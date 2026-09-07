import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { ModelRegistry, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { EngineError } from "../../src/engine/validation.js";
import { SYNTHETIC_LAST_USER_APPEND } from "../../src/live/append.js";
import {
  applyLastUserTextAppend, authorizePayload, canonicalJson, classifyPayloadChange, jsonView, lastUserTextAppend, payloadMode,
} from "../../src/pi/payload.js";
import { model } from "../engine/fixtures.js";
import { fixture } from "./fixtures.js";

const DASEIN_INJECTOR = "/Users/tefx/Projects/dasein-pi-extension/src/core/provider-payload-injector.ts";
const SYNTHETIC = SYNTHETIC_LAST_USER_APPEND;

type DaseinInjector = { injectAmbientProviderPayload: (input: { payload: unknown; content: string }) => { changed: boolean; payload: unknown } };

async function loadDaseinInjector(): Promise<DaseinInjector | undefined> {
  if (!existsSync(DASEIN_INJECTOR)) return undefined;
  return await import(pathToFileURL(DASEIN_INJECTOR).href) as DaseinInjector;
}

function authorize(before: unknown, after: unknown, extra: Partial<Parameters<typeof authorizePayload>[0]> = {}) {
  const beforeView = jsonView(before);
  const afterView = jsonView(after);
  const delta = classifyPayloadChange(beforeView, afterView, payloadMode(beforeView, afterView, after, before));
  authorizePayload({
    model, delta, before, after, inputTokens: 10, inputLimit: 8000, authorizedOutput: 8192, ...extra,
  });
  return delta;
}

function responsesSSE(modelId: string, text: string) {
  const item = { type: "message", id: "msg-1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: "response-1", model: modelId, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "response-1", model: modelId, status: "completed", output: [item], usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ];
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

async function nativeAppend(t: { after: (fn: () => Promise<void> | void) => void }, inject: (payload: unknown) => unknown) {
  let sends = 0;
  const bodies: Record<string, unknown>[] = [];
  const admissions: Array<{ outcome?: string; code?: string; payload?: { mode?: string; categories?: string[]; transform?: string } }> = [];
  const openai = openaiProvider();
  const catalog = openai.getModels().find(m => m.id === "gpt-4.1");
  assert(catalog);
  const transport: typeof fetch = async (resource, init) => {
    sends++;
    bodies.push(await new Request(resource, init).json() as Record<string, unknown>);
    return responsesSSE(catalog.id, "Controlled native response.");
  };
  const bound = { apiKey: "offline-fixture-key", fetch: transport, maxRetries: 0 as const };
  const wrapped: Provider = {
    ...openai,
    streamSimple: (m, context, options) => openai.streamSimple(m as Model<"openai-responses">, context, { ...options, ...bound }),
    stream: (m, context, options) => openai.stream(m as Model<"openai-responses">, context, { ...options, ...bound } as Parameters<typeof openai.stream>[2]),
  };
  const extras: InlineExtension[] = [
    { name: "watch-admission", factory(pi) { pi.events.on("nunc:admission", (value: unknown) => admissions.push(value as typeof admissions[number])); } },
    { name: "append", factory(pi) { pi.on("before_provider_request", event => inject(event.payload)); } },
  ];
  const f = await fixture({ config: { budget: { inputLimit: 8000 } }, extras });
  t.after(() => f.close());
  new ModelRegistry(f.modelRuntime).registerProvider(wrapped);
  await f.modelRuntime.setRuntimeApiKey("openai", "offline-fixture-key");
  await f.runtime.session.setModel(catalog);
  await f.runtime.session.prompt("Native last-user append request");
  return { f, catalog, sends: () => sends, bodies, admissions };
}

test("last-user append wraps Completions string content and Responses array prefix", () => {
  const completions = { model: "engine-test", stream: true, max_tokens: 16, messages: [{ role: "system", content: "sys" }, { role: "user", content: "ask" }] };
  const wrapped = applyLastUserTextAppend(completions, SYNTHETIC);
  assert.equal(wrapped.changed, true);
  assert.deepEqual((wrapped.payload as { messages: unknown[] }).messages[0], { role: "system", content: "sys" });
  assert.deepEqual((wrapped.payload as { messages: { content: unknown }[] }).messages[1]?.content, [
    { type: "text", text: "ask" }, { type: "text", text: SYNTHETIC },
  ]);
  assert.equal(lastUserTextAppend(jsonView(completions), jsonView(wrapped.payload)).ok, true);

  const responses = {
    model: "engine-test", stream: true, max_output_tokens: 16,
    input: [
      { role: "user", content: [{ type: "input_text", text: "first" }, { type: "input_text", text: "second" }] },
      { type: "function_call", call_id: "c1", name: "read", arguments: "{}" },
      { role: "user", content: [{ type: "input_text", text: "latest" }, { type: "input_image", image_url: "https://invalid.example/x.png" }] },
    ],
    tools: [{ type: "function", name: "read" }],
  };
  const added = applyLastUserTextAppend(responses, SYNTHETIC);
  assert.equal(added.changed, true);
  const after = added.payload as { input: Array<{ content?: unknown }>; tools: unknown };
  assert.deepEqual(after.input[0], responses.input[0]);
  assert.deepEqual(after.input[1], responses.input[1]);
  assert.deepEqual(after.tools, responses.tools);
  assert.deepEqual(after.input[2]?.content, [
    { type: "input_text", text: "latest" },
    { type: "input_image", image_url: "https://invalid.example/x.png" },
    { type: "input_text", text: SYNTHETIC },
  ]);
  const delta = authorize(responses, added.payload);
  assert(delta.categories.includes("input"));
  assert.equal(delta.imagesAdded, 0);
});

test("unvalidated last-user rewrite, reorder, netting, media replace and tool change stay rejected", () => {
  const before = {
    model: "engine-test", stream: true, max_tokens: 16,
    messages: [
      { role: "user", content: "keep" },
      { role: "user", content: [{ type: "text", text: "latest" }, { type: "image_url", image_url: { url: "https://invalid.example/a.png" } }] },
    ],
    tools: [{ type: "function", name: "read" }],
  };
  const replace = structuredClone(before);
  replace.messages[1] = { role: "user", content: "rewritten" };
  assert.equal(lastUserTextAppend(jsonView(before), jsonView(replace)).ok, false);
  assert.throws(() => authorize(before, replace), EngineError);

  const reorder = { ...before, messages: [before.messages[1], before.messages[0]] };
  assert.throws(() => authorize(before, reorder), EngineError);

  const netted = { ...before, messages: [{ role: "user", content: [{ type: "text", text: "keep" }, { type: "text", text: "latest" }, { type: "text", text: SYNTHETIC }] }] };
  assert.throws(() => authorize(before, netted), EngineError);

  const media = applyLastUserTextAppend(before, SYNTHETIC);
  assert.equal(media.changed, true);
  const replacedMedia = structuredClone(media.payload) as typeof before;
  const last = replacedMedia.messages[1] as { content: Array<{ type?: string; image_url?: { url: string } }> };
  last.content[1] = { type: "image_url", image_url: { url: "https://invalid.example/b.png" } };
  assert.throws(() => authorize(before, replacedMedia), EngineError);

  const tools = applyLastUserTextAppend(before, SYNTHETIC);
  const changedTools = { ...(tools.payload as typeof before), tools: [{ type: "function", name: "write" }] };
  assert.throws(() => authorize(before, changedTools), /unvalidated payload input,tools/);
});

test("append charges remaining input and post-native-clamp window occupancy", () => {
  const before = { model: "engine-test", stream: true, max_tokens: 800, messages: [{ role: "user", content: "hi" }] };
  const after = applyLastUserTextAppend(before, "x".repeat(400));
  assert.equal(after.changed, true);
  assert.throws(() => authorize(before, after.payload, { inputTokens: 7900, inputLimit: 8000 }), /CAPACITY|remaining safe input/);
  const tight = { ...model, contextWindow: 1000, maxTokens: 900 };
  assert.throws(() => authorize(before, after.payload, { model: tight, inputTokens: 200, inputLimit: 800, authorizedOutput: 900 }), /after native output clamp/);
  authorize(before, applyLastUserTextAppend(before, SYNTHETIC).payload);
});

test("tracked last-user append matches the read-only Dasein injector on synthetic payloads", async t => {
  const dasein = await loadDaseinInjector();
  if (!dasein) { t.skip("Dasein injector source is not present"); return; }
  const cases: unknown[] = [
    { model: "m", stream: true, messages: [{ role: "user", content: "ask" }] },
    { model: "m", stream: true, messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] },
    { model: "m", stream: true, input: [{ role: "user", content: "ask" }] },
    { model: "m", stream: true, input: [{ role: "assistant", content: "no" }] },
    { model: "m", stream: true, input: [{ role: "user", content: "" }] },
    { model: "m", stream: true },
  ];
  for (const payload of cases) {
    const ours = applyLastUserTextAppend(payload, SYNTHETIC);
    const theirs = dasein.injectAmbientProviderPayload({ payload, content: SYNTHETIC });
    assert.equal(ours.changed, theirs.changed, canonicalJson(payload));
    assert.equal(canonicalJson(ours.payload), canonicalJson(theirs.payload), canonicalJson(payload));
  }
});

test("stock loader last-user append reaches Responses HTTP; original text and tools stay", { timeout: 90000 }, async t => {
  const run = await nativeAppend(t, payload => {
    const result = applyLastUserTextAppend(payload, SYNTHETIC);
    return result.changed ? result.payload : undefined;
  });
  assert.equal(run.sends(), 1);
  const input = run.bodies[0]?.input;
  assert(Array.isArray(input));
  const lastUser = [...input].reverse().find((item): item is { role: string; content: Array<{ type?: string; text?: string }> } =>
    !!item && typeof item === "object" && (item as { role?: unknown }).role === "user");
  assert(lastUser);
  assert.equal(lastUser.content.at(-1)?.type, "input_text");
  assert.equal(lastUser.content.at(-1)?.text, SYNTHETIC);
  assert(lastUser.content.some(part => part.type === "input_text" && part.text?.includes("Native last-user append request")));
  assert(run.admissions.some(a => a.outcome === "delegate" && a.payload?.transform === "last-user-text-append"));
  assert.doesNotMatch(JSON.stringify(run.admissions), new RegExp(SYNTHETIC));
});

test("real Dasein injector last-user append reaches Responses HTTP", { timeout: 90000 }, async t => {
  const dasein = await loadDaseinInjector();
  if (!dasein) { t.skip("Dasein injector source is not present"); return; }
  const run = await nativeAppend(t, payload => {
    const result = dasein.injectAmbientProviderPayload({ payload, content: SYNTHETIC });
    return result.changed ? result.payload : undefined;
  });
  assert.equal(run.sends(), 1);
  const input = run.bodies[0]?.input;
  assert(Array.isArray(input));
  const lastUser = [...input].reverse().find((item): item is { content: Array<{ text?: string }> } =>
    !!item && typeof item === "object" && (item as { role?: unknown }).role === "user");
  assert.equal(lastUser?.content.at(-1)?.text, SYNTHETIC);
});
