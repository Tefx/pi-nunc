import { test } from "node:test";
import assert from "node:assert/strict";
import { maintain } from "../../src/engine/engine.js";
import { engineConfig } from "../../src/pi/config.js";
import { answer, assistant, input, responder, sourceRecords, tool, user } from "./fixtures.js";

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

test("ordinary maintenance remains independent of the explicit target gate", async () => {
  const s = await targeted(); delete s.target;
  const result = await maintain(s, responder());
  assert(result.ok, result.ok ? "" : result.message);
  assert.equal(result.observations.target, undefined);
  assert.equal(result.observations.accounting!.keepTarget, Math.floor(s.config.triggerTokens * 0.15));
  assert(result.candidate.kept.length >= 12 && result.candidate.kept.length <= 14);
});
