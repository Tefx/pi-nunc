import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPatch, isMemoryUnchanged, maintain, memoryTokens, parsePatch, type Memory, type Patch } from "pi-nunc/engine";
import { assistant, input, responder, tool, user } from "./fixtures.js";

const memory: Memory = { version: 1, nextId: 7, slots: [
  { id: "s1", text: "Original body" }, { id: "s3", text: "Unchanged condition\nexact: 42ms" },
] };
const base: Patch = { add: [], remove: [], priority: ["s1", "s3"], required: [] };

test("update preserves IDs, natural order and nextId; old and same-text patches remain compatible", async () => {
  const source = await input(); source.memory = structuredClone(memory);
  const patch: Patch = { ...base, update: [{ id: "s1", text: "Revised body with surviving conditions." }],
    add: [{ key: "next", text: "Next obligation" }], priority: ["next", "s3", "s1"], required: ["s1"] };
  const result = await maintain(source, responder(patch));
  assert(result.ok, result.ok ? "" : result.message);
  assert.deepEqual(result.candidate.memory, { version: 1, nextId: 8, slots: [
    { id: "s1", text: patch.update![0]!.text }, memory.slots[1], { id: "s7", text: "Next obligation" },
  ] });
  assert.deepEqual(result.observations.required?.retainedSlotIds, ["s1"]);
  assert.deepEqual(source.memory, memory);
  const updatedOnly = applyPatch(memory, { ...base, update: [{ id: "s1", text: "Changed" }] }, 10000, memoryTokens);
  assert.equal(updatedOnly.memory.nextId, memory.nextId);
  const old = applyPatch(memory, base, 10000, memoryTokens);
  const same = applyPatch(memory, { ...base, update: [{ id: "s1", text: memory.slots[0]!.text }] }, 10000, memoryTokens);
  assert.deepEqual(parsePatch(base, memory), base);
  assert.deepEqual(old.memory, memory);
  assert(isMemoryUnchanged(memory, same.memory));
  assert.equal(same.memory.nextId, memory.nextId);
});

test("selection measures revised bodies, preserves required over target, and never revives an unselected old body", () => {
  const update = [{ id: "s1", text: "Required revised condition ".repeat(50) }];
  const revised = { id: "s1", text: update[0]!.text };
  const required = applyPatch(memory, { ...base, update, priority: ["s3", "s1"], required: ["s1"] },
    { targetTokens: 0 }, memoryTokens);
  assert.deepEqual(required.memory.slots, [revised]);
  assert.deepEqual(required.droppedSlotIds, ["s3"]);
  const exact = memoryTokens([revised]);
  assert.deepEqual(applyPatch(memory, { ...base, update, required: ["s1"] },
    { targetTokens: 0, hardMaxTokens: exact }, memoryTokens).memory.slots, [revised]);
  assert.throws(() => applyPatch(memory, { ...base, update, required: ["s1"] },
    { targetTokens: 0, hardMaxTokens: exact - 1 }, memoryTokens), /explicit memory hard limit/);
  const optional = applyPatch(memory, { ...base, update }, memoryTokens([memory.slots[1]!]), memoryTokens);
  assert.deepEqual(optional.memory.slots, [memory.slots[1]]);
  assert.deepEqual(optional.droppedSlotIds, ["s1"]);
  assert.equal(optional.memory.nextId, memory.nextId);
});

test("omitted add/remove normalize without deletion; multilingual Markdown remains exact", async () => {
  const text = "## 后续验收\n\n- Keep normal spaces；禁止 push，42 ms 上限。\n- 路径 `/tmp/资料 α.json`，API `sourceRefs`，原文 ‘not ready’。\n\n下一步需沿用已选结果。🙂";
  const minimal = { update: [{ id: "s1", text }], priority: ["s3", "s1"], required: ["s1", "s3"] };
  assert.deepEqual(parsePatch(minimal, memory), { ...minimal, add: [], remove: [] });
  const source = await input(); source.memory = structuredClone(memory);
  const result = await maintain(source, responder(minimal));
  assert(result.ok, result.ok ? "" : result.message);
  assert.deepEqual(result.candidate.memory.slots, [{ id: "s1", text }, memory.slots[1]]);
  assert.deepEqual(source.memory, memory);
  const noOperations = applyPatch(memory, { priority: base.priority, required: [] }, 10000, memoryTokens);
  assert.deepEqual(noOperations.memory, memory);
  for (const field of ["add", "remove"] as const) for (const bad of [null, {}, "", 0, false, undefined]) {
    assert.throws(() => parsePatch({ ...minimal, [field]: bad }, memory), new RegExp(`${field}: expected an array`));
  }
});

test("malformed omitted-operation maintenance cannot retire source or mutate memory", async () => {
  const source = await input(); source.memory = structuredClone(memory);
  const snapshot = structuredClone({ memory: source.memory, active: source.active });
  const signal = source.signal;
  const result = await maintain(source, responder({ update: [{ id: "s1", text: "Rewritten" }], priority: ["s1"], required: [] }));
  assert.equal(result.ok, false);
  assert.deepEqual({ memory: source.memory, active: source.active }, snapshot);
  assert.equal(source.signal, signal);
});

const invalid: Array<[unknown, RegExp]> = [
  [{ ...base, update: null }, /update: expected an array/],
  [{ ...base, update: [{ id: "unknown", text: "New" }] }, /update\[0\]\.id: unknown reference "unknown"/],
  [{ ...base, update: [{ id: "s1", text: "New" }, { id: "s1", text: "Again" }] }, /update\[1\]\.id: duplicate update/],
  [{ ...base, update: [{ id: "s1", text: "New" }], remove: ["s1"], priority: ["s3"] }, /update\[0\]\.id: deleted reference/],
  [{ ...base, update: [{ id: "s1", text: " " }] }, /update\[0\]\.text: expected a nonempty/],
  [{ ...base, update: [{ id: "s1", text: "New", extra: true }] }, /update\[0\]: expected only/],
  [{ ...base, unexpected: true }, /Unsupported patch fields: "unexpected"/],
  [{ ...base, remove: ["unknown"] }, /remove\[0\]: unknown/],
  [{ ...base, remove: ["s1", "s1"] }, /remove\[1\]: duplicate/],
  [{ ...base, priority: ["s1", "unknown"] }, /priority\[1\]: unknown/],
  [{ ...base, priority: ["s1", "s1", "s3"] }, /priority\[1\]: duplicate/],
  [{ ...base, remove: ["s1"] }, /priority\[0\]: deleted/],
  [{ ...base, priority: ["s1"] }, /priority: omitted candidate references "s3"/],
  [{ ...base, required: ["unknown"] }, /required\[0\]: unknown/],
  [{ ...base, required: ["s1", "s1"] }, /required\[1\]: duplicate/],
  [{ ...base, remove: ["s1"], priority: ["s3"], required: ["s1"] }, /required\[0\]: deleted/],
  [{ ...base, remove: ["s1"], add: [{ key: "s1", text: "New" }] }, /add\[0\]\.key: collides with existing/],
];
test("invalid operations/references have bounded field-specific RESPONSE errors", () => {
  for (const [patch, message] of invalid) {
    assert.throws(() => parsePatch(patch, memory), error => {
      assert.equal((error as { code?: string }).code, "RESPONSE");
      assert.match((error as Error).message, message);
      return true;
    });
  }
  const secretTail = "reply-body-must-not-be-disclosed";
  assert.throws(() => parsePatch({ ...base, priority: ["x".repeat(2000) + secretTail] }, memory), error => {
    assert((error as Error).message.length < 200);
    assert(!(error as Error).message.includes(secretTail));
    return true;
  });
  const many: Memory = { version: 1, nextId: 1, slots: Array.from({ length: 30 }, (_, i) => ({ id: `id${i}`, text: "Kept" })) };
  assert.throws(() => parsePatch({ ...base, priority: [] }, many), /\(\+26 more\)/);
});

test("new semantic cleanup uses final selected updated M; dropping an updated dependency skips only its edit", async () => {
  for (const required of [[], ["s1"]]) {
    const source = await input(); source.memory = structuredClone(memory);
    source.config.memory.fraction = 0;
    source.config.memory.targetTokens = 1; // Force optional eviction independently of the fractional planning reserve.
    source.config.keepRecentFraction = 0.5;
    source.active = [user("old", "Retiring old source.".repeat(300)),
      assistant("invoke", [{ type: "toolCall", id: "call", name: "read", arguments: {} }]),
      tool("result", "call", "Specific tool evidence. ".repeat(50)), user("tail", "Latest continuing task.")];
    source.eligibleKeptEntryIds = ["invoke"];
    source.cleanupCandidateScope = [{ entryId: "result", messageIndex: 0 }];
    const result = await maintain(source, responder({ ...base, update: [{ id: "s1", text: "Final decisive evidence." }], required,
      toolResultEdits: [{ entryId: "result", messageIndex: 0, action: "omit", memoryRefs: ["s1"] }] }));
    assert(result.ok, result.ok ? "" : result.message);
    if (required.length) {
      assert.deepEqual(result.candidate.memory.slots, [{ id: "s1", text: "Final decisive evidence." }]);
      assert.deepEqual(result.candidate.toolResultCleanup?.applied[0]?.memoryRefs, ["s1"]);
    } else {
      assert.deepEqual(result.candidate.memory.slots, []);
      assert.equal(result.candidate.toolResultCleanup?.applied.length, 0);
      assert.equal(result.candidate.toolResultCleanup?.skipped[0]?.reason, "missing_memory_dependency");
    }
  }
});
