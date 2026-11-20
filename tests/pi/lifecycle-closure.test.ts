import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryPatch, preparedSurface } from "./fixtures.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { renderMemory } from "../../src/engine/memory.js";
import { memoryTokens, messageTokens } from "../../src/engine/accounting.js";

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
    // The ownership check already saw the divergent terminal entry. Restore
    // representation validity before asking the separate projection validator.
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

test("model_select and context contain provider installation failures and recover on the next request", async t => {
  const diagnostics: string[] = [];
  const h = await preparedSurface(t, { bus: bus => bus.on("nunc:diagnostic", value => diagnostics.push((value as { message: string }).message)) });
  const registry = h.ctx().modelRegistry;
  const original = registry.getRegisteredNativeProvider;
  registry.getRegisteredNativeProvider = () => { throw new Error("provider-install-fault"); };
  try {
    await h.f.runtime.session.setModel(h.f.faux.getModel("small")!);
    assert(diagnostics.some(message => message.includes("provider-install-fault")), "model_select reports installation failure");
    const count = diagnostics.length;
    await h.f.runtime.session.prompt("Installation failure stays contained");
    assert(diagnostics.slice(count).some(message => message.includes("provider-install-fault")), "context reports installation failure");
    assert.deepEqual(h.f.errors, [], "neither hook escapes to the host extension error channel");
    assert.equal(h.f.faux.state.callCount, 0);
  } finally { registry.getRegisteredNativeProvider = original; }
  await h.f.runtime.session.prompt("Installation recovered");
  assert.equal(h.f.faux.state.callCount, 1);
  const last = h.f.runtime.session.messages.at(-1);
  assert(last?.role === "assistant");
  assert.equal(last.stopReason, "stop");
});

test("fallback carrier occupancy matches current layout and bound receipt", async t => {
  const { f, context, ctx, admissions } = await preparedSurface(t);
  f.seed();
  const { fauxAssistantMessage } = await import("@earendil-works/pi-ai");
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
