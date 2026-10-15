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
test("one to three oversized slots never trigger consolidation; four require strictly above the soft target", async () => {
  const s = await input();
  const count = (limit: number) => textBlocks(extractionContext(s, 1, limit, s.active, [])).length;
  for (const size of [1, 2, 3, 4]) {
    s.memory = { version: 1, nextId: size + 1, slots: Array.from({ length: size }, (_, i) => ({ id: `s${i + 1}`, text: "Keep exact related facts. ".repeat(600) })) };
    const before = structuredClone(s.memory), used = memoryTokens(s.memory.slots);
    const atTarget = count(used);
    assert.equal(count(used - 1), atTarget + (size >= 4 ? 1 : 0));
    assert.deepEqual(s.memory, before);
  }
});
test("nine slots trigger consolidation independently of size; eight do not", async () => {
  const s = await input();
  s.memory = { version: 1, nextId: 10, slots: Array.from({ length: 8 }, (_, i) => ({ id: `s${i + 1}`, text: "Short independent task." })) };
  const count = () => textBlocks(extractionContext(s, 1, 8192, s.active, [])).length;
  const eight = count();
  s.memory.slots.push({ id: "s9", text: "Another task." });
  assert.equal(count(), eight + 1);
});
test("final tail binds update/remove to exact current IDs, including empty M", async () => {
  const s = await input();
  for (const slots of [[], [{ id: "s3", text: "First current task." }, { id: "s7", text: "Second current task." }]]) {
    s.memory = { version: 1, nextId: 8, slots };
    const tail = textBlocks(extractionContext(s, 1, 8192, s.active, [])).at(-1)!;
    assert(tail.endsWith(`Current M slot IDs: ${JSON.stringify(slots.map(slot => slot.id))}. Only these exact existing IDs may appear in update (each with only {"id","text"}) or remove; any new slot or previously removed ID must be placed in add (each with only {"key","text"}).`));
  }
});
