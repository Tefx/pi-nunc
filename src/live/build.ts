import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import ts from "typescript";
import { requireValue } from "./contract.js";

/** Freeze both build inputs and emitted runtime bytes; consumers recheck before loading. */
export function buildReceipt(compiledSource: string): { compiledSource: string; digest: string } {
  const entry = realpathSync(compiledSource);
  const repository = resolve(dirname(entry), "../..");
  requireValue(entry === join(repository, "dist/src/index.js"), "BUILD", "Compiled source must be the product dist/src/index.js entrypoint");
  const hash = createHash("sha256");
  const bind = (path: string): void => {
    if (statSync(path).isDirectory()) for (const name of readdirSync(path).sort()) bind(join(path, name));
    else { hash.update(relative(repository, path)); hash.update(readFileSync(path)); }
  };
  for (const name of ["src", "dist/src", "policies", "package.json", "package-lock.json", "tsconfig.json"]) bind(join(repository, name));
  return { compiledSource: entry, digest: hash.digest("hex") };
}

/** Execution consumes dist. Compare the actual locked compiler emission, held in memory; never write build files in preflight. */
export async function assertBuildParity(repository: string): Promise<void> {
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
  for (const [file, content] of outputs) requireValue(await readFile(join(repository, "dist/src", file), "utf8") === content, "BUILD", `Compiled runtime JS ${file} differs from current source; run the tracked build/check separately`);
  async function checkExtras(dir: string): Promise<void> {
    for (const name of await readdir(dir)) {
      const file = join(dir, name); if ((await lstat(file)).isDirectory()) await checkExtras(file);
      else if (file.endsWith(".js")) requireValue(outputs.has(relative(join(repository, "dist/src"), file)), "BUILD", "Stale extra JS in dist/src; run a clean tracked build");
    }
  }
  await checkExtras(join(repository, "dist/src"));
}
