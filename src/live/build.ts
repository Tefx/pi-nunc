import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import ts from "typescript";
import { requireValue } from "./contract.js";

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
