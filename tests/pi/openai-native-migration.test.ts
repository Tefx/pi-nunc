import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model, Provider, Context, AssistantMessage } from "@earendil-works/pi-ai";
import { responsesSSE, fixture } from "./fixtures.js";
import { piComplete, subscriptionBilling } from "../../src/engine/pi-model.js";
import { BudgetLedger, boundedProvider, readLedger, ledgerSummary } from "../../src/live/budget.js";
import { serializedEvidence } from "../../src/live/stable-memory-observation.js";
import type { AdmissionObservation } from "../../src/pi/admission.js";

const provider = openaiProvider();
const model = provider.getModels().find(m => m.id === "gpt-6.1-sol")!;
assert(model);

for (const oauth of [true, false]) test(`real loader / native openai serializer preserves medium main+maintenance and ${oauth ? "subscription unknown" : "API-key catalog"} billing`, async t => {
  const admissions: AdmissionObservation[] = [], bodies: Record<string, unknown>[] = [];
  const f = await fixture({ extras: [{ name: "admission-observer", factory(pi) { pi.events.on("nunc:admission", value => admissions.push(value as AdmissionObservation)); } }] });
  t.after(() => f.close());
  await f.credentials.modify("openai", async () => oauth ? { type: "oauth", access: "fictional-direct-subscription", refresh: "fictional-refresh", expires: Date.now() + 86400000, clientId: "fictional-client", scopes: ["chatgpt.tokens.use.direct"] } : { type: "api_key", key: "sk-fictional-controlled-only" });
  const registry = new ModelRegistry(f.modelRuntime);
  const transport: typeof fetch = async (resource, init) => {
    const request = new Request(resource, init);
    assert.equal(request.url, "https://api.openai.com/v1/responses");
    const body = await request.json() as Record<string, unknown>; bodies.push(body);
    assert.deepEqual(body.reasoning, { effort: "medium", summary: "auto" });
    assert.equal(Object.hasOwn(body, "max_output_tokens"), !oauth, "Native subscription omits cap; API-key serializer retains it");
    return responsesSSE(model.id, bodies.length === 2 ? JSON.stringify({ add: [{ key: "fact", text: "Continue verification." }], remove: [], priority: ["fact"], required: ["fact"] }) : "Controlled continuation.", { inputTokens: 200, outputTokens: 32, cachedTokens: 40, reasoningTokens: 8 });
  };
  const requests: Array<{ callId: number; outputPlanning: number | null; kind: string }> = [];
  const caps: Array<{ callId: number; cap: ReturnType<typeof import("../../src/pi/payload.js").outputCapState> }> = [];
  const boundedLedger = new BudgetLedger(join(f.dir, "bounded.jsonl"), { maxCalls: 4, maxTotalTokens: 2000000, maxOutputTokens: model.maxTokens, maxDurationMs: 30000, maxCostUsd: null }, Date.now() + 30000, new AbortController().signal);
  // Same registration as the live observer. Nunc then wraps this actual native
  // decorator for main admission and the owned piComplete maintenance scope.
  registry.registerProvider(boundedProvider(provider, [model], boundedLedger, { subscriptionBilling: m => subscriptionBilling(m, registry), fetch: transport,
    onRequest: data => requests.push(data), onPayload: data => caps.push(data) }));
  const refreshed = await f.modelRuntime.refresh({ allowNetwork: false });
  assert.equal(refreshed.errors.size, 0, [...refreshed.errors.values()].map(e => e.message).join("; "));
  assert.equal(registry.isUsingOAuth(model), oauth, JSON.stringify(await f.modelRuntime.checkAuth("openai")));
  assert.equal(subscriptionBilling(model, registry), oauth);
  await f.runtime.session.setModel(model); f.runtime.session.setThinkingLevel("medium");
  await f.runtime.session.prompt("Continue current work.");
  f.seed("delivered source");
  await f.runtime.session.compact();
  assert.equal(bodies.length, 2); assert.equal(f.events.at(-1)?.result.ok, true);
  const result = f.events.at(-1)!.result;
  assert.equal(result.observations.usage.cost === null, oauth);
  const maintenance = admissions.findLast(o => o.kind === "maintenance");
  assert.equal(maintenance?.outcome, "delegate");
  assert.equal(maintenance?.outputCapTokens, oauth ? null : model.maxTokens);
  assert.equal(bodies[1]!.max_output_tokens, oauth ? undefined : model.maxTokens);
  const boundedMaintenance = requests.find(r => r.kind === "maintenance"); assert(boundedMaintenance);
  assert.equal(boundedMaintenance.outputPlanning, oauth ? 8192 : model.maxTokens);
  const reservation = readLedger(boundedLedger.path).find(r => r.kind === "reserve" && r.id === boundedMaintenance.callId);
  assert(reservation?.kind === "reserve"); assert.equal(reservation.outputCeiling, model.maxTokens);
  assert.equal(caps.find(r => r.callId === boundedMaintenance.callId)?.cap.kind, oauth ? "missing" : "value");
  const cp = f.runtime.session.sessionManager.getBranch().findLast(e => e.type === "compaction");
  assert(cp?.type === "compaction"); assert.match(cp.summary, /Continue verification/);
  await f.runtime.session.prompt("Continue using saved state.");
  assert.equal(bodies.length, 3); assert.match(JSON.stringify(bodies[2]!.input), /Continue verification/);

  const limits = { maxCalls: 2, maxTotalTokens: 1000000, maxOutputTokens: model.maxTokens, maxDurationMs: 10000, maxCostUsd: 100 };
  const context: Context = { messages: [{ role: "user", content: "Controlled", timestamp: 1 }] };
  const priced = new BudgetLedger(join(f.dir, "priced.jsonl"), limits, Date.now() + 10000, new AbortController().signal);
  if (oauth) { assert.throws(() => priced.reserve(model, context, model.maxTokens, subscriptionBilling(model, registry)), /Subscription billing is unknown/); assert.equal(readLedger(priced.path).length, 0); }
  else { const call = priced.reserve(model, context, model.maxTokens, false); assert(call.reservedCostUsd! > 0); }
  const unknown = new BudgetLedger(join(f.dir, "unknown.jsonl"), { ...limits, maxCostUsd: null }, Date.now() + 10000, new AbortController().signal);
  const call = unknown.reserve(model, context, model.maxTokens, oauth);
  assert.equal(call.reservedCostUsd, null); assert(call.catalogReservationUsd! > 0);
});

test("public raw maintenance bridge preserves native medium and actual Responses M/tool associations", async t => {
  const f = await fixture(); t.after(() => f.close());
  await f.credentials.modify("openai", async () => ({ type: "api_key", key: "sk-fictional-controlled-only" }));
  let payload: unknown;
  const registry = new ModelRegistry(f.modelRuntime);
  const wrapped: Provider = { ...provider, stream: (m, context, options) => {
    assert.equal(m.api, "openai-responses");
    return provider.stream({ ...m, api: "openai-responses" }, context, { ...options, fetch: async () => responsesSSE(model.id, "Observed.", { inputTokens: 200, outputTokens: 32, cachedTokens: 40, reasoningTokens: 8 }), onPayload: body => { payload = structuredClone(body); } } as Parameters<typeof provider.stream>[2]);
  } };
  registry.registerProvider(wrapped);
  const context: Context = { messages: [
    { role: "user", content: "Task", timestamp: 1 },
    { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "toolCall", id: "call-1|fc-1", name: "read", arguments: { path: "source.txt" } }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "call-1|fc-1", toolName: "read", content: [{ type: "text", text: "No result provided" }], isError: false, timestamp: 3 },
    { role: "user", content: "Saved M", timestamp: 4 },
  ] };
  // Complete returns unknown for engine validation; this fixture binds the
  // actual native registry response type and immediately checks its terminal.
  const reply = await piComplete(registry, "medium")({ model, context, outputTokens: 8192, signal: new AbortController().signal }) as AssistantMessage;
  assert.equal(reply.stopReason, "stop", reply.errorMessage ?? "Native response must be complete");
  const body = payload as { reasoning: { effort: string }; input: unknown[] }; assert.equal(body.reasoning.effort, "medium");
  const observation = { callId: 1, turn: "a", kind: "main" as const, model, thinking: "medium", reasoning: "medium", outputPlanning: 8192, context,
    admission: { memoryPresent: true, memoryCarrierCount: 1, memoryIndex: 3, memoryContent: "Saved M" } as AdmissionObservation, finalPayload: payload };
  assert.deepEqual(serializedEvidence(observation), { synthetic: false, memory: true });
  const corrupted = structuredClone(observation); (corrupted.finalPayload as { input: { type?: string; output?: string }[] }).input.find(e => e.type === "function_call_output")!.output = "fabricated";
  assert.equal(serializedEvidence(corrupted).synthetic, true);
  await assert.rejects(async () => piComplete(registry, "minimal")({ model, context, outputTokens: 8192, signal: new AbortController().signal }), /unsupported/);
  const usage = new BudgetLedger(join(f.dir, "usage.jsonl"), { maxCalls: 1, maxTotalTokens: 1000000, maxOutputTokens: model.maxTokens, maxDurationMs: 10000, maxCostUsd: null }, Date.now() + 10000, new AbortController().signal);
  const call = usage.reserve(model, context, model.maxTokens, true); usage.finish(call, reply);
  assert.equal(ledgerSummary(readLedger(usage.path)).costUsd, null);
  assert.equal(ledgerSummary(readLedger(usage.path)).contextInput, 200);
});

test("thinking changed during native Responses extraction discards the otherwise valid candidate", async t => {
  const f = await fixture(); t.after(() => f.close());
  await f.credentials.modify("openai", async () => ({ type: "api_key", key: "sk-fictional-controlled-only" }));
  const wrapped: Provider = { ...provider, stream: (m, context, options) => {
    assert.equal(m.api, "openai-responses");
    return provider.stream({ ...m, api: "openai-responses" }, context, { ...options, fetch: async () => {
      f.runtime.session.setThinkingLevel("high");
      return responsesSSE(model.id, JSON.stringify({ add: [{ key: "fact", text: "Must not commit stale candidate." }], remove: [], priority: ["fact"], required: ["fact"] }), { inputTokens: 200, outputTokens: 32, cachedTokens: 40, reasoningTokens: 8 });
    } } as Parameters<typeof provider.stream>[2]);
  } };
  new ModelRegistry(f.modelRuntime).registerProvider(wrapped);
  await f.runtime.session.setModel(model); f.runtime.session.setThinkingLevel("medium"); f.seed("frozen source");
  await assert.rejects(f.runtime.session.compact());
  assert.equal(f.runtime.session.sessionManager.getBranch().filter(e => e.type === "compaction").length, 0);
  assert.equal(f.runtime.session.thinkingLevel, "high");
});

test("native provider decorator rejects subscription USD guarantees before reservation/transport", async t => {
  const f = await fixture(); t.after(() => f.close());
  await f.credentials.modify("openai", async () => ({ type: "oauth", access: "fictional-direct-subscription", refresh: "fictional-refresh", expires: Date.now() + 86400000, clientId: "fictional-client", scopes: ["chatgpt.tokens.use.direct"] }));
  const registry = new ModelRegistry(f.modelRuntime);
  let sent = 0;
  for (const maxCostUsd of [100, null]) {
    const ledger = new BudgetLedger(join(f.dir, `decorator-${maxCostUsd}.jsonl`), { maxCalls: 1, maxTotalTokens: 1000000, maxOutputTokens: model.maxTokens, maxDurationMs: 10000, maxCostUsd }, Date.now() + 10000, new AbortController().signal);
    registry.registerProvider(boundedProvider(provider, [model], ledger, { subscriptionBilling: m => subscriptionBilling(m, registry), onRequest: data => { assert.equal(data.reasoning, "medium"); assert.equal(data.model.api, "openai-responses"); }, fetch: async () => { sent++; return responsesSSE(model.id, "Controlled.", { inputTokens: 200, outputTokens: 32, cachedTokens: 40, reasoningTokens: 8 }); } }));
    await f.modelRuntime.refresh({ allowNetwork: false });
    const result = await registry.complete(model, { messages: [{ role: "user", content: "Controlled", timestamp: 1 }] }, { reasoningEffort: "medium" });
    assert.equal(result.stopReason, maxCostUsd === null ? "stop" : "error");
    if (maxCostUsd !== null) { assert.match(result.errorMessage ?? "", /COST_LIMIT/); assert.equal(sent, 0); assert.equal(readLedger(ledger.path).length, 0); }
    else { assert.equal(sent, 1); assert.equal(ledgerSummary(readLedger(ledger.path)).costUsd, null); }
  }
});
