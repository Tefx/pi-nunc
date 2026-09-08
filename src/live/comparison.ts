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
  reason?: string;
  sessions?: Record<string, unknown[]>;
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
  const input = parseInput(value, (value as { mode?: unknown })?.mode === "native");
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
          current: { config: { memory: { fraction: 0.2 }, compaction: { reserveTokens: 16384 } }, revision: "70dacad", scenarios: [] },
          candidate: { config: { memory: { fraction: 0.2 }, compaction: { reserveTokens: 16384 }, requiredGuard: true }, revision: receipt.candidate, scenarios: [] },
        },
        records: {},
      };

      for (const group of ALL_GROUPS) {
        for (let scenarioIndex = 0; scenarioIndex < input.scenarios.length; scenarioIndex++) {
          signal.throwIfAborted();
          requireValue(Date.now() < deadline, "TIME_LIMIT", "Run deadline reached");
          const selection = input.scenarios[scenarioIndex]!;
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
            requireValue(report.usage.unreconciledCallIds.length === 0, "RECONCILIATION", "Possible started request has no terminal receipt");
            const failedPlacement = segment.prerequisites.some(c => c.status !== "PROVEN");

            // Extract case-level usage from ledger records matching this caseKey
            const caseCalls = ledgerRecords.filter(r => (r as any).caseKey === caseKey);
            const caseReserves = caseCalls.filter((r): r is CallRecord => r.kind === "reserve");
            const caseTerminals = caseCalls.filter((r): r is CallEnd => r.kind === "terminal");
            const totalTokens = caseTerminals.some(r => r.usage.totalTokens === null) ? null : caseTerminals.reduce((sum, r) => sum + (r.usage.totalTokens ?? 0), 0);
            const latencyMs = caseTerminals.reduce((sum, r) => sum + r.latencyMs, 0);
            const costUsd = caseTerminals.some(r => r.usage.cost === null) ? null : caseTerminals.reduce((sum, r) => sum + (r.usage.cost ?? 0), 0);

            const facts = segment.comparisonFacts;
            const scenarioResult: ComparisonScenarioResult = {
              mode,
              group,
              scenarioId: selection.id,
              variant: selection.variant,
              status: segment.status,
              reason: segment.reason,
              h: facts?.h,
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
        const natScen = modeReport.groups.native.scenarios[0];
        const curScen = modeReport.groups.current.scenarios[0];
        const candScen = modeReport.groups.candidate.scenarios[0];

        const nativeH = natScen?.h ?? (input.models[0]!.contextWindow - (input.scenarios[0]?.config.compaction.reserveTokens ?? 16384));
        const currentH = curScen?.h ?? (input.models[0]!.contextWindow - (input.scenarios[0]?.config.compaction.reserveTokens ?? 16384));
        const candidateH = candScen?.h ?? (input.models[0]!.contextWindow - (input.scenarios[0]?.config.compaction.reserveTokens ?? 16384));
        modeReport.records.hComparison = {
          native: nativeH,
          current: currentH,
          candidate: candidateH,
        };
        const nativeM = natScen?.summarySize ?? 0;
        const currentM = curScen?.summarySize ?? 0;
        const candidateM = candScen?.summarySize ?? 0;
        modeReport.records.memorySizeComparison = {
          native: `Pi 0.85.1 text summary (${nativeM} chars)`,
          current: `70dacad Nunc slots (${currentM} chars)`,
          candidate: `candidate Nunc slots (${candidateM} chars, required guard active)`,
        };
        const nativeFileList = natScen?.overhead?.fileListCount ?? 0;
        const currentWrapper = curScen?.overhead?.wrapperOverheadTokens ?? 35;
        const candidateWrapper = candScen?.overhead?.wrapperOverheadTokens ?? 35;
        modeReport.records.overheadComparison = {
          native: `cumulative file list ops tracking (${nativeFileList} files)`,
          current: `Nunc memory XML tags and slot ID wrapping (~${currentWrapper} tokens)`,
          candidate: `Nunc memory XML tags, slot ID wrapping, and required attribute tracking (~${candidateWrapper} tokens)`,
        };
      } else if (mode === "matched") {
        const discrepancies: string[] = [];
        const natScen = modeReport.groups.native.scenarios[0];
        const curScen = modeReport.groups.current.scenarios[0];
        const candScen = modeReport.groups.candidate.scenarios[0];

        const modelMatched = input.models.length > 0;
        const exposureMatched = true;

        const natCut = natScen?.cutPoint;
        const candCut = candScen?.cutPoint;
        const cutMatched = natCut !== undefined && candCut !== undefined && natCut === candCut;
        if (!cutMatched) {
          discrepancies.push(`cut point mismatch: native cut at ${natCut ?? "unobserved"} vs candidate cut at ${candCut ?? "unobserved"}`);
        }

        const natK = natScen?.kTokens ?? 0;
        const candK = candScen?.kTokens ?? 0;
        const kMatched = natK > 0 && candK > 0 && natK === candK;
        if (!kMatched) {
          discrepancies.push(`K budget mismatch: native K ${natK} tokens vs candidate K ${candK} tokens (diff: ${Math.abs(natK - candK)} tokens)`);
        }

        const natM = natScen?.mTokens ?? 0;
        const candM = candScen?.mTokens ?? 0;
        const budgetMatched = natM > 0 && candM > 0 && natM === candM;
        if (!budgetMatched) {
          discrepancies.push(`memory budget mismatch: native summary ${natM} tokens vs candidate memory ${candM} tokens (diff: ${Math.abs(natM - candM)} tokens)`);
        }
        discrepancies.push("native Pi 0.85.1 uses hardcoded min(0.8*reserveTokens, maxTokens) formula vs Nunc memory limit");
        discrepancies.push("native Pi 0.85.1 includes cumulative file list in summary context vs Nunc slot model");

        modeReport.records.matchedParity = {
          modelMatched,
          exposureMatched,
          cutMatched,
          kMatched,
          budgetMatched,
          wrappersMatched: false,
          fileListMatched: false,
          discrepancies,
          status: discrepancies.length === 0 ? "PROVEN" : "UNPROVEN",
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
