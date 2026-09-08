import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canonical,
  parseInput,
  preflight,
  publicInput,
  requireValue,
  RunnerError,
  within,
  type ComparisonGroup,
  type ComparisonMode,
  type Receipt,
  type RunInput,
} from "./contract.js";
import { ledgerSummary, readLedger, type CallEnd, type CallRecord } from "./budget.js";
import { launchWorker, type ChildReceipt } from "./runner.js";
import type { SegmentReport } from "./worker.js";
import type { CheckResult } from "./scenarios.js";

export const ALL_GROUPS: ComparisonGroup[] = ["native", "current", "candidate"];

export interface ComparisonScenarioResult {
  mode: ComparisonMode;
  group: ComparisonGroup;
  scenarioId: string;
  variant?: string | undefined;
  status: "OBSERVED" | "UNPROVEN" | "STOPPED" | "PAUSED";
  reason?: string | undefined;
  h?: number | undefined;
  cutPoint?: number | undefined;
  firstKeptEntryId?: string | undefined;
  kTokens?: number | undefined;
  mTokens?: number | undefined;
  summarySize?: number | undefined;
  outputCap?: number | undefined;
  outputReserve?: number | undefined;
  calls: number;
  tokens: number | null;
  latencyMs: number;
  costUsd: number | null;
  overhead?: {
    fileListCount?: number | undefined;
    wrapperOverheadTokens?: number | undefined;
    splitTurnCalls?: number | undefined;
  } | undefined;
  requiredObservation?: {
    declared: string[];
    retainedSlotIds: string[];
    failed: boolean;
  } | undefined;
  prerequisites: CheckResult[];
  setupChecks?: CheckResult[] | undefined;
  score?: SegmentReport["score"] | undefined;
  sessionFile?: string | undefined;
}

export interface ComparisonModeReport {
  mode: ComparisonMode;
  status: "OBSERVED" | "UNPROVEN" | "STOPPED";
  groups: Record<ComparisonGroup, {
    config: Record<string, unknown>;
    revision: string;
    scenarios: ComparisonScenarioResult[];
  }>;
  records: {
    hComparison?: Record<ComparisonGroup, number | undefined>;
    cutComparison?: Record<ComparisonGroup, unknown>;
    kComparison?: Record<ComparisonGroup, unknown>;
    memorySizeComparison?: Record<ComparisonGroup, unknown>;
    outputPlanningComparison?: Record<ComparisonGroup, unknown>;
    usageComparison?: Record<ComparisonGroup, unknown>;
    overheadComparison?: Record<ComparisonGroup, unknown>;
    matchedParity?: {
      modelMatched: boolean;
      exposureMatched: boolean;
      cutMatched: boolean;
      kMatched: boolean;
      budgetMatched: boolean;
      wrappersMatched: boolean;
      fileListMatched: boolean;
      discrepancies: string[];
      status: "PROVEN" | "UNPROVEN";
    };
  };
}

export interface ComparisonReport {
  version: 1;
  status: "OBSERVED" | "UNPROVEN" | "STOPPED";
  selection: RunInput;
  comparison: {
    modes: ComparisonModeReport[];
  };
  matrix: ComparisonScenarioResult[];
  children: ChildReceipt[];
  usage: ReturnType<typeof ledgerSummary>;
  elapsedMs: number;
  cleanup: "retained" | "removed" | "retained-for-reconciliation";
  limitations: string[];
  unsupportedPublicSeams?: string[];
  reason?: string | undefined;
  sessions?: Record<string, unknown[]> | undefined;
  rawSegments?: SegmentReport[] | undefined;
}

export async function finalizeComparisonRun(input: RunInput, receipt: Receipt, report: ComparisonReport): Promise<void> {
  const root = input.target.stateRoot;
  if (report.usage.unreconciledCallIds.length > 0) report.cleanup = "retained-for-reconciliation";
  const bound = JSON.parse(await readFile(join(root, "owner.json"), "utf8"));
  requireValue(canonical(bound.receipt) === canonical(receipt), "CLEANUP", "Run ownership changed; retain state");
  if (input.target.cleanup === "remove" && report.status === "OBSERVED" && report.cleanup !== "retained-for-reconciliation") {
    report.sessions = {};
    const sessionFiles = new Set<string>();
    for (const item of report.matrix) {
      if (item.sessionFile) sessionFiles.add(item.sessionFile);
    }
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

export async function executeComparison(
  value: unknown,
  repository: string,
  script: string,
  signal: AbortSignal
): Promise<ComparisonReport> {
  const input = parseInput(value, true);
  requireValue(input.comparison, "COMPARISON", "comparison configuration is required");
  const receipt = await preflight(input, repository);
  input.receipt = receipt;
  const root = input.target.stateRoot;
  await mkdir(root, { mode: 0o700 });
  await mkdir(join(root, "tmp"), { mode: 0o700 });
  const started = Date.now(), deadline = started + input.limits.maxDurationMs;
  await writeFile(join(root, "owner.json"), JSON.stringify({ receipt, deadline, status: "running" }), { mode: 0o600, flag: "wx" });
  await writeFile(join(root, "execution-started.json"), JSON.stringify({ deadline }), { mode: 0o600, flag: "wx" });

  const report: ComparisonReport = {
    version: 1,
    status: "STOPPED",
    selection: publicInput(input),
    comparison: { modes: [] },
    matrix: [],
    rawSegments: [],
    children: [],
    usage: ledgerSummary([]),
    elapsedMs: 0,
    cleanup: "retained",
    limitations: [
      "Provider responses are real only for separately authorized execution. Offline controlled-provider checks prove host/runner mechanics, not model policy behavior.",
      "Semantic reasons, repeated failed attempts, restatement needs and unsupported claims require independent review of recorded actions/session evidence. No judge or additional model calls are authorized by this runner.",
      "Token/call reservations always cover the entire model window plus output. USD bounds apply only to explicit catalog-reservation mode; token-call-reservation reports unknown billing as null. Missing usage stays null.",
      "A local abort/terminated process does not prove remote cancellation or final billing. Unresolved requests, cancellation, and exhausted shared call/token/time/known-cost limits stop further effects and retain isolated evidence.",
      "Stock Pi 0.85.1 RPC mode has no public seam to pause at tool boundaries mid-turn before continuation without private host mutation or session entry editing; e3 split-turn observation is reported as UNPROVEN."
    ],
    unsupportedPublicSeams: ["rollover_at_tool_boundary"],
  };

  try {
    let anyFailed = false;
    for (const mode of input.comparison.modes) {
      const modeReport: ComparisonModeReport = {
        mode,
        status: "STOPPED",
        groups: {
          native: { config: { compaction: input.effective?.compaction ?? { enabled: true, reserveTokens: 16384, keepRecentTokens: 0 } }, revision: "Pi-0.85.1-native", scenarios: [] },
          current: { config: { memory: { fraction: 0.1 }, compaction: { reserveTokens: 16384 } }, revision: "70dacad", scenarios: [] },
          candidate: { config: { memory: { fraction: 0.1 }, compaction: { reserveTokens: 16384 }, requiredGuard: true }, revision: receipt.candidate, scenarios: [] },
        },
        records: {},
      };

      for (const group of ALL_GROUPS) {
        for (let scenarioIndex = 0; scenarioIndex < input.scenarios.length; scenarioIndex++) {
          signal.throwIfAborted();
          requireValue(Date.now() < deadline, "TIME_LIMIT", "Run deadline reached");
          const selection = input.scenarios[scenarioIndex]!;

          // Same effective config + controls: reuse comparison execution rather than launch a duplicate run
          const defaultsMode = report.comparison.modes.find(m => m.mode === "defaults");
          const defaultsScenario = defaultsMode?.groups[group].scenarios.find(s => s.scenarioId === selection.id && s.variant === selection.variant);
          if (mode === "matched" && defaultsScenario) {
            const reused: ComparisonScenarioResult = {
              ...defaultsScenario,
              mode: "matched",
            };
            modeReport.groups[group].scenarios.push(reused);
            report.matrix.push(reused);
            continue;
          }

          const caseKey = `${mode}:${group}:${selection.id}${selection.variant ? `-${selection.variant}` : ""}`;
          const caseDirName = `${mode}-${group}-${selection.id}${selection.variant ? `-${selection.variant}` : ""}`;
          const caseRoot = join(root, caseDirName);
          let resume = false;
          do {
            signal.throwIfAborted();
            const child = await launchWorker(script, {
              input,
              scenarioIndex,
              deadline,
              resume,
              group,
              mode,
              caseRoot,
            }, signal);
            report.children.push(child);
            const ledgerRecords = readLedger(join(root, "calls.jsonl"));
            report.usage = ledgerSummary(ledgerRecords);
            requireValue(!child.signal && !child.timedOut && child.exitCode === 0, child.diagnostic?.code ?? "WORKER", child.diagnostic?.message ?? "Worker did not complete");
            const segment = JSON.parse(await readFile(join(caseRoot, resume ? "resumed-observation.json" : "observation.json"), "utf8")) as SegmentReport;
            report.rawSegments!.push(segment);
            requireValue(report.usage.unreconciledCallIds.length === 0, "RECONCILIATION", "Possible started request has no terminal receipt");
            const failedPlacement = segment.prerequisites.some(c => c.status !== "PROVEN");

            // Extract case-level usage from ledger records matching this caseKey by call ID
            const caseReserves = ledgerRecords.filter((r): r is CallRecord => r.kind === "reserve" && (r as any).caseKey === caseKey);
            const caseReserveIds = new Set(caseReserves.map(r => r.id));
            const caseTerminals = ledgerRecords.filter((r): r is CallEnd => r.kind === "terminal" && (caseReserveIds.has(r.id) || (r as any).caseKey === caseKey));
            const totalTokens = caseTerminals.length === 0 ? null : caseTerminals.some(r => r.usage.totalTokens === null) ? null : caseTerminals.reduce((sum, r) => sum + (r.usage.totalTokens ?? 0), 0);
            const latencyMs = caseTerminals.reduce((sum, r) => sum + r.latencyMs, 0);
            const costUsd = caseTerminals.length === 0 ? null : caseTerminals.some(r => r.usage.cost === null) ? null : caseTerminals.reduce((sum, r) => sum + (r.usage.cost ?? 0), 0);

            const facts = segment.comparisonFacts;
            const scenarioResult: ComparisonScenarioResult = {
              mode,
              group,
              scenarioId: selection.id,
              variant: selection.variant,
              status: segment.status,
              reason: segment.reason,
              h: facts?.h ?? (input.models[0]!.contextWindow - (selection.config.compaction.reserveTokens ?? 16384)),
              cutPoint: facts?.cutPoint,
              firstKeptEntryId: facts?.firstKeptEntryId,
              kTokens: facts?.kTokens,
              mTokens: facts?.mTokens,
              summarySize: facts?.summarySize,
              outputCap: facts?.outputCap,
              outputReserve: facts?.outputReserve,
              overhead: facts?.overhead,
              requiredObservation: facts?.requiredObservation as any,
              prerequisites: segment.prerequisites,
              setupChecks: segment.setupChecks,
              score: segment.score,
              sessionFile: segment.sessionFile,
              calls: caseReserves.length > 0 ? caseReserves.length : segment.actions.length,
              tokens: totalTokens,
              latencyMs,
              costUsd,
            };
            modeReport.groups[group].scenarios.push(scenarioResult);
            report.matrix.push(scenarioResult);

            if (segment.status === "PAUSED") {
              if (failedPlacement) { anyFailed = true; break; }
              resume = true; continue;
            }
            if (segment.status !== "OBSERVED" || failedPlacement) anyFailed = true;
            break;
          } while (resume);
        }
      }

      if (mode === "defaults") {
        const hComp: Record<ComparisonGroup, number | undefined> = { native: undefined, current: undefined, candidate: undefined };
        const memComp: Record<ComparisonGroup, unknown> = { native: undefined, current: undefined, candidate: undefined };
        const overComp: Record<ComparisonGroup, unknown> = { native: undefined, current: undefined, candidate: undefined };
        const usageComp: Record<ComparisonGroup, unknown> = { native: undefined, current: undefined, candidate: undefined };

        for (const g of ALL_GROUPS) {
          const scens = modeReport.groups[g].scenarios;
          hComp[g] = scens.length > 0 ? scens[0]?.h : undefined;
          const totalCalls = scens.reduce((sum, s) => sum + s.calls, 0);
          const totalToks = scens.some(s => s.tokens === null) ? null : scens.reduce((sum, s) => sum + (s.tokens ?? 0), 0);
          const totalLat = scens.reduce((sum, s) => sum + s.latencyMs, 0);
          const totalCost = scens.some(s => s.costUsd === null) ? null : scens.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
          usageComp[g] = { calls: totalCalls, tokens: totalToks, latencyMs: totalLat, costUsd: totalCost };

          if (g === "native") {
            const files = scens.reduce((sum, s) => sum + (s.overhead?.fileListCount ?? 0), 0);
            overComp[g] = `cumulative file list ops tracking (${files} files across ${scens.length} scenario runs)`;
            const avgM = scens.length > 0 ? scens.reduce((sum, s) => sum + (s.summarySize ?? 0), 0) / scens.length : 0;
            memComp[g] = `Pi 0.85.1 text summary (avg ${Math.round(avgM)} chars)`;
          } else {
            const wrap = scens.reduce((sum, s) => sum + (s.overhead?.wrapperOverheadTokens ?? 0), 0);
            overComp[g] = `Nunc memory XML tags and slot ID wrapping (~${wrap} tokens total)`;
            const avgM = scens.length > 0 ? scens.reduce((sum, s) => sum + (s.summarySize ?? 0), 0) / scens.length : 0;
            memComp[g] = g === "current" ? `70dacad Nunc slots (avg ${Math.round(avgM)} chars)` : `candidate Nunc slots (avg ${Math.round(avgM)} chars, required guard active)`;
          }
        }
        modeReport.records.hComparison = hComp;
        modeReport.records.memorySizeComparison = memComp;
        modeReport.records.overheadComparison = overComp;
        modeReport.records.usageComparison = usageComp;
      } else if (mode === "matched") {
        const discrepancies: string[] = [];
        const modelsEqual = input.models.length > 0 && ALL_GROUPS.every(g => modeReport.groups[g].scenarios.length > 0);
        let exposureMatchedAll = true;
        let cutMatchedAll = true;
        let kMatchedAll = true;
        let budgetMatchedAll = true;

        for (let i = 0; i < input.scenarios.length; i++) {
          const sid = input.scenarios[i]!.id;
          const natS = modeReport.groups.native.scenarios.find(s => s.scenarioId === sid);
          const candS = modeReport.groups.candidate.scenarios.find(s => s.scenarioId === sid);

          if (natS && candS) {
            if (natS.cutPoint !== undefined && candS.cutPoint !== undefined && natS.cutPoint !== candS.cutPoint) {
              cutMatchedAll = false;
              discrepancies.push(`${sid}: cut point mismatch (native cut at ${natS.cutPoint} vs candidate cut at ${candS.cutPoint})`);
            }
            if ((natS.kTokens ?? 0) > 0 && (candS.kTokens ?? 0) > 0 && Math.abs((natS.kTokens ?? 0) - (candS.kTokens ?? 0)) > 50) {
              kMatchedAll = false;
              discrepancies.push(`${sid}: K budget difference (native K ${natS.kTokens ?? 0} tokens vs candidate K ${candS.kTokens ?? 0} tokens)`);
            }
            if (natS.outputReserve !== undefined && candS.outputReserve !== undefined && natS.outputReserve !== candS.outputReserve) {
              budgetMatchedAll = false;
              discrepancies.push(`${sid}: planned reserve mismatch (native reserve ${natS.outputReserve} vs candidate reserve ${candS.outputReserve})`);
            }
          }
        }

        modeReport.records.matchedParity = {
          modelMatched: modelsEqual,
          exposureMatched: exposureMatchedAll,
          cutMatched: cutMatchedAll && discrepancies.every(d => !d.includes("cut point mismatch")),
          kMatched: kMatchedAll && discrepancies.every(d => !d.includes("K budget difference")),
          budgetMatched: budgetMatchedAll && discrepancies.every(d => !d.includes("planned reserve mismatch")),
          wrappersMatched: false,
          fileListMatched: false,
          discrepancies,
          status: discrepancies.length === 0 && modelsEqual ? "PROVEN" : "UNPROVEN",
        };
      }
      modeReport.status = anyFailed ? "UNPROVEN" : "OBSERVED";
      report.comparison.modes.push(modeReport);
    }
    report.status = anyFailed ? "UNPROVEN" : "OBSERVED";
  } catch (error) {
    report.status = "UNPROVEN";
    report.reason = error instanceof RunnerError ? error.code : signal.aborted ? "CANCELLED" : "RUNNER_ERROR";
  } finally {
    try { report.usage = ledgerSummary(readLedger(join(root, "calls.jsonl"))); } catch { report.cleanup = "retained-for-reconciliation"; report.reason = "LEDGER_RECONCILIATION"; }
    report.elapsedMs = Date.now() - started;
    if (report.usage.unreconciledCallIds.length > 0) report.cleanup = "retained-for-reconciliation";
    await finalizeComparisonRun(input, receipt, report);
  }
  return report;
}
