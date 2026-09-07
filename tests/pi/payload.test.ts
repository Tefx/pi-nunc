import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { ModelRegistry, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { authorizePayload, canonicalJson, classifyPayloadChange, jsonView, outputCapState, payloadMode, payloadOutputCeiling } from "../../src/pi/payload.js";
import { model } from "../engine/fixtures.js";
import { fixture } from "./fixtures.js";

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
  authorizePayload({ model, delta: identity, before: base, after: base, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens });
  const meta = classifyPayloadChange(base, { ...base, temperature: 0 }, "replacement");
  authorizePayload({ model, delta: meta, before: base, after: { ...base, temperature: 0 }, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens });
  const over = classifyPayloadChange(base, { ...base, max_tokens: model.maxTokens + 1 }, "replacement");
  assert.throws(() => authorizePayload({ model, delta: over, before: base, after: { ...base, max_tokens: model.maxTokens + 1 }, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens }), /native serialized ceiling|exceeds authorization/);
  const stream = classifyPayloadChange(base, { ...base, stream: false }, "replacement");
  assert.throws(() => authorizePayload({ model, delta: stream, before: base, after: { ...base, stream: false }, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens }), /stream field|non-streaming/);
  const renamed = classifyPayloadChange(base, { ...base, model: "outside-selection" }, "replacement");
  assert.throws(() => authorizePayload({ model, delta: renamed, before: base, after: { ...base, model: "outside-selection" }, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens }), /model field|payload model differs/);
  const grown = { ...base, extra: "n".repeat(2000) };
  const growth = classifyPayloadChange(base, grown, "replacement");
  assert(growth.grewTokens > 0);
  assert.throws(() => authorizePayload({ model, delta: growth, before: base, after: grown, inputTokens: 900, inputLimit: 1000, authorizedOutput: model.maxTokens }), /input growth/);
});

test("payloadOutputCeiling reads Completions, Responses and Gemini generationConfig fields", () => {
  assert.equal(payloadOutputCeiling({ max_tokens: 8 }), 8);
  assert.equal(payloadOutputCeiling({ max_output_tokens: 9 }), 9);
  assert.equal(payloadOutputCeiling({ max_completion_tokens: 10 }), 10);
  assert.equal(payloadOutputCeiling({ generationConfig: { maxOutputTokens: 11 } }), 11);
  assert.equal(payloadOutputCeiling({ stream: true }), undefined);
  assert.equal(outputCapState({ max_tokens: "16" }).kind, "invalid");
  assert.equal(outputCapState({ max_tokens: 16, max_output_tokens: 32 }).kind, "conflict");
});

test("same-length input mutation, netted growth, extra image, audio, cap expansion and omitted cap fail", () => {
  const base = { model: model.id, stream: true, max_tokens: 16, extra: "n".repeat(4000), messages: [{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }] }, { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "ok" }] }] };
  const orphan = { ...base, messages: [{ role: "toolResult", toolCallId: "missing", toolName: "read", content: [{ type: "text", text: "ok" }] }] };
  const orphanDelta = classifyPayloadChange(base, orphan, "replacement");
  assert(orphanDelta.categories.includes("input"));
  assert.throws(() => authorizePayload({ model, delta: orphanDelta, before: base, after: orphan, inputTokens: 100, inputLimit: 100000, authorizedOutput: model.maxTokens }), /unvalidated payload input/);
  const netted = { ...base, extra: "x", messages: [{ role: "user", content: "a".repeat(4000) }] };
  const netDelta = classifyPayloadChange(base, netted, "replacement");
  assert(netDelta.inputGrewTokens > 0);
  assert(netDelta.grewTokens < netDelta.inputGrewTokens);
  assert.throws(() => authorizePayload({ model, delta: netDelta, before: base, after: netted, inputTokens: 100, inputLimit: 100000, authorizedOutput: model.maxTokens }), /unvalidated payload input/);
  const imaged = { model: model.id, stream: true, max_tokens: 16, messages: [{ role: "user", content: [{ type: "image", data: "aa", mimeType: "image/png" }, { type: "image", data: "bb", mimeType: "image/png" }] }] };
  const oneImage = { ...imaged, messages: [{ role: "user", content: [{ type: "image", data: "aa", mimeType: "image/png" }] }] };
  const extraImage = classifyPayloadChange(oneImage, imaged, "replacement");
  assert.equal(extraImage.imagesAdded, 1);
  assert(extraImage.categories.includes("media"));
  assert.throws(() => authorizePayload({ model, delta: extraImage, before: oneImage, after: imaged, inputTokens: 100, inputLimit: 100000, authorizedOutput: model.maxTokens }), /unvalidated payload/);
  const audio = { ...base, messages: [{ role: "user", content: [{ type: "audio", data: "zz" }] }] };
  const audioDelta = classifyPayloadChange(base, audio, "replacement");
  assert.throws(() => authorizePayload({ model, delta: audioDelta, before: base, after: audio, inputTokens: 100, inputLimit: 100000, authorizedOutput: model.maxTokens }), /unsupported media/);
  const from = { model: model.id, stream: true, max_tokens: 16, messages: [{ role: "user", content: "a" }] };
  const raised = { ...from, max_tokens: 32 };
  const expand = classifyPayloadChange(from, raised, "in-place");
  assert.throws(() => authorizePayload({ model, delta: expand, before: from, after: raised, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens }), /native serialized ceiling/);
  const omitted = { model: model.id, stream: true, messages: [{ role: "user", content: "a" }] };
  assert.throws(() => authorizePayload({ model, delta: classifyPayloadChange(from, omitted, "replacement"), before: from, after: omitted, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens }), /omitted its output cap|cap field was replaced/);
  assert.throws(() => authorizePayload({ model, delta: classifyPayloadChange(from, { ...from, max_tokens: "16" }, "replacement"), before: from, after: { ...from, max_tokens: "16" }, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens }), /not a positive integer/);
  assert.throws(() => authorizePayload({ model, delta: classifyPayloadChange(from, { ...from, max_output_tokens: 99 }, "replacement"), before: from, after: { ...from, max_output_tokens: 99 }, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens }), /disagree|cap field was replaced|native serialized ceiling/);
  const responses = { model: model.id, stream: true, max_output_tokens: 16, input: [] };
  const aliased = { model: model.id, stream: true, max_tokens: 16, input: [] };
  assert.throws(() => authorizePayload({ model, delta: classifyPayloadChange(responses, aliased, "replacement"), before: responses, after: aliased, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens }), /cap field was replaced/);
  const { stream: _s, ...noStream } = responses;
  assert.throws(() => authorizePayload({ model, delta: classifyPayloadChange(responses, noStream, "replacement"), before: responses, after: noStream, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens }), /stream field/);
  const { model: _m, ...noModel } = responses;
  assert.throws(() => authorizePayload({ model, delta: classifyPayloadChange(responses, noModel, "replacement"), before: responses, after: noModel, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens }), /model field/);
  const unstreamed = { model: model.id, max_tokens: 16, messages: [{ role: "user", content: "a" }] };
  authorizePayload({ model, delta: classifyPayloadChange(unstreamed, { ...unstreamed, temperature: 0 }, "replacement"), before: unstreamed, after: { ...unstreamed, temperature: 0 }, inputTokens: 100, inputLimit: 1000, authorizedOutput: model.maxTokens });
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
        case "inplace-meta": rec.nunc_fixture = "meta"; return;
        case "replace-meta": return { ...rec, nunc_fixture: "meta" };
        case "overcap": return { ...rec, max_output_tokens: 99_999_999 };
        case "expand-cap": {
          const current = rec.max_output_tokens ?? rec.max_tokens ?? rec.max_completion_tokens;
          return { ...rec, max_output_tokens: typeof current === "number" ? current + 1 : 32 };
        }
        case "nostream": return { ...rec, stream: false };
        case "grow": return { ...rec, nunc_fixture: "n".repeat(50000) };
        case "orphan-input": return { ...rec, ...(Array.isArray(rec.input) ? { input: [...rec.input, { role: "tool", call_id: "missing", type: "function_call_output", output: "x" }] } : { messages: [...(Array.isArray(rec.messages) ? rec.messages : []), { role: "tool", tool_call_id: "missing", content: "x" }] }) };
        case "illegal-model": return { ...rec, model: "outside-selection" };
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
      assert.equal(run.bodies[0]?.nunc_fixture, "meta");
      assert(run.admissions.some(a => a.payload?.categories?.includes("metadata")));
    }
  }
});

test("later before_provider_request replacement wins; overcap, non-stream, growth and model change send zero HTTP", { timeout: 90000 }, async t => {
  const order = await nativeMain(t, () => "replace-meta", payload => ({ ...payload, nunc_later: true }));
  assert.equal(order.sends(), 1);
  assert.equal(order.bodies[0]?.nunc_fixture, "meta");
  assert.equal(order.bodies[0]?.nunc_later, true);
  for (const mode of ["overcap", "expand-cap", "alias-cap", "nostream", "drop-stream", "drop-model", "grow", "orphan-input", "illegal-model"] as const) {
    const run = await nativeMain(t, () => mode);
    assert.equal(run.sends(), 0, mode);
    const last = run.f.runtime.session.messages.at(-1);
    assert.equal(last?.role, "assistant");
    assert.equal(last.stopReason, "error");
    if (mode === "grow") assert.match(last.errorMessage ?? "", /context_length_exceeded: Nunc local CAPACITY/);
    else assert.match(last.errorMessage ?? "", /Nunc local CONFIG|unvalidated payload|non-streaming|stream field|model field|cap field|output cap|model differs|native serialized/);
    assert.equal(run.admissions.some(a => a.outcome === "reject" && a.payload), true, mode);
    assert.doesNotMatch(JSON.stringify(run.admissions), /nunc_fixture|outside-selection|n{20}/);
  }
});
