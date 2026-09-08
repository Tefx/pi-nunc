import { test } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "@earendil-works/pi-ai";
import { checkCapacityRecovery, qualifyCapacity } from "../../src/live/capacity-observation.js";
import { evaluateCapacityPredicates } from "../../src/live/scenarios.js";
import type { MaintenanceResult, Memory } from "../../src/engine/types.js";

test("capacity qualification rejects malformed references, empty required sets and unknown limits", () => {
  const base = { add: [{ key: "r", text: "long necessary" }, { key: "o", text: "x" }], remove: [], priority: ["r", "o"], required: ["r"] };
  for (const patch of [{ ...base, required: ["missing"] }, { ...base, required: [] }, { ...base, priority: ["r"] }, undefined]) {
    assert(evaluateCapacityPredicates("fits-required", patch, 20, slots => slots.length).every(c => c.status === "UNPROVEN"));
  }
  assert.equal(evaluateCapacityPredicates("fits-required", base, NaN, slots => slots.length)[0]!.status, "UNPROVEN");
});

test("capacity reconstruction uses frozen nextId and collision-aware actual rendered IDs", () => {
  const seen: string[][] = [];
  const patch = { add: [{ key: "r", text: "necessary" }, { key: "o", text: "x" }], remove: ["s9"], priority: ["r", "o"], required: ["r"] };
  evaluateCapacityPredicates("fits-required", patch, 50, slots => { seen.push(slots.map(s => s.id)); return slots.reduce((n, s) => n + s.id.length + s.text.length, 0); }, [{ id: "s9", text: "old" }], 9);
  assert.deepEqual(seen[0], ["s10"]);
  assert.deepEqual(seen[1], ["s10", "s11"]);
  const exhausted = evaluateCapacityPredicates("fits-required", { ...patch, remove: [] }, 50, () => 0, [], Number.MAX_SAFE_INTEGER);
  assert.equal(exhausted[0]!.status, "UNPROVEN");
});

test("capacity source binding rejects stale response, missing request/accounting and changed frozen M", () => {
  const memory: Memory = { version: 1, slots: [], nextId: 10 };
  const context: Context = { systemPrompt: "Rendered memory limit: 50 estimated tokens", messages: [{ role: "user", timestamp: 0, content: JSON.stringify({ source: "F/M", M: [] }) }] };
  // Only the accounting field consumed by this component is supplied; native-host evidence is separate.
  const result = { ok: false, code: "CAPACITY", observations: { accounting: { memoryLimit: 50 } } } as MaintenanceResult;
  const response = { model: "test/model", stopReason: "stop", patch: { add: [{ key: "r", text: "note" }], remove: [], priority: ["r"], required: ["r"] } };
  const run = (contexts = [context], responses = [response], mem = memory, res: MaintenanceResult | undefined = result) => qualifyCapacity("fits-required", mem, res, contexts, responses, "test/model");
  assert.equal(run()[0]!.status, "PROVEN");
  assert.equal(run()[0]!.observed && (run()[0]!.observed as { nextId: number }).nextId, 10);
  for (const checks of [run([]), run([context], []), run([context], [response, response]), run([context], [{ ...response, stopReason: "length" }]), run([context], [{ ...response, model: "other/model" }]), run([context], [response], { ...memory, slots: [{ id: "s1", text: "old" }] }), qualifyCapacity("fits-required", memory, undefined, [context], [response], "test/model")]) {
    assert.equal(checks[0]!.status, "UNPROVEN");
  }
});

test("capacity recovery needs a real failed transaction, one delivered input, unchanged checkpoint and no repeat maintenance", () => {
  const facts = { capacityFailed: true, deliveredCount: 1, terminalStop: true, memoryAndBoundaryUnchanged: true, additionalMaintenance: 0 };
  assert.equal(checkCapacityRecovery(facts).status, "PROVEN");
  for (const delta of [{ capacityFailed: false }, { deliveredCount: 0 }, { deliveredCount: 2 }, { terminalStop: false }, { memoryAndBoundaryUnchanged: false }, { additionalMaintenance: 1 }]) {
    assert.equal(checkCapacityRecovery({ ...facts, ...delta }).status, "UNPROVEN");
  }
});
