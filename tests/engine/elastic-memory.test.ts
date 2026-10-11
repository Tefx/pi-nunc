import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { applyPatch, maintain, memoryPlan, memoryTokens, renderMemory } from "../../src/engine/index.js";
import { answer, input, sourceRecords, user } from "./fixtures.js";

const scale = 1000 / estimateTextTokens("x".repeat(4000));
const requiredText = "Active goal: finish implementation and verification; preserve exact pending constraints.\n" + "a".repeat(Math.floor(31000 * scale));
const newText = "Unfinished integration obligation with exact source state.\n" + "b".repeat(3200);
const patch = { add: [{ key: "next", text: newText }, { key: "optional", text: "Completed process background" }], remove: [], priority: ["optional", "s1", "next"], required: ["s1", "next"] };
const original = { version: 1 as const, nextId: 2, slots: [{ id: "s1", text: requiredText }] };

test("soft target retains required over target, no optional, no truncation or permanent required field", () => {
  const result = applyPatch(original, patch, { targetTokens: 8192 }, memoryTokens);
  assert(memoryTokens(original.slots) < 8192);
  assert(memoryTokens(result.memory.slots) > 8192);
  assert.deepEqual(result.memory.slots.map(s => s.text), [requiredText, newText]);
  assert.equal(result.required.failed, false);
  assert.deepEqual(result.required.retainedSlotIds, ["s1", "s2"]);
  assert(result.droppedSlotIds.includes("s3"));
  assert.deepEqual(Object.keys(result.memory.slots[0]!).sort(), ["id", "text"]);
  assert.deepEqual(original.slots, [{ id: "s1", text: requiredText }]);
});

test("under target admits optional by whole-slot priority; numeric API and explicit hard caps still bind", () => {
  const small = { ...original, slots: [{ id: "s1", text: "unfinished" }] };
  const fit = applyPatch(small, { ...patch, add: [{ key: "next", text: "required" }, { key: "optional", text: "optional" }] }, { targetTokens: 8192 }, memoryTokens);
  assert.equal(fit.memory.slots.length, 3);
  for (const budget of [8192, { targetTokens: 8192, hardMaxTokens: 8192 }]) {
    assert.throws(() => applyPatch(original, patch, budget, memoryTokens), (error: any) => error.code === "CAPACITY" && error.required.failed === true);
  }
  const zeroTarget = applyPatch(small, { add: [], remove: [], priority: ["s1"], required: ["s1"] }, { targetTokens: 0 }, memoryTokens);
  assert.equal(zeroTarget.memory.slots[0]?.text, "unfinished");
});

test("prior required has no permanent pin: a valid later revision/removal can shrink below target", () => {
  const grown = applyPatch(original, patch, { targetTokens: 8192 }, memoryTokens);
  // Scripted proposals exercise enforcement/retirement, not model completion judgment.
  const retained = "Unfinished subgoal: verify persistence; preserve exact limit 17 and do not deploy without approval.";
  const retired = applyPatch(grown.memory, { add: [{ key: "remaining", text: retained }], remove: grown.memory.slots.map(s => s.id), priority: ["remaining"], required: ["remaining"] }, { targetTokens: 8192 }, memoryTokens);
  assert.deepEqual(retired.memory.slots.map(s => s.text), [retained]);
  assert(memoryTokens(retired.memory.slots) < 8192);
});

test("large current M reduces next K target without changing q, scheduler or the original cut after output growth", async () => {
  const source = await input(); source.memory = structuredClone(original);
  source.active = [user("old", "old evidence " + "x".repeat(14000)), user("middle", "continued evidence " + "y".repeat(6000)), user("latest", "Finish the active task")];
  const before = structuredClone(source);
  const planned = memoryPlan(source.fixed, source.model, source.config, source.memory.slots);
  let calls = 0, extractionCut = "";
  const result = await maintain(source, async request => {
    calls++;
    const records = sourceRecords(request.context);
    extractionCut = records.find(r => r.region === "K")!.entryId;
    return answer(patch, request.model);
  });
  assert(result.ok, result.ok ? "" : result.message);
  assert.equal(calls, 1);
  assert.equal(result.candidate.firstKeptEntryId, extractionCut, "no post-response recut");
  assert.deepEqual(result.candidate.kept, source.active.slice(source.active.findIndex(e => e.entryId === extractionCut)));
  assert.equal(result.observations.accounting?.memoryTargetExceeded, true);
  assert.equal(result.observations.accounting?.memoryHardLimit, null);
  assert.equal(result.observations.accounting?.memoryReserveTokens, memoryTokens(original.slots));
  const next = memoryPlan(source.fixed, source.model, source.config, result.candidate.memory.slots);
  assert(next.memoryReserveTokens > planned.memoryReserveTokens);
  assert(next.keepTarget < planned.keepTarget);
  assert.equal(next.keepTarget, Math.floor(source.config.keepRecentFraction * Math.max(0, next.available - next.memoryReserveTokens)));
  assert.equal(next.effectiveTrigger, planned.effectiveTrigger);
  assert.equal(source.config.keepRecentFraction, before.config.keepRecentFraction);
  assert.deepEqual(source.memory, before.memory);
  assert.equal(result.candidate.summary, renderMemory(result.candidate.memory.slots));
});

test("required exceeding explicit hard cap fails without an extra call or candidate", async () => {
  const source = await input(); source.memory = structuredClone(original); source.config.memory.hardMaxTokens = 8192;
  let calls = 0;
  const result = await maintain(source, async request => { calls++; return answer(patch, request.model); });
  assert(!result.ok); assert.equal(result.code, "CAPACITY");
  assert.equal(result.observations.accounting?.memoryHardLimit, 8192);
  assert.equal(calls, 1);
  assert.equal(result.observations.required?.failed, true);
});
