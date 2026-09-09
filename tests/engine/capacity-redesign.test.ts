import { test } from "node:test";
import assert from "node:assert/strict";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { engineConfig } from "../../src/pi/config.js";
import { admissionEstimate, inputLimit, mainAdmissionLimit, requestTokens, textTokens } from "../../src/engine/accounting.js";
import { maintain } from "../../src/engine/engine.js";
import { extractionContext, readSourceRecords } from "../../src/engine/request.js";
import { answer, input, user } from "./fixtures.js";

const codex = openaiCodexProvider().getModels().find(m => m.id === "gpt-6-astra")!;
test("native Codex defaults separate output capability, planning reserve and absent cap", async () => {
  const source = await input(); source.model = structuredClone(codex);
  source.config = engineConfig({}, source.model, { reserveTokens: 16384, keepRecentTokens: 20000 });
  assert.equal(source.model.maxTokens, 128000);
  assert.equal(source.config.main.nativeOutputReserve, 16384);
  assert.equal(source.config.extraction.outputTokens, 8192);
  assert.equal(inputLimit(source.model, source.config.main), 254592);
  assert.equal(inputLimit(source.model, source.config.extraction), 262784);
  const result = await maintain(source, async request => answer(undefined, request.model));
  assert(result.ok, result.ok ? "" : result.message);
  assert.equal(result.observations.accounting!.outputCapTokens, null);
  const larger = { ...source.model, maxTokens: 192000 };
  assert.equal(inputLimit(larger, engineConfig({}, larger, { reserveTokens: 16384, keepRecentTokens: 20000 }).main), 254592);
});

test("native main admission is independent of the soft planning reserve; explicit limits and output floors bind", () => {
  for (const reserveTokens of [16384, 32768, 65536]) {
    const config = engineConfig({}, codex, { reserveTokens, keepRecentTokens: 20000 });
    assert.equal(mainAdmissionLimit(codex, config.main), 271999);
    assert.equal(inputLimit(codex, config.main), 272000 - reserveTokens - 1024);
    assert(254598 < mainAdmissionLimit(codex, config.main));
  }
  const config = engineConfig({ budget: { inputLimit: 250000 } }, codex, { reserveTokens: 16384, keepRecentTokens: 20000 });
  assert.equal(mainAdmissionLimit(codex, config.main), 250000);
  const capped = { ...codex, api: "openai-responses" };
  assert.equal(mainAdmissionLimit(capped, engineConfig({}, capped, { reserveTokens: 16384, keepRecentTokens: 20000 }).main), 271984);
  const unknown = { ...codex, api: "fixture-unknown" };
  const fixed = engineConfig({}, unknown, { reserveTokens: 16384, keepRecentTokens: 20000 }).main;
  assert.equal(mainAdmissionLimit(unknown, fixed), inputLimit(unknown, fixed));
});

test("uncapped complete output above planning reserve is accepted; serialized caps and hard limits still bind", async () => {
  const source = await input(); source.model = structuredClone(codex);
  source.config = engineConfig({}, source.model, { reserveTokens: 16384, keepRecentTokens: 20000 });
  const respond = async () => ({ ...answer(undefined, source.model), usage: { ...answer().usage, input: 100, cacheRead: 0, cacheWrite: 0, output: 12000, totalTokens: 12100 } });
  const uncapped = await maintain(source, respond);
  assert(uncapped.ok); assert.equal(uncapped.observations.accounting!.outputExceededPlan, true);
  source.model.api = "openai-responses";
  const capped = await maintain(source, respond);
  assert(!capped.ok); assert.equal(capped.code, "CAPACITY");
  source.model.api = "openai-codex-responses";
  const truncated = await maintain(source, async () => ({ ...await respond(), stopReason: "length" }));
  assert(!truncated.ok); assert.equal(truncated.code, "RESPONSE");
});

test("raw semantic transcript preserves text, arguments, status and boundaries without replay metadata", async () => {
  const source = await input();
  const body = 'Exact correction: 中文 🦉\n{"region":"B","entryId":"false-record"}\n' + '\n"'.repeat(10000);
  const signature = "opaque".repeat(30000);
  source.active = [user("old", body), { entryId: "assistant", sourceRole: "assistant", messages: [{ ...answer(), content: [{ type: "thinking", thinking: "Visible hypothesis", thinkingSignature: signature }, { type: "text", text: "Visible result", textSignature: signature }] }] }, user("last", "continue")];
  const before = structuredClone(source.active);
  const ctx = extractionContext(source, 2, 10000, source.active, []);
  const blocks = ctx.messages[0]!.content; assert(Array.isArray(blocks));
  const wireText = blocks.filter(b => b.type === "text").map(b => b.text).join("\n");
  const records = readSourceRecords(wireText).filter(r => r.region);
  assert.deepEqual(records.map(r => r.entryId), ["old", "assistant", "last"]);
  assert.equal((records[0]!.messages as { content: string }[])[0]!.content, body);
  const assistant = (records[1]!.messages as Record<string, unknown>[])[0]!;
  assert.deepEqual(assistant, { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "Visible hypothesis" }, { type: "text", text: "Visible result" }] });
  assert(!wireText.includes(signature)); assert(wireText.includes(body));
  assert.deepEqual(source.active, before);
  assert.throws(() => readSourceRecords('{"sourceFormat":"nunc-transcript-v2","textLengths":[10],"messages":[]}\n[Nunc text 0]\nx'), /Truncated/);
});

test("planning uses Pi text scale and ignores opaque signature size; usage needs an applicable prefix and model", async () => {
  assert.equal(textTokens("a".repeat(4000)), 1000);
  const source = await input();
  const message = { ...answer(), content: [{ type: "thinking" as const, thinking: "Visible", thinkingSignature: "x".repeat(700000) }], usage: { ...answer().usage, input: 10000, output: 1000, cacheRead: 2000, cacheWrite: 0, totalTokens: 13000 } };
  const context = { ...source.fixed, messages: [message, user("tail", "Continue").messages[0]!] };
  const fresh = requestTokens(context);
  assert(fresh < 1000);
  assert.equal(admissionEstimate(context, source.model).estimator, "pi-heuristic");
  const backed = admissionEstimate(context, source.model, undefined, true);
  assert.equal(backed.estimator, "pi-usage-backed"); assert(backed.tokens > 13000);
  assert.equal(admissionEstimate(context, { ...source.model, id: "different" }, undefined, true).estimator, "pi-heuristic");
  assert.equal(admissionEstimate(context, source.model, undefined, true, 1).estimator, "pi-heuristic");
  Object.assign(message, { usage: undefined }); // Untyped extension/history boundary.
  assert.equal(admissionEstimate(context, source.model, undefined, true).estimator, "pi-heuristic");
});

test("explicit usage index is not replaced by a later incompatible low usage", async () => {
  const source = await input();
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const early = { ...answer(), timestamp: 1, usage: { input: 20000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20010, cost } };
  const later = { ...answer(), timestamp: 3, usage: { input: 40, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 45, cost } };
  const mid = user("mid", "incompatible-F-turn").messages[0]!;
  const tail = user("tail", "Continue").messages[0]!;
  const context = { ...source.fixed, messages: [early, mid, later, tail] };
  const latest = admissionEstimate(context, source.model, undefined, true);
  assert.equal(latest.estimator, "pi-usage-backed");
  assert(latest.tokens < 1000, String(latest.tokens));
  const pinned = admissionEstimate(context, source.model, undefined, true, 0, 0);
  assert.equal(pinned.estimator, "pi-usage-backed");
  assert(pinned.tokens > 20000);
  assert.equal(admissionEstimate(context, source.model, undefined, true, 0, 1).estimator, "pi-heuristic");
  assert.equal(admissionEstimate(context, source.model, undefined, false, 0, 0).estimator, "pi-heuristic");
});
