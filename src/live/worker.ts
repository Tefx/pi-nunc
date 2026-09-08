import { qualifyCapacity, checkCapacityRecovery } from "./capacity-observation.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { convertToLlm, sessionEntryToContextMessages, SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { closeHost, openHost, type NativeHost } from "./host.js";
import { canonical, object, parseInput, preflight, requireValue, RunnerError, selectedModels, type ComparisonGroup, type ComparisonMode, type RunInput, type Selection } from "./contract.js";
import { checkFullExtraction, checkRollover, evaluateE2SetupChecks, loadScenario, maintenanceResult, qualifyFullGiantSource, scoreArtifacts, seedScenario, semanticEvidence, type CheckResult } from "./scenarios.js";
import { ledgerSummary, readLedger, type CallRecord, type CallEnd } from "./budget.js";
import type { MaintenanceResult } from "../engine/types.js";
import { project, type NuncConfig } from "../pi/index.js";
import type { RetentionCalibration } from "./calibration.js";
import { prepareBoundary, type PreparedBoundary, type MatchReference } from "./preparation.js";
import { rolloverFacts, type RolloverFacts, type RolloverObservation, type RequestObservation } from "./comparison-observation.js";

export interface WorkerJob { input: RunInput; scenarioIndex: number; deadline: number; resume: boolean; group?: ComparisonGroup | undefined; mode?: ComparisonMode | undefined; caseRoot?: string | undefined; matchReferences?: MatchReference[] | undefined }
interface Checkpoint { pid: number; sessionFile: string; sessionId: string; leafId: string | null; nextTurn: number; turnEntries: Record<string, string[]>; rebuilt: SessionEntry[]; prerequisites: CheckResult[]; nuncConfig: NuncConfig; actions?: unknown[]; lastBeforeActive?: SessionEntry[]; rollovers?: RolloverObservation[]; requests?: RequestObservation[]; runConfig?: Selection["config"] }
export interface SegmentReport {
  pid: number;
  scenario: string;
  group?: ComparisonGroup | undefined;
  mode?: ComparisonMode | undefined;
  status: "PAUSED" | "OBSERVED" | "UNPROVEN" | "STOPPED";
  reason?: string | undefined;
  diagnostic?: string | undefined;
  prerequisites: CheckResult[];
  setupChecks?: CheckResult[] | undefined;
  sessionFile?: string | undefined;
  nextTurn: number;
  score?: Awaited<ReturnType<typeof scoreArtifacts>> | undefined;
  contexts: Array<{ turn: string; model: string; kind: string; context: Context }>;
  maintenance: unknown[];
  actions: unknown[];
  commands?: Array<{ type: string; message?: string }> | undefined;
  segmentUsage?: { calls: number; tokens: number | null; latencyMs: number; costUsd: number | null } | undefined;
  maintenanceResponses?: Array<{ model: string; stopReason: string; patch: any; text?: string }> | undefined;
  rolloverQuality?: CheckResult | undefined;
  rollovers?: RolloverObservation[] | undefined;
  requests?: RequestObservation[];
  preparations?: Array<PreparedBoundary | { failure: string; turn: string }>;
  callIds?: number[];
  calibrations: Array<RetentionCalibration & { effectiveConfig: NuncConfig }>;
  preparationFailure?: { afterTurn: string; message: string } | undefined;
  observedFacts?: RolloverFacts;
  comparisonFacts?: {
    h: number;
    cutPoint?: number | undefined;
    firstKeptEntryId?: string | undefined;
    kTokens?: number | undefined;
    mTokens?: number | undefined;
    summarySize?: number | undefined;
    outputCap?: number | undefined;
    outputReserve?: number | undefined;
    memoryLimit?: number | undefined;
    model?: string | undefined;
    overhead?: {
      fileListCount?: number | undefined;
      wrapperOverheadTokens?: number | undefined;
      splitTurnCalls?: number | undefined;
    } | undefined;
    exposure?: {
      turns: string[];
      toolResultsCount: number;
    } | undefined;
    requiredObservation?: unknown;
    guardApplicability?: string | undefined;
  } | undefined;
}
function userText(entry: SessionEntry): string | undefined {
  if (entry.type !== "message" || entry.message.role !== "user") return undefined;
  const content = entry.message.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter(b => b.type === "text").map(b => b.text).join("") : undefined;
}
function deliveredUserIds(branch: SessionEntry[], text: string): string[] {
  return branch.filter(e => userText(e) === text).map(e => e.id);
}
function captureComparisonFacts(
  report: SegmentReport,
  runtime: NativeHost | undefined,
  selection: Selection,
  group: ComparisonGroup,
  firstModel: Model<Api>,
  lastBeforeActive: SessionEntry[]
): void {
  const row = report.rollovers?.at(-1);
  if (row) report.observedFacts = rolloverFacts(row, report.requests ?? [], group);
  // No host/transaction means no observed facts. Selection values never stand in for observations.
}
export async function runSegment(job: WorkerJob, overrides: { controlledModels?: unknown; models?: Model<Api>[]; signal?: AbortSignal } = {}): Promise<SegmentReport> {
  const { input } = job, selection = input.scenarios[job.scenarioIndex];
  requireValue(selection, "SCENARIO", "Invalid worker selection");
  const group: ComparisonGroup = job.group ?? "candidate";
  const mode: ComparisonMode = job.mode ?? "defaults";
  const caseRoot = job.caseRoot ?? join(input.target.stateRoot, `${selection.id}${selection.variant ? `-${selection.variant}` : ""}`);
  const checkpointPath = join(caseRoot, "checkpoint.json");
  const { input: scenario, observer } = await loadScenario(input.target.repository, selection, input.assets);
  const local = new AbortController();
  const signal = AbortSignal.any([local.signal, AbortSignal.timeout(Math.max(1, job.deadline - Date.now())), ...(overrides.signal ? [overrides.signal] : [])]);
  const onSignal = () => local.abort(); process.once("SIGTERM", onSignal); process.once("SIGINT", onSignal);
  const report: SegmentReport = { pid: process.pid, scenario: selection.id, group, mode, status: "STOPPED", prerequisites: [], nextTurn: 0, contexts: [], maintenance: [], actions: [], commands: [], calibrations: [] };
  const firstModel = overrides.models?.[0] ?? selectedModels(input)[0]!;
  const startLedger = readLedger(join(input.target.stateRoot, "calls.jsonl"));
  const startReserveIds = new Set(startLedger.filter(r => r.kind === "reserve").map(r => r.id));

  let runtime: NativeHost | undefined, turn = "startup", turns: Record<string, string[]> = {};
  const scheduledSteers = new Set<string>();
  let checkpoint: Checkpoint | undefined;
  let runConfig = structuredClone(selection.config);
  let effectiveConfig = runConfig.nunc;
  let prepared: PreparedBoundary | undefined;
  let pendingAdmission: any;
  report.rollovers = []; report.requests = []; report.preparations = [];
  const boundaryControl = observer.controls.find(c => c.action === "rollover_at_tool_boundary");
  const boundary = boundaryControl ? { control: boundaryControl, requestText: scenario.turns.find(t => t.id === boundaryControl.duringTurn)!.text, fixtureContent: scenario.files[boundaryControl.trigger!.pathArgument]! } : undefined;
  const targetRepository = group === "native" ? undefined : input.comparison?.targets[group].repository ?? input.target.repository;
  const prepare = async (branch: SessionEntry[], active: SessionEntry[], control: typeof observer.controls[number], trigger?: Parameters<typeof prepareBoundary>[0]["trigger"]) => {
    const result = await prepareBoundary({ branch, active, control, turns, turnOrder: scenario.turns.map(t => t.id), config: runConfig,
      model: runtime!.model!, fixed: runtime!.fixed, ...(targetRepository ? { repository: targetRepository } : {}), signal,
      ...(trigger ? { trigger } : {}), matched: mode === "matched", ...(job.matchReferences?.[report.rollovers!.length] ? { reference: job.matchReferences[report.rollovers!.length]! } : {}) });
    report.preparations!.push(result);
    runConfig = result.config; effectiveConfig = runConfig.nunc; prepared = result;
    if (result.calibration) report.calibrations.push({ ...result.calibration, effectiveConfig: structuredClone(effectiveConfig) });
    await runtime!.reconfigure(runConfig);
    return result;
  };
  let lastBeforeActive: SessionEntry[] = [];
  let capacityFailure: { snapshots: SessionEntry[]; maintenanceCount: number } | undefined;
  const maintenanceResponses: Array<{ model: string; stopReason: string; patch: any; text?: string }> = [];
  report.maintenanceResponses = maintenanceResponses;
  try {
    if (job.resume) {
      checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as Checkpoint;
      requireValue((selection.id === "c3" || selection.id === "e1" || selection.id === "e3") && checkpoint.nextTurn > 0, "RESTART", "Resume must use a new host process and existing checkpoint");
      turns = checkpoint.turnEntries; report.nextTurn = checkpoint.nextTurn; report.prerequisites = checkpoint.prerequisites;
      runConfig = checkpoint.runConfig ?? { ...runConfig, nunc: checkpoint.nuncConfig }; effectiveConfig = runConfig.nunc;
      if (checkpoint.requests) report.requests = checkpoint.requests.slice();
      if (Array.isArray(checkpoint.actions)) report.actions = checkpoint.actions.slice();
      lastBeforeActive = checkpoint.lastBeforeActive ? checkpoint.lastBeforeActive.slice() : checkpoint.rebuilt.slice();
      if (Array.isArray(checkpoint.rollovers)) report.rollovers = checkpoint.rollovers.slice();
    } else { await mkdir(caseRoot, { recursive: false }); await seedScenario(scenario, join(caseRoot, "task")); }
    runtime = await openHost({ repository: input.target.repository, input, selection: { ...selection, config: runConfig }, caseRoot, modelTargets: overrides.models ?? selectedModels(input), deadline: job.deadline, signal,
      group, mode, targetRepos: input.comparison?.targets ? { native: input.comparison.targets.native.repository, current: input.comparison.targets.current.repository, candidate: input.comparison.targets.candidate.repository } : undefined,
      ...(checkpoint ? { sessionFile: checkpoint.sessionFile } : {}), ...(overrides.controlledModels ? { controlledModels: overrides.controlledModels } : {}),
      boundary, verification: scenario.files["verify.py"] ? { script: scenario.files["verify.py"], artifact: selection.id === "e1" ? "verification.json" : "verified.json" } : undefined,
      onBoundary: async data => {
        try {
          const result = await prepare(data.branch, data.active, boundaryControl!, { callId: data.triggerId, requestText: boundary!.requestText,
            path: boundaryControl!.trigger!.pathArgument, cwd: join(caseRoot, "task"), fixtureContent: boundary!.fixtureContent, contextTokens: data.usage?.tokens ?? null });
          await runtime!.releaseBoundary({ firstKeptEntryId: result.firstKeptEntryId });
        } catch (error) {
          const failure = error instanceof Error ? error.message : "Boundary preparation failed";
          report.preparations!.push({ failure, turn });
          report.prerequisites.push({ check: "actual mid-turn preparation", status: "UNPROVEN", reason: failure });
          await runtime!.releaseBoundary({ stop: failure });
        }
      },
      onObservation: (type, data) => {
        if (type === "preparation") {
          report.rollovers!.push({ ...data, turn, config: structuredClone(runConfig), ...(prepared ? { prepared } : {}), callIds: [] });
          prepared = undefined;
        }
        const row = report.rollovers!.at(-1);
        if (type === "admission") {
          const req = report.requests!.at(-1);
          if (data.payload && req && req.kind === data.kind) req.admission = data;
          else pendingAdmission = data;
        }
        if (type === "request") {
          report.requests!.push({ ...data, turn, ...(pendingAdmission?.kind === data.kind ? { admission: pendingAdmission } : {}) });
          pendingAdmission = undefined;
          if (row && data.kind === "maintenance") row.callIds.push(data.callId);
          if (row?.snapshot && data.kind === "main" && row.continuationCallId === undefined) row.continuationCallId = data.callId;
        }
        if (type === "request-cap") { const req = report.requests!.find(r => r.callId === data.callId); if (req) req.cap = data.cap; }
        if (type === "commit" && row) { row.snapshot = data.snapshot; row.rebuilt = data.rebuilt; }
      },
      onMaintenance: event => { const result = maintenanceResult(event); report.maintenance.push(result ? JSON.parse(JSON.stringify(result)) : { invalidEvent: true });
        const row = report.rollovers!.at(-1); if (row && result) row.result = JSON.parse(JSON.stringify(result)); },
      onMaintenanceResponse: data => { if (object(data)) maintenanceResponses.push(data as any); },
      onContext: (model, context, kind) => report.contexts.push({ turn, model: `${model.provider}/${model.id}`, kind, context }),
      onAction: event => report.actions.push({ turn, event }),
    });
    report.pid = runtime.pid ?? process.pid;
    const session = runtime.session, sm = session.sessionManager;

    if (checkpoint) {
      const restored = sm.buildContextEntries();
      const same = checkpoint.pid !== report.pid && sm.getSessionId() === checkpoint.sessionId && sm.getLeafId() === checkpoint.leafId && session.sessionFile === checkpoint.sessionFile && isDeepStrictEqual(restored, checkpoint.rebuilt);
      report.prerequisites.push({ check: "new process resumed same persisted session/path/context without reseeding", status: same ? "PROVEN" : "UNPROVEN" });
      requireValue(same, "RESTART", "Restored context/path differs from paused persistent state");
    }
    for (let index = report.nextTurn; index < scenario.turns.length; index++) {
      signal.throwIfAborted(); const inputTurn = scenario.turns[index]!; turn = inputTurn.id;
      if (scheduledSteers.has(turn)) {
        const delivered = deliveredUserIds(sm.getBranch(), inputTurn.text);
        turns[turn] = delivered; report.nextTurn = index + 1;
        continue;
      }
      const beforeIds = new Set(sm.getBranch().map(e => e.id));
      await session.prompt(inputTurn.text, { expandPromptTemplates: false });
      turns[turn] = sm.getBranch().filter(e => e.type === "message" && !beforeIds.has(e.id)).map(e => e.id);
      report.nextTurn = index + 1;
      const last = session.messages.findLast(m => m.role === "assistant");
      requireValue(last?.role === "assistant" && last.stopReason === "stop", "MAIN_RESPONSE", last?.role === "assistant" && last.errorMessage ? last.errorMessage : "Main run did not end in a complete stop state");
      requireValue(ledgerSummary(readLedger(join(input.target.stateRoot, "calls.jsonl"))).unreconciledCallIds.length === 0, "RECONCILIATION", "A request is still unresolved");

      if (selection.id === "e4" && selection.variant === "required-too-large" && turn === "c") {
        if (group === "candidate") (capacityFailure ? report.prerequisites : (report.setupChecks ??= [])).push(checkCapacityRecovery({
          capacityFailed: capacityFailure !== undefined,
          deliveredCount: deliveredUserIds(sm.getBranch(), inputTurn.text).length,
          terminalStop: last?.role === "assistant" && last.stopReason === "stop",
          memoryAndBoundaryUnchanged: capacityFailure !== undefined && isDeepStrictEqual(sm.getBranch().filter(e => e.type === "compaction"), capacityFailure.snapshots),
          additionalMaintenance: capacityFailure ? report.maintenance.length - capacityFailure.maintenanceCount : -1,
        }));
      }
      for (const id of scheduledSteers) {
        const text = scenario.turns.find(t => t.id === id)?.text; if (!text) continue;
        if (report.prerequisites.some(p => p.check === "corrective D delivered verbatim once after freeze without a serial prompt")) continue;
        const count = deliveredUserIds(sm.getBranch(), text).length; if (count === 0) continue;
        const freezeAt = report.contexts.findIndex(c => c.kind === "maintenance");
        const firstMain = freezeAt >= 0 ? report.contexts.slice(freezeAt + 1).find(c => c.kind === "main") : undefined;
        const includes = Boolean(firstMain && JSON.stringify(firstMain.context).includes(text));
        turns[id] = deliveredUserIds(sm.getBranch(), text);
        report.prerequisites.push({ check: "corrective D delivered verbatim once after freeze without a serial prompt", status: count === 1 && includes ? "PROVEN" : count > 1 ? "DISPROVEN" : "UNPROVEN", observed: { count, firstPostFreezeMainIncludesD: includes } });
      }
      if ((selection.id === "c3" || selection.id === "c5") && turn === "a") {
        for (const [path, content] of Object.entries(scenario.files)) {
          const visible = sm.buildContextEntries().some(e => e.type === "message" && e.message.role === "toolResult" && !e.message.isError && e.message.content.some(b => b.type === "text" && b.text.includes(content.trim())));
          report.prerequisites.push({ check: `required ${path} observation actually visible`, status: visible ? "PROVEN" : "UNPROVEN" });
        }
      }
      if (selection.id === "c1" && turn === "b" && scenario.files["probe.json"]) {
        const probe = scenario.files["probe.json"]?.trim();
        const visible = sm.buildContextEntries().some(e => e.type === "message" && e.message.role === "toolResult" && !e.message.isError && e.message.content.some(b => b.type === "text" && Boolean(probe) && b.text.includes(probe!)));
        report.prerequisites.push({ check: "complete probe result actually visible before rollover", status: visible ? "PROVEN" : "UNPROVEN" });
      }
      for (const control of observer.controls.filter(c => c.afterTurn === turn || c.duringTurn === turn)) {
        if (control.action === "rollover_at_tool_boundary") {
          const row = report.rollovers!.find(r => r.turn === turn && r.reason === "threshold");
          const snap = row?.snapshot, expected = row?.prepared?.firstKeptEntryId;
          const next = report.requests!.find(r => r.callId === row?.continuationCallId);
          const retained = snap && row ? row.active.slice(row.active.findIndex(e => e.id === snap.firstKeptEntryId)).filter(e => e.type !== "compaction") : [];
          const unchanged = retained.length > 0 && retained.every(e => isDeepStrictEqual(row?.rebuilt?.find(r => r.id === e.id), e));
          const expectedMessages = convertToLlm(retained.flatMap(e => sessionEntryToContextMessages(e))).map(semanticEvidence);
          const delivered = next?.context.messages.map(semanticEvidence) ?? [];
          const suffixDelivered = expectedMessages.length > 0 && delivered.some((_m, i) => isDeepStrictEqual(delivered.slice(i, i + expectedMessages.length), expectedMessages));
          const requestRetired = Boolean(row && row.preparation.turnPrefixMessages.some((m: any) => m.role === "user" && (typeof m.content === "string" ? m.content : m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")) === boundary!.requestText));
          const check = { check: "actual tool batch followed by automatic native split compaction and same-loop continuation", status: row && snap && expected === snap.firstKeptEntryId && unchanged && suffixDelivered && requestRetired && next && row.preparation.isSplitTurn ? "PROVEN" as const : "UNPROVEN" as const,
            observed: { snapshotId: snap?.id, expectedFirst: expected, actualFirst: snap?.firstKeptEntryId, continuationCallId: row?.continuationCallId, retainedEntryIds: retained.map(e => e.id), reason: row?.reason } };
          report.prerequisites.push(check);
        } else if (control.action === "switch_to_authorized_smaller_model") {
          const models = overrides.models ?? selectedModels(input), next = models[1];
          requireValue(next && session.model && next.contextWindow < session.model.contextWindow, "MODEL", "No authorized smaller target");
          const before = session.model;
          await session.setModel(next, { persist: false });
          report.prerequisites.push({ check: "public session model switch recorded distinct smaller real catalog target", status: session.model?.id === next.id && sm.getBranch().some(e => e.type === "model_change" && e.provider === next.provider && e.modelId === next.id) ? "PROVEN" : "UNPROVEN", observed: { from: { provider: before.provider, id: before.id, capacity: before.contextWindow }, to: { provider: next.provider, id: next.id, capacity: next.contextWindow }, controlledProvider: Boolean(overrides.controlledModels) } });
        } else if (control.action === "rollover") {
          lastBeforeActive = structuredClone(sm.buildContextEntries());
          if (mode === "matched" || selection.config.retentionCalibration) {
            try { await prepare(structuredClone(sm.getBranch()), lastBeforeActive, control); }
            catch (error) { const failure = error instanceof Error ? error.message : "Placement preparation failed"; report.preparations!.push({ failure, turn }); report.preparationFailure = { afterTurn: turn, message: failure }; report.prerequisites.push({ check: "authorized retention calibration before maintenance", status: "UNPROVEN", reason: failure }); throw new RunnerError("CALIBRATION", failure); }
          }
          if (group === "native") {
            const before = structuredClone(sm.getBranch());
            let failed = false;
            try { await session.compact(); } catch { failed = true; }
            const file = session.sessionFile; requireValue(file, "PERSISTENCE", "No persistent session file");
            const saved = SessionManager.open(file, join(caseRoot, "sessions"));
            const after = saved.getBranch();
            const newSnapshots = after.filter(e => e.type === "compaction" && !before.some(b => b.id === e.id));
            const snapshot = newSnapshots[0];
            const pass = !failed && newSnapshots.length === 1 && snapshot?.type === "compaction" && !snapshot.fromHook;
            report.prerequisites.push({ check: "one actual persisted native Pi rollover", status: pass ? "PROVEN" : "UNPROVEN" });
            if (!pass || !snapshot) {
              report.prerequisites.push({ check: "successful native rollover", status: "UNPROVEN", reason: "Native Pi compact did not produce a valid snapshot" });
              throw new RunnerError("MAINTENANCE", "No successful native rollover; continuation remains unproven");
            }
            const rebuilt = saved.buildContextEntries();
            report.prerequisites.push({ check: "native rebuild selects compaction snapshot", status: rebuilt.some(e => e.id === snapshot.id) ? "PROVEN" : "UNPROVEN" });
            const placement = control.placement;
            if (placement?.retireThroughTurn) {
              const keys = Object.keys(turns), stop = keys.indexOf(placement.retireThroughTurn);
              const ids = keys.slice(0, stop + 1).flatMap(k => turns[k] ?? []);
              report.prerequisites.push({ check: `retired complete turns through ${placement.retireThroughTurn}`, status: stop >= 0 && ids.length > 0 && ids.every(id => !rebuilt.some(e => e.id === id)) ? "PROVEN" : "UNPROVEN" });
            }
            for (const t of placement?.retainTurns ?? []) {
              const ids = turns[t] ?? [];
              report.prerequisites.push({ check: `complete turn ${t} retained with tool associations`, status: ids.length > 0 && ids.every(id => rebuilt.some(e => e.id === id)) ? "PROVEN" : "UNPROVEN" });
            }
            if (selection.id === "e4") {
              report.prerequisites.push({ check: "required-item guard applicability", status: "PROVEN", observed: { group: "native", guardApplicability: "NOT_APPLICABLE", note: "Native Pi 0.85.1 has no required-item guard" } });
            }
          } else {
            const beforeActive = structuredClone(sm.buildContextEntries());
            const before = structuredClone(sm.getBranch()), previousSnapshots = before.filter(e => e.type === "compaction"), eventCount = report.maintenance.length;
            const frozenCapacityMemory = project(beforeActive).memory;
            const capacityResponseStart = maintenanceResponses.length, capacityContextStart = report.contexts.length;
            const capacityModel = session.model ? `${session.model.provider}/${session.model.id}` : "";
            const steerTurn = control.steer ? scenario.turns.find(t => t.id === control.steer) : undefined;
            let steered = false, overlap = false;
            const frozenContext = () => report.contexts.filter(c => c.turn === turn && c.kind === "maintenance");
            let failed = false;
            try {
              await session.compact(steerTurn ? async steerSignal => {
                while (!steerSignal.aborted && frozenContext().length === 0) await new Promise(resolve => setTimeout(resolve, 25));
                if (steerSignal.aborted || frozenContext().length === 0) return;
                if (!(await session.getState()).isCompacting) return;
                await session.steer(steerTurn.text);
                steered = true;
                scheduledSteers.add(steerTurn.id);
                overlap = (await session.getState()).isCompacting && frozenContext().length > 0;
              } : undefined);
            } catch { failed = true; }
            const result = maintenanceResult(report.maintenance.at(-1));
            const file = session.sessionFile; requireValue(file, "PERSISTENCE", "No persistent session file");
            const saved = SessionManager.open(file, join(caseRoot, "sessions"));
            const after = saved.getBranch();
            if (selection.id === "e4" && group === "candidate") {
              report.setupChecks ??= [];
              report.setupChecks.push(...qualifyCapacity(selection.variant as "fits-required" | "required-too-large",
                frozenCapacityMemory, report.maintenance.length === eventCount + 1 ? result : undefined,
                report.contexts.slice(capacityContextStart).filter(c => c.kind === "maintenance").map(c => c.context),
                maintenanceResponses.slice(capacityResponseStart), capacityModel, report.rollovers!.at(-1)?.prepared?.calibration?.accounting));
            }
            if (failed || !result?.ok || report.maintenance.length <= eventCount) {
              const unchanged = isDeepStrictEqual(after.filter(e => e.type === "compaction"), previousSnapshots);
              report.prerequisites.push({ check: "failed maintenance preserved prior saved memory/boundary", status: unchanged ? "PROVEN" : "DISPROVEN" });
              if (selection.id === "e4" && selection.variant === "required-too-large") {
                const req = result?.observations.required;
                const reqPass = Boolean(result && !result.ok && result.code === "CAPACITY" && req?.failed);
                if (group === "candidate" && reqPass && unchanged && report.maintenance.length === eventCount + 1) {
                  capacityFailure = { snapshots: structuredClone(previousSnapshots), maintenanceCount: report.maintenance.length };
                }
                report.prerequisites.push({ check: "marked necessary set exceeding limit fails with CAPACITY without commit", status: reqPass ? "PROVEN" : "UNPROVEN", observed: { code: result && !result.ok ? result.code : undefined, required: req } });
                report.rolloverQuality = { check: "successful required persisted rollover", status: "UNPROVEN", reason: "Capacity failure correctly rejected candidate; successful rollover is not claimed" };
              } else {
                report.prerequisites.push({ check: "successful required persisted rollover", status: "UNPROVEN", reason: result && !result.ok ? `${result.code}: ${result.message}` : "Pi hook did not produce a successful Nunc snapshot" });
                if (selection.variant === "capacity") report.prerequisites.push({ check: "full extraction demonstrably exceeds effective input capacity", status: result?.observations.accounting && result.observations.accounting.fullExtractionTokens > result.observations.accounting.extractionInputLimit ? "PROVEN" : "UNPROVEN", observed: result?.observations.accounting ?? null });
                throw new RunnerError("MAINTENANCE", "No successful rollover; continuation remains unproven");
              }
            } else {
              report.prerequisites.push(...checkRollover(before, after, saved, result, control, turns));
              if (selection.config.retentionCalibration || mode === "matched") report.prerequisites.push({ check: "Nunc/Pi independently selected and persisted calibrated boundary", status: result.candidate.firstKeptEntryId === report.rollovers!.at(-1)?.prepared?.firstKeptEntryId ? "PROVEN" : "UNPROVEN" });
              if (result.observations.omissions.length === 0) report.prerequisites.push(checkFullExtraction(beforeActive, report.contexts.findLast(c => c.turn === turn && c.kind === "maintenance")?.context));
              if (selection.id === "e4") {
                if (group === "candidate") {
                  report.prerequisites.push({ check: "required-item guard applicability", status: "PROVEN", observed: { group: "candidate", guardApplicability: "APPLICABLE" } });
                  const req = result?.observations.required;
                  if (selection.variant === "fits-required") {
                    const pass = Boolean(result?.ok && req && !req.failed && req.declared.length > 0);
                    report.setupChecks!.push({ check: "all marked necessary candidates jointly retained in final memory", status: pass ? "PROVEN" : "UNPROVEN", observed: req ?? null });
                  } else if (selection.variant === "required-too-large") {
                    const reqExceeds = report.setupChecks?.find(p => p.check.includes("marked necessary set exceeds rendered memory limit"))?.status === "PROVEN";
                    report.setupChecks!.push({ check: "required-too-large rollover eligibility", status: reqExceeds ? "DISPROVEN" : "UNPROVEN", reason: reqExceeds ? "Maintenance succeeded despite the measured necessary-set overflow" : "Successful ordinary continuation remains eligible; the capacity variant did not qualify" });
                  }
                } else if (group === "current") {
                  report.prerequisites.push({ check: "required-item guard applicability", status: "PROVEN", observed: { group: "current", guardApplicability: "NOT_APPLICABLE", note: "Product baseline 70dacad has no required-item guard" } });
                }
              } else if (selection.id === "c4") {
                const exception = scenario.generatedFiles?.[0]?.segments.find(s => s.repeat === 1)?.text.trim();
                const visible = before.some(e => e.type === "message" && e.message.role === "toolResult" && !e.message.isError && e.message.content.some(b => b.type === "text" && Boolean(exception) && b.text.includes(exception!)));
                const requests = report.contexts.filter(c => c.turn === turn && c.kind === "maintenance");
                const extracted = Boolean(exception) && requests.some(r => JSON.stringify(r.context).includes(exception!));
                if (selection.variant === "full") {
                  report.prerequisites.push(qualifyFullGiantSource(scenario.generatedFiles));
                  const toolTexts: string[] = [];
                  for (const e of before) if (e.type === "message" && e.message.role === "toolResult" && !e.message.isError) for (const b of e.message.content) if (b.type === "text") toolTexts.push(b.text);
                  const truncatedWithout = toolTexts.some(t => /Use offset=\d+/.test(t) && Boolean(exception) && !t.includes(exception!));
                  report.prerequisites.push({ check: "native truncation hid the middle exception until complete tool exposure", status: truncatedWithout && visible ? "PROVEN" : "UNPROVEN", observed: { truncatedWithoutException: truncatedWithout, completeException: visible } });
                  report.prerequisites.push({ check: "middle exception visible in actual Pi tool projection and full maintenance request", status: visible && extracted && result.observations.omissions.length === 0 ? "PROVEN" : "UNPROVEN" });
                } else {
                  const accounting = result.observations.accounting;
                  report.prerequisites.push({ check: "actual full-request overflow triggered bounded reduction", status: accounting && accounting.fullExtractionTokens > accounting.extractionInputLimit && result.observations.omissions.length > 0 ? "PROVEN" : "UNPROVEN", observed: { accounting, omissions: result.observations.omissions, middleVisibleBefore: visible, middleVisibleExtraction: extracted } });
                }
              } else report.prerequisites.push({ check: "normal rollover used full extraction", status: result.observations.omissions.length === 0 ? "PROVEN" : "UNPROVEN" });
              if (steerTurn) {
                const frozen = frozenContext();
                const absent = frozen.length > 0 && frozen.every(c => !JSON.stringify(c.context).includes(steerTurn.text));
                report.prerequisites.push({ check: "public frozen extraction overlapped one accepted steer", status: overlap && steered ? "PROVEN" : "UNPROVEN", observed: { overlap, steered, frozenRequests: frozen.length, compactingAck: overlap } });
                report.prerequisites.push({ check: "corrective D absent from frozen extraction", status: overlap && absent ? "PROVEN" : overlap && frozen.length > 0 ? "DISPROVEN" : "UNPROVEN", observed: { frozenRequests: frozen.length, absent } });
              }
            }
          }
        } else if (control.action === "pause_resume_same_session") {
          requireValue(report.prerequisites.every(p => p.status === "PROVEN"), "PREREQUISITE", "Required source placement/capacity was not established; no retries or observer hints are injected");
          const sessionFile = session.sessionFile; requireValue(sessionFile, "PERSISTENCE", "Pause requires persistent session");
          const saved = SessionManager.open(sessionFile, join(caseRoot, "sessions"));
          const next: Checkpoint = {
            pid: report.pid, sessionFile, sessionId: saved.getSessionId(), leafId: saved.getLeafId(),
            nextTurn: index + 1, turnEntries: turns, rebuilt: saved.buildContextEntries(),
            prerequisites: report.prerequisites, nuncConfig: effectiveConfig, runConfig, requests: report.requests,
            actions: report.actions.slice(), lastBeforeActive: lastBeforeActive.slice(),
            ...(report.rollovers ? { rollovers: report.rollovers.slice() } : {})
          };
          await writeFile(checkpointPath, JSON.stringify(next), { mode: 0o600, flag: "wx" });
          report.sessionFile = sessionFile; report.status = "PAUSED"; return report;
        }
      }
      // Do not spend more calls on a setup that cannot establish the requested observation.
      requireValue(report.prerequisites.every(p => p.status === "PROVEN"), "PREREQUISITE", "Required source placement/capacity was not established; no retries or observer hints are injected");
    }
    for (const id of scheduledSteers) {
      const text = scenario.turns.find(t => t.id === id)?.text;
      if (text && deliveredUserIds(sm.getBranch(), text).length === 0) report.prerequisites.push({ check: "corrective D delivered verbatim once after freeze without a serial prompt", status: "UNPROVEN", reason: "Accepted steer was never delivered by native continuation" });
    }
    if (selection.id === "e2") {
      report.setupChecks = evaluateE2SetupChecks(turns, sm.getBranch(), sm.buildContextEntries(), report.maintenance as MaintenanceResult[], report.contexts, report.actions, join(caseRoot, "task"), scenario.files["probe.json"]);
    }
    report.score = await scoreArtifacts(join(caseRoot, "task"), observer, report.prerequisites, { actions: report.actions, requireVerificationReceipt: true });
    captureComparisonFacts(report, runtime, selection, group, firstModel, lastBeforeActive);
    report.status = report.prerequisites.every(p => p.status === "PROVEN") &&
      !report.score.checks.some(c => c.status === "DISPROVEN") &&
      !report.score.actionReview.some(r => r.status === "DISPROVEN") &&
      !report.setupChecks?.some(r => r.status === "DISPROVEN") ? "OBSERVED" : "UNPROVEN";
  } catch (error) {
    report.status = "UNPROVEN";
    report.reason = error instanceof RunnerError ? error.code : signal.aborted ? "CANCELLED" : "HOST_ERROR";
    if (error instanceof RunnerError) report.diagnostic = error.message;
  }
  finally {
    if (runtime) {
      report.commands = runtime.commands.slice();
      if (runtime.session.sessionFile) report.sessionFile = runtime.session.sessionFile;
      if (!report.comparisonFacts) {
        captureComparisonFacts(report, runtime, selection, group, firstModel, lastBeforeActive);
      }
      try { await closeHost(runtime); } catch { report.status = "STOPPED"; report.reason = "CLEANUP"; }
    } else if (!report.comparisonFacts) {
      captureComparisonFacts(report, undefined, selection, group, firstModel, lastBeforeActive);
    }
    const endLedger = readLedger(join(input.target.stateRoot, "calls.jsonl"));
    const segmentReserves = endLedger.filter((r): r is CallRecord => r.kind === "reserve" && !startReserveIds.has(r.id));
    const segmentReserveIds = new Set(segmentReserves.map(r => r.id));
    const segmentTerminals = endLedger.filter((r): r is CallEnd => r.kind === "terminal" && segmentReserveIds.has(r.id));
    const usage = ledgerSummary(endLedger.filter(r => segmentReserveIds.has(r.id)));
    report.callIds = [...segmentReserveIds];
    report.segmentUsage = { calls: usage.calls, tokens: usage.totalTokens,
      latencyMs: segmentTerminals.reduce((sum, r) => sum + r.latencyMs, 0), costUsd: usage.costUsd };
    process.removeListener("SIGTERM", onSignal); process.removeListener("SIGINT", onSignal);
    await mkdir(caseRoot, { recursive: true });
    await writeFile(join(caseRoot, job.resume ? "resumed-observation.json" : "observation.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  return report;
}
/** Private subprocess protocol revalidates the target, quotas and supervisor's execution binding. */
export async function workerMain(value: unknown, repository: string): Promise<SegmentReport> {
  requireValue(object(value), "INPUT", "Invalid worker job");
  const input = parseInput(value.input, (value.input as { mode?: unknown })?.mode === "native");
  requireValue(Number.isSafeInteger(value.scenarioIndex) && Number(value.scenarioIndex) >= 0 && Number(value.scenarioIndex) < input.scenarios.length && typeof value.deadline === "number" && value.deadline > Date.now() && typeof value.resume === "boolean", "INPUT", "Invalid worker segment");
  await preflight(input, repository, true);
  requireValue(value.deadline <= Date.now() + input.limits.maxDurationMs, "TIME_LIMIT", "Worker deadline exceeds the task bound");
  const owner: unknown = JSON.parse(await readFile(join(input.target.stateRoot, "owner.json"), "utf8"));
  requireValue(object(owner) && canonical(owner.receipt) === canonical(input.receipt) && owner.deadline === value.deadline, "RECEIPT", "Worker is not bound to the supervisor's new isolated run");
  return runSegment({
    input,
    scenarioIndex: Number(value.scenarioIndex),
    deadline: value.deadline,
    resume: value.resume,
    group: typeof (value as { group?: unknown }).group === "string" ? (value as { group: ComparisonGroup }).group : undefined,
    mode: typeof (value as { mode?: unknown }).mode === "string" ? (value as { mode: ComparisonMode }).mode : undefined,
    caseRoot: typeof (value as { caseRoot?: unknown }).caseRoot === "string" ? (value as { caseRoot: string }).caseRoot : undefined,
    matchReferences: Array.isArray(value.matchReferences) ? value.matchReferences as MatchReference[] : undefined,
  });
}
