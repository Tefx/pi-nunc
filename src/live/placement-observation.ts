import { isDeepStrictEqual } from "node:util";
import { resolve, relative } from "node:path";
import { buildContextEntries, convertToLlm, findCutPoint, sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Control, Turn } from "./scenarios.js";
import type { RolloverObservation } from "./comparison-observation.js";

export interface PlacementContract { control: Control; turns: Turn[]; files: Record<string, string>; turnEntries: Record<string, string[]>; requiredReads: Array<{ turn: string; path: string }> }
const userText = (entry: SessionEntry) => entry.type === "message" && entry.message.role === "user"
  ? typeof entry.message.content === "string" ? entry.message.content : entry.message.content.filter(b => b.type === "text").map(b => b.text).join("") : undefined;
function turnMap(branch: SessionEntry[], contract: PlacementContract) {
  // Use worker-observed IDs, including the currently held partial turn. Identical
  // user text in two named turns must not alias them to the first occurrence.
  return Object.fromEntries(contract.turns.map((turn, i) => {
    const start = branch.findIndex(e => e.id === contract.turnEntries[turn.id]?.[0]);
    const next = contract.turns[i + 1];
    const end = next ? branch.findIndex(e => e.id === contract.turnEntries[next.id]?.[0]) : branch.length;
    return [turn.id, start < 0 || end <= start || userText(branch[start]!) !== turn.text ? [] : branch.slice(start, end).filter(e => e.type === "message").map(e => e.id)];
  }));
}
function unitsIntact(entries: SessionEntry[]) {
  const messages = entries.flatMap(e => convertToLlm(sessionEntryToContextMessages(e)));
  const calls = messages.flatMap((m, i) => m.role === "assistant" ? m.content.flatMap(b => b.type === "toolCall" ? [{ id: b.id, name: b.name, i }] : []) : []);
  const results = messages.flatMap((m, i) => m.role === "toolResult" ? [{ id: m.toolCallId, name: m.toolName, i }] : []);
  return new Set(calls.map(c => c.id)).size === calls.length && calls.length === results.length && calls.every(c => results.filter(r => r.id === c.id && r.name === c.name && r.i > c.i).length === 1);
}
/** Named placement and same-session integrity; cross-session generated content has no equality requirement. */
export function logicalPlacement(row: RolloverObservation, cwd: string) {
  const contract = row.placement, snap = row.snapshot;
  const cut = snap ? row.active.findIndex(e => e.id === snap.firstKeptEntryId) : -1;
  const b = row.active.slice(0, Math.max(0, cut)).filter(e => e.type !== "compaction");
  const k = cut < 0 ? [] : row.active.slice(cut).filter(e => e.type !== "compaction");
  const turnEntries = contract ? turnMap(row.branch, contract) : {};
  const issues: string[] = [];
  if (!contract || !snap || cut < 0 || !row.prepared) issues.push("Missing observed placement, cut or preparation");
  if (!isDeepStrictEqual(row.active, buildContextEntries(row.branch))) issues.push("Active source differs from its own frozen branch");
  if (!snap || !row.rebuilt?.some(e => isDeepStrictEqual(e, snap)) || !isDeepStrictEqual(row.rebuilt.filter(e => e.type !== "compaction"), k)) issues.push("Own K changed or reordered across persistence");
  if (!unitsIntact(b) || !unitsIntact(k)) issues.push("Cut splits or loses a tool call/result unit");
  if (snap && row.prepared) {
    const previous = row.branch.findLast(e => e.type === "compaction");
    const start = previous?.type === "compaction" ? row.branch.findIndex(e => e.id === previous.firstKeptEntryId) : 0;
    const native = findCutPoint(row.branch, Math.max(0, start), row.branch.length, row.preparation.settings.keepRecentTokens);
    if (snap.firstKeptEntryId !== row.prepared.firstKeptEntryId || row.branch[native.firstKeptEntryIndex]?.id !== row.preparation.firstKeptEntryId || native.firstKeptEntryIndex <= start) issues.push("Snapshot disagrees with its own public legal prepared cut");
  }
  if (contract) {
    for (const turn of contract.turns) if (!turnEntries[turn.id]?.length || !isDeepStrictEqual(turnEntries[turn.id], contract.turnEntries[turn.id])) issues.push(`Missing request or incomplete named turn ${turn.id}`);
    const p = contract.control.placement;
    if (p?.retireThroughTurn) {
      const end = contract.turns.findIndex(t => t.id === p.retireThroughTurn);
      const ids = contract.turns.slice(0, end + 1).flatMap(t => turnEntries[t.id] ?? []);
      if (end < 0 || !ids.length || ids.some(id => k.some(e => e.id === id))) issues.push("Requested complete turns did not retire");
    }
    for (const turn of p?.retainTurns ?? []) if (!turnEntries[turn]?.length || !turnEntries[turn]!.every(id => k.some(e => e.id === id))) issues.push(`Complete retained turn ${turn} is missing`);
    if (p?.retireEvidenceFromTurn) {
      const ids = turnEntries[p.retireEvidenceFromTurn] ?? [];
      const evidence = row.active.filter(e => ids.includes(e.id) && e.type === "message" && e.message.role === "toolResult");
      if (!evidence.length || !evidence.every(e => b.some(r => r.id === e.id))) issues.push("Required tool evidence did not retire");
    }
    if (p?.retireRequestOfTurn) {
      const turn = contract.turns.find(t => t.id === p.retireRequestOfTurn);
      if (!turn || !b.some(e => e.id === turnEntries[turn.id]?.[0]) || !row.preparation.isSplitTurn) issues.push("Original split request is absent from B");
      const unit = p.retainToolExchange;
      const ids = unit ? turnEntries[unit.turn] ?? [] : [];
      const calls = row.active.filter(e => ids.includes(e.id)).flatMap(e => e.type === "message" && e.message.role === "assistant" ? e.message.content.flatMap(c => c.type === "toolCall" && c.name === unit?.toolName && typeof c.arguments.path === "string" && resolve(cwd, c.arguments.path) === resolve(cwd, unit.pathArgument) ? [{ entry: e, call: c }] : []) : []);
      const selected = calls[(unit?.occurrence ?? 0) - 1];
      if (!selected || k[0]?.id !== selected.entry.id) issues.push("Requested tool batch does not start K");
      if (k.slice(1).some(e => e.type !== "message" || e.message.role !== "toolResult")) issues.push("Suffix already ran before the requested tool boundary");
    }
  }
  return { status: issues.length ? "UNPROVEN" as const : "PROVEN" as const, issues, turnEntries,
    retiredEntryIds: b.map(e => e.id), keptEntryIds: k.map(e => e.id), cutPoint: cut < 0 ? null : cut };
}

/** Initial task-file evidence only. Generated notes/output and extra read counts remain measured differences. */
export function fixtureExposure(row: RolloverObservation, cwd: string) {
  const files = row.placement?.files ?? {}, turns = row.placement ? turnMap(row.branch, row.placement) : {};
  const reads: Array<{ turn: string; path: string; complete: boolean }> = [];
  for (const entry of row.active) if (entry.type === "message" && entry.message.role === "assistant") for (const c of entry.message.content) {
    if (c.type !== "toolCall" || c.name !== "read" || typeof c.arguments.path !== "string") continue;
    const path = relative(cwd, resolve(cwd, c.arguments.path));
    if (!Object.hasOwn(files, path)) continue;
    const result = row.active.find(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === c.id && e.message.toolName === c.name);
    reads.push({ turn: Object.keys(turns).find(t => turns[t]!.includes(entry.id)) ?? "unmapped", path,
      complete: result?.type === "message" && result.message.role === "toolResult" && !result.message.isError && result.message.content.filter(b => b.type === "text").map(b => b.text).join("").trim() === files[path]!.trim() });
  }
  return reads;
}
