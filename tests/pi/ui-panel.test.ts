import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("stock TUI: footer, overlay tabs/search/edit/delete, commands, inflight, editor draft", { timeout: 120000 }, () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const result = spawnSync(process.execPath, ["scripts/observe-ui.mjs"], {
    cwd: root, encoding: "utf8", timeout: 110000, maxBuffer: 8_000_000,
    env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error ?? ""));
  const report = JSON.parse(result.stdout);
  assert.equal(report.cleanup, "removed");
  assert.equal(Object.hasOwn(report, "evidence"), false);
  assert.equal(Object.hasOwn(report, "dir"), false);
  const stock = join(root, ".scratch/stock");
  assert.deepEqual(existsSync(stock) ? readdirSync(stock).filter(name => name.startsWith(`nunc-stock-${result.pid}-`)) : [], []);
  assert.equal(report.status, "PASS");
  assert.equal(report.overlay, true);
  assert.equal(report.savedManual, true);
  assert.equal(report.inflightPreserved, true);
  assert.equal(report.projectionResponsive, true);
  assert(report.projectionMessages >= 700);
  assert(report.projectionMs < 1000);
  assert(report.keyboardMs < 1500);
  console.log(JSON.stringify({ observed: report.status, cleanup: report.cleanup, projectionMs: report.projectionMs, keyboardMs: report.keyboardMs, keyboardSentDuringProjection: report.keyboardSentDuringProjection, unproven: report.unproven }));
});
