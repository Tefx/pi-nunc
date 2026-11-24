import { appendFileSync, chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { createEditTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { access, readFile } from "node:fs/promises";
import type { Control, ToolTrigger } from "./scenarios.js";
import { memorySurface } from "../pi/manual.js";
import { setObserverMemoryLayout } from "../pi/projection.js";
import { userText, textOf } from "./guidance.js";
import { payloadThinking, subscriptionBilling } from "../engine/pi-model.js";
import { SYNTHETIC_LAST_USER_APPEND, SYNTHETIC_LAST_USER_APPEND_B, createAppendExtension } from "../pi/payload.js";


// Plain coordination state survives public resource reload; no old ctx is used after it.
export type BoundaryState = { occurrence: number; boundaryIndex?: number | undefined; held?: (() => void) | undefined } & (
  | { phase: "idle"; triggerId?: string }
  | { phase: "deferred"; triggerId: string }
  | { phase: "held"; triggerId: string }
  | { phase: "armed"; expectedFirst: string }
  | { phase: "committed" }
);
export interface ObserverState { boundary: BoundaryState; compacting?: boolean; ctx?: ExtensionContext; bases: WeakMap<Provider, Provider>; stop?: string; preBranchIds?: string[]; identityCut?: string; identityResultCut?: string; unconfirmedInjected?: boolean; unconfirmedFile?: string; unconfirmedMode?: number; unconfirmedCallId?: string; conflictInjected?: boolean }
const stateKey = Symbol.for("nunc.live.observer.reload-state");
const states: Map<string, ObserverState> = (process as any)[stateKey] ??= new Map();
import { boundedProvider, BudgetLedger } from "./budget.js";
import { compactionAssociationStop, resolveCompactionIdentity, type CompactionIdentityReason } from "./scenarios.js";
import { payloadAppendEnabled, payloadAppendBEnabled, providerWrapEnabled, taskRetentionSelection, taskRetentionRun, object, RunnerError, requireValue, type RunInput, type Selection } from "./contract.js";
import { authorizeVerification, metricsCommand, toolPath, resolveScenarioPath, VERIFY_COMMANDS } from "./tool-path.js";

export function toolBlockReason(error: unknown, aborted: boolean, context?: { isTaskRetention?: boolean; hasVerification?: boolean }): string {
  if (aborted || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))) return "Tool action after deadline";
  if (error instanceof RunnerError && error.code === "TOOL_COMMAND") {
    if (context?.isTaskRetention) {
      return "Tool kind or command is outside authorization: only scenario-local read/write/edit and task commands ('python3 build.py', 'python3 -m unittest ...', 'python3 solution.py', 'python3 scripts/validate_records.py') are permitted";
    }
    if (context?.hasVerification) {
      return "Tool kind or command is outside authorization: only scenario-local read/write/edit and fixture verification command 'python3 verify.py' are permitted";
    }
    return "Tool kind or command is outside authorization: only scenario-local read/write/edit tools are permitted";
  }
  if (error instanceof RunnerError && error.code.startsWith("SCRIPT_")) return error.message;
  if (error instanceof RunnerError && error.code === "TOOL_KIND") return "Tool kind is outside authorization";
  if (error instanceof RunnerError && error.code === "WRITE_SIZE") return "Artifact write exceeds bound";
  if (error instanceof RunnerError && error.code === "TOOL_PATH") return "Tool path is outside scenario task files";
  return "Tool action outside task scope or after deadline";
}

/** Explicit verification extension; loaded by the stock CLI, never a host factory. */
export default async function observer(pi: ExtensionAPI): Promise<void> {
  const source = process.env.NUNC_LIVE_OBSERVER;
  if (!source) throw new Error("Missing task-owned observer binding");
  // This private child file is written from the validated supervisor input. It
  // contains no credentials and is never passed to the model.
  const binding = JSON.parse(readFileSync(source, "utf8")) as { productExtension?: string; input: RunInput; models: Model<Api>[]; deadline: number; events: string; ledger: string; cwd: string; caseKey?: string; selection?: Selection; taskFiles?: Record<string, string>; larvaCompaction?: { owner: "nunc"; configFile: string }; boundaries?: Array<{ control: Control; turnOrdinal: number; requestText: string; fixtureContent: string }>; boundaryCompleted?: boolean; verification?: { script: string; artifact: string }; guidanceControls?: Array<{ action: "revision_conflict" | "unconfirmed_save"; turnOrdinal: number; requestText: string; turn?: string; trigger?: ToolTrigger }>; memoryLayout?: "stable" | "moving"; priorLedgers?: string[] };
  const boundaries = binding.boundaries ?? [];
  const activeBoundary = () => boundaries[state.boundary.boundaryIndex ?? 0];
  const currentTurn = (ctx: ExtensionContext) => {
    const users = ctx.sessionManager.getBranch().filter(e => e.type === "message" && e.message.role === "user");
    const user = users.at(-1);
    return { text: user ? userText(user) : undefined, ordinal: users.length };
  };
  const controlFor = (action: "revision_conflict" | "unconfirmed_save", ctx: ExtensionContext) => {
    const turn = currentTurn(ctx);
    return binding.guidanceControls?.find(c => c.action === action && c.requestText === turn.text && c.turnOrdinal === turn.ordinal);
  };
  const signal = AbortSignal.timeout(Math.max(1, binding.deadline - Date.now()));
  const log = (type: string, data: unknown) => appendFileSync(binding.events, JSON.stringify({ type, data }) + "\n", { mode: 0o600 });
  const ledger = new BudgetLedger(binding.ledger, binding.input.limits, binding.deadline, signal, binding.caseKey, binding.priorLedgers ?? []);
  const state = states.get(source) ?? { bases: new WeakMap<Provider, Provider>(), boundary: { occurrence: 0, phase: binding.boundaryCompleted ? "committed" : "idle" } };
  states.set(source, state);
  pi.on("session_start", (_event, ctx) => {
    setObserverMemoryLayout(binding.memoryLayout === "moving" ? "moving" : "stable");
    state.ctx = ctx;
    if (binding.larvaCompaction) {
      const selected = process.env.LARVA_PI_COMPACTION_CONFIG_FILE;
      let config: unknown;
      try { if (selected === binding.larvaCompaction.configFile) config = JSON.parse(readFileSync(selected, "utf8")); } catch { /* The bounded provider refuses before transport below. */ }
      const valid = object(config) && config.enabled === false;
      if (!valid) state.stop ??= "Task-local Larva compaction configuration unavailable";
      log("lifecycle", { phase: "larva-compaction-owner", owner: "nunc", configFile: binding.larvaCompaction.configFile, valid, enabled: object(config) ? config.enabled : null, scope: "isolated-task-child" });
    }
    const activeTools = pi.getActiveTools();
    const memoryToolsExposed = activeTools.includes("nunc_memory_read") && activeTools.includes("nunc_memory_patch");
    log("lifecycle", { phase: "session-tools", activeTools, memoryToolsExposed });
    const isTaskRetention = taskRetentionRun(binding.input);
    const maintenanceOverride = binding.input.overrides?.find(o => o.requirement === "maintenance-thinking" || (o as any).maintenanceThinking !== undefined);
    const maintenanceThinking = typeof (maintenanceOverride as any)?.maintenanceThinking === "string"
      ? (maintenanceOverride as any).maintenanceThinking
      : maintenanceOverride?.requirement === "maintenance-thinking"
        ? (binding.input.effective?.thinking ?? "low")
        : binding.selection?.id === "m5" ? binding.input.effective?.thinking : undefined;
    const effectiveThinking = binding.input.effective?.thinking;
    const requireThinkingLevel = isTaskRetention ? "low" : binding.selection?.id === "m5" ? effectiveThinking : undefined;
    for (const id of new Set(binding.models.map(m => m.provider))) {
      let base = ctx.modelRegistry.getProvider(id);
      requireValue(base, "MODEL", "Authorized native provider unavailable");
      while (state.bases.has(base)) base = state.bases.get(base)!;
      const decorated = boundedProvider(base, binding.models.filter(m => m.provider === id), ledger, {
        capturePayload: isTaskRetention || binding.input.scenarios.some(s => s.id.startsWith("m")),
        classify: simple => state.compacting || !simple ? "maintenance" : "main",
        maintenanceThinking,
        requireThinkingLevel,
        beforeRequest: () => {
          if (state.stop) log("stopped", { code: "PREPARATION", message: state.stop });
          requireValue(!state.stop, "PREPARATION", state.stop ?? "Boundary preparation failed");
        },
        onRequest: data => log("request", { ...data, thinking: state.ctx?.thinkingLevel ?? null }),
        onPayload: data => log("request-cap", { ...data, appliedThinking: payloadThinking(data.finalPayload) }),
        checkAuth: model => {
          const registry = state.ctx!.modelRegistry;
          if (model.provider === "openai-codex") requireValue(registry.isUsingOAuth(model), "AUTHORIZATION", "Selected Codex route requires native OAuth in the isolated host");
          log("auth-metadata", { model: `${model.provider}/${model.id}`, oauth: registry.isUsingOAuth(model), subscription: subscriptionBilling(model, registry) });
        },
        subscriptionBilling: model => subscriptionBilling(model, state.ctx!.modelRegistry),
        onContext: (model, context, kind) => log("context", { model, context, kind }),
        onResponse: (model, message, kind) => {
          if (kind === "maintenance") {
            const text = textOf(message.content);
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
  const restoreSaveFile = () => {
    if (!state.unconfirmedFile) return;
    chmodSync(state.unconfirmedFile, state.unconfirmedMode!);
    requireValue((statSync(state.unconfirmedFile).mode & 0o777) === state.unconfirmedMode, "CLEANUP", "Session file mode restoration failed");
    log("lifecycle", { phase: "save-file-restored", toolCallId: state.unconfirmedCallId, mode: state.unconfirmedMode });
    delete state.unconfirmedFile; delete state.unconfirmedMode;
  };
  pi.on("session_shutdown", () => {
    restoreSaveFile();
    for (const id of new Set(binding.models.map(m => m.provider))) pi.unregisterProvider(id);
  });
  pi.events.on("nunc:maintenance", event => {
    log("maintenance", event);
    const result = object(event) && object(event.result) ? event.result : undefined;
    if (result?.ok === true && object(result.candidate) && typeof result.candidate.firstKeptEntryId === "string") state.identityResultCut = result.candidate.firstKeptEntryId;
  });
  pi.events.on("nunc:admission", event => log("admission", event));
  pi.events.on("nunc:diagnostic", event => log("diagnostic", event));
  pi.events.on("nunc:live-provider-wrap", event => log("lifecycle", event));
  if (payloadAppendEnabled(binding.input)) createAppendExtension(SYNTHETIC_LAST_USER_APPEND)(pi);
  if (payloadAppendBEnabled(binding.input)) createAppendExtension(SYNTHETIC_LAST_USER_APPEND_B)(pi);
  if (providerWrapEnabled(binding.input)) {
    let settled = false, wrapped = false;
    pi.on("agent_settled", () => { settled = true; });
    pi.on("context", (_event, ctx) => {
      if (!settled || wrapped || !ctx.model) return;
      const previous = ctx.modelRegistry.getProvider(ctx.model.provider);
      if (!previous) return;
      wrapped = true;
      pi.registerProvider({ ...previous,
        stream: (model, context, options) => {
          pi.events.emit("nunc:live-provider-wrap", { phase: "provider-wrap-delegated", provider: model.provider, model: model.id, method: "stream" });
          return previous.stream(model, context, options);
        },
        streamSimple: (model, context, options) => {
          pi.events.emit("nunc:live-provider-wrap", { phase: "provider-wrap-delegated", provider: model.provider, model: model.id, method: "streamSimple" });
          return previous.streamSimple(model, context, options);
        },
      });
    });
  }
  pi.on("before_provider_request", event => {
    const payload = event.payload;
    log("payload", { mode: "observe", keys: payload && typeof payload === "object" && !Array.isArray(payload) ? Object.keys(payload) : [] });
  });
  pi.on("session_before_compact", (event, ctx) => {
    state.compacting = true;
    if (!state.stop) {
      state.preBranchIds = event.branchEntries.map(e => e.id);
      state.identityCut = event.preparation.firstKeptEntryId;
    }
    try {
      log("preparation", { reason: event.reason, model: ctx.model, thinking: ctx.thinkingLevel,
        preparation: { ...event.preparation, fileOps: Object.fromEntries(Object.entries(event.preparation.fileOps).map(([k, v]) => [k, [...v]])) },
        branch: event.branchEntries, active: ctx.sessionManager.buildContextEntries() });
      const autonomousTask = binding.selection?.id === "g4" && ["task-file", "same-task-history"].includes(String(binding.selection.variant)) && !activeBoundary();
      if (boundaries.length && !autonomousTask && (state.boundary.phase === "committed" || !activeBoundary())) state.stop ??= "Requested another automatic maintenance after the boundary; restored configuration cannot complete this suffix within one boundary transaction";
      if (boundaries.length && (!autonomousTask || state.boundary.phase === "armed") && (state.boundary.phase !== "armed" || state.boundary.expectedFirst !== event.preparation.firstKeptEntryId)) state.stop ??= "Native preparation did not select an armed eligible tool boundary";
      log("lifecycle", { phase: "maintenance-start", reason: event.reason, willRetry: event.willRetry, boundaryPhase: state.boundary.phase, expectedFirst: state.boundary.phase === "armed" ? state.boundary.expectedFirst : undefined, stopped: state.stop });
      if (state.stop) {
        delete state.preBranchIds; delete state.identityCut; delete state.identityResultCut;
        return { cancel: true };
      }
    } catch {
      // Freeze already captured. A later projection throw must not cancel persist.
    }
  });
  pi.on("session_compact", (event, ctx) => {
    state.compacting = false;
    const preBranchIds = state.preBranchIds, identityCut = state.identityCut, resultCut = state.identityResultCut;
    delete state.preBranchIds; delete state.identityCut; delete state.identityResultCut;
    const refuse = (reason: CompactionIdentityReason, rebuilt?: unknown) => {
      state.stop ??= compactionAssociationStop(reason);
      log("commit", { reason: event.reason, reported: event.compactionEntry, association: { status: "UNPROVEN" as const, reason, reportedId: event.compactionEntry?.id ?? null }, ...(rebuilt !== undefined ? { rebuilt } : {}) });
      log("stopped", { code: "ASSOCIATION", message: state.stop });
    };
    try {
      const rebuilt = ctx.sessionManager.buildContextEntries();
      const identity = resolveCompactionIdentity({
        preBranchIds, branch: ctx.sessionManager.getBranch(), rebuilt, reported: event.compactionEntry,
        ...(event.compactionEntry?.fromHook === true || identityCut === undefined ? {} : { expectedCut: identityCut }),
        ...(event.compactionEntry?.fromHook === true && resultCut !== undefined ? { resultCut } : {}),
      });
      if (identity.status !== "resolved") refuse(identity.reason, rebuilt);
      else log("commit", { reason: event.reason, reported: event.compactionEntry, rebuilt, snapshot: identity.snapshot, association: { status: "resolved" as const, reportedId: identity.reportedId } });
    } catch {
      refuse("inconsistent-cut-or-result");
    }
    if (state.boundary.phase === "armed") state.boundary = { occurrence: state.boundary.occurrence, boundaryIndex: state.boundary.boundaryIndex, phase: "committed" };
    log("lifecycle", { phase: "maintenance-end", reason: event.reason, willRetry: event.willRetry });
  });
  pi.on("session_compact_failed", event => {
    state.compacting = false;
    delete state.preBranchIds; delete state.identityCut; delete state.identityResultCut;
    if (boundaries.length) state.stop ??= "Automatic boundary maintenance failed; suffix is unproven";
    log("lifecycle", { phase: "maintenance-failed", reason: event.reason, aborted: event.aborted, willRetry: event.willRetry,
      errorMessage: event.errorMessage, fromExtension: event.fromExtension });
  });
  pi.on("message_end", event => {
    if (event.message.role !== "assistant") return;
    for (const block of event.message.content) if (block.type === "toolCall") {
      log("action", { type: "tool_intent", toolName: block.name, toolCallId: block.id, input: block.arguments });
    }
  });
  pi.on("turn_end", async (event, ctx) => {
    const currentBnd = activeBoundary();
    const boundary = state.boundary;
    if (!currentBnd || (boundary.phase !== "idle" && boundary.phase !== "deferred")) return;
    const isTriggerTurn = Boolean(boundary.triggerId && event.toolResults.some(r => r.toolCallId === boundary.triggerId));
    const isDeferredTurn = boundary.phase === "deferred" && event.toolResults.length > 0;
    if ((!isTriggerTurn && !isDeferredTurn) || !boundary.triggerId) return;
    const triggerId = boundary.triggerId;
    state.boundary = { occurrence: boundary.occurrence, boundaryIndex: boundary.boundaryIndex, phase: "held", triggerId };
    const held = new Promise<void>(resolve => { state.boundary.held = resolve; });
    log("tool-boundary", { branch: ctx.sessionManager.getBranch(), active: ctx.sessionManager.buildContextEntries(),
      model: ctx.model, thinking: ctx.thinkingLevel, usage: ctx.getContextUsage(), triggerId, boundaryIndex: state.boundary.boundaryIndex ?? 0 });
    // The command/reload path releases plain state. Do not touch ctx/pi after await.
    await held;
  });
  pi.on("tool_call", async (event, ctx) => {
    const currentBnd = activeBoundary();
    if (currentBnd && (state.boundary.phase === "idle" || state.boundary.phase === "deferred") && (event.toolName === currentBnd.control.trigger?.toolName || event.toolName === currentBnd.control.trigger?.alternateToolName) &&
        typeof (event.input as any).path === "string" && currentBnd.control.trigger?.pathArgument && resolveScenarioPath(binding.cwd, (event.input as any).path) === resolveScenarioPath(binding.cwd, currentBnd.control.trigger.pathArgument)) {
      const turn = currentTurn(ctx);
      if (turn.text === currentBnd.requestText && turn.ordinal === currentBnd.turnOrdinal && ++state.boundary.occurrence === currentBnd.control.trigger.occurrence) {
        state.boundary.triggerId = event.toolCallId;
      }
    }
    try {
      signal.throwIfAborted();
      if (event.toolName === "bash") {
        const cmd = typeof (event.input as any)?.command === "string" ? (event.input as any).command.trim() : "";
        const isTaskRetention = Boolean(binding.selection?.id === "g4" && taskRetentionSelection(binding.selection));
        const hasVerification = Boolean(binding.verification !== undefined);
        const isVerify = hasVerification && !isTaskRetention && VERIFY_COMMANDS.includes(cmd);
        if (!hasVerification && !isTaskRetention && VERIFY_COMMANDS.includes(cmd)) throw new RunnerError("SCRIPT_UNPROVIDED", "No fixture verification script was provided");
        const taskCommand = isTaskRetention ? metricsCommand(cmd) : undefined;
        const isTaskCommand = taskCommand !== undefined;
        requireValue(
          isVerify || isTaskCommand,
          "TOOL_COMMAND",
          isTaskRetention
            ? "Only authorized task commands ('python3 build.py', 'python3 -m unittest ...', 'python3 solution.py', 'python3 scripts/validate_records.py') are permitted"
            : hasVerification
            ? "Only fixture verification command 'python3 verify.py' is permitted"
            : "No bash commands are permitted"
        );
        const isBuildScript = typeof cmd === "string" && /(?:^|\s)(?:\.\/)?build\.py$/.test(cmd);
        const isValidateScript = typeof cmd === "string" && /(?:^|\s)(?:\.\/)?scripts\/validate_records\.py$/.test(cmd);
        if (isVerify || isBuildScript || isValidateScript) {
          const caller = ctx.sessionManager.getBranch().findLast(e => e.type === "message" && e.message.role === "assistant" && e.message.content.some(b => b.type === "toolCall" && b.id === event.toolCallId));
          const writes = caller?.type === "message" && caller.message.role === "assistant" ? caller.message.content.flatMap(b => b.type === "toolCall" && ["write", "edit"].includes(b.name) ? [b.arguments.path] : []) : [];
          const scriptName = isVerify ? "verify.py" : isBuildScript ? "build.py" : "scripts/validate_records.py";
          await authorizeVerification(binding.cwd, isVerify ? binding.verification?.script : binding.taskFiles?.[scriptName], writes, scriptName);
        }
        log("action", { type: "tool_call", toolName: event.toolName, toolCallId: event.toolCallId, input: event.input });
      } else if (event.toolName === "nunc_memory_read" || event.toolName === "nunc_memory_patch") {
        const before = memorySurface(pi)?.read(ctx);
        if (before) log("memory_state", { phase: "before", toolCallId: event.toolCallId, revision: before.revision, slots: before.memory.slots, unconfirmed: before.status.unconfirmed });
        if (event.toolName === "nunc_memory_patch") {
          const unconfirmedCtrl = controlFor("unconfirmed_save", ctx);
          if (unconfirmedCtrl && !state.unconfirmedInjected) {
            state.unconfirmedInjected = true;
            const sessionFile = ctx.sessionManager.getSessionFile();
            if (sessionFile && existsSync(sessionFile)) {
              state.unconfirmedMode = statSync(sessionFile).mode & 0o777;
              state.unconfirmedFile = sessionFile;
              state.unconfirmedCallId = event.toolCallId;
              chmodSync(sessionFile, state.unconfirmedMode & ~0o222);
              log("lifecycle", { phase: "save-file-readonly", toolCallId: event.toolCallId });
            }
          }
        }
        log("action", { type: "tool_call", toolName: event.toolName, toolCallId: event.toolCallId, input: event.input });
      } else {
        requireValue(["read", "write", "edit"].includes(event.toolName), "TOOL_KIND", "Only scenario-local read/write/edit/bash(verify.py) and nunc_memory_* tools are authorized");
        await toolPath(binding.cwd, "path" in event.input ? event.input.path : undefined, event.toolName as "read" | "write" | "edit");
        if (event.toolName === "write") requireValue(typeof event.input.content === "string" && Buffer.byteLength(event.input.content) <= 1_000_000, "WRITE_SIZE", "Artifact write exceeds bound");
        if (event.toolName === "edit") {
          // Use the host's matching, BOM and line-ending semantics without writing.
          const preview = createEditTool(binding.cwd, { operations: {
            access,
            readFile,
            writeFile: async (_path, content) => {
              requireValue(Buffer.byteLength(content) <= 1_000_000, "WRITE_SIZE", "Artifact write exceeds bound");
            },
          } });
          await preview.execute(event.toolCallId, event.input as { path: string; edits: Array<{ oldText: string; newText: string }> }, signal);
        }
        log("action", { type: "tool_call", toolName: event.toolName, toolCallId: event.toolCallId, input: event.input });
      }
    } catch (error) {
      const isTaskRetention = Boolean(binding.selection?.id === "g4" && taskRetentionSelection(binding.selection));
      const hasVerification = Boolean(binding.verification?.script !== undefined);
      const reason = toolBlockReason(error, signal.aborted, { isTaskRetention, hasVerification });
      log("action", { type: "tool_blocked", toolName: event.toolName, toolCallId: event.toolCallId, input: event.input, reason });
      return { block: true, reason };
    }
  });
  pi.on("tool_result", async (event, ctx) => {
    if (state.unconfirmedFile && event.toolCallId === state.unconfirmedCallId) {
      restoreSaveFile();
      const details = event.details as any;
      if (details?.ok === false && details.code === "unconfirmed") {
        log("lifecycle", { phase: "unconfirmed-injected", toolCallId: event.toolCallId, code: details.code });
      }
    }
    if (event.toolName === "nunc_memory_patch" && state.conflictInjected && (event.details as any)?.ok === false && (event.details as any)?.code === "conflict") {
      log("lifecycle", { phase: "revision-conflict-injected", toolCallId: event.toolCallId });
    }
    if (event.toolName === "nunc_memory_read" && event.isError === false) {
      const conflictCtrl = controlFor("revision_conflict", ctx);
      if (conflictCtrl && !state.conflictInjected) {
        state.conflictInjected = true;
        const surface = memorySurface(pi);
        if (surface) {
          const before = surface.read(ctx);
          const text = binding.selection && taskRetentionSelection(binding.selection) ? before.memory.slots[0]?.text : "Checklist source is notes.txt.";
          if (text) {
            const saved = surface.patch(ctx, { expectedRevision: before.revision, add: [{ key: "concurrent", text }] });
            log("lifecycle", { phase: "concurrent-save", toolCallId: event.toolCallId, beforeRevision: before.revision, sourceSlots: before.memory.slots, saved });
          } else log("lifecycle", { phase: "conflict-premise-unavailable", toolCallId: event.toolCallId });
        }
      }
    }
    let verification: unknown;
    if (binding.verification && event.toolName === "bash" && !event.isError) {
      try { verification = { scriptUnchanged: readFileSync(join(binding.cwd, "verify.py"), "utf8") === binding.verification.script,
        artifact: JSON.parse(readFileSync(join(binding.cwd, binding.verification.artifact), "utf8")) }; } catch { verification = { unavailable: true }; }
    }
    log("action", { type: "tool_result", toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError, content: event.content, details: (event as any).details, verification });
    if (event.toolName === "nunc_memory_read" || event.toolName === "nunc_memory_patch") {
      try {
        const surface = memorySurface(pi);
        if (surface && ctx) {
          const view = surface.read(ctx);
          log("memory_state", {
            phase: "after", toolCallId: event.toolCallId,
            revision: view.revision,
            slotCount: view.memory.slots.length,
            slots: view.memory.slots,
            unconfirmed: view.status.unconfirmed,
            occupied: view.status.occupied,
            budget: view.budget,
          });
        }
      } catch { /* ignore */ }
    }
  });
  pi.registerCommand("nunc-observer-note-opportunity", { handler: async (_args, ctx) => {
    requireValue(binding.selection?.id === "g4" && binding.selection.variant === "active-edit" && binding.input.overrides?.some(o => o.requirement === "mixed-note-opportunity"), "PREPARATION", "No selected controlled note opportunity");
    const surface = memorySurface(pi), before = surface?.read(ctx);
    if (!surface || !before || before.memory.slots.length < 2) {
      log("action", { type: "note_opportunity", established: false, reason: "Fewer than two generated notes; no text added" }); return;
    }
    const text = before.memory.slots.map(s => s.text).join("\n\n");
    const saved = surface.patch(ctx, { expectedRevision: before.revision, remove: before.memory.slots.map(s => s.id), add: [{ key: "mixed", text }, { key: "duplicate", text }] });
    log("action", { type: "note_opportunity", established: saved.ok, source: before, saved, after: surface.read(ctx), semantics: "UNPROVEN: verify differing validity from source notes; no missing condition was supplied" });
  } });
  pi.registerCommand("nunc-observer-reload", { handler: async (_args, ctx) => { await ctx.reload(); } });
  pi.registerCommand("nunc-observer-release", { handler: async args => {
    const decision = JSON.parse(args) as { firstKeptEntryId?: string; stop?: string; restored?: boolean; deferred?: boolean };
    if (decision.stop) state.stop ??= decision.stop;
    if (decision.firstKeptEntryId) {
      state.boundary = { occurrence: state.boundary.occurrence, boundaryIndex: state.boundary.boundaryIndex, held: state.boundary.held, phase: "armed", expectedFirst: decision.firstKeptEntryId };
    }
    if (decision.restored) {
      const held = state.boundary.held;
      state.boundary = { occurrence: 0, phase: "idle", boundaryIndex: (state.boundary.boundaryIndex ?? 0) + 1, ...(held ? { held } : {}) };
      log("lifecycle", { phase: "boundary-config-restored", nextBoundaryIndex: state.boundary.boundaryIndex });
    }
    if (decision.deferred) {
      requireValue(state.boundary.phase === "held", "PREPARATION", "Only a held tool boundary can defer");
      state.boundary = { ...state.boundary, phase: "deferred" };
      log("lifecycle", { phase: "boundary-deferred", boundaryIndex: state.boundary.boundaryIndex ?? 0 });
    }
    state.boundary.held?.(); delete state.boundary.held;
  } });
  pi.registerCommand("nunc-observer-quit", { handler: async (_args, ctx) => ctx.shutdown() });
  // Compose the public product factory between observation and restoration.
  // The bounded provider and frozen prestate must precede Nunc; its commit
  // handlers must finish before the restore hold reloads resources.
  if (binding.productExtension) {
    const product = await import(pathToFileURL(binding.productExtension).href) as { default: (api: ExtensionAPI) => void | Promise<void> };
    await product.default(pi);
  }
  pi.on("session_compact", async () => {
    if (state.boundary.phase !== "committed" || !boundaries.length || !activeBoundary()) return;
    const held = new Promise<void>(resolve => { state.boundary.held = resolve; });
    log("boundary-restore", {});
    await held;
  });
}
