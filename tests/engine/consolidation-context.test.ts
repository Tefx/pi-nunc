import { test } from "node:test";
import assert from "node:assert/strict";
import { extractionContext, readSourceRecords } from "../../src/engine/request.js";
import { memoryTokens } from "../../src/engine/accounting.js";
import { maintain } from "../../src/engine/engine.js";
import { input, answer } from "./fixtures.js";

function textBlocks(context: ReturnType<typeof extractionContext>): string[] {
  return context.messages.flatMap(message => typeof message.content === "string" ? [message.content] : message.content.flatMap(block => block.type === "text" ? [block.text] : []));
}
test("maintenance F projects shallow tool metadata without mutating the full validated input", async () => {
  const s = await input();
  s.fixed.tools[0]!.parameters = { type: "object", properties: { path: { type: "string", enum: ["deep-value"] }, options: { type: "object", properties: { nested: { type: "string" } } } } };
  const original = structuredClone(s.fixed);
  let calls = 0;
  const result = await maintain(s, async request => {
    calls++;
    const fm = readSourceRecords(textBlocks(request.context).join("\n")).find(row => row.source === "F/M")!;
    assert.deepEqual((fm.F as { tools: unknown[] }).tools, [{ name: "read", description: "Read complete file", parameterKeys: ["path", "options"] }]);
    return answer(undefined, request.model);
  });
  assert(result.ok, result.ok ? "" : result.message); assert.equal(calls, 1); assert.deepEqual(s.fixed, original);
  s.fixed.tools = [];
  const fm = readSourceRecords(textBlocks(extractionContext(s, 1, 8192, s.active, [])).join("\n")).find(row => row.source === "F/M")!;
  assert.deepEqual((fm.F as { tools: unknown[] }).tools, []);
});
test("consolidation tail activates strictly above 75 percent or eight slots without changing source M", async () => {
  const s = await input(); s.memory = { version: 1, nextId: 2, slots: [{ id: "s1", text: "Keep the current exact task constraints." }] };
  const before = structuredClone(s.memory), used = memoryTokens(s.memory.slots);
  const count = (limit: number) => textBlocks(extractionContext(s, 1, limit, s.active, [])).length;
  assert.equal(count(Math.ceil(used / .75)) + 1, count(Math.floor((used - 1) / .75)));
  assert.deepEqual(s.memory, before);
  s.memory.slots = Array.from({ length: 8 }, (_, i) => ({ id: `s${i + 1}`, text: "Short independent task." }));
  const eight = count(8192);
  s.memory.slots.push({ id: "s9", text: "Another task." });
  // One extra source slot stays inside the same F/M block; only the consolidation control adds a block.
  assert.equal(count(8192), eight + 1);
});
