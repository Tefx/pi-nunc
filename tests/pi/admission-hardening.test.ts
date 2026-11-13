import { test } from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, normalizeContext, type Api, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { createEventBus, ModelRegistry, ModelRuntime, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Admission, type AdmissionObservation } from "../../src/pi/admission.js";
import { engineConfig } from "../../src/pi/config.js";
import { omitsRouteOutputCap } from "../../src/engine/pi-model.js";
import { outputFloor } from "../../src/engine/accounting.js";
import { outputCapState } from "../../src/pi/payload.js";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { fixture, responsesSSE } from "./fixtures.js";

// Controlled serialized payloads exercise Admission's real wrapper/callback and
// completion receipt path. Native serializers have separate Google/OpenAI tests.
async function harness(t: { after(fn: () => void): void }, api: Api = "openai-completions") {
  const faux = fauxProvider({ api, provider: "cap-fixture", models: [{ id: "dense", contextWindow: 100000, maxTokens: 90000 }] });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  const observations: AdmissionObservation[] = [];
  const sent: unknown[] = [];
  let payload: unknown;
  let usage = 12000;
  registry.registerProvider({ ...faux.provider, streamSimple(model, _context, options) {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const message = { ...fauxAssistantMessage("anchor"), api: model.api, provider: model.provider, model: model.id };
      try {
        const replacement = await options?.onPayload?.(payload, model);
        sent.push(replacement === undefined ? payload : replacement);
        message.usage = { ...message.usage, input: usage, output: 4, totalTokens: usage + 4 };
        stream.push({ type: "done", reason: "stop", message }); stream.end(message);
      } catch (error) {
        const failed = { ...message, stopReason: "error" as const, errorMessage: String(error) };
        stream.push({ type: "error", reason: "error", error: failed }); stream.end(failed);
      }
    })();
    return stream;
  } });
  const model = faux.getModel();
  const signal = new AbortController().signal;
  const ctx = { model, signal, sessionManager: { getSessionId: () => "caps" }, modelRegistry: registry } as unknown as ExtensionContext;
  const events = createEventBus();
  events.on("nunc:admission", value => observations.push(value as AdmissionObservation));
  const admission = new Admission({ events,
    registerProvider(...args: Parameters<ModelRegistry["registerProvider"]>) { registry.registerProvider(...args); },
    unregisterProvider(id: string) { registry.unregisterProvider(id); },
  } as unknown as ExtensionAPI, () => engineConfig({ budget: { safetyTokens: 100 } }, model, { reserveTokens: 10000, keepRecentTokens: 1 }));
  admission.ensure(ctx);
  t.after(() => admission.close(ctx));
  const options = { signal, sessionId: "caps" };
  return { model, admission, observations, sent, options,
    setUsage(n: number) { usage = n; },
    async run(body: unknown, messages: TranscriptContext["messages"] = [{ role: "user", content: "x".repeat(20000), timestamp: 1 }], hook?: SimpleStreamOptions["onPayload"]) {
      payload = body;
      const context = normalizeContext({ messages });
      admission.bindProjection({ ...options, model, messages: context.messages, memory: { version: 1, nextId: 1, slots: [] } });
      return registry.getProvider(model.provider)!.streamSimple(model, context, { ...options, ...(hook ? { onPayload: hook } : {}) }).result();
    },
  };
}

test("actual native Responses serialization sends the post-authorization clamp and final observation", async t => {
  const native = openaiProvider();
  const catalog = native.getModels().find(m => m.id === "gpt-4.1");
  assert(catalog && catalog.api === "openai-responses");
  const model = { ...catalog, contextWindow: 100000, maxTokens: 90000, compat: { ...catalog.compat, supportsMaxOutputTokens: true } };
  let nativeCap: number | undefined;
  let sentCap: number | undefined;
  const observations: AdmissionObservation[] = [];
  const f = await fixture({ extras: [{ name: "capture-native-output", factory(pi) {
    pi.events.on("nunc:admission", value => observations.push(value as AdmissionObservation));
    pi.on("before_provider_request", event => {
      const state = outputCapState(event.payload);
      if (state.kind === "value") nativeCap = state.value;
    });
  } }] });
  t.after(() => f.close());
  const fetch: typeof globalThis.fetch = async (resource, init) => {
    const body = await new Request(resource, init).json();
    const state = outputCapState(body);
    assert.equal(state.kind, "value");
    if (state.kind === "value") sentCap = state.value;
    return responsesSSE(model.id, "Controlled response");
  };
  new ModelRegistry(f.modelRuntime).registerProvider({ ...native,
    getModels: () => [model],
    streamSimple: (_m, context, options) => native.streamSimple(model, context, { ...options, apiKey: "sk-offline-fixture-key", fetch, maxRetries: 0 }),
    stream: (_m, context, options) => native.stream(model, context, { ...options, apiKey: "sk-offline-fixture-key", fetch, maxRetries: 0 } as Parameters<typeof native.stream>[2]),
  });
  await f.modelRuntime.setRuntimeApiKey(model.provider, "sk-offline-fixture-key");
  await f.runtime.session.setModel(model);
  await f.runtime.session.prompt("Dense input " + "x".repeat(20000));
  assert(nativeCap && sentCap && sentCap < nativeCap && sentCap >= 36000, JSON.stringify({ nativeCap, sentCap, last: f.runtime.session.messages.at(-1), observations }));
  assert.equal(observations.at(-1)?.outputCapTokens, sentCap);
  assert.deepEqual(observations.at(-1)?.payload?.categories, []);
  const last = f.runtime.session.messages.at(-1);
  assert(last?.role === "assistant");
  assert.equal(last.stopReason, "stop", last.errorMessage ?? "");
});

const caps = { max_tokens: 90000, max_output_tokens: 90000, max_completion_tokens: 90000,
  generationConfig: { maxOutputTokens: 90000 }, config: { maxOutputTokens: 90000, thinkingConfig: { thinkingBudget: 0 } } };

test("post-authorization clamp clones every cap path, reports final cap, and preserves an output-only receipt", async t => {
  const h = await harness(t);
  const user = { role: "user" as const, content: "x".repeat(20000), timestamp: 1 };
  const body = { ...structuredClone(caps), messages: [user] };
  const original = structuredClone(body);
  const first = await h.run(body, [user], () => undefined);
  assert.equal(first.stopReason, "stop");
  assert.deepEqual(body, original);
  const sent = h.sent[0] as typeof body;
  assert.notEqual(sent, body);
  assert.notEqual(sent.config, body.config);
  assert.notEqual(sent.generationConfig, body.generationConfig);
  const state = outputCapState(sent);
  assert.equal(state.kind, "value");
  assert(state.kind === "value" && state.value >= 25000 && state.value < 80000);
  const observed = h.observations.at(-1)!;
  assert.equal(observed.outputCapTokens, state.kind === "value" ? state.value : -1);
  assert.equal(observed.payload?.mode, "noop");
  assert.deepEqual(observed.payload?.categories, []);
  const follow = { role: "user" as const, content: "next", timestamp: 2 };
  await h.run({ ...structuredClone(caps), messages: [user, first, follow] }, [user, first, follow]);
  assert.equal(h.observations.at(-1)?.estimateReason, "matching-receipt");
  assert.equal(h.observations.at(-1)?.receiptBreakdown?.observedU, 12004);
});

test("hook expansion and input over-budget growth reject before clamp", async t => {
  const h = await harness(t);
  const body = { max_tokens: 90000, messages: [{ role: "user", content: "x".repeat(20000) }] };
  const expanded = await h.run(body, undefined, p => ({ ...p as typeof body, max_tokens: 90001 }));
  assert.equal(expanded.stopReason, "error");
  assert.match(expanded.errorMessage ?? "", /native serialized ceiling/);
  const grown = await h.run(body, undefined, p => ({ ...p as typeof body, metadata: { text: "z".repeat(400000) } }));
  assert.equal(grown.stopReason, "error");
  assert.match(grown.errorMessage ?? "", /remaining context/);
  assert.equal(h.sent.length, 0);
});

for (const thinking of [
  { thinking: { budget_tokens: 1 } },
  ...["thinking_budget", "thinking_token_budget", "thinking_budget_tokens"].flatMap(key => [{ [key]: 1 }, { thinking: { [key]: 1 } }]),
  ...["root", "config", "generationConfig"].map(key => key === "root" ? { thinkingConfig: { thinkingBudget: 1 } } : { [key]: { thinkingConfig: { thinkingBudget: 1 } } }),
]) test(`positive coupled thinking budget skips clamp: ${JSON.stringify(thinking)}`, async t => {
  const h = await harness(t);
  const body = { max_tokens: 90000, messages: [{ role: "user", content: "x".repeat(20000) }], ...thinking };
  assert.equal((await h.run(body)).stopReason, "stop");
  assert.equal(h.sent[0], body);
  assert.equal(h.observations.at(-1)?.outputCapTokens, 90000);
});

test("true full-context and below-floor conservative headroom leave native cap untouched without local CAPACITY", async t => {
  const h = await harness(t);
  for (const length of [76000, 110000]) {
    const body = { max_tokens: 90000, messages: [{ role: "user", content: "x".repeat(length) }] };
    assert.equal((await h.run(body)).stopReason, "stop");
    assert.equal(h.sent.at(-1), body);
    assert.equal(h.observations.at(-1)?.outcome, "delegate");
  }
});

test("matching receipt never re-charges a huge measured prefix", async t => {
  const h = await harness(t);
  const prefix = { role: "user" as const, content: "x".repeat(80000), timestamp: 1 };
  const first = await h.run({ max_tokens: 90000, messages: [prefix] }, [prefix]);
  const tail = { role: "user" as const, content: "tiny", timestamp: 2 };
  const body = { max_tokens: 80000, messages: [prefix, first, tail] };
  await h.run(body, [prefix, first, tail]);
  assert.equal(h.observations.at(-1)?.estimateReason, "matching-receipt");
  assert.equal(h.sent.at(-1), body, "observed 12004 + tiny delta fits; serialized prefix is already measured");
});

test("matched receipt charges only trailing characters when mitigation needs a clamp", async t => {
  const h = await harness(t);
  const prefix = { role: "user" as const, content: "x".repeat(20000), timestamp: 1 };
  const first = await h.run({ max_tokens: 90000, messages: [prefix] }, [prefix]);
  const tail = { role: "user" as const, content: "z".repeat(48000), timestamp: 2 };
  await h.run({ max_tokens: 80000, messages: [prefix, first, tail] }, [prefix, first, tail]);
  assert.equal(h.observations.at(-1)?.estimateReason, "matching-receipt");
  const state = outputCapState(h.sent.at(-1));
  assert(state.kind === "value" && state.value > 39000 && state.value < 40000, JSON.stringify(state));
});

test("uncapped routes and missing cap states leave payloads untouched", async t => {
  for (const api of ["openai-codex-responses", "openai-completions"] as const) {
    const h = await harness(t, api);
    const body = { input: [{ role: "user", content: "x".repeat(20000) }] };
    assert.equal((await h.run(body)).stopReason, "stop");
    assert.equal(h.sent.at(-1), body);
    assert.equal(h.observations.at(-1)?.outputCapTokens, null);
  }
});

test("route omission distinguishes Anthropic subscription from Responses and shares serializer floors", () => {
  const registry = { isUsingOAuth: () => true, getProvider: () => ({ auth: { oauth: { isSubscription: true } } }) } as unknown as Parameters<typeof omitsRouteOutputCap>[1];
  for (const [api, omitted, floor] of [["anthropic-messages", false, 1], ["openai-responses", true, 16], ["azure-openai-responses", false, 16], ["openai-codex-responses", true, 1]] as const) {
    const model = { api } as Model<Api>;
    assert.equal(omitsRouteOutputCap(model, registry), omitted);
    assert.equal(outputFloor(model), floor);
  }
});
