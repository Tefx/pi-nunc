import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { createAssistantMessageEventStream, fauxAssistantMessage, type AssistantMessage } from "@earendil-works/pi-ai";
import { ModelRegistry, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAINTENANCE_CALIBRATION_TYPE } from "../../src/pi/calibration.js";
import { eligibleUsageEntryIds, MANUAL_MEMORY_TYPE, project } from "../../src/pi/projection.js";
import { requestTokens } from "../../src/engine/accounting.js";
import { contextSurface, type ContextSurface } from "../../src/pi/context.js";
import { maintenanceLines } from "../../src/ui/status.js";
import type { MaintenanceCalibrationRecord } from "../../src/engine/types.js";
import { answer, sourceRecords } from "../engine/fixtures.js";
import { fixture, memoryPatch } from "./fixtures.js";

test("first native compact reduces tool bodies from current-prefix main usage without a provider refusal", async t => {
  const f = await fixture(); t.after(() => f.close()); seed(f);
  const manager = f.runtime.session.sessionManager;
  manager.appendMessage({ ...answer({}, f.faux.getModel()), timestamp: 4,
    usage: { ...answer().usage, input: 58000, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 58040 } });
  f.runtime.session.agent.state.messages = manager.buildSessionContext().messages;
  f.respond(memoryPatch);
  assert.equal(calibrationEntries(f).length, 0);
  await f.runtime.session.compact();
  const result = f.events.at(-1)!.result;
  assert(result.ok, result.ok ? "" : result.message);
  assert.equal(f.calls.length, 1); assert.equal(result.observations.requests, 1);
  assert.equal(result.observations.omissions.length, 1);
  const accounting = result.observations.accounting!;
  assert(accounting.fullExtractionTokens < accounting.extractionInputLimit);
  assert(accounting.calibratedUndercountTokens! > 0);
  assert(accounting.extractionTokens < accounting.fullExtractionTokens);
  assert(accounting.extractionPlanningTokens! + accounting.outputReserveTokens <= f.faux.getModel().contextWindow);
  assert.equal(checkpoints(f).length, 1);
});

test("native usage eligibility excludes retained K and every anchor before the last active context edit", async t => {
  const f = await fixture(); t.after(() => f.close()); const { body } = seed(f);
  const manager = f.runtime.session.sessionManager;
  let entries = manager.buildContextEntries(), active = project(entries).active;
  assert.deepEqual(eligibleUsageEntryIds(entries, active), active.map(entry => entry.entryId));
  manager.appendContextEdit(body, { content: "Corrected body." });
  entries = manager.buildContextEntries(); active = project(entries).active;
  assert.deepEqual(eligibleUsageEntryIds(entries, active), []);
  const fresh = manager.appendMessage({ ...answer({}, f.faux.getModel()), timestamp: 4 });
  entries = manager.buildContextEntries(); active = project(entries).active;
  assert.deepEqual(eligibleUsageEntryIds(entries, active), [fresh]);
  manager.appendContextEdit(body, { content: "Second correction." });
  entries = manager.buildContextEntries(); active = project(entries).active;
  assert.deepEqual(eligibleUsageEntryIds(entries, active), [], "last edit invalidates intervening usage too");
  f.respond(memoryPatch); await f.runtime.session.compact();
  entries = manager.buildContextEntries(); active = project(entries).active;
  assert(active.length > 0);
  assert.deepEqual(eligibleUsageEntryIds(entries, active), [], "all surviving K precedes checkpoint");
  const after = manager.appendMessage({ ...answer({}, f.faux.getModel()), timestamp: 5 });
  entries = manager.buildContextEntries(); active = project(entries).active;
  assert.deepEqual(eligibleUsageEntryIds(entries, active), [after]);
});

const providerError = "400 INVALID_ARGUMENT: The input token count exceeds the maximum number of tokens allowed 60000.";
const rejection = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: providerError });
function seed(f: Awaited<ReturnType<typeof fixture>>) {
  f.seed();
  const manager = f.runtime.session.sessionManager, model = f.faux.getModel();
  manager.appendCustomEntry(MANUAL_MEMORY_TYPE, { nunc: { version: 1, nextId: 2, slots: [{ id: "s1", text: "Original saved M survives rejection and restart." }] } });
  manager.appendMessage({ ...answer({}, model), stopReason: "toolUse", content: [{ type: "toolCall", id: "body-call", name: "read", arguments: { path: "/fixture/source.txt" } }] });
  const body = manager.appendMessage({ role: "toolResult", toolCallId: "body-call", toolName: "read", isError: false,
    content: [{ type: "text", text: "HEAD" + "body evidence ".repeat(1600) + "TAIL" }], timestamp: 2 });
  manager.appendMessage({ role: "user", content: "Latest correction and continuation requirement.", timestamp: 3 });
  const last = manager.appendMessage(answer({}, model));
  f.runtime.session.agent.state.messages = manager.buildSessionContext().messages;
  return { body, last, before: project(manager.buildContextEntries()), entries: manager.getEntries() };
}
function calibrationEntries(f: Awaited<ReturnType<typeof fixture>>) {
  return f.runtime.session.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === MAINTENANCE_CALIBRATION_TYPE);
}
function checkpoints(f: Awaited<ReturnType<typeof fixture>>) {
  return f.runtime.session.sessionManager.getBranch().filter(entry => entry.type === "compaction");
}

test("native failure -> real runtime shutdown -> SessionManager.open -> fresh no-config runtime reduces once and commits once", async t => {
  let starts = 0, shutdowns = 0, ctx!: ExtensionContext;
  const f = await fixture({ configFlag: false, extras: [{ name: "calibration-runtime-lifecycle", factory(pi) {
    pi.on("session_start", (_e, c) => { starts++; ctx = c; });
    pi.on("session_shutdown", () => { shutdowns++; });
  } }] }); t.after(() => f.close());
  const { before, entries } = seed(f), firstRuntime = f.runtime, firstManager = f.runtime.session.sessionManager, firstContext = ctx;
  const file = f.runtime.session.sessionFile;
  f.respond(rejection);
  await assert.rejects(f.runtime.session.compact(), /Compaction cancelled/);
  const failed = f.events.at(-1)!.result;
  assert(!failed.ok); assert.equal(failed.observations.requests, 1); assert.equal(f.calls.length, 1); assert.deepEqual(failed.observations.omissions, []);
  assert(failed.observations.accounting!.fullExtractionTokens < failed.observations.accounting!.extractionInputLimit);
  assert.equal(failed.observations.providerOverflow?.mode, "full");
  assert.deepEqual(project(firstManager.buildContextEntries()), before, "failure changes neither M nor active source nor checkpoint");
  assert.equal(checkpoints(f).length, 0); assert.equal(calibrationEntries(f).length, 1);
  assert.deepEqual(firstManager.getEntries().filter(entry => !calibrationEntries(f).includes(entry)), entries);
  assert(!JSON.stringify(firstManager.buildSessionContext().messages).includes(MAINTENANCE_CALIBRATION_TYPE), "state does not become model context");
  // An absent file makes accidental --nunc-config dependence observable on the newly constructed runtime.
  await rm(f.configFile);
  await f.reopenWithoutConfig();
  assert.equal(shutdowns, 1); assert.equal(starts, 2);
  assert.notEqual(f.runtime, firstRuntime); assert.notEqual(f.runtime.session.sessionManager, firstManager); assert.notEqual(ctx, firstContext);
  assert.equal(f.runtime.session.sessionFile, file); assert.equal(f.calls.length, 1, "resume never generates");
  assert.deepEqual(project(f.runtime.session.sessionManager.buildContextEntries()), before);
  assert.equal(calibrationEntries(f).length, 1);
  f.respond(memoryPatch);
  const saved = await f.runtime.session.compact();
  const recovered = f.events.at(-1)!.result;
  assert(recovered.ok, recovered.ok ? "" : recovered.message);
  assert.equal(f.calls.length, 2); assert.equal(recovered.observations.requests, 1); assert.equal(recovered.observations.omissions.length, 1);
  assert.equal(checkpoints(f).length, 1);
  const originalK = before.active.slice(before.active.findIndex(e => e.entryId === saved.firstKeptEntryId));
  assert.deepEqual(recovered.candidate.kept, originalK);
  const body = sourceRecords(f.calls[1]!).find(entry => entry.sourceRole === "toolResult")!.messages[0]!;
  assert(body.role === "toolResult" && body.content[0]?.type === "text");
  assert.equal(body.content[0].text.match(/\[Nunc omitted/g)?.length, 1);
  assert.deepEqual(project(f.runtime.session.sessionManager.buildContextEntries()).memory, before.memory);
  assert.equal(project(f.runtime.session.sessionManager.buildContextEntries()).active.some(e => e.entryId === calibrationEntries(f)[0]!.id), false);
  t.diagnostic(`real runtime close/open without config: starts=${starts}, shutdowns=${shutdowns}, requests=1+1, checkpoints=0->1`);
});

test("native explicit full is zero-dispatch after refusal; changing only mode to auto enables the one bounded reduction", async t => {
  const f = await fixture({ config: { extraction: { toolResults: "full" } } }); t.after(() => f.close()); const { before } = seed(f);
  f.respond(rejection);
  await assert.rejects(f.runtime.session.compact(), /cancel/i);
  await assert.rejects(f.runtime.session.compact(), /cancel/i);
  const strict = f.events.at(-1)!.result;
  assert(!strict.ok); assert.equal(strict.code, "CAPACITY"); assert.equal(strict.observations.requests, 0); assert.deepEqual(strict.observations.omissions, []);
  assert.equal(f.calls.length, 1); assert.equal(calibrationEntries(f).length, 1); assert.deepEqual(project(f.runtime.session.sessionManager.buildContextEntries()), before);
  await writeFile(f.configFile, JSON.stringify({ ...f.config, extraction: { toolResults: "auto" } }));
  f.respond(memoryPatch);
  await f.runtime.session.compact();
  assert.equal(f.calls.length, 2); assert.equal(f.events.at(-1)!.result.observations.omissions.length, 1); assert.equal(checkpoints(f).length, 1);
});

test("full and reduced refusal state survives a new no-config runtime; repeated identical reduced input stays zero-send while a legal extension is reduced once", async t => {
  const f = await fixture({ configFlag: false }); t.after(() => f.close()); const { before } = seed(f);
  f.respond(rejection);
  await assert.rejects(f.runtime.session.compact(), /cancel/i);
  await assert.rejects(f.runtime.session.compact(), /cancel/i);
  assert.deepEqual(f.events.map(event => event.result.observations.providerOverflow?.mode), ["full", "reduced"]);
  assert.equal(f.calls.length, 2); assert.equal(calibrationEntries(f).length, 2); assert.equal(checkpoints(f).length, 0);
  await f.reopenWithoutConfig();
  for (let i = 0; i < 2; i++) {
    await assert.rejects(f.runtime.session.compact(), /cancel/i);
    const blocked = f.events.at(-1)!.result;
    assert(!blocked.ok); assert.equal(blocked.code, "CAPACITY"); assert.equal(blocked.observations.requests, 0);
  }
  assert.equal(f.calls.length, 2); assert.equal(calibrationEntries(f).length, 2);
  assert.deepEqual(project(f.runtime.session.sessionManager.buildContextEntries()), before);
  const manager = f.runtime.session.sessionManager;
  manager.appendMessage({ ...answer({}, f.faux.getModel()), stopReason: "toolUse",
    content: [{ type: "toolCall", id: "later-call", name: "read", arguments: {} }] });
  manager.appendMessage({ role: "toolResult", toolCallId: "later-call", toolName: "read", isError: false,
    content: [{ type: "text", text: "Later short tool result." }], timestamp: 4 });
  manager.appendMessage({ role: "user", content: "Later delivered instruction extends the same source prefix.", timestamp: 5 });
  f.respond(memoryPatch);
  await f.runtime.session.compact();
  assert.equal(f.calls.length, 3); assert.equal(f.events.at(-1)!.result.observations.requests, 1);
  assert.equal(f.events.at(-1)!.result.observations.omissions.length, 1, "older full evidence still forces reduction after the latest reduced refusal");
  assert.equal(checkpoints(f).length, 1);
});

for (const change of ["selected-branch", "same-id-content-edit", "model"] as const) test(`native ${change} invalidates refusal binding`, async t => {
  const f = await fixture({ configFlag: false }); t.after(() => f.close()); const { body, last } = seed(f);
  f.respond(rejection);
  await assert.rejects(f.runtime.session.compact(), /cancel/i);
  const manager = f.runtime.session.sessionManager;
  if (change === "selected-branch") {
    await f.runtime.session.navigateTree(last, { summarize: false });
    assert.equal(calibrationEntries(f).length, 0, "abandoned refusal remains in JSONL but is outside selected getBranch()");
    assert(manager.getEntries().some(entry => entry.type === "custom" && entry.customType === MAINTENANCE_CALIBRATION_TYPE));
  }
  if (change === "same-id-content-edit") manager.appendContextEdit(body, { content: "Corrected tool source under the same ID." });
  if (change === "model") await f.runtime.session.setModel(f.faux.getModel("small")!);
  f.respond(memoryPatch);
  await f.runtime.session.compact();
  assert.equal(f.calls.length, 2); assert.equal(f.events.at(-1)!.result.observations.requests, 1); assert.deepEqual(f.events.at(-1)!.result.observations.omissions, []);
});

for (const error of ["429 token limit exceeded", "ECONNRESET: connection closed"]) test(`native ${error} records no context refusal`, async t => {
  const f = await fixture({ configFlag: false }); t.after(() => f.close()); const { before } = seed(f);
  f.respond(() => fauxAssistantMessage("", { stopReason: "error", errorMessage: error }));
  await assert.rejects(f.runtime.session.compact(), /cancel/i);
  assert.equal(f.events.at(-1)!.result.observations.providerOverflow, undefined);
  assert.equal(checkpoints(f).length, 0); assert.deepEqual(project(f.runtime.session.sessionManager.buildContextEntries()), before);
  f.respond(memoryPatch);
  await f.runtime.session.compact();
  assert.equal(f.calls.length, 2); assert.deepEqual(f.events.at(-1)!.result.observations.omissions, []);
});

test("native cancellation wins over a late provider refusal and does not poison the next explicit attempt", async t => {
  const f = await fixture({ configFlag: false }); t.after(() => f.close()); const { before, entries } = seed(f);
  const started = Promise.withResolvers<void>();
  f.respond(async (_context, options) => {
    started.resolve();
    await new Promise<void>(resolve => options.signal.addEventListener("abort", () => resolve(), { once: true }));
    return rejection();
  });
  const compact = f.runtime.session.compact();
  const cancelled = assert.rejects(compact, /cancel|abort/i);
  await started.promise; f.runtime.session.abortCompaction(); await cancelled;
  assert.equal(f.events.at(-1)!.result.observations.providerOverflow, undefined);
  assert.equal(f.events.at(-1)!.result.observations.requests, 1);
  assert.equal(calibrationEntries(f).length, 0); assert.equal(checkpoints(f).length, 0);
  assert.deepEqual(f.runtime.session.sessionManager.getEntries(), entries);
  assert.deepEqual(project(f.runtime.session.sessionManager.buildContextEntries()), before);
  f.respond(memoryPatch); await f.runtime.session.compact();
  assert.equal(f.calls.length, 2); assert.deepEqual(f.events.at(-1)!.result.observations.omissions, []);
});

test("measured maintenance undercount survives successful checkpoint/restart, remains additive and never borrows a large main usage", async t => {
  let ctx!: ExtensionContext, view!: ContextSurface;
  const f = await fixture({ configFlag: false, extras: [{ name: "calibration-context-view", factory(pi) {
    view = contextSurface(pi)!;
    pi.on("session_start", (_e, context) => { ctx = context; });
  } }] }); t.after(() => f.close()); seed(f);
  let raw = 0, main = 0;
  const delta = 1700;
  function stream(message: AssistantMessage) {
    const events = createAssistantMessageEventStream();
    events.push({ type: "done", reason: "stop", message }); events.end(message); return events;
  }
  // Control the provider's reported usage, because fauxProvider otherwise replaces supplied usage with its own estimate.
  // Native ModelRegistry, extension loader, request accounting and real persistent runtime remain in use.
  new ModelRegistry(f.modelRuntime).registerProvider({ ...f.faux.provider,
    stream(model, context, options) {
      raw++;
      assert.equal(options?.maxRetries, 0);
      const estimated = requestTokens(context);
      const message = { ...memoryPatch(context), api: model.api, provider: model.provider, model: model.id };
      message.usage = { ...message.usage, input: estimated + delta - 200, cacheRead: 125, cacheWrite: 75, output: 40, totalTokens: estimated + delta + 40 };
      return stream(message);
    },
    streamSimple(model) {
      main++;
      const message = { ...fauxAssistantMessage("Continued with main usage."), api: model.api, provider: model.provider, model: model.id };
      message.usage = { ...message.usage, input: 41000, cacheRead: 100, cacheWrite: 200, output: 40, totalTokens: 41340 };
      return stream(message);
    },
  });
  await f.runtime.session.prompt("Record main usage before the checkpoint; retain this turn in K.");
  assert.equal(main, 1);
  await f.runtime.session.compact();
  const first = f.events.at(-1)!.result;
  assert(first.ok); assert.equal(first.observations.maintenanceCalibration?.undercountTokens, delta);
  const saved = (checkpoints(f).at(-1)!.details as { maintenanceCalibration: MaintenanceCalibrationRecord }).maintenanceCalibration;
  assert.deepEqual(saved.sourceEntryIds, first.candidate.kept.map(e => e.entryId));
  assert.equal(saved.measurement?.undercountTokens, delta);
  assert.equal(raw, 1); assert.equal(checkpoints(f).length, 1);
  const retained = project(f.runtime.session.sessionManager.buildContextEntries()).active;
  assert(retained.some(entry => entry.messages.some(message => message.role === "assistant" && message.usage.totalTokens === 41340)), "large pre-checkpoint usage remains in K");
  await rm(f.configFile); await f.reopenWithoutConfig();
  f.runtime.session.sessionManager.appendMessage({ role: "user", content: "New delivered source after restart, without fresh assistant usage.", timestamp: Date.now() });
  await f.runtime.session.compact();
  const next = f.events.at(-1)!.result;
  assert(next.ok, next.ok ? "" : next.message);
  assert.equal(raw, 2); assert.equal(main, 1);
  assert.equal(next.observations.accounting!.calibratedUndercountTokens, delta);
  assert.equal(next.observations.accounting!.extractionPlanningTokens, next.observations.accounting!.extractionTokens + delta);
  assert.deepEqual(next.observations.accounting!.extractionUncertainties, ["maintenance-usage-undercount"]);
  assert.equal(next.observations.maintenanceCalibration?.undercountTokens, delta, "the previous delta is not deducted from its own raw baseline");
  assert.notEqual(next.observations.maintenanceCalibration?.actualInputTokens, 41300, "main context usage never enters maintenance calibration");
  const lines = maintenanceLines(view.read(ctx).lastMaintenance).join("\n");
  assert.match(lines, /Maintenance calibration: \+1,700 → planned [\d,]+ \(prior maintenance usage; uncertain\)/);
  await f.runtime.session.prompt("Continue with a post-checkpoint main request.");
  assert.equal(main, 2);
  await f.runtime.session.compact();
  const postCheckpoint = f.events.at(-1)!.result;
  assert(postCheckpoint.ok, postCheckpoint.ok ? "" : postCheckpoint.message);
  assert(postCheckpoint.observations.accounting!.calibratedUndercountTokens! > delta, "fresh main usage calibrates in-flight planning");
  assert.equal(postCheckpoint.observations.maintenanceCalibration?.undercountTokens, delta);
  assert.notEqual(postCheckpoint.observations.maintenanceCalibration?.actualInputTokens, 41300);
  const persisted = (checkpoints(f).at(-1)!.details as { maintenanceCalibration: MaintenanceCalibrationRecord }).maintenanceCalibration;
  assert.equal(persisted.measurement?.undercountTokens, delta, "post-checkpoint main usage never replaces persisted maintenance evidence");
  assert.notEqual(persisted.measurement?.actualInputTokens, 41300);
  t.diagnostic(`successful checkpoint/restart: maintenance raw sends=${raw}, main sends=${main}, measured/additive correction=${delta}`);
});
