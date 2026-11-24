import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { access, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

test("ime fixture print retains the launch recipe's work, config and seeded session until teardown", { timeout: 60000 }, async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const result = spawnSync(process.execPath, ["scripts/ime-fixture.mjs", "print"], {
    cwd: root, encoding: "utf8", timeout: 50000,
    env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  const dir = dirname(report.recipe), state = join(dir, "isolated");
  try {
    assert.equal(report.status, "READY"); assert.equal(report.slot, "s12");
    for (const path of [join(state, "work"), join(state, "sessions"), join(state, "nunc.json"), report.sessionFile]) await access(path);
    assert.match(await readFile(report.sessionFile, "utf8"), /s12/);
    assert.match(await readFile(report.recipe, "utf8"), /# Teardown: rm -rf/);
    const saved = JSON.parse(await readFile(join(dir, "result.json"), "utf8"));
    assert.equal(saved.status, "READY"); assert.equal(saved.sessionFile, report.sessionFile);
    assert.deepEqual(saved.cleanup, { childrenExited: true, serverClosed: true, isolatedStateRemoved: false });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("ime fixture validate opens seeded slot without daily profile", { timeout: 60000 }, () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const result = spawnSync(process.execPath, ["scripts/ime-fixture.mjs", "validate"], {
    cwd: root, encoding: "utf8", timeout: 50000, maxBuffer: 4_000_000,
    env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error ?? ""));
  const start = result.stdout.lastIndexOf("{");
  assert(start >= 0, result.stdout);
  const report = JSON.parse(result.stdout.slice(start));
  assert.equal(report.status, "PASS");
  assert.equal(report.slot, "s12");
});
