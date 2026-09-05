import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPatch, emptyMemory, maintain, memoryTokens, renderMemory } from "../../src/engine/index.js";
import type { Memory } from "../../src/engine/index.js";
import { input, responder } from "./fixtures.js";

const initial: Memory = { version: 1, nextId: 5, slots: [
  { id: "s1", text: "Old error" }, { id: "s2", text: "Exact unchanged\ncondition: Node 18 only." }, { id: "s4", text: "Another old claim" },
] };

test("transaction merges/replaces incrementally, keeps bodies/order, appends generated IDs", async () => {
  const source = await input(); source.memory = structuredClone(initial);
  const before = structuredClone(source.memory);
  const result = await maintain(source, responder({ remove: ["s1", "s4"], add: [{ key: "combined", text: "Corrected joint conclusion" }], priority: ["combined", "s2"] }));
  assert(result.ok, result.ok ? "" : result.message);
  assert.deepEqual(result.candidate.memory.slots, [initial.slots[1], { id: "s5", text: "Corrected joint conclusion" }]);
  assert.equal(result.candidate.memory.nextId, 6);
  assert.equal(result.candidate.summary, renderMemory(result.candidate.memory.slots));
  assert.deepEqual(source.memory, before);
  assert.equal(result.observations.requests, 1);
});

test("capacity selects whole slots by priority without resurrecting explicitly invalidated old text", async () => {
  const source = await input(); source.memory = structuredClone(initial);
  source.config.memory.maxTokens = memoryTokens([initial.slots[1]!]);
  const result = await maintain(source, responder({ remove: ["s1", "s4"], add: [{ key: "tooBig", text: "corrected".repeat(1000) }], priority: ["tooBig", "s2"] }));
  assert(result.ok, result.ok ? "" : result.message);
  assert.deepEqual(result.candidate.memory.slots, [initial.slots[1]]);
  assert.deepEqual(result.observations.droppedSlotIds, ["s5"]);
  assert(result.candidate.memory.slots.every(s => s.id !== "s1"));
});

test("exact rendered boundary includes IDs/wrappers; insufficient budget skips complete body", () => {
  const patch = { add: [{ key: "new", text: "é🦉 exact body" }], remove: [], priority: ["new"] };
  const slot = { id: "s1", text: patch.add[0]!.text };
  const size = memoryTokens([slot]);
  assert.deepEqual(applyPatch(emptyMemory(), patch, size, memoryTokens).memory.slots, [slot]);
  assert.deepEqual(applyPatch(emptyMemory(), patch, size - 1, memoryTokens).memory.slots, []);
  assert(size > Buffer.byteLength(slot.text));
});

test("no capacity competition preserves natural order despite reversed priority", () => {
  const result = applyPatch(initial, { add: [{ key: "new", text: "new" }], remove: [], priority: ["new", "s4", "s2", "s1"] }, 10000, memoryTokens);
  assert.deepEqual(result.memory.slots.slice(0, 3), initial.slots);
  assert.equal(result.memory.slots[3]!.id, "s5");
});

test("zero memory fraction and explicit full retirement both permit empty snapshots", async () => {
  const source = await input(); source.memory = structuredClone(initial); source.config.memory.fraction = 0;
  const result = await maintain(source, responder({ add: [], remove: [], priority: ["s1", "s2", "s4"] }));
  assert(result.ok, result.ok ? "" : result.message);
  assert.deepEqual(result.candidate.memory.slots, []);
  assert.equal(result.observations.accounting!.memoryLimit, 0);
  assert.deepEqual(applyPatch(initial, { add: [], remove: ["s1", "s2", "s4"], priority: [] }, 0, memoryTokens).memory.slots, []);
});

const invalid = [
  {}, { add: [], remove: [], priority: [] },
  { add: [], remove: ["missing"], priority: ["s1", "s2", "s4"] },
  { add: [], remove: ["s1", "s1"], priority: ["s2", "s4"] },
  { add: [], remove: [], priority: ["s1", "s2", "s4", "s4"] },
  { add: [], remove: [], priority: ["s1", "s2", "missing"] },
  { add: [{ key: "s1", text: "changed" }], remove: ["s1"], priority: ["s1", "s2", "s4"] },
  { add: [{ key: "x", text: "x" }, { key: "x", text: "y" }], remove: [], priority: ["s1", "s2", "s4", "x"] },
  { add: [{ key: "x", text: "   " }], remove: [], priority: ["s1", "s2", "s4", "x"] },
  { add: [{ key: "x", text: "x" }], remove: [], priority: ["s1", "s2", "s4"] },
  { add: [], remove: ["s1"], priority: ["s1", "s2", "s4"] },
  { add: [], remove: [], priority: ["s1", "s2", "s4"], rewrite: [] },
];
for (const [i, patch] of invalid.entries()) test(`invalid reference/omission/shape ${i} yields explicit failure, no candidate and no repair`, async () => {
  const source = await input(); source.memory = structuredClone(initial);
  const result = await maintain(source, responder(patch));
  assert(!result.ok); assert.equal(result.code, "RESPONSE"); assert(!("candidate" in result));
  assert.equal(result.observations.requests, 1); assert.deepEqual(source.memory, initial);
});

test("generated IDs avoid imported collisions and remain monotonic even for discarded additions", () => {
  const first = applyPatch({ version: 1, nextId: 1, slots: [{ id: "s1", text: "imported" }] }, { remove: ["s1"], add: [{ key: "x", text: "new" }], priority: ["x"] }, 0, memoryTokens);
  assert.equal(first.memory.nextId, 3);
  const next = applyPatch(first.memory, { remove: [], add: [{ key: "x", text: "new" }], priority: ["x"] }, 500, memoryTokens);
  assert.equal(next.memory.slots[0]!.id, "s3");
});
