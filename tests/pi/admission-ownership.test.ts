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
  const huge: Context = { messages: [{ role: "user", content: "x".repeat(4000), timestamp: 1 }] };
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
  assert.match(guarded.errorMessage ?? "", /exceeds safe input/);
  const held = await e.held.streamSimple(e.model, e.huge, e.options).result();
  assert.equal(held.stopReason, "error");
  assert.match(held.errorMessage ?? "", /Provider changed after request preparation|exceeds safe input/);
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
