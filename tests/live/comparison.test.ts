import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseInput, preflight, type RunInput } from "../../src/live/contract.js";
import { liveExtensionFlags, openHost } from "../../src/live/host.js";
import { loadScenario } from "../../src/live/scenarios.js";
import { executeComparison, scopedUsage } from "../../src/live/comparison.js";
import { fixture, repository, temporaryBaseline, temporaryState } from "./fixtures.js";
import type { LedgerRecord } from "../../src/live/budget.js";

const compareScript = join(repository, "scripts/compare-extraction.mjs");
const mockWorker = join(repository, "tests/live/comparison-mock-worker.mjs");
const baseline = await temporaryBaseline();
const state = await temporaryState();
const { NODE_OPTIONS: _node, ...environment } = process.env;
const env = { ...environment, PATH: process.env.PATH, HOME: join(state, "home"), PI_CODING_AGENT_DIR: join(state, "host"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
async function comparisonFixture(): Promise<RunInput> {
  const input = await fixture();
  input.models[0]!.baseUrl = input.resolvedModels![0]!.baseUrl = "http://127.0.0.1:8080/v1";
  input.comparison = { modes: ["defaults", "matched"], targets: { native: { repository }, current: { repository: baseline }, candidate: { repository } } };
  input.scenarios = [{ id: "e1", config: input.scenarios[0]!.config }];
  return input;
}
function publicValue(input: RunInput) { return { target: input.target, limits: input.limits, observations: ["stock_rpc"], scenarios: input.scenarios.map(({ id, variant }) => ({ id, variant })), comparison: input.comparison }; }

test("comparison CLI validates argv, bounded stdin and required comparison before effects", () => {
  for (const [args, stdin, code] of [[ ["--unknown"], "", "ARGUMENTS" ], [["--preflight", "--worker"], "", "ARGUMENTS"], [["--preflight"], "", "INPUT"], [["--preflight"], "{broken", "INPUT"], [["--preflight"], " ".repeat(65537), "INPUT_SIZE"], [["--preflight"], "{}", "COMPARISON"]] as Array<[string[], string, string]>) {
    const run = spawnSync(process.execPath, [compareScript, ...args], { env, input: stdin, encoding: "utf8" });
    assert.equal(run.status, 1); assert(run.stderr.includes(code), run.stderr);
  }
});
test("comparison preflight validates modes, all prepared targets, baseline identity and emitted build", async () => {
  const input = await comparisonFixture();
  for (const modes of [[], ["invalid"], ["defaults", "defaults"]]) { const bad = structuredClone(input); (bad.comparison as any).modes = modes; assert.throws(() => parseInput(bad)); }
  const missing = structuredClone(input); delete (missing.comparison as any).targets.current; assert.throws(() => parseInput(missing));
  for (const repo of ["/path/does/not/exist", repository]) { const bad = structuredClone(input); bad.comparison!.targets.current.repository = repo; await assert.rejects(preflight(bad, repository)); }
  const mismatch = structuredClone(input); mismatch.comparison!.targets.candidate.repository = baseline; await assert.rejects(preflight(mismatch, repository), /Candidate target/);
  // Other stock CLI tests read the shared baseline concurrently. Corrupt only this test's target.
  const isolated = await mkdtemp(join(tmpdir(), "nunc-stale-build-"));
  try {
    const clone = spawnSync("git", ["clone", "--shared", "--no-hardlinks", baseline, isolated], { env, encoding: "utf8" });
    assert.equal(clone.status, 0, clone.stderr);
    await symlink(join(baseline, "node_modules"), join(isolated, "node_modules"), "dir");
    await cp(join(baseline, "dist"), join(isolated, "dist"), { recursive: true });
    const badBuild = structuredClone(input); badBuild.comparison!.targets.current.repository = isolated;
    await writeFile(join(isolated, "dist/src/stale-extra-file.js"), "export const stale = true;");
    await assert.rejects(preflight(badBuild, repository), /Stale extra JS|BUILD/);
    await rm(join(isolated, "dist/src/stale-extra-file.js"));
    await rm(join(isolated, "node_modules"));
    const installedPi = join(isolated, "node_modules/@earendil-works/pi-coding-agent");
    await mkdir(installedPi, { recursive: true });
    await writeFile(join(installedPi, "package.json"), JSON.stringify({ version: "0.0.0" }));
    await assert.rejects(preflight(badBuild, repository), /Current target installed Pi differs from its lock/);
  } finally { await rm(isolated, { recursive: true, force: true }); }
  const receipt = await preflight(input, repository); assert.equal(receipt.pi, JSON.parse(await readFile(join(repository, "package-lock.json"), "utf8")).packages["node_modules/@earendil-works/pi-coding-agent"].version); assert.equal(receipt.callsMade, 0);
  assert.equal(receipt.version, 1); assert.equal(typeof receipt.binding, "string"); assert(receipt.binding.length > 0);
  input.scenarios = [{ id: "e3", config: input.scenarios[0]!.config }];
  const run = spawnSync(process.execPath, [compareScript, "--preflight"], { env: { ...env, PI_PROVIDER: input.models[0]!.provider, PI_MODEL: input.models[0]!.id }, input: JSON.stringify(publicValue(input)), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.status, "PREFLIGHT"); assert.equal(out.receipt.version, 1);
  assert.deepEqual(out.comparison.modes, ["defaults", "matched"]); assert(out.limitations.length > 0);
  await assert.rejects(lstat(input.target.stateRoot), { code: "ENOENT" });
});
test("three groups load actual distinct native/current/candidate hooks", async () => {
  const input = await comparisonFixture();
  for (const group of ["native", "current", "candidate"] as const) {
    const flags = liveExtensionFlags(repository, input);
    assert.deepEqual(flags, ["-e", join(repository, "dist/src/live/observer.js")]);
    assert(!flags.some(f => f.endsWith("index.js")));
    const caseRoot = join(input.target.stateRoot, group);
    await mkdir(join(caseRoot, "task"), { recursive: true });
    // Replace only RPC responses; NativeHost writes the real observer binding.
    const host = await openHost({ repository, input, group, selection: input.scenarios[0]!, caseRoot,
      modelTargets: input.resolvedModels!, deadline: Date.now() + 10000, signal: new AbortController().signal,
      controlledModels: {}, testCommand: { command: process.execPath, args: [join(repository, "tests/live/host-child.mjs"), "rpc"] } });
    try {
      const binding = JSON.parse(await readFile(join(caseRoot, "observer-binding.json"), "utf8"));
      assert.equal(binding.productExtension, group === "native" ? undefined : join(group === "current" ? baseline : repository, "dist/src/index.js"));
    } finally { await host.close(); }
  }
});
test("extraction assets and explicit asset selection preserve controls and independent oracle", async () => {
  const input = await comparisonFixture(), config = input.scenarios[0]!.config;
  for (const selection of [{ id: "e1" }, { id: "e2" }, { id: "e3" }, { id: "e4", variant: "fits-required" }, { id: "e4", variant: "required-too-large" }] as const) {
    const loaded = await loadScenario(repository, { ...selection, config, assets: { inputs: "tests/scenarios/extraction-inputs.json", observer: "tests/scenarios/extraction-observer.json" } });
    assert.equal(loaded.input.id, selection.id); assert.equal(loaded.observer.id, selection.id); assert(loaded.observer.controls.length > 0);
    if (selection.id === "e3") assert.equal(loaded.observer.controls[0]!.trigger?.when, "after_result_before_continuation");
  }
});
test("controlled comparison refuses non-loopback targets before state or dispatch", async () => {
  const input = await comparisonFixture(); input.models[0]!.baseUrl = input.resolvedModels![0]!.baseUrl = "https://api.anthropic.com";
  assert.throws(() => parseInput(input, true)); await assert.rejects(executeComparison(input, repository, mockWorker, new AbortController().signal));
  assert.equal(existsSync(input.target.stateRoot), false);
});
test("comparison rejects missing/corrupt prior ledgers and expired deadlines before creating its target", async () => {
  const prior = await mkdtemp(join(tmpdir(), "nunc-prior-ledger-"));
  try {
    for (const kind of ["missing", "corrupt", "truncated", "expired"] as const) {
      const input = await comparisonFixture();
      const path = join(prior, `${kind}.jsonl`);
      if (kind === "corrupt") await writeFile(path, '{"kind":"invalid"}\n');
      if (kind === "truncated") await writeFile(path, '{"kind":');
      input.batch = kind === "expired" ? { firstDispatchAt: Date.now() - input.limits.maxDurationMs - 1000 } : { priorLedgers: [path] };
      await assert.rejects(executeComparison(input, repository, mockWorker, new AbortController().signal), (error: { code?: string }) => error.code === (kind === "expired" ? "TIME_LIMIT" : kind === "truncated" ? "RECONCILIATION" : "LEDGER_RECONCILIATION"));
      await assert.rejects(lstat(input.target.stateRoot), { code: "ENOENT" });
    }
  } finally { await rm(prior, { recursive: true, force: true }); }
});
test("aggregator never proves parity from empty mock contexts or relabels defaults as matched", async () => {
  const input = await comparisonFixture(); input.limits.maxDurationMs = 10000;
  try {
    const report = await executeComparison(input, repository, mockWorker, new AbortController().signal);
    assert.equal(report.children.length, 6);
    assert.equal(report.comparison.modes[1]?.records.matchedParity?.status, "UNPROVEN");
    assert.equal(report.comparison.modes[1]?.records.matchedParity?.exposureMatched, false);
    assert(report.comparison.modes[1]?.records.matchedParity?.discrepancies.length);
    assert.equal(report.usage.calls, 0); assert(report.matrix.every(r => r.calls === 0));
    assert.equal(report.cleanup, "retained");
    assert(existsSync(join(input.target.stateRoot, "report.json")));
    assert(existsSync(join(input.target.stateRoot, "owner.json")));
    await assert.rejects(preflight(input, repository), /already exists/);
  } finally { await rm(input.target.stateRoot, { recursive: true, force: true }); }
});
test("comparison wall-clock intervals include delayed workers and process restart separately from provider latency", async () => {
  const input = await comparisonFixture(); input.comparison!.modes = ["defaults"];
  input.scenarios = [{ id: "c3", config: input.scenarios[0]!.config }]; input.limits.maxDurationMs = 15000;
  try {
    const report = await executeComparison(input, repository, mockWorker, new AbortController().signal);
    assert.equal(report.status, "OBSERVED"); assert.equal(report.children.length, 6);
    assert.equal(new Set(report.rawSegments!.map(s => s.pid)).size, 6);
    const mode = report.comparison.modes[0]!;
    for (const group of Object.values(mode.groups)) {
      const c = group.caseTimings[0]!;
      assert.equal(c.scenarioId, "c3"); assert.equal(c.segments.length, 2);
      assert.deepEqual(group.scenarios.map(r => r.status), ["PAUSED", "OBSERVED"]);
      assert.deepEqual(group.scenarios.map(r => r.timing), c.segments);
      assert(c.segments.every(s => s.elapsedMs >= 200)); // Each real worker waited 250 ms.
      assert(c.segments[1]!.startedAt >= c.segments[0]!.endedAt);
      assert(c.timing.startedAt <= c.segments[0]!.startedAt && c.timing.endedAt >= c.segments[1]!.endedAt);
      assert(c.timing.elapsedMs >= c.segments.reduce((n, s) => n + s.elapsedMs, 0));
      assert(group.timing!.elapsedMs >= c.timing.elapsedMs);
      assert(group.timing!.startedAt >= mode.timing!.startedAt && group.timing!.endedAt <= mode.timing!.endedAt);
      for (const interval of [mode.timing!, group.timing!, c.timing, ...c.segments]) assert.equal(interval.elapsedMs, interval.endedAt - interval.startedAt);
      assert(group.scenarios.every(r => r.latencyMs === 0 && r.calls === 0));
    }
    assert(report.elapsedMs >= mode.timing!.elapsedMs);
    assert.equal(report.usage.calls, 0); assert.equal(report.usage.totalTokens, 0);
  } finally { await rm(input.target.stateRoot, { recursive: true, force: true }); }
});

test("comparison supervisor stops all modes and groups on STOPPED/CLEANUP but continues independent semantic failures", async () => {
  for (const mode of ["stopped-cleanup", "unproven-main"] as const) {
    const input = await comparisonFixture();
    input.overrides = [{ requirement: `supervisor-loop:${mode}` }];
    input.scenarios.push({ id: "c2", config: input.scenarios[0]!.config });
    try {
      const report = await executeComparison(input, repository, join(repository, "tests/live/supervisor-loop-worker.mjs"), new AbortController().signal);
      assert.equal(report.status, "UNPROVEN");
      if (mode === "stopped-cleanup") {
        assert.equal(report.children.length, 1);
        assert.equal(report.matrix.length, 1);
        assert.equal(report.reason, "CLEANUP");
        assert.equal(report.matrix[0]?.status, "STOPPED");
      } else {
        assert.equal(report.children.length, 12);
        assert.equal(report.matrix.filter(s => s.status === "OBSERVED").length, 6);
      }
    } finally { await rm(input.target.stateRoot, { recursive: true, force: true }); }
  }
});

test("call-ID totals do not count paused history twice and missing terminals stay unknown", () => {
  const reserve = (id: number) => ({ kind: "reserve", id, at: 0, model: "fixture", inputEstimate: 1, outputCeiling: 20, reservedTokens: 100, reservedCostUsd: null });
  const terminal = (id: number) => ({ kind: "terminal", id, at: 1, latencyMs: 1, stopReason: "stop", usage: { input: 5, cacheRead: 0, cacheWrite: 0, contextInput: 5, output: 5, reasoning: null, totalTokens: 10, cost: null } });
  const records = [reserve(1), terminal(1), reserve(2), terminal(2), reserve(3), terminal(3)] as LedgerRecord[];
  assert.equal(scopedUsage(records, new Set([1, 2])).calls + scopedUsage(records, new Set([3])).calls, 3);
  assert.equal(scopedUsage(records, new Set([1, 2, 3, 1])).tokens, 30);
  assert.equal(scopedUsage(records.slice(0, -1), new Set([3])).tokens, null);
  assert.equal(scopedUsage(records, new Set([1])).costUsd, null);
});
