import { test } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, normalizeContext, type Context, type TranscriptContext } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { googleVertexProvider } from "@earendil-works/pi-ai/providers/google-vertex";
import { boundedProvider, BudgetLedger, ledgerSummary, readLedger, callChargedTokens, callChargedCost, resolveBatchContext, readQualifiedLedgers, type CallRecord, type CallEnd } from "../../src/live/budget.js";
import { selectedModels } from "../../src/live/contract.js";
import { requestTokens } from "../../src/engine/accounting.js";
import { rolloverFacts, type RequestObservation, type RolloverObservation } from "../../src/live/comparison-observation.js";
import { fixture, repository } from "./fixtures.js";
function anthropicResponse(model: string, outputTokens = 4): Response {
  const events = [
    { type: "message_start", message: { id: "fixture", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Observed fixture." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens } }, { type: "message_stop" },
  ];
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
const context: TranscriptContext = normalizeContext({ systemPrompt: "Use available evidence.", messages: [{ role: "user", content: "Inspect the pending work.", timestamp: 1 }] });

test("bounded observations preserve sanitized tool sampling and count transcript system state once", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const model = selectedModels(input)[0]!;
    let sends = 0;
    const tools = [
      { name: "read", description: "Read evidence", parameters: Type.Object({}), constrainedSampling: { type: "json_schema" as const, strict: "require" as const } },
      { name: "write", description: "Write evidence", parameters: Type.Object({}), constrainedSampling: false as const },
      { name: "list", description: "List evidence", parameters: Type.Object({}) },
    ];
    const legacy = { systemPrompt: "Use available evidence.", tools, messages: context.messages.filter(m => m.role !== "system") } satisfies Context;
    const transcript = normalizeContext(legacy);
    const enriched = { ...transcript, tools: tools.map(tool => ({ ...tool, execute: async () => "local only" })) };
    const expectedTokens = requestTokens(transcript);
    assert.equal(requestTokens(legacy), expectedTokens);
    assert(requestTokens(enriched) > expectedTokens, "mixed Context accounts for its top-level tools");
    const contexts: Context[] = [], requests: RequestObservation[] = [];
    const ledger = new BudgetLedger(join(input.target.stateRoot, "observations.jsonl"), input.limits, Date.now() + 10000, new AbortController().signal);
    const provider = boundedProvider(anthropicProvider(), [model], ledger, {
      fetch: async () => { sends++; return anthropicResponse(model.id); },
      onContext: (_model, observed) => { contexts.push(observed); },
      onRequest: data => { requests.push({ ...data, turn: "a", thinking: null }); },
    });
    for (const simple of [true, false]) {
      const response = await (simple ? provider.streamSimple(model, enriched, { maxTokens: 1000, apiKey: "offline-fixture-key" }) : provider.stream(model, transcript, { maxTokens: 1000, apiKey: "offline-fixture-key" })).result();
      assert.equal(response.stopReason, "stop", response.errorMessage ?? "");
    }
    assert.equal(sends, 2);
    for (const observed of [...contexts, ...requests.map(r => r.context)]) {
      assert.deepEqual(observed.tools, structuredClone(tools));
      assert.equal(observed.messages.filter(m => m.role === "system").length, 1);
      assert.equal(requestTokens({ messages: observed.messages }), expectedTokens);
      assert(requestTokens(observed) > expectedTokens, "observation tools duplicate the transcript tool state");
    }
    assert.deepEqual(readLedger(ledger.path).filter(r => r.kind === "reserve").map(r => r.inputEstimate), [requestTokens(enriched), expectedTokens]);
    const settings = { enabled: true, reserveTokens: 8192, keepRecentTokens: 4000 };
    const row: RolloverObservation = { turn: "a", reason: "threshold", model, thinking: null, branch: [], active: [],
      config: { nunc: {}, compaction: settings },
      preparation: { firstKeptEntryId: "kept", settings, isSplitTurn: false, messagesToSummarize: [], turnPrefixMessages: [], tokensBefore: 0 },
      callIds: [1], continuationCallId: 2 };
    const facts = rolloverFacts(row, requests, "candidate");
    assert.equal(facts.finalContextTokens, expectedTokens);
    assert.equal(facts.remainingContextTokens, model.contextWindow - expectedTokens);
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});

test("mixed legacy prompt and tools with a later system message reject oversized input before reservation", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const faux = fauxProvider({ provider: "nunc-live-controlled", models: [{ id: "test", contextWindow: 1000, maxTokens: 8192 }] });
    const model = faux.getModel();
    const ledger = new BudgetLedger(join(input.target.stateRoot, "mixed.jsonl"), input.limits, Date.now() + 10000, new AbortController().signal);
    const mixed: Context = {
      systemPrompt: "x".repeat(3500),
      tools: [{ name: "read", description: "y".repeat(3500), parameters: Type.Object({}) }],
      messages: [
        { role: "user", content: "Inspect evidence.", timestamp: 1 },
        { role: "system", content: "Later instruction.", timestamp: 2 },
      ],
    };
    assert(requestTokens({ messages: mixed.messages }) < model.contextWindow);
    assert(requestTokens({ ...mixed, tools: [] }) > model.contextWindow, "legacy prompt contributes to admission");
    assert(requestTokens({ ...mixed, systemPrompt: "" }) > model.contextWindow, "legacy tools contribute to admission");
    assert.throws(() => ledger.reserve(model, mixed, 16), { code: "INPUT_LIMIT" });
    assert.deepEqual(ledger.readQualifiedCalls().calls, [], "rejected input creates no reservation");
    assert.equal(faux.state.callCount, 0);
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});

test("orphan terminals reject raw and qualified ledger reads; aggregate unresolved IDs retain ledger identity", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  const a = join(input.target.stateRoot, "a.jsonl"), b = join(input.target.stateRoot, "b.jsonl");
  const reserve: CallRecord = { kind: "reserve", id: 1, at: 1, model: "fixture", inputEstimate: 10, outputCeiling: 100, reservedTokens: 1000, reservedCostUsd: 1 };
  const terminal: CallEnd = { kind: "terminal", id: 1, at: 2, latencyMs: 1, stopReason: "stop", usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, contextInput: 10, reasoning: null, totalTokens: 30, cost: 0.1 } };
  try {
    const inA = { ...reserve, ledgerPath: a }, inB = { ...reserve, ledgerPath: b };
    assert.deepEqual(ledgerSummary([inA, inB]).unreconciledCallIds, [`${a}::1`, `${b}::1`]);
    assert.deepEqual(ledgerSummary([inA, inB, { ...terminal, ledgerPath: b }]).unreconciledCallIds, [`${a}::1`]);
    assert.throws(() => ledgerSummary([inA, { ...terminal, ledgerPath: b }]), /Orphan terminal/);
    await appendFile(a, JSON.stringify(reserve) + "\n");
    await appendFile(b, JSON.stringify(terminal) + "\n");
    assert.throws(() => readQualifiedLedgers([a, b]), /Orphan terminal/);
    await rm(b); await appendFile(b, JSON.stringify(reserve) + "\n");
    assert.deepEqual(ledgerSummary(readQualifiedLedgers([a, b])).unreconciledCallIds, [`${a}::1`, `${b}::1`]);
  } finally { await rm(input.target.stateRoot, { recursive: true, force: true }); }
});

test("real OpenAI adapter enforces serialized cap and stops on HTTP failure without retry or subsequent calls", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const base = openaiProvider(), model = base.getModels().find(m => m.id === "gpt-4.1"); assert(model);
    const ledger = new BudgetLedger(join(input.target.stateRoot, "calls.jsonl"), input.limits, Date.now() + 10000, new AbortController().signal);
    let requests = 0, observed: unknown;
    const transport: typeof fetch = async (resource, init) => {
      const request = new Request(resource, init); requests++;
      observed = { url: request.url, body: await request.json() };
      return new Response(JSON.stringify({ error: { message: "Controlled rate-limit response", type: "rate_limit_error" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "0" } });
    };
    const provider = boundedProvider(base, [model], ledger, { fetch: transport });
    const response = await provider.streamSimple(model, context, { maxTokens: 1000, apiKey: "sk-offline-fixture-key" }).result();
    assert.equal(response.stopReason, "error"); assert.equal(requests, 1, response.errorMessage ?? "No HTTP request");
    assert(observed && typeof observed === "object" && "url" in observed && "body" in observed);
    assert.equal(observed.url, "https://api.openai.com/v1/responses");
    const body = observed.body as Record<string, unknown>; assert.equal(body.max_output_tokens, 1000); assert.equal(body.model, "gpt-4.1");
    assert.equal((await provider.streamSimple(model, context, { maxTokens: 1000, apiKey: "sk-offline-fixture-key" }).result()).stopReason, "error"); assert.equal(requests, 1);
    assert.equal(ledgerSummary(readLedger(ledger.path)).costUsd, null);
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});

test("call/token/cost/time/output and unresolved-request ceilings reject before provider dispatch", async () => {
  for (const limit of ["call", "token", "cost", "time", "output", "unresolved"] as const) {
    const input = await fixture(); await mkdir(input.target.stateRoot);
    try {
      const faux = fauxProvider({ provider: "nunc-live-controlled", models: [{ id: "test", contextWindow: 60000, maxTokens: 8192 }] });
      const model = faux.getModel(); model.cost = { input: 10, output: 10, cacheRead: 5, cacheWrite: 20 };
      const limits = { ...input.limits, maxCalls: 1, maxOutputTokens: 4096, ...(limit === "token" ? { maxTotalTokens: 10 } : {}), ...(limit === "cost" ? { maxCostUsd: 0.001 } : {}) };
      const ledger = new BudgetLedger(join(input.target.stateRoot, "calls.jsonl"), limits, limit === "time" ? Date.now() - 1 : Date.now() + 10000, new AbortController().signal);
      if (limit === "call" || limit === "unresolved") { const reservation = ledger.reserve(model, context, 1000); if (limit === "call") ledger.finish(reservation, fauxAssistantMessage("finished")); }
      const provider = boundedProvider(faux.provider, [model], ledger);
      const result = await provider.streamSimple(model, context, { maxTokens: limit === "output" ? 8192 : 1000 }).result();
      assert.equal(result.stopReason, "error"); assert.equal(faux.state.callCount, 0, limit);
    } finally { await rm(input.target.stateRoot, { recursive: true }); }
  }
});
test("null call/token totals allow multiple reserves; explicit finite caps refuse before dispatch", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const faux = fauxProvider({ provider: "nunc-live-controlled", models: [{ id: "test", contextWindow: 60000, maxTokens: 8192 }] });
    const model = faux.getModel(); model.cost = { input: 10, output: 10, cacheRead: 5, cacheWrite: 20 };
    const open = { ...input.limits, maxCalls: null, maxTotalTokens: null, maxOutputTokens: 4096 };
    const ledger = new BudgetLedger(join(input.target.stateRoot, "open.jsonl"), open, Date.now() + 10000, new AbortController().signal);
    for (let i = 0; i < 3; i++) ledger.finish(ledger.reserve(model, context, 1000), fauxAssistantMessage("ok"));
    const summary = ledgerSummary(readLedger(ledger.path));
    assert.equal(summary.calls, 3);
    assert.equal(summary.reservedTokens, 3 * (60000 + 1000));
    assert.deepEqual(readLedger(ledger.path).filter(r => r.kind === "reserve").map(r => r.id), [1, 2, 3]);
    const callCap = new BudgetLedger(join(input.target.stateRoot, "call.jsonl"), { ...open, maxCalls: 1 }, Date.now() + 10000, new AbortController().signal);
    let callSends = 0;
    const callProvider = boundedProvider(faux.provider, [model], callCap, { fetch: async () => { callSends++; return new Response("no", { status: 400 }); } });
    callCap.finish(callCap.reserve(model, context, 1000), fauxAssistantMessage("ok"));
    assert.equal((await callProvider.streamSimple(model, context, { maxTokens: 1000 }).result()).stopReason, "error");
    assert.equal(callSends, 0); assert.equal(faux.state.callCount, 0);
    const tokenCap = new BudgetLedger(join(input.target.stateRoot, "token.jsonl"), { ...open, maxTotalTokens: 10 }, Date.now() + 10000, new AbortController().signal);
    let tokenSends = 0;
    const tokenProvider = boundedProvider(faux.provider, [model], tokenCap, { fetch: async () => { tokenSends++; return new Response("no", { status: 400 }); } });
    assert.equal((await tokenProvider.streamSimple(model, context, { maxTokens: 1000 }).result()).stopReason, "error");
    assert.equal(tokenSends, 0);
    const mixedCalls = new BudgetLedger(join(input.target.stateRoot, "mixed-calls.jsonl"), { ...open, maxCalls: 1, maxTotalTokens: null }, Date.now() + 10000, new AbortController().signal);
    mixedCalls.finish(mixedCalls.reserve(model, context, 1000), fauxAssistantMessage("ok"));
    assert.throws(() => mixedCalls.reserve(model, context, 1000), /Call ceiling/);
    const mixedTokens = new BudgetLedger(join(input.target.stateRoot, "mixed-tokens.jsonl"), { ...open, maxCalls: null, maxTotalTokens: 61000 }, Date.now() + 10000, new AbortController().signal);
    mixedTokens.finish(mixedTokens.reserve(model, context, 1000), fauxAssistantMessage("ok"));
    assert.throws(() => mixedTokens.reserve(model, context, 1000), /token authorization/);
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});
test("equal 500k context/output reserves window-plus-output without requiring simultaneous occupancy", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const faux = fauxProvider({ provider: "nunc-live-controlled", models: [{ id: "grok-like", contextWindow: 500000, maxTokens: 500000 }] });
    const grok = faux.getModel();
    grok.cost = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
    const limits = { maxCalls: 2, maxTotalTokens: 2_000_000, maxCostUsd: null, maxDurationMs: 10000, maxOutputTokens: 500000 };
    const ledger = new BudgetLedger(join(input.target.stateRoot, "calls.jsonl"), limits, Date.now() + 10000, new AbortController().signal);
    const record = ledger.reserve(grok, context, grok.maxTokens);
    assert.equal(record.outputCeiling, 500000);
    assert.equal(record.reservedTokens, 1_000_000);
    assert.equal(record.reservedCostUsd, null);
    assert(record.inputEstimate + record.outputCeiling > grok.contextWindow);
    ledger.finish(record, fauxAssistantMessage("ok"));
    const huge = { systemPrompt: "x".repeat(2000000), messages: [{ role: "user" as const, content: "y".repeat(1000), timestamp: 1 }] };
    const blocked = new BudgetLedger(join(input.target.stateRoot, "huge.jsonl"), limits, Date.now() + 10000, new AbortController().signal);
    assert.throws(() => blocked.reserve(grok, huge, 16), /input capacity|INPUT_LIMIT/);
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});
test("unknown usage remains null while full reservations survive restart; cached tokens count", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const model = selectedModels(input)[0]!, path = join(input.target.stateRoot, "calls.jsonl");
    const first = new BudgetLedger(path, input.limits, Date.now() + 10000, new AbortController().signal);
    const reserve = first.reserve(model, context, 1000);
    const message = fauxAssistantMessage("terminal");
    message.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    first.finish(reserve, message);
    const second = new BudgetLedger(path, input.limits, Date.now() + 10000, new AbortController().signal);
    const next = second.reserve(model, context, 1000);
    message.usage = { input: 10, output: 20, cacheRead: 500, cacheWrite: 100, totalTokens: 630, cost: { input: 0.001, output: 0.001, cacheRead: 0.001, cacheWrite: 0.001, total: 0.004 } };
    second.finish(next, message);
    const records = readLedger(path), summary = ledgerSummary(records);
    assert.equal(summary.reservedTokens, 402000); assert.equal(summary.totalTokens, null); assert.equal(summary.costUsd, null);
    const last = records.at(-1); assert(last?.kind === "terminal"); assert.equal(last.usage.contextInput, 610);
    await appendFile(path, '{"kind":'); assert.throws(() => readLedger(path), /Incomplete/);
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});
test("aborted authorization and changed model cannot call even controlled provider", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const faux = fauxProvider({ provider: "nunc-live-controlled", models: [{ id: "test", contextWindow: 60000, maxTokens: 8192 }] }), model = faux.getModel();
    const controller = new AbortController();
    const ledger = new BudgetLedger(join(input.target.stateRoot, "calls.jsonl"), input.limits, Date.now() + 10000, controller.signal);
    const provider = boundedProvider(faux.provider, [model], ledger);
    const changed = await provider.streamSimple({ ...model, contextWindow: 80000 }, context).result();
    assert.equal(changed.stopReason, "error");
    assert.match(changed.errorMessage ?? "", /Request changed its authorized model/);
    assert.equal(faux.state.callCount, 0);
    controller.abort();
    const aborted = await provider.streamSimple(model, context).result();
    assert.equal(aborted.stopReason, "error");
    assert.match(aborted.errorMessage ?? "", /CANCELLED/);
    assert.equal(faux.state.callCount, 0);
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});
test("real Anthropic adapter uses bounded fetch, exact serialized output cap, no retries, and a terminal usage receipt", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const model = selectedModels(input)[0]!, ledger = new BudgetLedger(join(input.target.stateRoot, "calls.jsonl"), input.limits, Date.now() + 10000, new AbortController().signal);
    let requests = 0;
    let transportError: unknown;
    const transport: typeof fetch = async (resource, init) => {
      try {
      const request = new Request(resource, init); requests++;
      assert.equal(request.url, "https://api.anthropic.com/v1/messages?beta=true");
      const payload = await request.json(); assert.equal(payload.max_tokens, 1000); assert.equal(payload.model, model.id); assert.equal(payload.stream, true);
      assert.equal(init?.redirect, "error");
      const events = [
        { type: "message_start", message: { id: "fixture", type: "message", role: "assistant", model: model.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Observed fixture." } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }, { type: "message_stop" },
      ];
      return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
      } catch (error) { transportError = error; throw error; }
    };
    const provider = boundedProvider(anthropicProvider(), [model], ledger, { fetch: transport });
    const response = await provider.streamSimple(model, context, { maxTokens: 1000, apiKey: "offline-fixture-key" }).result();
    assert.equal(transportError, undefined); assert.equal(requests, 1); assert.equal(response.stopReason, "stop", response.errorMessage ?? "");
    const summary = ledgerSummary(readLedger(ledger.path)); assert.equal(summary.calls, 1); assert.equal(summary.input, 12); assert.equal(summary.output, 4); assert.deepEqual(summary.unreconciledCallIds, []);
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});

test("trustworthy complete terminal actual usage settles unused token reserve and admits second call under finite cap", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const faux = fauxProvider({ provider: "nunc-live-controlled", models: [{ id: "luna-like", contextWindow: 1050000, maxTokens: 128000 }] });
    const model = faux.getModel();
    model.cost = { input: 0.25, output: 1.0, cacheRead: 0.05, cacheWrite: 0.25 };
    const limits = { maxCalls: 10, maxTotalTokens: 2000000, maxCostUsd: 20, maxDurationMs: 60000, maxOutputTokens: 128000 };
    const ledger = new BudgetLedger(join(input.target.stateRoot, "settle.jsonl"), limits, Date.now() + 60000, new AbortController().signal);

    // Call 1 reserves full 1,178,000 tokens
    const call1 = ledger.reserve(model, context, 128000);
    assert.equal(call1.reservedTokens, 1178000);
    assert.equal(typeof call1.reservedCostUsd, "number");

    // Call 1 completes cleanly with small actual usage (1255 tokens, $0.00034875)
    const msg1 = fauxAssistantMessage("call 1 ok");
    msg1.usage = { input: 3, output: 37, cacheRead: 0, cacheWrite: 1215, totalTokens: 1255, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.00034875 } };
    ledger.finish(call1, msg1);

    // Verify summary distinguishes actual, reserved, charged, and remaining
    const summary1 = ledgerSummary(readLedger(ledger.path), limits);
    assert.equal(summary1.calls, 1);
    assert.equal(summary1.reservedTokens, 1178000);
    assert.equal(summary1.chargedTokens, 1255, "trustworthy terminal settled unused reserve");
    assert.equal(summary1.actualTokens, 1255);
    assert.equal(summary1.costUsd, 0.00034875);
    assert.equal(summary1.chargedCostUsd, 0.00034875);
    assert.equal(summary1.remainingTokens, 2000000 - 1255);
    assert.equal(summary1.activeReservedTokens, 0);
    assert.deepEqual(summary1.unreconciledCallIds, []);

    // Call 2 can now reserve 1,178,000 tokens because 1255 + 1178000 = 1179255 <= 2000000!
    // (Under the un-repaired algorithm, this threw TOKEN_LIMIT because 1178000 + 1178000 > 2000000)
    const call2 = ledger.reserve(model, context, 128000);
    assert.equal(call2.id, 2);
    assert.equal(call2.reservedTokens, 1178000);

    // Call 2 completes cleanly with 2500 tokens
    const msg2 = fauxAssistantMessage("call 2 ok");
    msg2.usage = { input: 2000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 2500, cost: { input: 0.0005, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.001 } };
    ledger.finish(call2, msg2);

    const summary2 = ledgerSummary(readLedger(ledger.path), limits);
    assert.equal(summary2.calls, 2);
    assert.equal(summary2.reservedTokens, 2356000);
    assert.equal(summary2.chargedTokens, 1255 + 2500);
    assert.equal(summary2.actualTokens, 3755);
    assert.equal(summary2.costUsd, 0.00034875 + 0.001);
    assert.equal(summary2.remainingTokens, 2000000 - 3755);

    // Call 3 is also admitted under 2,000,000 token limit because 3755 + 1178000 <= 2000000
    const call3 = ledger.reserve(model, context, 128000);
    assert.equal(call3.id, 3);
    ledger.finish(call3, msg2);
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});

test("active in-flight call retains full worst-case reserve coverage and blocks concurrent/unreconciled calls", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const faux = fauxProvider({ provider: "nunc-live-controlled", models: [{ id: "test", contextWindow: 60000, maxTokens: 8192 }] });
    const model = faux.getModel();
    model.cost = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
    const limits = { maxCalls: 10, maxTotalTokens: 100000, maxCostUsd: null, maxDurationMs: 10000, maxOutputTokens: 8192 };
    const path = join(input.target.stateRoot, "active.jsonl");
    const ledger = new BudgetLedger(path, limits, Date.now() + 10000, new AbortController().signal);

    const call1 = ledger.reserve(model, context, 8192); // reserves 68,192 tokens
    assert.equal(call1.reservedTokens, 68192);

    // Active ledger blocks concurrency
    assert.throws(() => ledger.reserve(model, context, 8192), /Concurrent model calls are unsupported|CONCURRENCY/);

    // A fresh ledger instance reading the file sees the unreconciled active call
    const ledger2 = new BudgetLedger(path, limits, Date.now() + 10000, new AbortController().signal);
    assert.throws(() => ledger2.reserve(model, context, 8192), /has no terminal receipt|RECONCILIATION/);

    // Summary reflects active reserved tokens
    const summary = ledgerSummary(readLedger(path), limits);
    assert.equal(summary.calls, 1);
    assert.equal(summary.activeReservedTokens, 68192);
    assert.equal(summary.chargedTokens, 68192, "in-flight call remains covered worst-case");
    assert.deepEqual(summary.unreconciledCallIds, [1]);
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});

test("missing, unknown, interrupted, error, or aborted usage does not release token reserve", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const faux = fauxProvider({ provider: "nunc-live-controlled", models: [{ id: "test", contextWindow: 60000, maxTokens: 8192 }] });
    const model = faux.getModel();
    model.cost = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
    const limits = { maxCalls: 10, maxTotalTokens: 100000, maxCostUsd: null, maxDurationMs: 10000, maxOutputTokens: 8192 };

    // Case A: unknown usage (totalTokens is null)
    const pathA = join(input.target.stateRoot, "unknown-usage.jsonl");
    const ledgerA = new BudgetLedger(pathA, limits, Date.now() + 10000, new AbortController().signal);
    const rA = ledgerA.reserve(model, context, 8192); // 68,192 tokens
    const msgUnknown = fauxAssistantMessage("unknown");
    msgUnknown.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    ledgerA.finish(rA, msgUnknown); // observeUsage turns all-zero to nulls
    const sumA = ledgerSummary(readLedger(pathA), limits);
    assert.equal(sumA.chargedTokens, 68192, "unknown usage does NOT release reserve");
    // Under 100,000 cap: 68192 + 68192 = 136384 > 100000 -> rejected!
    assert.throws(() => ledgerA.reserve(model, context, 8192), (err: any) => err.code === "TOKEN_LIMIT");

    // Case B: error stopReason
    const pathB = join(input.target.stateRoot, "error-stop.jsonl");
    const ledgerB = new BudgetLedger(pathB, limits, Date.now() + 10000, new AbortController().signal, "case-b");
    const rB = ledgerB.reserve(model, context, 8192);
    const msgError = fauxAssistantMessage("failed");
    msgError.stopReason = "error";
    ledgerB.finish(rB, msgError);
    assert.equal(callChargedTokens(rB, [readLedger(pathB).find((r): r is CallEnd => r.kind === "terminal")!]), 68192);
    assert.throws(() => ledgerB.reserve(model, context, 8192), (err: any) => err.code === "TERMINAL_FAILURE");

    // Case C: aborted stopReason
    const pathC = join(input.target.stateRoot, "aborted-stop.jsonl");
    const ledgerC = new BudgetLedger(pathC, limits, Date.now() + 10000, new AbortController().signal, "case-c");
    const rC = ledgerC.reserve(model, context, 8192);
    const msgAborted = fauxAssistantMessage("aborted");
    msgAborted.stopReason = "aborted";
    ledgerC.finish(rC, msgAborted);
    assert.equal(callChargedTokens(rC, [readLedger(pathC).find((r): r is CallEnd => r.kind === "terminal")!]), 68192);
    assert.throws(() => ledgerC.reserve(model, context, 8192), (err: any) => err.code === "TERMINAL_FAILURE");
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});

test("unknown cost never settles to 0; token settlement does not imply known cost", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const faux = fauxProvider({ provider: "nunc-live-controlled", models: [{ id: "cost-model", contextWindow: 60000, maxTokens: 8192 }] });
    const model = faux.getModel();
    model.cost = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };
    // Model reservation cost: (60000 * 10 + 8192 * 10) / 1e6 = 0.68192 USD
    const limits = { maxCalls: 10, maxTotalTokens: 2000000, maxCostUsd: 1.0, maxDurationMs: 10000, maxOutputTokens: 8192 };
    const ledger = new BudgetLedger(join(input.target.stateRoot, "cost.jsonl"), limits, Date.now() + 10000, new AbortController().signal);

    const call1 = ledger.reserve(model, context, 8192);
    assert.equal(call1.reservedCostUsd, 0.68192);

    // Call 1 finishes with known token usage (1000 tokens), but NO cost report (cost: null)
    const msg = fauxAssistantMessage("ok");
    msg.usage = { input: 500, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1000, cost: undefined as any };
    ledger.finish(call1, msg);

    const summary = ledgerSummary(readLedger(ledger.path), limits);
    assert.equal(summary.chargedTokens, 1000, "token reserve settled to actual");
    assert.equal(summary.costUsd, null, "actual cost remains null");
    assert.equal(summary.chargedCostUsd, 0.68192, "unknown cost cannot settle to 0; remains covered worst-case");

    // Call 2 needs 0.68192 USD. 0.68192 + 0.68192 = 1.36384 > 1.0 USD ceiling!
    // It must be rejected with COST_LIMIT before transport!
    assert.throws(() => ledger.reserve(model, context, 8192), (err: any) => err.code === "COST_LIMIT");
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});

test("duplicate or inconsistent terminal records cannot undercharge and keep worst-case reservation", () => {
  const r: CallRecord = {
    kind: "reserve", id: 1, model: "test/model", inputEstimate: 100, outputCeiling: 8192,
    reservedTokens: 68192, reservedCostUsd: 0.68192, at: Date.now()
  };

  // Single trustworthy terminal settles
  const tClean: CallEnd = {
    kind: "terminal", id: 1, at: Date.now(), latencyMs: 100, stopReason: "stop",
    usage: { input: 50, output: 50, cacheRead: 0, cacheWrite: 0, contextInput: 50, reasoning: null, totalTokens: 100, cost: 0.001 }
  };
  assert.equal(callChargedTokens(r, [tClean]), 100);
  assert.equal(callChargedCost(r, [tClean]), 0.001);

  // Duplicate terminals cannot undercharge: must return worst-case reservedTokens
  const tDup: CallEnd = {
    kind: "terminal", id: 1, at: Date.now(), latencyMs: 200, stopReason: "stop",
    usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, contextInput: 10, reasoning: null, totalTokens: 20, cost: 0.0002 }
  };
  assert.equal(callChargedTokens(r, [tClean, tDup]), 68192);
  assert.equal(callChargedCost(r, [tClean, tDup]), 0.68192);

  // Inconsistent / invalid terminal (tokens exceed reservation)
  const tExceed: CallEnd = {
    kind: "terminal", id: 1, at: Date.now(), latencyMs: 100, stopReason: "stop",
    usage: { input: 100000, output: 100000, cacheRead: 0, cacheWrite: 0, contextInput: 100000, reasoning: null, totalTokens: 200000, cost: 2.0 }
  };
  assert.equal(callChargedTokens(r, [tExceed]), 68192);
  assert.equal(callChargedCost(r, [tExceed]), 2.0, "actual cost above reserve must remain charged");

  // Incomplete or zero-default usage: { totalTokens: 0, contextInput: null, output: null }
  const tZeroDefault: CallEnd = {
    kind: "terminal", id: 1, at: Date.now(), latencyMs: 100, stopReason: "stop",
    usage: { input: null, output: null, cacheRead: null, cacheWrite: null, contextInput: null, reasoning: null, totalTokens: 0, cost: null }
  };
  assert.equal(callChargedTokens(r, [tZeroDefault]), 68192, "zero-default usage cannot release reserve");

  // Inconsistent components: contextInput + output !== totalTokens
  const tInconsistentSum: CallEnd = {
    kind: "terminal", id: 1, at: Date.now(), latencyMs: 100, stopReason: "stop",
    usage: { input: null, output: 400, cacheRead: null, cacheWrite: null, contextInput: 500, reasoning: null, totalTokens: 1000, cost: 0.001 }
  };
  assert.equal(callChargedTokens(r, [tInconsistentSum]), 68192, "inconsistent total sum cannot release reserve");

  // Inconsistent subcomponents: input + cacheRead + cacheWrite !== contextInput
  const tInconsistentSub: CallEnd = {
    kind: "terminal", id: 1, at: Date.now(), latencyMs: 100, stopReason: "stop",
    usage: { input: 500, output: 200, cacheRead: 100, cacheWrite: 100, contextInput: 800, reasoning: null, totalTokens: 1000, cost: 0.001 }
  };
  assert.equal(callChargedTokens(r, [tInconsistentSub]), 68192, "inconsistent cache subcomponents cannot release reserve");

  // Partial subcomponents: missing input
  const tPartialSub: CallEnd = {
    kind: "terminal", id: 1, at: Date.now(), latencyMs: 100, stopReason: "stop",
    usage: { input: null, output: 200, cacheRead: 100, cacheWrite: 100, contextInput: 800, reasoning: null, totalTokens: 1000, cost: 0.001 }
  };
  assert.equal(callChargedTokens(r, [tPartialSub]), 68192, "partial subcomponent metadata cannot release reserve");

  // Unknown or zero cost when rate is non-zero
  const tZeroCost: CallEnd = {
    kind: "terminal", id: 1, at: Date.now(), latencyMs: 100, stopReason: "stop",
    usage: { input: 50, output: 50, cacheRead: 0, cacheWrite: 0, contextInput: 50, reasoning: null, totalTokens: 100, cost: 0 }
  };
  assert.equal(callChargedCost(r, [tZeroCost]), 0.68192, "unknown zero cost cannot settle against positive reservation");
});

test("shared batch accounting across invocations/comparison preserves cumulative usage and caps", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const faux = fauxProvider({ provider: "nunc-live-controlled", models: [{ id: "batch-model", contextWindow: 60000, maxTokens: 8192 }] });
    const model = faux.getModel();
    model.cost = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
    const run1Dir = join(input.target.stateRoot, "run1"); await mkdir(run1Dir);
    const run2Dir = join(input.target.stateRoot, "run2"); await mkdir(run2Dir);
    const run1Path = join(run1Dir, "calls.jsonl");
    const run2Path = join(run2Dir, "calls.jsonl");

    // Invocation 1: makes 1 call with actual usage 1255 tokens
    const limits = { maxCalls: 2, maxTotalTokens: 100000, maxCostUsd: null, maxDurationMs: 60000, maxOutputTokens: 8192 };
    const ledger1 = new BudgetLedger(run1Path, limits, Date.now() + 60000, new AbortController().signal);
    const r1 = ledger1.reserve(model, context, 8192);
    assert.equal(r1.id, 1);
    const msg1 = fauxAssistantMessage("invocation 1 done");
    msg1.usage = { input: 1000, output: 255, cacheRead: 0, cacheWrite: 0, totalTokens: 1255, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } as any };
    delete (msg1.usage as any).cost;
    ledger1.finish(r1, msg1);

    // Invocation 2: starts with run2Path and priorLedgerPaths = [run1Path]
    const ledger2 = new BudgetLedger(run2Path, limits, Date.now() + 60000, new AbortController().signal, undefined, [run1Path]);
    const { calls: qualifiedBefore } = ledger2.readQualifiedCalls();
    assert.equal(qualifiedBefore.length, 1, "reads prior reserve and terminal records with ledger qualification");

    // Call in Invocation 2 receives id: 1 in its own file, but cumulative calls is 2
    const r2 = ledger2.reserve(model, context, 8192);
    assert.equal(r2.id, 1, "own file ID is 1");
    assert.equal(r2.reservedTokens, 68192);

    // Admitted because 1255 (settled) + 68192 <= 100,000!
    const msg2 = fauxAssistantMessage("invocation 2 done");
    msg2.usage = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } as any };
    delete (msg2.usage as any).cost;
    ledger2.finish(r2, msg2);

    // Now total cumulative calls across batch is 2 (reaching maxCalls: 2).
    // A 3rd call in Invocation 2 MUST be refused with CALL_LIMIT!
    assert.throws(() => ledger2.reserve(model, context, 8192), /CALL_LIMIT|Call ceiling/);

    // Summary across all records reflects cumulative usage
    const summary = ledgerSummary(ledger2.readQualifiedCalls().calls, limits);
    assert.equal(summary.calls, 2);
    assert.equal(summary.chargedTokens, 1255 + 1500);
    assert.equal(summary.actualTokens, 2755);
    assert.equal(summary.remainingCalls, 0);

    // Test ledger-qualified identity isolation:
    // If File A has call 1 (unresolved), and File B has call 1 (completed),
    // File B's terminal cannot settle File A's reserve!
    const runADir = join(input.target.stateRoot, "runA"); await mkdir(runADir);
    const runBDir = join(input.target.stateRoot, "runB"); await mkdir(runBDir);
    const runAPath = join(runADir, "calls.jsonl");
    const runBPath = join(runBDir, "calls.jsonl");
    const ledgerA = new BudgetLedger(runAPath, limits, Date.now() + 60000, new AbortController().signal);
    ledgerA.reserve(model, context, 8192); // reserve 1 in A with NO terminal
    const ledgerB = new BudgetLedger(runBPath, limits, Date.now() + 60000, new AbortController().signal);
    const rB1 = ledgerB.reserve(model, context, 8192); // reserve 1 in B
    ledgerB.finish(rB1, msg1); // terminal 1 in B

    // Loading File A as prior to a new run must fail with RECONCILIATION because A is unresolved
    const runCDir = join(input.target.stateRoot, "runC"); await mkdir(runCDir);
    const runCPath = join(runCDir, "calls.jsonl");
    const ledgerC = new BudgetLedger(runCPath, limits, Date.now() + 60000, new AbortController().signal, undefined, [runAPath, runBPath]);
    assert.throws(() => ledgerC.reserve(model, context, 8192), (err: any) => err.code === "RECONCILIATION");

    // Missing declared prior file must block with LEDGER error, not silently skip
    assert.throws(
      () => new BudgetLedger(runCPath, limits, Date.now() + 60000, new AbortController().signal, undefined, ["/path/does/not/exist.jsonl"]),
      (err: any) => err.code === "LEDGER_RECONCILIATION"
    );

    // Shuffled prior files find earliest historical dispatch
    const contextBatch = resolveBatchContext({
      ...input,
      batch: { priorLedgers: [runBPath, run1Path] },
      limits: { ...limits, maxDurationMs: 60000 },
    });
    assert(contextBatch.firstDispatchAt !== null);

    // Explicit timestamp later than history is rejected
    assert.throws(
      () => resolveBatchContext({
        ...input,
        batch: { firstDispatchAt: Date.now() + 100000, priorLedgers: [run1Path] },
        limits: { ...limits, maxDurationMs: 60000 },
      }),
      (err: any) => err.code === "BATCH"
    );
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});

test("prior append-only receipts are compatible and never modified across invocations", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const faux = fauxProvider({ provider: "nunc-live-controlled", models: [{ id: "test", contextWindow: 60000, maxTokens: 8192 }] });
    const model = faux.getModel();
    model.cost = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
    const run1Dir = join(input.target.stateRoot, "run1"); await mkdir(run1Dir);
    const run2Dir = join(input.target.stateRoot, "run2"); await mkdir(run2Dir);
    const run1Path = join(run1Dir, "calls.jsonl");
    const run2Path = join(run2Dir, "calls.jsonl");

    const limits = { maxCalls: 5, maxTotalTokens: 200000, maxCostUsd: null, maxDurationMs: 60000, maxOutputTokens: 8192 };
    const ledger1 = new BudgetLedger(run1Path, limits, Date.now() + 60000, new AbortController().signal);
    const r1 = ledger1.reserve(model, context, 8192);
    ledger1.finish(r1, fauxAssistantMessage("ok"));

    const contentBefore = await readFile(run1Path, "utf8");
    const hashBefore = createHash("sha256").update(contentBefore).digest("hex");

    // Second run links to prior ledger
    const ledger2 = new BudgetLedger(run2Path, limits, Date.now() + 60000, new AbortController().signal, undefined, [run1Path]);
    const r2 = ledger2.reserve(model, context, 8192);
    ledger2.finish(r2, fauxAssistantMessage("ok 2"));

    const contentAfter = await readFile(run1Path, "utf8");
    const hashAfter = createHash("sha256").update(contentAfter).digest("hex");
    assert.equal(hashBefore, hashAfter, "prior ledger was never rewritten or modified");

    // Original behavior-batch-01 reserve/terminal receipts, copied without
    // transformation from the retained canonical run ledger into a portable fixture.
    // Provenance: .scratch/task-retention-evidence/retained-live/behavior-batch-01/
    // nunc-live-retention-01/calls.jsonl in the original pi-nunc checkout.
    const realRecords = readLedger(join(repository, "tests/live/fixtures/behavior-batch-01-calls.jsonl"));
    assert.equal(realRecords.length, 2);
    assert(realRecords[0] && realRecords[0].kind === "reserve");
    assert(realRecords[1] && realRecords[1].kind === "terminal");
    const realSummary = ledgerSummary(realRecords);
    assert.equal(realSummary.calls, 1);
    assert.equal(realSummary.reservedTokens, 1178000);
    assert.equal(realSummary.chargedTokens, 1255);
    assert.equal(realSummary.actualTokens, 1255);
    assert.equal(realSummary.costUsd, 0.00034875);
    assert.equal(realSummary.chargedCostUsd, 0.00034875);
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});

test("wallclock deadline from first dispatch and interval elapsed time; expired authorization refuses before transport", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const faux = fauxProvider({ provider: "nunc-live-controlled", models: [{ id: "test", contextWindow: 60000, maxTokens: 8192 }] });
    const model = faux.getModel();
    model.cost = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };

    // Case A: Expired authorization refuses before transport
    const expiredDispatchAt = Date.now() - 3700000; // 61 minutes ago
    const limitsExpired = { maxCalls: 10, maxTotalTokens: 200000, maxCostUsd: null, maxDurationMs: 3600000, maxOutputTokens: 8192, firstDispatchAt: expiredDispatchAt };
    const batchContextA = resolveBatchContext({ ...input, limits: limitsExpired });
    assert(batchContextA.deadline <= Date.now(), "deadline is in the past");

    const ledgerExpired = new BudgetLedger(join(input.target.stateRoot, "expired.jsonl"), limitsExpired, batchContextA.deadline, new AbortController().signal);
    assert.throws(() => ledgerExpired.reserve(model, context, 8192), /TIME_LIMIT|deadline reached/);

    // Case B: Unexpired authorization calculates elapsed time from first dispatch
    const pastDispatchAt = Date.now() - 60000; // 1 minute ago
    const limitsUnexpired = { maxCalls: 10, maxTotalTokens: 200000, maxCostUsd: null, maxDurationMs: 3600000, maxOutputTokens: 8192, firstDispatchAt: pastDispatchAt };
    const batchContextB = resolveBatchContext({ ...input, limits: limitsUnexpired });
    assert(batchContextB.deadline > Date.now(), "deadline is in the future");
    assert.equal(batchContextB.firstDispatchAt, pastDispatchAt);

    const ledgerUnexpired = new BudgetLedger(join(input.target.stateRoot, "unexpired.jsonl"), limitsUnexpired, batchContextB.deadline, new AbortController().signal);
    const r = ledgerUnexpired.reserve(model, context, 8192);
    assert.equal(r.id, 1);
    ledgerUnexpired.finish(r, fauxAssistantMessage("ok"));

    const elapsed = Date.now() - batchContextB.firstDispatchAt!;
    assert(elapsed >= 60000, "elapsed time includes interval before invocation");
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});

test("duplicate terminal on one call cannot conceal another call's missing terminal", () => {
  const reserve: CallRecord = { kind: "reserve", id: 1, at: 1, model: "test/model", inputEstimate: 10, outputCeiling: 100, reservedTokens: 1000, reservedCostUsd: null };
  const terminal: CallEnd = { kind: "terminal", id: 1, at: 2, latencyMs: 1, stopReason: "stop", usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, contextInput: 10, reasoning: null, totalTokens: 30, cost: null } };
  const summary = ledgerSummary([reserve, { ...reserve, id: 2 }, terminal, { ...terminal }]);
  assert.equal(summary.actualTokens, null);
  assert.equal(summary.input, null);
  assert.equal(summary.output, null);
  assert.deepEqual(summary.unreconciledCallIds, [2]);
});

test("controlled usage overflow preserves an unresolved reservation without a synthetic local terminal", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const model = selectedModels(input)[0]!;
    const ledger = new BudgetLedger(join(input.target.stateRoot, "overflow.jsonl"), input.limits, Date.now() + 10000, new AbortController().signal);
    const provider = boundedProvider(anthropicProvider(), [model], ledger, { fetch: async () => anthropicResponse(model.id, 1250) });
    const response = await provider.streamSimple(model, context, { maxTokens: 1000, apiKey: "offline-fixture-key" }).result();
    assert.equal(response.stopReason, "error");
    assert.match(response.errorMessage ?? "", /USAGE_LIMIT/);
    assert.equal(readLedger(ledger.path).length, 1);
    assert.deepEqual(ledgerSummary(readLedger(ledger.path)).unreconciledCallIds, [1]);
    assert.throws(() => ledger.reserve(model, context, 1000), /Concurrent model calls|terminal receipt/);
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});

test("requireThinkingLevel inspects trailing configuration_update effort on openai-responses and falls back to top-level effort", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const base = openaiProvider();
    const catalog = base.getModels().find(m => m.id === "gpt-5.4");
    assert(catalog);
    const model = { ...catalog, reasoning: true };
    const limits = { ...input.limits, maxCalls: 10, maxTotalTokens: 1000000, maxOutputTokens: 16384 };
    const ledger = new BudgetLedger(join(input.target.stateRoot, "thinking.jsonl"), limits, Date.now() + 10000, new AbortController().signal);
    const sseOk = () => new Response(
      [
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"type":"message","id":"msg_1","status":"completed","role":"assistant","content":[{"type":"output_text","text":"ok","annotations":[]}]}],"usage":{"input_tokens":10,"input_tokens_details":{"cached_tokens":0},"output_tokens":5,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":15}}}',
        '',
        '',
      ].join("\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );
    let sends = 0;
    const provider = boundedProvider(base, [model], ledger, {
      requireThinkingLevel: "low",
      fetch: async () => { sends++; return sseOk(); },
    });

    // 1. Mid-convo configuration_update with effort "low" while top-level reasoning.effort is "medium" -> accepted
    const okMsg = await provider.streamSimple(model, context, {
      maxTokens: 1000,
      reasoning: "low",
      apiKey: "sk-offline-fixture-key",
      onPayload: (payload) => {
        const body = payload as Record<string, any>;
        body.reasoning = { effort: "medium" };
        body.input = [...(Array.isArray(body.input) ? body.input : []), { type: "configuration_update", reasoning: { effort: "low" } }];
        return body;
      },
    }).result();
    assert.equal(okMsg.stopReason, "stop", okMsg.errorMessage ?? "expected stop");
    assert.equal(sends, 1);

    // 2. Top-level reasoning.effort without configuration_update -> accepted when matching "low"
    const topOkMsg = await provider.streamSimple(model, context, {
      maxTokens: 1000,
      reasoning: "low",
      apiKey: "sk-offline-fixture-key",
      onPayload: (payload) => {
        const body = payload as Record<string, any>;
        body.reasoning = { effort: "low" };
        if (Array.isArray(body.input)) body.input = body.input.filter((item: any) => item?.type !== "configuration_update");
        return body;
      },
    }).result();
    assert.equal(topOkMsg.stopReason, "stop", topOkMsg.errorMessage ?? "expected stop");
    assert.equal(sends, 2);

    // 3. Trailing configuration_update with effort "high" when "low" is required -> rejected before HTTP with THINKING_UNAPPLIED
    const badLedger = new BudgetLedger(join(input.target.stateRoot, "thinking-bad.jsonl"), limits, Date.now() + 10000, new AbortController().signal);
    const badProvider = boundedProvider(base, [model], badLedger, {
      requireThinkingLevel: "low",
      fetch: async () => { sends++; return sseOk(); },
    });
    const badMsg = await badProvider.streamSimple(model, context, {
      maxTokens: 1000,
      reasoning: "low",
      apiKey: "sk-offline-fixture-key",
      onPayload: (payload) => {
        const body = payload as Record<string, any>;
        body.reasoning = { effort: "low" };
        body.input = [
          ...(Array.isArray(body.input) ? body.input.filter((item: any) => item?.type !== "configuration_update") : []),
          { type: "configuration_update", reasoning: { effort: "low" } },
          { type: "configuration_update", reasoning: { effort: "high" } },
        ];
        return body;
      },
    }).result();
    assert.equal(badMsg.stopReason, "error");
    assert.equal(sends, 2, "must reject before HTTP when trailing configuration_update effort mismatches");
    const badTerm = readLedger(badLedger.path).find((r): r is CallEnd => r.kind === "terminal");
    assert.equal(badTerm?.diagnostic?.code, "THINKING_UNAPPLIED");
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});

test("concurrent Google and Vertex native adapters isolate bounded transport and restore global fetch", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  const originalFetch = globalThis.fetch;
  try {
    await Promise.all([googleProvider(), googleVertexProvider()].map(async base => {
      const catalog = base.getModels().find(m => m.id.includes("gemini-3") && m.reasoning);
      assert(catalog);
      const model = { ...catalog, baseUrl: "https://id.example.com/v1" };
      const ledger = new BudgetLedger(join(input.target.stateRoot, `${model.api}.jsonl`), { ...input.limits, maxCostUsd: null, maxTotalTokens: null }, Date.now() + 10000, new AbortController().signal);
      let sends = 0;
      const provider = boundedProvider(base, [model], ledger, {
        requireThinkingLevel: "low",
        fetch: async (resource, init) => {
          const request = new Request(resource, init);
          const body = await request.json();
          assert.equal(body.generationConfig.maxOutputTokens, 1000);
          assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, "LOW");
          sends++;
          return new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
        },
      });
      const response = await provider.streamSimple(model, context, { maxTokens: 1000, reasoning: "low", apiKey: "offline-fixture-key" }).result();
      assert.equal(response.stopReason, "stop", response.errorMessage ?? "");
      assert.equal(sends, 1);
      assert.deepEqual(ledgerSummary(readLedger(ledger.path)).unreconciledCallIds, []);
    }));
  } finally { assert.equal(globalThis.fetch, originalFetch); await rm(input.target.stateRoot, { recursive: true }); }
});

test("native pre-transport adapter exceptions settle reservations for raw and simple calls", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  const originalFetch = globalThis.fetch;
  try {
    const base = googleProvider(), model = base.getModels()[0]!;
    for (const simple of [true, false]) {
      const ledger = new BudgetLedger(join(input.target.stateRoot, `${simple}.jsonl`), { ...input.limits, maxCostUsd: null }, Date.now() + 10000, new AbortController().signal);
      let sends = 0;
      const provider = boundedProvider(base, [model], ledger, { fetch: async () => { sends++; throw new Error("Unexpected transport"); } });
      const response = await (simple ? provider.streamSimple(model, context, { maxTokens: 1000 }) : provider.stream(model, context, { maxTokens: 1000 })).result();
      assert.equal(response.stopReason, "error");
      assert.equal(sends, 0);
      const records = readLedger(ledger.path);
      assert.equal(records.length, 2);
      assert.deepEqual(ledgerSummary(records).unreconciledCallIds, []);
      assert.equal(globalThis.fetch, originalFetch);
    }
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});

test("future batch dispatch timestamps reject explicit and historical origins", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    for (const timestamp of [Date.now() + 60000, new Date(Date.now() + 60000).toISOString()]) {
      assert.throws(() => resolveBatchContext({ ...input, batch: { firstDispatchAt: timestamp } }), /no later than now/);
      assert.throws(() => resolveBatchContext({ ...input, limits: { ...input.limits, firstDispatchAt: timestamp } }), /no later than now/);
    }
    const now = Date.now();
    assert.equal(resolveBatchContext({ ...input, batch: { firstDispatchAt: now } }).firstDispatchAt, now);
    const path = join(input.target.stateRoot, "future.jsonl");
    const reserve: CallRecord = { kind: "reserve", id: 1, model: "fixture", at: now + 60000, inputEstimate: 10, outputCeiling: 16, reservedTokens: 100, reservedCostUsd: null };
    await appendFile(path, `${JSON.stringify(reserve)}\n`);
    assert.throws(() => resolveBatchContext({ ...input, batch: { priorLedgers: [path] } }), /no later than now/);
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});

test("persisted invalid reservation values reject reads and new reservations without changing either ledger", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const faux = fauxProvider({ provider: "nunc-live-controlled", models: [{ id: "test", contextWindow: 60000, maxTokens: 8192 }] });
    const model = faux.getModel(); model.cost = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };
    const limits = { maxCalls: 10, maxTotalTokens: 2000000, maxCostUsd: 20, maxDurationMs: 60000, maxOutputTokens: 8192 };
    const path = join(input.target.stateRoot, "history.jsonl"), nextPath = join(input.target.stateRoot, "next.jsonl");
    const reserve: CallRecord = { kind: "reserve", id: 1, model: "fixture", at: 1, inputEstimate: 100, outputCeiling: 8192, reservedTokens: 68192, reservedCostUsd: 0.68192 };
    const terminal: CallEnd = { kind: "terminal", id: 1, at: 2, latencyMs: 1, stopReason: "stop", usage: { input: 50, output: 50, cacheRead: 0, cacheWrite: 0, contextInput: 50, reasoning: null, totalTokens: 100, cost: 0.001 } };
    for (const field of ["inputEstimate", "outputCeiling", "reservedTokens", "at", "reservedCostUsd", "catalogReservationUsd"] as const) {
      // Raw JSON numbers can overflow to Infinity even though JSON.stringify cannot emit it.
      for (const raw of [field === "reservedTokens" ? "-100000" : "-1", '"1"', "true", "{}", "1e400", "-1e400", "null", undefined]) {
        if ((field === "reservedCostUsd" && raw === "null") || (field === "catalogReservationUsd" && raw === undefined)) continue;
        const { [field]: omitted, ...rest } = reserve;
        const json = JSON.stringify(rest);
        const contents = `${raw === undefined ? json : `${json.slice(0, -1)},"${field}":${raw}}`}\n${JSON.stringify(terminal)}\n`;
        await writeFile(path, contents); await writeFile(nextPath, "");
        const expected = { code: "LEDGER_RECONCILIATION", message: "Invalid ledger reservation values" };
        assert.throws(() => readLedger(path), expected, `${field}=${raw}`);
        assert.throws(() => readQualifiedLedgers([path]), expected, `${field}=${raw}`);
        for (const ledger of [
          new BudgetLedger(path, limits, Date.now() + 60000, new AbortController().signal),
          new BudgetLedger(nextPath, limits, Date.now() + 60000, new AbortController().signal, undefined, [path]),
        ]) assert.throws(() => ledger.reserve(model, context, 8192), expected, `${field}=${raw}`);
        assert.equal(await readFile(path, "utf8"), contents);
        assert.equal(await readFile(nextPath, "utf8"), "");
      }
    }
    for (const historical of [reserve, { ...reserve, reservedCostUsd: null }, { ...reserve, inputEstimate: 0, at: 0, catalogReservationUsd: 0 }]) {
      await writeFile(path, `${JSON.stringify(historical)}\n${JSON.stringify(terminal)}\n`);
      await writeFile(nextPath, "");
      assert.equal(readLedger(path).length, 2);
      const summary = ledgerSummary(readQualifiedLedgers([path]));
      assert.equal(summary.chargedTokens, 100);
      assert.equal(summary.chargedCostUsd, historical.reservedCostUsd === null ? null : 0.001);
      const ledger = new BudgetLedger(nextPath, { ...limits, maxCostUsd: null }, Date.now() + 60000, new AbortController().signal, undefined, [path]);
      ledger.finish(ledger.reserve(model, context, 8192), fauxAssistantMessage("ok"));
      assert.deepEqual(ledgerSummary(ledger.readQualifiedCalls().calls).unreconciledCallIds, []);
    }
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});

test("persisted terminal schema rejects invalid receipts and keeps absent optional usage unknown", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  const path = join(input.target.stateRoot, "calls.jsonl");
  const reserve: CallRecord = { kind: "reserve", id: 1, model: "fixture", at: 1, inputEstimate: 10, outputCeiling: 16, reservedTokens: 100, reservedCostUsd: 1 };
  const terminal = { kind: "terminal", id: 1, at: 2, latencyMs: 1, stopReason: "stop", usage: { totalTokens: 30, cost: 0.1 } };
  const persist = async (row: string) => writeFile(path, `${JSON.stringify(reserve)}\n${row}\n`);
  try {
    for (const field of ["at", "latencyMs", "stopReason", "usage"]) {
      for (const raw of [undefined, "null", "true", '"1"', "-1", "1e400", "{}", "[]"]) {
        if (field === "stopReason" && raw === '"1"') continue;
        const rest = Object.fromEntries(Object.entries(terminal).filter(([key]) => key !== field));
        const json = JSON.stringify(rest);
        await persist(raw === undefined ? json : `${json.slice(0, -1)},"${field}":${raw}}`);
        assert.throws(() => readLedger(path), { code: "LEDGER_RECONCILIATION" }, `${field}=${raw}`);
      }
    }
    for (const field of ["totalTokens", "cost", "input", "output", "cacheRead", "cacheWrite", "contextInput", "reasoning"]) {
      for (const raw of [undefined, '"1"', "true", "{}", "-1", "1e400"]) {
        if (raw === undefined && field !== "totalTokens" && field !== "cost") continue;
        const usage = Object.fromEntries(Object.entries(terminal.usage).filter(([key]) => key !== field));
        const json = JSON.stringify(usage);
        const row = JSON.stringify({ ...terminal, usage: undefined });
        await persist(`${row.slice(0, -1)},"usage":${raw === undefined ? json : `${json.slice(0, -1)},"${field}":${raw}}`}}`);
        assert.throws(() => readQualifiedLedgers([path]), { code: "LEDGER_RECONCILIATION" }, `${field}=${raw}`);
      }
    }
    await persist(JSON.stringify(terminal));
    const summary = ledgerSummary(readLedger(path));
    assert.equal(summary.actualTokens, 30); assert.equal(summary.actualCostUsd, 0.1);
    assert.equal(summary.input, null); assert.equal(summary.output, null);
    await persist(JSON.stringify({ ...terminal, at: 0, latencyMs: 0, usage: { totalTokens: null, cost: null, input: null } }));
    assert.equal(ledgerSummary(readLedger(path)).actualTokens, null);
    const typedTerminal: CallEnd = { ...terminal, kind: "terminal", usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, contextInput: 10, reasoning: null, totalTokens: Infinity, cost: NaN } };
    const nonfinite = ledgerSummary([reserve, typedTerminal]);
    assert.equal(nonfinite.actualTokens, null); assert.equal(nonfinite.actualCostUsd, null);
  } finally { await rm(input.target.stateRoot, { recursive: true, force: true }); }
});

test("persisted duplicate reservation IDs reject at the ledger read boundary", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const path = join(input.target.stateRoot, "calls.jsonl");
    const reserve: CallRecord = { kind: "reserve", id: 1, model: "fixture", at: 1, inputEstimate: 10, outputCeiling: 16, reservedTokens: 100, reservedCostUsd: 1 };
    await appendFile(path, `${JSON.stringify(reserve)}\n${JSON.stringify(reserve)}\n`);
    assert.throws(() => readLedger(path), /Duplicate reservation/);
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});
