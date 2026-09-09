import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { parseInput, type RunInput } from "../../src/live/contract.js";
import { executeComparison } from "../../src/live/comparison.js";
import { childEnvironment } from "../../src/live/host.js";
import { fixture, publicSelection, repository } from "./fixtures.js";

const compareScript = join(repository, "scripts/compare-extraction.mjs");
const mockWorker = join(repository, "tests/live/comparison-mock-worker.mjs");
const ledgerWorker = join(repository, "tests/live/quota-ledger-worker.mjs");
const baseline = join(repository, ".scratch/baseline-70dacad");
const { NODE_OPTIONS: _node, ...environment } = process.env;
const env = { ...environment, PATH: "/opt/homebrew/bin:/usr/bin:/bin", HOME: join(repository, ".scratch/offline-home"), PI_CODING_AGENT_DIR: join(repository, ".scratch/offline-agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };

async function comparisonFixture(): Promise<RunInput> {
  const input = await fixture();
  input.models[0]!.baseUrl = input.resolvedModels![0]!.baseUrl = "http://127.0.0.1:8080/v1";
  input.comparison = { modes: ["defaults"], targets: { native: { repository }, current: { repository: baseline }, candidate: { repository } } };
  input.scenarios = [{ id: "e1", config: input.scenarios[0]!.config }];
  input.limits.maxDurationMs = 15000;
  return input;
}
function publicLimits(input: RunInput, limits: Record<string, unknown>) {
  return { target: input.target, limits, observations: ["stock_rpc"], scenarios: input.scenarios.map(({ id, variant }) => ({ id, variant })), comparison: input.comparison };
}

test("public stdin omits or nulls call/token totals and rejects invalid numbers", async () => {
  const input = await fixture();
  const script = join(repository, "scripts/verify-live.mjs");
  const run = (limits: unknown) => spawnSync(process.execPath, [script, "--preflight"], {
    input: JSON.stringify({ ...publicSelection(input), limits }),
    encoding: "utf8",
    env: childEnvironment(join(repository, ".scratch")),
  });
  const omitted = run({ maxDurationMs: input.limits.maxDurationMs, maxCostUsd: input.limits.maxCostUsd, maxOutputTokens: input.limits.maxOutputTokens });
  assert.equal(omitted.status, 0, omitted.stderr);
  const omittedOut = JSON.parse(omitted.stdout);
  assert.equal(omittedOut.limits.maxCalls, null);
  assert.equal(omittedOut.limits.maxTotalTokens, null);
  const explicit = run({ ...input.limits, maxCalls: null, maxTotalTokens: null });
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).limits.maxCalls, null);
  const mixed = run({ ...input.limits, maxCalls: 1001, maxTotalTokens: null });
  assert.equal(mixed.status, 0, mixed.stderr);
  const mixedOut = JSON.parse(mixed.stdout);
  assert.equal(mixedOut.limits.maxCalls, 1001);
  assert.equal(mixedOut.limits.maxTotalTokens, null);
  for (const limits of [
    { ...input.limits, maxCalls: 0 },
    { ...input.limits, maxTotalTokens: 1.5 },
    { ...input.limits, maxTotalTokens: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.notEqual(run(limits).status, 0);
  assert.throws(() => parseInput({ ...input, limits: { ...input.limits, maxCalls: Infinity } }));
  assert.throws(() => parseInput({ ...input, limits: { ...input.limits, maxTotalTokens: Number.NaN } }));
});

test("comparison public stdin and shared groups proceed without cumulative call/token gates", async () => {
  const input = await comparisonFixture();
  input.limits.maxCalls = null;
  input.limits.maxTotalTokens = null;
  const publicRun = spawnSync(process.execPath, [compareScript, "--preflight"], {
    env: { ...env, PI_PROVIDER: input.models[0]!.provider, PI_MODEL: input.models[0]!.id },
    input: JSON.stringify(publicLimits(input, { maxDurationMs: input.limits.maxDurationMs, maxCostUsd: input.limits.maxCostUsd, maxOutputTokens: input.limits.maxOutputTokens })),
    encoding: "utf8",
  });
  assert.equal(publicRun.status, 0, publicRun.stderr);
  const preflight = JSON.parse(publicRun.stdout);
  assert.equal(preflight.limits.maxCalls, null);
  assert.equal(preflight.limits.maxTotalTokens, null);
  try {
    const report = await executeComparison(input, repository, mockWorker, new AbortController().signal);
    assert.equal(report.children.length, 3);
    assert.notEqual(report.reason, "CALL_LIMIT");
    assert.notEqual(report.reason, "TOKEN_LIMIT");
    assert.equal(report.selection.limits.maxCalls, null);
    assert.equal(report.selection.limits.maxTotalTokens, null);
  } finally { await rm(input.target.stateRoot, { recursive: true, force: true }); }
});

test("comparison opt-in finite call and token caps refuse the next child before effects", async () => {
  const calls = await comparisonFixture();
  calls.limits.maxCalls = 1;
  calls.limits.maxTotalTokens = null;
  try {
    const report = await executeComparison(calls, repository, ledgerWorker, new AbortController().signal);
    assert.equal(report.reason, "CALL_LIMIT");
    assert.equal(report.children.length, 1);
    assert.equal(report.usage.calls, 1);
    assert.equal(report.usage.reservedTokens, 100);
  } finally { await rm(calls.target.stateRoot, { recursive: true, force: true }); }
  const tokens = await comparisonFixture();
  tokens.limits.maxCalls = null;
  tokens.limits.maxTotalTokens = 1;
  try {
    const report = await executeComparison(tokens, repository, mockWorker, new AbortController().signal);
    assert.equal(report.reason, "TOKEN_LIMIT");
    assert.equal(report.children.length, 0);
  } finally { await rm(tokens.target.stateRoot, { recursive: true, force: true }); }
});

test("public stdin stock subjob serializes omitted totals and still records multiple requests", { timeout: 115000 }, async () => {
  const input = await fixture();
  input.observations = ["stock_rpc"];
  input.target.cleanup = "remove";
  const selection = { ...publicSelection(input), limits: { maxDurationMs: input.limits.maxDurationMs, maxCostUsd: input.limits.maxCostUsd, maxOutputTokens: input.limits.maxOutputTokens } };
  const options = { cwd: repository, encoding: "utf8" as const, timeout: 105000, maxBuffer: 64_000_000, env: childEnvironment(repository + "/.scratch") };
  try {
    const preflight = spawnSync(process.execPath, ["scripts/verify-live.mjs", "--preflight"], { ...options, input: JSON.stringify(selection) });
    assert.equal(preflight.status, 0, preflight.stderr);
    assert.equal(JSON.parse(preflight.stdout).limits.maxCalls, null);
    const result = spawnSync(process.execPath, ["scripts/verify-live.mjs", "--observe-stock"], { ...options, input: JSON.stringify(selection) });
    assert.equal(result.status, 0, result.stdout.slice(0, 3000) + result.stderr + String(result.error ?? ""));
    const report = JSON.parse(result.stdout);
    assert.equal(report.selection.limits.maxCalls, null);
    assert.equal(report.selection.limits.maxTotalTokens, null);
    assert.equal(report.stock.length, 1);
    assert(report.stock[0].requests > 1, `stock subjob made ${report.stock[0].requests} requests`);
    assert.equal(report.cleanup, "removed");
  } finally { await rm(input.target.stateRoot, { recursive: true, force: true }); }
});
