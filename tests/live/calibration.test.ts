import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { emptyMemory, loadPolicy, type MaintenanceInput } from "../../src/engine/index.js";
import { engineConfig } from "../../src/pi/index.js";
import { calibrateRetention } from "../../src/live/calibration.js";
import { maintain } from "../../src/engine/engine.js";
import { decideToolResultCleanup, applyToolResultCleanup, retainedToolResultCleanup } from "../../src/engine/cleanup.js";
import { historyPlanningEstimate } from "../../src/engine/accounting.js";
import { input, responder, user, assistant, tool } from "../engine/fixtures.js";

test("low-water calibration predicts the boundary that actual maintenance independently selects", async () => {
  const source = await input();
  source.model.contextWindow = 200000;
  source.config = engineConfig({ rolling: { keepRecentFraction: 0.5 } }, source.model, { reserveTokens: 16384, keepRecentTokens: 1 });
  source.active = [user("a", "old ".repeat(8000)), user("b", "retained ".repeat(1000)), user("c", "latest ".repeat(1000))];
  const control = { afterTurn: "c", action: "rollover" as const, placement: { retireThroughTurn: "a", retainTurns: ["b", "c"] } };
  const turns = { a: ["a"], b: ["b"], c: ["c"] }, order = ["a", "b", "c"], range = { minFraction: 0.0001, maxFraction: 0.9999 };
  assert.throws(() => calibrateRetention(source, control, turns, order, { ...range, maxFraction: 0.2 }), /No legal retained boundary/);
  const calibrated = calibrateRetention(source, control, turns, order, range);
  assert.equal(calibrated.firstKeptEntryId, "b");
  source.config.keepRecentFraction = calibrated.selectedFraction;
  const result = await maintain(source, responder());
  assert(result.ok, result.ok ? "" : result.message);
  assert.equal(result.candidate.firstKeptEntryId, "b");
  assert.equal(result.observations.accounting!.keepTarget, calibrated.accounting.keepTarget);
  assert.deepEqual(result.candidate.kept.map(e => e.entryId), ["b", "c"]);
  source.config.keepRecentTargetTokens = 10;
  assert.throws(() => calibrateRetention(source, control, turns, order, range), /No legal retained boundary/);
});

test("calibration and maintain share cleanup-aware history, per-cut dependencies and extraction sources", async () => {
  for (const dependent of [false, true]) for (const disabled of [false, true]) for (const keepBoth of [false, true]) {
    const source = await input();
    source.model.contextWindow = 200000;
    source.config = engineConfig({ rolling: { keepRecentFraction: 0.5 } }, source.model, { reserveTokens: 16384, keepRecentTokens: 1 });
    source.config.toolResultCleanup = !disabled;
    const body = JSON.stringify({ payload: "evidence".repeat(500) }, null, 200);
    const exchange = (id: string) => [assistant(`${id}-call`, [{ type: "toolCall", id, name: "read", arguments: { path: dependent ? "source.json" : `${id}.json` } }]), tool(`${id}-result`, id, body)];
    source.active = [user("a", "Old history ".repeat(6000)), ...exchange("b"), ...exchange("c"), user("d", "Continue ".repeat(100))];
    source.priorCleanup = decideToolResultCleanup({ active: source.active, retainedEntries: source.active,
      initialMemory: source.memory, finalMemory: source.memory, mechanicalWhenMemoryUnchanged: true,
      candidateScope: dependent ? [{ entryId: "c-result", messageIndex: 0 }] : [{ entryId: "b-result", messageIndex: 0 }, { entryId: "c-result", messageIndex: 0 }],
    }).applied;
    assert(source.priorCleanup.some(d => d.action === (dependent ? "deduplicate" : "compact_json")));
    const turns = { a: ["a"], b: ["b-call", "b-result"], c: ["c-call", "c-result"], d: ["d"] };
    const control = { afterTurn: "d", action: "rollover" as const, placement: { retireThroughTurn: keepBoth ? "a" : "b", retainTurns: keepBoth ? ["b", "c", "d"] : ["c", "d"] } };
    const calibrated = calibrateRetention(source, control, turns, ["a", "b", "c", "d"], { minFraction: 0.00001, maxFraction: 0.99999 });
    source.config.keepRecentFraction = calibrated.selectedFraction;
    const result = await maintain(source, responder());
    assert(result.ok, result.ok ? "" : result.message);
    assert.equal(result.candidate.firstKeptEntryId, calibrated.firstKeptEntryId);
    assert.equal(calibrated.firstKeptEntryId, keepBoth ? "b-call" : "c-call");
    const accounting = result.observations.accounting!;
    assert.equal(accounting.keepTarget, calibrated.accounting.keepTarget);
    assert.equal(accounting.keptTokens, calibrated.accounting.keptTokens);
    assert.equal(accounting.fullExtractionTokens, calibrated.accounting.fullExtractionTokens);
    assert.equal(accounting.extractionTokens, calibrated.accounting.extractionTokens);
    assert.equal(accounting.normalExtractionAtTrigger, calibrated.accounting.normalExtractionAtTrigger);
    const kept = source.active.slice(keepBoth ? 1 : 3);
    const effective = applyToolResultCleanup(kept, retainedToolResultCleanup(kept, disabled ? [] : source.priorCleanup));
    assert.equal(accounting.keptTokens, historyPlanningEstimate(effective, source.model).tokens);
    if (dependent && !keepBoth) assert.deepEqual(retainedToolResultCleanup(kept, source.priorCleanup), [], "sourceRefs expire independently for each cut");
    if (!dependent && !disabled) assert(accounting.keptTokens < historyPlanningEstimate(kept, source.model).tokens);
  }
});

test("calibration refuses illegal tool association cuts and absent retained entries", async () => {
  const provider = fauxProvider({ provider: "nunc-calibration", models: [{ id: "short", contextWindow: 60000, maxTokens: 4096 }] }), model = provider.getModel();
  const source: MaintenanceInput = {
    binding: { sessionId: "fixture", leafId: "end", generation: "fixture" }, model, fixed: { systemPrompt: "Work on the task.", tools: [] }, memory: emptyMemory(),
    active: [
      { entryId: "a", sourceRole: "user", messages: [{ role: "user", content: "Read the file.", timestamp: 1 }] },
      { entryId: "call", sourceRole: "assistant", messages: [fauxAssistantMessage(fauxToolCall("read", { path: "file" }, { id: "call-id" }), { stopReason: "toolUse" })] },
      { entryId: "result", sourceRole: "toolResult", messages: [{ role: "toolResult", toolCallId: "call-id", toolName: "read", isError: false, content: [{ type: "text", text: "Observed." }], timestamp: 2 }] },
      { entryId: "b", sourceRole: "user", messages: [{ role: "user", content: "Continue later.", timestamp: 3 }] },
    ],
    policy: await loadPolicy(), config: engineConfig({}, model, { reserveTokens: 50000, keepRecentTokens: 1 }), signal: new AbortController().signal,
  };
  const control = { afterTurn: "b", action: "rollover" as const, placement: { retireThroughTurn: "a", retainTurns: ["b"] } }, range = { minFraction: 0.0001, maxFraction: 0.95 };
  assert.throws(() => calibrateRetention(source, control, { a: ["a", "call"], b: ["result", "b"] }, ["a", "b"], range), /No legal retained boundary/);
  assert.throws(() => calibrateRetention(source, control, { a: ["a", "call", "result"], b: ["missing"] }, ["a", "b"], range), /absent/);
  assert.throws(() => calibrateRetention({ ...source, eligibleKeptEntryIds: ["call"] }, control, { a: ["a", "call", "result"], b: ["b"] }, ["a", "b"], range), /No legal retained boundary/);
  const valid = calibrateRetention(source, control, { a: ["a", "call", "result"], b: ["b"] }, ["a", "b"], range);
  assert.equal(valid.firstKeptEntryId, "b"); assert.equal(provider.state.callCount, 0);
});
