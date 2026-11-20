import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const env = { PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
const cases: Array<[string, string[]]> = [
  ...["openai-responses", "anthropic-messages", "openai-codex-responses"].map(api => [`stock ${api} adapter: native threshold maintenance and saved-context continuation`, ["scripts/observe-apis.mjs", api]] as [string, string[]]),
  ["stock Codex default planning/catalog overruns delegate; explicit input limits reject before HTTP", ["scripts/observe-capacity-recurrence.mjs"]],
  ["stock Codex defaults admit real input and persist uncapped output above planning reserve", ["scripts/observe-capacity-defaults.mjs"]],
  ["stock Grok 500k: native output sizing, raw extraction, checkpoint continuation and oversized zero-send", ["scripts/observe-grok-budget.mjs"]],
  ["stock loader payload callbacks: safe noop/return/in-place reach HTTP; overcap and illegal output send nothing", ["scripts/observe-payload.mjs"]],
  ["stock native lifecycle: repeated K overlap, manual/threshold, restore/reload, model/tree/clone/fork/new, failures", ["scripts/observe-lifecycle.mjs"]],
  ["stock RPC explicit-hard-limit cancellation and elastic required-over-target overflow continuation", ["scripts/observe-required-capacity.mjs"]],
];
for (const [name, args] of cases) test(name, { timeout: 110000 }, () => {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", timeout: 100000, maxBuffer: 2_000_000, env });
  assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error ?? ""));
  console.log(result.stdout.trim());
});
