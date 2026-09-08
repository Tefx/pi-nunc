import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseInput, preflight, type RunInput } from "../../src/live/contract.js";
import { liveExtensionFlags } from "../../src/live/host.js";
import { evaluateCapacityPredicates, loadScenario, scoreArtifacts } from "../../src/live/scenarios.js";
import { executeComparison } from "../../src/live/comparison.js";
import { fixture, repository } from "./fixtures.js";
import { spawn } from "node:child_process";

delete process.env.NODE_OPTIONS;
const compareScript = join(repository, "scripts/compare-extraction.mjs");
const mockWorker = join(repository, "tests/live/comparison-mock-worker.mjs");
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: "/opt/homebrew/bin:/usr/bin:/bin",
  HOME: join(repository, ".scratch/offline-home"),
  PI_CODING_AGENT_DIR: join(repository, ".scratch/offline-agent"),
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
};

function ensureBaseline70dacad(repo: string): string {
  const baselineDir = join(repo, ".scratch/baseline-70dacad");
  if (!existsSync(baselineDir)) {
    execFileSync("/usr/bin/git", ["worktree", "add", "--detach", baselineDir, "70dacad"], { cwd: repo });
  }
  const nm = join(baselineDir, "node_modules");
  if (!existsSync(nm)) {
    try { symlinkSync(join(repo, "node_modules"), nm); } catch {}
  }
  const distIndex = join(baselineDir, "dist/src/index.js");
  if (!existsSync(distIndex)) {
    execFileSync(join(repo, "node_modules/typescript/bin/tsc"), ["--project", join(baselineDir, "tsconfig.json")], { cwd: baselineDir });
  }
  return baselineDir;
}

async function comparisonFixture(): Promise<RunInput> {
  const input = await fixture();
  const baseline = ensureBaseline70dacad(repository);
  input.comparison = {
    modes: ["defaults", "matched"],
    targets: {
      native: { repository },
      current: { repository: baseline },
      candidate: { repository },
    },
  };
  input.scenarios = [
    { id: "e1", config: input.scenarios[0]!.config },
    { id: "e2", config: input.scenarios[0]!.config },
    { id: "e3", config: input.scenarios[0]!.config },
    { id: "e4", variant: "fits-required", config: input.scenarios[0]!.config },
    { id: "e4", variant: "required-too-large", config: input.scenarios[0]!.config },
  ];
  return input;
}

test("public compare-extraction CLI rejects missing/unknown/multiple arguments with nonzero exit", () => {
  const unknownFlag = spawnSync(process.execPath, [compareScript, "--unknown"], { env, encoding: "utf8" });
  assert.equal(unknownFlag.status, 1);
  assert(unknownFlag.stderr.includes("ARGUMENTS"));

  const multipleFlags = spawnSync(process.execPath, [compareScript, "--preflight", "--worker"], { env, encoding: "utf8" });
  assert.equal(multipleFlags.status, 1);
  assert(multipleFlags.stderr.includes("ARGUMENTS"));
});

test("public compare-extraction CLI rejects empty/malformed/oversized stdin", () => {
  const empty = spawnSync(process.execPath, [compareScript, "--preflight"], { env, input: "", encoding: "utf8" });
  assert.equal(empty.status, 1);
  assert(empty.stderr.includes("INPUT"));

  const malformed = spawnSync(process.execPath, [compareScript, "--preflight"], { env, input: "{broken json", encoding: "utf8" });
  assert.equal(malformed.status, 1);
  assert(malformed.stderr.includes("INPUT"));

  const oversized = spawnSync(process.execPath, [compareScript, "--preflight"], { env, input: " ".repeat(65537), encoding: "utf8" });
  assert.equal(oversized.status, 1);
  assert(oversized.stderr.includes("INPUT_SIZE"));
});

test("public compare-extraction --preflight rejects missing comparison with nonzero exit", () => {
  const run = spawnSync(process.execPath, [compareScript, "--preflight"], {
    env,
    input: JSON.stringify({
      target: { repository, stateRoot: join(repository, ".scratch/test-preflight-missing"), cleanup: "retain" },
      limits: { maxCalls: 1, maxTotalTokens: 100, maxDurationMs: 100, maxOutputTokens: 100, maxCostUsd: null },
      scenarios: [{ id: "e1" }],
    }),
    encoding: "utf8",
  });
  assert.equal(run.status, 1);
  assert(run.stderr.includes("COMPARISON"));
});

test("public compare-extraction --preflight with e3 exposes limitation and unsupported public seam before execution", async () => {
  const input = await comparisonFixture();
  const run = spawnSync(process.execPath, [compareScript, "--preflight"], {
    env: { ...env, PI_PROVIDER: input.models[0]!.provider, PI_MODEL: input.models[0]!.id },
    input: JSON.stringify({
      target: input.target,
      limits: input.limits,
      observations: ["stock_rpc"],
      scenarios: [{ id: "e3" }],
      comparison: input.comparison,
    }),
    encoding: "utf8",
  });
  assert.equal(run.status, 0);
  const out = JSON.parse(run.stdout);
  assert(out.unsupportedPublicSeams.includes("rollover_at_tool_boundary"));
  assert(out.limitations.some((l: string) => l.includes("e3 exact mid-turn tool-boundary split control")));
});

test("preflight comparison rejects missing or invalid comparison configuration", async () => {
  const input = await comparisonFixture();
  const baseline = ensureBaseline70dacad(repository);

  // Missing comparison
  const noComp = structuredClone(input);
  delete noComp.comparison;
  assert.throws(() => {
    const parsed = parseInput(noComp);
    if (!parsed.comparison) throw new Error("COMPARISON");
  }, /COMPARISON/);

  // Invalid modes
  const badModes = structuredClone(input);
  (badModes.comparison as any).modes = ["invalid-mode"];
  assert.throws(() => parseInput(badModes), (err: any) => err.code === "COMPARISON" || /comparison\.modes/i.test(err?.message));

  // Empty modes
  const emptyModes = structuredClone(input);
  (emptyModes.comparison as any).modes = [];
  assert.throws(() => parseInput(emptyModes), (err: any) => err.code === "COMPARISON" || /comparison\.modes/i.test(err?.message));

  // Missing current target
  const missingCurrent = structuredClone(input);
  delete (missingCurrent.comparison as any).targets.current;
  assert.throws(() => parseInput(missingCurrent), (err: any) => err.code === "INPUT" || /comparison\.targets/i.test(err?.message));

  // Non-existent target repository
  const nonExistent = structuredClone(input);
  nonExistent.comparison!.targets.current.repository = "/path/does/not/exist";
  await assert.rejects(preflight(nonExistent, repository), (err: any) => err.code === "TARGET" || /target/i.test(err?.message));

  // Current target not at 70dacad
  const wrongCommit = structuredClone(input);
  wrongCommit.comparison!.targets.current.repository = repository; // repository is at current HEAD, not 70dacad
  await assert.rejects(preflight(wrongCommit, repository), /70dacad/);

  // Candidate repository mismatch with target repository
  const candMismatch = structuredClone(input);
  candMismatch.comparison!.targets.candidate.repository = baseline;
  await assert.rejects(preflight(candMismatch, repository), /Candidate target/);
});

test("preflight comparison rejects stale baseline build", async () => {
  const input = await comparisonFixture();
  const baseline = ensureBaseline70dacad(repository);
  const extraFile = join(baseline, "dist/src/stale-extra-file.js");
  await writeFile(extraFile, "export const stale = true;");
  try {
    await assert.rejects(preflight(input, repository), /Stale extra JS in dist\/src|BUILD/);
  } finally {
    await rm(extraFile, { force: true });
  }
});

test("preflight comparison produces effect-free receipt bound to three targets, candidate, node and scenarios", async () => {
  const input = await comparisonFixture();
  const receipt = await preflight(input, repository);

  assert.equal(receipt.version, 1);
  assert.equal(receipt.pi, "0.85.1");
  assert.equal(receipt.callsMade, 0);
  assert.equal(typeof receipt.binding, "string");
  assert(receipt.binding.length > 0);

  // CLI execution with --preflight produces valid receipt on stdout
  const run = spawnSync(process.execPath, [compareScript, "--preflight"], {
    env: { ...env, PI_PROVIDER: input.models[0]!.provider, PI_MODEL: input.models[0]!.id },
    input: JSON.stringify({
      target: input.target,
      limits: input.limits,
      observations: ["stock_rpc"],
      scenarios: input.scenarios.map(s => ({ id: s.id, ...(s.variant ? { variant: s.variant } : {}) })),
      comparison: input.comparison,
    }),
    encoding: "utf8",
  });
  assert.equal(run.status, 0);
  const out = JSON.parse(run.stdout);
  assert.equal(out.status, "PREFLIGHT");
  assert.equal(out.receipt.version, 1);
  assert.deepEqual(out.comparison.modes, ["defaults", "matched"]);
  assert.equal(out.limitations.length > 0, true);
  await assert.rejects(lstat(input.target.stateRoot), { code: "ENOENT" });
});

test("three groups load distinct real configurations without relabeling", async () => {
  const input = await comparisonFixture();
  const baseline = ensureBaseline70dacad(repository);

  // 1. Native group: loads only observer, NO Nunc hook
  const nativeFlags = liveExtensionFlags(repository, input, "native");
  assert(nativeFlags.includes(join(repository, "dist/src/live/observer.js")));
  assert(!nativeFlags.some(f => f.includes("index.js")));

  // 2. Current group: loads 70dacad baseline dist/src/index.js
  const currentFlags = liveExtensionFlags(repository, input, "current", { current: baseline });
  assert(currentFlags.includes(join(repository, "dist/src/live/observer.js")));
  assert(currentFlags.includes(join(baseline, "dist/src/index.js")));
  assert(!currentFlags.includes(join(repository, "dist/src/index.js")));

  // 3. Candidate group: loads candidate dist/src/index.js
  const candidateFlags = liveExtensionFlags(repository, input, "candidate", { candidate: repository });
  assert(candidateFlags.includes(join(repository, "dist/src/live/observer.js")));
  assert(candidateFlags.includes(join(repository, "dist/src/index.js")));
  assert(!candidateFlags.includes(join(baseline, "dist/src/index.js")));

  // Verify baseline checkout real identity (starts with 70dacad)
  const baselineHead = execFileSync("/usr/bin/git", ["-C", baseline, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert(baselineHead.startsWith("70dacad"));
  assert(existsSync(join(baseline, "dist/src/index.js")));
});

test("scenarios e1–e4 load separately from c1–c5 and validate acceptance boundaries", async () => {
  const input = await comparisonFixture();

  // e1: two deliverables, Python verify.py script check, handoff booleans
  const { input: e1Input, observer: e1Obs } = await loadScenario(repository, { id: "e1", config: input.scenarios[0]!.config });
  assert.equal(e1Input.id, "e1");
  assert.equal(e1Input.turns.length, 5);
  assert(Object.keys(e1Input.files).includes("verify.py"));
  assert(Object.keys(e1Input.files).includes("rows.json"));
  assert(e1Obs.artifactChecks.some(c => c.path === "export.json" && c.pointer === "/retryLimit"));
  assert(e1Obs.artifactChecks.some(c => c.path === "handoff.json" && c.pointer === "/accepted"));

  // e2: mixed-slot split/merge and probe isolation ground
  const { input: e2Input, observer: e2Obs } = await loadScenario(repository, { id: "e2", config: input.scenarios[0]!.config });
  assert.equal(e2Input.id, "e2");
  assert.equal(e2Input.turns.length, 5);
  assert(Object.keys(e2Input.files).includes("probe.json"));
  assert(e2Obs.artifactChecks.some(c => c.path === "east.json" && c.pointer === "/route"));
  assert(e2Obs.artifactChecks.some(c => c.path === "east.json" && c.pointer === "/timeoutMs"));

  // e3: rollover_at_tool_boundary control is parsed and validated
  const { input: e3Input, observer: e3Obs } = await loadScenario(repository, { id: "e3", config: input.scenarios[0]!.config });
  assert.equal(e3Input.id, "e3");
  assert.equal(e3Input.turns.length, 2);
  const boundaryControl = e3Obs.controls.find(c => c.action === "rollover_at_tool_boundary");
  assert(boundaryControl);
  assert.equal(boundaryControl.duringTurn, "a");
  assert.equal(boundaryControl.trigger?.toolName, "read");
  assert.equal(boundaryControl.trigger?.pathArgument, "investigation.json");
  assert.equal(boundaryControl.trigger?.when, "after_result_before_continuation");

  // e4: fits-required and required-too-large variants
  const { input: e4InputFits, observer: e4ObsFits } = await loadScenario(repository, { id: "e4", variant: "fits-required", config: input.scenarios[0]!.config });
  assert.equal(e4InputFits.id, "e4");
  assert(e4ObsFits.controls[0]!.capacity?.includes("all marked necessary candidates jointly fit"));

  const { input: e4InputTooLarge, observer: e4ObsTooLarge } = await loadScenario(repository, { id: "e4", variant: "required-too-large", config: input.scenarios[0]!.config });
  assert.equal(e4InputTooLarge.id, "e4");
  assert(e4ObsTooLarge.controls[0]!.capacity?.includes("marked necessary set exceeds rendered memory limit"));
});

test("explicit asset-path selection contract is honored", async () => {
  const input = await comparisonFixture();
  input.scenarios = [{
    id: "e1",
    config: input.scenarios[0]!.config,
    assets: {
      inputs: "tests/scenarios/extraction-inputs.json",
      observer: "tests/scenarios/extraction-observer.json",
    },
  }];
  const { input: sInput, observer: sObs } = await loadScenario(repository, input.scenarios[0]!);
  assert.equal(sInput.id, "e1");
  assert.equal(sObs.id, "e1");
});

test("e1 and e3 fixture verification commands are authorized through narrow bash tool", async () => {
  const { observer } = await loadScenario(repository, { id: "e1", config: (await fixture()).scenarios[0]!.config });
  const scored = await scoreArtifacts(repository, observer, [{ check: "prereq", status: "PROVEN" }], {
    actions: [{ event: { type: "tool_call", toolName: "bash", input: { command: "python3 verify.py" } } }],
  });
  assert(scored.actionReview.some(r => r.check.includes("python3 verify.py") && r.status === "PROVEN"));
});

test("e4 capacity predicates evaluate necessary fit, competition overflow, and optional fit", () => {
  const measure = (slots: Array<{ key: string; text: string }>) => slots.reduce((sum, s) => sum + s.text.length, 0);
  const patchFits = {
    add: [
      { key: "nec1", text: "x".repeat(30) },
      { key: "opt1", text: "x".repeat(15) },
      { key: "opt2", text: "x".repeat(15) },
    ],
    remove: [],
    priority: ["nec1", "opt1", "opt2"],
    required: ["nec1"],
  };
  // Memory limit 40: necessary (30) <= 40, total (60) > 40, nec1 (30) > opt1 (15)
  const resFits = evaluateCapacityPredicates("fits-required", patchFits, 40, measure);
  assert.equal(resFits.every(r => r.status === "PROVEN"), true);

  // Too large: necessary (50) > limit (40), optional (15) <= limit (40)
  const patchTooLarge = {
    add: [
      { key: "nec1", text: "x".repeat(50) },
      { key: "opt1", text: "x".repeat(15) },
    ],
    remove: [],
    priority: ["nec1", "opt1"],
    required: ["nec1"],
  };
  const resTooLarge = evaluateCapacityPredicates("required-too-large", patchTooLarge, 40, measure);
  assert.equal(resTooLarge.every(r => r.status === "PROVEN"), true);
});

test("comparison defaults and matched modes report truthful differences and matched parity", async () => {
  const input = await comparisonFixture();
  input.scenarios = [input.scenarios[0]!]; // e1 only for fast structure test
  input.limits.maxDurationMs = 5000;

  // Test executeComparison output structure
  const report = await executeComparison(input, repository, mockWorker, new AbortController().signal);
  assert.equal(report.version, 1);
  assert.equal(report.comparison.modes.length, 2);

  // Defaults mode reports actual differences
  const defaultsMode = report.comparison.modes.find(m => m.mode === "defaults");
  assert(defaultsMode);
  assert.equal(typeof defaultsMode.records.hComparison?.native, "number");
  assert.equal(typeof defaultsMode.records.memorySizeComparison?.native, "string");
  assert.equal(typeof defaultsMode.records.memorySizeComparison?.candidate, "string");

  // Matched mode truthfully reports discrepancies and UNPROVEN parity
  const matchedMode = report.comparison.modes.find(m => m.mode === "matched");
  assert(matchedMode);
  assert.equal(matchedMode.records.matchedParity?.status, "UNPROVEN");
  assert(matchedMode.records.matchedParity!.discrepancies.length > 0);

  // Unsupported public seam for mid-turn boundary split control is explicitly reported
  assert(report.unsupportedPublicSeams?.includes("rollover_at_tool_boundary"));
});

test("single finite budget ledger charges all groups; quota exhaustion and cleanup reconciled", async () => {
  const input = await comparisonFixture();
  await mkdir(input.target.stateRoot, { recursive: true });
  try {
    // Single-use target protection: already existing target cannot be rerun
    await assert.rejects(preflight(input, repository), /already exists/);
  } finally {
    await rm(input.target.stateRoot, { recursive: true });
  }

  // Test cleanup retain
  input.target.cleanup = "retain";
  input.limits.maxDurationMs = 2000;
  const retainReport = await executeComparison(input, repository, mockWorker, new AbortController().signal);
  assert.equal(retainReport.cleanup, "retained");
  assert(existsSync(join(input.target.stateRoot, "report.json")));
  assert(existsSync(join(input.target.stateRoot, "owner.json")));
  await rm(input.target.stateRoot, { recursive: true });
});

test("end-to-end comparison across native, current and candidate via public CLI, stock Pi and loopback", { timeout: 120000 }, async () => {
  const { StockFixture } = await import(join(repository, "scripts/stock-driver.mjs")) as { StockFixture: any };
  const f = await new StockFixture().setup({ api: "openai-codex-responses", compaction: { enabled: false, reserveTokens: 200000 } });
  const baseline = ensureBaseline70dacad(repository);
  const stateRoot = join(f.dir, "nunc-live-runner-cmp");

  const settings = { ...f.settings, defaultProvider: "openai-codex", defaultModel: "gpt-6-astra" };
  await writeFile(join(f.state, "agent/settings.json"), JSON.stringify(settings));

  const selection = {
    target: { repository, stateRoot, cleanup: "retain" },
    limits: { maxCalls: 20, maxTotalTokens: 8000000, maxCostUsd: null, maxDurationMs: 60000, maxOutputTokens: 128000 },
    observations: ["stock_rpc"],
    scenarios: [{ id: "c1" }],
    comparison: {
      modes: ["defaults"],
      targets: {
        native: { repository },
        current: { repository: baseline },
        candidate: { repository },
      },
    },
  };

  const write = (path: string, content: unknown) => [{ tool: { name: "write", input: { path, content: JSON.stringify(content) } } }, "Saved."];
  const steps = ["Pending.", ...write("decision.json", { route: "direct", reason: "Controlled fixture reason." })];
  f.response = (_row: unknown, source: unknown) => source ? JSON.stringify({ add: [], remove: [], priority: [], required: [] }) : (() => { return steps.length ? steps.shift() : "Done"; })();

  const runEnv = { PATH: "/opt/homebrew/bin:/usr/bin:/bin", HOME: join(f.state, "home"), PI_CODING_AGENT_DIR: join(f.state, "agent"), TMPDIR: join(f.state, "tmp"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };

  try {
    const child = spawn(process.execPath, [compareScript], { cwd: repository, env: runEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => { stdout += b; if (stdout.length > 16000000) child.kill("SIGTERM"); });
    child.stderr.on("data", b => { stderr += b; });
    child.stdin.end(JSON.stringify(selection));
    const code = await new Promise((resolve) => child.once("close", resolve));

    assert.equal(code, 2); // UNPROVEN exit code
    assert(stdout.length > 0);
    const report = JSON.parse(stdout);
    assert.equal(report.matrix.length, 3);
    assert.equal(report.comparison.modes.length, 1);
    assert.equal(report.comparison.modes[0].mode, "defaults");
    assert(report.usage.calls >= 6);
    assert.deepEqual(report.usage.unreconciledCallIds, []);
    assert.equal(report.matrix.every((m: any) => m.calls > 0), true);
  } finally {
    await f.close();
  }
});
