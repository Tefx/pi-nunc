import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseInput, preflight, type RunInput } from "../../src/live/contract.js";
import { liveExtensionFlags } from "../../src/live/host.js";
import { loadScenario, scoreArtifacts } from "../../src/live/scenarios.js";
import { executeComparison, scopedUsage } from "../../src/live/comparison.js";
import { fixture, repository } from "./fixtures.js";
import type { LedgerRecord } from "../../src/live/budget.js";

const compareScript = join(repository, "scripts/compare-extraction.mjs");
const mockWorker = join(repository, "tests/live/comparison-mock-worker.mjs");
const baseline = join(repository, ".scratch/baseline-70dacad");
const { NODE_OPTIONS: _node, ...environment } = process.env;
const env = { ...environment, PATH: "/opt/homebrew/bin:/usr/bin:/bin", HOME: join(repository, ".scratch/offline-home"), PI_CODING_AGENT_DIR: join(repository, ".scratch/offline-agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
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
  const extra = join(baseline, "dist/src/stale-extra-file.js"); await writeFile(extra, "export const stale = true;");
  try { await assert.rejects(preflight(input, repository), /Stale extra JS|BUILD/); } finally { await rm(extra); }
  const receipt = await preflight(input, repository); assert.equal(receipt.pi, "0.85.1"); assert.equal(receipt.callsMade, 0);
  input.scenarios = [{ id: "e3", config: input.scenarios[0]!.config }];
  const run = spawnSync(process.execPath, [compareScript, "--preflight"], { env: { ...env, PI_PROVIDER: input.models[0]!.provider, PI_MODEL: input.models[0]!.id }, input: JSON.stringify(publicValue(input)), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).status, "PREFLIGHT");
  await assert.rejects(lstat(input.target.stateRoot), { code: "ENOENT" });
});
test("three groups load actual distinct native/current/candidate hooks", async () => {
  const input = await comparisonFixture();
  const native = liveExtensionFlags(repository, input, "native"), current = liveExtensionFlags(repository, input, "current"), candidate = liveExtensionFlags(repository, input, "candidate");
  assert(!native.some(f => f.endsWith("index.js")));
  assert(current.includes(join(baseline, "dist/src/index.js"))); assert(!current.includes(join(repository, "dist/src/index.js")));
  assert(candidate.includes(join(repository, "dist/src/index.js"))); assert(!candidate.includes(join(baseline, "dist/src/index.js")));
});
test("extraction assets and explicit asset selection preserve controls and independent oracle", async () => {
  const input = await comparisonFixture(), config = input.scenarios[0]!.config;
  for (const selection of [{ id: "e1" }, { id: "e2" }, { id: "e3" }, { id: "e4", variant: "fits-required" }, { id: "e4", variant: "required-too-large" }] as const) {
    const loaded = await loadScenario(repository, { ...selection, config, assets: { inputs: "tests/scenarios/extraction-inputs.json", observer: "tests/scenarios/extraction-observer.json" } });
    assert.equal(loaded.input.id, selection.id); assert(loaded.observer.controls.length > 0);
    if (selection.id === "e3") assert.equal(loaded.observer.controls[0]!.trigger?.when, "after_result_before_continuation");
  }
});
test("controlled comparison refuses non-loopback targets before state or dispatch", async () => {
  const input = await comparisonFixture(); input.models[0]!.baseUrl = input.resolvedModels![0]!.baseUrl = "https://api.anthropic.com";
  assert.throws(() => parseInput(input, true)); await assert.rejects(executeComparison(input, repository, mockWorker, new AbortController().signal));
  assert.equal(existsSync(input.target.stateRoot), false);
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
    await assert.rejects(preflight(input, repository), /already exists/);
  } finally { await rm(input.target.stateRoot, { recursive: true, force: true }); }
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
test("verification receipts bind exact turn/script/artifact and only successful edits invalidate", async () => {
  const { observer } = await loadScenario(repository, { id: "e1", config: (await fixture()).scenarios[0]!.config });
  const dir = join(repository, ".scratch", `verify-receipt-${process.pid}`); await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, "verification.json"), JSON.stringify({ artifact: "export.json", passed: true }));
    const verify = (turn = "e", isError = false) => [
      { turn, event: { type: "tool_call", toolName: "bash", toolCallId: "verify", input: { command: "python3 verify.py" } } },
      { turn, event: { type: "tool_result", toolName: "bash", toolCallId: "verify", isError } },
    ];
    const change = (path: string, isError = false) => [
      { turn: "c", event: { type: "tool_call", toolName: "write", toolCallId: "change", input: { path, content: "{}" } } },
      { turn: "c", event: { type: "tool_result", toolName: "write", toolCallId: "change", isError } },
    ];
    const score = async (actions: unknown[]) => (await scoreArtifacts(dir, observer, [{ check: "eligible", status: "PROVEN" }], { actions })).actionReview[0]!.status;
    assert.equal(await score(verify()), "PROVEN");
    assert.equal(await score(verify("c")), "DISPROVEN"); assert.equal(await score(verify("e", true)), "DISPROVEN");
    assert.equal(await score([...change("verify.py"), ...verify()]), "DISPROVEN");
    assert.equal(await score([...change("verification.json"), ...verify()]), "DISPROVEN");
    assert.equal(await score([...verify(), ...change("export.json")]), "DISPROVEN");
    assert.equal(await score([...change("verify.py", true), ...verify()]), "PROVEN");
    assert.equal(await score([...change("old-verify.py"), ...verify()]), "PROVEN");
    await writeFile(join(dir, "verification.json"), JSON.stringify({ artifact: "other.json", passed: true }));
    assert.equal(await score(verify()), "DISPROVEN");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
