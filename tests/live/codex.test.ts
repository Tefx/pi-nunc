import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { fixture, repository } from "./fixtures.js";
import { parseInput, preflight, selectedModels } from "../../src/live/contract.js";
import { BudgetLedger, ledgerSummary, readLedger } from "../../src/live/budget.js";

test("selected native Codex catalog/uncapped output and explicit unknown billing bind the preflight", async () => {
  const input = await fixture(true), [model] = selectedModels(input); assert(model);
  assert.equal(model.api, "openai-codex-responses"); assert.equal(model.maxTokens, 128000); assert.equal(model.contextWindow, 272000);
  assert.equal((await preflight(input, repository)).callsMade, 0);
  for (const change of [
    (v: typeof input) => { v.limits.maxCostUsd = 100; },
    (v: typeof input) => { v.limits.maxOutputTokens = 4096; },
    (v: typeof input) => { v.models[0]!.baseUrl = "https://example.invalid"; },
    (v: typeof input) => { v.scenarios[0]!.config.nunc.extraction!.outputTokens = 4096; },
    (v: typeof input) => { v.models[0]!.id = "unbound-model"; },
  ]) { const changed = structuredClone(input); change(changed); assert.throws(() => selectedModels(changed)); }
  assert.throws(() => parseInput({ ...input, models: [{ ...input.models[0], provider: ["openai-codex"] }] }));
  assert.throws(() => parseInput({ ...input, limits: { ...input.limits, maxCostUsd: ["unknown"] } }));
  const malformed = structuredClone(input); malformed.limits.maxCostUsd = 0; assert.throws(() => parseInput(malformed));
  delete (malformed.limits as Partial<typeof malformed.limits>).maxCostUsd; assert.throws(() => parseInput(malformed));
});

test("uncapped Codex reserves its full 400000-token allowance, preserves unknown billing and stops at limits", async () => {
  const input = await fixture(true), model = selectedModels(input)[0]!; await mkdir(input.target.stateRoot);
  const context = { messages: [{ role: "user" as const, content: "Controlled work", timestamp: 1 }] };
  try {
    const path = join(input.target.stateRoot, "calls.jsonl"), signal = new AbortController().signal;
    const small = new BudgetLedger(path, { ...input.limits, maxTotalTokens: 399999 }, Date.now() + 10000, signal);
    assert.throws(() => small.reserve(model, context, model.maxTokens), /token authorization/);
    const ledger = new BudgetLedger(path, { ...input.limits, maxCalls: 1 }, Date.now() + 10000, signal);
    const call = ledger.reserve(model, context, model.maxTokens);
    assert.equal(call.reservedTokens, 400000); assert.equal(call.reservedCostUsd, null); assert(call.catalogReservationUsd! > 0);
    const reply = fauxAssistantMessage("Fixture completed");
    reply.usage = { input: 10, cacheRead: 20, cacheWrite: 0, output: 30, totalTokens: 60, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    ledger.finish(call, reply);
    const usage = ledgerSummary(readLedger(path)); assert.equal(usage.costUsd, null); assert.equal(usage.reservedCostUsd, null); assert.equal(usage.contextInput, 30);
    assert.throws(() => ledger.reserve(model, context, model.maxTokens), /Call ceiling/);
    const overflow = new BudgetLedger(join(input.target.stateRoot, "overflow.jsonl"), input.limits, Date.now() + 10000, signal);
    const excessive = overflow.reserve(model, context, model.maxTokens); reply.usage.output = 128001; reply.usage.totalTokens = 128031;
    assert.throws(() => overflow.finish(excessive, reply), /Observed usage exceeds/);
    assert.deepEqual(ledgerSummary(readLedger(join(input.target.stateRoot, "overflow.jsonl"))).unreconciledCallIds, [excessive.id]);
    const reloaded = new BudgetLedger(overflow.path, input.limits, Date.now() + 10000, signal);
    assert.throws(() => reloaded.reserve(model, context, model.maxTokens), /no terminal receipt/);
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});

