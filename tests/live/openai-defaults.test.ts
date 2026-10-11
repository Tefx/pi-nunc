import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile, readFile, rm, lstat } from "node:fs/promises";
import { join } from "node:path";
import { fixture, repository } from "./fixtures.js";
import { childEnvironment } from "../../src/live/host.js";

test("metadata-only OpenAI/Sol medium preflight defaults unknown billing; explicit API-key USD limit remains selectable", async () => {
  const input = await fixture(true), profile = input.target.stateRoot + "-openai-profile";
  await mkdir(join(profile, "host"), { recursive: true }); await mkdir(join(profile, "tmp"));
  const authFile = join(profile, "host/auth.json");
  await writeFile(authFile, "fictional-invalid-auth-never-resolved");
  await writeFile(join(profile, "host/settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-6.1-sol", defaultThinkingLevel: "medium", compaction: { enabled: true, reserveTokens: 255616, keepRecentTokens: 8000 } }));
  const value = { target: input.target, limits: { maxDurationMs: 60000, maxCalls: 60, maxTotalTokens: 2000000 }, scenarios: [{ id: "c2" }], observations: ["stock_rpc"] };
  const run = (limits: object) => spawnSync(process.execPath, [join(repository, "scripts/verify-live.mjs"), "--preflight"], { cwd: repository, env: childEnvironment(profile), input: JSON.stringify({ ...value, limits }), encoding: "utf8", timeout: 60000 });
  try {
    const unknown = run(value.limits); assert.equal(unknown.status, 0, unknown.stderr);
    const result = JSON.parse(unknown.stdout);
    assert.equal(result.effective.provider, "openai"); assert.equal(result.effective.model, "gpt-6.1-sol"); assert.equal(result.effective.thinking, "medium");
    assert.equal(result.models[0].contextWindow, 272000); assert.equal(result.models[0].maxTokens, 128000);
    assert.equal(result.limits.maxCostUsd, null); assert.equal(result.receipt.callsMade, 0);
    const priced = run({ ...value.limits, maxCostUsd: 100 }); assert.equal(priced.status, 0, priced.stderr);
    assert.equal(JSON.parse(priced.stdout).limits.maxCostUsd, 100, "Static provider/API cannot classify actual OAuth versus API-key billing");
    assert.equal(await readFile(authFile, "utf8"), "fictional-invalid-auth-never-resolved");
    await assert.rejects(lstat(input.target.stateRoot), { code: "ENOENT" });
  } finally { await rm(profile, { recursive: true }); }
});
