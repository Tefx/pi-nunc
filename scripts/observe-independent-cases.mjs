#!/usr/bin/env node
// purpose: Actual verify-live supervisor/worker + stock Pi loopback two-case continuation.
// usage: node scripts/observe-independent-cases.mjs [--quota|--unlimited]
// effects: Isolated target, two native workers, controlled HTTP only.
// requires: Committed locked build and stock-driver.mjs. Scripted replies do not prove memory quality.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile, rm, lstat } from "node:fs/promises";
import { join } from "node:path";
import { StockFixture, root } from "./stock-driver.mjs";
import { readLedger, ledgerSummary } from "../dist/src/live/budget.js";

const quota = process.argv[2] === "--quota";
const unlimited = process.argv[2] === "--unlimited";
const f = await new StockFixture().setup({ compaction: { enabled: false, reserveTokens: 50000 } });
const stateRoot = join(f.dir, "nunc-live-independent");
const settings = { ...f.settings, defaultProvider: "groq", defaultModel: "nunc-native" };
await writeFile(join(f.state, "agent/settings.json"), JSON.stringify(settings));
const write = (path, content) => [{ tool: { name: "write", input: { path, content: JSON.stringify(content) } } }, "Saved."];
const steps = ["Pending.", ...write("sum.json", { sum: 46 }), ...write("product.json", { product: 104 }), ...write("difference.json", { difference: 63 }), ...write("retry.json", { supportedNodeMajors: [18], retryLimit: 2, retryBeforeCommit: true, retryAfterSuccessfulCommit: false })];
let firstMain = true;
f.response = (_row, source) => {
  if (source) return JSON.stringify({ add: [], remove: [], priority: source.M.map(s => s.id), required: [] });
  if (firstMain) { firstMain = false; return { status: 429, message: "Controlled rate-limit response" }; }
  return steps.shift() ?? "Continue.";
};
const selection = {
  target: { repository: root, stateRoot, cleanup: "retain" },
  limits: {
    ...(unlimited ? {} : { maxCalls: quota ? 1 : 20, maxTotalTokens: 8_000_000 }),
    maxCostUsd: null, maxDurationMs: 90000, maxOutputTokens: 20000,
  },
  scenarios: [{ id: "c1" }, { id: "c2" }],
  overrides: [{ requirement: "independent-case-continuation", reason: "First native HTTP error must not block a later authorized isolated case", config: { nunc: { memory: { fraction: 0.1 }, rolling: { keepRecentFraction: 0.2 }, extraction: { toolResults: "full", outputTokens: 2048 }, budget: { safetyTokens: 512, growthTokens: 128 } }, compaction: { enabled: false, reserveTokens: 50000, keepRecentTokens: 1 }, retentionCalibration: { minFraction: 0.0001, maxFraction: 0.95 } } }],
};
const env = { PATH: "/opt/homebrew/bin:/usr/bin:/bin", HOME: join(f.state, "home"), PI_CODING_AGENT_DIR: join(f.state, "agent"), TMPDIR: join(f.state, "tmp"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
function run(flags = []) {
  const child = spawn(process.execPath, [join(root, "scripts/verify-live.mjs"), ...flags], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", b => { stdout += b; if (stdout.length > 16_000_000) child.kill("SIGTERM"); });
  child.stderr.on("data", b => { stderr += b; });
  child.stdin.end(JSON.stringify(selection));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
}
let result = { status: "FAIL", case: unlimited ? "unlimited" : quota ? "quota" : "continue" };
try {
  const preflight = await run(["--preflight"]);
  assert.equal(preflight.code, 0, preflight.stderr);
  assert.equal(f.requests.length, 0);
  await assert.rejects(lstat(stateRoot), { code: "ENOENT" });
  const execution = await run();
  await writeFile(join(f.dir, "independent-report.json"), execution.stdout);
  assert.notEqual(execution.code, 0, execution.stdout.slice(0, 4000) + execution.stderr);
  const report = JSON.parse(execution.stdout);
  assert.equal(report.status, "UNPROVEN");
  assert.equal(report.children.length, 2);
  assert.equal(report.segments.length, 2);
  assert.equal(report.segments[0]?.status, "UNPROVEN");
  assert.equal(report.segments[0]?.reason, "MAIN_RESPONSE");
  assert.match(report.segments[0]?.diagnostic ?? "", /status=429|PROVIDER_HTTP/);
  const ledger = readLedger(join(stateRoot, "calls.jsonl"));
  const summary = ledgerSummary(ledger);
  assert.deepEqual(summary.unreconciledCallIds, []);
  const reserves = ledger.filter(r => r.kind === "reserve");
  assert.equal(reserves[0]?.caseKey, "c1");
  const firstTerminal = ledger.find(r => r.kind === "terminal" && r.id === 1);
  assert(firstTerminal && firstTerminal.kind === "terminal");
  assert.equal(firstTerminal.usage.totalTokens, null);
  if (quota) {
    assert.equal(f.requests.length, 1);
    assert.equal(summary.calls, 1);
    assert.equal(reserves.length, 1);
    assert.match(`${report.segments[1]?.reason ?? ""} ${report.segments[1]?.diagnostic ?? ""}`, /CALL_LIMIT/);
  } else {
    assert(f.requests.length > 1, `second case made no HTTP: ${f.requests.length}`);
    assert(summary.calls >= 2, `second case reserved nothing: ${summary.calls}`);
    assert.equal(reserves.some(r => r.caseKey === "c2"), true);
    assert.equal(report.segments[1]?.scenario, "c2");
    if (unlimited) {
      assert.equal(report.selection.limits.maxCalls, null);
      assert.equal(report.selection.limits.maxTotalTokens, null);
      assert.doesNotMatch(`${report.reason ?? ""} ${report.segments.map(s => `${s.reason ?? ""} ${s.diagnostic ?? ""}`).join(" ")}`, /CALL_LIMIT|TOKEN_LIMIT/);
    }
  }
  result = { status: "PROVEN_CONTROLLED", case: unlimited ? "unlimited" : quota ? "quota" : "continue", children: report.children.length, calls: summary.calls, requests: f.requests.length, memoryQuality: "UNPROVEN: scripted service", evidence: f.dir };
} catch (error) {
  result.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  await rm(stateRoot, { recursive: true, force: true });
  await f.close(result);
  console.log(JSON.stringify(result));
}
