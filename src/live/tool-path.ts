import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { object, requireValue, within, RunnerError } from "./contract.js";
/** Resolve existing prefixes to catch accidental aliases; tools see scenario files only. */
export async function toolPath(cwd: string, input: unknown, toolName?: "read" | "write" | "edit"): Promise<string> {
  requireValue(typeof input === "string" && input.length > 0, "TOOL_PATH", "A scenario-local path is required");
  const path = resolve(cwd, input.replace(/^@/, ""));
  const readRoot = toolName === "read" && path === cwd;
  requireValue((readRoot || within(path, cwd)) && !path.slice(cwd.length).split("/").some(p => [".pi", ".agents", ".git"].includes(p) || p.startsWith(".env") || p === "auth.json"), "TOOL_PATH", "Tool path is outside scenario task files");
  if (readRoot) {
    const stat = await lstat(path);
    requireValue(!stat.isSymbolicLink(), "TOOL_PATH", "Tool path resolves outside scenario");
    return path;
  }
  let parent = path;
  while (parent !== cwd) {
    try { await lstat(parent); requireValue(within(await realpath(parent), cwd), "TOOL_PATH", "Tool path resolves outside scenario"); break; }
    catch (error) { if (!(object(error) && error.code === "ENOENT")) throw error; parent = dirname(parent); }
  }
  return path;
}

/** Authorization belongs to the seeded fixture, never to a model-created filename.
 * Stock Pi preflights a whole parallel batch before executing it, so a sibling
 * script write must also prevent verification even if the old bytes still match.
 */
export async function authorizeVerification(cwd: string, script: string | undefined, siblingWrites: unknown[] = []): Promise<void> {
  requireValue(script !== undefined, "SCRIPT_UNPROVIDED", "No fixture verification script was provided");
  const path = resolve(cwd, "verify.py");
  requireValue(!siblingWrites.some(p => typeof p === "string" && resolve(cwd, p.replace(/^@/, "")) === path), "SCRIPT_BUSY", "Verification cannot run in the same tool batch as a script write");
  try {
    await toolPath(cwd, "verify.py", "read");
    requireValue((await lstat(path)).isFile(), "SCRIPT_CHANGED", "Fixture verification script is not an original regular file");
    requireValue((await readFile(path)).equals(Buffer.from(script)), "SCRIPT_CHANGED", "Fixture verification script was modified; execution refused");
  } catch (error) {
    if (object(error) && error.code === "ENOENT") throw new RunnerError("SCRIPT_MISSING", "Fixture verification script is missing");
    throw error;
  }
}
