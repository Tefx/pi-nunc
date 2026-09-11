import { test } from "node:test";
import assert from "node:assert/strict";
import { zstdDecompressSync } from "node:zlib";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { ModelRegistry, type InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AdmissionObservation } from "../../src/pi/admission.js";
import { fixture } from "./fixtures.js";
import { oauthFixture } from "./oauth-fixture.js";

const frame = (v: unknown) => `data: ${JSON.stringify(v)}\n\n`;
const chunk = (delta: unknown, finish_reason: string | null = null) =>
  frame({ id: "resp-chunk", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] });

function completionsToolCallSSE(callId: string, name: string, args: Record<string, unknown>) {
  const sse =
    chunk({ role: "assistant", content: null }) +
    chunk({ tool_calls: [{ index: 0, id: callId, type: "function", function: { name, arguments: JSON.stringify(args) } }] }) +
    chunk({}, "tool_calls") +
    frame({ id: "resp-chunk", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }) +
    "data: [DONE]\n\n";
  return new Response(sse, { headers: { "content-type": "text/event-stream" } });
}

function completionsTextSSE(text: string) {
  const sse =
    chunk({ role: "assistant", content: "" }) +
    chunk({ content: text }) +
    chunk({}, "stop") +
    frame({ id: "resp-chunk", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }) +
    "data: [DONE]\n\n";
  return new Response(sse, { headers: { "content-type": "text/event-stream" } });
}

function responsesToolCallSSE(modelId: string, callId: string, name: string, args: Record<string, unknown>) {
  const item = { type: "function_call", id: "fc-1", call_id: callId, name, arguments: JSON.stringify(args), status: "completed" };
  const events = [
    { type: "response.created", response: { id: "resp-1", model: modelId, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp-1", model: modelId, status: "completed", output: [item], usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ];
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

function responsesTextSSE(modelId: string, text: string) {
  const item = { type: "message", id: "msg-1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: "resp-1", model: modelId, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp-1", model: modelId, status: "completed", output: [item], usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ];
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

function anthropicToolCallSSE(modelId: string, callId: string, name: string, args: Record<string, unknown>) {
  const events = [
    { type: "message_start", message: { id: "resp-1", type: "message", role: "assistant", model: modelId, content: [], stop_reason: null, usage: { input_tokens: 50, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: callId, name, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(args) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 10 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

function anthropicTextSSE(modelId: string, text: string) {
  const events = [
    { type: "message_start", message: { id: "resp-1", type: "message", role: "assistant", model: modelId, content: [], stop_reason: null, usage: { input_tokens: 50, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

interface NativeAdapterSpec {
  name: string;
  setup: (transport: typeof fetch) => {
    provider: Provider;
    model: Model<Api>;
    isCodex?: boolean;
    toolCallSSE: (callId: string, name: string, args: Record<string, unknown>) => Response;
    textSSE: (txt: string) => Response;
    extractCalls: (body: unknown) => Array<{ id: string; args: unknown }>;
    extractResults: (body: unknown) => Array<{ id: string; content?: unknown }>;
  };
}

const nativeAdapters: NativeAdapterSpec[] = [
  {
    name: "openai-completions",
    setup: () => {
      const p = openrouterProvider();
      const m = p.getModels().find(model => model.id === "x-ai/grok-4.6");
      assert(m && m.api === "openai-completions");
      return {
        provider: p, model: m,
        toolCallSSE: (id, name, args) => completionsToolCallSSE(id, name, args),
        textSSE: (txt) => completionsTextSSE(txt),
        extractCalls: (body: any) => body.messages.flatMap((msg: any) =>
          (msg.tool_calls || []).map((tc: any) => ({
            id: tc.id,
            args: typeof tc.function?.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function?.arguments,
          }))
        ),
        extractResults: (body: any) => body.messages.filter((msg: any) => msg.role === "tool").map((msg: any) => ({
          id: msg.tool_call_id,
          content: msg.content,
        })),
      };
    },
  },
  {
    name: "openai-responses",
    setup: () => {
      const p = openaiProvider();
      const m = p.getModels().find(model => model.id === "gpt-4.1");
      assert(m && m.api === "openai-responses");
      return {
        provider: p, model: m,
        toolCallSSE: (id, name, args) => responsesToolCallSSE(m.id, id, name, args),
        textSSE: (txt) => responsesTextSSE(m.id, txt),
        extractCalls: (body: any) => body.input.filter((i: any) => i.type === "function_call").map((i: any) => ({
          id: i.call_id,
          args: typeof i.arguments === "string" ? JSON.parse(i.arguments) : i.arguments,
        })),
        extractResults: (body: any) => body.input.filter((i: any) => i.type === "function_call_output").map((i: any) => ({
          id: i.call_id,
          content: i.output,
        })),
      };
    },
  },
  {
    name: "anthropic-messages",
    setup: () => {
      const p = anthropicProvider();
      const m = p.getModels().find(model => model.id.includes("claude"));
      assert(m && m.api === "anthropic-messages");
      return {
        provider: p, model: m,
        toolCallSSE: (id, name, args) => anthropicToolCallSSE(m.id, id, name, args),
        textSSE: (txt) => anthropicTextSSE(m.id, txt),
        extractCalls: (body: any) => body.messages.flatMap((msg: any) =>
          Array.isArray(msg.content)
            ? msg.content.filter((b: any) => b.type === "tool_use").map((b: any) => ({ id: b.id, args: b.input }))
            : []
        ),
        extractResults: (body: any) => body.messages.flatMap((msg: any) =>
          Array.isArray(msg.content)
            ? msg.content.filter((b: any) => b.type === "tool_result").map((b: any) => ({ id: b.tool_use_id, content: b.content }))
            : []
        ),
      };
    },
  },
  {
    name: "openai-codex-responses",
    setup: () => {
      const p = openaiCodexProvider();
      const m = p.getModels().find(model => model.id === "gpt-6-astra");
      assert(m && m.api === "openai-codex-responses");
      return {
        provider: p, model: m, isCodex: true,
        toolCallSSE: (id, name, args) => responsesToolCallSSE(m.id, id, name, args),
        textSSE: (txt) => responsesTextSSE(m.id, txt),
        extractCalls: (body: any) => body.input.filter((i: any) => i.type === "function_call").map((i: any) => ({
          id: i.call_id,
          args: typeof i.arguments === "string" ? JSON.parse(i.arguments) : i.arguments,
        })),
        extractResults: (body: any) => body.input.filter((i: any) => i.type === "function_call_output").map((i: any) => ({
          id: i.call_id,
          content: i.output,
        })),
      };
    },
  },
];

test("stock Pi session with faux provider: sequential completed tool calls reuse ID across turns with receipt reuse", async t => {
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
  f.respond(() => {
    turn++;
    if (turn === 1) {
      return fauxAssistantMessage(fauxToolCall("read_fixture", { path: "turn1.txt" }, { id: "call-reused" }), { stopReason: "toolUse" });
    }
    if (turn === 2) {
      return fauxAssistantMessage("Finished turn 1 with tool.");
    }
    if (turn === 3) {
      return fauxAssistantMessage(fauxToolCall("read_fixture", { path: "turn2.txt" }, { id: "call-reused" }), { stopReason: "toolUse" });
    }
    if (turn === 4) {
      return fauxAssistantMessage("Finished turn 2 with tool.");
    }
    return fauxAssistantMessage("Default response.");
  });

  await f.runtime.session.prompt("Please read turn1.txt");
  const turn1Assistant = f.runtime.session.messages.findLast(m => m.role === "assistant");
  assert.equal(turn1Assistant?.role, "assistant");
  assert.equal(turn1Assistant?.stopReason, "stop");
  assert.equal(toolExecutions, 1);

  await f.runtime.session.prompt("Please read turn2.txt");
  const turn2Assistant = f.runtime.session.messages.findLast(m => m.role === "assistant");
  assert.equal(turn2Assistant?.role, "assistant");
  assert.equal(turn2Assistant?.stopReason, "stop");
  assert.equal(toolExecutions, 2);

  const delegated = admissions.filter(o => o.kind === "main" && o.outcome === "delegate");
  assert.equal(delegated.length, 4, "all 4 main/continuation requests delegated without duplicate rejection");
  assert(delegated.some(o => o.estimator === "pi-usage-backed" && o.estimateReason === "matching-receipt"),
    "usage receipt was successfully established and matched across tool loop");
});

test("stock Pi session: ambiguous duplicate pending calls, orphan results, mismatched tool names, unresolved calls reject locally before transport", async t => {
  // 1. Ambiguous duplicate pending calls in same assistant message
  {
    let callCount = 0;
    const f = await fixture({
      extras: [{
        name: "duplicate-pending",
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
      }],
    });
    t.after(() => f.close());
    f.respond(() => { callCount++; return fauxAssistantMessage("Must not call"); });
    await f.runtime.session.prompt("Trigger duplicate pending");
    assert.equal(callCount, 0);
    const last = f.runtime.session.messages.at(-1);
    assert(last?.role === "assistant" && last.stopReason === "error");
    assert.match(last.errorMessage ?? "", /Duplicate tool call ambig-id|Nunc local INPUT/);
  }

  // 2. Orphan result
  {
    let callCount = 0;
    const f = await fixture({
      extras: [{
        name: "orphan-test",
        factory(pi) {
          (pi as any).on("context", (event: { messages: unknown[] }) => ({
            messages: [...event.messages, { role: "toolResult", toolCallId: "nonexistent", toolName: "read", isError: false, content: [{ type: "text", text: "orphan" }], timestamp: 10 }],
          }));
        },
      }],
    });
    t.after(() => f.close());
    f.respond(() => { callCount++; return fauxAssistantMessage("No call"); });
    await f.runtime.session.prompt("Prompt with orphan");
    assert.equal(callCount, 0);
    const last = f.runtime.session.messages.at(-1);
    assert(last?.role === "assistant" && last.stopReason === "error");
    assert.match(last.errorMessage ?? "", /Orphan|Nunc local INPUT/);
  }

  // 3. Name-mismatched result
  {
    let callCount = 0;
    const f = await fixture({
      extras: [{
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
      }],
    });
    t.after(() => f.close());
    f.respond(() => { callCount++; return fauxAssistantMessage("No call"); });
    await f.runtime.session.prompt("Prompt with mismatch");
    assert.equal(callCount, 0);
    const last = f.runtime.session.messages.at(-1);
    assert(last?.role === "assistant" && last.stopReason === "error");
    assert.match(last.errorMessage ?? "", /mismatched|Nunc local INPUT/);
  }

  // 4. Duplicate result for same call
  {
    let callCount = 0;
    const f = await fixture({
      extras: [{
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
      }],
    });
    t.after(() => f.close());
    f.respond(() => { callCount++; return fauxAssistantMessage("No call"); });
    await f.runtime.session.prompt("Prompt with duplicate result");
    assert.equal(callCount, 0);
    const last = f.runtime.session.messages.at(-1);
    assert(last?.role === "assistant" && last.stopReason === "error");
    assert.match(last.errorMessage ?? "", /duplicate|Nunc local INPUT/);
  }

  // 5. Unresolved tool call at end of context
  {
    let callCount = 0;
    const f = await fixture({
      extras: [{
        name: "unresolved-test",
        factory(pi) {
          (pi as any).on("context", (event: { messages: unknown[] }) => ({
            messages: [
              ...event.messages,
              { role: "assistant", model: "large", api: "openai-completions", provider: "nunc-pi-fixture", stopReason: "toolUse", timestamp: 10, content: [{ type: "toolCall", id: "call-unresolved", name: "read", arguments: {} }] },
            ],
          }));
        },
      }],
    });
    t.after(() => f.close());
    f.respond(() => { callCount++; return fauxAssistantMessage("No call"); });
    await f.runtime.session.prompt("Prompt with unresolved call");
    assert.equal(callCount, 0);
    const last = f.runtime.session.messages.at(-1);
    assert(last?.role === "assistant" && last.stopReason === "error");
    assert.match(last.errorMessage ?? "", /Unresolved|Nunc local INPUT/);
  }
});

test("combined seam for all 4 native mapping families: stock Pi session tool loop -> Nunc admission/receipt -> native serialization -> controlled transport -> repeated-ID continuation", async t => {
  for (const adapter of nativeAdapters) {
    let toolExecs = 0;
    const toolParams: unknown[] = [];
    const tools = [{
      name: "read_fixture", label: "read_fixture", description: "Read a fixture file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: async (_toolCallId: string, params: unknown) => {
        toolExecs++;
        toolParams.push(params);
        return { content: [{ type: "text" as const, text: `Content of ${(params as any)?.path}` }], details: {} };
      },
    }];

    let httpRequests = 0;
    const bodies: unknown[] = [];
    let spec: ReturnType<typeof adapter.setup>;
    const transport: typeof fetch = async (resource, init) => {
      httpRequests++;
      const req = new Request(resource, init);
      let body: unknown;
      if (req.headers.get("content-encoding") === "zstd") {
        const raw = Buffer.from(await req.arrayBuffer());
        body = JSON.parse(zstdDecompressSync(raw).toString("utf8"));
      } else {
        body = await req.json();
      }
      bodies.push(body);
      if (httpRequests === 1) return spec.toolCallSSE("reused-call-id", "read_fixture", { path: "alpha.txt" });
      if (httpRequests === 2) return spec.textSSE("Done with alpha.");
      if (httpRequests === 3) return spec.toolCallSSE("reused-call-id", "read_fixture", { path: "beta.txt" });
      if (httpRequests === 4) return spec.textSSE("Done with beta.");
      return spec.textSSE("Default.");
    };

    spec = adapter.setup(transport);
    const cred = spec.isCodex ? oauthFixture() : undefined;
    const bound = { apiKey: cred ? cred.access : "offline-key", fetch: transport, transport: "sse" as const, maxRetries: 0 as const };
    const wrapped: Provider = {
      ...spec.provider,
      stream: (m, ctx, opt) => spec.provider.stream(m as never, ctx, { ...opt, ...bound } as never),
      streamSimple: (m, ctx, opt) => spec.provider.streamSimple(m as never, ctx, { ...opt, ...bound } as never),
    };

    const admissions: AdmissionObservation[] = [];
    const f = await fixture({
      tools,
      extras: [{
        name: "watch-admission",
        factory(pi) { pi.events.on("nunc:admission", value => admissions.push(value as AdmissionObservation)); },
      }],
    });
    t.after(() => f.close());

    new ModelRegistry(f.modelRuntime).registerProvider(wrapped);
    if (spec.isCodex && cred) {
      await f.credentials.modify(spec.model.provider, async () => cred);
    } else {
      await f.modelRuntime.setRuntimeApiKey(spec.model.provider, "offline-key");
    }
    await f.runtime.session.setModel(spec.model);

    // Turn 1 prompt -> tool execution -> tool continuation
    await f.runtime.session.prompt("Prompt 1: read alpha.txt");
    const a1 = f.runtime.session.messages.findLast(m => m.role === "assistant");
    assert.equal(a1?.role, "assistant");
    assert.equal(a1?.stopReason, "stop");
    assert.equal(a1?.errorMessage, undefined);
    assert.equal(toolExecs, 1);
    assert.deepEqual(toolParams[0], { path: "alpha.txt" });

    // Turn 2 prompt -> tool execution (reusing ID "reused-call-id") -> tool continuation
    await f.runtime.session.prompt("Prompt 2: read beta.txt");
    const a2 = f.runtime.session.messages.findLast(m => m.role === "assistant");
    assert.equal(a2?.role, "assistant");
    assert.equal(a2?.stopReason, "stop");
    assert.equal(a2?.errorMessage, undefined);
    assert.equal(toolExecs, 2);
    assert.deepEqual(toolParams[1], { path: "beta.txt" });

    // Verify exactly 4 HTTP requests reached transport
    assert.equal(httpRequests, 4, `expected exactly 4 HTTP requests on ${adapter.name}`);

    // Verify all admissions were delegated (no Duplicate tool call rejection)
    const delegates = admissions.filter(o => o.kind === "main" && o.outcome === "delegate");
    assert(delegates.length >= 4, `expected at least 4 delegated main admissions on ${adapter.name}`);

    // Verify captured wire body on request 4 (continuation of turn 2)
    const lastBody = bodies[3];
    const calls = spec.extractCalls(lastBody);
    const results = spec.extractResults(lastBody);
    assert.equal(calls.length, 2, `expected 2 tool calls in wire body on ${adapter.name}`);
    assert.equal(calls[0]?.id, "reused-call-id");
    assert.equal(calls[1]?.id, "reused-call-id");
    assert.deepEqual(calls[0]?.args, { path: "alpha.txt" });
    assert.deepEqual(calls[1]?.args, { path: "beta.txt" });

    assert.equal(results.length, 2, `expected 2 tool results in wire body on ${adapter.name}`);
    assert.equal(results[0]?.id, "reused-call-id");
    assert.equal(results[1]?.id, "reused-call-id");
    assert.match(JSON.stringify(results[0]?.content), /Content of alpha\.txt/);
    assert.match(JSON.stringify(results[1]?.content), /Content of beta\.txt/);
  }
});

test("negative matrix for all 4 native mapping families: both stream and streamSimple bound to controlled transport, positive delivery succeeds, then invalid association rejected before transport with zero HTTP sends", async t => {
  for (const adapter of nativeAdapters) {
    let httpCalls = 0;
    let spec: ReturnType<typeof adapter.setup>;
    const transport: typeof fetch = async () => {
      httpCalls++;
      return spec.textSSE("Positive delivery ok.");
    };

    spec = adapter.setup(transport);
    const cred = spec.isCodex ? oauthFixture() : undefined;
    const bound = { apiKey: cred ? cred.access : "offline-key", fetch: transport, transport: "sse" as const, maxRetries: 0 as const };
    const wrapped: Provider = {
      ...spec.provider,
      stream: (m, ctx, opt) => spec.provider.stream(m as never, ctx, { ...opt, ...bound } as never),
      streamSimple: (m, ctx, opt) => spec.provider.streamSimple(m as never, ctx, { ...opt, ...bound } as never),
    };

    let injectOrphan = false;
    const f = await fixture({
      extras: [{
        name: `test-injector-${adapter.name}`,
        factory(pi) {
          (pi as any).on("context", (event: { messages: unknown[] }) => {
            if (!injectOrphan) return;
            return {
              messages: [
                ...event.messages,
                { role: "toolResult", toolCallId: "orphan-id", toolName: "read", isError: false, content: [{ type: "text", text: "orphan" }], timestamp: 10 },
              ],
            };
          });
        },
      }],
    });
    t.after(() => f.close());

    new ModelRegistry(f.modelRuntime).registerProvider(wrapped);
    if (spec.isCodex && cred) {
      await f.credentials.modify(spec.model.provider, async () => cred);
    } else {
      await f.modelRuntime.setRuntimeApiKey(spec.model.provider, "offline-key");
    }
    await f.runtime.session.setModel(spec.model);

    // 1. Positive delivery: establish that the wrapped path with bound transport executes and sends HTTP
    await f.runtime.session.prompt("Positive prompt");
    const a1 = f.runtime.session.messages.findLast(m => m.role === "assistant");
    assert.equal(httpCalls, 1, `positive delivery must reach transport once on ${adapter.name}`);
    assert.equal(a1?.role, "assistant");
    assert.equal(a1?.stopReason, "stop");
    assert.equal(a1?.errorMessage, undefined);

    // 2. Negative delivery: inject orphan tool result and verify local rejection with zero additional HTTP sends
    injectOrphan = true;
    await f.runtime.session.prompt("Negative prompt with orphan");
    assert.equal(httpCalls, 1, `zero additional HTTP calls after invalid association rejection on ${adapter.name}`);
    const a2 = f.runtime.session.messages.findLast(m => m.role === "assistant");
    assert.equal(a2?.role, "assistant");
    assert.equal(a2?.stopReason, "error");
    assert.match(a2?.errorMessage || "", /Orphan|Nunc local INPUT/);
  }
});
