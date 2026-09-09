import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonical, parseInput, preflight, publicInput, requireValue, RunnerError, within, type ComparisonGroup, type ComparisonMode, type Receipt, type RunInput } from "./contract.js";
import { ledgerSummary, readLedger, type LedgerRecord } from "./budget.js";
import { launchWorker, type ChildReceipt } from "./runner.js";
import type { SegmentReport } from "./worker.js";
import { matchedParity, rolloverFacts, type RolloverFacts, type RolloverObservation, type RequestObservation } from "./comparison-observation.js";
import type { MatchReference } from "./preparation.js";
import { elapsedInterval, type WallClockInterval } from "./timing.js";

export const ALL_GROUPS: ComparisonGroup[] = ["native", "current", "candidate"];
export interface ComparisonScenarioResult {
  mode: ComparisonMode; group: ComparisonGroup; scenarioId: string; variant?: string | undefined;
  status: SegmentReport["status"]; reason?: string | undefined; sessionFile?: string | undefined;
  prerequisites: SegmentReport["prerequisites"]; setupChecks?: SegmentReport["setupChecks"]; score?: SegmentReport["score"];
  ordinaryScore?: SegmentReport["ordinaryScore"]; noWork?: SegmentReport["noWork"]; rolloverQuality?: SegmentReport["rolloverQuality"];
  calls: number; tokens: number | null; latencyMs: number; costUsd: number | null; callIds: number[];
  rollovers: RolloverFacts[];
  timing?: WallClockInterval | undefined;
}
export interface ComparisonModeReport {
  mode: ComparisonMode; status: "OBSERVED" | "UNPROVEN" | "STOPPED";
  timing?: WallClockInterval;
  groups: Record<ComparisonGroup, { config: Record<string, unknown>; revision: string; scenarios: ComparisonScenarioResult[]; timing?: WallClockInterval;
    caseTimings: Array<{ scenarioId: string; variant?: string | undefined; timing: WallClockInterval; segments: WallClockInterval[] }> }>;
  records: { hComparison?: Record<string, unknown>; memorySizeComparison?: Record<string, unknown>; overheadComparison?: Record<string, unknown>; usageComparison?: Record<string, unknown>; matchedParity?: ReturnType<typeof matchedParity> };
}
export interface ComparisonReport {
  version: 1; status: "OBSERVED" | "UNPROVEN" | "STOPPED"; selection: RunInput;
  comparison: { modes: ComparisonModeReport[] }; matrix: ComparisonScenarioResult[]; children: ChildReceipt[];
  usage: ReturnType<typeof ledgerSummary>; ledger?: LedgerRecord[]; elapsedMs: number;
  cleanup: "retained" | "removed" | "retained-for-reconciliation"; limitations: string[]; reason?: string | undefined;
  sessions?: Record<string, unknown[]> | undefined; rawSegments?: SegmentReport[] | undefined;
}
export async function finalizeComparisonRun(input: RunInput, receipt: Receipt, report: ComparisonReport): Promise<void> {
  const root = input.target.stateRoot;
  if (report.usage.unreconciledCallIds.length > 0) report.cleanup = "retained-for-reconciliation";
  const bound = JSON.parse(await readFile(join(root, "owner.json"), "utf8"));
  requireValue(canonical(bound.receipt) === canonical(receipt), "CLEANUP", "Run ownership changed; retain state");
  if (input.target.cleanup === "remove" && report.status === "OBSERVED" && report.cleanup !== "retained-for-reconciliation") {
    report.sessions = {};
    const sessionFiles = new Set(report.matrix.flatMap(item => item.sessionFile ? [item.sessionFile] : []));
    for (const file of sessionFiles) {
      requireValue(within(file, root), "CLEANUP", "Session evidence is outside owned run");
      const text = await readFile(file, "utf8");
      requireValue(text.endsWith("\n"), "RECONCILIATION", "Incomplete persistent session; retain state");
      report.sessions[file] = text.trim().split("\n").map(line => JSON.parse(line));
    }
    await rm(root, { recursive: true });
    report.cleanup = "removed";
  } else {
    await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    await writeFile(join(root, "owner.json"), JSON.stringify({ ...bound, status: "terminal", result: report.status, reason: report.reason, cleanup: report.cleanup }), { mode: 0o600 });
  }
}
/** Call-ID joining is shared by segment, case and group totals. Missing terminals stay unknown. */
export function scopedUsage(records: LedgerRecord[], ids: Set<number>) {
  const scoped = records.filter(r => ids.has(r.id));
  const summary = ledgerSummary(scoped);
  return { callIds: [...ids], calls: summary.calls, tokens: summary.totalTokens, costUsd: summary.costUsd,
    latencyMs: scoped.filter(r => r.kind === "terminal").reduce((n, r) => n + r.latencyMs, 0) };
}
export function joinedObservations(segments: SegmentReport[]) {
  const rows = new Map<string, RolloverObservation>(), requests = new Map<number, RequestObservation>();
  for (const segment of segments) {
    for (const row of segment.rollovers ?? []) rows.set(row.snapshot?.id ?? `${row.branch.at(-1)?.id}:${row.callIds.join(",")}`, row);
    for (const req of segment.requests ?? []) requests.set(req.callId, req);
  }
  return { rows: [...rows.values()], requests: [...requests.values()] };
}
export async function executeComparison(value: unknown, repository: string, script: string, signal: AbortSignal): Promise<ComparisonReport> {
  const input = parseInput(value, true);
  requireValue(input.comparison, "COMPARISON", "comparison configuration is required");
  const receipt = await preflight(input, repository); input.receipt = receipt;
  const root = input.target.stateRoot;
  await mkdir(root, { mode: 0o700 }); await mkdir(join(root, "tmp"), { mode: 0o700 });
  const started = Date.now(), deadline = started + input.limits.maxDurationMs;
  await writeFile(join(root, "owner.json"), JSON.stringify({ receipt, deadline, status: "running" }), { mode: 0o600, flag: "wx" });
  await writeFile(join(root, "execution-started.json"), JSON.stringify({ deadline }), { mode: 0o600, flag: "wx" });
  const report: ComparisonReport = { version: 1, status: "STOPPED", selection: publicInput(input), comparison: { modes: [] }, matrix: [], rawSegments: [], children: [], usage: ledgerSummary([]), elapsedMs: 0, cleanup: "retained", limitations: [
    "Controlled HTTP responses prove stock-host scheduling, accounting and scorer mechanics only; semantic policy and continuation quality require independent observation.",
    "All setup, maintenance and continuation calls share the finite ledger. Unknown usage/cost remains null; reservations are never refunded.",
    "Matched runs prepare each actual rollover independently. Native summaries have provider output limits but no enforced rendered-memory ceiling after wrapper/file-list append; realized-size matching alone leaves budget parity UNPROVEN.",
    "E3 uses awaited public turn_end, task settings reload and native automatic compaction. Each actual tool batch must satisfy exposure, cut and capacity inequalities before further transport.",
    "Semantic claims, restatements and excluded actions require independent review of retained contexts, actions, artifacts and native sessions. No model judge or repair replay is run.",
  ] };
  try {
    let anyFailed = false;
    for (const mode of input.comparison.modes) {
      const modeStarted = Date.now();
      let modeFailed = false;
      const revisions = { native: "Pi-0.85.1-native", current: "70dacad", candidate: receipt.candidate };
      const groupReport = (group: ComparisonGroup): ComparisonModeReport["groups"][ComparisonGroup] => ({ config: {
        selections: input.scenarios.map(s => ({ id: s.id, variant: s.variant, config: s.config })),
        actualConfiguration: "rawSegments[].rollovers[].preparation.settings / config / result.observations.accounting",
      }, revision: revisions[group], scenarios: [], caseTimings: [] });
      const modeReport: ComparisonModeReport = { mode, status: "STOPPED", groups: { native: groupReport("native"), current: groupReport("current"), candidate: groupReport("candidate") }, records: {} };
      report.comparison.modes.push(modeReport);
      try {
      const completed = new Map<string, SegmentReport[]>();
      const roots = new Map<string, string>();
      for (const group of ALL_GROUPS) {
        const groupStarted = Date.now();
        try {
        for (let scenarioIndex = 0; scenarioIndex < input.scenarios.length; scenarioIndex++) {
        signal.throwIfAborted(); requireValue(Date.now() < deadline, "TIME_LIMIT", "Run deadline reached");
        const selection = input.scenarios[scenarioIndex]!, label = `${selection.id}${selection.variant ? `-${selection.variant}` : ""}`;
        const caseKey = `${mode}:${group}:${label}`, caseRoot = join(root, `${mode}-${group}-${label}`);
        const key = `${group}:${label}`, segments: SegmentReport[] = []; completed.set(key, segments); roots.set(key, join(caseRoot, "task"));
        const caseStarted = Date.now(), segmentIntervals: WallClockInterval[] = [];
        let resume = false;
        try {
        do {
          requireValue(report.usage.calls < input.limits.maxCalls, "CALL_LIMIT", "Shared call ceiling exhausted; no further child/session effects");
          const smallestReservation = Math.min(...input.models.map(m => m.contextWindow + m.maxTokens));
          requireValue(report.usage.reservedTokens + smallestReservation <= input.limits.maxTotalTokens, "TOKEN_LIMIT", "Shared token ceiling cannot reserve another task request");
          if (input.limits.maxCostUsd !== null) requireValue(report.usage.reservedCostUsd !== null && report.usage.reservedCostUsd < input.limits.maxCostUsd, "COST_LIMIT", "Shared known-cost ceiling exhausted");
          const beforeIds = new Set(readLedger(join(root, "calls.jsonl")).filter(r => r.kind === "reserve").map(r => r.id));
          const native = joinedObservations(completed.get(`native:${label}`) ?? []);
          const matchReferences: MatchReference[] = native.rows.map(row => { const f = rolloverFacts(row, native.requests, "native"); return { snapshotId: f.snapshotId ?? "unobserved", mTokens: f.mTokens, outputCaps: f.outputCaps }; });
          const child = await launchWorker(script, { input, scenarioIndex, deadline, resume, group, mode, caseRoot, matchReferences }, signal);
          report.children.push(child);
          if (child.timing) segmentIntervals.push(child.timing);
          const records = readLedger(join(root, "calls.jsonl")); report.usage = ledgerSummary(records);
          requireValue(!child.signal && !child.timedOut && child.exitCode === 0, child.diagnostic?.code ?? "WORKER", child.diagnostic?.message ?? "Worker did not complete");
          const segment = JSON.parse(await readFile(join(caseRoot, resume ? "resumed-observation.json" : "observation.json"), "utf8")) as SegmentReport;
          segments.push(segment); report.rawSegments!.push(segment);
          const ids = new Set(records.filter(r => r.kind === "reserve" && r.caseKey === caseKey && !beforeIds.has(r.id)).map(r => r.id));
          const result: ComparisonScenarioResult = { mode, group, scenarioId: selection.id, variant: selection.variant, status: segment.status, reason: segment.reason,
            prerequisites: segment.prerequisites, setupChecks: segment.setupChecks, score: segment.score, sessionFile: segment.sessionFile,
            ordinaryScore: segment.ordinaryScore, noWork: segment.noWork, rolloverQuality: segment.rolloverQuality,
            timing: child.timing, ...scopedUsage(records, ids), rollovers: (segment.rollovers ?? []).map(row => rolloverFacts(row, segment.requests ?? [], group)) };
          modeReport.groups[group].scenarios.push(result); report.matrix.push(result);
          requireValue(report.usage.unreconciledCallIds.length === 0, "RECONCILIATION", "Possible started request has no terminal receipt");
          const failed = segment.prerequisites.some(c => c.status !== "PROVEN");
          if (segment.status === "PAUSED" && !failed) { resume = true; continue; }
          if (segment.status !== "OBSERVED" || failed) modeFailed = true;
          break;
        } while (resume);
        } finally { modeReport.groups[group].caseTimings.push({ scenarioId: selection.id, variant: selection.variant, timing: elapsedInterval(caseStarted), segments: segmentIntervals }); }
        }
        } finally { modeReport.groups[group].timing = elapsedInterval(groupStarted); }
      }
      const groupRecords = (pick: (facts: RolloverFacts) => unknown) => Object.fromEntries(ALL_GROUPS.map(group => [group, input.scenarios.map(s => {
        const label = `${s.id}${s.variant ? `-${s.variant}` : ""}`, j = joinedObservations(completed.get(`${group}:${label}`) ?? []);
        return { selection: label, rollovers: j.rows.map(row => pick(rolloverFacts(row, j.requests, group))) };
      })]));
      modeReport.records.hComparison = groupRecords(f => f.h);
      modeReport.records.memorySizeComparison = groupRecords(f => ({ realized: f.mTokens, limit: f.memoryLimit, finalContext: f.finalContextTokens, remaining: f.remainingContextTokens }));
      modeReport.records.overheadComparison = groupRecords(f => f.overhead);
      const records = readLedger(join(root, "calls.jsonl"));
      modeReport.records.usageComparison = Object.fromEntries(ALL_GROUPS.map(group => [group, scopedUsage(records, new Set(records.filter(r => r.kind === "reserve" && r.caseKey?.startsWith(`${mode}:${group}:`)).map(r => r.id)))]));
      if (mode === "matched") modeReport.records.matchedParity = matchedParity(input.scenarios.map(s => {
        const label = `${s.id}${s.variant ? `-${s.variant}` : ""}`;
        return { label, groups: ALL_GROUPS.map(group => { const key = `${group}:${label}`, segments = completed.get(key) ?? []; return {
          group, complete: segments.at(-1)?.status === "OBSERVED", cwd: roots.get(key)!, ...joinedObservations(segments),
        }; }) };
      }));
      // Observation completion and parity are independent: measured inequality is a valid observation.
      modeReport.status = modeFailed ? "UNPROVEN" : "OBSERVED";
      anyFailed ||= modeFailed;
      } finally { modeReport.timing = elapsedInterval(modeStarted); }
    }
    report.status = anyFailed ? "UNPROVEN" : "OBSERVED";
  } catch (error) {
    report.status = "UNPROVEN"; report.reason = error instanceof RunnerError ? error.code : signal.aborted ? "CANCELLED" : "RUNNER_ERROR";
  } finally {
    try { report.ledger = readLedger(join(root, "calls.jsonl")); report.usage = ledgerSummary(report.ledger); } catch { report.cleanup = "retained-for-reconciliation"; report.reason = "LEDGER_RECONCILIATION"; }
    report.elapsedMs = Date.now() - started;
    await finalizeComparisonRun(input, receipt, report);
  }
  return report;
}
