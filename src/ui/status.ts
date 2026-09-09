import { VERSION, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Accounting } from "../engine/index.js";
import { inputLimit, mainAdmissionLimit, omitsSerializedOutputCap } from "../engine/accounting.js";
import { engineConfig, readConfig } from "../pi/config.js";
import type { MemoryView } from "../pi/manual.js";

export type FooterTone = "dim" | "accent" | "warning" | "error";
export interface CompactFooterInput {
  unavailable: boolean;
  occupied: boolean;
  unconfirmed: boolean;
  warning: boolean;
  slotCount: number;
  budget: { tokens: number; limit: number | null; unknown: boolean };
}
export interface DiagnosticNote { level: "warning" | "error" | "info"; message: string }

export const COMMAND_USAGE = "Usage: /nunc [status|details]";
export const UNLOAD_LIMIT = "Manual edits not yet absorbed by the next native compaction need a current Nunc to interpret; unload or older Nunc still reads the last native summary.";

const COMPLETIONS = [
  { value: "details", label: "details", description: "Show budget and last maintenance details" },
  { value: "status", label: "status", description: "Text overview without opening the panel" },
] as const;

export function commandCompletions(prefix: string): { value: string; label: string; description: string }[] | null {
  const trimmed = prefix.trimStart();
  if (trimmed.includes(" ")) return null;
  const hits = COMPLETIONS.filter(item => item.value.startsWith(trimmed));
  return hits.length ? hits.map(item => ({ ...item })) : null;
}

export function compactFooter(input: CompactFooterInput): { text: string; tone: FooterTone } {
  if (input.unavailable) return { text: "nunc ×", tone: "error" };
  const n = String(input.slotCount);
  if (input.occupied) return { text: `nunc ↻ ${n}`, tone: "accent" };
  if (input.unconfirmed || input.warning) return { text: `nunc ! ${n}`, tone: "warning" };
  if (input.budget.unknown || input.budget.limit === null) return { text: `nunc ${n}·?`, tone: "dim" };
  if (input.budget.limit === 0) return { text: `nunc ${n}`, tone: "dim" };
  return { text: `nunc ${n}·${Math.round((input.budget.tokens / input.budget.limit) * 100)}%`, tone: "dim" };
}

export function thousands(n: number): string {
  return n.toLocaleString("en-US");
}

export function statusLines(view: MemoryView, triggerTokens: number | undefined): string {
  return [
    `Memory: ${view.memory.slots.length} slots`,
    `Compaction trigger: ${triggerTokens === undefined ? "no model selected" : `${thousands(triggerTokens)} tokens`}`,
    "Budget details: /nunc details",
  ].join("\n");
}

export function detailsLines(input: {
  view: MemoryView;
  ctx: ExtensionContext;
  configPath: string | undefined;
  compaction: Parameters<typeof engineConfig>[2];
  lastAccounting: Accounting | null;
  diagnostics: readonly DiagnosticNote[];
}): string {
  const selection = readConfig(input.configPath, input.ctx.cwd);
  const config = input.ctx.model ? engineConfig(selection.config, input.ctx.model, input.compaction) : undefined;
  const summary = [
    `Memory: ${input.view.memory.slots.length} slots`,
    `Compaction trigger: ${config ? thousands(config.triggerTokens) + " tokens" : "no model selected"}`,
  ];
  const details = config && input.ctx.model ? [
    "", "Input budget (tokens)",
    `  Main admission: ${thousands(mainAdmissionLimit(input.ctx.model, config.main))}`,
    `  Memory plan: ${thousands(inputLimit(input.ctx.model, config.main))}`,
    `  Maintenance: ${thousands(inputLimit(input.ctx.model, config.extraction))}`,
    "", "Output reserve (tokens)",
    `  Main: ${thousands(config.main.nativeOutputReserve ?? config.main.outputTokens)}`,
    `  Maintenance: ${thousands(config.extraction.outputTokens)}`,
    `  Maintenance output cap: ${omitsSerializedOutputCap(input.ctx.model) ? "none" : thousands(config.extraction.outputTokens)}`,
    `Safety margin: ${thousands(config.extraction.safetyTokens)} tokens`,
  ] : [];
  const last = input.lastAccounting ? [
    "", "Last maintenance (this context)",
    `  Input estimate: full ${thousands(input.lastAccounting.fullExtractionTokens)} → selected ${thousands(input.lastAccounting.extractionTokens)}`,
    `  Normal-trigger headroom: ${input.lastAccounting.normalHeadroomSufficient ? "sufficient" : "insufficient; suggest reserveTokens ≥ " + thousands(input.lastAccounting.suggestedReserveTokens)}`,
    `  Over-plan records: input ${input.lastAccounting.inputExceededPlan ? "yes" : "no"} / output ${input.lastAccounting.outputExceededPlan ? "yes" : "no"}`,
  ] : ["", "No maintenance record in this context."];
  const notes = input.diagnostics.length === 0 ? [] : [
    "", "Recent diagnostics",
    ...input.diagnostics.slice(-5).map(note => `  ${note.level}: ${firstLine(note.message)}`),
  ];
  return [...summary, ...details, ...last, ...notes, "", `Pi ${VERSION} · budgets are estimates`].join("\n");
}

function firstLine(message: string): string {
  const line = message.split("\n")[0] ?? message;
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}
