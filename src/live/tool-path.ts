import { lstat, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { object, requireValue, within } from "./contract.js";
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
