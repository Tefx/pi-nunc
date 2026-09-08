import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("stock TUI: footer, overlay tabs/search/edit/delete, commands, inflight, editor draft", { timeout: 120000 }, () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const result = spawnSync(process.execPath, ["scripts/observe-ui.mjs"], {
    cwd: root, encoding: "utf8", timeout: 110000, maxBuffer: 8_000_000,
    env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error ?? ""));
  const start = result.stdout.lastIndexOf("{");
  assert(start >= 0, result.stdout);
  const report = JSON.parse(result.stdout.slice(start));
  assert.equal(report.status, "PASS");
  assert.equal(report.overlay, true);
  assert.equal(report.savedManual, true);
  assert.equal(report.inflightPreserved, true);
  console.log(JSON.stringify({ observed: report.status, dir: report.dir, unproven: report.unproven }));
});
