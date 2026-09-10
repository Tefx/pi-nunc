import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { contextSurface, type ContextSurface } from "pi-nunc/pi";
import { emptyMemory } from "../../src/engine/index.js";
import { createContextSurface, unknownBudget } from "../../src/pi/context.js";
import { engineConfig } from "../../src/pi/config.js";
import { budgetLines, capLabel, detailsLines, DIAGNOSTIC_LIMIT, maintenanceLines, quantity } from "../../src/ui/status.js";
import { NuncUi } from "../../src/ui/index.js";
import { model } from "../engine/fixtures.js";
import { fixture, memoryPatch } from "./fixtures.js";

function port(): {
  extras: InlineExtension[];
  context: () => ContextSurface;
  ctx: () => ExtensionContext;
  pi: () => ExtensionAPI;
} {
  let api: ExtensionAPI | undefined;
  let ctx: ExtensionContext | undefined;
  return {
    extras: [{ name: "nunc-report-port", factory(pi) {
      api = pi;
      pi.on("session_start", (_event, next) => { ctx = next; });
    } }],
    context() { const value = contextSurface(api!); assert(value); return value; },
    ctx() { assert(ctx); return ctx; },
    pi() { assert(api); return api; },
  };
}

test("non-TUI bare /nunc equals /nunc details from ContextSurface; status is unknown; reports do not consume diagnostics", async t => {
  const captured = port();
  const reports: string[] = [];
  const f = await fixture({ extras: [...captured.extras, { name: "capture-nunc-report", factory(pi) {
    pi.events.on("nunc:diagnostic", value => {
      if (value && typeof value === "object" && "message" in value && typeof value.message === "string") reports.push(value.message);
    });
  } }] });
  t.after(() => f.close());
  const entries = f.runtime.session.sessionManager.getEntries();
  await f.runtime.session.prompt("/nunc");
  await f.runtime.session.prompt("/nunc details");
  assert.equal(reports.at(-1), reports.at(-2));
  const view = captured.context().read(captured.ctx());
  for (const line of budgetLines(view.current)) assert(reports.at(-1)!.includes(line), line);
  for (const line of maintenanceLines(view.lastMaintenance)) assert(reports.at(-1)!.includes(line), line);
  assert.notEqual(view.current.budget.extractionInputLimit, null);
  assert.equal(view.current.budget.extractionOutputCapKnown, true);
  await f.runtime.session.prompt("/nunc status");
  assert.equal(reports.at(-1), "Usage: /nunc [details]");
  assert.equal(f.faux.state.callCount, 0);
  assert.deepEqual(f.runtime.session.sessionManager.getEntries(), entries);

  f.seed(); f.respond(memoryPatch);
  await f.runtime.session.compact();
  const saved = f.runtime.session.sessionManager.getEntries();
  const calls = f.faux.state.callCount;
  const after = captured.context().read(captured.ctx());
  assert(after.lastMaintenance?.accounting);
  const beforeReports = reports.length;
  await f.runtime.session.prompt("/nunc");
  await f.runtime.session.prompt("/nunc details");
  assert.equal(reports.at(-1), reports.at(-2));
  const live = reports.at(-1)!;
  for (const line of budgetLines(after.current)) assert(live.includes(line), line);
  for (const line of maintenanceLines(after.lastMaintenance)) assert(live.includes(line), line);
  assert.equal(after.lastMaintenance?.accounting?.extractionTokens, f.events.at(-1)!.result.observations.accounting!.extractionTokens);
  assert.equal(f.faux.state.callCount, calls);
  assert.deepEqual(f.runtime.session.sessionManager.getEntries(), saved);
  assert.equal(reports.length, beforeReports + 2);
});

test("complete reports do not enter diagnostic history or echo themselves", async t => {
  const reports: string[] = [];
  const f = await fixture({ extras: [{ name: "capture-nunc-report", factory(pi) {
    pi.events.on("nunc:diagnostic", value => {
      if (value && typeof value === "object" && "message" in value && typeof value.message === "string") reports.push(value.message);
    });
  } }] });
  t.after(() => f.close());
  await f.runtime.session.prompt("/nunc status");
  assert.equal(reports.at(-1), "Usage: /nunc [details]");
  const entries = f.runtime.session.sessionManager.getEntries();
  const calls = f.faux.state.callCount;
  for (let i = 0; i < DIAGNOSTIC_LIMIT + 5; i++) await f.runtime.session.prompt("/nunc details");
  const last = reports.at(-1)!;
  assert.match(last, /Current warning: Usage: \/nunc \[details\]/);
  assert.match(last, /warning: Usage: \/nunc \[details\]/);
  assert.equal((last.match(/Current budgets/g) ?? []).length, 1);
  assert.equal(f.faux.state.callCount, calls);
  assert.deepEqual(f.runtime.session.sessionManager.getEntries(), entries);
});

test("diagnostic ring stays bounded and recover clears only the current warning", () => {
  const ui = new NuncUi({
    memory: { read: () => ({ revision: "r", memory: emptyMemory(), status: { occupied: false, unconfirmed: false }, budget: { tokens: 0, limit: 100, unknown: false, overLimit: false }, contextLayout: { slotCount: 0, activeEntries: 0 } }) } as never,
    context: { read: () => ({ current: { scope: "current", sessionId: "s", leafId: "l", model: null, revision: "r", occupied: false, unconfirmed: false, contextLayout: { slotCount: 0, activeEntries: 0 }, layout: { system: { text: "", tokens: 0 }, tools: { count: 0, names: [], tokens: 0, unknown: false, definitions: [] }, messages: [], messageCount: 0, blockCount: 0, packagingTokens: 0, extraInputTokens: 0, heuristic: { tokens: 0, unknown: true }, associations: [] }, budget: unknownBudget(0, false) } }) } as never,
    supported() {},
  });
  ui.noteDiagnostic("warning", "KEEP_WARNING");
  for (let i = 0; i < DIAGNOSTIC_LIMIT; i++) ui.noteDiagnostic("warning", `w${i}`);
  assert.equal(ui.recentDiagnostics().length, DIAGNOSTIC_LIMIT);
  assert.equal(ui.recentDiagnostics().some(note => note.message === "KEEP_WARNING"), false);
  assert.equal(ui.currentWarning(), `w${DIAGNOSTIC_LIMIT - 1}`);
  ui.recover();
  assert.equal(ui.currentWarning(), undefined);
  assert.equal(ui.recentDiagnostics().at(-1)?.message, `w${DIAGNOSTIC_LIMIT - 1}`);
});

test("detailsLines distinguishes no-model, unknown, uncapped none, and known zero", () => {
  const layout = { system: { text: "", tokens: 0 }, tools: { count: 0, names: [], tokens: 0, unknown: false, definitions: [] }, messages: [], messageCount: 0, blockCount: 0, packagingTokens: 0, extraInputTokens: 0, heuristic: { tokens: 0, unknown: false }, associations: [] };
  const noModel = detailsLines({
    view: { current: { scope: "current", sessionId: "s", leafId: "l", model: null, revision: "r", occupied: false, unconfirmed: false, contextLayout: { slotCount: 0, activeEntries: 0 }, layout, budget: unknownBudget(0, false) } },
    diagnostics: [],
  });
  assert.match(noModel, /Model: no model/);
  assert.match(noModel, /Maintenance input plan: no model/);
  assert.match(noModel, /Maintenance output cap: no model/);
  assert.doesNotMatch(noModel, /Maintenance output cap: none/);
  assert.equal(quantity(null, true), "no model");
  assert.equal(quantity(null, false), "unknown");
  assert.equal(quantity(0, false), "0");
  assert.equal(capLabel(true, null, false), "none");
  assert.equal(capLabel(false, null, false), "unknown");
  assert.equal(capLabel(true, 0, false), "0");
  const uncapped = detailsLines({
    view: { current: { scope: "current", sessionId: "s", leafId: "l", model: { id: "m", provider: "p", api: "openai-codex-responses" }, revision: "r", occupied: true, unconfirmed: true, contextLayout: { slotCount: 0, activeEntries: 0 }, layout, budget: { ...unknownBudget(0, false), modelWindow: 1000, triggerTokens: 0, plannedInputLimit: 1, mainAdmissionLimit: 2, extractionInputLimit: 3, memoryLimit: 0, memoryOccupied: 0, memoryUnknown: false, outputReserveTokens: 4, outputCapTokens: null, outputCapKnown: true, extractionOutputTokens: 8192, extractionOutputCapTokens: null, extractionOutputCapKnown: true, safetyTokens: 0 } } },
    diagnostics: [],
    currentWarning: "live warning",
  });
  assert.match(uncapped, /Occupied: yes/);
  assert.match(uncapped, /Unconfirmed: yes/);
  assert.match(uncapped, /Current warning: live warning/);
  assert.match(uncapped, /H \/ trigger: 0/);
  assert.match(uncapped, /M occupancy: 0 \/ 0/);
  assert.match(uncapped, /Main output cap: none/);
  assert.match(uncapped, /Maintenance output cap: none/);
  assert.match(uncapped, /Safety: 0/);
  assert.doesNotMatch(uncapped, /no model/);
});

test("ContextSurface uncapped model marks extraction cap none rather than unknown", () => {
  const uncapped = { ...model, api: "openai-codex-responses" as const };
  const session = { getSessionId: () => "s", getLeafId: () => "l", getSessionFile: () => undefined, getBranch: () => [{ id: "l" }], buildContextEntries: () => [] };
  const ctx = { model: uncapped, sessionManager: session, getSystemPrompt: () => "sys" } as unknown as ExtensionContext;
  const memory = {
    read: (_ctx?: ExtensionContext) => ({ revision: "r", memory: emptyMemory(), status: { occupied: false, unconfirmed: false }, budget: { tokens: 0, limit: 100, unknown: false, overLimit: false }, contextLayout: { slotCount: 0, activeEntries: 0 } }),
    replace: () => ({ ok: false as const, code: "invalid" as const, message: "no", view: memory.read() }),
    delete: () => ({ ok: false as const, code: "invalid" as const, message: "no", view: memory.read() }),
  };
  const host = {
    events: { on(_name: string, _fn: (value: unknown) => void) {}, emit(name: string, value: unknown) { if (name === "nunc:context-bind" && typeof value === "function") value(surface); } },
  };
  const surface = createContextSurface({
    pi: host as never,
    memory: memory as never,
    fixed: () => ({ systemPrompt: "sys", tools: [] }),
    config: () => engineConfig({}, uncapped, { reserveTokens: 16384, keepRecentTokens: 1 }),
  });
  const view = surface.read(ctx);
  assert.equal(view.current.budget.extractionOutputCapKnown, true);
  assert.equal(view.current.budget.extractionOutputCapTokens, null);
  assert.equal(view.current.budget.outputCapKnown, true);
  assert.notEqual(view.current.budget.extractionInputLimit, null);
  const none = capLabel(view.current.budget.extractionOutputCapKnown, view.current.budget.extractionOutputCapTokens, view.current.model === null);
  assert.equal(none, "none");
  const missing = { ...ctx, model: undefined };
  const noModel = surface.read(missing as never);
  assert.equal(noModel.current.model, null);
  assert.equal(noModel.current.budget.extractionOutputCapKnown, false);
  assert.equal(capLabel(noModel.current.budget.extractionOutputCapKnown, noModel.current.budget.extractionOutputCapTokens, noModel.current.model === null), "no model");
});

test("last-maintenance engine vs native states stay on ContextSurface used by the report", async t => {
  const captured = port();
  const f = await fixture({ extras: captured.extras });
  t.after(() => f.close());
  f.seed();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.respond(async request => { started.resolve(); await release.promise; return memoryPatch(request); });
  const compacting = f.runtime.session.compact();
  await started.promise;
  const pending = captured.context().read(captured.ctx());
  assert.equal(pending.lastMaintenance?.native, "pending");
  assert.equal(pending.lastMaintenance?.engine, undefined);
  const pendingReport = detailsLines({ view: pending, diagnostics: [] });
  assert.match(pendingReport, /Engine: pending · native pending/);
  assert.match(pendingReport, /candidate success is not a native save/);
  release.resolve();
  await compacting;
  const saved = captured.context().read(captured.ctx());
  assert.equal(saved.lastMaintenance?.engine, "ok");
  assert.equal(saved.lastMaintenance?.native, "saved");
  const savedReport = detailsLines({ view: saved, diagnostics: [] });
  assert.match(savedReport, /Native save: saved/);
  assert(saved.lastMaintenance?.accounting);
  assert.match(savedReport, new RegExp(`full ${saved.lastMaintenance.accounting.fullExtractionTokens.toLocaleString("en-US")} → selected ${saved.lastMaintenance.accounting.extractionTokens.toLocaleString("en-US")}`));
  assert.match(savedReport, new RegExp(`Last-maintenance input plan: ${saved.lastMaintenance.accounting.extractionInputLimit.toLocaleString("en-US")}`));
});

test("last-maintenance input plan stays on frozen accounting after current model/budget change", async t => {
  const captured = port();
  const f = await fixture({ extras: captured.extras });
  t.after(() => f.close());
  f.seed(); f.respond(memoryPatch);
  await f.runtime.session.compact();
  const saved = captured.context().read(captured.ctx());
  const frozen = saved.lastMaintenance?.accounting?.extractionInputLimit;
  const frozenModel = saved.lastMaintenance?.model.id;
  assert(typeof frozen === "number");
  assert.equal(saved.current.model?.id, frozenModel);
  await f.runtime.session.setModel(f.faux.getModel("small")!);
  const switched = captured.context().read(captured.ctx());
  assert.equal(switched.lastMaintenance?.accounting?.extractionInputLimit, frozen);
  assert.equal(switched.lastMaintenance?.model.id, frozenModel);
  assert.notEqual(switched.current.model?.id, frozenModel);
  assert.notEqual(switched.current.budget.extractionInputLimit, frozen);
  const report = detailsLines({ view: switched, diagnostics: [] });
  const currentPlan = switched.current.budget.extractionInputLimit!.toLocaleString("en-US");
  const frozenPlan = frozen.toLocaleString("en-US");
  assert.match(report, new RegExp(`Maintenance input plan: ${currentPlan}`));
  assert.match(report, new RegExp(`Last-maintenance input plan: ${frozenPlan}`));
  assert.doesNotMatch(report, new RegExp(`Last-maintenance input plan: ${currentPlan}`));
  for (const line of maintenanceLines(switched.lastMaintenance)) {
    if (line.startsWith("Last-maintenance input plan:")) assert.equal(line, `Last-maintenance input plan: ${frozenPlan}`);
  }
});

test("session reset drops last maintenance from the shared report source without a model call", async t => {
  const captured = port();
  const f = await fixture({ extras: captured.extras });
  t.after(() => f.close());
  f.seed(); f.respond(memoryPatch);
  await f.runtime.session.compact();
  assert(captured.context().read(captured.ctx()).lastMaintenance);
  const calls = f.faux.state.callCount;
  await f.runtime.newSession();
  const empty = captured.context().read(captured.ctx());
  assert.equal(empty.lastMaintenance, undefined);
  assert.match(detailsLines({ view: empty, diagnostics: [] }), /No maintenance record in this context/);
  assert.equal(f.faux.state.callCount, calls);
});

