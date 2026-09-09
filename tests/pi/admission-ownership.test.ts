import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, type Context } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Admission } from "../../src/pi/admission.js";
import { engineConfig } from "../../src/pi/config.js";

async function env() {
  const faux = fauxProvider({ api: "openai-completions", provider: "synthetic-review", models: [{ id: "synthetic", contextWindow: 60000, maxTokens: 8192 }] });
  faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("synthetic answer")));
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  registry.registerProvider(faux.provider);
  const model = faux.getModel();
  const observations: Array<{ kind?: string; outcome?: string; code?: string }> = [];
  const signal = new AbortController().signal;
  const ctx = {
    model,
    signal,
    sessionManager: { getSessionId: () => "synthetic-session" },
    modelRegistry: registry,
  } as unknown as ExtensionContext;
  const admission = new Admission({
    registerProvider(...args: Parameters<ModelRegistry["registerProvider"]>) { registry.registerProvider(...args); },
    unregisterProvider(id: string) { registry.unregisterProvider(id); },
    events: { emit(_name: string, value: unknown) { observations.push(value as { kind?: string; outcome?: string; code?: string }); } },
  } as unknown as ExtensionAPI, () => engineConfig({ budget: { inputLimit: 2000, safetyTokens: 100 } }, model, { reserveTokens: 36000, keepRecentTokens: 1 }));
  admission.ensure(ctx);
  const held = registry.getProvider(model.provider);
  assert(held);
  const options = { signal, sessionId: "synthetic-session" };
  const context: Context = { messages: [{ role: "user", content: "short synthetic input", timestamp: 1 }] };
  const huge: Context = { messages: [{ role: "user", content: "x".repeat(16000), timestamp: 1 }] };
  const rewrap = () => {
    registry.registerProvider({
      ...held,
      streamSimple: (m, c, o) => held.streamSimple(m, c, o),
      stream: (m, c, o) => held.stream(m, c, o),
    });
    admission.ensure(ctx);
    return registry.getProvider(model.provider);
  };
  return { faux, runtime, registry, model, ctx, admission, held, options, context, huge, observations, rewrap };
}

test("held older wrapper still applies capacity; inner wrap on the live chain still sends", async () => {
  const e = await env();
  const latest = e.rewrap();
  assert(latest);
  const ok = await latest.streamSimple(e.model, e.context, e.options).result();
  assert.equal(ok.stopReason, "stop", ok.errorMessage ?? "");
  const guarded = await latest.streamSimple(e.model, e.huge, e.options).result();
  assert.equal(guarded.stopReason, "error");
  assert.match(guarded.errorMessage ?? "", /exceeds main input limit/);
  const held = await e.held.streamSimple(e.model, e.huge, e.options).result();
  assert.equal(held.stopReason, "error");
  assert.match(held.errorMessage ?? "", /Provider changed after request preparation|exceeds main input limit/);
  assert.equal(e.faux.state.callCount, 1);
});

test("prepareRequest header await wrap does not skip admission on the captured wrapper", async () => {
  const e = await env();
  const before = e.faux.state.callCount;
  const escaped = await e.runtime.streamSimple(e.model, e.huge, {
    ...e.options,
    transformHeaders: async headers => {
      e.rewrap();
      return headers;
    },
  }).result();
  assert.equal(escaped.stopReason, "error", escaped.errorMessage ?? "");
  assert.equal(e.faux.state.callCount, before);
  assert(e.observations.some(o => o.outcome === "reject"));
});

test("maintenance same-Context replay via a held older wrapper cannot consume a second extraction", async () => {
  const e = await env();
  const latest = e.rewrap();
  assert(latest);
  let statuses: string[] | undefined;
  await e.admission.complete(async request => {
    const options = { signal: request.signal, maxTokens: request.outputTokens };
    const first = await latest.stream(e.model, request.context, options).result();
    const guarded = await latest.stream(e.model, request.context, options).result();
    const held = await e.held.stream(e.model, request.context, options).result();
    statuses = [first.stopReason, guarded.stopReason, held.stopReason];
    assert.match(guarded.errorMessage ?? "", /already used or changed binding/);
    assert.equal(held.stopReason, "error");
    return first;
  })({ model: e.model, context: e.context, signal: e.options.signal, outputTokens: 128 });
  assert.deepEqual(statuses, ["stop", "error", "error"]);
  assert.equal(e.faux.state.callCount, 1);
});

test("held older wrapper replay from inside the native callback cannot send twice", async () => {
  const e = await env();
  const latest = e.rewrap();
  assert(latest);
  let replay: string | undefined;
  await e.admission.complete(async request => {
    const options = { signal: request.signal, maxTokens: request.outputTokens };
    e.faux.setResponses([async () => {
      const nested = await e.held.stream(e.model, request.context, options).result();
      replay = nested.stopReason;
      return fauxAssistantMessage("synthetic answer");
    }]);
    return latest.stream(e.model, request.context, options).result();
  })({ model: e.model, context: e.context, signal: e.options.signal, outputTokens: 128 });
  assert.equal(replay, "error");
  assert.equal(e.faux.state.callCount, 1);
});

test("held older wrapper oversize from inside the native callback still runs main admission", async () => {
  const e = await env();
  const latest = e.rewrap();
  assert(latest);
  let nested: string | undefined;
  let nestedMessage: string | undefined;
  e.faux.setResponses([async () => {
    const extra = await e.held.streamSimple(e.model, e.huge, e.options).result();
    nested = extra.stopReason;
    nestedMessage = extra.errorMessage;
    return fauxAssistantMessage("synthetic answer");
  }]);
  const first = await latest.streamSimple(e.model, e.context, e.options).result();
  assert.equal(first.stopReason, "stop", first.errorMessage ?? "");
  assert.equal(nested, "error");
  assert.match(nestedMessage ?? "", /exceeds main input limit|Provider changed after request preparation/);
  assert.equal(e.faux.state.callCount, 1);
});

test("repeated same-length completed calls keep a bounded receipt and bind the actual response", async () => {
  const e = await env();
  const provider = e.registry.getProvider(e.model.provider);
  assert(provider);
  let completed = await provider.streamSimple(e.model, e.context, e.options).result();
  assert.equal(completed.stopReason, "stop", completed.errorMessage ?? "");
  for (let i = 0; i < 11; i++) {
    completed = await provider.streamSimple(e.model, e.context, e.options).result();
    assert.equal(completed.stopReason, "stop", completed.errorMessage ?? "");
  }
  await Promise.resolve();
  e.observations.length = 0;
  const follow: Context = { messages: [e.context.messages[0]!, completed, { role: "user", content: "next synthetic turn", timestamp: 2 }] };
  const next = await provider.streamSimple(e.model, follow, e.options).result();
  assert.equal(next.stopReason, "stop", next.errorMessage ?? "");
  const reused = e.observations.filter(o => o.kind === "main").at(-1) as { estimator?: string } | undefined;
  assert.equal(reused?.estimator, "pi-usage-backed");
  e.admission.invalidateUsage();
  e.observations.length = 0;
  const after = await provider.streamSimple(e.model, follow, e.options).result();
  assert.equal(after.stopReason, "stop", after.errorMessage ?? "");
  const fresh = e.observations.filter(o => o.kind === "main").at(-1) as { estimator?: string } | undefined;
  assert.equal(fresh?.estimator, "pi-heuristic");
  e.admission.close(e.ctx);
});

test("after close, leftover wrappers stay transparent; a different signal stays independent", async () => {
  const e = await env();
  const latest = e.rewrap();
  assert(latest);
  const independent = await latest.streamSimple(e.model, e.huge, { ...e.options, signal: AbortSignal.any([e.options.signal]) }).result();
  assert.equal(independent.stopReason, "stop");
  assert.equal(e.observations[0]?.kind, "unknown");
  e.admission.close(e.ctx);
  Object.defineProperty(e.ctx, "signal", { get: () => { throw new Error("stale ctx access"); } });
  const after = await latest.streamSimple(e.model, e.context, e.options).result();
  assert.equal(after.stopReason, "stop", after.errorMessage ?? "");
});
