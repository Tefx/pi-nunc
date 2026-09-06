import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
for (const api of ["openai-responses", "anthropic-messages", "openai-codex-responses"]) test(`stock ${api} adapter: actual pre-HTTP admission, maintenance and native recovery`, { timeout: 100000 }, () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const result = spawnSync(process.execPath, ["scripts/observe-apis.mjs", api], { cwd: root, encoding: "utf8", timeout: 90000, maxBuffer: 2_000_000, env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" } });
  assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error ?? "")); console.log(result.stdout.trim());
});
test("stock native lifecycle: repeated K overlap, manual/threshold, restore/reload, model/tree/clone/fork/new, failures", { timeout: 110000 }, () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const result = spawnSync(process.execPath, ["scripts/observe-lifecycle.mjs"], { cwd: root, encoding: "utf8", timeout: 100000, maxBuffer: 2_000_000, env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" } });
  assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error ?? "")); console.log(result.stdout.trim());
});
