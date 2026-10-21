import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { emptyMemory, loadPolicy, type MaintenanceInput } from "../../src/engine/index.js";
import { engineConfig } from "../../src/pi/index.js";
import { calibrateRetention } from "../../src/live/calibration.js";
import { maintain } from "../../src/engine/engine.js";
import { input, responder, user } from "../engine/fixtures.js";

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
