import { test } from "node:test";
import assert from "node:assert/strict";
import { maintain } from "../../src/engine/engine.js";
import { chooseCut, memoryPlan, requestTokens } from "../../src/engine/accounting.js";
import { extractionContext, resolveExtractionRequest } from "../../src/engine/request.js";
import { engineConfig, parseConfig } from "../../src/pi/config.js";
import { answer, input, user } from "./fixtures.js";

async function automatic() {
  const source = await input(); source.model.maxTokens = 64000; source.model.contextWindow = 98304;
  source.config = engineConfig({}, source.model, { reserveTokens: 16384, keepRecentTokens: 8000 });
  return source;
}
test("omitted and explicit auto preserve defaults, explicit numeric remains fixed", async () => {
  const s = await automatic();
  assert.deepEqual(engineConfig(parseConfig({ extraction: { outputTokens: "auto" } }), s.model, { reserveTokens: 16384, keepRecentTokens: 8000 }), s.config);
  assert.equal(s.config.extraction.toolResults, "auto"); assert.equal(s.config.memory.targetTokens, 8192);
  assert.equal(s.config.memory.fraction, .1); assert.equal(s.config.memory.hardMaxTokens, undefined);
  assert.equal(s.config.keepRecentFraction, .5); assert.equal(s.config.growthTokens, 1024);
  const fixed = engineConfig(parseConfig({ extraction: { outputTokens: 8192, toolResults: "auto" } }), s.model, { reserveTokens: 16384, keepRecentTokens: 8000 });
  assert.equal(fixed.extraction.outputAuto, undefined); assert.equal(fixed.extraction.outputTokens, 8192); assert.equal(fixed.extraction.toolResults, "auto");
  assert.throws(() => parseConfig({ extraction: { outputTokens: "32768" } }));
});
test("complete frozen source, IDs, tools, media, wrapping and extras determine ample, limited and insufficient auto cap", async () => {
  for (const headroom of [50000, 17280, 8192, 8191]) {
    const s = await automatic();
    s.fixed.tools.push({ name: "extra", description: "definition".repeat(400), parameters: { type: "object" } });
    s.memory.slots = [{ id: "s1", text: "Material relation A belongs to B" }];
    s.active[2]!.messages = [{ role: "user", content: [{ type: "text", text: "continue" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 0 }];
    s.config.extraction.extraInputTokens = 411; s.config.imageTokens = 2048;
    s.config.triggerTokens = 10000; s.config.main.nativeOutputReserve = 1;
    const plan = memoryPlan(s.fixed, s.model, s.config, s.memory.slots);
    const context = extractionContext(s, 2, plan.organizingTarget, s.active, [], s.model.maxTokens);
    const completeInput = requestTokens(context, 2048) + 411;
    s.model.contextWindow = completeInput + 1024 + headroom;
    s.config.triggerTokens = Math.min(s.config.triggerTokens, s.model.contextWindow - 2048);
    let calls = 0;
    const result = await maintain(s, async request => {
      calls++;
      const tokens = requestTokens(request.context, 2048) + 411;
      assert.equal(request.outputTokens, Math.min(s.model.maxTokens, s.model.contextWindow - tokens - 1024));
      assert.match(request.context.systemPrompt!, new RegExp(`Serialized output cap: ${String(request.outputTokens).padStart(5, "0")}`));
      return answer({ add: [], remove: [], priority: ["s1"], required: ["s1"] }, request.model);
    });
    if (headroom < 8192) { assert(!result.ok); assert.equal(result.code, "CAPACITY"); assert.equal(calls, 0); }
    else { assert(result.ok, result.ok ? "" : result.message); assert.equal(calls, 1); assert.equal(result.observations.accounting!.outputReserveTokens, Math.min(s.model.maxTokens, headroom)); assert.equal(result.observations.omissions.length, 0); }
  }
});
test("capability, independent input/output limits, explicit numbers and uncapped native route retain their meanings", async () => {
  const s = await automatic();
  const build = (cap: number) => extractionContext(s, 2, 8192, s.active, [], cap);
  let r = resolveExtractionRequest(s, build);
  assert.equal(r.outputTokens, 64000); assert.equal(r.outputDesiredTokens, 64000); assert.equal(r.outputLimitedBy, "capability");
  s.config.extraction.outputLimit = 48000;
  r = resolveExtractionRequest(s, build); assert.equal(r.outputTokens, 48000); assert.equal(r.outputLimitedBy, "capability");
  s.config.extraction.outputLimit = 4000;
  r = resolveExtractionRequest(s, build); assert.equal(r.outputTokens, 4000);
  delete s.config.extraction.outputLimit; s.config.extraction.outputAuto = false; s.config.extraction.outputTokens = 16000;
  r = resolveExtractionRequest(s, build); assert.equal(r.outputTokens, 16000);
  s.config.extraction.inputLimit = 10; assert.throws(() => resolveExtractionRequest(s, build), (e: unknown) => e instanceof Error && "code" in e && e.code === "CAPACITY");
  delete s.config.extraction.inputLimit; s.config.extraction.outputAuto = true; s.config.extraction.outputTokens = 8192;
  for (const native of ["codex", "compat", "subscription"]) {
    s.model.api = native === "codex" ? "openai-codex-responses" : "openai-responses";
    s.model.compat = native === "compat" ? { supportsMaxOutputTokens: false } : {};
    s.config.extraction.outputUncapped = native === "subscription";
    r = resolveExtractionRequest(s, build); assert.equal(r.outputTokens, 8192); assert.equal(r.outputCapTokens, null);
  }
});
test("six-digit model capability is reduced only by complete input headroom and final request is checked", async () => {
  const s = await automatic(); s.model.maxTokens = 128000; s.model.contextWindow = 100000;
  s.config.extraction.extraInputTokens = 300;
  const build = (cap: number) => extractionContext(s, 2, 8192, s.active, [], cap);
  const before = structuredClone(s.active), r = resolveExtractionRequest(s, build);
  assert.equal(r.outputDesiredTokens, 128000); assert.equal(r.outputLimitedBy, "window");
  assert(r.outputTokens > 32768); assert(r.outputTokens < 128000);
  assert.equal(r.extractionTokens, requestTokens(r.context) + 300);
  assert(r.extractionTokens + r.outputTokens + s.config.extraction.safetyTokens <= s.model.contextWindow);
  assert.deepEqual(s.active, before);
});
test("caller-added UI cleanup instruction is counted before resolving cap", async () => {
  const s = await automatic(); const normal = resolveExtractionRequest(s, cap => extractionContext(s, 2, 8192, s.active, [], cap));
  s.model.contextWindow = normal.extractionTokens + 1024 + 10000;
  const extra = resolveExtractionRequest(s, cap => {
    const ctx = extractionContext(s, 2, 8192, s.active, [], cap);
    ctx.messages.push({ role: "user", content: "exact proposed M / cleanup only".repeat(100), timestamp: 0 }); return ctx;
  });
  assert(extra.outputTokens < 10000); assert(extra.outputTokens >= 8192);
});
test("nearest legal neighbor retains a larger contiguous suffix only with growth room", async () => {
  const s = await input(); s.active = [user("a", "x".repeat(400)), user("b", "x".repeat(400)), user("c", "x".repeat(400)), user("d", "x".repeat(400))];
  const lower = chooseCut(s.active, [1, 2, 3], 0, 0, 0, 10000, s.config);
  const next = chooseCut(s.active, [1, 2], 0, 0, 0, 10000, s.config);
  const midpoint = (lower.keptTokens + next.keptTokens) / 2;
  assert.equal(chooseCut(s.active, [1, 2, 3], 0, 0, midpoint + 1, 10000, s.config).cut, 2);
  assert.equal(chooseCut(s.active, [1, 2, 3], 0, 0, midpoint - 1, 10000, s.config).cut, 3);
  assert.equal(chooseCut(s.active, [1, 2, 3], 0, 0, midpoint + 1, next.keptTokens + s.config.growthTokens - 1, s.config).cut, 3);
});
test("auto length/partial JSON or cancellation never retries or produces a candidate", async () => {
  for (const kind of ["length", "partial", "cancel"]) {
    const s = await automatic(); const before = structuredClone({ memory: s.memory, active: s.active }); let calls = 0; const controller = new AbortController(); s.signal = controller.signal;
    const result = await maintain(s, async request => {
      calls++; if (kind === "cancel") controller.abort();
      return { ...answer(undefined, request.model), ...(kind === "length" ? { stopReason: "length" } : {}), ...(kind === "partial" ? { content: [{ type: "text", text: '{"add":[' }] } : {}) };
    });
    assert(!result.ok); assert.equal(calls, 1); assert.equal(result.observations.requests, 1);
    assert.deepEqual({ memory: s.memory, active: s.active }, before);
  }
});
