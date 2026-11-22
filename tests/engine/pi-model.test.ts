import { test } from "node:test";
import { createServer } from "node:http";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import assert from "node:assert/strict";
import { setImmediate as flush } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider, getCurrentTools, InMemoryCredentialStore, type OpenAICompletionsOptions } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, convertToLlm } from "@earendil-works/pi-coding-agent";
import { maintain, memoryMessage, piComplete, renderMemory } from "pi-nunc/engine";
import { semanticEvidence } from "../../src/live/scenarios.js";
import { answer, input, noChange, sourceRecords } from "./fixtures.js";
import { maintenanceThinkingOptions, payloadThinking, rateLimited, retryMaintenanceComplete } from "../../src/engine/pi-model.js";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { clampThinkingBudgetToAnswerRoom, thinkingBudgetForLevel } from "@earendil-works/pi-ai/api/simple-options";
import { resolveGoogleThinkingLevel, toGoogleThinkingLevel, usesGoogleThinkingLevel } from "@earendil-works/pi-ai/api/google-shared";

test("native throttling cannot become persistent maintenance provider overflow", async () => {
  const source = await input();
  for (const errorMessage of ['{"code":429}', "status_code=429", "status:429", "RESOURCE_EXHAUSTED"]) {
    const result = await maintain(source, async () => ({ ...answer(), stopReason: "error", errorMessage: `${errorMessage}: context window exceeded` }));
    assert.equal(result.ok, false);
    assert.equal(result.observations.providerOverflow, undefined, errorMessage);
  }
});

const retryInput = input();
test("rate limits include native Google errors and exclude unrelated 429 quantities", () => {
  for (const message of ['{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}', '{"code" : 429}', "status_code=429", "status:429", "status 429", "RESOURCE_EXHAUSTED", "HTTP/2 429", "(429)"]) assert.equal(rateLimited(message), true, message);
  for (const message of ["4290", "processed 429 tokens", '{"code":400}', "status=4290"]) assert.equal(rateLimited(message), false, message);
});

for (const failure of ["stream ended before a terminal response event", "terminated", "Connection error", "ECONNREFUSED example.com:443", "ECONNREFUSED 127.0.0.1:443", "ECONNREFUSED [::1]:443", "Connection error :443", "Connection error (400 ms)", "Connection error (400.5 ms)", "Connection error (400.0 seconds)", "Connection error (403 requests)", "ECONNRESET: connection closed", "HTTP 429", "HTTP 503"]) {
  test(`bounded extraction retry recovers ${failure} with unchanged request`, async () => {
    const s = await retryInput;
    const request = { model: s.model, context: { messages: [] }, outputTokens: 4096, signal: s.signal };
    let attempts = 0;
    const response = await retryMaintenanceComplete(async actual => {
      assert.equal(actual, request);
      return ++attempts < 3 ? { ...answer(), stopReason: "error", errorMessage: failure } : answer();
    }, 0)(request);
    assert.deepEqual(response, answer());
    assert.equal(attempts, 3);
    attempts = 0;
    await retryMaintenanceComplete(async () => { attempts++; throw new Error(failure); }, 0)(request).then(
      () => assert.fail("exhausted throw must remain an error"), error => assert.equal(error.message, failure));
    assert.equal(attempts, 3);
  });
}
for (const failure of [
  { stopReason: "length", errorMessage: "terminated" },
  { stopReason: "stop", content: [{ type: "text", text: "invalid JSON" }] },
  { stopReason: "error", errorMessage: "400 context_length_exceeded: Connection error" },
  { stopReason: "error", errorMessage: "400 server error: input overflow" },
  ...['{"error":{"code":400,"message":"Connection error","status":"INVALID_ARGUMENT"}}',
    "HTTP:400 Connection error", "status:403 Connection error", "code:401 Connection error",
    "HTTP 403 requests forbidden; Connection error", "HTTP 401 bytes rejected; Connection error",
    "HTTP/1.1:401 Connection error", "HTTP/2 403 Connection error", "status: 401 bytes rejected; Connection error",
    "error code 403 requests forbidden; Connection error",
    ...["statusCode", "status_code", "errorCode", "error_code"].map(label => `${label}:400 Connection error`),
    "Nunc local Connection error", "billing Connection error"].map(errorMessage => ({ stopReason: "error", errorMessage })),
  { stopReason: "error", errorMessage: "429 insufficient_quota" },
  { stopReason: "aborted", errorMessage: "Connection error" },
]) test(`deterministic or cancelled extraction never retries: ${JSON.stringify(failure)}`, async () => {
  const s = await retryInput; let calls = 0;
  const response = { ...answer(), ...failure };
  assert.equal(await retryMaintenanceComplete(async () => { calls++; return response; }, 0)({
    model: s.model, context: { messages: [] }, outputTokens: 4096, signal: s.signal,
  }), response);
  assert.equal(calls, 1);
  if (failure.stopReason === "error") {
    calls = 0;
    await assert.rejects(retryMaintenanceComplete(async () => { calls++; throw new Error(failure.errorMessage); }, 0)({
      model: s.model, context: { messages: [] }, outputTokens: 4096, signal: s.signal,
    }));
    assert.equal(calls, 1, "thrown deterministic errors also remain terminal");
  }
});

test("native Google HTTP errors preserve physical-request retry boundaries", async () => {
  const provider = googleProvider();
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const catalog = new ModelRegistry(runtime).getAll().find(model => model.provider === "google");
  assert(catalog);
  let requests = 0;
  let status = 400;
  let interrupted = false;
  let quota = false;
  const server = createServer((req, res) => {
    requests++;
    req.resume();
    if (interrupted) { req.socket.destroy(); return; }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: status, message: quota ? "insufficient_quota Connection error" : "Connection error", status: "INVALID_ARGUMENT" } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const { compat: _compat, ...googleModel } = catalog;
    const model = { ...googleModel, baseUrl: `http://127.0.0.1:${address.port}` };
    for (const failure of ["400", "429", "503", "interruption", "quota"] as const) {
      interrupted = failure === "interruption";
      quota = failure === "quota";
      status = quota ? 429 : interrupted ? 200 : Number(failure);
      requests = 0;
      const response = await retryMaintenanceComplete(request => provider.stream({ ...model, api: "google-generative-ai" }, normalizeContext(request.context), {
        apiKey: "offline-fixture-key", maxRetries: 0, signal: request.signal, maxTokens: request.outputTokens,
      }).result(), 0)({ model, context: { messages: [{ role: "user", content: "Offline test", timestamp: 1 }] }, outputTokens: 128, signal: new AbortController().signal });
      assert(response && typeof response === "object" && "stopReason" in response);
      assert.equal(response.stopReason, "error");
      assert.equal(requests, failure === "400" || quota ? 1 : 3, `${failure}: physical requests with native provider retries disabled`);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("cancellation during retry backoff terminates without another transport", async t => {
  const s = await input(), controller = new AbortController(); let calls = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const complete = retryMaintenanceComplete(async () => {
    calls++;
    return { ...answer(), stopReason: "error", errorMessage: "terminated" };
  });
  const request = { model: s.model, context: { messages: [] }, outputTokens: 4096, signal: controller.signal };
  const pending = complete(request);
  await flush(); // First error has reached the abortable backoff timer.
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls, 1);
  await assert.rejects(complete(request), { name: "AbortError" });
  assert.equal(calls, 1, "already-cancelled calls never start transport");
});

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

test("maintenance native thinking serializes Anthropic adaptive/budget and Google level/budget controls", async () => {
  const credentials = new InMemoryCredentialStore();
  for (const provider of ["anthropic", "google", "google-vertex"]) await credentials.modify(provider, async () => ({ type: "api_key", key: "offline-fixture-key" }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  const catalog = registry.getAll();
  const models = [
    catalog.find(m => m.provider === "anthropic" && m.reasoning && m.compat && "forceAdaptiveThinking" in m.compat && m.compat.forceAdaptiveThinking === true),
    catalog.find(m => m.provider === "anthropic" && m.reasoning && (!m.compat || !("forceAdaptiveThinking" in m.compat) || !m.compat.forceAdaptiveThinking) && (!m.compat || !("supportsMidConvoEffort" in m.compat) || !m.compat.supportsMidConvoEffort)),
    catalog.find(m => m.provider === "google" && m.id.includes("gemini-3") && m.reasoning),
    catalog.find(m => m.provider === "google" && m.id.includes("2.5-pro") && m.reasoning),
    catalog.find(m => m.provider === "google-vertex" && m.id.includes("gemini-3") && m.reasoning),
  ];
  for (const model of models) {
    assert(model, "native catalog must supply every API thinking family");
    const base = runtime.getProvider(model.provider); assert(base);
    let captured: unknown;
    registry.registerProvider({ ...base, stream: (selected, context, options) => base.stream<import("@earendil-works/pi-ai").Api>(selected, context, {
      ...options,
      onPayload: async (payload, nativeModel) => {
        captured = await options?.onPayload?.(payload, nativeModel) ?? payload;
        throw new Error("Offline payload capture before transport");
      },
    }) });
    for (const level of ["low", "off"] as const) {
      captured = undefined;
      // Models that cannot disable thinking retain the explicit capability rejection.
      if (level === "off" && model.thinkingLevelMap?.off === null) continue;
      await piComplete(registry, level)({ model, context: { messages: [{ role: "user", content: "Offline serialization", timestamp: 1 }] }, outputTokens: 4096, signal: new AbortController().signal });
      assert(captured);
      const applied = payloadThinking(captured);
      assert(level === "off" ? applied === "off" || applied === 0 : typeof applied === "number" ? applied > 0 : applied === "low", `${model.api}/${model.id}: ${String(applied)}`);
    }
  }
});

test("loader-safe maintenance thinking translation matches native SDK mappings and budget boundaries", async () => {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const models = new ModelRegistry(runtime).getAll().filter(model => ["anthropic-messages", "google-generative-ai", "google-vertex"].includes(model.api));
  assert(models.length > 0);
  let budgetCases = 0, levelCases = 0;
  for (const model of models) for (const thinking of getSupportedThinkingLevels(model)) {
    if (thinking === "off") continue;
    if (model.api === "anthropic-messages") {
      for (const outputTokens of [512, 1024, 1025, 4096, 32768]) {
        assert.equal(maintenanceThinkingOptions(model, thinking, outputTokens).thinkingBudgetTokens,
          clampThinkingBudgetToAnswerRoom(thinkingBudgetForLevel(thinking), outputTokens), `${model.id}/${thinking}/${outputTokens}`);
        budgetCases++;
      }
    } else {
      const googleModel = model as import("@earendil-works/pi-ai").Model<"google-generative-ai" | "google-vertex">;
      const options = maintenanceThinkingOptions(model, thinking, 4096).thinking as { level?: string; budgetTokens?: number };
      if (usesGoogleThinkingLevel(googleModel)) {
        assert.equal(options.level, toGoogleThinkingLevel(resolveGoogleThinkingLevel(googleModel, thinking)), `${model.id}/${thinking}`);
        levelCases++;
      } else {
        assert.equal(options.level, undefined, model.id);
        assert.equal(typeof options.budgetTokens, "number");
      }
    }
  }
  assert(budgetCases > 0 && levelCases > 0, "exercise both raw-option families");
});

test("shared thinking detector honors native controls and trailing effort updates", () => {
  assert.equal(payloadThinking({ messages: [{ role: "system", output_config: { effort: "low" } }], thinking: { type: "adaptive" }, output_config: { effort: "high" } }), "low");
  assert.equal(payloadThinking({ thinking: { type: "disabled" }, output_config: { effort: "high" } }), "off");
  assert.equal(payloadThinking({ config: { thinkingConfig: { thinkingBudget: -1 } } }), -1);
  assert.equal(payloadThinking({ generationConfig: { thinkingConfig: { thinkingLevel: "LOW" } } }), "low");
  assert.equal(payloadThinking({ thinkingConfig: { thinkingBudget: 0 } }), 0);
  assert.equal(payloadThinking({}), undefined);
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
