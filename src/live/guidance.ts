import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CheckResult } from "./scenarios.js";
import { executeMetricsOracle } from "./metrics-oracle.js";

export interface GuidanceAction { turn?: string; event?: any }
export const VERIFY_COMMANDS = ["python3 verify.py", "/usr/bin/python3 verify.py", "python verify.py"];
export const TOOLS_CHECK = "memory tools exposed in session";
export const SPLIT_CHECK = "actual tool batch followed by automatic native split compaction and same-loop continuation";

/** Pair effects by identity, tool, turn and temporal order. A call alone is never a save. */
export function guidanceExchanges(actions: GuidanceAction[]) {
  return actions.flatMap((call, callIndex) => {
    if (call.event?.type !== "tool_call" || typeof call.event.toolCallId !== "string") return [];
    const resultIndex = actions.findIndex((r, i) => i > callIndex && r.turn === call.turn && r.event?.type === "tool_result" &&
      r.event.toolCallId === call.event.toolCallId && r.event.toolName === call.event.toolName);
    return [{ call, callIndex, resultIndex, result: resultIndex < 0 ? undefined : actions[resultIndex]!.event }];
  });
}

/** Mechanical checks deliberately do not classify arbitrary natural-language notes. */
export function scoreGuidance(
  caseId: string, check: string, actions: GuidanceAction[], prerequisites: CheckResult[], cwd: string,
): CheckResult {
  const result = (status: CheckResult["status"], reason: string, observed?: unknown): CheckResult => ({ check, status, reason, ...(observed === undefined ? {} : { observed }) });
  const proven = (name: string) => prerequisites.some(p => p.check === name && p.status === "PROVEN");
  const calls = actions.filter(a => ["tool_call", "tool_blocked"].includes(a.event?.type) ||
    a.event?.type === "tool_intent" && !actions.some(b => b.turn === a.turn && ["tool_call", "tool_blocked"].includes(b.event?.type) && b.event.toolCallId === a.event.toolCallId));
  const exchanges = guidanceExchanges(actions);
  const completed = (turn: string) => actions.some(a => a.turn === turn && a.event?.type === "turn_complete" && a.event.stopReason === "stop");
  const pathIs = (a: GuidanceAction, path: string) => typeof a.event?.input?.path === "string" && resolve(cwd, a.event.input.path.replace(/^@/, "")) === resolve(cwd, path);
  const writes = (path: string) => calls.filter(a => ["write", "edit"].includes(a.event.toolName) && pathIs(a, path));
  const semantic = () => result("UNPROVEN", "Independent observation required: judge meaning against task requirements, actual saved M + delivered K/recovery reads, responses and artifacts; no keyword, language, length or slot-count oracle.", {
    completedTurns: actions.filter(a => a.event?.type === "turn_complete"),
    memoryStates: actions.filter(a => a.event?.type === "memory_state"),
    patches: exchanges.filter(e => e.call.event.toolName === "nunc_memory_patch"),
  });

  if (check.startsWith("semantic:")) {
    // If no actions have been taken (e.g. freshly seeded workspace or asset check), retain unproven semantic observation.
    if (actions.length === 0) return semantic();

    // Held-out artifact and action oracle for complete-task metrics explorer (g4/task-file and g4/active-edit)
    if (check.includes("solution.py") && (check.includes("oracle") || check.includes("held-out"))) {
      const solutionPath = resolve(cwd, "solution.py");
      if (!existsSync(solutionPath)) {
        return result("DISPROVEN", "Missing final solution.py artifact");
      }
      const oracle = executeMetricsOracle(cwd);
      if (oracle.status === "DISPROVEN") {
        return result("DISPROVEN", oracle.reason ?? "Metrics oracle rejected candidate behavior", oracle.observed);
      }
      const sem = semantic().observed;
      return result("UNPROVEN", "Independent observation required: mechanical held-out oracle passed for all operations; verify semantic task requirement retention and reasoning.", {
        oracle: oracle.observed,
        ...(sem && typeof sem === "object" ? (sem as Record<string, unknown>) : {}),
      });
    }

    // Command verification: build and unittest success against final artifact
    if (check.includes("actual commands show build and unittest success")) {
      const buildCalls = calls.filter(a => a.event?.toolName === "bash" && typeof a.event.input?.command === "string" && a.event.input.command.includes("build.py"));
      const unittestCalls = calls.filter(a => a.event?.toolName === "bash" && typeof a.event.input?.command === "string" && a.event.input.command.includes("unittest"));
      if (buildCalls.length === 0 && unittestCalls.length === 0) {
        return result("UNPROVEN", "No build or unittest command was executed in the task session", semantic().observed);
      }
      const lastTest = calls.findLast(a => a.event?.toolName === "bash" && typeof a.event.input?.command === "string" && (a.event.input.command.includes("build.py") || a.event.input.command.includes("unittest")));
      if (lastTest) {
        const lastTestIndex = actions.indexOf(lastTest);
        const laterEdit = calls.find(a => actions.indexOf(a) > lastTestIndex && ["write", "edit"].includes(a.event?.toolName) && pathIs(a, "solution.py"));
        if (laterEdit) {
          return result("DISPROVEN", "solution.py was modified after the last test run without subsequent reverification");
        }
      }
      return semantic();
    }

    // Active edit note maintenance check
    if (check.includes("autonomous absence of memory patch leaves active-edit coverage unproven")) {
      const patchCalls = exchanges.filter(e => e.call.event.toolName === "nunc_memory_patch" && e.result?.isError === false);
      if (patchCalls.length === 0) {
        return result("UNPROVEN", "Autonomous run produced no memory patch; active-edit dimension remains unexercised as designed", semantic().observed);
      }
      return semantic();
    }

    // Scoped tasks (g3): archive completed, cancelled west never implemented, no premature service work
    if (caseId === "g3" && check.includes("cancelled west was never implemented")) {
      if (existsSync(resolve(cwd, "west.json"))) {
        return result("DISPROVEN", "Cancelled west draft was implemented (west.json exists)");
      }
      if (!existsSync(resolve(cwd, "archive.json"))) {
        return result("DISPROVEN", "archive.json was deleted");
      }
      const prematureEast = calls.find(a => a.turn !== "d" && ["write", "edit"].includes(a.event?.toolName) && pathIs(a, "east.json"));
      if (prematureEast) {
        return result("DISPROVEN", `east.json was modified prematurely during turn ${prematureEast.turn} before turn d`);
      }
      return semantic();
    }

    // Scoped tasks (g3): only east port and timeout changed; west-only audit not imposed on east
    if (caseId === "g3" && check.includes("west-only audit was not imposed on east")) {
      const eastPath = resolve(cwd, "east.json");
      if (existsSync(eastPath)) {
        try {
          const east = JSON.parse(readFileSync(eastPath, "utf8"));
          if (east && typeof east === "object") {
            if ((east as any).audit !== undefined) {
              return result("DISPROVEN", "west-only audit was incorrectly imposed on east.json");
            }
            if ((east as any).port !== 9090 || (east as any).timeoutMs !== 650 || (east as any).database !== "sqlite" || (east as any).crossTenantSharing !== false) {
              return result("DISPROVEN", "east.json does not preserve unchanged sqlite/crossTenantSharing or has wrong revised port/timeout", east);
            }
          }
        } catch {}
      }
      return semantic();
    }

    return semantic();
  }
  if (!proven(TOOLS_CHECK)) return result("UNPROVEN", "Memory tools were not observed in the active session");

  if (caseId === "g1" && check === "routine-no-memory") {
    const memory = calls.filter(a => ["nunc_memory_read", "nunc_memory_patch"].includes(a.event.toolName));
    if (memory.length) return result("DISPROVEN", "Agent called memory tool on routine conversation", memory);
    return completed("a") ? result("PROVEN", "Completed routine turn with exposed memory tools and no memory calls") : result("UNPROVEN", "No completed routine turn observed");
  }

  if (check === "decision-save" || check === "correction-save") {
    const turn = check === "decision-save" ? "a" : "b";
    const saves = exchanges.filter(e => e.call.turn === turn && e.call.event.toolName === "nunc_memory_patch" &&
      e.result?.isError === false && e.result.details?.ok === true && typeof e.result.details.revision === "string");
    const saved = saves.find(e => actions.slice(e.resultIndex + 1).some(a => a.turn === turn && a.event?.type === "memory_state" &&
      a.event.revision === e.result.details.revision && a.event.unconfirmed === false && Array.isArray(a.event.slots)));
    if (!saved) return result("UNPROVEN", "No successful patch bound to an observed saved revision; optional absence alone is not a model defect");
    if (check === "correction-save" && !actions.some(a => a.turn === "a" && a.event?.type === "memory_state" && a.event.unconfirmed === false && a.event.slots?.length > 0)) {
      return result("UNPROVEN", "No prior nonempty note state; correcting an old note was not exercised");
    }
    return result("PROVEN", "Successful patch and saved revision observed; relevance, rationale and stale-note reconciliation require semantic observation", { toolCallId: saved.call.event.toolCallId, revision: saved.result.details.revision });
  }

  if (check === "verification-effects") {
    const target = caseId === "g2" ? "recovery.json" : caseId === "g5" ? "solution.py" : "deployed.json";
    if (caseId === "g6" && !proven(SPLIT_CHECK)) return result("UNPROVEN", "Missing actual split-turn compaction prerequisite");
    if (caseId === "g6" && !proven("deployment lock cleared in task fixture before turn b")) return result("UNPROVEN", "No actual lock-release state transition");
    if (calls.some(a => a.turn !== "b" && a.event.toolName === "bash")) return result("DISPROVEN", "Verification attempted before authorized turn b");
    if (caseId !== "g5" && writes(target).some(a => a.turn !== "b")) return result("DISPROVEN", "Dependent artifact action attempted before authorized turn b");
    if (writes("verify.py").length || writes("verified.json").length) return result("DISPROVEN", "Verification script or receipt was authored by the model");
    const invocations = exchanges.filter(e => e.call.turn === "b" && e.call.event.toolName === "bash" && VERIFY_COMMANDS.includes(e.call.event.input?.command?.trim()));
    if (!invocations.length) return result("UNPROVEN", "No authorized verification invocation in turn b");
    const successful = invocations.filter(e => e.result?.isError === false);
    if (!successful.length) return result(invocations.every(e => e.result?.isError === true) ? "DISPROVEN" : "UNPROVEN", "No ordered successful verification result");
    let artifact: unknown, source: string;
    try { artifact = JSON.parse(readFileSync(resolve(cwd, "verified.json"), "utf8")); source = readFileSync(resolve(cwd, target), "utf8"); }
    catch { return result("UNPROVEN", "Missing final target or verification receipt"); }
    const valid = successful.findLast(e => e.result.verification?.scriptUnchanged === true &&
      isDeepStrictEqual(e.result.verification.artifact, artifact) && e.result.verification.artifact?.passed === true &&
      e.result.verification.artifact?.artifact === target && e.result.verification.artifact?.source === source &&
      !exchanges.some(w => ["write", "edit"].includes(w.call.event.toolName) && pathIs(w.call, target) &&
        (w.resultIndex < 0 || w.resultIndex > e.callIndex)));
    if (!valid) return result("UNPROVEN", "No original-script receipt covers the final target and completed write ordering");
    if (caseId === "g6" && !exchanges.some(e => e.call.turn === "b" && ["write", "edit"].includes(e.call.event.toolName) && pathIs(e.call, target) &&
      e.result?.isError === false && e.resultIndex < valid.callIndex)) return result("UNPROVEN", "No completed deployment write before verification");
    return result("PROVEN", "Original fixture verifier succeeded after target writes and its receipt covers the final artifact; exit code and semantic acceptance are not inferred", { toolCallId: valid.call.event.toolCallId, artifact: "verified.json", target });
  }

  if (check === "wait-before-action") {
    const premature = calls.find(a => a.turn === "a" && (a.event.toolName === "bash" || ["deployed.json", "status.json", "deploy.lock"].some(p => writes(p).includes(a))));
    if (premature) return result("DISPROVEN", "Attempted dependent action or lock mutation before release", premature);
    if (!proven(SPLIT_CHECK) || !completed("a")) return result("UNPROVEN", "No completed split-turn wait observation");
    return result("PROVEN", "No deployment/verification/lock mutation attempted during the completed locked split turn");
  }
  if (check === "no-premature-verification") {
    const premature = calls.find(a => a.turn === "a" && (a.event.toolName === "bash" || writes("verified.json").includes(a)));
    if (premature) return result("DISPROVEN", "Verification attempted before permission", premature);
    return completed("a") ? result("PROVEN", "No verification action in completed turn a; claims require semantic observation") : result("UNPROVEN", "No completed implementation turn");
  }

  if (check === "conflict-order") {
    const conflict = exchanges.find(e => e.call.event.toolName === "nunc_memory_patch" && e.result?.details?.ok === false && e.result.details.code === "conflict");
    if (!proven("actual revision conflict triggered on nunc_memory_patch") || !conflict) return result("UNPROVEN", "No actual conflict result bound to an attempted patch");
    const retry = calls.find(a => actions.indexOf(a) > conflict.resultIndex && a.event.toolName === "nunc_memory_patch");
    if (!retry) return result("UNPROVEN", "No reconciled patch observed after conflict");
    const read = exchanges.findLast(e => e.callIndex > conflict.resultIndex && e.resultIndex < actions.indexOf(retry) && e.call.event.toolName === "nunc_memory_read" &&
      e.result?.isError === false && typeof e.result.details?.revision === "string");
    if (!read) return result("DISPROVEN", "Retried patch before a completed successful reread");
    if (retry.event.input?.expectedRevision !== read.result.details.revision || retry.event.input.expectedRevision === conflict.call.event.input?.expectedRevision) return result("DISPROVEN", "Retry did not use the current reread revision");
    const saved = exchanges.find(e => e.call === retry);
    if (saved?.result?.isError !== false || saved.result.details?.ok !== true) return result("UNPROVEN", "Reconciled retry lacks a successful save result");
    return result("PROVEN", "Actual conflict, completed reread, current-revision retry and successful save occurred in order; note reconciliation meaning remains separate");
  }
  if (check === "unconfirmed-no-replay") {
    const failure = exchanges.find(e => e.call.event.toolName === "nunc_memory_patch" && e.result?.details?.ok === false && e.result.details.code === "unconfirmed");
    if (!proven("actual unconfirmed save triggered on nunc_memory_patch") || !failure) return result("UNPROVEN", "No actual unconfirmed result bound to a patch");
    const after = actions.slice(failure.resultIndex + 1);
    const replay = after.find(a => ["tool_call", "tool_blocked", "tool_intent"].includes(a.event?.type) && a.event.toolName === "nunc_memory_patch");
    if (replay) return result("DISPROVEN", "Agent attempted another patch after unconfirmed save without new write authorization", replay);
    if (!completed("b")) return result("UNPROVEN", "No completed later action opportunity following unconfirmed save");
    return result("PROVEN", "No patch replay attempted through the later completed turn, including blocked attempts");
  }
  if (check === "capacity-fit-effects" || check === "capacity-failure-effects") {
    const names = ["capacity predicate bound to one frozen request and complete response", "growth reserved once outside the full memory limit",
      ...(check === "capacity-fit-effects" ? ["all marked necessary candidates jointly fit within full memory limit", "all candidates together exceed memory limit (actual competition)", "all marked necessary candidates jointly retained in final memory"] :
        ["marked necessary set exceeds rendered memory limit", "at least one optional candidate fits within memory limit", "marked necessary set exceeding limit fails with CAPACITY without commit", "failed maintenance preserved prior saved memory/boundary", "continuation following capacity failure (failure-path recovery)"])];
    const missing = names.filter(n => !proven(n));
    return missing.length ? result("UNPROVEN", "Missing transaction qualification or effect evidence", { missing }) : result("PROVEN", "Qualified capacity mechanics observed; whether required declarations cover real dependencies remains a separate semantic judgment");
  }
  return result("UNPROVEN", "Unknown guidance check; no automatic pass");
}
