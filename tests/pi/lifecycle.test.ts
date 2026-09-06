import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, rename, mkdir, rm } from "node:fs/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { sourceRecords, answer } from "../engine/fixtures.js";
import { fixture, memoryPatch } from "./fixtures.js";

for (const reason of ["length", "error", "aborted", "toolUse"] as const) test(`nonterminal ${reason} response cancels real hook with no saved candidate/default fallback`, async t => {
  const f = await fixture(); t.after(() => f.close()); f.seed();
  f.respond(() => fauxAssistantMessage('{"add":[],"remove":[],"priority":[]}', { stopReason: reason }));
  const before = f.runtime.session.sessionManager.getEntries();
  await assert.rejects(f.runtime.session.compact(), /cancel/i);
  assert.equal(f.faux.state.callCount, 1);
  assert.deepEqual(f.runtime.session.sessionManager.getEntries(), before);
  assert.equal(f.events[0]?.result.ok, false);
});
for (const bad of ["broken", '{"add":[],"remove":[],"priority":["unknown"]}', '{"add":[{"key":"k","text":"note"}],"remove":[],"priority":[]}']) test(`invalid patch cancels once: ${bad}`, async t => {
  const f = await fixture(); t.after(() => f.close()); f.seed(); f.respond(() => fauxAssistantMessage(bad));
  const before = f.runtime.session.sessionManager.getEntries();
  await assert.rejects(f.runtime.session.compact(), /cancel/i);
  assert.deepEqual(f.runtime.session.sessionManager.getEntries(), before);
  assert.equal(f.faux.state.callCount, 1);
});

test("public abortCompaction propagates to service and leaves saved state unchanged", async t => {
  const f = await fixture(); t.after(() => f.close()); f.seed();
  const started = Promise.withResolvers<void>(); let aborted = false;
  f.respond(async (_context, options) => {
    started.resolve();
    await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    return fauxAssistantMessage('{"add":[],"remove":[],"priority":[]}');
  });
  const before = f.runtime.session.sessionManager.getEntries();
  const compact = f.runtime.session.compact(); await started.promise;
  f.runtime.session.abortCompaction();
  await assert.rejects(compact, /cancel|abort/i);
  assert(aborted); assert.deepEqual(f.runtime.session.sessionManager.getEntries(), before);
  assert.equal(f.faux.state.callCount, 1);
});

for (const change of ["model", "path", "config", "settings", "thinking"] as const) test(`${change} change during extraction cannot hand off stale memory`, async t => {
  const f = await fixture(); t.after(() => f.close()); const { last } = f.seed();
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.respond(async context => { started.resolve(); await release.promise; return memoryPatch(context); });
  const compact = f.runtime.session.compact(); await started.promise;
  const check = assert.rejects(compact, /cancel|abort/i);
  if (change === "model") await f.runtime.session.setModel(f.faux.getModel("small")!);
  if (change === "path") f.runtime.session.sessionManager.branch(last);
  if (change === "config") await writeFile(f.configFile, JSON.stringify({ memory: { fraction: 0.2 } }));
  if (change === "settings") f.settings.applyOverrides({ compaction: { reserveTokens: 38000 } });
  if (change === "thinking") f.runtime.session.setThinkingLevel("low");
  // A same-leaf selection has no path change. Move to the actual parent for this case.
  if (change === "path") f.runtime.session.sessionManager.branch(f.runtime.session.sessionManager.getEntry(last)!.parentId!);
  release.resolve(); await check;
  assert.equal(f.runtime.session.sessionManager.getEntries().filter(e => e.type === "compaction").length, 0);
  assert.equal(f.faux.state.callCount, 1);
});

test("automatic pre-prompt threshold freezes delivered R and later sends new D once", async t => {
  const f = await fixture({ enabled: true }); t.after(() => f.close()); f.seed();
  // A persisted aborted response supplies Pi's prior provider usage; this is
  // controlled history, then the actual public prompt/preparation path runs.
  const previous = answer({}, f.faux.getModel()); previous.stopReason = "aborted"; previous.timestamp = Date.now();
  previous.usage = { ...previous.usage, input: 26000, cacheRead: 0, cacheWrite: 0, totalTokens: 26040 };
  f.runtime.session.sessionManager.appendMessage(previous);
  f.runtime.session.agent.state.messages = f.runtime.session.sessionManager.buildSessionContext().messages;
  f.respond(context => sourceRecords(context).length ? memoryPatch(context) : fauxAssistantMessage("Continued."));
  await f.runtime.session.prompt("LATEST pending correction before the next request");
  assert.equal(f.events.length, 1); assert.equal(f.events[0]?.reason, "threshold");
  assert(f.events[0]?.result.ok);
  const sources = sourceRecords(f.calls[0]!);
  assert(!JSON.stringify(sources).includes("LATEST pending correction"));
  assert.equal(f.calls[1]!.messages.filter(m => JSON.stringify(m).includes("LATEST pending correction")).length, 1);
  const keptId = f.events[0].result.candidate.firstKeptEntryId;
  assert(!keptId.startsWith("pending-"));
  assert.equal(f.faux.state.callCount, 2);
});

test("actual overflow response uses same maintenance hook then Pi retries once with rebuilt context", async t => {
  const f = await fixture({ enabled: true }); t.after(() => f.close()); f.seed();
  let main = 0;
  f.respond(context => sourceRecords(context).length ? memoryPatch(context) : ++main === 1
    ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "maximum context length exceeded" })
    : fauxAssistantMessage("Recovered and continued."));
  await f.runtime.session.prompt("Continue the active work");
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0]?.reason, "overflow"); assert.equal(f.events[0]?.willRetry, true);
  assert(f.events[0]?.result.ok);
  assert.equal(main, 2); assert.equal(f.faux.state.callCount, 3);
  assert.equal(f.runtime.session.sessionManager.getEntries().filter(e => e.type === "compaction").length, 1);
  assert.equal(f.calls.at(-1)?.messages.at(-1)?.role, "user");
});

test("Pi-owned write failure after handoff is not Nunc rollback or replay", async t => {
  const f = await fixture(); t.after(() => f.close()); f.seed(); f.respond(memoryPatch);
  const file = f.runtime.session.sessionFile!;
  // Concrete isolated I/O fault: replace the file target with a directory after
  // successful source loading. SessionManager's real append must encounter it.
  await rename(file, file + ".saved"); await mkdir(file);
  try {
    await assert.rejects(f.runtime.session.compact(), /directory|EISDIR/i);
    assert.equal(f.faux.state.callCount, 1);
    assert.equal(f.runtime.session.sessionManager.getEntries().filter(e => e.type === "compaction").length, 1, "Pi may already have changed in-memory state before failing its append");
  } finally {
    await rm(file, { recursive: true }); await rename(file + ".saved", file);
  }
});

test("ephemeral session and impossible host reserve/keep preparation never call the extractor", async t => {
  const f = await fixture({ ephemeral: true }); t.after(() => f.close()); f.seed();
  await assert.rejects(f.runtime.session.compact(), /cancel/i);
  assert.equal(f.faux.state.callCount, 0);
});
