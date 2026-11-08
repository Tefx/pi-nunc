import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { cp } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { extractSharedWritingGuidance, MEMORY_WRITING_GUIDANCE } from "../../src/engine/policy.js";
import { EngineError } from "../../src/engine/validation.js";
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

test("shared guidance extracts exactly one section and matches the canonical asset", async () => {
  const heading = "## Shared writing and applicability policy";
  const body = "Readable guidance.\n\n### Detail\nPreserve scope.";
  assert.equal(extractSharedWritingGuidance(`# Policy\n\n${heading}\n\n${body}\n\n## Next\nOther policy`), body);
  assert.equal(extractSharedWritingGuidance(`${heading}\r\nBody\r\n## Next\r\nOther`), "Body");
  assert.equal(MEMORY_WRITING_GUIDANCE, extractSharedWritingGuidance(await readFile(builtinPolicyPath, "utf8")));
  for (const invalid of ["# Missing section", `${heading}\nBody\n${heading}\nAgain`, `${heading}\n \n## Next\nOther`, heading]) {
    assert.throws(() => extractSharedWritingGuidance(invalid), (error: unknown) => error instanceof EngineError && error.code === "CONFIG");
  }
});

test("corrupt built-in assets fail closed at module load and loadPolicy revalidates on later reads", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "nunc-policy-"));
  try {
    const source = resolve(dir, "src/engine");
    await mkdir(source, { recursive: true });
    await mkdir(resolve(dir, "policies"));
    await writeFile(resolve(dir, "package.json"), '{"type":"module"}');
    for (const name of ["policy.js", "validation.js"]) {
      await cp(new URL(`../../src/engine/${name}`, import.meta.url), resolve(source, name));
    }
    const asset = resolve(dir, "policies/default.md");
    const url = pathToFileURL(resolve(source, "policy.js")).href;
    const valid = "## Shared writing and applicability policy\nValid body.\n";
    const corruptions = ["# No shared section", "## Shared writing and applicability policy\n\n## Next\nOther", valid + valid, Buffer.from([0xff, 0xfe])];
    for (const invalid of corruptions) {
      await writeFile(asset, invalid);
      const atImport = execFileSync(process.execPath, ["--input-type=module", "-e", `
        try { await import(${JSON.stringify(url)}); process.exit(1); }
        catch (error) { if (error.code !== "CONFIG") throw error; process.stdout.write(error.code); }
      `], { encoding: "utf8" });
      assert.equal(atImport, "CONFIG");
      await writeFile(asset, valid);
      const laterRead = execFileSync(process.execPath, ["--input-type=module", "-e", `
        import { writeFileSync } from "node:fs";
        const { loadPolicy } = await import(${JSON.stringify(url)});
        writeFileSync(${JSON.stringify(asset)}, Buffer.from(${JSON.stringify([...Buffer.from(invalid)])}));
        try { await loadPolicy(); process.exit(1); }
        catch (error) { if (error.code !== "CONFIG") throw error; process.stdout.write(error.code); }
      `], { encoding: "utf8" });
      assert.equal(laterRead, "CONFIG");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
