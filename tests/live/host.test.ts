import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { toolPath, childEnvironment } from "../../src/live/host.js";
import { fixture, repository } from "./fixtures.js";
for (const scenario of ["c1", "c2", "c3", "outside", "codex", "codex-defaults", "codex-timeout"]) test(`downstream ${scenario}: actual stock CLI/tools/native service/calibration/persistence (controlled responses)`, { timeout: 60000 }, () => {
  const result = spawnSync(process.execPath, [join(repository, "scripts/observe-segment.mjs"), scenario], { encoding: "utf8", env: childEnvironment(join(repository, ".scratch")), timeout: 55000, maxBuffer: 4_000_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error ?? "")); console.log(result.stdout.trim());
});
test("default-input CLI preflight and supervisor/worker delegate existing fictional native Codex without an auth copy", { timeout: 110000 }, () => {
  const result = spawnSync(process.execPath, [join(repository, "scripts/observe-runner.mjs")], { encoding: "utf8", env: childEnvironment(join(repository, ".scratch")), timeout: 105000, maxBuffer: 4_000_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error ?? "")); console.log(result.stdout.trim());
});
test("scenario-local tool paths reject traversal, protected names and external symlinks", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  const cwd = join(input.target.stateRoot, "task"); await mkdir(cwd); await writeFile(join(cwd, "valid.txt"), "ok");
  try {
    assert.equal(await toolPath(cwd, "valid.txt"), join(cwd, "valid.txt")); assert.equal(await toolPath(cwd, "new/file.txt"), join(cwd, "new/file.txt"));
    for (const path of ["../calls.jsonl", "/etc/passwd", ".pi/settings.json", "auth.json", ".env"]) await assert.rejects(toolPath(cwd, path));
    await symlink(input.target.stateRoot, join(cwd, "outside")); await assert.rejects(toolPath(cwd, "outside/calls.jsonl"), /outside/);
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});
