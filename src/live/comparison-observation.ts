import { isDeepStrictEqual } from "node:util";
import { convertToLlm, sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { memoryTokens, messageTokens, requestTokens, textTokens } from "../engine/accounting.js";
import { memoryMessage } from "../engine/memory.js";
import type { AdmissionObservation } from "../pi/admission.js";
import { semanticEvidence } from "./scenarios.js";
import type { MaintenanceResult } from "../engine/types.js";
import type { RunConfig } from "./contract.js";
import type { PreparedBoundary } from "./preparation.js";

export interface RequestObservation {
  callId: number; turn: string; kind: string; model: Model<Api>; thinking: string | null; reasoning: unknown;
  outputPlanning: number | null; context: Context; admission?: AdmissionObservation; cap?: { kind: string; value?: number };
}
export interface RolloverObservation {
  turn: string; reason: string; model: Model<Api>; thinking: string | null;
  preparation: { firstKeptEntryId: string; settings: RunConfig["compaction"]; isSplitTurn: boolean; messagesToSummarize: unknown[]; turnPrefixMessages: unknown[]; tokensBefore: number; [key: string]: unknown };
  branch: SessionEntry[]; active: SessionEntry[]; config: RunConfig; prepared?: PreparedBoundary;
  snapshot?: Extract<SessionEntry, { type: "compaction" }>; rebuilt?: SessionEntry[];
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
  const mTokens = !snap ? null : native ? summaryMessages!.reduce((sum, m) => sum + messageTokens(m), 0) : Array.isArray(slots) ? messageTokens(memoryMessage(slots)) : null;
  const summaryBodyTokens = snap ? textTokens(snap.summary) : null;
  const model = row.model;
  const calls = row.callIds.map(id => requests.find(r => r.callId === id)).filter((r): r is RequestObservation => Boolean(r));
  const cap = (r: RequestObservation) => r.cap?.kind === "known" || r.cap?.kind === "value" ? r.cap.value ?? null : r.cap?.value ?? null;
  const next = requests.find(r => r.callId === row.continuationCallId);
  const accounting = row.result?.observations.accounting;
  const fileLists = native && snap && Array.isArray(details?.readFiles) && Array.isArray(details?.modifiedFiles) ? { read: details.readFiles as string[], modified: details.modifiedFiles as string[] } : native ? null : { read: [], modified: [] };
  return { snapshotId: snap?.id ?? null, h: model.contextWindow - row.preparation.settings.reserveTokens,
    model: `${model.provider}/${model.id}`, modelConfig: model, thinking: row.thinking,
    cutPoint: index < 0 ? null : index, firstKeptEntryId: snap?.firstKeptEntryId ?? null,
    kTokens: msgs ? msgs.reduce((sum, m) => sum + messageTokens(m), 0) : null,
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
    overhead: { wrapperOverheadTokens: snap && mTokens !== null ? native ? mTokens - summaryBodyTokens! : mTokens - textTokens(slots.map((s: any) => s.text).join("")) : null,
      fileLists, fileListCount: fileLists ? fileLists.read.length + fileLists.modified.length : null,
      splitTurnCalls: native && row.preparation.isSplitTurn ? calls.length : 0 },
    source: { active: row.active, kept, nativeHistory: row.preparation.messagesToSummarize, nativePrefix: row.preparation.turnPrefixMessages },
    callIds: row.callIds, continuationCallId: row.continuationCallId ?? null,
    requiredObservation: row.result?.observations.required ?? null,
    guardApplicability: native || group === "current" ? "NOT_APPLICABLE" : "APPLICABLE" };
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
      if (!same(f.map(x => ({ provider: x.modelConfig.provider, id: x.modelConfig.id, api: x.modelConfig.api, contextWindow: x.modelConfig.contextWindow, maxTokens: x.modelConfig.maxTokens, thinking: x.thinking }))) || f.some(x => x.thinking === null || !x.callIds.length)) fail("modelMatched", `${label}: actual model/thinking unobserved or different`);
      if (!same(f.map((x, n) => evidence(x.source.active, g[n]!.cwd)))) fail("exposureMatched", `${label}: actual delivered source exposure differs`);
      if (!same(f.map(x => x.cutPoint)) || f.some(x => x.snapshotId === null)) fail("cutMatched", `${label}: actual cut point unobserved or different`);
      if (!same(f.map((x, n) => evidence(x.source.kept, g[n]!.cwd))) || !same(f.map(x => x.kTokens))) fail("kMatched", `${label}: whole K content/association/accounting unobserved or different`);
      // Native output caps constrain provider tokens; Pi appends file lists and wrappers after generation.
      // That does not establish a rendered-memory ceiling in the engine's estimator units.
      if (!same(f.map(x => x.memoryLimit)) || !same(f.map(x => x.mainInputLimit)) || !same(f.map(x => x.outputCaps)) || f.some(x => x.outputCaps.some(c => c === null) || x.finalContextTokens === null)) fail("budgetMatched", `${label}: rendered-memory, final-context or enforced-output constraints differ or are unobserved`);
      if (f.some(x => x.overhead.wrapperOverheadTokens === null)) fail("wrappersMeasured", `${label}: wrapper overhead unobserved`);
      if (f.some(x => x.overhead.fileLists === null)) fail("fileListsMeasured", `${label}: file-list overhead unobserved`);
      if (rows.some(r => !r.prepared)) fail("budgetMatched", `${label}: actual matched preparation missing`);
      differences.push({ label, groups: f.map((x, n) => ({ group: g[n]!.group, ...x, source: undefined })) });
    }
  }
  return { ...dimensions, differences, discrepancies, status: Object.values(dimensions).every(Boolean) ? "PROVEN" as const : "UNPROVEN" as const };
}
