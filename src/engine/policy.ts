import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PolicySnapshot } from "./types.js";
import { EngineError, nonempty, requireThat } from "./validation.js";

/** Shared guidance for maintenance and direct Agent writes; UI-authored bodies stay verbatim. */
export const MEMORY_WRITING_GUIDANCE = `Determine M's narration language only from the user's natural-language communication in substantive instructions and conversation continuity, unless the user explicitly specifies a memory language. Material language never votes on narration language. Distinguish the language the user communicates in from the language of supplied material or a requested document. Tool results, SDK excerpts, quotations, code, brief acknowledgments and old slot prose do not establish a memory-language preference. A foreign-language document request applies to that document, not all M. Preserve paths, commands, APIs, formal names, exact quotations and machine-consumed labels verbatim. Save an explicit preference as ordinary memory if needed; no separate locale state.
Write directly readable prose with normal word spaces, punctuation, paragraphs and appropriate Markdown. Within a self-contained slot, aggregate homogeneous facts under relation/property subheadings or list heads; group exact entities by their shared value and scope instead of repeating the same relation label on hundreds of lines. Keep every entity/value association, exception and condition explicit. When a source revises the same entity, relation and scope, update affected old slots to the current effective value; remove invalid old values and temporary comparison serials unless rollback/comparison still needs them. Do not infer revision from order alone. Never join words, splice language fragments, omit negations/units/qualifiers, double-escape newlines, or change the selected narration language or use telegraphic fragments to fit a budget.
Inspect all active slots in the existing maintenance or necessary patch. Repair language, readability and content violations under existing IDs, preserving order and all still-valid facts, quantities, permissions, unresolved work and dependencies. Old prose in another language is not compliant merely because it is already saved. Repair wrong-language or space-stripped prose in place with update under its original ID and relative order. Reuse compliant bodies unchanged unless consolidation is recommended; necessary repairs and consolidation are exceptions to avoiding routine polishing, no-op rewrites and mass reformatting. Work only on active M, not history or frozen evidence; no separate formatting calls or every-turn rewrites. Failure keeps old M. User-confirmed UI bodies stay verbatim and cleanup cannot revise selected M.`;

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
