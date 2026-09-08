import { test } from "node:test";
import assert from "node:assert/strict";
import { mainContext, maintain, memoryTokens, observeUsage, requestTokens } from "../../src/engine/index.js";
import { answer, input, responder, usage, user } from "./fixtures.js";

test("accounts complete F/envelope/M/R and extraction controls, independent ceilings and actual output reserve", async () => {
  const source = await input(); source.memory.slots = [{ id: "s8", text: "Exact original condition" }];
  source.config.main.extraInputTokens = 300; source.config.extraction.extraInputTokens = 400;
  source.config.main.inputLimit = 40000; source.config.extraction.inputLimit = 50000;
  const result = await maintain(source, responder({ add: [], remove: [], priority: ["s8"] }));
  assert(result.ok, result.ok ? "" : result.message);
  const a = result.observations.accounting!;
  assert.equal(a.mainBeforeTokens, requestTokens(mainContext(source.fixed, source.memory.slots, source.active)) + 300);
  assert.equal(a.mainAfterTokens, requestTokens(mainContext(source.fixed, result.candidate.memory.slots, result.candidate.kept)) + 300);
  assert.equal(a.mainInputLimit, 40000 - 512);
  assert.equal(a.extractionInputLimit, 50000 - 512);
  assert.equal(a.memoryTokens, memoryTokens(source.memory.slots));
  assert.equal(a.memoryLimit, Math.floor((a.effectiveTrigger - a.fixedTokens) * 0.1));
  assert.equal(a.keepTarget, Math.floor((a.effectiveTrigger - a.fixedTokens - a.memoryLimit) * 0.67));
  assert(a.fullExtractionTokens > a.mainBeforeTokens);
  assert(a.mainAfterTokens! < a.effectiveTrigger && a.growthTokens! >= 2000);
  assert.equal(result.observations.usage.contextInput, 175);
  assert.equal(result.observations.usage.totalTokens, 215); // reasoning is already included in output
});

test("maximum output capability is not automatically reserved; narrower main model capacity recomputes H/M/K", async () => {
  const source = await input(); const large = await maintain(source, responder()); assert(large.ok);
  source.model.contextWindow = 25000; source.config.triggerTokens = 24000;
  const small = await maintain(source, responder());
  // Current full extraction fits despite insufficient hypothetical trigger headroom.
  assert(small.ok); assert.equal(small.observations.requests, 1);
  source.config.triggerTokens = 12000;
  const adjusted = await maintain(source, responder()); assert(adjusted.ok, adjusted.ok ? "" : adjusted.message);
  assert.equal(adjusted.observations.accounting!.mainInputLimit, 25000 - 4096 - 512);
  assert(adjusted.observations.accounting!.memoryLimit < large.observations.accounting!.memoryLimit);
  assert(adjusted.observations.accounting!.keepTarget < large.observations.accounting!.keepTarget);
});

test("lowering H synchronously recalculates memory and K and retains growth", async () => {
  const source = await input(); source.active = Array.from({ length: 10 }, (_, i) => user(`u${i}`, "x".repeat(6000)));
  const first = await maintain(source, responder()); assert(first.ok);
  source.config.triggerTokens = 9000;
  const next = await maintain(source, responder()); assert(next.ok, next.ok ? "" : next.message);
  assert(next.candidate.kept.length < first.candidate.kept.length);
  assert(next.observations.accounting!.memoryLimit < first.observations.accounting!.memoryLimit);
  assert(next.observations.accounting!.growthTokens! >= source.config.growthTokens);
});

test("known cache usage occupies context; partial, invalid and unreported usage remain unknown", () => {
  assert.equal(observeUsage(usage).contextInput, 175);
  assert.equal(observeUsage({ ...usage, input: 0, cacheRead: 60000 }).contextInput, 60025);
  assert.equal(observeUsage({ ...usage, cacheRead: undefined }).contextInput, null);
  assert.equal(observeUsage({ ...usage, cacheRead: -1 }).cacheRead, null);
  assert.equal(observeUsage(undefined).cost, null);
  assert.equal(observeUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }).contextInput, null);
  assert.equal(observeUsage({ input: 1, output: 2 }).output, 2);
});

test("source accounting never uses stale/cache/unknown assistant usage as a zero-size shortcut", async () => {
  const source = await input(); const first = await maintain(source, responder()); assert(first.ok);
  const assistant = source.active[1]!.messages[0]!; assert(assistant.role === "assistant");
  Object.assign(assistant, { usage: undefined });
  const unknown = await maintain(source, responder()); assert(unknown.ok);
  assert.equal(unknown.observations.accounting!.mainBeforeTokens, first.observations.accounting!.mainBeforeTokens);
  assistant.usage = { ...usage, cacheRead: 50000 };
  const cached = await maintain(source, responder()); assert(cached.ok);
  assert.equal(cached.observations.accounting!.mainBeforeTokens, first.observations.accounting!.mainBeforeTokens);
});

test("complete extraction over the catalog window still commits; serialized output cap and explicit inputLimit still bind", async () => {
  const overWindow = await maintain(await input(), async request => ({ ...answer(undefined, request.model), usage: { ...usage, cacheRead: 60000 } }));
  assert(overWindow.ok, overWindow.ok ? "" : overWindow.message);
  assert.equal(overWindow.observations.accounting!.inputExceededPlan, true);
  const overCap = await maintain(await input(), async request => ({ ...answer(undefined, request.model), usage: { ...usage, output: 8192, reasoning: 8000 } }));
  assert(!overCap.ok); assert.equal(overCap.code, "CAPACITY"); assert.match(overCap.message, /output/);
  const source = await input(); source.config.extraction.inputLimit = 50000;
  const overConfigured = await maintain(source, async request => ({ ...answer(undefined, request.model), usage: { ...usage, cacheRead: 60000 } }));
  assert(!overConfigured.ok); assert.equal(overConfigured.code, "CAPACITY"); assert.match(overConfigured.message, /configured provider input limit/);
});

test("unknown service usage does not prevent estimate-based maintenance and is not reported as zero", async () => {
  const source = await input();
  const result = await maintain(source, async request => ({ ...answer(undefined, request.model), usage: undefined }));
  assert(result.ok); assert.equal(result.observations.usage.contextInput, null); assert.equal(result.observations.usage.cost, null);
  assert(result.observations.accounting!.extractionTokens > 0);
});

const invalidConfigs = [
  (s: Awaited<ReturnType<typeof input>>) => { s.config.memory.fraction = -1; },
  (s: Awaited<ReturnType<typeof input>>) => { s.config.memory.fraction = 1; },
  (s: Awaited<ReturnType<typeof input>>) => { s.config.memory.fraction = NaN; },
  (s: Awaited<ReturnType<typeof input>>) => { s.config.memory.maxTokens = 0; },
  (s: Awaited<ReturnType<typeof input>>) => { s.config.keepRecentFraction = 0; },
  (s: Awaited<ReturnType<typeof input>>) => { s.config.keepRecentFraction = 1; },
  (s: Awaited<ReturnType<typeof input>>) => { s.config.main.outputTokens = 9000; },
  (s: Awaited<ReturnType<typeof input>>) => { s.config.extraction.outputLimit = 1000; },
  (s: Awaited<ReturnType<typeof input>>) => { s.config.growthTokens = 0; },
  (s: Awaited<ReturnType<typeof input>>) => { s.config.extraction.safetyTokens = 0; },
  (s: Awaited<ReturnType<typeof input>>) => { s.model.samplingParams = { max_tokens: 999999 }; },
  (s: Awaited<ReturnType<typeof input>>) => { s.config.extraction.nativeOutputReserve = 1024; },
  (s: Awaited<ReturnType<typeof input>>) => { s.model.api = "openai-codex-responses"; s.config.main.outputTokens = s.model.maxTokens; s.config.extraction.outputTokens = s.model.maxTokens; s.config.main.nativeOutputReserve = s.model.maxTokens + 1; },
];
for (const [i, change] of invalidConfigs.entries()) test(`invalid budget configuration ${i} fails before dispatch`, async () => {
  const source = await input(); change(source);
  const result = await maintain(source, async () => { assert.fail("invalid config must not dispatch"); });
  assert(!result.ok); assert.equal(result.code, "CONFIG"); assert.equal(result.observations.requests, 0);
});

test("negative A, indivisible source, no retained growth and impossible small-model extraction are explicit failures", async () => {
  const fixed = await input(); fixed.fixed.systemPrompt = "f".repeat(120000);
  const single = await input(); single.active = [user("one", "big".repeat(10000))];
  const growth = await input(); growth.config.growthTokens = 24900;
  const giantK = await input(); giantK.active = [user("old", "old"), user("large", "x".repeat(320000))];
  for (const source of [fixed, single, growth, giantK]) {
    const result = await maintain(source, async () => { assert.fail("unusable work budget"); });
    assert(!result.ok); assert.equal(result.code, "CAPACITY"); assert.equal(result.observations.requests, 0);
  }
});

test("Pi uncapped Codex/Responses output and Responses' minimum are reflected in preflight", async () => {
  const source = await input(); source.model.api = "openai-codex-responses";
  const planned = await maintain(source, responder()); assert(planned.ok); assert.equal(planned.observations.accounting!.outputCapTokens, null);
  source.config.main.outputTokens = source.model.maxTokens; source.config.extraction.outputTokens = source.model.maxTokens;
  const reserved = await maintain(source, responder()); assert(reserved.ok, reserved.ok ? "" : reserved.message);
  assert.equal(reserved.observations.accounting!.extractionInputLimit, 60000 - 8192 - 512);
  source.model.api = "openai-responses"; Object.assign(source.model, { compat: { supportsMaxOutputTokens: false } });
  source.config.extraction.outputTokens = 4096;
  const optedOut = await maintain(source, responder()); assert(optedOut.ok); assert.equal(optedOut.observations.accounting!.outputCapTokens, null);
  delete source.model.compat; source.config.extraction.outputTokens = 1;
  const floored = await maintain(source, responder()); assert(!floored.ok); assert.equal(floored.code, "CONFIG");
});

test("normal trigger advice never rejects an executable complete extraction", async () => {
  const source = await input(); source.config.triggerTokens = 55000;
  const result = await maintain(source, responder());
  assert(result.ok); assert.equal(result.observations.requests, 1);
  assert(result.observations.accounting!.normalExtractionAtTrigger > result.observations.accounting!.extractionInputLimit);
  assert.equal(result.observations.accounting!.normalHeadroomSufficient, false);
  assert.equal(result.observations.omissions.length, 0);
});
