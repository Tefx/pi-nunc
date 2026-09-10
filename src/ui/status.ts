import { VERSION } from "@earendil-works/pi-coding-agent";
import type { ContextView, CurrentContext, LastMaintenanceContext } from "../pi/context.js";

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

export const COMMAND_USAGE = "Usage: /nunc [details]";
export const UNLOAD_LIMIT = "Manual edits not yet absorbed by the next native compaction need a current Nunc to interpret; unload or older Nunc still reads the last native summary.";
export const DIAGNOSTIC_LIMIT = 20;

const COMPLETIONS = [
  { value: "details", label: "details", description: "Complete memory, budget, maintenance, and diagnostic report" },
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

export function firstLine(message: string, max = 160): string {
  const line = message.split("\n")[0] ?? message;
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function quantity(value: number | null, noModel: boolean): string {
  if (noModel) return "no model";
  if (value === null) return "unknown";
  return thousands(value);
}

export function capLabel(known: boolean, tokens: number | null, noModel: boolean, unknownLabel = "unknown"): string {
  if (noModel) return "no model";
  if (!known) return unknownLabel;
  if (tokens === null) return "none";
  return thousands(tokens);
}

export function memoryOccupancy(current: CurrentContext): string {
  const b = current.budget;
  const noModel = current.model === null;
  const occupied = b.memoryOccupied === null ? (noModel ? "no model" : "unknown") : thousands(b.memoryOccupied);
  if (b.memoryUnknown) return b.memoryOccupied === null ? occupied : `${occupied} · unknown limit`;
  if (b.memoryLimit === null) return `${occupied} / ${noModel ? "no model" : "unknown"}`;
  return `${occupied} / ${thousands(b.memoryLimit)}`;
}

export function budgetLines(current: CurrentContext): string[] {
  const noModel = current.model === null;
  const b = current.budget;
  return [
    `Model: ${current.model ? `${current.model.provider}/${current.model.id}` : "no model"}`,
    `Model window: ${quantity(b.modelWindow, noModel)}`,
    `H / trigger: ${quantity(b.triggerTokens, noModel)}`,
    `Main admission: ${quantity(b.mainAdmissionLimit, noModel)}`,
    `Memory/input plan: ${quantity(b.plannedInputLimit, noModel)}`,
    `Maintenance input plan: ${quantity(b.extractionInputLimit, noModel)}`,
    `M occupancy: ${memoryOccupancy(current)}`,
    `Main output reserve: ${quantity(b.outputReserveTokens, noModel)}`,
    `Maintenance output reserve: ${quantity(b.extractionOutputTokens, noModel)}`,
    `Main output cap: ${capLabel(b.outputCapKnown, b.outputCapTokens, noModel, "not observed")}`,
    `Maintenance output cap: ${capLabel(b.extractionOutputCapKnown, b.extractionOutputCapTokens, noModel)}`,
    `Safety: ${quantity(b.safetyTokens, noModel)}`,
  ];
}

export function maintenanceLines(last: LastMaintenanceContext | undefined): string[] {
  if (!last) return ["No maintenance record in this context."];
  const engine = last.engine ?? "pending";
  const lines = [
    `Model: ${last.model.provider}/${last.model.id} (${last.model.api})`,
    `Observed: ${new Date(last.observedAt).toISOString()}`,
    `Scope: last-maintenance · ${last.reason ?? "unknown reason"}`,
    `Engine: ${engine} · native ${last.native}${last.invalidated ? " · invalidated" : ""}`,
    last.candidate ? `Engine candidate: ${last.candidate.memory.slots.length} slots @ ${last.candidate.firstKeptEntryId}` : "Engine candidate: none",
    last.native === "saved" && last.after
      ? `Native save: saved · after ${last.after.memory.slots.length} slots`
      : `Native save: ${last.native}${last.native === "saved" ? "" : " (candidate success is not a native save)"}`,
  ];
  if (last.accounting) {
    const a = last.accounting;
    lines.push(
      `Input estimate: full ${thousands(a.fullExtractionTokens)} → selected ${thousands(a.extractionTokens)}`,
      `Normal-trigger headroom: ${a.normalHeadroomSufficient ? "sufficient" : "insufficient; suggest reserveTokens ≥ " + thousands(a.suggestedReserveTokens)}`,
      `Over-plan records: input ${a.inputExceededPlan ? "yes" : "no"} / output ${a.outputExceededPlan ? "yes" : "no"}`,
    );
  }
  if (last.code) lines.push(`${last.code}: ${last.message ?? ""}`);
  return lines;
}

export function diagnosticLines(notes: readonly DiagnosticNote[]): string[] {
  const shown = notes.filter(note => note.level !== "info");
  if (shown.length === 0) return ["No recent diagnostics."];
  return shown.map(note => `${note.level}: ${firstLine(note.message)}`);
}

export function detailsLines(input: {
  view: ContextView;
  diagnostics: readonly DiagnosticNote[];
  currentWarning?: string;
}): string {
  const current = input.view.current;
  const summary = [
    `Memory: ${current.layout.memory?.slots.length ?? current.contextLayout.slotCount} slots`,
    `Occupied: ${current.occupied ? "yes" : "no"}`,
    `Unconfirmed: ${current.unconfirmed ? "yes" : "no"}`,
    `Current warning: ${input.currentWarning ? firstLine(input.currentWarning) : "none"}`,
  ];
  const notes = diagnosticLines(input.diagnostics);
  return [
    ...summary,
    "", "Current budgets",
    ...budgetLines(current).map(line => `  ${line}`),
    "", "Last maintenance",
    ...maintenanceLines(input.view.lastMaintenance).map(line => `  ${line}`),
    "", "Recent diagnostics",
    ...notes.map(line => `  ${line}`),
    "", `Pi ${VERSION} · budgets are estimates`,
  ].join("\n");
}
