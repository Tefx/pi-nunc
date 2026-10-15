import { test } from "node:test";
import assert from "node:assert/strict";
import { extractionContext, readSourceRecords } from "../../src/engine/request.js";
import { RESPONSE_CONTRACT } from "../../src/engine/memory.js";
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
test("response contract supplies a parseable multiline operation example", () => {
  const example = RESPONSE_CONTRACT.slice(RESPONSE_CONTRACT.indexOf("\n{") + 1, RESPONSE_CONTRACT.indexOf("\nadd:"));
  assert(example.includes("\n  \"priority\":"));
  const patch = JSON.parse(example);
  assert.deepEqual(Object.keys(patch), ["priority", "required", "remove", "add", "update", "toolResultEdits"]);
  assert.deepEqual(patch.update, [{ id: "surviving-old-id", text: "complete revised note" }]);
});
test("normal headroom uses the minimum output reserve when capability exceeds window", async () => {
  const s = await input();
  s.model.maxTokens = s.model.contextWindow * 2;
  s.config.extraction.outputAuto = true;
  const result = await maintain(s, async request => answer(undefined, request.model));
  assert(result.ok, result.ok ? "" : result.message);
  const a = result.observations.accounting!;
  const limit = s.model.contextWindow - a.outputReserveTokens - s.config.extraction.safetyTokens;
  // The resolved cap may consume more than the floor; reconstruct the planning limit.
  const planningLimit = Math.min(s.model.contextWindow - Math.min(8192, s.model.maxTokens),
    s.config.extraction.inputLimit ?? s.model.contextWindow) - s.config.extraction.safetyTokens;
  assert.equal(a.normalHeadroomSufficient, a.normalExtractionAtTrigger <= planningLimit);
  assert.equal(a.normalHeadroomSufficient, true);
  assert.equal(a.suggestedReserveTokens, Math.max(1, Math.ceil(s.model.contextWindow - planningLimit + a.fullExtractionTokens - a.mainBeforeTokens)));
  assert(a.suggestedReserveTokens < s.model.contextWindow);
  assert(limit >= 0);
});
test("final tail binds update/remove to exact current IDs, including empty M", async () => {
  const s = await input();
  for (const slots of [[], [{ id: "s3", text: "First current task." }, { id: "s7", text: "Second current task." }]]) {
    s.memory = { version: 1, nextId: 8, slots };
    const tail = textBlocks(extractionContext(s, 1, 8192, s.active, [])).at(-1)!;
    assert(tail.endsWith(`Current M slot IDs: ${JSON.stringify(slots.map(slot => slot.id))}. Only these exact existing IDs may appear in update (each with only {"id","text"}) or remove; any new slot or previously removed ID must be placed in add (each with only {"key","text"}).`));
  }
});
