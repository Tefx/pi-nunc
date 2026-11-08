import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PolicySnapshot } from "./types.js";
import { EngineError, nonempty, requireThat } from "./validation.js";

/** Extract the one shared level-two section, stopping before the next peer heading. */
export function extractSharedWritingGuidance(policyMarkdown: string): string {
  const headings = [...policyMarkdown.matchAll(/^## Shared writing and applicability policy\r?$/gm)];
  requireThat(headings.length === 1, "CONFIG", "Built-in policy must contain exactly one Shared writing and applicability policy section");
  const heading = headings[0]!;
  const rest = policyMarkdown.slice(heading.index! + heading[0].length);
  const next = rest.search(/^#{1,2} /m);
  const body = (next < 0 ? rest : rest.slice(0, next)).trim();
  requireThat(nonempty(body), "CONFIG", "Shared writing and applicability policy is empty");
  return body;
}

/** Supports emitted dist/src/engine as well as direct source loading by Pi's TS loader. */
const root = new URL(import.meta.url.includes("/dist/src/engine/") ? "../../../" : "../../", import.meta.url);
export async function loadPolicy(options: { policyFile?: string; configFile?: string } = {}): Promise<PolicySnapshot> {
  async function text(path: string | URL): Promise<string> {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path)); }
    catch (cause) { throw new EngineError("CONFIG", `Cannot load UTF-8 policy: ${String(path)}`, { cause }); }
  }
  const builtin = await text(new URL("policies/default.md", root));
  requireThat(nonempty(builtin), "CONFIG", "Built-in policy is empty");
  extractSharedWritingGuidance(builtin);
  let user = "";
  if (options.policyFile !== undefined) {
    requireThat(nonempty(options.policyFile), "CONFIG", "policyFile must be nonempty");
    requireThat(isAbsolute(options.policyFile) || (options.configFile !== undefined && isAbsolute(options.configFile)), "CONFIG", "Relative policyFile requires an absolute configFile base");
    const path = isAbsolute(options.policyFile) ? options.policyFile : resolve(dirname(options.configFile!), options.policyFile);
    user = await text(path);
  }
  return Object.freeze({ builtin, user });
}
export const builtinPolicyPath = fileURLToPath(new URL("policies/default.md", root));

/** Shared guidance for maintenance and direct Agent writes; UI-authored bodies stay verbatim. */
export const MEMORY_WRITING_GUIDANCE = (() => {
  try {
    return extractSharedWritingGuidance(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(builtinPolicyPath)));
  } catch (cause) {
    if (cause instanceof EngineError) throw cause;
    throw new EngineError("CONFIG", `Cannot load UTF-8 policy: ${builtinPolicyPath}`, { cause });
  }
})();
