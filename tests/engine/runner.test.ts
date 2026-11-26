import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { satisfiesStableRange } from "../../src/pi/compat.js";

test("toolchain floors admit stable upgrades, while the live caret stays on one major", () => {
  const { engines } = JSON.parse(readFileSync("package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  assert.deepEqual(lock.packages[""].engines, engines);
  for (const [range, accepted, rejected] of [
    [engines.node, ["22.19.0", "22.19.1", "22.20.0", "24.0.0", "26.7.0"], ["22.18.9", "21.99.99", "22.19.0-rc.1", "24.0.0-nightly"]],
    [engines.npm, ["11.5.1", "11.5.2", "11.19.0", "12.0.0"], ["11.5.0", "10.19.0", "11.5.1-rc.1", "12.0.0-nightly"]],
    ["^26.7.0", ["26.7.0", "26.7.1", "26.13.0"], ["26.6.9", "25.9.0", "27.0.0", "26.7.0-rc.1"]],
  ] as Array<[string, string[], string[]]>) {
    for (const version of accepted) assert.equal(satisfiesStableRange(version, range), true, `${version} ${range}`);
    for (const version of [...rejected, "", "v26.7.0", "26.7", "26.7.x", "026.7.0", "26.07.0", "26.7.00", "26.7.0+build", "26.7.0\n", " 26.7.0", "26.7.0.1", "9007199254740992.0.0"]) {
      assert.equal(satisfiesStableRange(version, range), false, `${version} ${range}`);
    }
  }
  for (const range of ["26.7.0", "^26.7", "^0.7.0", "^26.7.0-rc.1", ">=22.19", ">=22.19.0\n"]) {
    assert.equal(satisfiesStableRange("26.7.0", range), false, range);
  }
});

test("check CLI reports missing local TypeScript before installing source hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "nunc-check-bootstrap-"));
  try {
    await mkdir(join(root, "scripts"));
    await copyFile("scripts/check.mjs", join(root, "scripts/check.mjs"));
    await writeFile(join(root, "package.json"), JSON.stringify({ engines: { node: "^26.7.0" } }));
    const result = spawnSync(process.execPath, [join(root, "scripts/check.mjs"), "engine"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), "check: Missing local typescript; install from package-lock.json separately");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("check CLI rejects missing/unknown/multiple selections and injected Node options with nonzero exit", () => {
  for (const args of [[], ["unknown"], ["all", "extra"], ["engine", "extra"]]) {
    const result = spawnSync(process.execPath, ["scripts/check.mjs", ...args], { encoding: "utf8" });
    assert.equal(result.status, 1); assert.match(result.stderr, /Expected nonempty selection/);
  }
  const options = spawnSync(process.execPath, ["scripts/check.mjs", "engine"], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "--no-warnings" } });
  assert.equal(options.status, 1); assert.match(options.stderr, /Unset NODE_OPTIONS/);
});
