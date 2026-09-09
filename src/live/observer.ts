import { appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Control } from "./scenarios.js";

// Plain coordination state survives public resource reload; no old ctx is used after it.
export interface ObserverState { compacting?: boolean; ctx?: ExtensionContext; bases: WeakMap<Provider, Provider>; stop?: string; occurrence: number; triggerId?: string; held?: () => void; boundaryDone?: boolean; expectedFirst?: string; boundaryCommitted?: boolean; restorePending?: boolean; preBranchIds?: string[]; identityCut?: string }
const stateKey = Symbol.for("nunc.live.observer.reload-state");
const states: Map<string, ObserverState> = (process as any)[stateKey] ??= new Map();
export function observerState(source: string): ObserverState | undefined { return states.get(source); }
import { boundedProvider, BudgetLedger } from "./budget.js";
import { compactionAssociationStop, resolveCompactionIdentity } from "./compaction-identity.js";
import { RunnerError, requireValue, type RunInput } from "./contract.js";
import { authorizeVerification, toolPath } from "./tool-path.js";

function toolBlockReason(error: unknown, aborted: boolean): string {
  if (aborted || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))) return "Tool action after deadline";
  if (error instanceof RunnerError && error.code === "TOOL_COMMAND") return "Tool kind or command is outside authorization: only scenario-local read/write/edit and fixture verification command 'python3 verify.py' are permitted";
  if (error instanceof RunnerError && error.code.startsWith("SCRIPT_")) return error.message;
  if (error instanceof RunnerError && error.code === "TOOL_KIND") return "Tool kind is outside authorization";
  if (error instanceof RunnerError && error.code === "WRITE_SIZE") return "Artifact write exceeds bound";
  if (error instanceof RunnerError && error.code === "TOOL_PATH") return "Tool path is outside scenario task files";
  return "Tool action outside task scope or after deadline";
}

/** Explicit verification extension; loaded by the stock CLI, never a host factory. */
export default function observer(pi: ExtensionAPI): void {
  const source = process.env.NUNC_LIVE_OBSERVER;
  if (!source) throw new Error("Missing task-owned observer binding");
  // This private child file is written from the validated supervisor input. It
  // contains no credentials and is never passed to the model.
  const binding = JSON.parse(readFileSync(source, "utf8")) as { input: RunInput; models: Model<Api>[]; deadline: number; events: string; ledger: string; cwd: string; caseKey?: string; boundary?: { control: Control; requestText: string; fixtureContent: string }; boundaryCompleted?: boolean; verification?: { script: string; artifact: string } };
  const signal = AbortSignal.timeout(Math.max(1, binding.deadline - Date.now()));
  const log = (type: string, data: unknown) => appendFileSync(binding.events, JSON.stringify({ type, data }) + "\n", { mode: 0o600 });
  const ledger = new BudgetLedger(binding.ledger, binding.input.limits, binding.deadline, signal, binding.caseKey);
  const state = states.get(source) ?? { bases: new WeakMap<Provider, Provider>(), occurrence: 0, boundaryDone: binding.boundaryCompleted === true, boundaryCommitted: binding.boundaryCompleted === true };
  states.set(source, state);
  pi.on("session_start", (_event, ctx) => {
    state.ctx = ctx;
    for (const id of new Set(binding.models.map(m => m.provider))) {
      let base = ctx.modelRegistry.getProvider(id);
      requireValue(base, "MODEL", "Authorized native provider unavailable");
      while (state.bases.has(base)) base = state.bases.get(base)!;
      const decorated = boundedProvider(base, binding.models.filter(m => m.provider === id), ledger, {
        classify: simple => state.compacting || !simple ? "maintenance" : "main",
        beforeRequest: () => {
          if (state.stop) log("stopped", { code: "PREPARATION", message: state.stop });
          requireValue(!state.stop, "PREPARATION", state.stop ?? "Boundary preparation failed");
        },
        onRequest: data => log("request", { ...data, thinking: state.ctx?.thinkingLevel ?? null }),
        onPayload: data => log("request-cap", data),
        checkAuth: model => { if (model.provider === "openai-codex") requireValue(state.ctx!.modelRegistry.isUsingOAuth(model), "AUTHORIZATION", "Selected Codex route requires native OAuth in the isolated host"); },
        onContext: (model, context, kind) => log("context", { model, context, kind }),
        onResponse: (model, message, kind) => {
          if (kind === "maintenance") {
            const text = Array.isArray(message.content) ? message.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("") : "";
            let patch: unknown;
            try { patch = JSON.parse(text); } catch {}
            log("maintenance_response", { model: `${model.provider}/${model.id}`, stopReason: message.stopReason, patch, text });
          }
        },
      });
      state.bases.set(decorated, base);
      pi.registerProvider(decorated);
    }
    log("ready", { sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), model: ctx.model, thinking: ctx.thinkingLevel });
  });
  // The registry can wrap registered providers in models.json overlays, so object
  // identity alone cannot unwrap a prior decorator. Remove this registration at
  // public runtime teardown; the refreshed native registry remains auth/config owner.
  pi.on("session_shutdown", () => { for (const id of new Set(binding.models.map(m => m.provider))) pi.unregisterProvider(id); });
  pi.events.on("nunc:maintenance", event => log("maintenance", event));
  pi.events.on("nunc:admission", event => log("admission", event));
  pi.on("before_provider_request", event => {
    const payload = event.payload;
    log("payload", { mode: "observe", keys: payload && typeof payload === "object" && !Array.isArray(payload) ? Object.keys(payload) : [] });
  });
  pi.on("before_provider_request", event => event.payload);
  pi.on("session_before_compact", (event, ctx) => {
    state.compacting = true;
    log("preparation", { reason: event.reason, model: ctx.model, thinking: ctx.thinkingLevel,
      preparation: { ...event.preparation, fileOps: Object.fromEntries(Object.entries(event.preparation.fileOps).map(([k, v]) => [k, [...v]])) },
      branch: event.branchEntries, active: ctx.sessionManager.buildContextEntries() });
    if (binding.boundary && state.boundaryCommitted) state.stop ??= "E3 requested another automatic maintenance after the boundary; restored configuration cannot complete this suffix within one boundary transaction";
    if (binding.boundary && (!state.boundaryDone || state.expectedFirst && state.expectedFirst !== event.preparation.firstKeptEntryId)) state.stop ??= "Native preparation did not select the eligible tool boundary";
    log("lifecycle", { phase: "maintenance-start", reason: event.reason, willRetry: event.willRetry, boundaryDone: state.boundaryDone, expectedFirst: state.expectedFirst, stopped: state.stop });
    if (state.stop) return { cancel: true };
    state.preBranchIds = event.branchEntries.map(e => e.id);
    state.identityCut = event.preparation.firstKeptEntryId;
  });
  pi.on("session_compact", (event, ctx) => {
    state.compacting = false;
    const preBranchIds = state.preBranchIds, identityCut = state.identityCut;
    delete state.preBranchIds; delete state.identityCut;
    const rebuilt = ctx.sessionManager.buildContextEntries();
    const identity = resolveCompactionIdentity({
      preBranchIds, branch: ctx.sessionManager.getBranch(), rebuilt, reported: event.compactionEntry,
      ...(event.compactionEntry?.fromHook === true || identityCut === undefined ? {} : { expectedCut: identityCut }),
    });
    const association = identity.status === "resolved"
      ? { status: "resolved" as const, reportedId: identity.reportedId }
      : { status: "UNPROVEN" as const, reason: identity.reason, reportedId: identity.reportedId };
    log("commit", { reason: event.reason, reported: event.compactionEntry, rebuilt, association,
      ...(identity.status === "resolved" ? { snapshot: identity.snapshot } : {}) });
    if (identity.status !== "resolved") {
      state.stop ??= compactionAssociationStop(identity.reason);
      log("stopped", { code: "ASSOCIATION", message: state.stop });
    }
    if (state.expectedFirst) { state.boundaryCommitted = true; state.restorePending = true; }
    delete state.expectedFirst;
    log("lifecycle", { phase: "maintenance-end", reason: event.reason, willRetry: event.willRetry });
  });
  pi.on("session_compact_failed", event => {
    state.compacting = false;
    delete state.preBranchIds; delete state.identityCut;
    if (binding.boundary) state.stop ??= "Automatic boundary maintenance failed; suffix is unproven";
    log("lifecycle", { phase: "maintenance-failed", reason: event.reason, aborted: event.aborted, willRetry: event.willRetry });
  });
  pi.on("turn_end", async (event, ctx) => {
    if (!binding.boundary || state.boundaryDone || !state.triggerId || !event.toolResults.some(r => r.toolCallId === state.triggerId)) return;
    state.boundaryDone = true;
    const held = new Promise<void>(resolve => { state.held = resolve; });
    log("tool-boundary", { branch: ctx.sessionManager.getBranch(), active: ctx.sessionManager.buildContextEntries(),
      model: ctx.model, thinking: ctx.thinkingLevel, usage: ctx.getContextUsage(), triggerId: state.triggerId });
    // The command/reload path releases plain state. Do not touch ctx/pi after await.
    await held;
  });
  pi.on("tool_call", async (event, ctx) => {
    if (binding.boundary && !state.boundaryDone && event.toolName === binding.boundary.control.trigger?.toolName && typeof (event.input as any).path === "string" && resolve(binding.cwd, (event.input as any).path) === resolve(binding.cwd, binding.boundary.control.trigger.pathArgument)) {
      const user = ctx.sessionManager.getBranch().findLast(e => e.type === "message" && e.message.role === "user");
      const text = user?.type === "message" && user.message.role === "user" ? (typeof user.message.content === "string" ? user.message.content : user.message.content.filter(b => b.type === "text").map(b => b.text).join("")) : undefined;
      if (text === binding.boundary.requestText && ++state.occurrence === binding.boundary.control.trigger.occurrence) state.triggerId = event.toolCallId;
    }
    try {
      signal.throwIfAborted();
      if (event.toolName === "bash") {
        const cmd = typeof (event.input as any)?.command === "string" ? (event.input as any).command.trim() : "";
        requireValue(
          cmd === "python3 verify.py" || cmd === "/usr/bin/python3 verify.py" || cmd === "python verify.py",
          "TOOL_COMMAND",
          "Only authorized fixture verification command 'python3 verify.py' is permitted"
        );
        const caller = ctx.sessionManager.getBranch().findLast(e => e.type === "message" && e.message.role === "assistant" && e.message.content.some(b => b.type === "toolCall" && b.id === event.toolCallId));
        const writes = caller?.type === "message" && caller.message.role === "assistant" ? caller.message.content.flatMap(b => b.type === "toolCall" && ["write", "edit"].includes(b.name) ? [b.arguments.path] : []) : [];
        await authorizeVerification(binding.cwd, binding.verification?.script, writes);
        log("action", { type: "tool_call", toolName: event.toolName, toolCallId: event.toolCallId, input: event.input });
      } else {
        requireValue(["read", "write", "edit"].includes(event.toolName), "TOOL_KIND", "Only scenario-local read/write/edit/bash(verify.py) are authorized");
        await toolPath(binding.cwd, "path" in event.input ? event.input.path : undefined, event.toolName as "read" | "write" | "edit");
        if (event.toolName === "write") requireValue(typeof event.input.content === "string" && Buffer.byteLength(event.input.content) <= 1_000_000, "WRITE_SIZE", "Artifact write exceeds bound");
        log("action", { type: "tool_call", toolName: event.toolName, toolCallId: event.toolCallId, input: event.input });
      }
    } catch (error) {
      const reason = toolBlockReason(error, signal.aborted);
      log("action", { type: "tool_blocked", toolName: event.toolName, toolCallId: event.toolCallId, input: event.input, reason });
      return { block: true, reason };
    }
  });
  pi.on("tool_result", event => {
    let verification: unknown;
    if (binding.verification && event.toolName === "bash" && !event.isError) {
      try { verification = { scriptUnchanged: readFileSync(join(binding.cwd, "verify.py"), "utf8") === binding.verification.script,
        artifact: JSON.parse(readFileSync(join(binding.cwd, binding.verification.artifact), "utf8")) }; } catch { verification = { unavailable: true }; }
    }
    log("action", { type: "tool_result", toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError, content: event.content, verification });
  });
  pi.registerCommand("nunc-observer-reload", { handler: async (_args, ctx) => { await ctx.reload(); } });
  pi.registerCommand("nunc-observer-release", { handler: async args => {
    const decision = JSON.parse(args) as { firstKeptEntryId?: string; stop?: string; restored?: boolean };
    if (decision.stop) state.stop ??= decision.stop;
    if (decision.firstKeptEntryId) state.expectedFirst = decision.firstKeptEntryId;
    if (decision.restored) { state.restorePending = false; log("lifecycle", { phase: "boundary-config-restored" }); }
    state.held?.(); delete state.held;
  } });
  pi.registerCommand("nunc-observer-quit", { handler: async (_args, ctx) => ctx.shutdown() });
}
