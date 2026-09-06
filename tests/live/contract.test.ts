import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { parseInput, preflight, readBoundedJson, selectedModels, validateTarget } from "../../src/live/contract.js";
import { childEnvironment, execute } from "../../src/live/runner.js";
import { fixture, publicSelection, repository } from "./fixtures.js";

test("bounded stdin rejects empty/malformed/oversized JSON and accepts one complete object", async () => {
  for (const content of ["", "{", "{} {}", " ".repeat(65537)]) await assert.rejects(readBoundedJson([Buffer.from(content)]));
  assert.deepEqual(await readBoundedJson([Buffer.from('{"a":'), Buffer.from("1}")]), { a: 1 });
  await assert.rejects(readBoundedJson([Buffer.from([123, 34, 97, 34, 58, 34, 255, 34, 125])]), /JSON/);
});
// Deliberately invalid boundary mutations: test-only any permits deleting required fields and wrong JSON shapes.
const mutations: Array<[string, (value: Record<string, any>) => void]> = [
  ["missing cost bound", v => delete v.limits.maxCostUsd],
  ["calibration missing lower bound", v => delete v.scenarios[0].config.retentionCalibration.minFraction],
  ["calibration outside valid fraction", v => v.scenarios[0].config.retentionCalibration.minFraction = 0],
  ["calibration reversed range", v => v.scenarios[0].config.retentionCalibration = { minFraction: 0.8, maxFraction: 0.2 }],
  ["calibration missing upper bound", v => delete v.scenarios[0].config.retentionCalibration.maxFraction],
  ["calibration unknown option", v => v.scenarios[0].config.retentionCalibration.force = true],
  ["missing internal mode", v => delete v.mode], ["invalid internal mode", v => v.mode = "unknown"],
  ["absent limits", v => delete v.limits],
  ["zero calls", v => v.limits.maxCalls = 0], ["negative tokens", v => v.limits.maxTotalTokens = -1], ["fractional tokens", v => v.limits.maxTotalTokens = 1.5],
  ["invalid cost ceiling", v => v.limits.maxCostUsd = "free"], ["infinite time", v => v.limits.maxDurationMs = Infinity], ["missing output cap", v => delete v.limits.maxOutputTokens],
  ["empty model list", v => v.models = []], ["empty provider", v => v.models[0].provider = ""], ["model without capacity", v => delete v.models[0].contextWindow],
  ["empty scenario selection", v => v.scenarios = []], ["unknown scenario", v => v.scenarios[0].id = "answer"], ["duplicate scenario", v => v.scenarios.push(v.scenarios[0])],
  ["missing giant variant", v => v.scenarios[0].id = "c4"], ["late-d is not a c4 variant", v => { v.scenarios[0].id = "c4"; v.scenarios[0].variant = "late-d"; }],
  ["c2 has no late-d variant", v => v.scenarios[0].variant = "late-d"], ["smaller switch needs second model", v => v.scenarios[0].id = "c5"],
  ["missing compaction settings", v => delete v.scenarios[0].config.compaction], ["negative keepRecent", v => v.scenarios[0].config.compaction.keepRecentTokens = -1],
  ["invalid memory ratio", v => v.scenarios[0].config.nunc.memory.fraction = 1], ["invalid K ratio", v => v.scenarios[0].config.nunc.rolling.keepRecentFraction = 0],
  ["unknown config field", v => v.scenarios[0].config.nunc.expectedAnswer = "secret"], ["relative policy path", v => v.scenarios[0].config.nunc.policyFile = "./policy.md"],
  ["unknown cleanup", v => { v.target.cleanup = "elsewhere"; }],
  ["selected provider credential value rejected", v => v.credentials = { anthropic: "dummy-never-secret" }],
  ["credential source location rejected", v => v.credentialsPath = "/dummy/location"],
  ["mixed controlled/live observations", v => v.observations = ["continuation", "stock_tui"]],
  ["unknown observation", v => v.observations = ["imaginary"]],
  ["credential provider outside selection", v => v.credentials = { unrelated: "fixture" }], ["implicit target", v => delete v.target.stateRoot], ["obsolete authorization field", v => v.authorization = {}],
];
for (const [name, mutate] of mutations) test(`pre-call rejection: ${name}`, async () => {
  const input = await fixture(); mutate(input); assert.throws(() => parseInput(input));
});
test("internal offline job cannot cross the live execution boundary", async () => {
  const input = await fixture(); assert.throws(() => parseInput(input, true));
  input.mode = "native";
  assert.doesNotThrow(() => parseInput(input, true));
  await assert.rejects(execute(await fixture(), repository, join(repository, "scripts/verify-live.mjs"), new AbortController().signal));
  await assert.rejects(lstat(input.target.stateRoot), { code: "ENOENT" });
});
test("daily/existing/aliased/wrong-repository targets are refused before state creation", async () => {
  const input = await fixture();
  for (const target of [join(repository, ".pi", "nunc-live-target"), join(repository, "nunc-live-target"), join(repository, ".scratch", "../nunc-live-target")]) {
    await assert.rejects(validateTarget({ ...input, target: { ...input.target, stateRoot: target } }, repository));
  }
  await mkdir(input.target.stateRoot);
  try { await assert.rejects(validateTarget(input, repository), /already exists/); }
  finally { await rm(input.target.stateRoot, { recursive: true }); }
  const alias = join(repository, ".scratch", `alias-${Date.now()}`); await symlink(join(repository, ".scratch"), alias);
  try { await assert.rejects(validateTarget({ ...input, target: { ...input.target, stateRoot: join(alias, "nunc-live-target") } }, repository), /symlink/); }
  finally { await rm(alias); }
  await assert.rejects(validateTarget({ ...input, target: { ...input.target, repository: "/" } }, repository), /differs/);
});
test("native-resolved metadata rejects changed endpoint/capacity, unavailable models and unusable H", async () => {
  const input = await fixture(); assert.equal(selectedModels(input)[0]?.contextWindow, 200000);
  for (const mutate of [(v: typeof input) => v.models[0]!.baseUrl = "https://example.invalid", (v: typeof input) => v.models[0]!.contextWindow = 100000, (v: typeof input) => v.models[0]!.id = "unavailable", (v: typeof input) => v.scenarios[0]!.config.compaction.reserveTokens = 200000, (v: typeof input) => { delete v.resolvedModels; }]) {
    const changed = structuredClone(input); mutate(changed); assert.throws(() => selectedModels(changed));
  }
  const renamed = structuredClone(input); renamed.models[0]!.provider = "ambient-auth";
  assert.doesNotThrow(() => parseInput(renamed)); assert.throws(() => selectedModels(renamed));
});
test("tracked fixture yields effect-free receipt bound to scenario/config/limits/target", async () => {
  const input = await fixture(), receipt = await preflight(input, repository);
  assert.equal(receipt.callsMade, 0); input.receipt = receipt;
  assert.deepEqual(await preflight(input, repository), receipt);
  await assert.rejects(lstat(input.target.stateRoot), { code: "ENOENT" });
  const changed = structuredClone(input); changed.limits.maxCalls++;
  await assert.rejects(preflight(changed, repository), /does not match/);
  const changedConfig = structuredClone(input); changedConfig.scenarios[0]!.config.nunc.rolling = { keepRecentFraction: 0.3 };
  await assert.rejects(preflight(changedConfig, repository), /does not match/);
  const changedRange = structuredClone(input); changedRange.scenarios[0]!.config.retentionCalibration!.maxFraction = 0.8;
  await assert.rejects(preflight(changedRange, repository), /does not match/);
  const disabled = structuredClone(input); delete disabled.scenarios[0]!.config.retentionCalibration;
  await assert.rejects(preflight(disabled, repository), /does not match/);
  const target = structuredClone(input); target.target.stateRoot += "-other";
  await assert.rejects(preflight(target, repository), /does not match/);
});
test("public CLI rejects empty stdin/unknown args; real preflight consumes tracked fixture", async () => {
  const script = join(repository, "scripts/verify-live.mjs"), input = await fixture();
  for (const [args, stdin] of [[[], ""], [["--unknown"], "{}"], [["--preflight"], "{}"], [[], JSON.stringify(input)]] as Array<[string[], string]>) {
    const result = spawnSync(process.execPath, [script, ...args], { input: stdin, encoding: "utf8", env: childEnvironment(join(repository, ".scratch")) });
    assert.notEqual(result.status, 0); assert.equal(result.stdout, ""); assert.equal(JSON.parse(result.stderr).status, "REJECTED");
  }
  const result = spawnSync(process.execPath, [script, "--preflight"], { input: JSON.stringify(publicSelection(input)), encoding: "utf8", env: childEnvironment(join(repository, ".scratch")) });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).receipt.callsMade, 0);
  await assert.rejects(lstat(input.target.stateRoot), { code: "ENOENT" });
});
test("seven legal unique scenario combinations are admitted; duplicates still fail", async () => {
  const input = await fixture();
  const config = input.scenarios[0]!.config;
  const full = { ...config, nunc: { ...config.nunc, extraction: { ...config.nunc.extraction, toolResults: "full" as const } } };
  const combos: Array<{ id: "c1" | "c2" | "c3" | "c4" | "c5"; variant?: "full" | "capacity" | "late-d"; config: typeof config }> = [
    { id: "c1", config }, { id: "c1", variant: "late-d", config }, { id: "c2", config }, { id: "c3", config },
    { id: "c4", variant: "full", config: full }, { id: "c4", variant: "capacity", config }, { id: "c5", config },
  ];
  const models = [input.models[0]!, { ...input.models[0]!, id: "smaller-authorized", contextWindow: Math.max(16, Number(input.models[0]!.contextWindow) - 1) }];
  assert.doesNotThrow(() => parseInput({ ...input, models, scenarios: combos }));
  const duplicated = [...combos, combos[0]!];
  assert.throws(() => parseInput({ ...input, models, scenarios: duplicated }));
});
test("child environment is constructed without caller credentials, proxy or NODE_OPTIONS", () => {
  const env = childEnvironment("/isolated");
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "NO_COLOR", "PATH", "PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"].sort());
  assert.equal(env.HOME, "/isolated/home");
});
