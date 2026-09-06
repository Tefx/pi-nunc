import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { closeHost, openHost, type NativeHost } from "./host.js";
import { canonical, object, parseInput, preflight, requireValue, RunnerError, selectedModels, type RunInput } from "./contract.js";
import { checkFullExtraction, checkRollover, loadScenario, maintenanceResult, scoreArtifacts, seedScenario, type CheckResult } from "./scenarios.js";
import { ledgerSummary, readLedger } from "./budget.js";
import { loadPolicy } from "../engine/index.js";
import { engineConfig, eligibleStarts, project, type NuncConfig } from "../pi/index.js";
import { calibrateRetention, type RetentionCalibration } from "./calibration.js";

export interface WorkerJob { input: RunInput; scenarioIndex: number; deadline: number; resume: boolean }
interface Checkpoint { pid: number; sessionFile: string; sessionId: string; leafId: string | null; nextTurn: number; turnEntries: Record<string, string[]>; rebuilt: SessionEntry[]; prerequisites: CheckResult[]; nuncConfig: NuncConfig }
export interface SegmentReport { pid: number; scenario: string; status: "PAUSED" | "OBSERVED" | "UNPROVEN" | "STOPPED"; reason?: string; prerequisites: CheckResult[]; sessionFile?: string; nextTurn: number; score?: Awaited<ReturnType<typeof scoreArtifacts>>; contexts: Array<{ turn: string; model: string; kind: string; context: Context }>; maintenance: unknown[]; actions: unknown[]; calibrations: Array<RetentionCalibration & { effectiveConfig: NuncConfig }>; preparationFailure?: { afterTurn: string; message: string } }
export async function runSegment(job: WorkerJob, overrides: { controlledModels?: unknown; models?: Model<Api>[]; signal?: AbortSignal } = {}): Promise<SegmentReport> {
  const { input } = job, selection = input.scenarios[job.scenarioIndex];
  requireValue(selection, "SCENARIO", "Invalid worker selection");
  const caseRoot = join(input.target.stateRoot, `${selection.id}${selection.variant ? `-${selection.variant}` : ""}`);
  const checkpointPath = join(caseRoot, "checkpoint.json");
  const { input: scenario, observer } = await loadScenario(input.target.repository, selection);
  const local = new AbortController();
  const signal = AbortSignal.any([local.signal, AbortSignal.timeout(Math.max(1, job.deadline - Date.now())), ...(overrides.signal ? [overrides.signal] : [])]);
  const onSignal = () => local.abort(); process.once("SIGTERM", onSignal); process.once("SIGINT", onSignal);
  const report: SegmentReport = { pid: process.pid, scenario: selection.id, status: "STOPPED", prerequisites: [], nextTurn: 0, contexts: [], maintenance: [], actions: [], calibrations: [] };
  let runtime: NativeHost | undefined, turn = "startup", turns: Record<string, string[]> = {};
  let checkpoint: Checkpoint | undefined;
  let effectiveConfig = structuredClone(selection.config.nunc);
  try {
    if (job.resume) {
      checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as Checkpoint;
      requireValue(selection.id === "c3" && checkpoint.nextTurn > 0, "RESTART", "Resume must use a new host process and existing checkpoint");
      turns = checkpoint.turnEntries; report.nextTurn = checkpoint.nextTurn; report.prerequisites = checkpoint.prerequisites;
      effectiveConfig = checkpoint.nuncConfig;
    } else { await mkdir(caseRoot, { recursive: false }); await seedScenario(scenario, join(caseRoot, "task")); }
    runtime = await openHost({ repository: input.target.repository, input, selection: { ...selection, config: { ...selection.config, nunc: effectiveConfig } }, caseRoot, modelTargets: overrides.models ?? selectedModels(input), deadline: job.deadline, signal,
      ...(checkpoint ? { sessionFile: checkpoint.sessionFile } : {}), ...(overrides.controlledModels ? { controlledModels: overrides.controlledModels } : {}),
      onMaintenance: event => { const result = maintenanceResult(event); report.maintenance.push(result ? JSON.parse(JSON.stringify(result)) : { invalidEvent: true }); },
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
      const beforeIds = new Set(sm.getBranch().map(e => e.id));
      await session.prompt(inputTurn.text, { expandPromptTemplates: false });
      turns[turn] = sm.getBranch().filter(e => e.type === "message" && !beforeIds.has(e.id)).map(e => e.id);
      report.nextTurn = index + 1;
      const last = session.messages.findLast(m => m.role === "assistant");
      requireValue(last?.role === "assistant" && last.stopReason === "stop", "MAIN_RESPONSE", "Main run did not end in a complete stop state");
      requireValue(ledgerSummary(readLedger(join(input.target.stateRoot, "calls.jsonl"))).unreconciledCallIds.length === 0, "RECONCILIATION", "A request is still unresolved");
      if ((selection.id === "c3" || selection.id === "c5") && turn === "a") {
        for (const [path, content] of Object.entries(scenario.files)) {
          const visible = sm.buildContextEntries().some(e => e.type === "message" && e.message.role === "toolResult" && !e.message.isError && e.message.content.some(b => b.type === "text" && b.text.includes(content.trim())));
          report.prerequisites.push({ check: `required ${path} observation actually visible`, status: visible ? "PROVEN" : "UNPROVEN" });
        }
      }
      if (selection.id === "c1" && turn === "b") {
        const probe = scenario.files["probe.json"]?.trim();
        const visible = sm.buildContextEntries().some(e => e.type === "message" && e.message.role === "toolResult" && !e.message.isError && e.message.content.some(b => b.type === "text" && Boolean(probe) && b.text.includes(probe!)));
        report.prerequisites.push({ check: "complete probe result actually visible before rollover", status: visible ? "PROVEN" : "UNPROVEN" });
      }
      for (const control of observer.controls.filter(c => c.afterTurn === turn)) {
        if (control.action === "switch_to_authorized_smaller_model") {
          const models = overrides.models ?? selectedModels(input), next = models[1];
          requireValue(next && session.model && next.contextWindow < session.model.contextWindow, "MODEL", "No authorized smaller target");
          const before = session.model;
          await session.setModel(next, { persist: false });
          report.prerequisites.push({ check: "public session model switch recorded distinct smaller real catalog target", status: session.model?.id === next.id && sm.getBranch().some(e => e.type === "model_change" && e.provider === next.provider && e.modelId === next.id) ? "PROVEN" : "UNPROVEN", observed: { from: { provider: before.provider, id: before.id, capacity: before.contextWindow }, to: { provider: next.provider, id: next.id, capacity: next.contextWindow }, controlledProvider: Boolean(overrides.controlledModels) } });
        } else if (control.action === "rollover") {
          const beforeActive = structuredClone(sm.buildContextEntries());
          const before = structuredClone(sm.getBranch()), previousSnapshots = before.filter(e => e.type === "compaction"), eventCount = report.maintenance.length;
          if (selection.config.retentionCalibration) {
            try {
              requireValue(session.model, "CALIBRATION", "No current model for retention calibration");
              const projected = project(beforeActive), state = runtime.fixed;
              const config = engineConfig(effectiveConfig, session.model, selection.config.compaction);
              const policy = await loadPolicy({ ...effectiveConfig, configFile: join(caseRoot, "nunc-config.json") });
              const calibration = calibrateRetention({
                binding: { sessionId: sm.getSessionId(), leafId: sm.getLeafId() ?? "", generation: "observer-only-calibration" }, model: session.model,
                fixed: { systemPrompt: state.systemPrompt, tools: state.tools.map(({ name, description, parameters }) => ({ name, description, parameters })) },
                memory: projected.memory, active: projected.active, eligibleKeptEntryIds: eligibleStarts(before, projected.active, projected.latestId), config, policy, signal,
              }, control, turns, scenario.turns.map(t => t.id), selection.config.retentionCalibration);
              effectiveConfig = { ...effectiveConfig, rolling: { ...effectiveConfig.rolling, keepRecentFraction: calibration.selectedFraction } };
              await writeFile(join(caseRoot, "nunc-config.json"), JSON.stringify(effectiveConfig), { mode: 0o600 });
              report.calibrations.push({ ...calibration, effectiveConfig: structuredClone(effectiveConfig) });
            } catch (error) {
              report.preparationFailure = { afterTurn: turn, message: error instanceof Error ? error.message : "Retention preparation failed" };
              report.prerequisites.push({ check: "authorized retention calibration before maintenance", status: "UNPROVEN", reason: report.preparationFailure.message });
              throw new RunnerError("CALIBRATION", report.preparationFailure.message);
            }
          }
          let failed = false;
          try { await session.compact(); } catch { failed = true; }
          const result = maintenanceResult(report.maintenance.at(-1));
          const file = session.sessionFile; requireValue(file, "PERSISTENCE", "No persistent session file");
          const saved = SessionManager.open(file, join(caseRoot, "sessions"));
          const after = saved.getBranch();
          if (failed || !result?.ok || report.maintenance.length <= eventCount) {
            const unchanged = isDeepStrictEqual(after.filter(e => e.type === "compaction"), previousSnapshots);
            report.prerequisites.push({ check: "failed maintenance preserved prior saved memory/boundary", status: unchanged ? "PROVEN" : "DISPROVEN" });
            report.prerequisites.push({ check: "successful required persisted rollover", status: "UNPROVEN", reason: result && !result.ok ? `${result.code}: ${result.message}` : "Pi hook did not produce a successful Nunc snapshot" });
            if (selection.variant === "capacity") report.prerequisites.push({ check: "full extraction demonstrably exceeds effective input capacity", status: result?.observations.accounting && result.observations.accounting.fullExtractionTokens > result.observations.accounting.extractionInputLimit ? "PROVEN" : "UNPROVEN", observed: result?.observations.accounting ?? null });
            throw new RunnerError("MAINTENANCE", "No successful rollover; continuation remains unproven");
          }
          report.prerequisites.push(...checkRollover(before, after, saved, result, control, turns));
          if (selection.config.retentionCalibration) report.prerequisites.push({ check: "Nunc/Pi independently selected and persisted calibrated boundary", status: result.candidate.firstKeptEntryId === report.calibrations.at(-1)?.firstKeptEntryId ? "PROVEN" : "UNPROVEN" });
          if (result.observations.omissions.length === 0) report.prerequisites.push(checkFullExtraction(beforeActive, report.contexts.findLast(c => c.turn === turn && c.kind === "maintenance")?.context));
          if (selection.id === "c4") {
            const exception = scenario.generatedFiles?.[0]?.segments.find(s => s.repeat === 1)?.text.trim();
            const visible = before.some(e => e.type === "message" && e.message.role === "toolResult" && !e.message.isError && e.message.content.some(b => b.type === "text" && Boolean(exception) && b.text.includes(exception!)));
            const requests = report.contexts.filter(c => c.turn === turn && c.kind === "maintenance");
            const extracted = Boolean(exception) && requests.some(r => JSON.stringify(r.context).includes(exception!));
            if (selection.variant === "full") {
              report.prerequisites.push({ check: "middle exception visible in actual Pi tool projection and full maintenance request", status: visible && extracted && result.observations.omissions.length === 0 ? "PROVEN" : "UNPROVEN" });
            } else {
              const accounting = result.observations.accounting;
              report.prerequisites.push({ check: "actual full-request overflow triggered bounded reduction", status: accounting && accounting.fullExtractionTokens > accounting.extractionInputLimit && result.observations.omissions.length > 0 ? "PROVEN" : "UNPROVEN", observed: { accounting, omissions: result.observations.omissions, middleVisibleBefore: visible, middleVisibleExtraction: extracted } });
            }
          } else report.prerequisites.push({ check: "normal rollover used full extraction", status: result.observations.omissions.length === 0 ? "PROVEN" : "UNPROVEN" });
        } else if (control.action === "pause_resume_same_session") {
          const sessionFile = session.sessionFile; requireValue(sessionFile, "PERSISTENCE", "Pause requires persistent session");
          const saved = SessionManager.open(sessionFile, join(caseRoot, "sessions"));
          const next: Checkpoint = { pid: report.pid, sessionFile, sessionId: saved.getSessionId(), leafId: saved.getLeafId(), nextTurn: index + 1, turnEntries: turns, rebuilt: saved.buildContextEntries(), prerequisites: report.prerequisites, nuncConfig: effectiveConfig };
          await writeFile(checkpointPath, JSON.stringify(next), { mode: 0o600, flag: "wx" });
          report.sessionFile = sessionFile; report.status = "PAUSED"; return report;
        }
      }
      // Do not spend more calls on a setup that cannot establish the requested observation.
      requireValue(report.prerequisites.every(p => p.status === "PROVEN"), "PREREQUISITE", "Required source placement/capacity was not established; no retries or observer hints are injected");
    }
    report.score = await scoreArtifacts(join(caseRoot, "task"), observer, report.prerequisites);
    report.status = report.prerequisites.every(p => p.status === "PROVEN") && !report.score.checks.some(c => c.status === "DISPROVEN") ? "OBSERVED" : "UNPROVEN";
  } catch (error) { report.status = "UNPROVEN"; report.reason = error instanceof RunnerError ? error.code : signal.aborted ? "CANCELLED" : "HOST_ERROR"; }
  finally {
    if (runtime) { if (runtime.session.sessionFile) report.sessionFile = runtime.session.sessionFile; try { await closeHost(runtime); } catch { report.status = "STOPPED"; report.reason = "CLEANUP"; } }
    process.removeListener("SIGTERM", onSignal); process.removeListener("SIGINT", onSignal);
    await mkdir(caseRoot, { recursive: true });
    await writeFile(join(caseRoot, job.resume ? "resumed-observation.json" : "observation.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  return report;
}
/** Private subprocess protocol revalidates the target, quotas and supervisor's execution binding. */
export async function workerMain(value: unknown, repository: string): Promise<SegmentReport> {
  requireValue(object(value), "INPUT", "Invalid worker job");
  const input = parseInput(value.input, true);
  requireValue(Number.isSafeInteger(value.scenarioIndex) && Number(value.scenarioIndex) >= 0 && Number(value.scenarioIndex) < input.scenarios.length && typeof value.deadline === "number" && value.deadline > Date.now() && typeof value.resume === "boolean", "INPUT", "Invalid worker segment");
  await preflight(input, repository, true);
  requireValue(value.deadline <= Date.now() + input.limits.maxDurationMs, "TIME_LIMIT", "Worker deadline exceeds the task bound");
  const owner: unknown = JSON.parse(await readFile(join(input.target.stateRoot, "owner.json"), "utf8"));
  requireValue(object(owner) && canonical(owner.receipt) === canonical(input.receipt) && owner.deadline === value.deadline, "RECEIPT", "Worker is not bound to the supervisor's new isolated run");
  return runSegment({ input, scenarioIndex: Number(value.scenarioIndex), deadline: value.deadline, resume: value.resume });
}
