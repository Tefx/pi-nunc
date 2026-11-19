import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { toolPath, childEnvironment } from "../../src/live/host.js";
import { fixture, repository } from "./fixtures.js";
for (const scenario of ["c1", "c2", "c3", "outside", "codex", "codex-defaults", "codex-timeout", "c4-full", "c4-capacity", "late-d", "late-d-cancel", "late-d-race"]) test(`downstream ${scenario}: actual stock CLI/tools/native service/calibration/persistence (controlled responses)`, { timeout: scenario === "c4-full" || scenario === "c4-capacity" || scenario.startsWith("late-") ? 90000 : 60000 }, () => {
  const result = spawnSync(process.execPath, [join(repository, "scripts/observe-segment.mjs"), scenario], { encoding: "utf8", env: childEnvironment(join(repository, ".scratch")), timeout: scenario === "c4-full" || scenario === "c4-capacity" || scenario.startsWith("late-") ? 85000 : 55000, maxBuffer: 4_000_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error ?? "")); console.log(result.stdout.trim());
});
test("actual supervisor/worker continues an independent case after a native HTTP error", { timeout: 150000 }, () => {
  const result = spawnSync(process.execPath, [join(repository, "scripts/observe-independent-cases.mjs")], { encoding: "utf8", env: childEnvironment(join(repository, ".scratch")), timeout: 140000, maxBuffer: 4_000_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error ?? "")); console.log(result.stdout.trim());
});
test("actual supervisor/worker stops before another child once the shared call ceiling is exhausted", { timeout: 150000 }, async () => {
  const { StockFixture } = await import(join(repository, "scripts/stock-driver.mjs"));
  const f = await new StockFixture().setup({ compaction: { enabled: false, reserveTokens: 50000 } });
  const stateRoot = join(f.dir, "nunc-live-quota");
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await writeFile(join(f.state, "agent/settings.json"), JSON.stringify({ ...f.settings, defaultProvider: "groq", defaultModel: "nunc-native" }));
    f.response = () => ({ status: 429, message: "Controlled rate-limit response" });
    const selection = {
      target: { repository, stateRoot, cleanup: "retain" },
      limits: { maxCalls: 1, maxTotalTokens: 8000000, maxCostUsd: null, maxDurationMs: 90000, maxOutputTokens: 20000 },
      scenarios: [{ id: "c1" }, { id: "c2" }],
      overrides: [{ requirement: "quota-closure", reason: "Exhausted quota stops the next child before effects", config: { nunc: {}, compaction: { enabled: false, reserveTokens: 50000, keepRecentTokens: 1 } } }],
    };
    const env = { ...childEnvironment(f.state), PI_CODING_AGENT_DIR: join(f.state, "agent") };
    child = spawn(process.execPath, [join(repository, "scripts/verify-live.mjs")], { cwd: repository, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout!.on("data", b => { stdout += b; if (stdout.length > 4000000) child!.kill("SIGTERM"); });
    child.stderr!.on("data", b => { stderr += b; });
    const done = new Promise<number | null>((resolve, reject) => { child!.once("error", reject); child!.once("close", resolve); });
    child.stdin!.end(JSON.stringify(selection));
    const timer = setTimeout(() => child!.kill("SIGKILL"), 100000);
    let code: number | null;
    try { code = await done; } finally { clearTimeout(timer); }
    assert.equal(code, 2, stdout + stderr);
    const report = JSON.parse(stdout);
    assert.equal(report.status, "UNPROVEN");
    assert.equal(report.reason, "CALL_LIMIT");
    assert.equal(report.children.length, 1);
    assert.equal(report.segments.length, 1);
    assert.equal(report.segments[0].reason, "MAIN_RESPONSE");
    assert.match(report.segments[0].diagnostic, /status=429|PROVIDER_HTTP/);
    assert.equal(f.requests.length, 1);
    assert.equal(report.usage.calls, 1);
    assert.deepEqual(report.usage.unreconciledCallIds, []);
    const persisted = JSON.parse(await readFile(join(stateRoot, "report.json"), "utf8"));
    assert.equal(persisted.children.length, 1);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise(resolve => child!.once("close", resolve)); }
    await rm(stateRoot, { recursive: true, force: true });
    await f.close();
  }
});
test("actual supervisor/worker keeps later cases when public call/token totals are omitted", { timeout: 150000 }, () => {
  const result = spawnSync(process.execPath, [join(repository, "scripts/observe-independent-cases.mjs"), "--unlimited"], { encoding: "utf8", env: childEnvironment(join(repository, ".scratch")), timeout: 140000, maxBuffer: 4_000_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error ?? "")); console.log(result.stdout.trim());
});
test("default-input CLI preflight and supervisor/worker delegate existing fictional native Codex without an auth copy", { timeout: 150000 }, () => {
  const result = spawnSync(process.execPath, [join(repository, "scripts/observe-runner.mjs")], { encoding: "utf8", env: childEnvironment(join(repository, ".scratch")), timeout: 140000, maxBuffer: 4_000_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error ?? "")); console.log(result.stdout.trim());
});
test("system-temp public-input supervisor/worker reaches native Codex and cleans its external task root", { timeout: 150000 }, () => {
  const env = childEnvironment(join(repository, ".scratch")); delete env.TMPDIR;
  const result = spawnSync(process.execPath, [join(repository, "scripts/observe-runner.mjs"), "--system-temp"], { encoding: "utf8", env, timeout: 140000, maxBuffer: 4_000_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error ?? "")); console.log(result.stdout.trim());
});
test("scenario-local tool paths reject traversal, protected names and external symlinks", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  const cwd = join(input.target.stateRoot, "task"); await mkdir(cwd); await writeFile(join(cwd, "valid.txt"), "ok");
  try {
    assert.equal(await toolPath(cwd, "valid.txt"), join(cwd, "valid.txt")); assert.equal(await toolPath(cwd, "new/file.txt"), join(cwd, "new/file.txt"));
    assert.equal(await toolPath(cwd, ".", "read"), cwd);
    await assert.rejects(toolPath(cwd, ".", "write")); await assert.rejects(toolPath(cwd, ".", "edit"));
    for (const path of ["../calls.jsonl", "/etc/passwd", ".pi/settings.json", "auth.json", ".env"]) await assert.rejects(toolPath(cwd, path));
    await symlink(input.target.stateRoot, join(cwd, "outside")); await assert.rejects(toolPath(cwd, "outside/calls.jsonl"), /outside/);
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});
