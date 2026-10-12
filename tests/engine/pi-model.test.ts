import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxProvider, getCurrentTools, InMemoryCredentialStore, type OpenAICompletionsOptions } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, convertToLlm } from "@earendil-works/pi-coding-agent";
import { maintain, memoryMessage, piComplete, renderMemory } from "pi-nunc/engine";
import { semanticEvidence } from "../../src/live/scenarios.js";
import { input, noChange, sourceRecords } from "./fixtures.js";

test("maintenance forwards selected thinking through real native OpenRouter Completions serialization", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openrouter", async () => ({ type: "api_key", key: "offline-fixture-key" }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const base = runtime.getProvider("openrouter");
  const catalog = runtime.getModel("openrouter", "openai/gpt-6.1-sol");
  assert(base && catalog);
  const bodies: Array<Record<string, unknown>> = [];
  const registry = new ModelRegistry(runtime);
  registry.registerProvider({ ...base, stream: (model, context, options) => base.stream<"openai-completions">({ ...model, api: "openai-completions" }, context, {
    ...options,
    fetch: async (resource, init) => {
      const request = new Request(resource, init);
      assert.equal(request.url, "https://openrouter.ai/api/v1/chat/completions");
      const body = await request.json() as Record<string, unknown>;
      bodies.push(body);
      const chunks = [
        { id: "controlled", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: JSON.stringify(noChange) }, finish_reason: null }] },
        { id: "controlled", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
      ];
      return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    },
  } as OpenAICompletionsOptions) });
  // Provider.stream is generic across APIs; this fixture delegates only its asserted Completions route.
  assert.equal(catalog.api, "openai-completions");
  const source = await input(); source.model = { ...catalog, contextWindow: 60000 };
  const result = await maintain(source, piComplete(registry, "medium"));
  assert(result.ok, result.ok ? "" : result.message);
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0]!.reasoning, { effort: "medium" });
  assert.equal(bodies[0]!.max_completion_tokens, source.config.extraction.outputTokens);
  const context = { messages: [{ role: "user" as const, content: "Cleanup continuation", timestamp: 1 }] };
  await piComplete(registry, "low")({ model: source.model, context, outputTokens: 128, signal: source.signal });
  assert.deepEqual(bodies[1]!.reasoning, { effort: "low" });
  await assert.rejects(async () => piComplete(registry, "off")({ model: source.model, context, outputTokens: 128, signal: source.signal }), /unsupported/);
  const offSupported = { ...source.model, thinkingLevelMap: { ...source.model.thinkingLevelMap, off: "none" } };
  await piComplete(registry, "off")({ model: offSupported, context, outputTokens: 128, signal: source.signal });
  assert.deepEqual(bodies[2]!.reasoning, { effort: "none" });
  await piComplete(registry)({ model: source.model, context, outputTokens: 128, signal: source.signal });
  assert.equal(bodies[3]!.reasoning, undefined);
  await assert.rejects(async () => piComplete(registry, "minimal")({ model: source.model, context, outputTokens: 128, signal: source.signal }), /unsupported/);
  assert.equal(bodies.length, 4, "Unsupported level must fail before dispatch");
});

test("public package export -> engine -> piComplete -> real Pi registry/runtime -> controlled pi-ai provider", async () => {
  const faux = fauxProvider({ provider: "nunc-engine-fixture", models: [{ id: "fixture-model", contextWindow: 60000, maxTokens: 8192 }] });
  // Explicit in-memory stores and no models file/catalog refresh: never use daily auth/config.
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  registry.registerProvider(faux.provider);
  const source = await input(); source.model = faux.getModel();
  faux.setResponses([(context, options, _state, model) => {
    assert.equal(model.id, source.model.id);
    assert.deepEqual(sourceRecords(context).flatMap(r => r.messages), source.active.flatMap(e => e.messages).map(semanticEvidence));
    assert.deepEqual(getCurrentTools(context.messages), []);
    assert.equal(options?.signal, source.signal);
    assert.equal(options?.maxTokens, source.config.extraction.outputTokens);
    assert.equal(options?.cacheRetention, "none"); assert.equal(options?.maxRetries, 0);
    assert.equal(options?.transport, "sse"); assert(options?.sessionId);
    return fauxAssistantMessage(JSON.stringify(noChange));
  }]);
  const result = await maintain(source, piComplete(registry));
  assert(result.ok, result.ok ? "" : `${result.message}: ${String(result.cause)}`);
  assert.equal(faux.state.callCount, 1);
  assert.equal(result.observations.requests, 1);
  assert(result.observations.usage.contextInput! > 0);
  // Exercise the host projection used in budgeting, without claiming loader/persistence coverage.
  assert.deepEqual(memoryMessage(result.candidate.memory.slots), convertToLlm([{ role: "user", content: [{ type: "text", text: renderMemory(result.candidate.memory.slots) }], timestamp: 0 } as any])[0]);
});

test("public complete keeps transformHeaders; piComplete does not inherit SDK-only header hooks", async () => {
  const faux = fauxProvider({ provider: "nunc-header-fixture", models: [{ id: "fixture-model", contextWindow: 60000, maxTokens: 8192 }] });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  registry.registerProvider(faux.provider);
  const headerSeen: Array<string | null> = [];
  faux.setResponses(Array.from({ length: 2 }, () => (_c, o) => {
    headerSeen.push(o?.headers?.["x-synthetic-required"] ?? null);
    return fauxAssistantMessage("Synthetic answer");
  }));
  const model = faux.getModel();
  const context = { messages: [{ role: "user" as const, content: "Synthetic question", timestamp: 1 }] };
  const hooked = await runtime.complete(model, context, { maxTokens: 128, transformHeaders: async headers => ({ ...headers, "x-synthetic-required": "present" }) });
  assert.equal(hooked.stopReason, "stop", hooked.errorMessage ?? "");
  const maintenance = await piComplete(registry)({ model, context, signal: new AbortController().signal, outputTokens: 128 });
  assert(maintenance && typeof maintenance === "object" && "stopReason" in maintenance);
  assert.equal(maintenance.stopReason, "stop");
  assert.deepEqual(headerSeen, ["present", null]);
});
