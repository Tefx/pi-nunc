import { test } from "node:test";
import assert from "node:assert/strict";
import type { Api, Context, Model, Provider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { ModelRegistry, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { EngineError } from "../../src/engine/validation.js";
import { SYNTHETIC_LAST_USER_APPEND } from "../../src/live/append.js";
import { SYNTHETIC_LAST_USER_APPEND_B } from "../../src/live/append-b.js";
import {
  applyLastUserTextAppend, authorizePayload, classifyPayloadChange, jsonView, lastUserTextAppend, payloadMode,
} from "../../src/pi/payload.js";
import { model } from "../engine/fixtures.js";
import { fixture } from "./fixtures.js";

const SYNTHETIC = SYNTHETIC_LAST_USER_APPEND;
const SYNTHETIC_B = SYNTHETIC_LAST_USER_APPEND_B;

function authorize(before: unknown, after: unknown, extra: Partial<Parameters<typeof authorizePayload>[0]> = {}) {
  const beforeView = jsonView(before);
  const afterView = jsonView(after);
  const delta = classifyPayloadChange(beforeView, afterView, payloadMode(beforeView, afterView, after, before));
  authorizePayload({
    model, delta, before, after, inputTokens: 10, inputLimit: 8000, authorizedOutput: 8192,
    context: extra.context ?? { messages: [] }, ...extra,
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

function completionsSSE(modelId: string, text: string) {
  const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const chunk = (delta: unknown, finish_reason: string | null = null) => frame({ id: "response-1", object: "chat.completion.chunk", created: 1, model: modelId, choices: [{ index: 0, delta, finish_reason }] });
  return new Response(
    chunk({ role: "assistant", content: "" }) + chunk({ content: text }) + chunk({}, "stop") +
    frame({ id: "response-1", object: "chat.completion.chunk", model: modelId, choices: [], usage: { prompt_tokens: 100, completion_tokens: 4, total_tokens: 104 } }) +
    "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function nativeCatalogAppend(t: { after: (fn: () => Promise<void> | void) => void }, args: {
  provider: Provider; catalog: Model<Api>; sse: (id: string, text: string) => Response; prompt: string;
  inject: (payload: unknown) => unknown; inputLimit?: number;
}) {
  let sends = 0;
  const bodies: Record<string, unknown>[] = [];
  const admissions: Array<{ outcome?: string; code?: string; payload?: { mode?: string; categories?: string[]; transform?: string } }> = [];
  const transport: typeof fetch = async (resource, init) => {
    sends++;
    bodies.push(await new Request(resource, init).json() as Record<string, unknown>);
    return args.sse(args.catalog.id, "Controlled native response.");
  };
  const bound = { apiKey: "offline-fixture-key", fetch: transport, maxRetries: 0 as const };
  const wrapped: Provider = {
    ...args.provider,
    streamSimple: (m, context, options) => args.provider.streamSimple(m as never, context, { ...options, ...bound } as never),
    stream: (m, context, options) => args.provider.stream(m as never, context, { ...options, ...bound } as never),
  };
  const extras: InlineExtension[] = [
    { name: "watch-admission", factory(pi) { pi.events.on("nunc:admission", (value: unknown) => admissions.push(value as typeof admissions[number])); } },
    { name: "append", factory(pi) { pi.on("before_provider_request", event => args.inject(event.payload)); } },
  ];
  const f = await fixture({ config: args.inputLimit === undefined ? {} : { budget: { inputLimit: args.inputLimit } }, extras });
  t.after(() => f.close());
  new ModelRegistry(f.modelRuntime).registerProvider(wrapped);
  await f.modelRuntime.setRuntimeApiKey(args.catalog.provider, "offline-fixture-key");
  await f.runtime.session.setModel(args.catalog);
  await f.runtime.session.prompt(args.prompt);
  return { f, catalog: args.catalog, sends: () => sends, bodies, admissions };
}

async function nativeAppend(t: { after: (fn: () => Promise<void> | void) => void }, inject: (payload: unknown) => unknown, second?: (payload: unknown) => unknown) {
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
  if (second) extras.push({ name: "append-b", factory(pi) { pi.on("before_provider_request", event => second(event.payload)); } });
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

  const twice = applyLastUserTextAppend(wrapped.payload, SYNTHETIC_B);
  assert.equal(twice.changed, true);
  assert.equal(lastUserTextAppend(jsonView(completions), jsonView(twice.payload)).ok, true);
  authorize(completions, twice.payload);
  const twiceContent = (twice.payload as { messages: { content: Array<{ text?: string }> }[] }).messages[1]?.content;
  assert.equal(twiceContent?.at(-2)?.text, SYNTHETIC);
  assert.equal(twiceContent?.at(-1)?.text, SYNTHETIC_B);
  const framed = { ...(twice.payload as Record<string, unknown>), metadata: { note: "y".repeat(50) } };
  authorize(completions, framed);
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

test("append charges Nunc input headroom separately from Pi estimateContextTokens occupancy", () => {
  const before = { model: "engine-test", stream: true, max_tokens: 800, messages: [{ role: "user", content: "hi" }] };
  const after = applyLastUserTextAppend(before, "x".repeat(400));
  assert.equal(after.changed, true);
  assert.throws(() => authorize(before, after.payload, { inputTokens: 7900, inputLimit: 8000 }), /remaining safe input/);

  const grok = { ...model, id: "grok-4.6", api: "openai-responses" as const, contextWindow: 500000, maxTokens: 500000 };
  const smallPrompt = "a".repeat(4000);
  const pContext: Context = { messages: [{ role: "user", content: smallPrompt, timestamp: 1 }] };
  assert.equal(estimateContextTokens(pContext).tokens, 1000);
  const pBefore = { model: grok.id, stream: true, max_output_tokens: 494904, input: [{ role: "user", content: smallPrompt }] };
  const pSmall = applyLastUserTextAppend(pBefore, "x".repeat(20));
  assert.equal(pSmall.changed, true);
  authorize(pBefore, pSmall.payload, { model: grok, context: pContext, inputTokens: 10000, inputLimit: 450000, authorizedOutput: grok.maxTokens });

  const prompt = `First task ${"a".repeat(80000)}`;
  const context: Context = { systemPrompt: "Perform the current task.", messages: [{ role: "user", content: prompt, timestamp: 1 }] };
  const occupied = estimateContextTokens(context).tokens;
  const cap = 475870;
  assert(occupied + cap < grok.contextWindow);
  const grokBefore = { model: grok.id, stream: true, max_output_tokens: cap, input: [{ role: "user", content: prompt }] };
  const grokSmall = applyLastUserTextAppend(grokBefore, SYNTHETIC);
  authorize(grokBefore, grokSmall.payload, { model: grok, context, inputTokens: 90000, inputLimit: 450000, authorizedOutput: grok.maxTokens });
  const grokHuge = applyLastUserTextAppend(grokBefore, "x".repeat(200000));
  assert.throws(() => authorize(grokBefore, grokHuge.payload, { model: grok, context, inputTokens: 90000, inputLimit: 450000, authorizedOutput: grok.maxTokens }), /after native output clamp/);

  const orGrok = { ...model, id: "x-ai/grok-4.6", api: "openai-completions" as const, contextWindow: 500000, maxTokens: 450000 };
  const orBefore = { model: orGrok.id, stream: true, max_tokens: 450000, messages: [{ role: "user", content: prompt }] };
  const orSmall = applyLastUserTextAppend(orBefore, SYNTHETIC);
  authorize(orBefore, orSmall.payload, { model: orGrok, context, inputTokens: 90000, inputLimit: 450000, authorizedOutput: orGrok.maxTokens });
  const orHuge = applyLastUserTextAppend(orBefore, "x".repeat(200000));
  assert.throws(() => authorize(orBefore, orHuge.payload, { model: orGrok, context, inputTokens: 90000, inputLimit: 450000, authorizedOutput: orGrok.maxTokens }), /after native output clamp/);
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

test("two last-user append hooks reach Responses HTTP with both suffix parts", { timeout: 90000 }, async t => {
  const run = await nativeAppend(
    t,
    payload => { const result = applyLastUserTextAppend(payload, SYNTHETIC); return result.changed ? result.payload : undefined; },
    payload => { const result = applyLastUserTextAppend(payload, SYNTHETIC_B); return result.changed ? result.payload : undefined; },
  );
  assert.equal(run.sends(), 1);
  const input = run.bodies[0]?.input;
  assert(Array.isArray(input));
  const lastUser = [...input].reverse().find((item): item is { content: Array<{ text?: string }> } =>
    !!item && typeof item === "object" && (item as { role?: unknown }).role === "user");
  assert.equal(lastUser?.content.at(-2)?.text, SYNTHETIC);
  assert.equal(lastUser?.content.at(-1)?.text, SYNTHETIC_B);
  assert(run.admissions.some(a => a.outcome === "delegate" && a.payload?.transform === "last-user-text-append"));
});

test("xai grok-4.6 80k last-user append reaches Responses HTTP; overlarge append is zero-send", { timeout: 90000 }, async t => {
  const xai = xaiProvider();
  const catalog = xai.getModels().find(m => m.id === "grok-4.6");
  assert(catalog && catalog.contextWindow === 500000 && catalog.maxTokens === 500000 && catalog.api === "openai-responses");
  const prompt = `First task ${"a".repeat(80000)}`;
  const small = await nativeCatalogAppend(t, {
    provider: xai, catalog, sse: responsesSSE, prompt,
    inject: payload => { const result = applyLastUserTextAppend(payload, SYNTHETIC); return result.changed ? result.payload : undefined; },
  });
  assert.equal(small.sends(), 1);
  const cap = small.bodies[0]?.max_output_tokens;
  assert.equal(typeof cap, "number");
  assert(Number(cap) > 400000 && Number(cap) < catalog.maxTokens);
  const input = small.bodies[0]?.input;
  assert(Array.isArray(input));
  const lastUser = [...input].reverse().find((item): item is { content: Array<{ text?: string }> } =>
    !!item && typeof item === "object" && (item as { role?: unknown }).role === "user");
  assert.equal(lastUser?.content.at(-1)?.text, SYNTHETIC);
  assert(small.admissions.some(a => a.outcome === "delegate" && a.payload?.transform === "last-user-text-append"));

  const huge = await nativeCatalogAppend(t, {
    provider: xai, catalog, sse: responsesSSE, prompt,
    inject: payload => { const result = applyLastUserTextAppend(payload, "x".repeat(200000)); return result.changed ? result.payload : undefined; },
  });
  assert.equal(huge.sends(), 0);
  assert(huge.admissions.some(a => a.outcome === "reject" && a.code === "CAPACITY" && a.payload?.transform === "last-user-text-append"));
  const last = huge.f.runtime.session.messages.at(-1);
  assert.equal(last?.role, "assistant");
  assert.match(last.role === "assistant" ? last.errorMessage ?? "" : "", /context_length_exceeded: Nunc local CAPACITY/);
  assert.doesNotMatch(JSON.stringify(huge.admissions), /x{20}/);
});

test("openrouter grok-4.6 80k last-user append reaches Completions HTTP; overlarge append is zero-send", { timeout: 90000 }, async t => {
  const openrouter = openrouterProvider();
  const catalog = openrouter.getModels().find(m => m.id === "x-ai/grok-4.6");
  assert(catalog && catalog.contextWindow === 500000 && catalog.maxTokens === 450000 && catalog.api === "openai-completions");
  const prompt = `First task ${"a".repeat(80000)}`;
  const small = await nativeCatalogAppend(t, {
    provider: openrouter, catalog, sse: completionsSSE, prompt,
    inject: payload => { const result = applyLastUserTextAppend(payload, SYNTHETIC); return result.changed ? result.payload : undefined; },
  });
  assert.equal(small.sends(), 1);
  const cap = small.bodies[0]?.max_tokens ?? small.bodies[0]?.max_completion_tokens;
  assert.equal(typeof cap, "number");
  assert(Number(cap) > 400000);
  const messages = small.bodies[0]?.messages;
  assert(Array.isArray(messages));
  const lastUser = [...messages].reverse().find((item): item is { content: unknown } =>
    !!item && typeof item === "object" && (item as { role?: unknown }).role === "user");
  const content = lastUser?.content;
  assert(Array.isArray(content));
  assert.equal((content.at(-1) as { text?: string }).text, SYNTHETIC);

  const huge = await nativeCatalogAppend(t, {
    provider: openrouter, catalog, sse: completionsSSE, prompt,
    inject: payload => { const result = applyLastUserTextAppend(payload, "x".repeat(200000)); return result.changed ? result.payload : undefined; },
  });
  assert.equal(huge.sends(), 0);
  assert(huge.admissions.some(a => a.outcome === "reject" && a.code === "CAPACITY"));
});
