import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PolicySnapshot } from "./types.js";
import { EngineError, nonempty, requireThat } from "./validation.js";

/** Shared guidance for maintenance and direct Agent writes; UI-authored bodies stay verbatim. */
export const MEMORY_WRITING_GUIDANCE = `Write slot prose in the user's communication language. An explicit memory-language preference takes precedence; otherwise infer it from substantive user instructions and conversation continuity. Tool results, SDK documents, quotations, old slots, short confirmations, code, or a request to produce a foreign-language document do not by themselves switch all memory. Keep paths, commands, APIs, formal names, exact quotations and fixed labels with machine consumers in their original form. An explicit preference may be saved as ordinary memory, without separate locale state.
Use natural, concise, directly readable sentences with normal word spaces, punctuation, paragraphs and appropriate Markdown. Lists may express parallel items; paths and commands may use inline code. Do not join English words, splice language fragments, omit negations, units or qualifiers, double-escape newlines, switch to English or use telegraphic compression to fit a budget. Compress redundancy and obsolete process instead; organize headings by actual content without a fixed template.
Inspect all active slots during existing maintenance or a necessary direct patch. Update bodies that violate the current user's language, readability or content requirements, including after an explicit memory-language switch; preserve IDs, order and every still-valid fact, quantity, negation, permission, unresolved obligation and cleanup dependency. Reuse compliant bodies unchanged. Avoid unnecessary polishing, no-op/style rewrites and mass reformatting. Do not rewrite history or frozen evidence, start separate formatting calls, or rewrite every turn. A failed patch keeps the old memory; do not claim cleanup succeeded. User-confirmed UI bodies are saved verbatim and cleanup may not revise selected M.`;

/** Supports emitted dist/src/engine as well as direct source loading by Pi's TS loader. */
const root = new URL(import.meta.url.includes("/dist/src/engine/") ? "../../../" : "../../", import.meta.url);
export async function loadPolicy(options: { policyFile?: string; configFile?: string } = {}): Promise<PolicySnapshot> {
  async function text(path: string | URL): Promise<string> {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path)); }
    catch (cause) { throw new EngineError("CONFIG", `Cannot load UTF-8 policy: ${String(path)}`, { cause }); }
  }
  const builtin = await text(new URL("policies/default.md", root));
  requireThat(nonempty(builtin), "CONFIG", "Built-in policy is empty");
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
