import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
