import { dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import ts from "typescript";
import { requireValue } from "./contract.js";
import { bundleExtension } from "../../build/bundle.js";

// A receipt digest binds every input and runtime byte; reuse parity only for identical bytes.
let verifiedBuild: string | undefined;

/** Freeze only a runtime that matches the current locked compiler and bundle emission. */
export function buildReceipt(compiledSource: string): { compiledSource: string; digest: string } {
  const entry = realpathSync(compiledSource);
  const repository = resolve(dirname(entry), "../..");
  requireValue(entry === join(repository, "dist/src/index.js"), "BUILD", "Compiled source must be the product dist/src/index.js entrypoint");
  const hash = createHash("sha256");
  const bind = (path: string): void => {
    if (statSync(path).isDirectory()) for (const name of readdirSync(path).sort()) bind(join(path, name));
    else { hash.update(relative(repository, path)); hash.update(readFileSync(path)); }
  };
  for (const name of ["src", "scripts/bundle.mjs", "dist/src", "policies", "package.json", "package-lock.json", "tsconfig.json"]) bind(join(repository, name));
  const build = join(repository, "build");
  if (existsSync(build)) bind(build);
  const digest = hash.digest("hex");
  const key = `${entry}:${digest}`;
  if (verifiedBuild !== key) {
    checkBuildParity(repository);
    verifiedBuild = key;
  }
  return { compiledSource: entry, digest };
}

/** Compare compiler plus bundle emission in memory; never write build files in preflight. */
export async function assertBuildParity(repository: string): Promise<void> {
  checkBuildParity(repository);
}

function checkBuildParity(repository: string): void {
  const loaded = ts.readConfigFile(join(repository, "tsconfig.json"), ts.sys.readFile);
  requireValue(!loaded.error, "BUILD", "Cannot read tracked TypeScript configuration");
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, repository);
  requireValue(parsed.errors.length === 0, "BUILD", "Invalid tracked TypeScript configuration");
  const outputs = new Map<string, string>();
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const emitted = program.emit(undefined, (file, content) => {
    if (file.startsWith(join(repository, "dist/src") + "/") && file.endsWith(".js")) outputs.set(relative(join(repository, "dist/src"), file), content);
  });
  requireValue(!emitted.emitSkipped && !emitted.diagnostics.some(d => d.category === ts.DiagnosticCategory.Error) && outputs.size > 0, "BUILD", "Source cannot emit the tracked runtime; run the full check separately");
  if (existsSync(join(repository, "scripts/bundle.mjs"))) outputs.set("index.js", bundleExtension(outputs));
  for (const [file, content] of outputs) requireValue(readFileSync(join(repository, "dist/src", file), "utf8") === content, "BUILD", `Compiled runtime JS ${file} differs from current source; run the tracked build/check separately`);
  function checkExtras(dir: string): void {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name); if (lstatSync(file).isDirectory()) checkExtras(file);
      else if (file.endsWith(".js")) requireValue(outputs.has(relative(join(repository, "dist/src"), file)), "BUILD", "Stale extra JS in dist/src; run a clean tracked build");
    }
  }
  checkExtras(join(repository, "dist/src"));
}
