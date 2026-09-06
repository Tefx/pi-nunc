import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonical, parseInput, preflight, publicInput, requireValue, RunnerError, within, type Receipt, type RunInput } from "./contract.js";
import { ledgerSummary, readLedger } from "./budget.js";
import type { SegmentReport, WorkerJob } from "./worker.js";
import { childEnvironment, nativeEnvironment } from "./host.js";
export { childEnvironment } from "./host.js";

export interface ChildReceipt { exitCode: number | null; signal: string | null; timedOut: boolean }
export function launchWorker(script: string, job: WorkerJob, signal: AbortSignal): Promise<ChildReceipt> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, "--worker"], { cwd: job.input.target.stateRoot, env: nativeEnvironment(job.input.target.stateRoot), detached: true, stdio: ["pipe", "ignore", "ignore"] });
    let timedOut = false, hard: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } } };
    const stop = () => { timedOut = true; kill("SIGTERM"); hard ??= setTimeout(() => kill("SIGKILL"), 2000); };
    const timer = setTimeout(stop, Math.max(1, job.deadline - Date.now()));
    signal.addEventListener("abort", stop, { once: true });
    child.once("error", error => { clearTimeout(timer); if (hard) clearTimeout(hard); signal.removeEventListener("abort", stop); reject(error); });
    child.once("close", (exitCode, exitSignal) => { clearTimeout(timer); if (hard) clearTimeout(hard); signal.removeEventListener("abort", stop); resolve({ exitCode, signal: exitSignal, timedOut }); });
    child.stdin.on("error", () => { /* Early rejection is reported by child exit, never replayed. */ });
    child.stdin.end(JSON.stringify(job));
    if (signal.aborted) stop();
  });
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
  await mkdir(input.target.stateRoot, { mode: 0o700 });
  await mkdir(join(input.target.stateRoot, "tmp"), { mode: 0o700 });
  input.receipt = receipt;
  await writeFile(join(input.target.stateRoot, "owner.json"), JSON.stringify({ receipt }), { mode: 0o600, flag: "wx" });
  const started = Date.now(), deadline = started + input.limits.maxDurationMs;
  const root = input.target.stateRoot;
  // A newly created target is single-use; no silent rerun of possible prior effects.
  await writeFile(join(root, "execution-started.json"), JSON.stringify({ deadline }), { mode: 0o600, flag: "wx" });
  const report: RunReport = { version: 1, status: "STOPPED", selection: publicInput(input), segments: [], children: [], usage: ledgerSummary([]), elapsedMs: 0, cleanup: "retained", limitations: [
    "Provider responses are real only for separately authorized execution. Offline controlled-provider checks prove host/runner mechanics, not model policy behavior.",
    "Semantic reasons, repeated failed attempts, restatement needs and unsupported claims require independent review of recorded actions/session evidence. No judge or additional model calls are authorized by this runner.",
    "Token/call reservations always cover the entire model window plus output. USD bounds apply only to explicit catalog-reservation mode; token-call-reservation reports unknown billing as null, with available worst-tier catalog estimates separately labeled. Native subscription session cost placeholders are not billing receipts. Reservations are never refunded; missing usage stays null.",
    "A local abort/terminated process does not prove remote cancellation or final billing. Unresolved requests stop all further effects and retain isolated evidence for reconciliation.",
  ] };
  try {
    await writeFile(join(root, "owner.json"), JSON.stringify({ receipt, deadline, status: "running" }), { mode: 0o600 });
    if (input.observations?.some(m => m !== "continuation")) report.stock = await runStock(input, repository, deadline, signal);
    for (let scenarioIndex = 0; scenarioIndex < (input.observations && !input.observations.includes("continuation") ? 0 : input.scenarios.length); scenarioIndex++) {
      const selection = input.scenarios[scenarioIndex]!;
      const caseRoot = join(root, `${selection.id}${selection.variant ? `-${selection.variant}` : ""}`);
      let resume = false;
      do {
        signal.throwIfAborted(); requireValue(Date.now() < deadline, "TIME_LIMIT", "Run deadline reached");
        const child = await launchWorker(script, { input, scenarioIndex, deadline, resume }, signal); report.children.push(child);
        report.usage = ledgerSummary(readLedger(join(root, "calls.jsonl")));
        requireValue(!child.signal && !child.timedOut && child.exitCode === 0, "WORKER", "Worker did not complete; inspect saved state before any new run");
        const segment = JSON.parse(await readFile(join(caseRoot, resume ? "resumed-observation.json" : "observation.json"), "utf8")) as SegmentReport;
        report.segments.push(segment);
        requireValue(report.usage.unreconciledCallIds.length === 0, "RECONCILIATION", "Possible started request has no terminal receipt");
        requireValue(segment.status === "OBSERVED" || segment.status === "PAUSED", "OBSERVATION", "Required observation did not complete");
        requireValue(segment.prerequisites.every(c => c.status === "PROVEN"), "PREREQUISITE", "Scenario setup did not establish required placement");
        if (segment.status === "PAUSED") { requireValue(!resume && selection.id === "c3", "RESTART", "Unexpected repeated pause"); resume = true; }
        else break;
      } while (resume);
    }
    report.status = "OBSERVED";
  } catch (error) { report.status = "UNPROVEN"; report.reason = error instanceof RunnerError ? error.code : signal.aborted ? "CANCELLED" : "RUNNER_ERROR"; }
  finally {
    try { report.usage = ledgerSummary(readLedger(join(root, "calls.jsonl"))); } catch { report.cleanup = "retained-for-reconciliation"; report.reason = "LEDGER_RECONCILIATION"; }
    report.elapsedMs = Date.now() - started;
    if (report.usage.unreconciledCallIds.length > 0) report.cleanup = "retained-for-reconciliation";
    await finalizeRun(input, receipt, report);
  }
  return report;
}

/** Controlled stock transports only. No catalog model is contacted by these observations. */
async function runStock(input: RunInput, repository: string, deadline: number, signal: AbortSignal): Promise<unknown[]> {
  const reports: unknown[] = []; let calls = 0;
  for (const mode of input.observations ?? []) {
    if (mode === "continuation") continue;
    signal.throwIfAborted();
    const limits = { ...input.limits, maxCalls: input.limits.maxCalls - calls, maxTotalTokens: input.limits.maxTotalTokens - calls * 80000, maxDurationMs: deadline - Date.now() };
    requireValue(limits.maxCalls > 0 && limits.maxDurationMs > 0, "LIMIT", "Controlled stock observation exhausted its bound");
    const parent = join(input.target.stateRoot, "stock"); await mkdir(parent, { recursive: true });
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [join(repository, "scripts/observe-stock.mjs"), mode === "stock_tui" ? "tui" : "rpc", parent], { cwd: input.target.stateRoot, detached: true, env: { ...childEnvironment(input.target.stateRoot), NUNC_STOCK_LIMITS: JSON.stringify(limits) }, stdio: ["ignore", "pipe", "ignore"] });
      let stdout = "", killed = false, hard: NodeJS.Timeout | undefined;
      const kill = (s: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, s); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; } } };
      const stop = () => { killed = true; kill("SIGTERM"); hard ??= setTimeout(() => kill("SIGKILL"), 2000); };
      const timer = setTimeout(stop, limits.maxDurationMs); signal.addEventListener("abort", stop, { once: true });
      const clear = () => { clearTimeout(timer); if (hard) clearTimeout(hard); signal.removeEventListener("abort", stop); };
      child.stdout.on("data", (b: Buffer) => { stdout += b.toString(); if (stdout.length > 1_000_000) stop(); });
      child.once("error", e => { clear(); reject(e); });
      child.once("close", code => { clear(); if (code === 0 && !killed) resolve(stdout); else reject(new RunnerError("STOCK_OBSERVATION", "Stock observation stopped; retain isolated evidence")); });
      if (signal.aborted) stop();
    });
    const row = JSON.parse(result.trim()) as { status: string; requests: number; evidence: string };
    requireValue(row.status === "PROVEN_CONTROLLED" && Number.isSafeInteger(row.requests) && row.requests > 0 && row.requests <= limits.maxCalls && within(row.evidence, parent), "STOCK_OBSERVATION", "Invalid stock observation receipt");
    const evidence: Record<string, unknown> = {};
    for (const name of await readdir(row.evidence)) {
      if (!/^(events|session-\d+)\.jsonl$|^(result|wire|processes|timeline)\.json$/.test(name)) continue;
      const data = await readFile(join(row.evidence, name), "utf8");
      requireValue(data.length <= 64_000_000, "OUTPUT", "Stock evidence exceeded bound");
      evidence[name] = name.endsWith(".jsonl") ? data.trim().split("\n").filter(Boolean).map(s => JSON.parse(s)) : JSON.parse(data);
    }
    reports.push({ ...row, evidence }); calls += row.requests;
  }
  return reports;
}
export async function observeStock(value: unknown, repository: string, signal: AbortSignal): Promise<RunReport> {
  const input = parseInput(value), receipt = await preflight(input, repository);
  requireValue(input.mode === "controlled" && input.observations?.length && !input.observations.includes("continuation"), "AUTHORIZATION", "Controlled stock mode requires stock_rpc/stock_tui only");
  await mkdir(input.target.stateRoot, { mode: 0o700 });
  await writeFile(join(input.target.stateRoot, "owner.json"), JSON.stringify({ receipt }), { mode: 0o600, flag: "wx" });
  const start = Date.now();
  const report: RunReport = { version: 1, status: "UNPROVEN", selection: input, segments: [], children: [], usage: ledgerSummary([]), elapsedMs: 0, cleanup: "retained", limitations: ["Controlled loopback service proves actual stock CLI/RPC/TUI mechanics; real model memory quality and billing remain UNPROVEN."] };
  try { report.stock = await runStock(input, repository, start + input.limits.maxDurationMs, signal); report.status = "OBSERVED"; }
  catch (error) { report.reason = error instanceof RunnerError ? error.code : "STOCK_OBSERVATION"; }
  finally { report.elapsedMs = Date.now() - start; await finalizeRun(input, receipt, report); }
  return report;
}

/** Called only after every child has exited. Failed/uncertain runs retain their evidence and are never replayed. */
export async function finalizeRun(input: RunInput, receipt: Receipt, report: RunReport): Promise<void> {
  const root = input.target.stateRoot;
  if (report.usage.unreconciledCallIds.length > 0) report.cleanup = "retained-for-reconciliation";
  const bound = JSON.parse(await readFile(join(root, "owner.json"), "utf8"));
  requireValue(canonical(bound.receipt) === canonical(receipt), "CLEANUP", "Run ownership changed; retain state");
  if (input.target.cleanup === "remove" && report.status === "OBSERVED" && report.cleanup !== "retained-for-reconciliation") {
    // Preserve actual persistent evidence in the returned observer report before deleting its source directory.
    report.sessions = {};
    for (const file of new Set(report.segments.flatMap(s => s.sessionFile ? [s.sessionFile] : []))) {
      requireValue(within(file, root), "CLEANUP", "Session evidence is outside owned run");
      const text = await readFile(file, "utf8");
      requireValue(text.endsWith("\n"), "RECONCILIATION", "Incomplete persistent session; retain state");
      report.sessions[file] = text.trim().split("\n").map(line => JSON.parse(line));
    }
    await rm(root, { recursive: true }); report.cleanup = "removed";
  } else await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
}
