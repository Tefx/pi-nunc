import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { repository } from "./fixtures.js";
import { extractionContext } from "../../src/engine/request.js";
import { input } from "../engine/fixtures.js";

const scripts = join(repository, "scripts/benchmarks");
test("tracked selection freezes Fact40 and exactly one protocol-relevant ordinary case; matrix/legacy overrides refused", async () => {
  const { assertFactProtocol, assertArenaProtocol, ordinarySelection, allocation, assertAllocation } = await import(join(scripts, "selection.mjs"));
  const cases = ["factconsolidation_sh_64k", "factconsolidation_mh_64k"].map(caseId => ({ caseId, chunks: Array(17).fill("material"), questions: Array(20).fill({ prompt: "hidden" }), checkpointAfterChunks: [8, 17] }));
  const fact = { arm: "nunc", condition: "luna-nunc", readerThinking: "medium", model: { api: "openai-completions", contextWindow: 272000 }, cases, nunc: { configuration: "defaults", compiledSource: "tracked/dist/src/index.js" }, allowanceUsd: 3 };
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
test("full database guard rejects missing/scorer-only DB before importing official tool executor", () => {
  const command = "from pathlib import Path; from database import validate_live_database; import tempfile; temp=tempfile.TemporaryDirectory(); r=Path(temp.name);\ntry: validate_live_database(r)\nexcept ValueError as e: assert '304807007' in str(e)\nelse: raise AssertionError('accepted incomplete liveDB')\n";
  const result = spawnSync("python3", ["-c", command], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: join(scripts, "arena") } });
  assert.equal(result.status, 0, result.stderr);
});
