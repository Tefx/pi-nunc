import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeContext, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { admissionEstimate, chooseCut, historyPlanningEstimate, mainContext, mainPlanningEstimate, memoryPlan, messagePlanningEstimate, messageTokens, requestTokens, textTokens } from "../../src/engine/accounting.js";
import { maintain } from "../../src/engine/engine.js";
import { legalCuts } from "../../src/engine/validation.js";
import { answer, input, model as baseModel, sourceRecords, tool, user } from "./fixtures.js";
import type { ActiveEntry } from "../../src/engine/types.js";

const model: Model<Api> = { ...baseModel, api: "openai-responses", provider: "openai", reasoning: true };
const item = (id = "rs_fixture", encrypted = "fixture-opaque") => ({ type: "reasoning", id, summary: [], encrypted_content: encrypted });
function signed(output = 8000, items = 1): AssistantMessage {
  return { ...answer({}, model), usage: { ...answer().usage, output, reasoning: Math.max(0, output - 20) },
    content: Array.from({ length: items }, (_, i) => ({ type: "thinking" as const, thinking: "", thinkingSignature: JSON.stringify(item(`rs_${i}`)) })) };
}
function entry(id: string, message = signed()): ActiveEntry { return { entryId: id, sourceRole: "assistant", messages: [message] }; }

test("reply-level output proxy preserves role/block framing, charges once and leaves admission generic", () => {
  const message = signed(8000, 3), before = structuredClone(message);
  const estimate = messagePlanningEstimate(message, model);
  const framing = 32 + textTokens("assistant") + 3 * 16;
  assert.equal(estimate.tokens, framing + 8000);
  assert.equal(estimate.visibleTokens, messageTokens(message));
  assert.equal(estimate.additionalTokens, 8000);
  assert.equal(estimate.basis, "response-output-proxy");
  assert.deepEqual(estimate.uncertainties, ["replay-mode-unknown"]);
  assert.equal(estimate.partial, true, "generation does not establish next-request rendering");
  const context = { systemPrompt: "fixed", messages: [message] };
  assert.equal(admissionEstimate(context, model).tokens, requestTokens(context));
  assert(requestTokens(context) < 1000);
  assert.deepEqual(message, before);
  message.content.push({ type: "text", text: "a".repeat(40000) });
  assert.equal(messagePlanningEstimate(message, model).tokens, messageTokens(message), "larger visible content is not added twice");
});

test("ciphertext size, model reasoning capability and opaque metadata do not determine replay cost", () => {
  const short = signed(8000), long = structuredClone(short);
  const thinking = long.content[0]; assert(thinking?.type === "thinking");
  thinking.thinkingSignature = JSON.stringify(item("rs_0", "opaque".repeat(100000)));
  assert.equal(messagePlanningEstimate(short, model).tokens, messagePlanningEstimate(long, model).tokens);
  assert.equal(messagePlanningEstimate(short, { ...model, reasoning: false }).tokens, messagePlanningEstimate(short, model).tokens);
  thinking.thinkingSignature = "opaque".repeat(100000);
  const unknown = messagePlanningEstimate(long, model);
  assert.equal(unknown.tokens, messageTokens(long));
  assert(unknown.uncertainties.includes("replay-mapping-unknown"));
});

for (const api of ["openai-responses", "openai-codex-responses", "azure-openai-responses"]) test(`native ${api} replay eligibility uses API/provider/model without a provider-name whitelist`, () => {
  const target = { ...model, api, provider: "custom-native-provider" };
  const message = { ...signed(), api, provider: target.provider };
  assert.equal(messagePlanningEstimate(message, target).basis, "response-output-proxy");
  for (const other of [{ ...target, api: "openai-completions" }, { ...target, id: "other" }, { ...target, provider: "other" }]) {
    const estimate = messagePlanningEstimate(message, other);
    assert.equal(estimate.tokens, messageTokens(message)); assert.equal(estimate.partial, false);
  }
  for (const stopReason of ["error", "aborted"] as const) assert.equal(messagePlanningEstimate({ ...message, stopReason }, target).basis, "visible-heuristic");
});

test("absent, normalized-zero and invalid output remain partial visible fallbacks", () => {
  for (const output of [undefined, 0, -1, 1.5, Infinity, NaN]) {
    const message = signed();
    message.usage = { ...message.usage, output } as AssistantMessage["usage"];
    const estimate = messagePlanningEstimate(message, model);
    assert.equal(estimate.tokens, messageTokens(message));
    assert.equal(estimate.basis, "visible-heuristic");
    assert(estimate.partial && estimate.uncertainties.includes("usage-unavailable"));
  }
  const message = signed(); message.usage.reasoning = message.usage.output + 1;
  assert(messagePlanningEstimate(message, model).uncertainties.includes("usage-unavailable"));
  delete message.usage.reasoning;
  assert.equal(messagePlanningEstimate(message, model).basis, "response-output-proxy", "reported output suffices without per-item reasoning counts");
  const unavailable = messagePlanningEstimate(message, model, undefined, true);
  assert.equal(unavailable.tokens, messageTokens(message)); assert(unavailable.uncertainties.includes("replay-mapping-unknown"));
  message.content.push({ type: "thinking", thinking: "visible part without replay metadata" });
  assert.equal(messagePlanningEstimate(message, model).basis, "visible-heuristic", "native transport cannot replay the complete reply's thinking");
  message.content[1] = { type: "thinking", thinking: "", thinkingSignature: "not-native-json" };
  assert.equal(messagePlanningEstimate(message, model).basis, "visible-heuristic", "partially mapped replies are not treated as a known whole output");
});

test("model-aware cut retains complete tools, leaves extraction semantic and does not alter fixed q", async () => {
  const source = await input(); source.model = model; source.config.keepRecentFraction = 0.5;
  source.active = [user("old", "initial task")];
  for (let i = 0; i < 3; i++) {
    const message = signed(); message.stopReason = "toolUse";
    message.content[0] = { type: "thinking", thinking: "", thinkingSignature: JSON.stringify(item(`rs_reply${i}`)) };
    message.content.push({ type: "toolCall", id: `call${i}|fc_call${i}`, name: "read", arguments: { path: `file${i}` } });
    source.active.push(entry(`reply${i}`, message), tool(`result${i}`, `call${i}|fc_call${i}`, `evidence${i}`));
  }
  source.active.push(user("last", "continue"));
  const original = structuredClone(source.active), plan = memoryPlan(source.fixed, model, source.config), cuts = legalCuts(source.active);
  const old = chooseCut(source.active, cuts, plan.fixedTokens, plan.memoryLimit, plan.keepTarget, plan.effectiveTrigger, source.config);
  const chosen = chooseCut(source.active, cuts, plan.fixedTokens, plan.memoryLimit, plan.keepTarget, plan.effectiveTrigger, source.config, model);
  assert(chosen.cut > old.cut); assert(cuts.includes(chosen.cut));
  let extraction = 0;
  const result = await maintain(source, async request => {
    extraction++;
    const body = JSON.stringify(request.context);
    assert(!body.includes("fixture-opaque") && !body.includes("thinkingSignature"));
    assert.equal(sourceRecords(request.context).length, source.active.length);
    return answer(undefined, model);
  });
  assert(result.ok, result.ok ? "" : result.message);
  assert.equal(extraction, 1);
  assert.equal(result.candidate.firstKeptEntryId, source.active[chosen.cut]!.entryId);
  assert.deepEqual(result.candidate.kept, original.slice(chosen.cut));
  const accounting = result.observations.accounting!;
  assert.equal(accounting.keptTokens, historyPlanningEstimate(result.candidate.kept, model).tokens);
  assert.equal(accounting.planning?.after?.tokens, accounting.mainAfterTokens);
  assert(accounting.mainBeforeTokens > requestTokens(mainContext(source.fixed, [], source.active)));
  assert.equal(source.config.keepRecentFraction, 0.5);
  let serialized: Record<string, unknown> = {};
  const native = await openaiProvider().stream(model as Model<"openai-responses">, normalizeContext(mainContext(source.fixed, result.candidate.memory.slots, result.candidate.kept)), {
    apiKey: "offline-fixture-key", maxRetries: 0, maxTokens: 100,
    fetch: async (resource, init) => {
      serialized = await new Request(resource, init).json() as Record<string, unknown>;
      return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { id: "offline-final", model: model.id, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  }).result();
  assert.equal(native.stopReason, "stop", native.errorMessage ?? "");
  const expectedItems = result.candidate.kept.flatMap(e => e.messages.flatMap(m => typeof m.content === "string" ? [] : m.content.flatMap(b => b.type === "thinking" && b.thinkingSignature ? [JSON.parse(b.thinkingSignature)] : [])));
  const wireItems = serialized.input as Record<string, unknown>[];
  assert(expectedItems.length > 0);
  assert.deepEqual(wireItems.filter(item => item.type === "reasoning"), expectedItems);
  const calls = wireItems.filter(item => item.type === "function_call"), outputs = wireItems.filter(item => item.type === "function_call_output");
  assert.deepEqual(calls.map(item => item.call_id), outputs.map(item => item.call_id), "retained native tool associations remain whole");
  source.config.keepRecentFraction = 0.67;
  const larger = memoryPlan(source.fixed, model, source.config);
  const at67 = chooseCut(source.active, cuts, larger.fixedTokens, larger.memoryLimit, larger.keepTarget, larger.effectiveTrigger, source.config, model);
  assert(at67.cut <= chosen.cut);
  assert.equal(mainPlanningEstimate(source.fixed, [], source.active, model).visibleTokens, requestTokens(mainContext(source.fixed, [], source.active)));
});

test("entry-level unavailable output prevents reuse after a native edit", () => {
  const original = entry("original");
  const edited = { ...original, outputUsageUnavailable: true };
  assert(historyPlanningEstimate([original], model).additionalTokens > 0);
  const fallback = historyPlanningEstimate([edited], model);
  assert.equal(fallback.tokens, original.messages.reduce((n, m) => n + messageTokens(m), 0));
  assert(fallback.partial && fallback.uncertainties.includes("replay-mapping-unknown"));
});
