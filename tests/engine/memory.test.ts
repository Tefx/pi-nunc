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
  const result = await maintain(source, responder({ remove: ["s1", "s4"], add: [{ key: "combined", text: "Corrected joint conclusion" }], priority: ["combined", "s2"], required: ["combined"] }));
  assert(result.ok, result.ok ? "" : result.message);
  assert.deepEqual(result.candidate.memory.slots, [initial.slots[1], { id: "s5", text: "Corrected joint conclusion" }]);
  assert.equal(result.candidate.memory.nextId, 6);
  assert.equal(result.candidate.summary, renderMemory(result.candidate.memory.slots));
  assert.deepEqual(source.memory, before);
  assert.equal(result.observations.requests, 1);
  assert.deepEqual(result.observations.required?.declared, ["combined"]);
  assert.deepEqual(result.observations.required?.retainedSlotIds, ["s5"]);
  assert.equal(result.observations.required?.failed, false);
});

test("capacity selects whole slots by priority without resurrecting explicitly invalidated old text", async () => {
  const source = await input(); source.memory = structuredClone(initial);
  source.config.memory.maxTokens = memoryTokens([initial.slots[1]!]);
  const result = await maintain(source, responder({ remove: ["s1", "s4"], add: [{ key: "tooBig", text: "corrected".repeat(1000) }], priority: ["tooBig", "s2"], required: [] }));
  assert(result.ok, result.ok ? "" : result.message);
  assert.deepEqual(result.candidate.memory.slots, [initial.slots[1]]);
  assert.deepEqual(result.observations.droppedSlotIds, ["s5"]);
  assert(result.candidate.memory.slots.every(s => s.id !== "s1"));
  assert.equal(result.observations.required?.failed, false);
});

test("exact rendered boundary includes IDs/wrappers; insufficient budget skips complete body", () => {
  const patch = { add: [{ key: "new", text: "é🦉 exact body" }], remove: [], priority: ["new"], required: [] };
  const slot = { id: "s1", text: patch.add[0]!.text };
  const size = memoryTokens([slot]);
  assert.deepEqual(applyPatch(emptyMemory(), patch, size, memoryTokens).memory.slots, [slot]);
  assert.deepEqual(applyPatch(emptyMemory(), patch, size - 1, memoryTokens).memory.slots, []);
  assert(size > Buffer.byteLength(slot.text));
});

test("no capacity competition preserves natural order despite reversed priority", () => {
  const result = applyPatch(initial, { add: [{ key: "new", text: "new" }], remove: [], priority: ["new", "s4", "s2", "s1"], required: [] }, 10000, memoryTokens);
  assert.deepEqual(result.memory.slots.slice(0, 3), initial.slots);
  assert.equal(result.memory.slots[3]!.id, "s5");
});

test("zero memory fraction and explicit full retirement both permit empty snapshots", async () => {
  const source = await input(); source.memory = structuredClone(initial); source.config.memory.fraction = 0;
  const result = await maintain(source, responder({ add: [], remove: [], priority: ["s1", "s2", "s4"], required: [] }));
  assert(result.ok, result.ok ? "" : result.message);
  assert.deepEqual(result.candidate.memory.slots, []);
  assert.equal(result.observations.accounting!.memoryLimit, 0);
  assert.deepEqual(applyPatch(initial, { add: [], remove: ["s1", "s2", "s4"], priority: [], required: [] }, 0, memoryTokens).memory.slots, []);
});

const invalid = [
  {},
  { add: [], remove: [], priority: [], required: [] },
  { add: [], remove: ["missing"], priority: ["s1", "s2", "s4"], required: [] },
  { add: [], remove: ["s1", "s1"], priority: ["s2", "s4"], required: [] },
  { add: [], remove: [], priority: ["s1", "s2", "s4", "s4"], required: [] },
  { add: [], remove: [], priority: ["s1", "s2", "missing"], required: [] },
  { add: [{ key: "s1", text: "changed" }], remove: ["s1"], priority: ["s1", "s2", "s4"], required: [] },
  { add: [{ key: "x", text: "x" }, { key: "x", text: "y" }], remove: [], priority: ["s1", "s2", "s4", "x"], required: [] },
  { add: [{ key: "x", text: "   " }], remove: [], priority: ["s1", "s2", "s4", "x"], required: [] },
  { add: [{ key: "x", text: "x" }], remove: [], priority: ["s1", "s2", "s4"], required: [] },
  { add: [], remove: ["s1"], priority: ["s1", "s2", "s4"], required: [] },
  { add: [], remove: [], priority: ["s1", "s2", "s4"], required: [], rewrite: [] },
  { add: [], remove: [], priority: ["s1", "s2", "s4"] }, // missing required field
  { add: [], remove: [], priority: ["s1", "s2", "s4"], required: "not-an-array" },
  { add: [], remove: [], priority: ["s1", "s2", "s4"], required: ["s1", "s1"] }, // duplicate in required
  { add: [], remove: [], priority: ["s1", "s2", "s4"], required: ["unknown"] }, // unknown in required
  { add: [], remove: ["s1"], priority: ["s2", "s4"], required: ["s1"] }, // deleted ref in required
];
for (const [i, patch] of invalid.entries()) test(`invalid reference/omission/shape ${i} yields explicit failure, no candidate and no repair`, async () => {
  const source = await input(); source.memory = structuredClone(initial);
  const result = await maintain(source, responder(patch));
  assert(!result.ok); assert.equal(result.code, "RESPONSE"); assert(!("candidate" in result));
  assert.equal(result.observations.requests, 1); assert.deepEqual(source.memory, initial);
});

test("generated IDs avoid imported collisions and remain monotonic even for discarded additions", () => {
  const first = applyPatch({ version: 1, nextId: 1, slots: [{ id: "s1", text: "imported" }] }, { remove: ["s1"], add: [{ key: "x", text: "new" }], priority: ["x"], required: [] }, 0, memoryTokens);
  assert.equal(first.memory.nextId, 3);
  const next = applyPatch(first.memory, { remove: [], add: [{ key: "x", text: "new" }], priority: ["x"], required: [] }, 500, memoryTokens);
  assert.equal(next.memory.slots[0]!.id, "s3");
});

test("all declared required items retained jointly; optional items dropped by priority even when ordered first", async () => {
  const source = await input(); source.memory = structuredClone(initial);
  // required items: s2 (surviving) + focus (new). optional: opt1, opt2 (new).
  const focusText = "Active task: preserve shipments table";
  const s2Text = initial.slots[1]!.text;
  const opt1Text = "Optional background note 1 ".repeat(20);
  const opt2Text = "Optional background note 2 ".repeat(20);
  // Set memory limit to exactly fit s2 + focus + small margin, but NOT opt1 or opt2
  const requiredBudget = memoryTokens([{ id: "s2", text: s2Text }, { id: "s5", text: focusText }]);
  source.config.memory.maxTokens = requiredBudget;
  const patch = {
    add: [
      { key: "focus", text: focusText },
      { key: "opt1", text: opt1Text },
      { key: "opt2", text: opt2Text },
    ],
    remove: ["s1", "s4"],
    priority: ["opt1", "focus", "opt2", "s2"], // opt1 and opt2 prioritized ahead of required items!
    required: ["focus", "s2"],
  };
  const result = await maintain(source, responder(patch));
  assert(result.ok, result.ok ? "" : result.message);
  // Must contain s2 and focus (s5). Must NOT contain opt1 (s6) or opt2 (s7).
  assert.equal(result.candidate.memory.slots.length, 2);
  assert.equal(result.candidate.memory.slots[0]!.id, "s2");
  assert.equal(result.candidate.memory.slots[1]!.id, "s5");
  assert.equal(result.candidate.memory.slots[1]!.text, focusText);
  assert.deepEqual(result.observations.droppedSlotIds, ["s6", "s7"]);
  assert.deepEqual(result.observations.required?.declared, ["focus", "s2"]);
  assert.deepEqual(result.observations.required?.retainedSlotIds, ["s5", "s2"]);
  assert.equal(result.observations.required?.failed, false);
});

test("priority cannot skip large required item to pick small optional item and claim success", async () => {
  const source = await input(); source.memory = structuredClone(initial);
  const bigRequiredText = "Critical shipment constraint ".repeat(80);
  const smallOptionalText = "Small note";
  // Budget fits small optional item but NOT the large required item
  source.config.memory.maxTokens = memoryTokens([{ id: "s5", text: smallOptionalText }]);
  const patch = {
    add: [
      { key: "bigReq", text: bigRequiredText },
      { key: "smallOpt", text: smallOptionalText },
    ],
    remove: ["s1", "s2", "s4"],
    priority: ["bigReq", "smallOpt"],
    required: ["bigReq"],
  };
  const result = await maintain(source, responder(patch));
  assert(!result.ok);
  assert.equal(result.code, "CAPACITY");
  assert(!("candidate" in result));
  assert.equal(result.observations.required?.failed, true);
  assert.deepEqual(result.observations.required?.declared, ["bigReq"]);
  assert.deepEqual(result.observations.required?.retainedSlotIds, []);
  assert.deepEqual(source.memory, initial);
});

test("multiple required items that fit individually but exceed limit jointly fail with CAPACITY", async () => {
  const source = await input(); source.memory = structuredClone(initial);
  const req1Text = "First required obligation ".repeat(25);
  const req2Text = "Second required obligation ".repeat(25);
  // Budget fits either req1 or req2 individually, but not both jointly
  const singleBudget = memoryTokens([{ id: "s5", text: req1Text }]);
  source.config.memory.maxTokens = singleBudget;
  const patch = {
    add: [
      { key: "req1", text: req1Text },
      { key: "req2", text: req2Text },
    ],
    remove: ["s1", "s2", "s4"],
    priority: ["req1", "req2"],
    required: ["req1", "req2"],
  };
  const result = await maintain(source, responder(patch));
  assert(!result.ok);
  assert.equal(result.code, "CAPACITY");
  assert(!("candidate" in result));
  assert.equal(result.observations.required?.failed, true);
  assert.deepEqual(result.observations.required?.declared, ["req1", "req2"]);
});

test("markdown formatting inside slot text is preserved verbatim", async () => {
  const source = await input(); source.memory = structuredClone(initial);
  const markdownText = "### Active Task\n\n- Step 1: verify `config.json`\n- Step 2: run script\n\n```python\nassert status == 'ready'\n```";
  const patch = {
    add: [{ key: "task", text: markdownText }],
    remove: ["s1", "s4"],
    priority: ["task", "s2"],
    required: ["task"],
  };
  const result = await maintain(source, responder(patch));
  assert(result.ok, result.ok ? "" : result.message);
  assert.equal(result.candidate.memory.slots[1]!.text, markdownText);
  assert(result.candidate.memory.slots[1]!.text.includes("```python\nassert status == 'ready'\n```"));
  assert(renderMemory(result.candidate.memory.slots).includes("```python\\nassert status == 'ready'\\n```"));
});

test("deterministic multi-slot operations: split mixed slot, merge slots, additions, and retirement", async () => {
  // Start with mixed slot s1, obsolete slot s2, and separate slot s4
  const startMemory: Memory = {
    version: 1, nextId: 5, slots: [
      { id: "s1", text: "Mixed slot: east timeout 900ms and west audit enabled" },
      { id: "s2", text: "Obsolete provisional route" },
      { id: "s4", text: "Stable global policy: no cross-tenant sharing" },
    ],
  };
  const source = await input(); source.memory = structuredClone(startMemory);

  // Operation: split s1 into east revised and west cancelled; retire s2; keep s4; add new independent task
  const patch = {
    add: [
      { key: "east_revised", text: "East lookup: timeoutMs 650, pending validation" },
      { key: "new_calc", text: "Calculation result: 14 days in two weeks" },
    ],
    remove: ["s1", "s2"], // retire mixed s1 and obsolete s2
    priority: ["east_revised", "s4", "new_calc"],
    required: ["east_revised", "s4"],
  };
  const result = await maintain(source, responder(patch));
  assert(result.ok, result.ok ? "" : result.message);
  const slots = result.candidate.memory.slots;
  // Natural order: surviving s4 first, then additions east_revised (s5) and new_calc (s6)
  assert.equal(slots.length, 3);
  assert.equal(slots[0]!.id, "s4");
  assert.equal(slots[0]!.text, "Stable global policy: no cross-tenant sharing"); // unchanged body preserved
  assert.equal(slots[1]!.id, "s5");
  assert.equal(slots[1]!.text, "East lookup: timeoutMs 650, pending validation");
  assert.equal(slots[2]!.id, "s6");
  assert.equal(slots[2]!.text, "Calculation result: 14 days in two weeks");
  assert.deepEqual(result.observations.required?.declared, ["east_revised", "s4"]);
  assert.deepEqual(result.observations.required?.retainedSlotIds, ["s5", "s4"]);
  assert.deepEqual(result.observations.droppedSlotIds, []);

  // Now perform merge operation on the result
  const mergeSource = await input(); mergeSource.memory = structuredClone(result.candidate.memory);
  const mergePatch = {
    add: [
      { key: "merged", text: "Consolidated config: east timeout 650ms, no cross-tenant sharing" },
    ],
    remove: ["s4", "s5"], // merge s4 and s5 into single slot
    priority: ["merged", "s6"],
    required: ["merged"],
  };
  const mergeResult = await maintain(mergeSource, responder(mergePatch));
  assert(mergeResult.ok, mergeResult.ok ? "" : mergeResult.message);
  const mergeSlots = mergeResult.candidate.memory.slots;
  assert.equal(mergeSlots.length, 2);
  assert.equal(mergeSlots[0]!.id, "s6"); // surviving s6 keeps relative order
  assert.equal(mergeSlots[1]!.id, "s7"); // merged addition appended
  assert.equal(mergeSlots[1]!.text, "Consolidated config: east timeout 650ms, no cross-tenant sharing");
  assert.deepEqual(mergeResult.observations.required?.declared, ["merged"]);
  assert.deepEqual(mergeResult.observations.required?.retainedSlotIds, ["s7"]);
});
