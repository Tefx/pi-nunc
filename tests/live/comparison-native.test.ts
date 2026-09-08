import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { RunInput, Selection } from "../../src/live/contract.js";
import { runSegment } from "../../src/live/worker.js";
import { readLedger, ledgerSummary } from "../../src/live/budget.js";
import { repository } from "./fixtures.js";
import { comparisonStock, compareCli } from "./comparison-native-fixture.js";
import { matchedParity } from "../../src/live/comparison-observation.js";

async function actualWorker(f: any, selection: Pick<Selection, "id" | "variant">) {
  const model: Model<Api> = { id: f.modelId, name: f.modelId, provider: f.provider, api: f.api, baseUrl: f.endpoint, reasoning: false, input: ["text", "image"], contextWindow: 60000, maxTokens: 20000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const stateRoot = join(f.state, "worker-run"); await mkdir(join(stateRoot, "tmp"), { recursive: true });
  const input: RunInput = { version: 1, mode: "controlled", target: { repository, stateRoot, cleanup: "retain" }, models: [model], resolvedModels: [model],
    limits: { maxCalls: 24, maxTotalTokens: 1920000, maxOutputTokens: 20000, maxCostUsd: null, maxDurationMs: 60000 },
    scenarios: [{ ...selection, config: { compaction: { enabled: false, reserveTokens: 36000, keepRecentTokens: 1 }, nunc: { memory: { maxTokens: 100 }, extraction: { outputTokens: 1024 } }, retentionCalibration: { minFraction: 0.000001, maxFraction: 0.999999 } } }] };
  const overrides = { models: [model], controlledModels: { providers: { groq: { baseUrl: f.endpoint, apiKey: "isolated-nunc-fixture", models: [{ ...model, provider: undefined, cost: undefined }] } } } };
  const job = { input, scenarioIndex: 0, deadline: Date.now() + 60000, resume: false };
  const first = await runSegment(job, overrides);
  const second = first.status === "PAUSED" ? await runSegment({ ...job, resume: true }, overrides) : undefined;
  const ledger = readLedger(join(stateRoot, "calls.jsonl"));
  await writeFile(join(f.dir, "worker-report.json"), JSON.stringify({ first, second, ledger }, null, 2));
  return { first, second, ledger };
}

test("public CLI -> worker -> stock Pi -> loopback: all groups, per-roll matching, restart and successful remove", { timeout: 300000 }, async () => {
  const f = await comparisonStock({ e3: "siblings" });
  try {
    const { code, stderr, report, stateRoot } = await compareCli(f, [{ id: "e1" }, { id: "e2" }, { id: "e3" }, { id: "e4", variant: "fits-required" }, { id: "e4", variant: "required-too-large" }], ["defaults", "matched"], "positive");
    assert.equal(code, 0, JSON.stringify({ stderr, reason: report?.reason, matrix: report?.matrix?.map((m: any) => ({ group: m.group, mode: m.mode, id: m.scenarioId, reason: m.reason, status: m.status, failed: m.prerequisites.filter((p: any) => p.status !== "PROVEN") })), segments: report?.rawSegments?.filter((s: any) => s.status === "UNPROVEN").map((s: any) => ({ diagnostic: s.diagnostic, preparations: s.preparations })) }));
    assert.equal(report.status, "OBSERVED"); assert.equal(report.cleanup, "removed"); assert.equal(existsSync(stateRoot), false);
    assert.equal(Object.keys(report.sessions).length, 30);
    assert.equal(report.rawSegments.length, 42); // e1/e3 pause and resume in each group/mode.
    assert.equal(report.usage.calls, f.requests.length);
    assert.deepEqual(report.usage.unreconciledCallIds, []);
    assert.equal(report.matrix.reduce((n: number, r: any) => n + r.calls, 0), report.usage.calls);
    assert.equal(report.usage.costUsd, null);
    const modes = report.comparison.modes;
    assert.equal(modes[1].records.matchedParity.status, "UNPROVEN");
    assert.equal(modes[1].records.matchedParity.budgetMatched, false);
    assert.equal(modes[1].records.matchedParity.wrappersMeasured, true);
    assert.equal(modes[1].records.matchedParity.fileListsMeasured, true);
    for (const mode of modes) for (const group of ["native", "current", "candidate"]) {
      const rows = mode.groups[group].scenarios;
      const timings = mode.groups[group].caseTimings;
      assert.equal(timings.length, 5);
      assert.equal(timings.filter((c: any) => c.scenarioId === "e4").length, 2);
      for (const c of timings) {
        assert.equal(c.segments.length, c.scenarioId === "e1" || c.scenarioId === "e3" ? 2 : 1);
        assert(c.timing.elapsedMs >= c.segments.reduce((n: number, s: any) => n + s.elapsedMs, 0));
      }
      for (const row of rows) assert(row.timing.elapsedMs > row.latencyMs);
      const raw = report.rawSegments.filter((s: any) => s.mode === mode.mode && s.group === group);
      assert(raw.every((s: any) => s.timing.elapsedMs > s.segmentUsage.latencyMs));
      const e1 = rows.filter((r: any) => r.scenarioId === "e1"); assert.deepEqual(e1.map((r: any) => r.status), ["PAUSED", "OBSERVED"]);
      assert.equal(e1[1].rollovers.length, 2);
      assert.equal(e1[1].score.actionReview[0].status, "PROVEN");
      const e2 = rows.find((r: any) => r.scenarioId === "e2"); assert.equal(e2.rollovers.length, 3);
      assert(e2.setupChecks.slice(0, 3).every((p: any) => p.status === "PROVEN"), JSON.stringify({ group, setupChecks: e2.setupChecks }));
      assert(e2.setupChecks.slice(3).every((p: any) => p.status === "UNPROVEN"));
      const e3 = rows.filter((r: any) => r.scenarioId === "e3"); assert.deepEqual(e3.map((r: any) => r.status), ["PAUSED", "OBSERVED"]);
      assert.equal(e3[1].rollovers.length, 1);
      assert.equal(e3[1].rollovers[0].callIds.length, 1);
      assert.equal(e3[1].score.actionReview[0].status, "PROVEN");
      if (group === "native") assert.equal(e3[1].rollovers[0].overhead.splitTurnCalls, 1);
      for (const row of [...e1[1].rollovers, ...e2.rollovers, ...e3[1].rollovers]) {
        assert.equal(row.thinking, "off"); assert(row.callIds.length > 0); assert(row.kTokens > 0); assert(row.finalContextTokens > 0);
        assert(row.outputCaps.every((cap: number) => cap > 0));
      }
    }
    const e2Pair = [{ label: "e2", groups: ["native", "current", "candidate"].map(group => {
      const s = report.rawSegments.find((s: any) => s.group === group && s.mode === "matched" && s.scenario === "e2");
      return { group, complete: s.status === "OBSERVED", cwd: join(stateRoot, `matched-${group}-e2`, "task"), rows: s.rollovers, requests: s.requests };
    }) }];
    assert.equal(matchedParity(e2Pair).cutMatched, true);
    const shifted = structuredClone(e2Pair), row = shifted[0]!.groups[2]!.rows[0];
    row.snapshot.firstKeptEntryId = row.active[row.active.findIndex((e: any) => e.id === row.snapshot.firstKeptEntryId) + 1].id;
    assert.equal(matchedParity(shifted).cutMatched, false);
    assert.equal(matchedParity(shifted).kMatched, false);
    const candidateE4 = report.matrix.find((r: any) => r.mode === "defaults" && r.group === "candidate" && r.scenarioId === "e4");
    assert(candidateE4.setupChecks.every((c: any) => c.status === "PROVEN"));
    const refs = report.rawSegments.filter((s: any) => s.mode === "matched" && s.group !== "native").flatMap((s: any) => s.rollovers.map((r: any) => r.prepared?.matching));
    assert(refs.every((r: any) => r && r.referenceSnapshot !== "unobserved" && r.requestedMemoryLimit > 0 && r.requestedOutputCap > 0));
  } finally { await f.close(); }
});

test("E3 failed read, infeasible accounting and failed maintenance stop subsequent transport; wrong tool stays unqualified", { timeout: 120000 }, async () => {
  for (const shape of ["failed", "small", "maintenance-failure", "wrong"] as const) {
    const f = await comparisonStock({ e3: shape });
    try {
      const { first, second, ledger } = await actualWorker(f, { id: "e3" });
      assert.equal(first.status, "UNPROVEN", shape); assert.equal(second, undefined);
      assert.equal(f.requests.length, shape === "maintenance-failure" || shape === "wrong" ? 2 : 1, shape);
      assert.deepEqual(ledgerSummary(ledger).unreconciledCallIds, []);
      assert.equal(first.rollovers?.filter(r => r.snapshot).length, 0);
      assert(first.prerequisites.some(p => p.status === "UNPROVEN") || first.reason === "MAIN_RESPONSE");
    } finally { await f.close({ shape }); }
  }
});

test("E4 actual required-capacity failure delivers c once, preserves state and terminates without repeated maintenance", { timeout: 60000 }, async () => {
  const f = await comparisonStock({ tooLarge: true });
  try {
    const { first, ledger } = await actualWorker(f, { id: "e4", variant: "required-too-large" });
    assert.equal(first.status, "OBSERVED", JSON.stringify(first));
    assert(first.setupChecks?.every(c => c.status === "PROVEN"));
    assert.equal(first.rolloverQuality?.status, "UNPROVEN");
    assert.equal(first.maintenance.length, 1);
    assert(first.prerequisites.some(c => c.check.includes("failure-path recovery") && c.status === "PROVEN"));
    assert.equal(first.commands?.filter(c => c.type === "prompt" && c.message === "Continue the pending routing configuration now, using the agreed shipment conditions.").length, 1);
    assert.deepEqual(ledgerSummary(ledger).unreconciledCallIds, []);
  } finally { await f.close(); }
});

test("E1 early verification survives process restart and defeats a later successful verification claim", { timeout: 60000 }, async () => {
  const f = await comparisonStock({ earlyVerify: true });
  try {
    const { first, second } = await actualWorker(f, { id: "e1" });
    assert.equal(first.status, "PAUSED", JSON.stringify(first));
    assert.equal(second?.status, "UNPROVEN");
    assert.equal(second?.score?.actionReview[0]?.status, "DISPROVEN");
    assert(second?.actions.some((a: any) => a.turn === "c" && a.event.verification?.artifact?.passed));
  } finally { await f.close(); }
});
