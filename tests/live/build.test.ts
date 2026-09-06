import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { assertBuildParity } from "../../src/live/build.js";
import { fixture } from "./fixtures.js";

test("preflight build parity rejects stale or extra executable JS without rewriting source/build", async () => {
  const input = await fixture(), root = input.target.stateRoot; await mkdir(join(root, "src"), { recursive: true });
  try {
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", rootDir: ".", outDir: "dist", types: [], noEmitOnError: true, skipLibCheck: true }, include: ["src/**/*.ts"] }));
    const source = join(root, "src/index.ts"), output = join(root, "dist/src/index.js");
    await writeFile(source, "export const value: number = 1;\n");
    const loaded = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile), config = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root);
    const emitted = ts.createProgram(config.fileNames, config.options).emit(); assert.equal(emitted.emitSkipped, false);
    const original = await readFile(output, "utf8"); await assertBuildParity(root);
    await writeFile(source, "export const value: number = 2;\n"); await assert.rejects(assertBuildParity(root), /differs/);
    assert.equal(await readFile(output, "utf8"), original);
    await writeFile(source, "export const value: number = 1;\n");
    await writeFile(join(root, "dist/src/stale.js"), "throw new Error('stale');\n"); await assert.rejects(assertBuildParity(root), /Stale extra JS/);
  } finally { await rm(root, { recursive: true }); }
});
