import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryCredentialStore, fauxProvider, type Context } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { inputLimit } from "../../src/engine/accounting.js";
import { engineConfig } from "../../src/pi/config.js";
import { boundedProvider, BudgetLedger } from "../../src/live/budget.js";
import { parseInput, selectedModels } from "../../src/live/contract.js";
import { childEnvironment } from "../../src/live/host.js";
import { expandGeneratedText, loadScenario } from "../../src/live/scenarios.js";
import { fixture, nativeModels, repository } from "./fixtures.js";

const context: Context = { systemPrompt: "Use available evidence.", messages: [{ role: "user", content: "Inspect the pending work.", timestamp: 1 }] };

test("fictional OpenRouter Completions default and invoking-runtime switch resolve without a provider catalog", async () => {
  const input = await fixture(), profile = input.target.stateRoot + "-openrouter-profile";
  await mkdir(join(profile, "host"), { recursive: true });
  await mkdir(join(profile, "tmp"));
  const settings = { defaultProvider: "openrouter", defaultModel: "google/gemini-3.8-flash", defaultThinkingLevel: "medium", compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } };
  const settingsFile = join(profile, "host/settings.json");
  await writeFile(settingsFile, JSON.stringify(settings));
  await writeFile(join(profile, "host/auth.json"), "fictional-invalid-auth-never-resolved");
  const selection = { target: input.target, limits: { maxCalls: 20, maxTotalTokens: 8_000_000, maxCostUsd: 100, maxDurationMs: 120000 }, scenarios: [{ id: "c2" }], observations: ["stock_rpc"] };
  const env = childEnvironment(profile);
  const run = (value: unknown, extra: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [join(repository, "scripts/verify-live.mjs"), "--preflight"], { cwd: repository, env: { ...env, ...extra }, input: JSON.stringify(value), encoding: "utf8", timeout: 20000 });
  try {
    const resolved = run(selection); assert.equal(resolved.status, 0, resolved.stderr);
    const defaults = JSON.parse(resolved.stdout);
    assert.equal(defaults.effective.source, "standalone-defaults");
    assert.equal(defaults.models[0].provider, "openrouter");
    assert.equal(defaults.models[0].id, "google/gemini-3.8-flash");
    assert.equal(defaults.models[0].contextWindow, 1048576);
    assert.equal(defaults.models[0].maxTokens, 65536);
    assert.equal(defaults.limits.maxOutputTokens, 65536);
    const switched = run(selection, { PI_PROVIDER: "openrouter", PI_MODEL: "mistralai/mistral-nemo", PI_REASONING_LEVEL: "low" });
    assert.equal(switched.status, 0, switched.stderr);
    const current = JSON.parse(switched.stdout);
    assert.equal(current.effective.source, "invoking-runtime");
    assert.equal(current.models[0].id, "mistralai/mistral-nemo");
    assert.equal(current.models[0].contextWindow, 131072);
    assert.equal(current.models[0].maxTokens, 16384);
    assert(current.models[0].contextWindow < defaults.models[0].contextWindow);
    assert.notEqual(run(selection, { PI_MODEL: "mistralai/mistral-nemo" }).status, 0, "partial current context is rejected");
  } finally { await rm(profile, { recursive: true }); }
});

test("native metadata binds OpenRouter Completions and a strictly smaller same-provider switch", async () => {
  const [gemini, nemo] = await nativeModels({ provider: "openrouter", id: "google/gemini-3.8-flash" }, { provider: "openrouter", id: "mistralai/mistral-nemo" });
  assert(gemini && nemo); assert.equal(gemini.api, "openai-completions"); assert.equal(nemo.api, "openai-completions");
  assert(nemo.contextWindow < gemini.contextWindow);
  const input = await fixture();
  const authorize = (model: typeof gemini) => ({ provider: model.provider, id: model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens, baseUrl: model.baseUrl });
  input.models = [authorize(gemini)]; input.resolvedModels = [gemini];
  input.limits.maxOutputTokens = gemini.maxTokens;
  input.scenarios[0]!.config.compaction.reserveTokens = 16384;
  input.scenarios[0]!.config.compaction.keepRecentTokens = 20000;
  assert(input.scenarios[0]!.config.compaction.reserveTokens < gemini.maxTokens);
  assert.equal(selectedModels(input)[0]?.api, "openai-completions");
  input.models = [authorize(gemini), authorize(nemo)]; input.resolvedModels = [gemini, nemo];
  input.limits.maxOutputTokens = Math.max(gemini.maxTokens, nemo.maxTokens);
  input.scenarios[0]!.id = "c5";
  assert.doesNotThrow(() => parseInput(input));
  const selected = selectedModels(input);
  assert.equal(selected[0]?.id, gemini.id); assert.equal(selected[1]?.id, nemo.id);
  const swapped = structuredClone(input); swapped.models = [authorize(nemo), authorize(gemini)]; swapped.resolvedModels = [nemo, gemini];
  assert.throws(() => parseInput(swapped));
});

test("c4/capacity overflow is reachable on smaller native metadata without shrinking the source", async () => {
  const [gemini, nemo] = await nativeModels({ provider: "openrouter", id: "google/gemini-3.8-flash" }, { provider: "openrouter", id: "mistralai/mistral-nemo" });
  assert(gemini && nemo);
  const input = await fixture();
  const scenario = await loadScenario(repository, { ...input.scenarios[0]!, id: "c4", variant: "capacity" });
  const bytes = Buffer.byteLength(expandGeneratedText(scenario.input.generatedFiles![0]!));
  const compaction = { reserveTokens: 16384, keepRecentTokens: 1 };
  const geminiLimit = inputLimit(gemini, engineConfig({ extraction: { toolResults: "full" } }, gemini, compaction).extraction);
  const nemoLimit = inputLimit(nemo, engineConfig({ extraction: { toolResults: "full" } }, nemo, compaction).extraction);
  assert(bytes > nemoLimit, "named mistral-nemo window must be able to miss full extraction");
  assert(geminiLimit > nemoLimit);
  assert.equal(scenario.input.generatedFiles![0]!.segments.reduce((n, s) => n + s.repeat, 0), 6001);
});

test("native Completions serializer remains the bounded OpenRouter dispatch seam", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), refreshOnCreate: false, allowModelNetwork: false });
    const model = runtime.getModel("openrouter", "google/gemini-3.8-flash"); const base = runtime.getProvider("openrouter");
    assert(model && base);
    const ledger = new BudgetLedger(join(input.target.stateRoot, "calls.jsonl"), { ...input.limits, maxOutputTokens: model.maxTokens }, Date.now() + 10000, new AbortController().signal);
    let requests = 0, observed: { url?: string; body?: Record<string, unknown> } = {};
    const transport: typeof fetch = async (resource, init) => {
      const request = new Request(resource, init); requests++;
      observed = { url: request.url, body: await request.json() as Record<string, unknown> };
      return new Response(JSON.stringify({ error: { message: "Controlled rate-limit response", type: "rate_limit_error" } }), { status: 429, headers: { "content-type": "application/json" } });
    };
    const provider = boundedProvider(base, [model], ledger, { fetch: transport });
    const response = await provider.streamSimple(model, context, { maxTokens: 1000, apiKey: "offline-fixture-key" }).result();
    assert.equal(response.stopReason, "error"); assert.equal(requests, 1);
    assert.equal(observed.url, "https://openrouter.ai/api/v1/chat/completions");
    const body = observed.body ?? {};
    assert.equal(body.model, model.id); assert.equal(body.stream, true); assert.notEqual(body.background, true);
    const ceiling = body.max_tokens ?? body.max_completion_tokens;
    assert.equal(ceiling, 1000);
    assert.equal((await provider.streamSimple(model, context, { maxTokens: 1000, apiKey: "offline-fixture-key" }).result()).stopReason, "error");
    assert.equal(requests, 1);
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});

test("unknown native APIs fail closed before dispatch; Responses opt-out reserves the full ceiling", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const faux = fauxProvider({ provider: "nunc-live-controlled", models: [{ id: "test", contextWindow: 60000, maxTokens: 8192 }] }), model = faux.getModel();
    model.cost = { input: 10, output: 10, cacheRead: 5, cacheWrite: 20 };
    const ledger = new BudgetLedger(join(input.target.stateRoot, "calls.jsonl"), { ...input.limits, maxOutputTokens: 8192 }, Date.now() + 10000, new AbortController().signal);
    const unknown = { ...model, api: "fixture-unsupported-api" as typeof model.api };
    const blocked = boundedProvider(faux.provider, [unknown], ledger, { controlled: true });
    assert.equal((await blocked.streamSimple(unknown, context, { maxTokens: 1000 }).result()).stopReason, "error");
    assert.equal(faux.state.callCount, 0);
    const opted = { ...model, api: "openai-responses" as const, compat: { supportsMaxOutputTokens: false } };
    assert.throws(() => ledger.reserve(opted, context, 4096));
    const reserved = ledger.reserve(opted, context, opted.maxTokens);
    assert.equal(reserved.outputCeiling, opted.maxTokens);
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});
