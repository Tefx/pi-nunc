import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall, type Model, type Provider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { Type } from "typebox";
import { ModelRegistry, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AdmissionObservation } from "../../src/pi/admission.js";
import { memorySurface } from "pi-nunc/pi";
import { fixture, memoryPatch } from "./fixtures.js";

const MARKER = "\n<turn-override>" + "Z".repeat(12000) + "</turn-override>";

function responsesSSE(modelId: string, text: string) {
  const item = { type: "message", id: "msg-1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: "response-1", model: modelId, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "response-1", model: modelId, status: "completed", output: [item], usage: { input_tokens: 80, output_tokens: 4, total_tokens: 84, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ];
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

function userMessages(f: Awaited<ReturnType<typeof fixture>>) {
  return f.runtime.session.sessionManager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user");
}
function customMessages(f: Awaited<ReturnType<typeof fixture>>, customType: string) {
  return f.runtime.session.sessionManager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === customType);
}
function mains(observations: AdmissionObservation[]) {
  return observations.filter(o => o.kind === "main");
}

async function receiptsFixture(t: { after: (fn: () => Promise<void>) => void }, extra?: {
  onStart?: (event: { systemPrompt: string }) => { systemPrompt: string } | undefined;
  payload?: (pi: ExtensionAPI) => void;
}) {
  const observations: AdmissionObservation[] = [];
  let api: ExtensionAPI | undefined;
  let ctx: ExtensionContext | undefined;
  let resolveSettled = () => {};
  let toolRuns = 0;
  let beforeStarts = 0;
  const f = await fixture({
    tools: [{
      name: "probe", label: "probe", description: "Return bounded offline test text",
      parameters: Type.Object({}),
      execute: async () => { toolRuns++; return { content: [{ type: "text" as const, text: "probe-ok" }], details: {} }; },
    }, {
      name: "other", label: "other", description: "Second tool for dynamic-tool mismatch",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text" as const, text: "other-ok" }], details: {} }),
    }],
    extras: [{ name: "request-receipts", factory(pi) {
      api = pi;
      pi.on("session_start", (_event, next) => { ctx = next; });
      pi.on("agent_settled", () => resolveSettled());
      pi.events.on("nunc:admission", value => observations.push(value as AdmissionObservation));
      pi.on("before_agent_start", event => {
        beforeStarts++;
        return extra?.onStart ? extra.onStart(event) : { systemPrompt: event.systemPrompt + MARKER };
      });
      extra?.payload?.(pi);
    } }],
  });
  t.after(() => f.close());
  f.respond((_context, options) => {
    if (options) options.cacheRetention = "none";
    return fauxAssistantMessage("Done.");
  });
  async function idle(content: string) {
    assert(api);
    const settled = new Promise<void>(resolve => { resolveSettled = resolve; });
    api.sendMessage({ customType: "idle-callback", content, display: true }, { triggerTurn: true, deliverAs: "steer" });
    await settled;
  }
  return {
    f, observations, idle,
    api: () => { assert(api); return api; },
    ctx: () => { assert(ctx); return ctx; },
    counts: () => ({ toolRuns, beforeStarts }),
  };
}

test("user then idle custom then real tool then second callback reuses the earlier compatible receipt", async t => {
  const env = await receiptsFixture(t);
  let turn = 0;
  env.f.respond((_context, options) => {
    if (options) options.cacheRetention = "none";
    turn++;
    if (turn === 2) return fauxAssistantMessage(fauxToolCall("probe", {}, { id: "probe-1" }), { stopReason: "toolUse" });
    return fauxAssistantMessage("Done.");
  });
  const usersBefore = userMessages(env.f).length;
  await env.f.runtime.session.prompt("First user task");
  const firstCall = env.f.calls[0];
  assert(firstCall?.systemPrompt?.includes("<turn-override>"));
  const firstAssistant = env.f.runtime.session.messages.find(message => message.role === "assistant");
  assert(firstAssistant?.role === "assistant");
  const firstUsage = firstAssistant.usage.totalTokens;
  assert(firstUsage > 2000);

  await env.idle("Completed child one.");
  assert.equal(env.f.calls.length, 3, "idle custom plus its tool continuation");
  assert(env.f.calls[1]?.systemPrompt?.includes("<turn-override>"), "first idle keeps leftover extended F");
  assert.equal(env.f.calls[1]?.systemPrompt, firstCall?.systemPrompt);
  assert(!env.f.calls[2]?.systemPrompt?.includes("<turn-override>"), "tool continuation uses base F");
  const toolAdmission = mains(env.observations).filter(o => o.outcome === "delegate").at(-1);
  assert.equal(toolAdmission?.hostPromptMatchesRequest, false, "stock getter can disagree with actual Context; Nunc still sent the actual F");
  const toolAssistant = [...env.f.runtime.session.messages].reverse().find(message => message.role === "assistant" && message.stopReason !== "toolUse");
  assert(toolAssistant?.role === "assistant");
  const lowUsage = toolAssistant.usage.totalTokens;
  assert(lowUsage < firstUsage, JSON.stringify({ firstUsage, lowUsage }));

  const beforeSecond = env.f.faux.state.callCount;
  await env.idle("Completed child two.");
  assert.equal(env.f.faux.state.callCount, beforeSecond + 1);
  const secondCall = env.f.calls.at(-1);
  assert(secondCall?.systemPrompt?.includes("<turn-override>"));
  assert.equal(secondCall?.systemPrompt, firstCall?.systemPrompt);
  const second = mains(env.observations).at(-1);
  assert.equal(second?.outcome, "delegate", JSON.stringify(second));
  assert.equal(second?.estimator, "pi-usage-backed");
  assert.equal(second?.estimateReason, "matching-receipt");
  assert(second?.inputTokens !== undefined && second.inputTokens >= firstUsage, JSON.stringify(second));
  assert(second.inputTokens! > lowUsage + 1000, "must not adopt the later incompatible low usage");
  assert(second.anchorTrailingMessages! >= 1);

  assert.equal(env.counts().beforeStarts, 1, "idle custom must not rerun before_agent_start");
  assert.equal(env.counts().toolRuns, 1);
  assert.equal(userMessages(env.f).length, usersBefore + 1, "sendMessage must not add user entries");
  assert.equal(customMessages(env.f, "idle-callback").length, 2);
  for (const call of env.f.calls) {
    assert.equal(call.systemPrompt, call === env.f.calls[2] ? env.f.calls[2]?.systemPrompt : firstCall?.systemPrompt);
  }
});

test("matching receipt still charges trailing growth and rejects a real over-limit with zero HTTP", async t => {
  const env = await receiptsFixture(t);
  await env.f.runtime.session.prompt("Prefix");
  const calls = env.f.faux.state.callCount;
  assert.equal(calls, 1);
  await env.idle("x".repeat(250000));
  const last = mains(env.observations).at(-1);
  assert.equal(last?.outcome, "reject");
  assert.equal(last?.code, "CAPACITY");
  assert.equal(env.f.faux.state.callCount, calls);
  const assistant = env.f.runtime.session.messages.at(-1);
  assert(assistant?.role === "assistant");
  assert.match(assistant.errorMessage ?? "", /exceeds main input limit/);
});

test("changed F with no matching receipt estimates freshly", async t => {
  let variant = "A";
  const env = await receiptsFixture(t, { onStart: event => ({ systemPrompt: event.systemPrompt + MARKER + variant }) });
  await env.f.runtime.session.prompt("First");
  variant = "B";
  await env.f.runtime.session.prompt("Second");
  const last = mains(env.observations).at(-1);
  assert.equal(last?.estimator, "pi-heuristic");
  assert.equal(last?.estimateReason, "system-mismatch");
  assert.equal(last?.outcome, "delegate");
});

test("failed and unissued responses do not become receipts", async t => {
  const env = await receiptsFixture(t);
  env.f.respond(() => fauxAssistantMessage("provider failed", { stopReason: "error", errorMessage: "controlled failure" }));
  await env.f.runtime.session.prompt("Will fail");
  assert.equal(env.f.faux.state.callCount, 1);
  env.f.respond((_context, options) => {
    if (options) options.cacheRetention = "none";
    return fauxAssistantMessage("Recovered.");
  });
  await env.f.runtime.session.prompt("After failure");
  const afterFail = mains(env.observations).at(-1);
  assert.equal(afterFail?.estimator, "pi-heuristic");
  assert.notEqual(afterFail?.estimateReason, "matching-receipt");

  let pad = true;
  const oversize = await receiptsFixture(t, {
    payload(pi) {
      pi.on("context", event => {
        if (!pad) return;
        pad = false;
        return { messages: [...event.messages, { role: "user", content: "n".repeat(320000), timestamp: 3 }] };
      });
    },
  });
  const before = oversize.f.faux.state.callCount;
  await oversize.f.runtime.session.prompt("tiny");
  assert.equal(oversize.f.faux.state.callCount, before);
  const rejected = mains(oversize.observations).at(-1);
  assert.equal(rejected?.outcome, "reject");
  assert.equal(rejected?.code, "CAPACITY");
  await oversize.f.runtime.session.prompt("small follow-up");
  const follow = mains(oversize.observations).at(-1);
  assert.equal(follow?.outcome, "delegate");
  assert.equal(follow?.estimator, "pi-heuristic");
});

test("newer incompatible F does not erase an earlier receipt, and eviction drops the oldest", async t => {
  let tag = 0;
  const env = await receiptsFixture(t, { onStart: event => ({ systemPrompt: event.systemPrompt + `\nF${tag}` }) });
  tag = 0;
  await env.f.runtime.session.prompt("keep-f0");
  const first = mains(env.observations).at(-1);
  assert.equal(first?.estimator, "pi-heuristic");
  for (let i = 1; i <= 8; i++) {
    tag = i;
    await env.f.runtime.session.prompt(`turn-${i}`);
  }
  tag = 0;
  await env.f.runtime.session.prompt("return-f0");
  const returned = mains(env.observations).at(-1);
  assert.equal(returned?.estimator, "pi-heuristic", "oldest receipt must be evicted after the in-process bound");
  assert.notEqual(returned?.estimateReason, "matching-receipt");
});

test("payload non-output change does not authorize that request or destroy an earlier receipt", async t => {
  let rewrite = false;
  let sends = 0;
  const openai = openaiProvider();
  const catalog = openai.getModels().find(m => m.id === "gpt-4.1");
  assert(catalog);
  const bound = {
    apiKey: "offline-fixture-key",
    fetch: (async (resource: RequestInfo | URL, init?: RequestInit) => {
      sends++;
      await new Request(resource, init).json();
      return responsesSSE(catalog.id, "Controlled native response.");
    }) as typeof fetch,
    maxRetries: 0 as const,
  };
  const wrapped: Provider = {
    ...openai,
    streamSimple: (model, context, options) => openai.streamSimple(model as Model<"openai-responses">, context, { ...options, ...bound }),
    stream: (model, context, options) => openai.stream(model as Model<"openai-responses">, context, { ...options, ...bound } as Parameters<typeof openai.stream>[2]),
  };
  const env = await receiptsFixture(t, { payload(pi) {
    pi.on("before_provider_request", event => {
      if (!rewrite || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;
      (event.payload as { temperature?: number }).temperature = 0;
    });
  } });
  new ModelRegistry(env.f.modelRuntime).registerProvider(wrapped);
  await env.f.modelRuntime.setRuntimeApiKey("openai", "offline-fixture-key");
  await env.f.runtime.session.setModel(catalog);
  await env.f.runtime.session.prompt("Establish");
  assert.equal(sends, 1);
  rewrite = true;
  await env.f.runtime.session.prompt("Metadata only");
  assert.equal(sends, 2);
  const mutated = mains(env.observations).filter(o => o.payload).at(-1);
  assert.equal(mutated?.outcome, "delegate");
  assert(mutated?.payload?.categories.includes("metadata"));
  rewrite = false;
  await env.f.runtime.session.prompt("Reuse earlier");
  assert.equal(sends, 3);
  const reuse = mains(env.observations).at(-1);
  assert.equal(reuse?.estimator, "pi-usage-backed");
  assert.equal(reuse?.estimateReason, "matching-receipt");
});

test("model, tools, compaction and manual M invalidate every receipt", async t => {
  const env = await receiptsFixture(t);
  await env.f.runtime.session.prompt("On large");
  await env.f.runtime.session.setModel(env.f.faux.getModel("small")!);
  await env.f.runtime.session.setModel(env.f.faux.getModel()!);
  await env.f.runtime.session.prompt("Back on large");
  const afterModel = mains(env.observations).at(-1);
  assert.equal(afterModel?.estimator, "pi-heuristic");

  env.api().setActiveTools(["probe"]);
  await env.f.runtime.session.prompt("Dropped other tool");
  const afterTools = mains(env.observations).at(-1);
  assert.equal(afterTools?.estimator, "pi-heuristic");
  assert.equal(afterTools?.estimateReason, "tools-mismatch");

  env.f.seed();
  env.f.respond(memoryPatch);
  await env.f.runtime.session.compact();
  env.f.respond((_context, options) => {
    if (options) options.cacheRetention = "none";
    return fauxAssistantMessage("After compact.");
  });
  await env.f.runtime.session.prompt("After compact");
  const afterCompact = mains(env.observations).at(-1);
  assert.equal(afterCompact?.estimator, "pi-heuristic");

  const memory = memorySurface(env.api());
  assert(memory);
  await env.f.runtime.session.prompt("Before save");
  const view = memory.read(env.ctx());
  if (view.memory.slots[0]) assert.equal(memory.replace(env.ctx(), view.revision, view.memory.slots[0].id, "Edited receipt cut").ok, true);
  await env.f.runtime.session.prompt("After save");
  const afterSave = mains(env.observations).at(-1);
  assert.equal(afterSave?.estimator, "pi-heuristic");
});
