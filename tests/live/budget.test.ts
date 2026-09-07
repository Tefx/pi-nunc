import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, type Context } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { boundedProvider, BudgetLedger, ledgerSummary, readLedger } from "../../src/live/budget.js";
import { selectedModels } from "../../src/live/contract.js";
import { fixture } from "./fixtures.js";
const context: Context = { systemPrompt: "Use available evidence.", messages: [{ role: "user", content: "Inspect the pending work.", timestamp: 1 }] };

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
    const response = await provider.streamSimple(model, context, { maxTokens: 1000, apiKey: "offline-fixture-key" }).result();
    assert.equal(response.stopReason, "error"); assert.equal(requests, 1);
    assert(observed && typeof observed === "object" && "url" in observed && "body" in observed);
    assert.equal(observed.url, "https://api.openai.com/v1/responses");
    const body = observed.body as Record<string, unknown>; assert.equal(body.max_output_tokens, 1000); assert.equal(body.model, "gpt-4.1");
    assert.equal((await provider.streamSimple(model, context, { maxTokens: 1000, apiKey: "offline-fixture-key" }).result()).stopReason, "error"); assert.equal(requests, 1);
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
      const provider = boundedProvider(faux.provider, [model], ledger, { controlled: true });
      const result = await provider.streamSimple(model, context, { maxTokens: limit === "output" ? 8192 : 1000 }).result();
      assert.equal(result.stopReason, "error"); assert.equal(faux.state.callCount, 0, limit);
    } finally { await rm(input.target.stateRoot, { recursive: true }); }
  }
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
    const huge = { systemPrompt: "x".repeat(500000), messages: [{ role: "user" as const, content: "y".repeat(1000), timestamp: 1 }] };
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
    message.usage = { input: 10, output: 20, cacheRead: 500, cacheWrite: 100, totalTokens: 630, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 } };
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
    const controller = new AbortController(); controller.abort();
    const ledger = new BudgetLedger(join(input.target.stateRoot, "calls.jsonl"), input.limits, Date.now() + 10000, controller.signal);
    const provider = boundedProvider(faux.provider, [model], ledger, { controlled: true });
    assert.equal((await provider.streamSimple(model, context).result()).stopReason, "error");
    assert.equal((await provider.streamSimple({ ...model, contextWindow: 80000 }, context).result()).stopReason, "error");
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
