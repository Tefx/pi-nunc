import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { assertBuildParity, buildReceipt } from "../../bench/live/build.js";
import { bundleExtension } from "../../build/bundle.js";
import { fixture } from "./fixtures.js";

test("preflight build parity rejects stale or extra executable JS without rewriting source/build", async () => {
  const input = await fixture(), root = input.target.stateRoot; await mkdir(join(root, "src"), { recursive: true });
  try {
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(join(root, "package-lock.json"), '{}');
    await mkdir(join(root, "policies"));
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "scripts/bundle.mjs"), "// fixture build driver\n");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", rootDir: ".", outDir: "dist", types: [], noEmitOnError: true, skipLibCheck: true }, include: ["src/**/*.ts"] }));
    const source = join(root, "src/index.ts"), output = join(root, "dist/src/index.js");
    await writeFile(source, "export default 1;\n");
    const loaded = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile), config = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root);
    const emitted = ts.createProgram(config.fileNames, config.options).emit(); assert.equal(emitted.emitSkipped, false);
    await writeFile(output, bundleExtension(new Map([["index.js", await readFile(output, "utf8")]])));
    const original = await readFile(output, "utf8"); await assertBuildParity(root);
    const receipt = buildReceipt(output); assert.deepEqual(buildReceipt(output), receipt);
    await writeFile(source, "export default 2;\n"); await assert.rejects(assertBuildParity(root), /differs/);
    assert.throws(() => buildReceipt(output), /differs/);
    // Even a formerly verified digest must not admit changed executable bytes.
    assert.equal(await readFile(output, "utf8"), original);
    await writeFile(source, "export default 1;\n");
    await writeFile(output, original + "\n// stale artifact\n");
    assert.throws(() => buildReceipt(output), /differs/);
    await writeFile(output, original);
    assert.deepEqual(buildReceipt(output), receipt);
    await mkdir(join(root, "build"));
    const bundler = join(root, "build/bundle.ts");
    await writeFile(bundler, "// first build input\n");
    const withBuild = buildReceipt(output);
    await writeFile(bundler, "// changed build input\n");
    assert.notEqual(buildReceipt(output).digest, withBuild.digest);
    await writeFile(join(root, "dist/src/stale.js"), "throw new Error('stale');\n"); await assert.rejects(assertBuildParity(root), /Stale extra JS/);
    assert.throws(() => buildReceipt(output), /Stale extra JS/);
  } finally { await rm(root, { recursive: true }); }
});
