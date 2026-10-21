import { test } from "node:test";
import assert from "node:assert/strict";
import { maintain } from "../../src/engine/engine.js";
import { engineConfig } from "../../src/pi/config.js";
import { answer, input, responder, sourceRecords, user } from "./fixtures.js";

async function targeted() {
  const s = await input();
  s.model.contextWindow = 200000;
  s.config = engineConfig({ extraction: { toolResults: "full" } }, s.model, { reserveTokens: 16384, keepRecentTokens: 1 });
  const targetModel = { ...s.model, id: "target-small", contextWindow: 30000 };
  s.target = { model: targetModel, config: engineConfig({}, targetModel, { reserveTokens: 8192, keepRecentTokens: 1 }) };
  s.active = Array.from({ length: 30 }, (_, i) => user(`u${i}`, `Required source ${i}: ` + "evidence ".repeat(800)));
  return s;
}

test("target retention uses the small window while one full extraction uses the execution model", async () => {
  const s = await targeted(), before = structuredClone(s.active);
  let calls = 0;
  const result = await maintain(s, async request => {
    calls++;
    assert.equal(request.model.id, s.model.id);
    const records = sourceRecords(request.context);
    assert.deepEqual(records.map(r => r.entryId), before.map(r => r.entryId));
    for (const [i, record] of records.entries()) assert.equal(record.messages[0]!.content, before[i]!.messages[0]!.content);
    return answer(undefined, request.model);
  });
  assert(result.ok, result.ok ? "" : result.message);
  assert.equal(calls, 1);
  assert.equal(result.observations.omissions.length, 0);
  assert(result.observations.accounting!.fullExtractionTokens > s.target!.model.contextWindow);
  assert(result.observations.target!.fits);
  assert(result.candidate.kept.length < 10);
  assert.deepEqual(result.candidate.kept, before.slice(result.candidate.retiredEntryIds.length));
  assert.deepEqual(s.active, before);
});

test("targeted compaction refuses insufficient execution capacity without reducing sources or calling a model", async () => {
  const s = await targeted(); s.model.contextWindow = 40000;
  let calls = 0;
  const result = await maintain(s, async () => { calls++; return answer(); });
  assert(!result.ok); assert.equal(result.code, "CAPACITY");
  assert.equal(calls, 0); assert.deepEqual(result.observations.omissions, []);
});

test("required M that cannot meet the explicit target fails without recutting or a second request", async () => {
  const s = await targeted();
  let calls = 0;
  const result = await maintain(s, async request => {
    calls++;
    return answer({ add: [{ key: "required", text: "necessary ".repeat(16000) }], remove: [], priority: ["required"], required: ["required"] }, request.model);
  });
  assert(!result.ok); assert.equal(result.code, "CAPACITY"); assert.equal(calls, 1);
  assert.equal(result.observations.target!.fits, false);
  assert(result.observations.target!.estimatedInputTokens! > result.observations.target!.plannedInputLimit);
  assert.deepEqual(s.memory.slots, []);
});

test("an indivisible oversized target suffix is rejected before extraction", async () => {
  const s = await targeted(); s.active = [user("old", "old"), user("latest", "required ".repeat(20000))];
  const result = await maintain(s, async () => assert.fail("no feasible target suffix"));
  assert(!result.ok); assert.equal(result.code, "CAPACITY"); assert.equal(result.observations.requests, 0);
});

test("targeted compaction does not retain images for a text-only target", async () => {
  const s = await targeted();
  s.model.input = ["text", "image"];
  s.target!.model.input = ["text"];
  s.active = [user("old", "old"), { entryId: "image", sourceRole: "user", messages: [{ role: "user", timestamp: 1,
    content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] }] }];
  const result = await maintain(s, async () => assert.fail("unsupported retained media must fail before extraction"));
  assert(!result.ok); assert.equal(result.code, "CAPACITY"); assert.equal(result.observations.requests, 0);
});

test("ordinary maintenance remains independent of the explicit target gate", async () => {
  const s = await targeted(); delete s.target;
  const result = await maintain(s, responder());
  assert(result.ok, result.ok ? "" : result.message);
  assert.equal(result.observations.target, undefined);
  assert(result.candidate.kept.length >= 14);
});
