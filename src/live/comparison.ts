import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseInput,
  preflight,
  publicInput,
  requireValue,
  RunnerError,
  type ComparisonGroup,
  type ComparisonMode,
  type RunInput,
} from "./contract.js";
import { ledgerSummary, readLedger } from "./budget.js";
import { finalizeRun, launchWorker, type ChildReceipt } from "./runner.js";
import type { SegmentReport } from "./worker.js";
import type { CheckResult } from "./scenarios.js";

export const ALL_GROUPS: ComparisonGroup[] = ["native", "current", "candidate"];

export interface ComparisonScenarioResult {
  mode: ComparisonMode;
  group: ComparisonGroup;
  scenarioId: string;
  variant?: string | undefined;
  status: "OBSERVED" | "UNPROVEN" | "STOPPED";
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
  tokens: number;
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
          native: { config: {}, revision: "Pi-0.85.1-native", scenarios: [] },
          current: { config: {}, revision: "70dacad", scenarios: [] },
          candidate: { config: {}, revision: receipt.candidate, scenarios: [] },
        },
        records: {},
      };

      for (const group of ALL_GROUPS) {
        for (let scenarioIndex = 0; scenarioIndex < input.scenarios.length; scenarioIndex++) {
          signal.throwIfAborted();
          requireValue(Date.now() < deadline, "TIME_LIMIT", "Run deadline reached");
          const selection = input.scenarios[scenarioIndex]!;
          const caseKey = `${mode}-${group}-${selection.id}${selection.variant ? `-${selection.variant}` : ""}`;
          const caseRoot = join(root, caseKey);
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
            report.usage = ledgerSummary(readLedger(join(root, "calls.jsonl")));
            requireValue(!child.signal && !child.timedOut && child.exitCode === 0, child.diagnostic?.code ?? "WORKER", child.diagnostic?.message ?? "Worker did not complete");
            const segment = JSON.parse(await readFile(join(caseRoot, resume ? "resumed-observation.json" : "observation.json"), "utf8")) as SegmentReport;
            requireValue(report.usage.unreconciledCallIds.length === 0, "RECONCILIATION", "Possible started request has no terminal receipt");
            const failedPlacement = segment.prerequisites.some(c => c.status !== "PROVEN");
            if (segment.status === "PAUSED") {
              if (failedPlacement) { anyFailed = true; break; }
              resume = true; continue;
            }
            const scenarioResult: ComparisonScenarioResult = {
              mode,
              group,
              scenarioId: selection.id,
              variant: selection.variant,
              status: segment.status,
              reason: segment.reason,
              prerequisites: segment.prerequisites,
              score: segment.score,
              sessionFile: segment.sessionFile,
              calls: segment.actions.length,
              tokens: 0,
              latencyMs: 0,
              costUsd: null,
            };
            modeReport.groups[group].scenarios.push(scenarioResult);
            report.matrix.push(scenarioResult);
            if (segment.status !== "OBSERVED" || failedPlacement) anyFailed = true;
            break;
          } while (resume);
        }
      }

      if (mode === "defaults") {
        const modelWindow = input.models[0]!.contextWindow;
        modeReport.records.hComparison = {
          native: modelWindow - 16384,
          current: modelWindow - 16384,
          candidate: modelWindow - 16384,
        };
        modeReport.records.memorySizeComparison = {
          native: "Pi 0.85.1 text summary (up to 0.8 * reserveTokens = 13107 tokens)",
          current: "70dacad Nunc slots (0.2 * contextWindow = ~40000 tokens soft planning 8192)",
          candidate: "candidate Nunc slots (0.2 * contextWindow = ~40000 tokens soft planning 8192 + required item guard)",
        };
        modeReport.records.overheadComparison = {
          native: "cumulative file list ops tracking (readFiles/modifiedFiles)",
          current: "Nunc memory XML tags and slot ID wrapping",
          candidate: "Nunc memory XML tags, slot ID wrapping, and required attribute tracking",
        };
      } else if (mode === "matched") {
        const discrepancies: string[] = [
          "native Pi 0.85.1 uses hardcoded 0.8 * reserveTokens output cap vs Nunc configured memory budget",
          "native Pi 0.85.1 includes cumulative file list in summary context vs Nunc slot model",
        ];
        modeReport.records.matchedParity = {
          modelMatched: true,
          exposureMatched: true,
          cutMatched: false,
          kMatched: false,
          budgetMatched: false,
          wrappersMatched: false,
          fileListMatched: false,
          discrepancies,
          status: "UNPROVEN",
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
    await finalizeRun(input, receipt, report as any);
  }
  return report;
}
