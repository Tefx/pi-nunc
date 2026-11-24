import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonical } from "../engine/validation.js";
import { object, canResumeScenario, parseInput, preflight, requireValue, RunnerError, within, elapsedInterval, type WallClockInterval, type Receipt, type RunInput } from "./contract.js";
import { ledgerSummary, readQualifiedLedgers, resolveBatchContext, type QualifiedCall } from "./budget.js";
import type { SegmentReport, WorkerJob } from "./worker.js";
import { childEnvironment, nativeEnvironment, superviseProcess } from "./host.js";

export interface ChildReceipt { timing?: WallClockInterval; exitCode: number | null; signal: string | null; timedOut: boolean; diagnostic?: { code: string; message: string } }
export async function launchWorker(script: string, job: WorkerJob, signal: AbortSignal): Promise<ChildReceipt> {
  const startedAt = Date.now();
  // Orchestration uses the checked repository cwd and supervisor's temp root.
  const env = { ...nativeEnvironment(job.input.target.stateRoot), TMPDIR: process.env.TMPDIR };
  let diagnostic: ChildReceipt["diagnostic"];
  const result = await superviseProcess(process.execPath, [script, "--worker"], { cwd: job.input.target.repository, env, stdio: ["pipe", "ignore", "ignore", "ipc"] }, job.deadline, signal, child => {
    child.on("message", (value: unknown) => {
      if (!diagnostic && object(value) && value.type === "nunc-worker-rejection" && typeof value.code === "string" && /^[A-Z_]{1,64}$/.test(value.code) && typeof value.message === "string" && /^[\x20-\x7e]{1,256}$/.test(value.message)) {
        diagnostic = { code: value.code, message: value.message };
      }
    });
    child.stdin!.on("error", () => { /* Early rejection is reported by child exit, never replayed. */ });
    child.stdin!.end(JSON.stringify(job));
  });
  return { ...result, timing: elapsedInterval(startedAt), ...(diagnostic ? { diagnostic } : {}) };
}
/** Both supervisors admit a fresh segment against the same cumulative ledger. */
export function assertDispatchQuota(input: RunInput, usage: ReturnType<typeof ledgerSummary>): void {
  requireValue(usage.unreconciledCallIds.length === 0, "RECONCILIATION", "Possible started request has no terminal receipt");
  if (input.limits.maxCalls !== null) requireValue(usage.calls < input.limits.maxCalls, "CALL_LIMIT", "Shared call ceiling exhausted; no further child/session effects");
  if (input.limits.maxTotalTokens !== null) {
    const smallestReservation = Math.min(...input.models.map(m => m.contextWindow + m.maxTokens));
    requireValue(usage.chargedTokens + smallestReservation <= input.limits.maxTotalTokens, "TOKEN_LIMIT", "Shared token ceiling cannot reserve another task request");
  }
  if (input.limits.maxCostUsd !== null) requireValue(usage.chargedCostUsd !== null && usage.chargedCostUsd < input.limits.maxCostUsd, "COST_LIMIT", "Shared known-cost ceiling exhausted");
}
export async function dispatchWorker(script: string, job: WorkerJob, signal: AbortSignal,
  report: { children: ChildReceipt[]; usage: ReturnType<typeof ledgerSummary> }, readAll: () => QualifiedCall[]) {
  signal.throwIfAborted();
  requireValue(Date.now() < job.deadline, "TIME_LIMIT", "Run deadline reached");
  report.usage = ledgerSummary(readAll(), job.input.limits);
  assertDispatchQuota(job.input, report.usage);
  const child = await launchWorker(script, job, signal);
  report.children.push(child);
  report.usage = ledgerSummary(readAll(), job.input.limits);
  requireValue(!child.signal && !child.timedOut && child.exitCode === 0, child.diagnostic?.code ?? "WORKER", child.diagnostic?.message ?? "Worker did not complete; inspect saved state before any new run");
  const selection = job.input.scenarios[job.scenarioIndex]!;
  const caseRoot = job.caseRoot ?? join(job.input.target.stateRoot, `${selection.id}${selection.variant ? `-${selection.variant}` : ""}`);
  const segment = JSON.parse(await readFile(join(caseRoot, job.resume ? "resumed-observation.json" : "observation.json"), "utf8")) as SegmentReport;
  return { child, segment };
}
export function assertSegmentSettled(segment: SegmentReport, usage: ReturnType<typeof ledgerSummary>): void {
  requireValue(usage.unreconciledCallIds.length === 0, "RECONCILIATION", "Possible started request has no terminal receipt");
  requireValue(segment.status !== "STOPPED" && segment.reason !== "CLEANUP", segment.reason === "CLEANUP" ? "CLEANUP" : segment.reason ?? "WORKER", segment.diagnostic ?? "Worker stopped; inspect saved state before any new run");
}
export interface RunReport {
  version: 1; status: "OBSERVED" | "UNPROVEN" | "STOPPED";
  selection: RunInput; segments: SegmentReport[]; children: ChildReceipt[];
  usage: ReturnType<typeof ledgerSummary>; elapsedMs: number;
  cleanup: "retained" | "removed" | "retained-for-reconciliation";
  limitations: string[]; reason?: string; sessions?: Record<string, unknown[]>; stock?: unknown[];
}
export async function execute(value: unknown, repository: string, script: string, signal: AbortSignal): Promise<RunReport> {
  const input = parseInput(value, true);
  const receipt = await preflight(input, repository);
  const { priorLedgerPaths, firstDispatchAt, deadline } = resolveBatchContext(input);
  requireValue(Date.now() < deadline, "TIME_LIMIT", "Run deadline reached");
  input.receipt = receipt;
  await initializeRun(input, receipt, deadline);
  const started = Date.now();
  const root = input.target.stateRoot;
  const readAll = () => readQualifiedLedgers([...priorLedgerPaths, ...(existsSync(join(root, "calls.jsonl")) ? [join(root, "calls.jsonl")] : [])]);
  const report: RunReport = { version: 1, status: "STOPPED", selection: structuredClone(input), segments: [], children: [], usage: ledgerSummary([]), elapsedMs: 0, cleanup: "retained", limitations: [
    "Provider responses are real only for separately authorized execution. Offline controlled-provider checks prove host/runner mechanics, not model policy behavior.",
    "Semantic reasons, repeated failed attempts, restatement needs and unsupported claims require independent review of recorded actions/session evidence. No judge or additional model calls are authorized by this runner.",
    "Token/call reservations always cover the entire model window plus output. USD bounds apply only to explicit catalog-reservation mode; token-call-reservation reports unknown billing as null, with available worst-tier catalog estimates separately labeled. Native subscription session cost placeholders are not billing receipts. Trustworthy terminal usage releases unused token reserves; missing or untrusted usage retains full reservations.",
    "A local abort/terminated process does not prove remote cancellation or final billing. Unresolved requests, cancellation, exhausted time/known-cost limits, and any configured call/token caps stop further effects and retain isolated evidence. A completed failed independent scenario keeps its reservation and is not replayed; later authorized isolated scenarios may continue within remaining shared time/known-cost limits and any still-configured call/token caps. Unknown usage stays null.",
  ] };
  try {
    if (input.observations?.some(m => m !== "continuation")) report.stock = await runStock(input, repository, deadline, signal);
    let failed = false;
    for (let scenarioIndex = 0; scenarioIndex < (input.observations && !input.observations.includes("continuation") ? 0 : input.scenarios.length); scenarioIndex++) {
      const selection = input.scenarios[scenarioIndex]!;
      let resume = false;
      do {
        const { segment } = await dispatchWorker(script, { input, scenarioIndex, deadline, resume, priorLedgers: priorLedgerPaths }, signal, report, readAll);
        report.segments.push(segment);
        assertSegmentSettled(segment, report.usage);
        const failedPlacement = segment.prerequisites.some(c => c.status !== "PROVEN");
        if (segment.status === "PAUSED") {
          requireValue(canResumeScenario(selection.id, resume), "RESTART", "Unexpected repeated pause");
          if (failedPlacement) { failed = true; break; }
          resume = true; continue;
        }
        if (segment.status !== "OBSERVED" || failedPlacement) failed = true;
        break;
      } while (resume);
    }
    report.status = failed ? "UNPROVEN" : "OBSERVED";
    if (failed) report.reason = report.segments.find(s => s.status === "UNPROVEN" || s.status === "STOPPED" || (s.status === "PAUSED" && s.prerequisites.some(c => c.status !== "PROVEN")))?.reason ?? "OBSERVATION";
  } catch (error) { report.status = "UNPROVEN"; report.reason = error instanceof RunnerError ? error.code : signal.aborted ? "CANCELLED" : "RUNNER_ERROR"; }
  finally {
    await settleRun(input, receipt, report, readAll, firstDispatchAt ?? started);
  }
  return report;
}

/** Controlled stock transports only. No catalog model is contacted by these observations. */
async function runStock(input: RunInput, repository: string, deadline: number, signal: AbortSignal): Promise<unknown[]> {
  const reports: unknown[] = [];
  const { priorLedgerPaths } = resolveBatchContext(input);
  for (const mode of input.observations ?? []) {
    if (mode === "continuation") continue;
    signal.throwIfAborted();
    const ledgerPath = join(input.target.stateRoot, "calls.jsonl");
    const usage = ledgerSummary(readQualifiedLedgers([...priorLedgerPaths, ...(existsSync(ledgerPath) ? [ledgerPath] : [])]), input.limits);
    requireValue(usage.unreconciledCallIds.length === 0, "RECONCILIATION", "Stock requests require settled prior receipts");
    requireValue(input.limits.maxCostUsd === null || usage.chargedCostUsd !== null && usage.chargedCostUsd <= input.limits.maxCostUsd, "COST_LIMIT", "Stock requests require reconciled prior costs within the shared ceiling");
    const remainingCalls = usage.remainingCalls;
    const remainingTokens = usage.remainingTokens;
    const limits = { ...input.limits, maxCalls: remainingCalls, maxTotalTokens: remainingTokens, maxDurationMs: deadline - Date.now() };
    requireValue((remainingCalls === null || remainingCalls > 0) && limits.maxDurationMs > 0, "LIMIT", "Controlled stock observation exhausted its bound");
    const parent = join(input.target.stateRoot, "stock"); await mkdir(parent, { recursive: true });
    let stdout = "";
    const overflow = new AbortController();
    const result = await superviseProcess(process.execPath, [join(repository, "scripts/observe-stock.mjs"), mode === "stock_tui" ? "tui" : "rpc", parent], { cwd: input.target.stateRoot, env: { ...childEnvironment(input.target.stateRoot), NUNC_STOCK_LIMITS: JSON.stringify(limits), NUNC_STOCK_LEDGER: ledgerPath }, stdio: ["ignore", "pipe", "ignore"] }, deadline, AbortSignal.any([signal, overflow.signal]), child => {
      child.stdout!.on("data", (b: Buffer) => { stdout += b.toString(); if (stdout.length > 1_000_000) overflow.abort(); });
    });
    requireValue(result.exitCode === 0 && !result.timedOut, "STOCK_OBSERVATION", "Stock observation stopped; retain isolated evidence");
    const row = JSON.parse(stdout.trim()) as { status: string; requests: number; evidence: string };
    requireValue(row.status === "PROVEN_CONTROLLED" && Number.isSafeInteger(row.requests) && row.requests > 0 && (remainingCalls === null || row.requests <= remainingCalls) && within(row.evidence, parent), "STOCK_OBSERVATION", "Invalid stock observation receipt");
    const evidence: Record<string, unknown> = {};
    for (const name of await readdir(row.evidence)) {
      if (!/^(events|session-\d+)\.jsonl$|^(result|wire|processes|timeline)\.json$/.test(name)) continue;
      const data = await readFile(join(row.evidence, name), "utf8");
      requireValue(data.length <= 64_000_000, "OUTPUT", "Stock evidence exceeded bound");
      evidence[name] = name.endsWith(".jsonl") ? data.trim().split("\n").filter(Boolean).map(s => JSON.parse(s)) : JSON.parse(data);
    }
    reports.push({ ...row, evidence });
  }
  return reports;
}
export async function observeStock(value: unknown, repository: string, signal: AbortSignal): Promise<RunReport> {
  const input = parseInput(value), receipt = await preflight(input, repository);
  requireValue(input.mode === "controlled" && input.observations?.length && !input.observations.includes("continuation"), "AUTHORIZATION", "Controlled stock mode requires stock_rpc/stock_tui only");
  const { priorLedgerPaths, firstDispatchAt, deadline } = resolveBatchContext(input);
  requireValue(Date.now() < deadline, "TIME_LIMIT", "Run deadline reached");
  await initializeRun(input, receipt, deadline);
  const start = Date.now();
  const report: RunReport = { version: 1, status: "UNPROVEN", selection: input, segments: [], children: [], usage: ledgerSummary([]), elapsedMs: 0, cleanup: "retained", limitations: ["Controlled loopback service proves actual stock CLI/RPC/TUI mechanics; real model memory quality and billing remain UNPROVEN."] };
  try { report.stock = await runStock(input, repository, deadline, signal); report.status = "OBSERVED"; }
  catch (error) { report.reason = error instanceof RunnerError ? error.code : "STOCK_OBSERVATION"; }
  finally {
    await settleRun(input, receipt, report, () => readQualifiedLedgers([...priorLedgerPaths, ...(existsSync(join(input.target.stateRoot, "calls.jsonl")) ? [join(input.target.stateRoot, "calls.jsonl")] : [])]), firstDispatchAt ?? start);
  }
  return report;
}

/** All supervisors create the same single-use ownership boundary before dispatch. */
export async function initializeRun(input: RunInput, receipt: Receipt, deadline: number): Promise<void> {
  const root = input.target.stateRoot;
  await mkdir(root, { mode: 0o700 });
  await mkdir(join(root, "tmp"), { mode: 0o700 });
  await writeFile(join(root, "owner.json"), JSON.stringify({ receipt, deadline, status: "running" }), { mode: 0o600, flag: "wx" });
  await writeFile(join(root, "execution-started.json"), JSON.stringify({ deadline }), { mode: 0o600, flag: "wx" });
}
export async function settleRun(input: RunInput, receipt: Receipt, report: RunReport | import("./comparison.js").ComparisonReport,
  readAll: () => QualifiedCall[], started: number): Promise<void> {
  try { report.usage = ledgerSummary(readAll(), input.limits); }
  catch { report.status = "UNPROVEN"; report.reason = "LEDGER_RECONCILIATION"; report.cleanup = "retained-for-reconciliation"; }
  report.elapsedMs = Date.now() - started;
  try { await finalizeRun(input, receipt, report); }
  catch (error) {
    report.status = "UNPROVEN";
    report.reason ??= error instanceof RunnerError ? error.code : "CLEANUP";
    report.cleanup = "retained-for-reconciliation";
    const root = input.target.stateRoot;
    try { await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 }); }
    catch { /* Persistence failure must not hide the returned reconciliation report. */ }
    try {
      const bound = JSON.parse(await readFile(join(root, "owner.json"), "utf8"));
      await writeFile(join(root, "owner.json"), JSON.stringify({ ...bound, status: "terminal", result: report.status, reason: report.reason, cleanup: report.cleanup }), { mode: 0o600 });
    } catch { /* Retain unreadable ownership evidence for manual reconciliation. */ }
  }
}

/** Called only after every child has exited. Failed/uncertain runs retain their evidence and are never replayed. */
export async function finalizeRun(input: RunInput, receipt: Receipt, report: RunReport | import("./comparison.js").ComparisonReport): Promise<void> {
  const root = input.target.stateRoot;
  if (report.usage.unreconciledCallIds.length > 0) report.cleanup = "retained-for-reconciliation";
  const bound = JSON.parse(await readFile(join(root, "owner.json"), "utf8"));
  requireValue(canonical(bound.receipt) === canonical(receipt), "CLEANUP", "Run ownership changed; retain state");
  if (input.target.cleanup === "remove" && report.status === "OBSERVED" && report.cleanup !== "retained-for-reconciliation") {
    // Preserve actual persistent evidence in the returned observer report before deleting its source directory.
    report.sessions = {};
    for (const file of new Set(("segments" in report ? report.segments : report.matrix).flatMap(s => s.sessionFile ? [s.sessionFile] : []))) {
      requireValue(within(file, root), "CLEANUP", "Session evidence is outside owned run");
      const text = await readFile(file, "utf8");
      requireValue(text.endsWith("\n"), "RECONCILIATION", "Incomplete persistent session; retain state");
      report.sessions[file] = text.trim().split("\n").map(line => JSON.parse(line));
    }
    await rm(root, { recursive: true }); report.cleanup = "removed";
  } else {
    await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    await writeFile(join(root, "owner.json"), JSON.stringify({ ...bound, status: "terminal", result: report.status, reason: report.reason, cleanup: report.cleanup }), { mode: 0o600 });
  }
}
