import { test } from "node:test";
import assert from "node:assert/strict";
import { zstdDecompressSync } from "node:zlib";
import type { Api, AssistantMessage, Context, Model, Provider } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { ModelRegistry, type InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AdmissionObservation } from "../../src/pi/admission.js";
import { fixture } from "./fixtures.js";
import { oauthFixture } from "./oauth-fixture.js";

const dummyUsage = { input: 10, output: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function assistantMsg(options: { model: string; api: Api; provider: string; stopReason: "stop" | "toolUse"; timestamp: number; content: AssistantMessage["content"] }): AssistantMessage {
  return { role: "assistant", usage: dummyUsage, ...options };
}

function completionsSSE(text: string) {
  const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const chunk = (delta: unknown, finish_reason: string | null = null) =>
    frame({ id: "resp-1", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason }] });
  return new Response(
    chunk({ role: "assistant", content: "" }) + chunk({ content: text }) + chunk({}, "stop") +
    frame({ id: "resp-1", object: "chat.completion.chunk", model: "test-model", choices: [], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }) +
    "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

function responsesSSE(text: string) {
  const item = { type: "message", id: "msg-1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: "resp-1", model: "test-model", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp-1", model: "test-model", status: "completed", output: [item], usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ];
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

function anthropicSSE(text: string) {
  const events = [
    { type: "message_start", message: { id: "resp-1", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, usage: { input_tokens: 50, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

test("sequential completed tool calls reusing the same ID complete across multiple turns with valid admission and receipts", async t => {
  let toolExecutions = 0;
  const admissions: AdmissionObservation[] = [];
  const extras: InlineExtension[] = [{
    name: "watch-admission",
    factory(pi) {
      pi.events.on("nunc:admission", value => admissions.push(value as AdmissionObservation));
    },
  }];

  const f = await fixture({
    extras,
    tools: [{
      name: "read_fixture",
      label: "read_fixture",
      description: "Read a fixture file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      execute: async (_toolCallId, params) => {
        toolExecutions++;
        const p = (params as { path?: string })?.path ?? "unknown";
        return { content: [{ type: "text" as const, text: `Content of ${p}` }], details: {} };
      },
    }],
  });
  t.after(() => f.close());

  let turn = 0;
  f.respond((context) => {
    turn++;
    // Turn 1 prompt -> request 1: assistant emits tool call with ID "call-reused"
    if (turn === 1) {
      return fauxAssistantMessage(fauxToolCall("read_fixture", { path: "turn1.txt" }, { id: "call-reused" }), { stopReason: "toolUse" });
    }
    // Turn 1 continuation -> request 2: assistant returns final answer
    if (turn === 2) {
      return fauxAssistantMessage("Finished turn 1 with tool.");
    }
    // Turn 2 prompt -> request 3: assistant emits tool call with the EXACT SAME ID "call-reused"
    if (turn === 3) {
      return fauxAssistantMessage(fauxToolCall("read_fixture", { path: "turn2.txt" }, { id: "call-reused" }), { stopReason: "toolUse" });
    }
    // Turn 2 continuation -> request 4: assistant returns final answer
    if (turn === 4) {
      return fauxAssistantMessage("Finished turn 2 with tool.");
    }
    return fauxAssistantMessage("Default response.");
  });

  // Prompt turn 1
  await f.runtime.session.prompt("Please read turn1.txt");
  const turn1Assistant = f.runtime.session.messages.findLast(m => m.role === "assistant");
  assert.equal(turn1Assistant?.role, "assistant");
  assert.equal(turn1Assistant?.stopReason, "stop");
  assert.equal(toolExecutions, 1);

  // Prompt turn 2 - reuses the completed tool call ID
  await f.runtime.session.prompt("Please read turn2.txt");
  const turn2Assistant = f.runtime.session.messages.findLast(m => m.role === "assistant");
  assert.equal(turn2Assistant?.role, "assistant");
  assert.equal(turn2Assistant?.stopReason, "stop");
  assert.equal(toolExecutions, 2);

  // Check admission observations: all 4 requests were delegated successfully
  const delegated = admissions.filter(o => o.kind === "main" && o.outcome === "delegate");
  assert.equal(delegated.length, 4, "all 4 main/continuation requests delegated without duplicate rejection");

  // Verify that turn 2 tool continuation re-used the receipt anchor from turn 2 call
  assert(delegated.some(o => o.estimator === "pi-usage-backed" && o.estimateReason === "matching-receipt"),
    "usage receipt was successfully established and matched across tool loop");
});

test("ambiguous duplicate pending tool call IDs are rejected before transport with zero provider calls", async t => {
  let callCount = 0;
  const admissions: AdmissionObservation[] = [];
  const extras: InlineExtension[] = [
    {
      name: "watch-admission",
      factory(pi) { pi.events.on("nunc:admission", value => admissions.push(value as AdmissionObservation)); },
    },
    {
      name: "inject-duplicate-pending",
      factory(pi) {
        (pi as any).on("context", (event: { messages: unknown[] }) => ({
          messages: [
            ...event.messages,
            {
              role: "assistant", model: "large", api: "openai-completions", provider: "nunc-pi-fixture",
              stopReason: "toolUse", timestamp: 10,
              content: [
                { type: "toolCall", id: "ambig-id", name: "read", arguments: { path: "a.txt" } },
                { type: "toolCall", id: "ambig-id", name: "read", arguments: { path: "b.txt" } },
              ],
            },
          ],
        }));
      },
    },
  ];
  const f = await fixture({ extras });
  t.after(() => f.close());
  f.respond(() => { callCount++; return fauxAssistantMessage("Must not be called"); });

  await f.runtime.session.prompt("Trigger duplicate pending check");
  const last = f.runtime.session.messages.at(-1);
  assert.equal(callCount, 0, "provider must not be called when ambiguous pending calls exist");
  assert(last?.role === "assistant");
  assert.equal(last.stopReason, "error");
  assert.match(last.errorMessage ?? "", /Duplicate tool call ambig-id|Nunc local INPUT/);
});

test("orphan, duplicate, name-mismatched, and unresolved tool results reject before transport", async t => {
  // 1. Orphan result
  {
    let callCount = 0;
    const f = await fixture({ extras: [{
      name: "orphan-test",
      factory(pi) {
        (pi as any).on("context", (event: { messages: unknown[] }) => ({
          messages: [...event.messages, { role: "toolResult", toolCallId: "nonexistent", toolName: "read", isError: false, content: [{ type: "text", text: "orphan" }], timestamp: 10 }],
        }));
      },
    }] });
    t.after(() => f.close());
    f.respond(() => { callCount++; return fauxAssistantMessage("No call"); });
    await f.runtime.session.prompt("Prompt with orphan");
    assert.equal(callCount, 0);
    const last = f.runtime.session.messages.at(-1);
    assert(last?.role === "assistant" && last.stopReason === "error");
    assert.match(last.errorMessage ?? "", /Orphan|Nunc local INPUT/);
  }

  // 2. Name-mismatched result
  {
    let callCount = 0;
    const f = await fixture({ extras: [{
      name: "mismatched-test",
      factory(pi) {
        (pi as any).on("context", (event: { messages: unknown[] }) => ({
          messages: [
            ...event.messages,
            { role: "assistant", model: "large", api: "openai-completions", provider: "nunc-pi-fixture", stopReason: "toolUse", timestamp: 10, content: [{ type: "toolCall", id: "call-mismatch", name: "read", arguments: {} }] },
            { role: "toolResult", toolCallId: "call-mismatch", toolName: "write", isError: false, content: [{ type: "text", text: "mismatched" }], timestamp: 11 },
          ],
        }));
      },
    }] });
    t.after(() => f.close());
    f.respond(() => { callCount++; return fauxAssistantMessage("No call"); });
    await f.runtime.session.prompt("Prompt with mismatch");
    assert.equal(callCount, 0);
    const last = f.runtime.session.messages.at(-1);
    assert(last?.role === "assistant" && last.stopReason === "error");
    assert.match(last.errorMessage ?? "", /mismatched|Nunc local INPUT/);
  }

  // 3. Duplicate result for same call
  {
    let callCount = 0;
    const f = await fixture({ extras: [{
      name: "duplicate-result-test",
      factory(pi) {
        (pi as any).on("context", (event: { messages: unknown[] }) => ({
          messages: [
            ...event.messages,
            { role: "assistant", model: "large", api: "openai-completions", provider: "nunc-pi-fixture", stopReason: "toolUse", timestamp: 10, content: [{ type: "toolCall", id: "call-dup", name: "read", arguments: {} }] },
            { role: "toolResult", toolCallId: "call-dup", toolName: "read", isError: false, content: [{ type: "text", text: "res1" }], timestamp: 11 },
            { role: "toolResult", toolCallId: "call-dup", toolName: "read", isError: false, content: [{ type: "text", text: "res2" }], timestamp: 12 },
          ],
        }));
      },
    }] });
    t.after(() => f.close());
    f.respond(() => { callCount++; return fauxAssistantMessage("No call"); });
    await f.runtime.session.prompt("Prompt with duplicate result");
    assert.equal(callCount, 0);
    const last = f.runtime.session.messages.at(-1);
    assert(last?.role === "assistant" && last.stopReason === "error");
    assert.match(last.errorMessage ?? "", /duplicate|Nunc local INPUT/);
  }

  // 4. Unresolved tool call at end of context
  {
    let callCount = 0;
    const f = await fixture({ extras: [{
      name: "unresolved-test",
      factory(pi) {
        (pi as any).on("context", (event: { messages: unknown[] }) => ({
          messages: [
            ...event.messages,
            { role: "assistant", model: "large", api: "openai-completions", provider: "nunc-pi-fixture", stopReason: "toolUse", timestamp: 10, content: [{ type: "toolCall", id: "call-unresolved", name: "read", arguments: {} }] },
          ],
        }));
      },
    }] });
    t.after(() => f.close());
    f.respond(() => { callCount++; return fauxAssistantMessage("No call"); });
    await f.runtime.session.prompt("Prompt with unresolved call");
    assert.equal(callCount, 0);
    const last = f.runtime.session.messages.at(-1);
    assert(last?.role === "assistant" && last.stopReason === "error");
    assert.match(last.errorMessage ?? "", /Unresolved|Nunc local INPUT/);
  }
});

test("native serializers format sequential completed same-ID tool loops into valid wire protocol", async t => {
  // Test OpenAI Completions serializer
  {
    const bodies: unknown[] = [];
    const openrouter = openrouterProvider();
    const catalog = openrouter.getModels().find(m => m.api === "openai-completions");
    assert(catalog);
    const targetModel: Model<Api> = catalog;
    const transport: typeof fetch = async (resource, init) => {
      bodies.push(await new Request(resource, init).json());
      return completionsSSE("Completions tool loop ok.");
    };
    const bound = { apiKey: "offline-test-key", fetch: transport, maxRetries: 0 as const };
    const wrapped: Provider = {
      ...openrouter,
      streamSimple: (m, context, options) => openrouter.streamSimple(m as never, context, { ...options, ...bound } as never),
      stream: (m, context, options) => openrouter.stream(m as never, context, { ...options, ...bound } as never),
    };
    const context: Context = {
      messages: [
        { role: "user", content: "turn 1 request", timestamp: 1 },
        assistantMsg({ model: targetModel.id, api: targetModel.api, provider: targetModel.provider, stopReason: "toolUse", timestamp: 2, content: [{ type: "toolCall", id: "reused-tool-id", name: "read", arguments: { path: "first.txt" } }] }),
        { role: "toolResult", toolCallId: "reused-tool-id", toolName: "read", isError: false, timestamp: 3, content: [{ type: "text", text: "first result" }] },
        assistantMsg({ model: targetModel.id, api: targetModel.api, provider: targetModel.provider, stopReason: "stop", timestamp: 4, content: [{ type: "text", text: "turn 1 done" }] }),
        { role: "user", content: "turn 2 request", timestamp: 5 },
        assistantMsg({ model: targetModel.id, api: targetModel.api, provider: targetModel.provider, stopReason: "toolUse", timestamp: 6, content: [{ type: "toolCall", id: "reused-tool-id", name: "read", arguments: { path: "second.txt" } }] }),
        { role: "toolResult", toolCallId: "reused-tool-id", toolName: "read", isError: false, timestamp: 7, content: [{ type: "text", text: "second result" }] },
      ],
    };
    const stream = wrapped.stream(targetModel as never, context, {} as never);
    const result = await stream.result();
    assert.equal(result.role, "assistant");
    assert.equal(bodies.length, 1);
    const wireBody = bodies[0] as { messages: Array<{ role: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string }> };
    assert(Array.isArray(wireBody.messages));
    const toolCalls = wireBody.messages.flatMap(m => m.tool_calls ?? []);
    assert.equal(toolCalls.length, 2);
    assert.equal(toolCalls[0]?.id, "reused-tool-id");
    assert.equal(toolCalls[1]?.id, "reused-tool-id");
    const toolResults = wireBody.messages.filter(m => m.role === "tool");
    assert.equal(toolResults.length, 2);
    assert.equal(toolResults[0]?.tool_call_id, "reused-tool-id");
    assert.equal(toolResults[1]?.tool_call_id, "reused-tool-id");
  }

  // Test OpenAI Responses serializer
  {
    const bodies: unknown[] = [];
    const openai = openaiProvider();
    const catalog = openai.getModels().find(m => m.id === "gpt-4.1");
    assert(catalog);
    const transport: typeof fetch = async (resource, init) => {
      bodies.push(await new Request(resource, init).json());
      return responsesSSE("Responses tool loop ok.");
    };
    const bound = { apiKey: "offline-test-key", fetch: transport, maxRetries: 0 as const };
    const wrapped: Provider = {
      ...openai,
      streamSimple: (m, context, options) => openai.streamSimple(m as never, context, { ...options, ...bound } as never),
      stream: (m, context, options) => openai.stream(m as never, context, { ...options, ...bound } as never),
    };
    const context: Context = {
      messages: [
        { role: "user", content: "turn 1 request", timestamp: 1 },
        assistantMsg({ model: catalog.id, api: catalog.api, provider: catalog.provider, stopReason: "toolUse", timestamp: 2, content: [{ type: "toolCall", id: "reused-call-id", name: "read", arguments: { path: "first.txt" } }] }),
        { role: "toolResult", toolCallId: "reused-call-id", toolName: "read", isError: false, timestamp: 3, content: [{ type: "text", text: "first result" }] },
        assistantMsg({ model: catalog.id, api: catalog.api, provider: catalog.provider, stopReason: "stop", timestamp: 4, content: [{ type: "text", text: "turn 1 done" }] }),
        { role: "user", content: "turn 2 request", timestamp: 5 },
        assistantMsg({ model: catalog.id, api: catalog.api, provider: catalog.provider, stopReason: "toolUse", timestamp: 6, content: [{ type: "toolCall", id: "reused-call-id", name: "read", arguments: { path: "second.txt" } }] }),
        { role: "toolResult", toolCallId: "reused-call-id", toolName: "read", isError: false, timestamp: 7, content: [{ type: "text", text: "second result" }] },
      ],
    };
    const stream = wrapped.stream(catalog as never, context, {} as never);
    const result = await stream.result();
    assert.equal(result.role, "assistant");
    assert.equal(bodies.length, 1);
    const wireBody = bodies[0] as { input: Array<{ type: string; call_id?: string }> };
    assert(Array.isArray(wireBody.input));
    const calls = wireBody.input.filter(item => item.type === "function_call");
    const outputs = wireBody.input.filter(item => item.type === "function_call_output");
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.call_id, "reused-call-id");
    assert.equal(calls[1]?.call_id, "reused-call-id");
    assert.equal(outputs.length, 2);
    assert.equal(outputs[0]?.call_id, "reused-call-id");
    assert.equal(outputs[1]?.call_id, "reused-call-id");
  }

  // Test Anthropic Messages serializer
  {
    const bodies: unknown[] = [];
    const anthropic = anthropicProvider();
    const catalog = anthropic.getModels().find(m => m.id.includes("claude"));
    assert(catalog);
    const transport: typeof fetch = async (resource, init) => {
      bodies.push(await new Request(resource, init).json());
      return anthropicSSE("Anthropic tool loop ok.");
    };
    const bound = { apiKey: "offline-test-key", fetch: transport, maxRetries: 0 as const };
    const wrapped: Provider = {
      ...anthropic,
      streamSimple: (m, context, options) => anthropic.streamSimple(m as never, context, { ...options, ...bound } as never),
      stream: (m, context, options) => anthropic.stream(m as never, context, { ...options, ...bound } as never),
    };
    const context: Context = {
      messages: [
        { role: "user", content: "turn 1 request", timestamp: 1 },
        assistantMsg({ model: catalog.id, api: catalog.api, provider: catalog.provider, stopReason: "toolUse", timestamp: 2, content: [{ type: "toolCall", id: "reused-anthropic-id", name: "read", arguments: { path: "first.txt" } }] }),
        { role: "toolResult", toolCallId: "reused-anthropic-id", toolName: "read", isError: false, timestamp: 3, content: [{ type: "text", text: "first result" }] },
        assistantMsg({ model: catalog.id, api: catalog.api, provider: catalog.provider, stopReason: "stop", timestamp: 4, content: [{ type: "text", text: "turn 1 done" }] }),
        { role: "user", content: "turn 2 request", timestamp: 5 },
        assistantMsg({ model: catalog.id, api: catalog.api, provider: catalog.provider, stopReason: "toolUse", timestamp: 6, content: [{ type: "toolCall", id: "reused-anthropic-id", name: "read", arguments: { path: "second.txt" } }] }),
        { role: "toolResult", toolCallId: "reused-anthropic-id", toolName: "read", isError: false, timestamp: 7, content: [{ type: "text", text: "second result" }] },
      ],
    };
    const stream = wrapped.stream(catalog as never, context, {} as never);
    const result = await stream.result();
    assert.equal(result.role, "assistant");
    assert.equal(bodies.length, 1);
    const wireBody = bodies[0] as { messages: Array<{ role: string; content: Array<{ type: string; id?: string; tool_use_id?: string }> }> };
    assert(Array.isArray(wireBody.messages));
    const uses = wireBody.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === "tool_use") : []);
    const results = wireBody.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === "tool_result") : []);
    assert.equal(uses.length, 2);
    assert.equal(uses[0]?.id, "reused-anthropic-id");
    assert.equal(uses[1]?.id, "reused-anthropic-id");
    assert.equal(results.length, 2);
    assert.equal(results[0]?.tool_use_id, "reused-anthropic-id");
    assert.equal(results[1]?.tool_use_id, "reused-anthropic-id");
  }

  // Test OpenAI Codex Responses serializer
  {
    const bodies: unknown[] = [];
    const codex = openaiCodexProvider();
    const catalog = codex.getModels().find(m => m.id === "gpt-6-astra");
    assert(catalog);
    const transport: typeof fetch = async (resource, init) => {
      const request = new Request(resource, init);
      const raw = Buffer.from(await request.arrayBuffer());
      const decoded = request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(raw) : raw;
      bodies.push(JSON.parse(decoded.toString("utf8")));
      return responsesSSE("Codex tool loop ok.");
    };
    const credential = oauthFixture();
    const bound = { apiKey: credential.access, fetch: transport, transport: "sse" as const, maxRetries: 0 as const };
    const wrapped: Provider = {
      ...codex,
      streamSimple: (m, context, options) => codex.streamSimple(m as never, context, { ...options, ...bound } as never),
      stream: (m, context, options) => codex.stream(m as never, context, { ...options, ...bound } as never),
    };
    const context: Context = {
      messages: [
        { role: "user", content: "turn 1 request", timestamp: 1 },
        assistantMsg({ model: catalog.id, api: catalog.api, provider: catalog.provider, stopReason: "toolUse", timestamp: 2, content: [{ type: "toolCall", id: "reused-codex-id", name: "read", arguments: { path: "first.txt" } }] }),
        { role: "toolResult", toolCallId: "reused-codex-id", toolName: "read", isError: false, timestamp: 3, content: [{ type: "text", text: "first result" }] },
        assistantMsg({ model: catalog.id, api: catalog.api, provider: catalog.provider, stopReason: "stop", timestamp: 4, content: [{ type: "text", text: "turn 1 done" }] }),
        { role: "user", content: "turn 2 request", timestamp: 5 },
        assistantMsg({ model: catalog.id, api: catalog.api, provider: catalog.provider, stopReason: "toolUse", timestamp: 6, content: [{ type: "toolCall", id: "reused-codex-id", name: "read", arguments: { path: "second.txt" } }] }),
        { role: "toolResult", toolCallId: "reused-codex-id", toolName: "read", isError: false, timestamp: 7, content: [{ type: "text", text: "second result" }] },
      ],
    };
    const stream = wrapped.stream(catalog as never, context, {} as never);
    const result = await stream.result();
    assert.equal(result.role, "assistant");
    assert.equal(bodies.length, 1);
    const wireBody = bodies[0] as { input: Array<{ type: string; call_id?: string }> };
    assert(Array.isArray(wireBody.input));
    const calls = wireBody.input.filter(item => item.type === "function_call");
    const outputs = wireBody.input.filter(item => item.type === "function_call_output");
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.call_id, "reused-codex-id");
    assert.equal(calls[1]?.call_id, "reused-codex-id");
    assert.equal(outputs.length, 2);
    assert.equal(outputs[0]?.call_id, "reused-codex-id");
    assert.equal(outputs[1]?.call_id, "reused-codex-id");
  }
});

test("native serializers with Nunc admission reject invalid tool associations before HTTP transport", async t => {
  // Test that for each native adapter, an invalid association (e.g. orphan result)
  // is rejected locally by Nunc Admission with zero HTTP network requests.
  const adapters: Array<{ name: string; setup: (transport: typeof fetch) => { provider: Provider; model: Model<Api> } }> = [
    {
      name: "openai-completions",
      setup: (transport) => {
        const p = openrouterProvider();
        const m = p.getModels().find(model => model.api === "openai-completions")!;
        const bound = { apiKey: "offline-key", fetch: transport, maxRetries: 0 as const };
        return {
          provider: { ...p, stream: (mod, ctx, opt) => p.stream(mod as never, ctx, { ...opt, ...bound } as never) },
          model: m,
        };
      },
    },
    {
      name: "openai-responses",
      setup: (transport) => {
        const p = openaiProvider();
        const m = p.getModels().find(model => model.id === "gpt-4.1")!;
        const bound = { apiKey: "offline-key", fetch: transport, maxRetries: 0 as const };
        return {
          provider: { ...p, stream: (mod, ctx, opt) => p.stream(mod as never, ctx, { ...opt, ...bound } as never) },
          model: m,
        };
      },
    },
    {
      name: "anthropic-messages",
      setup: (transport) => {
        const p = anthropicProvider();
        const m = p.getModels().find(model => model.id.includes("claude"))!;
        const bound = { apiKey: "offline-key", fetch: transport, maxRetries: 0 as const };
        return {
          provider: { ...p, stream: (mod, ctx, opt) => p.stream(mod as never, ctx, { ...opt, ...bound } as never) },
          model: m,
        };
      },
    },
  ];

  for (const adapter of adapters) {
    let httpCalls = 0;
    const transport: typeof fetch = async () => {
      httpCalls++;
      return new Response("must not reach here", { status: 500 });
    };
    const { provider, model: adapterModel } = adapter.setup(transport);
    const f = await fixture({
      extras: [{
        name: `orphan-injection-${adapter.name}`,
        factory(pi) {
          (pi as any).on("context", (event: { messages: unknown[] }) => ({
            messages: [
              ...event.messages,
              { role: "toolResult", toolCallId: "orphan-id", toolName: "read", isError: false, content: [{ type: "text", text: "orphan" }], timestamp: 10 },
            ],
          }));
        },
      }],
    });
    t.after(() => f.close());
    new ModelRegistry(f.modelRuntime).registerProvider(provider);
    await f.modelRuntime.setRuntimeApiKey(adapterModel.provider, "offline-key");
    await f.runtime.session.setModel(adapterModel);

    await f.runtime.session.prompt(`Test invalid association on ${adapter.name}`);
    const last = f.runtime.session.messages.at(-1);
    assert.equal(httpCalls, 0, `zero HTTP calls before rejection on ${adapter.name}`);
    assert(last?.role === "assistant");
    assert.equal(last.stopReason, "error");
    assert.match(last.errorMessage ?? "", /Orphan|Nunc local INPUT/);
  }
});
