import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, rename, mkdir, rm, access, mkdtemp, open } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { renderMemory } from "../../src/engine/memory.js";
import { memoryTokens, messageTokens } from "../../src/engine/accounting.js";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { sourceRecords, answer } from "../engine/fixtures.js";
import { assertOnlyCalibrationAppend, fixture, memoryPatch, surfacePort, preparedSurface } from "./fixtures.js";
import { NuncUi } from "../../src/ui/index.js";
import { buildContextNodes } from "../../src/ui/context-tree.js";
import { project, MANUAL_MEMORY_TYPE } from "../../src/pi/projection.js";

for (const reason of ["stop", "length", "error", "aborted", "toolUse"] as const) {
  for (const nonempty of [false, true]) test(`maintenance ${reason} with ${nonempty ? "saved" : "empty"} M preserves failure semantics and rolls only completed responses`, async t => {
    const port = surfacePort();
    const f = await fixture({ extras: port.extras }); t.after(() => f.close()); f.seed();
    const manager = f.runtime.session.sessionManager;
    if (nonempty) manager.appendCustomEntry(MANUAL_MEMORY_TYPE, { nunc: { version: 1, nextId: 8, slots: [{ id: "s7", text: "Keep the full task constraint." }] } });
    const before = project(manager.buildContextEntries());
    f.respond(() => fauxAssistantMessage("broken", { stopReason: reason }));
    if (reason === "error" || reason === "aborted") {
      const entries = manager.getEntries();
      await assert.rejects(f.runtime.session.compact(), /cancel/i);
      if (reason === "aborted") assert.deepEqual(manager.getEntries(), entries);
      else assertOnlyCalibrationAppend(entries, manager.getEntries(), f.events[0]!.result);
      assert.equal(project(manager.buildContextEntries()).mechanicalFallback, undefined);
      const failed = port.context().read(port.ctx());
      assert.equal(failed.lastMaintenance?.native, "failed");
      assert.equal(failed.lastMaintenance?.after, undefined);
      assert.equal(port.memory().read(port.ctx()).status.occupied, false);
    } else {
      const saved = await f.runtime.session.compact();
      const after = project(manager.buildContextEntries());
      assert.deepEqual(after.memory, before.memory);
      assert.deepEqual(after.active, before.active.slice(before.active.findIndex(e => e.entryId === saved.firstKeptEntryId)));
      const calibration = (saved.details as { maintenanceCalibration?: { sourceEntryIds: string[]; providerOverflow?: unknown } }).maintenanceCalibration;
      assert(calibration);
      assert.deepEqual(calibration.sourceEntryIds, after.active.map(e => e.entryId));
      assert.equal(calibration.providerOverflow, undefined);
      assert.notDeepEqual(calibration.sourceEntryIds, before.active.map(e => e.entryId));
      assert.equal(after.mechanicalFallback?.code, "RESPONSE");
      assert.match(saved.summary, /Nunc Mechanical Roll Fallback/);
      const view = port.context().read(port.ctx());
      if (!nonempty) assert((view.current.layout.memory?.tokens ?? 0) > 0, "empty M still accounts for the fallback carrier");
      assert.equal(view.lastMaintenance?.engine, "fail");
      assert.equal(view.lastMaintenance?.native, "saved");
      assert.deepEqual(view.lastMaintenance?.after?.memory, before.memory);
      f.respond(() => fauxAssistantMessage("Continued."));
      await f.runtime.session.prompt("Continue");
      await f.runtime.session.prompt("Continue again");
      assert(f.calls.at(-1)!.messages.some(m => JSON.stringify(m).includes("Nunc Mechanical Roll Fallback")));
      assert.equal(port.admissions.at(-1)?.estimator, "pi-usage-backed", "fallback carrier retains receipt identity");
      assert(project(manager.buildContextEntries()).mechanicalFallback, "main delegation does not clear fallback");
      await f.reopenWithoutConfig();
      assert(project(f.runtime.session.sessionManager.buildContextEntries()).mechanicalFallback, "checkpoint survives reload");
      const memory = port.memory().read(port.ctx());
      const patch = port.memory().patch(port.ctx(), { expectedRevision: memory.revision, add: [{ key: "reconciled", text: "Explicitly reconciled retired history." }] });
      assert(patch.ok);
      assert.equal(project(f.runtime.session.sessionManager.buildContextEntries()).mechanicalFallback, undefined);
    }
    const result = f.events[0]!.result;
    assert(!result.ok); assert.equal(result.code, "RESPONSE");
    assert.equal(f.events.length, 1);
    assert.equal(f.faux.state.callCount, reason === "error" || reason === "aborted" ? 1 : 3, "one extraction plus the two explicit continuation prompts, with no recursive maintenance");
  });
}
for (const bad of ["broken", '{"add":[],"remove":[],"priority":["unknown"],"required":[]}', '{"add":[],"remove":[],"priority":[]}', '{"add":[],"remove":[],"priority":[],"required":["unknown"]}', '{"add":[{"key":"k","text":"note"}],"remove":[],"priority":[],"required":[]}']) test(`invalid patch rolls once: ${bad}`, async t => {
  const f = await fixture(); t.after(() => f.close()); f.seed(); f.respond(() => fauxAssistantMessage(bad));
  const before = project(f.runtime.session.sessionManager.buildContextEntries());
  const saved = await f.runtime.session.compact();
  const after = project(f.runtime.session.sessionManager.buildContextEntries());
  assert.deepEqual(after.memory, before.memory);
  assert(after.mechanicalFallback);
  assert.match(saved.summary, /without updating M/);
  assert.equal(f.events[0]?.result.ok, false);
  assert.equal(f.faux.state.callCount, 1);
});

test("failed disk-settings fixture initialization restores the environment and removes its directory", async () => {
  const inherited = process.env.PI_CODING_AGENT_DIR;
  let dir: string | undefined;
  await assert.rejects(fixture({ diskSettings: true, extras: [{ name: "fail-fixture-init", factory() {
    assert(process.env.PI_CODING_AGENT_DIR);
    dir = dirname(process.env.PI_CODING_AGENT_DIR);
    throw new Error("fixture-init-error");
  } }] }), /fixture-init-error/);
  assert.equal(process.env.PI_CODING_AGENT_DIR, inherited);
  assert(dir);
  await assert.rejects(access(dir), { code: "ENOENT" });
});

test("public abortCompaction propagates to service and leaves saved state unchanged", async t => {
  const f = await fixture(); t.after(() => f.close()); f.seed();
  const started = Promise.withResolvers<void>(); let aborted = false;
  f.respond(async (_context, options) => {
    started.resolve();
    await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    return fauxAssistantMessage('{"add":[],"remove":[],"priority":[],"required":[]}');
  });
  const before = f.runtime.session.sessionManager.getEntries();
  const compact = f.runtime.session.compact(); await started.promise;
  f.runtime.session.abortCompaction();
  await assert.rejects(compact, /cancel|abort/i);
  assert(aborted); assert.deepEqual(f.runtime.session.sessionManager.getEntries(), before);
  assert.equal(f.faux.state.callCount, 1);
});

test("abortCompaction settles while policy-file reading is still pending", { timeout: 5000 }, async t => {
  const f = await fixture(); t.after(() => f.close()); f.seed();
  const policy = join(f.dir, "policy.fifo");
  execFileSync("mkfifo", [policy]);
  await writeFile(f.configFile, JSON.stringify({ ...f.config, policyFile: policy }));
  const before = f.runtime.session.sessionManager.getEntries();
  const compact = f.runtime.session.compact();
  const rejected = assert.rejects(compact, /cancel|abort/i);
  // Opening the writer proves loadPolicy reached the real FIFO reader. Keep
  // it open without bytes so cancellation must settle before EOF.
  const writer = await open(policy, "w");
  try {
    f.runtime.session.abortCompaction();
    await rejected;
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.runtime.session.sessionManager.getEntries(), before);
  } finally { await writer.close(); }
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

for (const kind of ["reminder", "user"] as const) test(`later ${kind} append during extraction stays outside frozen source and survives native handoff once`, async t => {
  const f = await fixture(); t.after(() => f.close()); f.seed();
  const manager = f.runtime.session.sessionManager;
  const before = project(manager.buildContextEntries());
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  f.respond(async context => {
    if (!sourceRecords(context).length) return fauxAssistantMessage("Continued with the later input.");
    started.resolve(); await release.promise; return memoryPatch(context);
  });
  const compact = f.runtime.session.compact();
  compact.catch(() => {});
  await started.promise;
  const text = `LATER ${kind} correction excluded from this extraction`;
  if (kind === "reminder") await f.runtime.session.sendCustomMessage({ customType: "reminder", content: text, display: false }, { triggerTurn: false });
  else manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  const later = project(manager.buildContextEntries()).active.at(-1)!;
  assert.notEqual(manager.getLeafId(), before.active.at(-1)!.entryId);
  release.resolve();
  const result = await compact;
  assert.equal(f.events.length, 1);
  assert(f.events[0]?.result.ok);
  assert.equal(f.calls.length, 1, "one extraction, no repair or replay");
  assert(!JSON.stringify(sourceRecords(f.calls[0]!)).includes(text), "later D was not consumed by extraction");
  assert.deepEqual(project(manager.buildContextEntries()).active, [
    ...before.active.slice(before.active.findIndex(entry => entry.entryId === result.firstKeptEntryId)), later,
  ], "Pi keeps original K plus unchanged later D");
  assert.equal(manager.getEntries().filter(entry => entry.type === "compaction").length, 1);
  await f.runtime.session.prompt("Continue after append-safe maintenance");
  assert.equal(f.calls.at(-1)!.messages.filter(message => JSON.stringify(message).includes(text)).length, 1);
  assert.equal(f.events.length, 1, "the continuation does not repeat extraction");
});

for (const replacement of [null, { content: "Changed already-frozen requirement" }] as const) test(`append-only context edit ${replacement === null ? "omission" : "replacement"} invalidates the frozen source`, async t => {
  const f = await fixture(); t.after(() => f.close()); const { first } = f.seed();
  const manager = f.runtime.session.sessionManager;
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  f.respond(async context => { started.resolve(); await release.promise; return memoryPatch(context); });
  const compact = f.runtime.session.compact();
  const rejected = assert.rejects(compact, /cancel|abort/i);
  await started.promise;
  manager.appendContextEdit(first, replacement);
  release.resolve(); await rejected;
  assert.equal(f.calls.length, 1);
  assert.equal(manager.getEntries().filter(entry => entry.type === "compaction").length, 0);
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

test("Pi-owned write failure leaves visible unconfirmed M without activating cleanup or allowing writes", async t => {
  const { f, memory, ctx } = await preparedSurface(t);
  f.seed(); f.respond(memoryPatch);
  const manager = f.runtime.session.sessionManager;
  for (const id of ["eligible", "newest"]) {
    manager.appendMessage({ ...answer({}, f.faux.getModel()), stopReason: "toolUse",
      content: [{ type: "toolCall", id, name: "read", arguments: { path: id } }] });
    manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "read", isError: false,
      content: [{ type: "text", text: '{\n  "value": [1, 2, 3]\n}' }], timestamp: 2 });
  }
  f.runtime.session.agent.state.messages = manager.buildSessionContext().messages;
  const file = f.runtime.session.sessionFile!;
  // Concrete isolated I/O fault: replace the file target with a directory after
  // successful source loading. SessionManager's real append must encounter it.
  await rename(file, file + ".saved"); await mkdir(file);
  try {
    await assert.rejects(f.runtime.session.compact(), /directory|EISDIR/i);
    assert.equal(f.faux.state.callCount, 1);
    const checkpoint = manager.getEntry(manager.getLeafId()!);
    assert(checkpoint?.type === "compaction", "Pi already changed in-memory state before failing its append");
    assert((checkpoint.details as { toolResultCleanup: unknown[] }).toolResultCleanup.length > 0, "failure must reach a checkpoint carrying cleanup");
    const projected = project(manager.buildContextEntries());
    assert.equal(projected.cleanup.length, 0);
    assert(projected.memory.slots.length > 0, "unconfirmed M remains visible");
    const view = memory().read(ctx());
    assert.equal(view.status.unconfirmed, true);
    const patch = memory().patch(ctx(), { expectedRevision: view.revision, add: [{ key: "blocked", text: "Cannot save yet" }] });
    assert(!patch.ok); assert.equal(patch.code, "unconfirmed");
  } finally {
    await rm(file, { recursive: true }); await rename(file + ".saved", file);
  }
  assert.equal(memory().read(ctx()).status.unconfirmed, true, "restoring the old file cannot confirm a missing checkpoint");
  await f.runtime.switchSession(file);
  assert.equal(memory().read(ctx()).status.unconfirmed, false);
  assert.equal(project(f.runtime.session.sessionManager.buildContextEntries()).cleanup.length, 0);
});

test("ephemeral session and impossible host reserve/keep preparation never call the extractor", async t => {
  const f = await fixture({ ephemeral: true }); t.after(() => f.close()); f.seed();
  await assert.rejects(f.runtime.session.compact(), /cancel/i);
  assert.equal(f.faux.state.callCount, 0);
});

test("mechanical checkpoint warning survives recovery and clears on a normal compaction", async t => {
  const port = surfacePort();
  const f = await fixture({ extras: port.extras }); t.after(() => f.close()); f.seed();
  f.respond(() => fauxAssistantMessage("broken"));
  const saved = await f.runtime.session.compact();
  let status: string | undefined;
  const ctx = port.ctx();
  const paintCtx = { ...ctx, hasUI: true, ui: { ...ctx.ui,
    theme: { ...ctx.ui.theme, fg: (_tone: string, value: string) => value },
    setStatus: (_key: string, value: string | undefined) => { status = value; },
  } } as typeof ctx;
  const ui = new NuncUi({ memory: { ...port.memory(), beginFreeze: () => true, endFreeze() {}, noteForeignFailure: () => false },
    context: port.context(), supported() {} });
  ui.attach(paintCtx);
  assert.equal(status, "🧠 !0·roll");
  ui.recover(); ui.refresh(paintCtx);
  assert.equal(status, "🧠 !0·roll");
  assert.match(buildContextNodes(port.context().read(ctx)).get("scope:current")!.preview, /Mechanical fallback: active/);
  f.respond(() => fauxAssistantMessage("Continued."));
  await f.runtime.session.prompt("Continue");
  ui.recover(); ui.refresh(paintCtx);
  assert.equal(status, "🧠 !0·roll");
  const manager = f.runtime.session.sessionManager;
  const checkpoint = manager.getEntries().find(e => e.type === "compaction")!;
  for (const bad of [null, {}, { code: "CAPACITY" }, { ...(checkpoint.details as { mechanicalFallback: object }).mechanicalFallback, retiredEntryCount: -1 },
      { ...(checkpoint.details as { mechanicalFallback: object }).mechanicalFallback, firstKeptEntryId: "wrong" }]) {
    const entries = structuredClone(manager.buildContextEntries());
    const c = entries.find(e => e.id === checkpoint.id);
    assert(c?.type === "compaction");
    c.details = { ...c.details as object, mechanicalFallback: bad };
    assert.throws(() => project(entries), /fallback|snapshot/i);
  }
  f.seed("normal");
  f.respond(memoryPatch);
  const normal = await f.runtime.session.compact();
  assert(!normal.summary.includes("Nunc Mechanical Roll Fallback"));
  assert.equal(project(manager.buildContextEntries()).mechanicalFallback, undefined);
  ui.recover(); ui.refresh(paintCtx);
  assert(!status?.includes("·roll"));
  assert(saved.summary.includes("Nunc Mechanical Roll Fallback"));
});

for (const targeted of [false, true]) test(`repeated unchanged-M native compaction confirms the newest checkpoint: targeted=${targeted}`, async t => {
  const notes: string[] = [];
  const { f, context, ctx } = await preparedSurface(t, { bus: bus => bus.on("nunc:diagnostic", value => notes.push((value as { message: string }).message)) });
  f.respond(memoryPatch);
  let firstSummary: string | undefined;
  for (let i = 0; i < 3; i++) {
    f.seed(`turn-${i}`);
    if (targeted) await f.runtime.session.prompt("/nunc compact-for nunc-pi-fixture/small");
    else await f.runtime.session.compact();
    const branch = f.runtime.session.sessionManager.getBranch();
    const saved = branch.findLast(entry => entry.type === "compaction");
    assert(saved?.type === "compaction");
    firstSummary ??= saved.summary;
    assert.equal(saved.summary, firstSummary);
    assert.equal(branch.filter(entry => entry.type === "compaction").length, i + 1);
    const view = context().read(ctx());
    assert.equal(view.lastMaintenance?.native, "saved");
    assert(view.lastMaintenance.after);
    assert.equal(view.lastMaintenance.candidate!.firstKeptEntryId, saved.firstKeptEntryId);
  }
  if (targeted) assert.equal(notes.filter(note => note.includes("Saved compaction for")).length, 3);
});

for (const field of ["summary", "toolResultCleanup", "maintenanceCalibration"] as const) test(`native checkpoint ownership verifies ${field} as well as memory`, async t => {
  await mkdir(resolve(".scratch"), { recursive: true });
  const dir = await mkdtemp(resolve(".scratch/checkpoint-owner-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const extension = join(dir, "mutate-terminal.mjs");
  await writeFile(extension, `export default pi => pi.on('session_compact', (_event, ctx) => {
    const entry = ctx.sessionManager.getBranch().findLast(e => e.type === 'compaction');
    ${field === "summary" ? "entry.summary += 'foreign summary';" : `entry.details.${field} = { foreign: true };`}
  });`);
  const diagnostics: string[] = [];
  const { f, context, ctx } = await preparedSurface(t, { beforeNunc: [extension], bus: bus => bus.on("nunc:diagnostic", value => diagnostics.push((value as { message: string }).message)) });
  f.seed(); f.respond(memoryPatch);
  await f.runtime.session.compact();
  if (field === "summary") {
    const entry = f.runtime.session.sessionManager.getBranch().findLast(e => e.type === "compaction");
    assert(entry?.type === "compaction");
    const result = f.events[0]!.result;
    assert(result.ok);
    entry.summary = renderMemory(result.candidate.memory.slots);
  }
  const view = context().read(ctx());
  assert.equal(view.lastMaintenance?.engine, "ok");
  assert.equal(view.lastMaintenance?.native, "failed");
  assert.equal(view.lastMaintenance?.after, undefined);
  assert(diagnostics.some(message => message.includes("save ownership is unconfirmed")));
});

for (const warning of ["headroom", "runway"] as const) test(`native saves retain deduplicated ${warning} warning until genuine recovery`, async t => {
  const diagnostics: string[] = [];
  const prefix = warning === "headroom" ? "Normal-trigger extraction estimate" : "Candidate post-compaction growth runway";
  const { f } = await preparedSurface(t, { config: { budget: warning === "headroom" ? { extraExtractionInputTokens: 26000 } : { extraMainInputTokens: 16000 } },
    bus: bus => bus.on("nunc:diagnostic", value => diagnostics.push((value as { message: string }).message)) });
  f.respond(memoryPatch);
  for (let i = 0; i < 2; i++) {
    if (i === 0) f.seed("warning");
    else f.runtime.session.sessionManager.appendMessage({ role: "user", content: "Next warning compaction", timestamp: 2 });
    await f.runtime.session.compact();
    const accounting = f.events[i]!.result.observations.accounting!;
    if (warning === "headroom") assert.equal(accounting.normalHeadroomSufficient, false);
    else assert(accounting.growthTokens! < 0.35 * accounting.effectiveTrigger);
    f.respond(() => fauxAssistantMessage("Ordinary main response."));
    await f.runtime.session.prompt("Continue despite maintenance advice");
    f.respond(memoryPatch);
    await f.runtime.session.prompt("/nunc details");
    assert(diagnostics.at(-1)!.includes(`Current warning: ${prefix}`));
  }
  assert.equal(diagnostics.filter(message => message.startsWith(prefix)).length, 1, "repeat notification is deduplicated without clearing warning");
  await writeFile(f.configFile, JSON.stringify({ ...f.config, budget: { extraExtractionInputTokens: 0 } }));
  f.seed("recovered");
  await f.runtime.session.compact();
  assert.equal(f.events.at(-1)!.result.observations.accounting?.normalHeadroomSufficient, true);
  await f.runtime.session.prompt("/nunc details");
  assert.match(diagnostics.at(-1)!, /Current warning: none/);
  await writeFile(f.configFile, JSON.stringify(f.config));
  f.runtime.session.sessionManager.appendMessage({ role: "user", content: "Warning regressed", timestamp: 3 });
  await f.runtime.session.compact();
  assert.equal(diagnostics.filter(message => message.startsWith(prefix)).length, 2, "genuine recovery re-arms warning notification");
});

test("fallback carrier occupancy matches current layout and bound receipt", async t => {
  const { f, context, ctx, admissions } = await preparedSurface(t);
  f.seed();
  f.respond(() => fauxAssistantMessage("broken"));
  await f.runtime.session.compact();
  const before = context().read(ctx());
  const fallback = before.current.mechanicalFallback;
  assert(fallback);
  const expected = memoryTokens([], undefined, fallback);
  assert.equal(before.current.layout.memory!.tokens, expected);
  f.respond(() => fauxAssistantMessage("Continued"));
  await f.runtime.session.prompt("Continue");
  const carrier = f.calls.at(-1)!.messages.find(message => JSON.stringify(message).includes("Nunc Mechanical Roll Fallback"));
  assert(carrier);
  assert.equal(messageTokens(carrier), expected);
  await f.runtime.session.prompt("Continue again");
  const receipt = admissions.findLast(row => row.receiptBreakdown);
  assert.equal(receipt?.receiptBreakdown?.currentMTokens, expected);
  assert.equal(receipt?.receiptBreakdown?.oldMTokensEstimate, expected);
  assert.equal(context().read(ctx()).lastMain!.layout.memory!.tokens, expected);
});
