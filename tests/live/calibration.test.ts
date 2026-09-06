import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { emptyMemory, loadPolicy, type MaintenanceInput } from "../../src/engine/index.js";
import { engineConfig } from "../../src/pi/index.js";
import { calibrateRetention } from "../../src/live/calibration.js";

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
