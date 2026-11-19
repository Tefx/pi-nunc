import { test } from "node:test";
import assert from "node:assert/strict";
import { input, responder, user, assistant, tool } from "./fixtures.js";
import { maintain } from "../../src/engine/engine.js";
import { chooseCut, historyPlanningEstimate, mainPlanningEstimate, memoryTokens, messageTokens } from "../../src/engine/accounting.js";
import { memoryMessage } from "../../src/engine/memory.js";
import { applyToolResultCleanup, retainedToolResultCleanup } from "../../src/engine/cleanup.js";
import { legalCuts } from "../../src/engine/validation.js";
import { maintenanceCalibrationRecord, selectMaintenanceCalibration } from "../../src/engine/calibration.js";
import type { MechanicalFallbackInfo, ToolResultDecision } from "../../src/engine/types.js";

test("oversized unfinished turn retires completed tool batches while small turns stay aligned", async () => {
  const s = await input();
  s.active = [user("old", "old"), assistant("done", [{ type: "text", text: "Completed response." }]), user("task", "Continue"),
    ...Array.from({ length: 8 }, (_, i) => [assistant(`a${i}`, [{ type: "toolCall", id: `c${i}`, name: "read", arguments: { path: `file${i}` } }]), tool(`t${i}`, `c${i}`, "evidence ".repeat(600))]).flat()];
  const cuts = legalCuts(s.active);
  const large = chooseCut(s.active, cuts, 100, 1000, 2000, 25000, s.config);
  assert(large.cut > 2 && cuts.includes(large.cut));
  assert(large.keptTokens < 3000);
  const wholeTurn = historyPlanningEstimate(s.active.slice(2), s.model).tokens;
  const small = chooseCut(s.active, cuts, 100, 1000, wholeTurn + 100, 25000, s.config);
  assert(small.cut <= 2, "a current turn that fits stays intact");
  const result = await maintain({ ...s, config: { ...s.config, keepRecentTargetTokens: 2000 } }, responder());
  assert(result.ok, result.ok ? "" : result.message);
  assert(result.candidate.retiredEntryIds.includes("t0"));
  assert.deepEqual(result.candidate.kept, s.active.slice(result.candidate.retiredEntryIds.length));
});

for (const action of ["deduplicate", "strip_boilerplate", "replace"] as const) {
  for (const keepSource of [false, true]) test(`${action} prior cleanup uses only retained source dependencies: ${keepSource}`, async () => {
    const s = await input();
    const body = "Unique full original evidence. ".repeat(350);
    s.active = [user("old", "old ".repeat(600)), assistant("call0", [{ type: "toolCall", id: "c0", name: "read", arguments: {} }]), tool("source", "c0", "source ".repeat(100)),
      assistant("call1", [{ type: "toolCall", id: "c1", name: "read", arguments: {} }]), tool("target", "c1", body), user("latest", "Continue")];
    const decision: ToolResultDecision = { entryId: "target", messageIndex: 0, toolCallId: "c1", toolName: "read", kind: action === "replace" ? "semantic" : "mechanical", action,
      text: "Short marker", originalLength: body.length, cleanedLength: 12, netSavings: body.length - 12, sourceRefs: [{ entryId: "source", messageIndex: 0 }] };
    s.priorCleanup = [decision];
    // Force each side of the cut; the production planner must measure this exact suffix.
    s.eligibleKeptEntryIds = [keepSource ? "call0" : "call1"];
    s.config.extraction.toolResults = "full";
    s.target = { model: s.model, config: s.config };
    const result = await maintain(s, responder());
    assert(result.ok, result.ok ? "" : result.message);
    const candidate = result.candidate;
    assert.equal(candidate.toolResultCleanup?.applied.length, keepSource ? 1 : 0);
    const expected = applyToolResultCleanup(candidate.kept, retainedToolResultCleanup(candidate.kept, [decision]));
    const tokens = mainPlanningEstimate(s.fixed, candidate.memory.slots, expected, s.model, s.config.imageTokens, s.config.main.extraInputTokens).tokens;
    assert.equal(result.observations.accounting!.mainAfterTokens, tokens);
    assert.equal(result.observations.target!.estimatedInputTokens, tokens);
    assert.equal(result.observations.accounting!.keptTokens, historyPlanningEstimate(expected, s.model).tokens);
    const calibration = maintenanceCalibrationRecord(s, result)!;
    const rebound = { ...s, active: candidate.kept, memory: candidate.memory };
    assert.equal(selectMaintenanceCalibration(rebound, [calibration]).length, 1, "calibration binds the raw suffix used by the next extraction");
  });
}

test("target preflight rejects raw K restored by an expired prior cleanup without dispatch", async () => {
  const s = await input();
  const body = "large retained source ".repeat(1000);
  s.active = [user("old", "old"), assistant("source-call", [{ type: "toolCall", id: "c0", name: "read", arguments: {} }]), tool("source", "c0", "keeper"),
    assistant("target-call", [{ type: "toolCall", id: "c1", name: "read", arguments: {} }]), tool("target", "c1", body)];
  s.priorCleanup = [{ entryId: "target", messageIndex: 0, toolCallId: "c1", toolName: "read", kind: "semantic", action: "replace",
    text: "Consumed.", originalLength: body.length, cleanedLength: 9, netSavings: body.length - 9, sourceRefs: [{ entryId: "source", messageIndex: 0 }] }];
  s.eligibleKeptEntryIds = ["target-call"];
  s.config.extraction.toolResults = "full";
  s.target = { model: s.model, config: { ...s.config, triggerTokens: 4000, growthTokens: 100 } };
  const result = await maintain(s, async () => assert.fail("raw restored K cannot fit the target"));
  assert(!result.ok);
  assert.equal(result.code, "CAPACITY");
  assert.equal(result.observations.requests, 0);
  assert.equal(result.observations.target!.fits, false);
});

test("fallback memory uses the same text-block framing as the delivered carrier", () => {
  const fallback: MechanicalFallbackInfo = { code: "RESPONSE", message: "Invalid JSON", retiredEntryCount: 4, firstKeptEntryId: "kept" };
  for (const slots of [[], [{ id: "s1", text: "Preserve this result." }]]) {
    const message = memoryMessage(slots, fallback);
    assert(Array.isArray(message.content));
    assert.equal(memoryTokens(slots, undefined, fallback), messageTokens(message));
    const text = message.content[0];
    assert(text?.type === "text");
    assert.equal(memoryTokens(slots, undefined, fallback), messageTokens({ role: "user", content: text.text, timestamp: 0 }) + 16);
  }
  assert.equal(memoryTokens([]), 0);
});
