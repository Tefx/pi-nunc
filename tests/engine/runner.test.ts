import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("check CLI rejects missing/unknown/multiple selections and injected Node options with nonzero exit", () => {
  for (const args of [[], ["unknown"], ["all", "extra"], ["engine", "extra"]]) {
    const result = spawnSync(process.execPath, ["scripts/check.mjs", ...args], { encoding: "utf8" });
    assert.equal(result.status, 1); assert.match(result.stderr, /Expected nonempty selection/);
  }
  const options = spawnSync(process.execPath, ["scripts/check.mjs", "engine"], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "--no-warnings" } });
  assert.equal(options.status, 1); assert.match(options.stderr, /Unset NODE_OPTIONS/);
});
