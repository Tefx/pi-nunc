import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { satisfiesStableCaret } from "../../src/live/toolchain.js";

test("toolchain ranges admit stable floor and rolling upgrades only", () => {
  const { engines } = JSON.parse(readFileSync("package.json", "utf8"));
  for (const [range, accepted, rejected] of [
    [engines.node, ["26.7.0", "26.7.1", "26.13.0"], ["26.6.9", "25.9.0", "27.0.0", "26.7.0-rc.1", "26.13.0-nightly"]],
    [engines.npm, ["11.19.0", "11.19.1", "11.20.0"], ["11.18.9", "10.19.0", "12.0.0", "11.19.0-rc.1", "11.20.0-nightly"]],
  ] as Array<[string, string[], string[]]>) {
    for (const version of accepted) assert.equal(satisfiesStableCaret(version, range), true, version);
    for (const version of [...rejected, "", "v26.7.0", "26.7", "26.7.x", "026.7.0", "26.07.0", "26.7.00", "26.7.0+build", "26.7.0\n", " 26.7.0", "26.7.0.1", "9007199254740992.0.0"]) {
      assert.equal(satisfiesStableCaret(version, range), false, version);
    }
  }
  for (const range of ["26.7.0", "^26.7", "^0.7.0", "^26.7.0-rc.1"]) {
    assert.equal(satisfiesStableCaret("26.7.0", range), false, range);
  }
});

test("check CLI rejects missing/unknown/multiple selections and injected Node options with nonzero exit", () => {
  for (const args of [[], ["unknown"], ["all", "extra"], ["engine", "extra"]]) {
    const result = spawnSync(process.execPath, ["scripts/check.mjs", ...args], { encoding: "utf8" });
    assert.equal(result.status, 1); assert.match(result.stderr, /Expected nonempty selection/);
  }
  const options = spawnSync(process.execPath, ["scripts/check.mjs", "engine"], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "--no-warnings" } });
  assert.equal(options.status, 1); assert.match(options.stderr, /Unset NODE_OPTIONS/);
});
