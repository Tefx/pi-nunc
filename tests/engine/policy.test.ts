import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { builtinPolicyPath, loadPolicy } from "../../src/engine/index.js";

test("loads actual built-in UTF-8 asset, resolves optional policy against config file and freezes once", async () => {
  const builtin = await loadPolicy();
  assert.equal(builtin.builtin, await readFile(builtinPolicyPath, "utf8")); // loading bytes is the mechanical asset contract
  assert.equal(builtin.user, "");
  await mkdir(".scratch", { recursive: true });
  const dir = await mkdtemp(resolve(".scratch/policy-"));
  try {
    await writeFile(resolve(dir, "user.md"), "Preserve exact units.");
    const first = await loadPolicy({ policyFile: "user.md", configFile: resolve(dir, "config.json") });
    assert.equal(first.user, "Preserve exact units.");
    await writeFile(resolve(dir, "user.md"), "Later preference.");
    assert.equal(first.user, "Preserve exact units.");
    assert.equal((await loadPolicy({ policyFile: resolve(dir, "user.md") })).user, "Later preference.");
    await writeFile(resolve(dir, "user.md"), "");
    assert.equal((await loadPolicy({ policyFile: resolve(dir, "user.md") })).user, "");
    await writeFile(resolve(dir, "bad.md"), Buffer.from([0xff, 0xfe]));
    await assert.rejects(loadPolicy({ policyFile: resolve(dir, "bad.md") }), /UTF-8 policy/);
    await assert.rejects(loadPolicy({ policyFile: resolve(dir, "missing") }), /Cannot load/);
    await assert.rejects(loadPolicy({ policyFile: "relative.md" }), /absolute configFile/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
