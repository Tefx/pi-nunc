import { textOf, userText } from "./guidance.js";
import { isDeepStrictEqual } from "node:util";
import { buildContextEntries, convertToLlm, sessionEntryToContextMessages, serializeConversation, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { memoryTokens, messageTokens, requestTokens, textTokens } from "../engine/accounting.js";
import type { AdmissionObservation } from "../pi/admission.js";
import { checkFullExtraction, semanticEvidence } from "./scenarios.js";
import { resolve, relative } from "node:path";
import { resolveScenarioPath } from "./tool-path.js";
import { projectedNativeCut } from "./preparation.js";
import type { Control, Turn } from "./scenarios.js";
import type { MaintenanceResult } from "../engine/types.js";
import type { RunConfig } from "./contract.js";
import type { PreparedBoundary } from "./preparation.js";

export interface PlacementContract { control: Control; turns: Turn[]; files: Record<string, string>; turnEntries: Record<string, string[]>; requiredReads: Array<{ turn: string; path: string }> }
function turnMap(branch: SessionEntry[], contract: PlacementContract) {
  // Worker-observed IDs disambiguate identical requests in distinct named turns.
  return Object.fromEntries(contract.turns.map((turn, i) => {
    const start = branch.findIndex(e => e.id === contract.turnEntries[turn.id]?.[0]);
    const next = contract.turns[i + 1];
    const end = next ? branch.findIndex(e => e.id === contract.turnEntries[next.id]?.[0]) : branch.length;
    return [turn.id, start < 0 || end <= start || userText(branch[start]!) !== turn.text ? [] : branch.slice(start, end).filter(e => e.type === "message").map(e => e.id)];
  }));
}
function unitsIntact(entries: SessionEntry[]) {
  const messages = entries.flatMap(e => convertToLlm(sessionEntryToContextMessages(e)));
  const pending = new Map<string, string>();
  let callCount = 0, resultCount = 0;
  for (const m of messages) {
    if (m.role === "assistant") {
      for (const b of m.content) if (b.type === "toolCall") {
        if (pending.has(b.id)) return false;
        pending.set(b.id, b.name);
        callCount++;
      }
    } else if (m.role === "toolResult") {
      if (pending.get(m.toolCallId) !== m.toolName) return false;
      pending.delete(m.toolCallId);
      resultCount++;
    }
  }
  return pending.size === 0 && callCount === resultCount;
}
/** Named placement and same-session integrity; generated cross-session content may differ. */
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
    const native = projectedNativeCut(row.branch, row.preparation.settings.keepRecentTokens);
    if (snap.firstKeptEntryId !== row.prepared.firstKeptEntryId || row.branch[native?.firstKeptEntryIndex ?? -1]?.id !== row.preparation.firstKeptEntryId || !native || native.firstKeptEntryIndex <= start) issues.push("Snapshot disagrees with its own public legal prepared cut");
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
      const requestId = turn ? turnEntries[turn.id]?.[0] : undefined;
      const requestIndex = row.branch.findIndex(e => e.id === requestId);
      const branchCut = row.branch.findIndex(e => e.id === snap?.firstKeptEntryId);
      // An earlier checkpoint may already have retired the original request.
      if (!turn || requestIndex < 0 || requestIndex >= branchCut || k.some(e => e.id === requestId) || (!row.preparation.isSplitTurn && row.active.some(e => e.id === requestId))) issues.push("Original request did not retire before K");
      const unit = p.retainToolExchange;
      const ids = unit ? turnEntries[unit.turn] ?? [] : [];
      const calls = row.active.filter(e => ids.includes(e.id)).flatMap(e => e.type === "message" && e.message.role === "assistant" ? e.message.content.flatMap(c => c.type === "toolCall" && unit && (c.name === unit.toolName || c.name === contract.control.trigger?.alternateToolName) && typeof c.arguments.path === "string" && resolveScenarioPath(cwd, c.arguments.path) === resolve(cwd, unit.pathArgument) ? [{ entry: e, call: c }] : []) : []);
      const selected = row.prepared?.triggerCallId ? calls.find(c => c.call.id === row.prepared!.triggerCallId) : calls[(unit?.occurrence ?? 0) - 1];
      if (!selected || k[0]?.id !== selected.entry.id) issues.push("Requested tool batch does not start K");
      if (!row.prepared?.deferred && k.slice(1).some(e => e.type !== "message" || e.message.role !== "toolResult")) issues.push("Suffix already ran before the requested tool boundary");
    }
  }
  return { status: issues.length ? "UNPROVEN" as const : "PROVEN" as const, issues, turnEntries,
    retiredEntryIds: b.map(e => e.id), keptEntryIds: k.map(e => e.id), cutPoint: cut < 0 ? null : cut };
}
/** Initial fixture evidence only; extra reads and generated notes remain measured differences. */
export function fixtureExposure(row: RolloverObservation, cwd: string) {
  const files = row.placement?.files ?? {}, turns = row.placement ? turnMap(row.branch, row.placement) : {};
  const reads: Array<{ turn: string; path: string; complete: boolean }> = [];
  for (const entry of row.active) if (entry.type === "message" && entry.message.role === "assistant") for (const c of entry.message.content) {
    if (c.type !== "toolCall" || c.name !== "read" || typeof c.arguments.path !== "string") continue;
    const path = relative(cwd, resolveScenarioPath(cwd, c.arguments.path));
    if (!Object.hasOwn(files, path)) continue;
    const result = row.active.find(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === c.id && e.message.toolName === c.name);
    reads.push({ turn: Object.keys(turns).find(t => turns[t]!.includes(entry.id)) ?? "unmapped", path,
      complete: result?.type === "message" && result.message.role === "toolResult" && !result.message.isError && textOf(result.message.content).trim() === files[path]!.trim() });
  }
  return reads;
}

export interface RequestObservation {
  callId: number; turn: string; kind: string; model: Model<Api>; thinking: string | null; reasoning: unknown;
  outputPlanning: number | null; context: Context; admission?: AdmissionObservation; cap?: { kind: string; value?: number };
  /** Native serialized payload after all public payload hooks, bound by callId. */
  finalPayload?: unknown;
}
export interface RolloverObservation {
  turn: string; reason: string; model: Model<Api>; thinking: string | null;
  placement?: PlacementContract;
  preparation: { firstKeptEntryId: string; settings: RunConfig["compaction"]; isSplitTurn: boolean; messagesToSummarize: unknown[]; turnPrefixMessages: unknown[]; tokensBefore: number; [key: string]: unknown };
  branch: SessionEntry[]; active: SessionEntry[]; config: RunConfig; prepared?: PreparedBoundary;
  snapshot?: Extract<SessionEntry, { type: "compaction" }>; rebuilt?: SessionEntry[];
  reported?: Extract<SessionEntry, { type: "compaction" }>;
  association?: { status: "resolved" | "UNPROVEN"; reason?: string; reportedId?: string | null };
  result?: MaintenanceResult; callIds: number[]; continuationCallId?: number;
}
export function rolloverFacts(row: RolloverObservation, requests: RequestObservation[], group: string) {
  const snap = row.snapshot, native = group === "native";
  const index = snap ? row.active.findIndex(e => e.id === snap.firstKeptEntryId) : -1;
  const kept: SessionEntry[] | null = index < 0 ? null : row.active.slice(index).filter(e => e.type !== "compaction");
  const msgs = kept?.flatMap(e => convertToLlm(sessionEntryToContextMessages(e)));
  const summaryMessages = snap ? convertToLlm(sessionEntryToContextMessages(snap)) : null;
  const details = snap?.details as any;
  const slots = details?.nunc?.slots;
  const mTokens = !snap ? null : native ? summaryMessages!.reduce((sum, m) => sum + messageTokens(m), 0) : Array.isArray(slots) ? memoryTokens(slots, undefined, details.mechanicalFallback) : null;
  const summaryBodyTokens = snap ? textTokens(snap.summary) : null;
  const model = row.model;
  const calls = row.callIds.map(id => requests.find(r => r.callId === id)).filter((r): r is RequestObservation => Boolean(r));
  const cap = (r: RequestObservation) => r.cap?.kind === "known" || r.cap?.kind === "value" ? r.cap.value ?? null : r.cap?.value ?? null;
  const next = requests.find(r => r.callId === row.continuationCallId);
  const accounting = row.result?.observations.accounting;
  const fileLists = native && snap && Array.isArray(details?.readFiles) && Array.isArray(details?.modifiedFiles) ? { read: details.readFiles as string[], modified: details.modifiedFiles as string[] } : native || !snap ? null : { read: [], modified: [] };
  const nativeSources = [row.preparation.messagesToSummarize, row.preparation.turnPrefixMessages].filter(m => m.length > 0);
  const nativeSourceObserved = native && calls.length > 0 && nativeSources.length > 0 && nativeSources.every(messages => {
    const serialized = serializeConversation(convertToLlm(messages as any));
    return calls.some(c => c.context.messages.some(m => textOf(m.content).includes(serialized)));
  });
  const nativeTruncatedTools = nativeSources.flat().filter((m: any) => m.role === "toolResult" && Array.isArray(m.content) && m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").length > 2000).length;
  return { snapshotId: snap?.id ?? null, h: model.contextWindow - row.preparation.settings.reserveTokens,
    model: `${model.provider}/${model.id}`, modelConfig: model, thinking: row.thinking,
    cutPoint: index < 0 ? null : index, firstKeptEntryId: snap?.firstKeptEntryId ?? null,
    kTokens: msgs ? msgs.reduce((sum, m) => sum + messageTokens(m), 0) : null,
    kPlanning: accounting?.planning?.kept ?? null, // New planning basis; historical kTokens stays visible-only.
    mTokens, summarySize: snap?.summary.length ?? null,
    memoryLimit: native ? null : accounting?.memoryLimit ?? null,
    outputCaps: calls.map(cap), outputPlanning: calls.map(r => r.outputPlanning),
    outputReserve: row.preparation.settings.reserveTokens,
    mainInputLimit: native ? null : next?.admission?.inputLimit ?? null,
    mainPlanningInputLimit: accounting?.mainInputLimit ?? null,
    mainOutputCap: next ? cap(next) : null,
    mainAdmission: next?.admission ?? null,
    finalContextTokens: next ? requestTokens(next.context) : null,
    remainingContextTokens: next ? model.contextWindow - requestTokens(next.context) : null,
    accounting: accounting ?? null,
    overhead: { wrapperOverheadTokens: snap && mTokens !== null ? native ? mTokens - summaryBodyTokens! : memoryTokens(slots, undefined, details.mechanicalFallback) - textTokens(slots.map((s: any) => s.text).join("")) : null,
      fileLists, fileListCount: fileLists ? fileLists.read.length + fileLists.modified.length : null,
      splitTurnCalls: native && row.preparation.isSplitTurn ? calls.length : 0 },
    source: { active: row.active, kept, nativeHistory: row.preparation.messagesToSummarize, nativePrefix: row.preparation.turnPrefixMessages,
      extractionContexts: calls.map(c => c.context), nativeSourceObserved: native ? nativeSourceObserved : null,
      nativeTruncatedTools: native ? nativeTruncatedTools : null, omissions: row.result?.observations.omissions ?? null },
    callIds: row.callIds, continuationCallId: row.continuationCallId ?? null,
    requiredObservation: row.result?.observations.required ?? null,
    guardApplicability: native ? "NOT_APPLICABLE" : group !== "current" || row.result?.observations.required !== undefined ? "APPLICABLE" : row.result?.ok ? "NOT_APPLICABLE" : "UNPROVEN" };
}
export type RolloverFacts = ReturnType<typeof rolloverFacts>;

// Cross-session IDs/timestamps and task roots differ. Keep actual originals in each row;
// equality here concerns the ordered delivered content and whole tool associations.
function evidence(entries: SessionEntry[] | null, cwd: string) {
  if (!entries) return null;
  const ids = new Map<string, string>();
  const messages = entries.filter(e => e.type !== "compaction").flatMap(e => convertToLlm(sessionEntryToContextMessages(e))).map(semanticEvidence);
  for (const m of messages) if (Array.isArray(m.content)) for (const b of m.content) if (b.type === "toolCall") ids.set(b.id, `call${ids.size}`);
  return JSON.parse(JSON.stringify(messages, (key, value) => typeof value === "string" ? (key === "id" || key === "toolCallId") && ids.has(value) ? ids.get(value) : value.replaceAll(cwd, "<task>") : value));
}
export function matchedParity(cases: Array<{ label: string; groups: Array<{ group: string; complete: boolean; cwd: string; rows: RolloverObservation[]; requests: RequestObservation[] }> }>) {
  const dimensions = { modelMatched: true, exposureMatched: true, cutMatched: true, kMatched: true, budgetMatched: true, wrappersMeasured: true, fileListsMeasured: true };
  const discrepancies: string[] = [], differences: unknown[] = [];
  const fail = (key: keyof typeof dimensions, message: string) => { dimensions[key] = false; discrepancies.push(message); };
  for (const item of cases) {
    const g = item.groups;
    if (g.length !== 3 || g.some(x => !x.complete || x.rows.length === 0) || !g.every(x => x.rows.length === g[0]!.rows.length)) {
      for (const key of Object.keys(dimensions) as Array<keyof typeof dimensions>) fail(key, `${item.label}: incomplete group/segment/rollover evidence (${key})`);
      continue;
    }
    for (let i = 0; i < g[0]!.rows.length; i++) {
      const label = `${item.label} rollover ${i + 1}`;
      const rows = g.map(x => x.rows[i]!);
      const f = g.map((x, n) => rolloverFacts(rows[n]!, x.requests, x.group));
      const same = (values: unknown[]) => values.every(v => v !== null && v !== undefined && isDeepStrictEqual(v, values[0]));
      if (!same(f.map(x => ({ model: x.modelConfig, thinking: x.thinking }))) || f.some(x => x.thinking === null || !x.callIds.length)) fail("modelMatched", `${label}: actual model/thinking unobserved or different`);
      const placements = rows.map((r, n) => logicalPlacement(r, g[n]!.cwd));
      const reads = rows.map((r, n) => fixtureExposure(r, g[n]!.cwd));
      const requiredReads = [...new Set([...reads.flat(), ...rows.flatMap(r => r.placement?.requiredReads ?? [])].map(r => `${r.turn}:${r.path}`))];
      const missingReads = reads.map(rs => requiredReads.filter(key => !rs.some(r => `${r.turn}:${r.path}` === key && r.complete)));
      const contractsMatch = same(rows.map(r => r.placement ? { control: r.placement.control, turns: r.placement.turns, files: r.placement.files, requiredReads: r.placement.requiredReads } : null));
      const extractionObserved = f.every((x, n) => x.source.extractionContexts.length > 0 && (g[n]!.group === "native"
        ? x.source.nativeSourceObserved && x.source.nativeTruncatedTools === 0
        : x.source.omissions?.length === 0 && x.source.extractionContexts.some(ctx => checkFullExtraction(rows[n]!.active, ctx).status === "PROVEN")));
      if (!contractsMatch || placements.some(p => p.issues.some(i => i.includes("request"))) || missingReads.some(rs => rs.length > 0) || !extractionObserved) fail("exposureMatched", `${label}: necessary task/file source is missing, different, truncated or unobserved`);
      if (!contractsMatch || placements.some(p => p.status !== "PROVEN")) fail("cutMatched", `${label}: own legal cut or common named placement is unproven`);
      if (!contractsMatch || placements.some(p => p.status !== "PROVEN")) fail("kMatched", `${label}: own unchanged complete K/tool units or common named retention is unproven`);
      // Native output caps constrain provider tokens; Pi appends file lists and wrappers after generation.
      // That does not establish a rendered-memory ceiling in the engine's estimator units.
      if (!same(f.map(x => x.memoryLimit)) || !same(f.map(x => x.mainInputLimit)) || !same(f.map(x => x.outputCaps)) || f.some(x => x.outputCaps.some(c => c === null) || x.finalContextTokens === null)) fail("budgetMatched", `${label}: rendered-memory, final-context or enforced-output constraints differ or are unobserved`);
      if (f.some(x => x.overhead.wrapperOverheadTokens === null)) fail("wrappersMeasured", `${label}: wrapper overhead unobserved`);
      if (f.some(x => x.overhead.fileLists === null)) fail("fileListsMeasured", `${label}: file-list overhead unobserved`);
      if (rows.some(r => !r.prepared)) fail("budgetMatched", `${label}: actual matched preparation missing`);
      differences.push({ label,
        exactTrajectory: { activeContentEqual: same(f.map((x, n) => evidence(x.source.active, g[n]!.cwd))), rawCutIndicesEqual: same(f.map(x => x.cutPoint)),
          kContentEqual: same(f.map((x, n) => evidence(x.source.kept, g[n]!.cwd))), kTokensEqual: same(f.map(x => x.kTokens)) },
        groups: f.map((x, n) => ({ group: g[n]!.group, ...x, source: undefined, placement: placements[n], fixtureReads: reads[n], missingNecessaryReads: missingReads[n],
          nativeTruncatedTools: x.source.nativeTruncatedTools, toolResults: x.source.active.filter(e => e.type === "message" && e.message.role === "toolResult").length })) });
    }
  }
  return { ...dimensions, differences, discrepancies, status: Object.values(dimensions).every(Boolean) ? "PROVEN" as const : "UNPROVEN" as const };
}
