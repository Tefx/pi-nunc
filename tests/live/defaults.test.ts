import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { childEnvironment } from "../../src/live/host.js";
import { fixture, repository } from "./fixtures.js";

test("public stdin resolves synthetic native defaults and current shell selection without catalog, approval or auth copying", async () => {
  const input = await fixture(true), profile = input.target.stateRoot + "-profile";
  await mkdir(join(profile, "host"), { recursive: true });
  await mkdir(join(profile, "tmp"));
  const settings = { defaultProvider: "openai-codex", defaultModel: "gpt-6-astra", defaultThinkingLevel: "high", compaction: { enabled: true, reserveTokens: 200000, keepRecentTokens: 1 } };
  const settingsFile = join(profile, "host/settings.json");
  await writeFile(settingsFile, JSON.stringify(settings));
  // Deliberately unusable fictional auth: no-call preflight must not parse it.
  await writeFile(join(profile, "host/auth.json"), "fictional-invalid-auth-never-resolved");
  const selection = { target: input.target, limits: input.limits, scenarios: [{ id: "c2" }], observations: ["stock_rpc"] };
  const env = childEnvironment(profile);
  const run = (value: unknown, extra: NodeJS.ProcessEnv = {}, flags = ["--preflight"]) => spawnSync(process.execPath, [join(repository, "scripts/verify-live.mjs"), ...flags], { cwd: repository, env: { ...env, ...extra }, input: JSON.stringify(value), encoding: "utf8", timeout: 60000 });
  try {
    const defaultRun = run(selection); assert.equal(defaultRun.status, 0, defaultRun.stderr);
    const defaults = JSON.parse(defaultRun.stdout); assert.equal(defaults.models[0].id, "gpt-6-astra"); assert.equal(defaults.models[0].maxTokens, 128000);
    await writeFile(settingsFile, JSON.stringify({ ...settings, defaultThinkingLevel: undefined, compaction: { ...settings.compaction, keepRecentTokens: 0 } }));
    const nativeFallback = run({ ...selection, limits: { ...selection.limits, maxCostUsd: undefined, maxOutputTokens: undefined } });
    assert.equal(nativeFallback.status, 0, nativeFallback.stderr); assert.equal(JSON.parse(nativeFallback.stdout).effective.thinking, "medium");
    assert.equal(JSON.parse(nativeFallback.stdout).limits.maxCostUsd, null); assert.equal(JSON.parse(nativeFallback.stdout).limits.maxOutputTokens, 128000); assert.equal(JSON.parse(nativeFallback.stdout).effective.compaction.keepRecentTokens, 0);
    await writeFile(settingsFile, JSON.stringify({ ...settings, defaultProvider: "anthropic", defaultModel: "absent-static-model" }));
    const current = run(selection, { PI_PROVIDER: "openai-codex", PI_MODEL: "gpt-6-astra", PI_REASONING_LEVEL: "medium" });
    assert.equal(current.status, 0, current.stderr); assert.equal(JSON.parse(current.stdout).effective.source, "invoking-runtime"); assert.equal(JSON.parse(current.stdout).effective.thinking, "medium");
    assert.notEqual(run(selection).status, 0, "unresolved standalone default never changes accounts silently");
    const overridden = run({ ...selection, overrides: [{ requirement: "native-codex-budget", reason: "Explicitly select the controlled native Codex catalog", model: { provider: "openai-codex", id: "gpt-6-astra" }, thinking: "low" }] });
    assert.equal(overridden.status, 0, overridden.stderr); assert.equal(JSON.parse(overridden.stdout).effective.thinking, "low");
    for (const value of [
      { ...selection, overrides: [{ model: { provider: "openai-codex", id: "gpt-6-astra" } }] },
      { ...selection, overrides: [{ requirement: "test", reason: "fixture", model: { provider: "openai-codex", id: "gpt-6-astra", maxTokens: 4096 } }] },
      { ...selection, authorization: {} }, { ...selection, credentials: "fictional" }, { ...selection, target: undefined }, { ...selection, limits: undefined },
    ]) assert.notEqual(run(value).status, 0);
    assert.notEqual(run(selection, { PI_MODEL: "gpt-6-astra" }).status, 0, "partial current context is rejected");
    assert.notEqual(run(selection, {}, ["--handoff-auth"]).status, 0);
    await assert.rejects(lstat(input.target.stateRoot), { code: "ENOENT" });
    assert.equal(await readFile(join(profile, "host/auth.json"), "utf8"), "fictional-invalid-auth-never-resolved");
    assert.equal(JSON.parse(await readFile(settingsFile, "utf8")).defaultModel, "absent-static-model", "saved defaults were never rewritten");
  } finally { await rm(profile, { recursive: true }); }
});
