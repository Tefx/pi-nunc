import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { ModelRegistry, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { authorizePayload, canonicalJson, classifyPayloadChange, jsonView, outputCapState, payloadMode, payloadOutputCeiling } from "../../src/pi/payload.js";
import { model } from "../engine/fixtures.js";
import { fixture } from "./fixtures.js";
function authPayload(args: Omit<Parameters<typeof authorizePayload>[0], "context">) {
  authorizePayload({ ...args, context: { messages: [] } });
}

class SdkParams {
  model = "engine-test";
  stream = true;
  max_tokens = 16;
  prompt_cache_key: string | undefined = undefined;
}

test("JSON bytes ignore prototypes, undefined keys and identity copies that deep equality rejects", () => {
  const instance = new SdkParams();
  const clone = structuredClone(instance);
  assert.notEqual(Object.getPrototypeOf(instance), Object.prototype);
  assert.equal(Object.getPrototypeOf(clone), Object.prototype);
  assert.equal(isDeepStrictEqual(clone, instance), false);
  assert.equal(canonicalJson(instance), canonicalJson({ model: "engine-test", stream: true, max_tokens: 16 }));
  const copy = JSON.parse(JSON.stringify(instance));
  assert.equal(canonicalJson(instance), canonicalJson(copy));
  assert.equal(payloadMode(jsonView(instance), jsonView(copy), copy, instance), "identity");
});

test("classify payload categories without reading bodies; metadata is not capacity", () => {
  const before = { model: "engine-test", stream: true, max_tokens: 16, messages: [{ role: "user", content: "a" }] };
  const meta = classifyPayloadChange(before, { ...before, temperature: 0 }, "replacement");
  assert.deepEqual(meta.categories, ["metadata"]);
  const output = classifyPayloadChange(before, { ...before, max_tokens: 32 }, "in-place");
  assert.deepEqual(output.categories, ["output"]);
  assert.equal(output.outputAfter, 32);
  const illegal = classifyPayloadChange(before, { ...before, model: "other", stream: false }, "replacement");
  assert(illegal.categories.includes("model") && illegal.categories.includes("stream"));
});

test("authorize allows metadata and identity; rejects overcap, non-stream, model change and input growth", () => {
  const base = { model: model.id, stream: true, max_tokens: 16, messages: [{ role: "user", content: "a" }] };
  const identity = classifyPayloadChange(base, jsonView(base), "identity");
  authPayload({ model, delta: identity, before: base, after: base, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens });
  const meta = classifyPayloadChange(base, { ...base, temperature: 0 }, "replacement");
  authPayload({ model, delta: meta, before: base, after: { ...base, temperature: 0 }, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens });
  const over = classifyPayloadChange(base, { ...base, max_tokens: model.maxTokens + 1 }, "replacement");
  assert.throws(() => authPayload({ model, delta: over, before: base, after: { ...base, max_tokens: model.maxTokens + 1 }, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens }), /native serialized ceiling|exceeds authorization/);
  const stream = classifyPayloadChange(base, { ...base, stream: false }, "replacement");
  assert.throws(() => authPayload({ model, delta: stream, before: base, after: { ...base, stream: false }, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens }), /stream field|non-streaming/);
  const renamed = classifyPayloadChange(base, { ...base, model: "outside-selection" }, "replacement");
  assert.throws(() => authPayload({ model, delta: renamed, before: base, after: { ...base, model: "outside-selection" }, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens }), /model field|payload model differs/);
  const extra = { ...base, extra: "n".repeat(2000) };
  assert.throws(() => authPayload({ model, delta: classifyPayloadChange(base, extra, "replacement"), before: base, after: extra, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens }), /unrecognized payload field/);
  const grown = { ...base, metadata: { note: "n".repeat(2000) } };
  const growth = classifyPayloadChange(base, grown, "replacement");
  assert.deepEqual(growth.categories, ["metadata"]);
  assert(growth.grewTokens > 0);
  assert.throws(() => authPayload({ model, delta: growth, before: base, after: grown, inputTokens: 900, inputLimit: 1000, authorizedOutput: model.maxTokens }), /input growth/);
});

test("payloadOutputCeiling reads Completions, Responses and Gemini generationConfig fields", () => {
  assert.equal(payloadOutputCeiling({ max_tokens: 8 }), 8);
  assert.equal(payloadOutputCeiling({ max_output_tokens: 9 }), 9);
  assert.equal(payloadOutputCeiling({ max_completion_tokens: 10 }), 10);
  assert.equal(payloadOutputCeiling({ generationConfig: { maxOutputTokens: 11 } }), 11);
  assert.equal(payloadOutputCeiling({ config: { maxOutputTokens: 12 } }), 12);
  assert.equal(payloadOutputCeiling({ stream: true }), undefined);
  assert.equal(outputCapState({ max_tokens: "16" }).kind, "invalid");
  assert.equal(outputCapState({ max_tokens: 16, max_output_tokens: 32 }).kind, "conflict");
});

test("Google nested config and Completions n are control, not metadata", () => {
  const google = { model: model.id, contents: [{ role: "user", parts: [{ text: "a" }] }], config: { maxOutputTokens: 128 } };
  const expanded = { ...google, config: { ...google.config, maxOutputTokens: 256 } };
  const output = classifyPayloadChange(google, expanded, "replacement");
  assert.deepEqual(output.categories, ["output"]);
  assert.equal(output.outputBefore, 128);
  assert.equal(output.outputAfter, 256);
  assert.throws(() => authPayload({ model, delta: output, before: google, after: expanded, inputTokens: 100, inputLimit: 1000, authorizedOutput: 128 }), /native serialized ceiling|exceeds authorization/);
  const system = { ...google, config: { ...google.config, systemInstruction: "rewrite" } };
  assert.throws(() => authPayload({ model, delta: classifyPayloadChange(google, system, "replacement"), before: google, after: system, inputTokens: 100, inputLimit: 1000, authorizedOutput: 128 }), /unvalidated payload input/);
  const tools = { ...google, config: { ...google.config, tools: [{ functionDeclarations: [{ name: "x" }] }] } };
  assert.throws(() => authPayload({ model, delta: classifyPayloadChange(google, tools, "replacement"), before: google, after: tools, inputTokens: 100, inputLimit: 1000, authorizedOutput: 128 }), /unvalidated payload tools/);
  const thinking = { ...google, config: { ...google.config, thinkingConfig: { thinkingBudget: 8 } } };
  assert.throws(() => authPayload({ model, delta: classifyPayloadChange(google, thinking, "replacement"), before: google, after: thinking, inputTokens: 100, inputLimit: 1000, authorizedOutput: 128 }), /unvalidated payload thinking/);
  const completions = { model: model.id, stream: true, max_tokens: 16, messages: [{ role: "user", content: "a" }] };
  const multi = { ...completions, n: 2 };
  const nDelta = classifyPayloadChange(completions, multi, "replacement");
  assert.deepEqual(nDelta.categories, ["control"]);
  assert.throws(() => authPayload({ model, delta: nDelta, before: completions, after: multi, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens }), /unvalidated payload control/);
  const unknown = { prompt: "a" };
  authPayload({ model, delta: classifyPayloadChange(unknown, unknown, "identity"), before: unknown, after: unknown, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens });
  const candidate = { ...google, config: { ...google.config, candidateCount: 2 } };
  assert.throws(() => authPayload({ model, delta: classifyPayloadChange(google, candidate, "replacement"), before: google, after: candidate, inputTokens: 100, inputLimit: 1000, authorizedOutput: 128 }), /unrecognized payload field/);
  const cached = { ...google, config: { ...google.config, cachedContent: "cachedContents/synthetic" } };
  assert.throws(() => authPayload({ model, delta: classifyPayloadChange(google, cached, "replacement"), before: google, after: cached, inputTokens: 100, inputLimit: 1000, authorizedOutput: 128 }), /unrecognized payload field/);
  const audioOut = { ...google, config: { ...google.config, responseModalities: ["AUDIO"] } };
  assert.throws(() => authPayload({ model, delta: classifyPayloadChange(google, audioOut, "replacement"), before: google, after: audioOut, inputTokens: 100, inputLimit: 1000, authorizedOutput: 128 }), /unrecognized payload field/);
  const responsesHidden = { model: model.id, stream: true, max_output_tokens: 16, input: [{ role: "user", content: "a" }] };
  for (const patch of [{ previous_response_id: "resp_synthetic" }, { conversation: "conv_synthetic" }, { truncation: "auto" }]) {
    const after = { ...responsesHidden, ...patch };
    assert.throws(() => authPayload({ model, delta: classifyPayloadChange(responsesHidden, after, "replacement"), before: responsesHidden, after, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens }), /unrecognized payload field/);
  }
});

test("same-length input mutation, netted growth, extra image, audio, cap expansion and omitted cap fail", () => {
  const base = { model: model.id, stream: true, max_tokens: 16, metadata: { note: "n".repeat(4000) }, messages: [{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }] }, { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "ok" }] }] };
  const orphan = { ...base, messages: [{ role: "toolResult", toolCallId: "missing", toolName: "read", content: [{ type: "text", text: "ok" }] }] };
  const orphanDelta = classifyPayloadChange(base, orphan, "replacement");
  assert(orphanDelta.categories.includes("input"));
  assert.throws(() => authPayload({ model, delta: orphanDelta, before: base, after: orphan, inputTokens: 100, inputLimit: 100000, authorizedOutput: model.maxTokens }), /unvalidated payload input/);
  const netted = { ...base, metadata: { note: "x" }, messages: [{ role: "user", content: "a".repeat(4000) }] };
  const netDelta = classifyPayloadChange(base, netted, "replacement");
  assert(netDelta.inputGrewTokens > 0);
  assert(netDelta.grewTokens < netDelta.inputGrewTokens);
  assert.throws(() => authPayload({ model, delta: netDelta, before: base, after: netted, inputTokens: 100, inputLimit: 100000, authorizedOutput: model.maxTokens }), /unvalidated payload input/);
  const imaged = { model: model.id, stream: true, max_tokens: 16, messages: [{ role: "user", content: [{ type: "image", data: "aa", mimeType: "image/png" }, { type: "image", data: "bb", mimeType: "image/png" }] }] };
  const oneImage = { ...imaged, messages: [{ role: "user", content: [{ type: "image", data: "aa", mimeType: "image/png" }] }] };
  const extraImage = classifyPayloadChange(oneImage, imaged, "replacement");
  assert.equal(extraImage.imagesAdded, 1);
  assert(extraImage.categories.includes("media"));
  assert.throws(() => authPayload({ model, delta: extraImage, before: oneImage, after: imaged, inputTokens: 100, inputLimit: 100000, authorizedOutput: model.maxTokens }), /unvalidated payload/);
  const audio = { ...base, messages: [{ role: "user", content: [{ type: "audio", data: "zz" }] }] };
  const audioDelta = classifyPayloadChange(base, audio, "replacement");
  assert.throws(() => authPayload({ model, delta: audioDelta, before: base, after: audio, inputTokens: 100, inputLimit: 100000, authorizedOutput: model.maxTokens }), /unsupported media/);
  const from = { model: model.id, stream: true, max_tokens: 16, messages: [{ role: "user", content: "a" }] };
  const raised = { ...from, max_tokens: 32 };
  const expand = classifyPayloadChange(from, raised, "in-place");
  assert.throws(() => authPayload({ model, delta: expand, before: from, after: raised, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens }), /native serialized ceiling/);
  const omitted = { model: model.id, stream: true, messages: [{ role: "user", content: "a" }] };
  assert.throws(() => authPayload({ model, delta: classifyPayloadChange(from, omitted, "replacement"), before: from, after: omitted, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens }), /omitted its output cap|cap field was replaced/);
  assert.throws(() => authPayload({ model, delta: classifyPayloadChange(from, { ...from, max_tokens: "16" }, "replacement"), before: from, after: { ...from, max_tokens: "16" }, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens }), /not a positive integer/);
  assert.throws(() => authPayload({ model, delta: classifyPayloadChange(from, { ...from, max_output_tokens: 99 }, "replacement"), before: from, after: { ...from, max_output_tokens: 99 }, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens }), /disagree|cap field was replaced|native serialized ceiling/);
  const responses = { model: model.id, stream: true, max_output_tokens: 16, input: [] };
  const aliased = { model: model.id, stream: true, max_tokens: 16, input: [] };
  assert.throws(() => authPayload({ model, delta: classifyPayloadChange(responses, aliased, "replacement"), before: responses, after: aliased, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens }), /cap field was replaced/);
  const { stream: _s, ...noStream } = responses;
  assert.throws(() => authPayload({ model, delta: classifyPayloadChange(responses, noStream, "replacement"), before: responses, after: noStream, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens }), /stream field/);
  const { model: _m, ...noModel } = responses;
  assert.throws(() => authPayload({ model, delta: classifyPayloadChange(responses, noModel, "replacement"), before: responses, after: noModel, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens }), /model field/);
  const unstreamed = { model: model.id, max_tokens: 16, messages: [{ role: "user", content: "a" }] };
  authPayload({ model, delta: classifyPayloadChange(unstreamed, { ...unstreamed, temperature: 0 }, "replacement"), before: unstreamed, after: { ...unstreamed, temperature: 0 }, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens });
});

function responsesSSE(modelId: string, text: string): Response {
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

function payloadExtra(mode: () => string, second?: (payload: Record<string, unknown>) => unknown): InlineExtension[] {
  const extras: InlineExtension[] = [{ name: "payload-one", factory(pi) {
    pi.on("before_provider_request", event => {
      const payload = event.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
      const rec = payload as Record<string, unknown>;
      switch (mode()) {
        case "identity": return payload;
        case "inplace-meta": rec.temperature = 0; return;
        case "replace-meta": return { ...rec, temperature: 0 };
        case "overcap": return { ...rec, max_output_tokens: 99_999_999 };
        case "expand-cap": {
          const current = rec.max_output_tokens ?? rec.max_tokens ?? rec.max_completion_tokens;
          return { ...rec, max_output_tokens: typeof current === "number" ? current + 1 : 32 };
        }
        case "nostream": return { ...rec, stream: false };
        case "grow": return { ...rec, metadata: { note: "n".repeat(50000) } };
        case "orphan-input": return { ...rec, ...(Array.isArray(rec.input) ? { input: [...rec.input, { role: "tool", call_id: "missing", type: "function_call_output", output: "x" }] } : { messages: [...(Array.isArray(rec.messages) ? rec.messages : []), { role: "tool", tool_call_id: "missing", content: "x" }] }) };
        case "illegal-model": return { ...rec, model: "outside-selection" };
        case "multi-choice": return { ...rec, n: 2 };
        case "alias-cap": {
          const cap = rec.max_output_tokens;
          if (typeof cap !== "number") return rec;
          const { max_output_tokens: _dropped, ...rest } = rec;
          return { ...rest, max_tokens: cap };
        }
        case "drop-stream": {
          const { stream: _stream, ...rest } = rec;
          return rest;
        }
        case "drop-model": {
          const { model: _model, ...rest } = rec;
          return rest;
        }
        default: return;
      }
    });
  } }];
  if (second) extras.push({ name: "payload-two", factory(pi) {
    pi.on("before_provider_request", event => {
      const payload = event.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
      return second(payload as Record<string, unknown>);
    });
  } });
  return extras;
}

async function nativeMain(t: { after: (fn: () => Promise<void> | void) => void }, mode: () => string, second?: (payload: Record<string, unknown>) => unknown) {
  let sends = 0;
  const bodies: Record<string, unknown>[] = [];
  const admissions: Array<{ outcome?: string; code?: string; payload?: { mode?: string; categories?: string[] } }> = [];
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
  const f = await fixture({
    config: { budget: { inputLimit: 8000 } },
    extras: [
      { name: "watch-admission", factory(pi) { pi.events.on("nunc:admission", (value: unknown) => admissions.push(value as typeof admissions[number])); } },
      ...payloadExtra(mode, second),
    ],
  });
  t.after(() => f.close());
  new ModelRegistry(f.modelRuntime).registerProvider(wrapped);
  await f.modelRuntime.setRuntimeApiKey("openai", "offline-fixture-key");
  await f.runtime.session.setModel(catalog);
  await f.runtime.session.prompt("Native main request through the stock serializer");
  return { f, catalog, sends: () => sends, bodies, admissions };
}

test("stock loader noop, identity, in-place and replacement metadata reach controlled HTTP", { timeout: 90000 }, async t => {
  for (const mode of ["observe", "identity", "inplace-meta", "replace-meta"] as const) {
    const run = await nativeMain(t, () => mode);
    assert.equal(run.sends(), 1, mode);
    const last = run.f.runtime.session.messages.at(-1);
    assert.equal(last?.role, "assistant");
    if (mode === "inplace-meta" || mode === "replace-meta") {
      assert.equal(run.bodies[0]?.temperature, 0);
      assert(run.admissions.some(a => a.payload?.categories?.includes("metadata")));
    }
  }
});

test("later before_provider_request replacement wins; overcap, non-stream, growth and model change send zero HTTP", { timeout: 90000 }, async t => {
  const order = await nativeMain(t, () => "replace-meta", payload => ({ ...payload, temperature: 1 }));
  assert.equal(order.sends(), 1);
  assert.equal(order.bodies[0]?.temperature, 1);
  for (const mode of ["overcap", "expand-cap", "alias-cap", "nostream", "drop-stream", "drop-model", "grow", "orphan-input", "illegal-model", "multi-choice"] as const) {
    const run = await nativeMain(t, () => mode);
    assert.equal(run.sends(), 0, mode);
    const last = run.f.runtime.session.messages.at(-1);
    assert.equal(last?.role, "assistant");
    assert.equal(last.stopReason, "error");
    if (mode === "grow") assert.match(last.errorMessage ?? "", /context_length_exceeded: Nunc local CAPACITY/);
    else assert.match(last.errorMessage ?? "", /Nunc local CONFIG|unvalidated payload|non-streaming|stream field|model field|cap field|output cap|model differs|native serialized/);
    assert.equal(run.admissions.some(a => a.outcome === "reject" && a.payload), true, mode);
    assert.doesNotMatch(JSON.stringify(run.admissions), /outside-selection|n{20}/);
  }
});
