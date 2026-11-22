import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { repository } from "./fixtures.js";
import { extractionContext } from "../../src/engine/request.js";
import { input } from "../engine/fixtures.js";
import { buildReceipt } from "../../src/live/build.js";

const scripts = join(repository, "scripts/benchmarks");
test("tracked selection freezes Fact40 and exactly one protocol-relevant ordinary case; matrix/legacy overrides refused", async () => {
  const { assertFactProtocol, assertArenaProtocol, ordinarySelection, allocation, assertAllocation } = await import(join(scripts, "selection.mjs"));
  const cases = ["factconsolidation_sh_64k", "factconsolidation_mh_64k"].map(caseId => ({ caseId, chunks: Array(17).fill("material"), questions: Array(20).fill({ prompt: "hidden" }), checkpointAfterChunks: [8, 17] }));
  const fact = { arm: "nunc", condition: "luna-nunc", readerThinking: "medium", model: { api: "openai-completions", contextWindow: 272000 }, cases, nunc: { configuration: "defaults", compiledSource: join(repository, "dist/src/index.js"), buildReceipt: buildReceipt(join(repository, "dist/src/index.js")) }, allowanceUsd: 3 };
  assertFactProtocol(fact); assert.throws(() => assertFactProtocol({ ...fact, cases: [...cases, { caseId: "event" }] }));
  assert.throws(() => assertFactProtocol({ ...fact, nunc: { ...fact.nunc, configuration: "explicit8192/full" } }));
  const arena = { arm: "nunc", groups: [4], order: [[4, "nunc"]], model: { id: ordinarySelection.modelId }, thinking: "medium", compaction: { effectiveContext: 272000, reserveTokens: 255616, keepRecentTokens: 8000 }, nunc: fact.nunc, flightCsvBytes: 304807007, catalogAllowanceUsd: 3 };
  assertArenaProtocol(arena); assert.throws(() => assertArenaProtocol({ ...arena, groups: [4, 5] })); assert.throws(() => assertArenaProtocol({ ...arena, flightCsvBytes: 1000 }));
  const a = allocation(); assertAllocation(a); assert.throws(() => assertAllocation({ ...a, exclusive: { ...a.exclusive, extra: 1 } })); assert.throws(() => assertAllocation({ ...a, priorHeldUsd: 0 }));
});
test("guard reserves actual resolved auto cap and retains unknown effects rather than old8192 or zero", async () => {
  const { reserveState, settleState, reconcileStoppedState, assertCatalogBinding } = await import(join(scripts, "mab/capture.mjs"));
  const state = () => ({ stopped: false, pending: {}, spentUsd: 0, heldUnknownUsd: 0, admissions: 0, receipts: 0, maxReservedTotalUsd: 0, allowanceUsd: 3, maxTokens: 128000, contextWindow: 272000, cost: { input: .2, output: 1, cacheRead: .1, cacheWrite: .2 } });
  const s = state(); assertCatalogBinding(s, { maxTokens: s.maxTokens, cost: s.cost });
  assert.throws(() => assertCatalogBinding(s, { maxTokens: s.maxTokens, cost: { ...s.cost, output: 10 } }));
  const old = reserveState(s, "maintenance", 8192); settleState(s, "maintenance", { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: .000012 } });
  const actual = reserveState(s, "maintenance", 32768); assert(actual > old); const t = reconcileStoppedState(s, "fact"); assert.equal(t.heldUnknownUsd, actual); assert.deepEqual(t.pending, {});
  reserveState(t, "next", 17280); assert.equal(t.pending.next.output, 17280); assert.equal(t.heldUnknownUsd, actual);
  assert.throws(() => reserveState(t, "replay", 32768)); const low = state(); low.heldUnknownUsd = 2.99; assert.throws(() => reserveState(low, "maintenance", 32768));
});
test("tracked source/M/NEXT report rejects absent actual payload and mismatched cap; material matches remain bounded observations", async () => {
  const { evidence } = await import(join(scripts, "evidence.mjs"));
  const s = await input(),ctx = extractionContext(s, 2, 8192, s.active, []);
  const request = { context: ctx, options: { maxTokens: 17280 } },checkpoint = { memory: { slots: [{ id: "s1", text: "Alice owns blue house" }] }, accounting: { outputCapTokens: 17280, outputReserveTokens: 17280, extractionInputLimit: 80000, extractionTokens: 79000, memoryLimit: 8192, memoryTokens: 80, keepTarget: 10000, keptTokens: 9000, fullExtractionTokens: 79000 } };
  const payload = { messages: [{ role: "user", content: "Nunc working memory (session-local, reference only):\n" + JSON.stringify(checkpoint.memory.slots) }] };
  const e = evidence(request, checkpoint, payload, ["Alice owns blue house"]);
  assert.equal(e.actualCap, 17280); assert.equal(e.headroom, 1000); assert.equal(e.semanticCompleteness, "unjudged"); assert.equal(e.relations[0].inMemory, true);
  assert.throws(() => evidence(request, checkpoint, { messages: [] })); assert.throws(() => evidence({ ...request, options: { maxTokens: 8192 } }, checkpoint, {}));
});
test("Arena and MAB settle real split-compaction per-call USD across tier boundaries", async t => {
  const { compact } = await import(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const { calculateCost } = await import(import.meta.resolve('@earendil-works/pi-ai'));
  await mkdir(join(repository, '.scratch'), { recursive: true });
  const root = await mkdtemp(join(repository, '.scratch/capture-tiers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cost = { input: 1, output: 2, cacheRead: .5, cacheWrite: 1, tiers: [{ inputTokensAbove: 200000, input: 3, output: 4, cacheRead: 2, cacheWrite: 3 }] };
  const model = { provider: 'openrouter', api: 'openai-completions', id: 'openai/gpt-6-luna', contextWindow: 1050000, maxTokens: 128000, cost };
  for (const inputs of [[150000, 150000], [200000, 200001]]) {
    let calls = 0, expected = 0;
    const result = await compact({ firstKeptEntryId: 'kept', messagesToSummarize: [{ role: 'user', content: 'Prior history', timestamp: 1 }], turnPrefixMessages: [{ role: 'user', content: 'Current turn', timestamp: 2 }], isSplitTurn: true, tokensBefore: 300000, fileOps: { read: new Set(), written: new Set(), edited: new Set() } }, model, 'controlled', undefined, undefined, undefined, 'medium', async () => ({ result: async () => {
      const usage = { input: inputs[calls++]!, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      calculateCost(model, usage); expected += usage.cost.total;
      return { role: 'assistant', content: [{ type: 'text', text: 'Controlled summary' }], stopReason: 'stop', usage };
    } }));
    assert.equal(calls, 2); assert.equal(result.usage.cost.total, expected);
    const repriced = structuredClone(result.usage); calculateCost(model, repriced);
    assert(repriced.cost.total > expected, 'Aggregate tier selection would overcharge');
    for (const suite of ['arena/capture-openrouter-medium.mjs', 'mab/capture.mjs']) {
      const file = join(root, suite.startsWith('arena') ? 'arena.json' : 'mab.json'), capture = file + '.jsonl';
      await writeFile(file, JSON.stringify({ stopped: false, pending: {}, spentUsd: 0, heldUnknownUsd: 0, admissions: 0, receipts: 0, maxReservedTotalUsd: 0, allowanceUsd: 10, modelId: model.id, maxTokens: model.maxTokens, contextWindow: 272000, cost, arm: 'native' }));
      const ctx = { model: { ...model }, cwd: join(root, 'native-1'), thinkingLevel: 'off', abort() { assert.fail('Unexpected admission failure'); }, modelRegistry: { find() { return model; }, complete() {}, getProviderAuthStatus() { return { configured: true }; }, isUsingOAuth() { return false; } } };
      const handlers = new Map<string, (event: unknown, context: typeof ctx) => unknown>();
      const { default: extension } = await import(join(scripts, suite));
      extension({ registerFlag() {}, getFlag(name: string) { return name === 'bench-budget-file' ? file : capture; }, on(name: string, handler: (event: unknown, context: typeof ctx) => unknown) { handlers.set(name, handler); }, async setModel(selected: typeof model) { ctx.model = selected; return true; }, setThinkingLevel(level: string) { ctx.thinkingLevel = level; } });
      await handlers.get('session_start')!({}, ctx);
      await handlers.get('session_before_compact')!({}, ctx);
      await handlers.get('session_compact')!({ fromExtension: false, compactionEntry: result }, ctx);
      const settled = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(settled.spentUsd, expected); assert.equal(settled.receipts, 1); assert.deepEqual(settled.pending, {});
      const records = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(records.at(-1).computedCatalogUsd, expected);
    }
  }
});

test("full database guard rejects missing/scorer-only DB before importing official tool executor", () => {
  const command = "from pathlib import Path; from database import validate_live_database; import tempfile; temp=tempfile.TemporaryDirectory(); r=Path(temp.name);\ntry: validate_live_database(r)\nexcept ValueError as e: assert '304807007' in str(e)\nelse: raise AssertionError('accepted incomplete liveDB')\n";
  const result = spawnSync("python3", ["-c", command], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: join(scripts, "arena") } });
  assert.equal(result.status, 0, result.stderr);
});
