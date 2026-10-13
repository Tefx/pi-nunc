import { test } from "node:test";
import assert from "node:assert/strict";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { fixture } from "./fixtures.js";
import { answer } from "../engine/fixtures.js";
import { requestTokens, textTokens } from "../../src/engine/accounting.js";
import type { AdmissionObservation } from "../../src/pi/admission.js";

for (const [output, metadata] of [["auto", undefined], [8192, undefined], ["auto", { user_id: "genuine supplied metadata" }], [8192, { user_id: "genuine supplied metadata" }]] as const) test(`real loader/native guarded complete: ${output}, metadata ${metadata ? "supplied" : "absent"}, constrained full input`, async t => {
  const observations: AdmissionObservation[] = [];
  const f = await fixture({ config: { extraction: { outputTokens: output } }, extras: [{ name: "watch-native-cap", factory(pi) {
    pi.events.on("nunc:admission", o => observations.push(o as AdmissionObservation));
    if (metadata) pi.on("session_start", (_event, ctx) => {
      const registry = ctx.modelRegistry, original = registry.complete.bind(registry);
      registry.complete = (m, context, options) => original(m, context, Object.assign({}, options, { metadata }));
    });
  } }] });
  t.after(() => f.close());
  const registry = new ModelRegistry(f.modelRuntime), native = openrouterProvider();
  const model: Model<Api> = { id: "guarded-defaults", name: "Controlled native serializer", provider: "openrouter", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", reasoning: false, input: ["text"], contextWindow: 50000, maxTokens: 32768, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  await f.credentials.modify("openrouter", async () => ({ type: "api_key", key: "fictional-offline-key" }));
  const bodies: Record<string, unknown>[] = [], contexts: Parameters<typeof requestTokens>[0][] = [];
  registry.registerProvider({ ...native, getModels: () => [model], stream: (selected, context, options) => {
    contexts.push(structuredClone(context));
    assert.equal(selected.api, "openai-completions");
    return native.stream({ ...selected, api: "openai-completions" }, context, { ...options, fetch: async (_resource, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>; bodies.push(body);
      assert.equal(Object.hasOwn(body, "metadata"), false, "No omitted metadata object exists in the native request");
      const patch = JSON.stringify({ add: [{ key: "material", text: "Alice owns the blue house." }], remove: [], priority: ["material"], required: ["material"] });
      const chunks = [
        { id: "controlled", object: "chat.completion.chunk", model: model.id, choices: [{ index: 0, delta: { role: "assistant", content: patch }, finish_reason: null }] },
        { id: "controlled", object: "chat.completion.chunk", model: model.id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } },
      ];
      return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    } } as Parameters<typeof native.stream>[2]);
  } });
  await f.runtime.session.setModel(model);
  const manager = f.runtime.session.sessionManager;
  manager.appendMessage({ role: "user", content: "x".repeat(110000), timestamp: 0 });
  manager.appendMessage(answer({}, model));
  manager.appendMessage({ role: "user", content: "Continue preserving the established material.", timestamp: 1 });
  manager.appendMessage(answer({}, model));
  f.runtime.session.agent.state.messages = manager.buildSessionContext().messages;
  if (metadata && output === "auto") await assert.rejects(f.runtime.session.compact(), /Compaction cancelled/);
  else await f.runtime.session.compact();
  const result = f.events.at(-1)?.result;
  if (metadata && output === "auto") {
    assert(result && !result.ok); assert.equal(bodies.length, 0);
    const rejection = observations.find(o => o.kind === "maintenance" && o.outcome === "reject");
    assert(rejection); assert.equal(rejection.code, "CAPACITY");
    assert(rejection.inputTokens! > result.observations.accounting!.extractionTokens);
    assert.equal(manager.getBranch().filter(e => e.type === "compaction").length, 0);
    t.diagnostic(JSON.stringify({ output, metadata: "supplied", engineInput: result.observations.accounting!.extractionTokens, guardInput: rejection.inputTokens, limit: rejection.inputLimit, physicalCalls: bodies.length }));
    return;
  }
  assert(result?.ok, result && !result.ok ? result.message : "No maintenance result");
  assert.equal(bodies.length, 1, "Exactly one actual native complete call; no repair or fallback");
  const a = result.observations.accounting!, actual = bodies[0]!.max_completion_tokens ?? bodies[0]!.max_tokens;
  const input = requestTokens(contexts[0]!);
  assert.equal(input, a.extractionTokens);
  assert.equal(actual, a.outputReserveTokens); assert.equal(actual, a.outputCapTokens);
  assert.equal(actual, output === "auto" ? model.contextWindow - input - 1024 : output);
  if (output === "auto") { assert(a.outputReserveTokens >= 8192 && a.outputReserveTokens < 32768); assert.equal(a.outputLimitedBy, "window"); }
  const delegated = observations.filter(o => o.kind === "maintenance" && o.outcome === "delegate");
  assert(delegated.length); assert(delegated.every(o => o.inputTokens === input + (metadata ? textTokens(JSON.stringify(metadata)) : 0) && o.outputReserveTokens === actual));
  assert(!observations.some(o => o.kind === "maintenance" && o.outcome === "reject"));
  const checkpoints = manager.getBranch().filter(e => e.type === "compaction");
  assert.equal(checkpoints.length, 1); assert.match(checkpoints[0]!.summary, /Alice owns the blue house/);
  t.diagnostic(JSON.stringify({ output, metadata: metadata ? "supplied" : "absent", engineInput: input, guardInput: delegated.at(-1)!.inputTokens, limit: delegated.at(-1)!.inputLimit, actualCap: actual, physicalCalls: bodies.length, checkpoints: checkpoints.length }));
});
