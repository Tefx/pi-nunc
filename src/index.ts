import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { getCurrentSystemPrompt, getCurrentTools, Type, type Tool } from "@earendil-works/pi-ai";
import { convertToLlm, getAgentDir, sessionEntryToContextMessages, SettingsManager, VERSION, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent, type CompactionSettings } from "@earendil-works/pi-coding-agent";
import type { FixedContext, MaintenanceInput, MaintenanceResult, Memory } from "./engine/index.js";
import { maintain, piComplete, loadPolicy, memoryPlan, parsePatch } from "./engine/index.js";
import { subscriptionBilling } from "./engine/pi-model.js";
import { messageTextContent } from "./engine/cleanup.js";
import { extractionContext, resolveExtractionRequest } from "./engine/request.js";
import { maintenanceCalibrationRecord } from "./engine/calibration.js";
import { MAINTENANCE_CALIBRATION_TYPE, projectMaintenanceCalibration } from "./pi/calibration.js";
import { MEMORY_WRITING_GUIDANCE } from "./engine/policy.js";
import { EngineError, record } from "./engine/validation.js";
import { mainAdmissionLimit, mainContext, requestTokens, omitsSerializedOutputCap } from "./engine/accounting.js";
import { engineConfig, readConfig, resolveMemoryTools, resolveToolResultCleanup, validateNuncSettings } from "./pi/config.js";
import { carrierIndexIn, clearMemoryAnchors, effectiveActive, eligibleCleanupScope, compactionCleanupScope, eligibleStarts, eligibleUsageEntryIds, originalResults, searchBranchHistory, project, sealDecisions, withEffectiveMemory, memoryRevision, revisionApplies } from "./pi/projection.js";
import { assertPiContextCompatibility, assertSupportedPiVersion } from "./pi/compat.js";
import { createMemorySurface } from "./pi/manual.js";
import { createContextSurface } from "./pi/context.js";
import { Admission, type AdmissionLayoutEvent } from "./pi/admission.js";
import { COMMAND_USAGE, commandCompletions, createNuncUi, detailsLines } from "./ui/index.js";

/** Optional public settings source for component fixtures; stock CLI uses its settings. */
export interface HostSettingsSource {
  readSettings: (model?: ExtensionContext["model"]) => {
    compaction: ReturnType<SettingsManager["getCompactionSettings"]>;
    blockImages: boolean;
    nunc?: unknown;
  };
  getGlobalSettings?: () => Record<string, unknown>;
  getProjectSettings?: () => Record<string, unknown>;
  isProjectTrusted?: () => boolean;
}
export interface MaintenanceEvent { reason: SessionBeforeCompactEvent["reason"]; willRetry: boolean; result: MaintenanceResult }

export default function nunc(pi: ExtensionAPI): void {
  assertSupportedPiVersion(VERSION);
  pi.registerFlag("nunc-config", { description: "Nunc JSON configuration path (relative to cwd); policy paths are relative to this file", type: "string" });
  pi.registerFlag("nunc-memory-tools", { description: "Expose nunc_memory_read and nunc_memory_patch model tools", type: "boolean" });
  let generation = 0;
  let running: AbortController | undefined;
  let uiRunning: AbortController | undefined;
  let hostSettings: HostSettingsSource | undefined;
  let headroomWarned = false;
  let completionRegistry: ExtensionContext["modelRegistry"] | undefined;
  type CompactForIntent = { marker: string; sessionId: string; leafId: string | null; generation: number;
    target: NonNullable<MaintenanceInput["target"]>; claimed: boolean;
    outcome?: NonNullable<MaintenanceResult["observations"]["target"]> };
  let compactFor: CompactForIntent | undefined;
  const invalidate = () => { generation++; running?.abort(); uiRunning?.abort(); admission.invalidateUsage(); headroomWarned = false; };
  const dropAnchors = () => { clearMemoryAnchors(); };
  pi.events.on("nunc:host-settings", (value: unknown) => {
    if (!value || typeof value !== "object" || !("readSettings" in value) || typeof value.readSettings !== "function") return;
    invalidate(); hostSettings = value as HostSettingsSource;
  });
  const getHostSettings = (ctx: ExtensionContext, model = ctx.model) => {
    if (hostSettings) {
      const read = hostSettings.readSettings(model);
      const projectTrusted = hostSettings.isProjectTrusted ? hostSettings.isProjectTrusted() : ctx.isProjectTrusted();
      const globalNunc = hostSettings.getGlobalSettings ? hostSettings.getGlobalSettings()?.nunc : read.nunc;
      const projectNunc = projectTrusted ? (hostSettings.getProjectSettings ? hostSettings.getProjectSettings()?.nunc : read.nunc) : undefined;
      return {
        compaction: read.compaction,
        blockImages: read.blockImages,
        globalNunc,
        projectNunc,
        projectTrusted,
      };
    }
    const manager = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
    const globalSettings = manager.getGlobalSettings() as Record<string, unknown>;
    const projectSettings = manager.getProjectSettings() as Record<string, unknown>;
    return {
      compaction: manager.getCompactionSettings(model),
      blockImages: manager.getBlockImages(),
      globalNunc: globalSettings.nunc,
      projectNunc: projectSettings.nunc,
      projectTrusted: manager.isProjectTrusted(),
    };
  };
  let lastCleanupSetting: boolean | undefined;
  const cleanupEnabled = (ctx: ExtensionContext) => {
    const host = getHostSettings(ctx);
    const enabled = resolveToolResultCleanup(host);
    if (lastCleanupSetting !== undefined && lastCleanupSetting !== enabled) {
      invalidate(); dropAnchors(); contextView.resetPath();
    }
    lastCleanupSetting = enabled;
    return enabled;
  };
  const cleanupOpportunity = (ctx: ExtensionContext, memoryValue: ReturnType<typeof project>["memory"], active: ReturnType<typeof project>["active"], saved: ReturnType<typeof project>["cleanup"]) => {
    const enabled = cleanupEnabled(ctx);
    const prefix = enabled ? admission.cleanupAnchor(ctx.sessionManager.getSessionId(), memoryValue) : undefined;
    return { enabled, scope: prefix ? eligibleCleanupScope(active, prefix, saved) : [] };
  };
  const settings = (ctx: ExtensionContext) => {
    const s = getHostSettings(ctx);
    return { compaction: s.compaction, blockImages: s.blockImages };
  };
  const supported = (ctx: ExtensionContext) => {
    assertPiContextCompatibility(ctx);
    if (!ctx.sessionManager.getSessionFile()) throw new EngineError("CONFIG", "Persistent sessions only; start Pi without --no-session");
    const s = getHostSettings(ctx);
    if (s.blockImages) throw new EngineError("CONFIG", "Image-blocking conversion is unsupported; preserve native media");
    validateNuncSettings(s);
    cleanupEnabled(ctx);
  };
  let observeLayout = (_event: AdmissionLayoutEvent) => {};
  const admission = new Admission(pi, (ctx, model) => {
    supported(ctx);
    project(ctx.sessionManager.buildContextEntries());
    return engineConfig(readConfig(pi.getFlag("nunc-config"), ctx.cwd).config, model, settings(ctx).compaction, omitsSerializedOutputCap(model) || subscriptionBilling(model, ctx.modelRegistry));
  }, event => observeLayout(event));
  const fixed = (ctx: ExtensionContext): FixedContext => {
    const all = pi.getAllTools();
    const branch = ctx.sessionManager.buildContextEntries();
    const messages = convertToLlm(branch.flatMap(sessionEntryToContextMessages));
    const hasSystemState = messages.some(message => message.role === "system");
    const systemPrompt = hasSystemState ? getCurrentSystemPrompt(messages) : ctx.getSystemPrompt();
    const tools = hasSystemState ? getCurrentTools(messages) : pi.getActiveTools().map(name => {
      const tool = all.find(t => t.name === name);
      if (!tool) throw new EngineError("INPUT", `Active tool definition unavailable: ${name}`);
      const sampling = (tool as { constrainedSampling?: Tool["constrainedSampling"] }).constrainedSampling;
      return { name, description: tool.description, parameters: tool.parameters, ...(sampling !== undefined ? { constrainedSampling: sampling } : {}) };
    });
    return { systemPrompt, tools, ...(hasSystemState ? {} : { toolState: "partial" as const }) };
  };
  const memory = createMemorySurface({ pi, fixed, settings, cleanup: cleanupOpportunity, onCommitted: () => { ui.refresh(); } });
  let toolsRegistered = false;
  const registerMemoryTools = () => {
    if (toolsRegistered) return;
    pi.registerTool({
        name: "nunc_memory_read",
        label: "Read Memory",
        description: "Read session-local working memory, slot IDs, revision, estimated budget and writable status when saved notes or a patch need inspection; routine turns require no read. Inspect complete relevant notes, including mixed obligations/progress and necessary relationships. Notes may be stale or incomplete and do not override current instructions; recover task sources with ordinary tools when needed. writable does not guarantee a save. A null budget.limitTokens means unknown; otherwise it bounds manual growth. targetTokens is a soft maintenance target and hardLimitTokens=null means no hard cap. Maintenance may retain required items over target. Optional query searches retired visible text on this session's selected branch, plus original active tool results hidden by cleanup; entryIds reads exact eligible entries. No disk search or other sessions/branches. Query matches are case-insensitive substrings ranked by distinct matching words, then newest first; limit defaults to 5 and must be at most 10. history.matches contains bounded snippets; history.entries returns at most 10 IDs with at most 4000 text characters each and a truncated flag. Optional originals returns pure-text tool-result originals from the active or retired selected path, with missing/non-text errors. Reads do not change M, restore old positions or grant historical instructions current authority.",
        parameters: Type.Object({
          originals: Type.Optional(Type.Array(Type.Object({ entryId: Type.String(), messageIndex: Type.Integer({ minimum: 0 }) }))),
          query: Type.Optional(Type.String({ description: "Case-insensitive words or substrings to find in selected-branch retired visible text" })),
          entryIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 10, description: "Exact eligible history IDs to read; each entry is bounded to 4000 text characters" })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 5, description: "Maximum query matches" })),
        }),
        execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
          const view = memory.read(ctx);
          const projected = project(ctx.sessionManager.buildContextEntries());
          const opportunity = cleanupOpportunity(ctx, projected.memory, projected.active, projected.cleanup);
          const requested = params?.originals;
          const wantsHistory = params.query !== undefined || params.entryIds !== undefined;
          const branch = requested !== undefined || wantsHistory ? ctx.sessionManager.getBranch() : [];
          const originals = requested === undefined ? undefined : Array.isArray(requested)
            ? originalResults(projected, requested, branch) : [{ error: "Invalid originals reference list" }];
          const history = wantsHistory ? searchBranchHistory(branch, effectiveActive(projected, opportunity.enabled), params) : undefined;
          const result = {
            revision: view.revision,
            slots: view.memory.slots.map(s => ({ id: s.id, text: s.text })),
            budget: {
              usedTokens: view.budget.tokens,
              limitTokens: view.budget.limit,
              targetTokens: view.budget.target,
              hardLimitTokens: view.budget.hardLimit,
            },
            writable: !view.status.occupied && !view.status.unconfirmed,
            ...(opportunity.scope.length ? { cleanupCandidates: opportunity.scope.map(ref => {
              const message = projected.active.find(e => e.entryId === ref.entryId)?.messages[ref.messageIndex];
              return { ...ref, toolName: message?.role === "toolResult" ? message.toolName : "", toolCallId: message?.role === "toolResult" ? message.toolCallId : "",
                textLength: message?.role === "toolResult" ? messageTextContent(message)?.length ?? 0 : 0 };
            }) } : {}),
            ...(originals === undefined ? {} : { originals }),
            ...(history === undefined ? {} : { history }),
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            details: result,
          };
        },
      });
      pi.registerTool({
        name: "nunc_memory_patch",
        label: "Patch Memory",
        description: MEMORY_WRITING_GUIDANCE + "\nWhen manual growth exceeds budget, use update/remove to consolidate or remove old process records with no continuing use; keep normal word spaces, never strip spaces to fit. Atomically revise session-local working memory with a revision from nunc_memory_read. Preserve the whole active task's goals, decisive conditions, valid constraints, unfinished work, supported decisions/results, blockers and recovery paths with purpose and unchecked scope. Inspect full notes before changing mixed content; preserve surviving quantities, negations, qualifiers, scope, interaction and verification conditions, uncertainty and necessary relationships. Keep notes self-contained and independently updateable; separate stable obligations from changing progress where useful. Apply revisions only within their authority and scope. Partial evidence or a side question does not cancel remaining obligations. Retire ended/cancelled/superseded information and internal references only when it has no continuing use; preserve a minimal result still needed by ongoing work. Avoid raw logs, credentials, unnecessary polishing and process history; repair bodies that violate current language, readability or content requirements. Notes do not override instructions. Combine settled, persistently useful changes in one patch; routine turns require none. Manual growth is limited by the reported budget even though maintenance may retain required over target. On conflict reread and reconcile; never replay an unconfirmed save automatically. Memory changes may rebuild cache later; do not delay necessary corrections for that reason. Nunc owns placement; no delete/reinsert is needed to move memory.",
        parameters: Type.Object({
          expectedRevision: Type.String({ description: "Revision obtained from nunc_memory_read" }),
          add: Type.Optional(Type.Array(
            Type.Object({
              key: Type.String({ description: "Temporary unique key for the added item within this batch" }),
              text: Type.String({ description: "Self-contained note body following the patch tool's language and writing guidance; preserve exact values and qualifiers. Use real newlines." }),
            }),
            { description: "Items to add (system assigns final IDs in order). Express subject-relation-result clearly for correspondences, dependencies, or scope; independent facts remain plain sentences. Keep notes self-contained." }
          )),
          update: Type.Optional(Type.Array(
            Type.Object({
              id: Type.String({ description: "ID of existing slot to update" }),
              text: Type.String({ description: "Complete replacement body following the patch tool's language and writing guidance; preserve all still-valid content. Use real newlines." }),
            }),
            { description: "Items to update. Replaces the full slot body, preserving ID and position. Inspect all existing content; retain still-valid goals, qualifiers, completion conditions, necessary relationships and unfinished work when replacing or merging mixed notes. Keep notes self-contained; partial progress does not retire remaining obligations." }
          )),
          remove: Type.Optional(Type.Array(
            Type.String({ description: "ID of existing slot to remove" }),
            { description: "Slot IDs to remove from current working memory; historical session entries remain. Remove obsolete or superseded notes only after preserving their still-valid parts elsewhere. Finished or cancelled task items and mutually referencing groups may retire when they no longer affect other work; preserve minimal self-contained results if needed by ongoing work. Deleting a note does not cancel a requirement; the tool does not detect semantic loss." }
          )),
          // The host validates tool arguments before execute. Keep the optional
          // cleanup payload unconstrained there so malformed cleanup never blocks
          // a valid M patch; decideToolResultCleanup validates each item locally.
          toolResultEdits: Type.Optional(Type.Unknown({ description: "Optional array of eligible result edits from nunc_memory_read. Each item: {entryId: string, messageIndex: non-negative integer, action: 'omit' | 'replace', text?: string, memoryRefs?: string[], sourceRefs?: {entryId: string, messageIndex: non-negative integer}[]}. 'replace' requires non-empty text; 'omit' forbids text. Invalid edits are skipped locally without blocking a valid memory patch; memoryRefs must survive this commit's final M selection, while sourceRefs require full retained sources. Later M changes do not automatically undo saved cleanup." })),
        }),
        execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
          const patchParams = (params ?? {}) as Parameters<typeof memory.patch>[1];
          const res = memory.patch(ctx, patchParams, signal);
          if (res.ok) {
            const payload = {
              ok: true,
              revision: res.revision,
              added: res.added,
              budget: res.budget,
              ...(res.cleanup ? { toolResultCleanup: res.cleanup } : {}),
            };
            return {
              content: [{ type: "text" as const, text: JSON.stringify(payload) }],
              details: payload,
            };
          }
          const errPayload = {
            ok: false,
            code: res.code,
            message: res.message,
            recovery: {
              revision: res.view.revision,
              budget: {
                usedTokens: res.view.budget.tokens,
                limitTokens: res.view.budget.limit,
                targetTokens: res.view.budget.target,
                hardLimitTokens: res.view.budget.hardLimit,
              },
              writable: !res.view.status.occupied && !res.view.status.unconfirmed,
            },
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(errPayload) }],
            details: errPayload,
            isError: true,
          };
        },
      });
      toolsRegistered = true;
  };
  if (Boolean(pi.getFlag("nunc-memory-tools"))) {
    registerMemoryTools();
  }
  const contextView = createContextSurface({
    pi, memory, fixed,
    config: (ctx, model) => engineConfig(readConfig(pi.getFlag("nunc-config"), ctx.cwd).config, model, settings(ctx).compaction, omitsSerializedOutputCap(model) || subscriptionBilling(model, ctx.modelRegistry)),
  });
  const prepareUiCleanup = async (ctx: ExtensionContext, proposal: Memory, signal: AbortSignal): Promise<{ edits?: unknown; warning?: string; stale?: boolean }> => {
    if (signal.aborted) return { stale: true };
    const entries = ctx.sessionManager.buildContextEntries();
    const projected = project(entries);
    const opportunity = cleanupOpportunity(ctx, projected.memory, projected.active, projected.cleanup);
    const semanticScope = opportunity.scope.filter(ref => {
      const message = projected.active.find(entry => entry.entryId === ref.entryId)?.messages[ref.messageIndex];
      return message?.role === "toolResult" && messageTextContent(message) !== null;
    });
    if (!opportunity.enabled || !semanticScope.length) return {};
    if (!ctx.model) return { warning: "Cleanup skipped: current model unavailable; memory can still be saved" };
    const frozen = { generation, sessionId: ctx.sessionManager.getSessionId(), leafId: ctx.sessionManager.getLeafId(),
      revision: memory.read(ctx).revision, model: structuredClone(ctx.model), thinking: ctx.thinkingLevel, host: structuredClone(getHostSettings(ctx)),
      selected: readConfig(pi.getFlag("nunc-config"), ctx.cwd), fixed: structuredClone(fixed(ctx)) };
    const stale = () => {
      try {
        return signal.aborted || frozen.generation !== generation || frozen.sessionId !== ctx.sessionManager.getSessionId() ||
          frozen.leafId !== ctx.sessionManager.getLeafId() || frozen.revision !== memory.read(ctx).revision ||
          !isDeepStrictEqual(ctx.model, frozen.model) || ctx.thinkingLevel !== frozen.thinking || !isDeepStrictEqual(getHostSettings(ctx), frozen.host) ||
          !isDeepStrictEqual(readConfig(pi.getFlag("nunc-config"), ctx.cwd), frozen.selected) || !isDeepStrictEqual(fixed(ctx), frozen.fixed);
      } catch { return true; }
    };
    const controller = new AbortController();
    uiRunning = controller;
    const timeout = AbortSignal.timeout(60_000);
    const combined = AbortSignal.any([signal, controller.signal, timeout]);
    let callStartedAt: number | undefined;
    let observedResponse = false;
    try {
      const config = engineConfig(frozen.selected.config, frozen.model, frozen.host.compaction, omitsSerializedOutputCap(frozen.model) || subscriptionBilling(frozen.model, ctx.modelRegistry));
      config.toolResultCleanup = true;
      const policy = await loadPolicy({ ...frozen.selected.config, ...(frozen.selected.configFile ? { configFile: frozen.selected.configFile } : {}) });
      if (stale()) return { stale: true };
      const active = effectiveActive(projected, true);
      const input = { binding: { sessionId: frozen.sessionId, leafId: frozen.leafId ?? "", generation: String(generation) },
        model: frozen.model, fixed: frozen.fixed, memory: proposal, active, eligibleUsageEntryIds: eligibleUsageEntryIds(entries, active), cleanupCandidateScope: semanticScope,
        policy, config };
      const plan = memoryPlan(frozen.fixed, frozen.model, config, input.memory.slots);
      const resolved = resolveExtractionRequest(input, cap => {
        const context = extractionContext(input, 0, plan.organizingTarget, active, [], cap);
        const request = context.messages[0];
        if (request && Array.isArray(request.content)) request.content.push({ type: "text", text:
          `The user has already selected the exact proposed M above. Decide only eligible tool-result cleanup; do not revise M. Return add: [], update: [], remove: [], priority: every current slot ID once, required: [], and optional toolResultEdits. Current slot IDs: ${JSON.stringify(proposal.slots.map(s => s.id))}.` });
        return context;
      });
      callStartedAt = Date.now();
      const response = await admission.complete(piComplete(ctx.modelRegistry, frozen.thinking))({ model: frozen.model, context: resolved.context, outputTokens: resolved.outputTokens, signal: combined });
      observedResponse = true;
      try { pi.events.emit("nunc:ui-cleanup-usage", { status: "response", model: { provider: frozen.model.provider, id: frozen.model.id },
        elapsedMs: Date.now() - callStartedAt, outputReserveTokens: resolved.outputTokens, outputCapTokens: resolved.outputCapTokens, outputDesiredTokens: resolved.outputDesiredTokens, outputLimitedBy: resolved.outputLimitedBy, stopReason: record(response) ? response.stopReason : null,
        usage: record(response) ? response.usage : null }); } catch { /* Observation only. */ }
      if (stale()) return { stale: true };
      if (combined.aborted || !record(response) || response.role !== "assistant" || response.stopReason !== "stop" ||
          response.endTurn === false || response.deferred || response.errorMessage ||
          response.model !== frozen.model.id || response.provider !== frozen.model.provider || response.api !== frozen.model.api ||
          (response.responseModel && response.responseModel !== frozen.model.id) ||
          !Array.isArray(response.content) || response.content.some(b => !record(b) ||
            !((b.type === "text" && typeof b.text === "string") || (b.type === "thinking" && typeof b.thinking === "string")))) {
        return { warning: "Cleanup did not complete; memory can still be saved with original tool results" };
      }
      const text = response.content.filter(b => record(b) && b.type === "text").map(b => b.text).join("");
      const patch = parsePatch(JSON.parse(text), proposal);
      if (patch.add.length || patch.update?.length || patch.remove.length) return { warning: "Cleanup response changed frozen memory; memory saved without cleanup" };
      return { edits: patch.toolResultEdits ?? [] };
    } catch (error) {
      if (callStartedAt !== undefined && !observedResponse) {
        try { pi.events.emit("nunc:ui-cleanup-usage", { status: "unknown", model: { provider: frozen.model.provider, id: frozen.model.id },
          elapsedMs: Date.now() - callStartedAt, usage: null }); } catch { /* Observation only. */ }
      }
      if (stale()) return { stale: true };
      return { warning: `Cleanup did not complete (${error instanceof Error ? error.message : String(error)}); memory can still be saved with original results` };
    } finally {
      if (uiRunning === controller) uiRunning = undefined;
    }
  };
  const ui = createNuncUi({ memory, context: contextView, supported, prepareSave: prepareUiCleanup });
  const notify = (ctx: ExtensionContext, message: string, level: "warning" | "info" = "warning") => {
    ui.noteDiagnostic(level, message);
    try { pi.events.emit("nunc:diagnostic", { level, message }); } catch { /* Notification only. */ }
    try { if (ctx.hasUI) ctx.ui.notify(`Nunc: ${message}`, level); else console.error(`Nunc: ${message}`); } catch { /* Never fall through to default summary. */ }
    if (level !== "info") ui.refresh(ctx);
  };
  observeLayout = event => {
    contextView.observeAdmission(event);
    if (event.observation.kind === "main" && event.observation.outcome === "reject") {
      const detail = event.observation.resolution && (event.observation.resolution === "unavailable" || event.observation.resolution === "protocol-error")
        ? ` (${event.observation.resolution})`
        : "";
      ui.noteDiagnostic("warning", `Admission ${event.observation.code ?? "reject"}${detail}`);
    } else if (event.observation.kind === "main" && event.observation.outcome === "delegate") {
      ui.recover();
    }
    ui.refresh(event.ctx);
  };
  pi.on("session_compact", (_event, ctx) => { admission.invalidateUsage(); memory.endFreeze(); contextView.noteNative("saved"); ui.recover(); ui.refresh(ctx); });
  pi.on("session_compact_failed", (_event, ctx) => { if (!memory.noteForeignFailure()) { memory.endFreeze(); contextView.noteNative("failed"); } ui.refresh(ctx); });
  pi.on("session_start", (_event, ctx) => {
    completionRegistry = ctx.modelRegistry;
    invalidate(); dropAnchors(); contextView.resetPath();
    try {
      supported(ctx);
      const s = getHostSettings(ctx);
      const memoryToolsEnabled = resolveMemoryTools({
        cliFlag: pi.getFlag("nunc-memory-tools"),
        projectNunc: s.projectNunc,
        globalNunc: s.globalNunc,
        projectTrusted: s.projectTrusted,
      });
      if (memoryToolsEnabled) registerMemoryTools();
      admission.ensure(ctx);
      const selected = ctx.model ? readConfig(pi.getFlag("nunc-config"), ctx.cwd).config : undefined;
      if (ctx.model && selected) engineConfig(selected, ctx.model, settings(ctx).compaction);
      project(ctx.sessionManager.buildContextEntries());
      ui.attach(ctx);
      if (selected?.memory?.hardMaxTokens !== undefined) {
        notify(ctx, `Explicit memory.hardMaxTokens=${selected.memory.hardMaxTokens} may block required-memory maintenance. For an elastic organizing target, use memory.targetTokens and remove hardMaxTokens. Settings were not changed.`);
      }
      if (ctx.model && selected && omitsSerializedOutputCap(ctx.model) && selected.extraction?.outputTokens === ctx.model.maxTokens) {
        notify(ctx, `Explicit extraction.outputTokens=${ctx.model.maxTokens} still reserves the full output capability. This API has no output cap; remove the legacy override to use the 8192 planning default. Settings were not changed.`);
      }
    } catch (error) { notify(ctx, error instanceof Error ? error.message : "Invalid startup configuration"); }
  });
  pi.on("session_before_switch", () => { invalidate(); contextView.resetPath(); });
  pi.on("session_before_fork", () => { invalidate(); contextView.resetPath(); });
  pi.on("session_before_tree", () => { invalidate(); contextView.resetPath(); });
  pi.on("session_tree", (_event, ctx) => { invalidate(); ui.refresh(ctx); });
  pi.on("session_shutdown", (_event, ctx) => { completionRegistry = undefined; memory.endFreeze(); invalidate(); dropAnchors(); contextView.resetPath(); admission.close(ctx); ui.shutdown(ctx); });
  pi.on("model_select", (_event, ctx) => {
    invalidate(); admission.ensure(ctx); ui.refresh(ctx);
    if (!ctx.model) return;
    try {
      const config = engineConfig(readConfig(pi.getFlag("nunc-config"), ctx.cwd).config, ctx.model, settings(ctx).compaction);
      const projected = project(ctx.sessionManager.buildContextEntries());
      const estimate = requestTokens(mainContext(fixed(ctx), projected.memory.slots, effectiveActive(projected, cleanupEnabled(ctx))), config.imageTokens)
        + config.main.extraInputTokens;
      const limit = mainAdmissionLimit(ctx.model, config.main);
      if (estimate > limit) notify(ctx, `Selected model context estimate ${estimate} exceeds input limit ${limit}. Native automatic recovery may require compaction; success is not guaranteed. With automatic compaction disabled, compact explicitly or choose a larger model. This is a projection, not the next provider payload.`);
    } catch (error) { notify(ctx, error instanceof Error ? error.message : "Cannot estimate selected model capacity"); }
  });
  pi.on("thinking_level_select", (_event, ctx) => { invalidate(); ui.refresh(ctx); });
  pi.on("agent_settled", (_event, ctx) => { admission.settled(); ui.refresh(ctx); });
  pi.on("message_end", (event, ctx) => {
    ui.refresh(ctx);
    if (event.message.role === "assistant") {
      const message = admission.finalized(event.message);
      if (message) return { message };
    }
  });
  pi.on("context", (event, ctx) => {
    // Pi puts the newest native checkpoint first, even when its kept range
    // includes earlier checkpoints. Keep that carrier once and every real K.
    admission.ensure(ctx);
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const entries = ctx.sessionManager.buildContextEntries();
      const projected = project(entries);
      const messages = withEffectiveMemory(event.messages, projected.memory, { sessionId, entries,
        decisions: projected.cleanup, enabled: cleanupEnabled(ctx),
        ...(projected.latestId !== undefined ? { latestId: projected.latestId } : {}) });
      // Inspect Pi's public native mapping without changing real AgentMessages
      // that later context hooks still consume. Native user/assistant/toolResult
      // objects (and our carrier) survive conversion and witness this projection.
      const converted = convertToLlm(messages);
      const originals = new Set<object>(messages);
      if (ctx.model) {
        const memoryIndex = carrierIndexIn(converted);
        admission.bindProjection({
          sessionId, signal: ctx.signal, model: ctx.model, messages: converted,
          identityMessages: converted.filter(message => originals.has(message)),
          memory: projected.memory,
          ...(memoryIndex !== undefined ? { memoryIndex } : {}),
        });
      }
      return { messages };
    } catch (error) {
      notify(ctx, error instanceof Error ? error.message : "Invalid memory projection");
      let seen = false;
      return { messages: event.messages.filter(m => {
        if (m.role === "assistant" && ["error", "aborted"].includes(m.stopReason)) return false;
        if (m.role !== "compactionSummary") return true;
        if (seen) return false;
        seen = true; return true;
      }) };
    }
  });
  pi.on("session_before_compact", async (event, ctx) => {
    if (!memory.beginFreeze()) { notify(ctx, "Maintenance already active"); return { cancel: true }; }
    const controller = new AbortController(); running = controller;
    const abort = () => controller.abort();
    event.signal.addEventListener("abort", abort, { once: true });
    if (event.signal.aborted) controller.abort();
    try {
      supported(ctx); admission.ensure(ctx);
      if (event.reason === "overflow" && admission.recoveryCancelled()) throw new EngineError("CANCELLED", "User cancelled the rejected request; no capacity recovery");
      const manager = ctx.sessionManager;
      if (!ctx.model) throw new EngineError("CONFIG", "No current model");
      const binding = { sessionId: manager.getSessionId(), leafId: manager.getLeafId() ?? "", generation: String(generation) };
      const file = manager.getSessionFile();
      const selection = readConfig(pi.getFlag("nunc-config"), ctx.cwd), host = settings(ctx);
      if (!isDeepStrictEqual(host.compaction, event.preparation.settings)) throw new EngineError("CONFIG", "Host settings differ from preparation; reload settings before maintenance");
      const model = structuredClone(ctx.model), thinking = ctx.thinkingLevel, f = structuredClone(fixed(ctx));
      const config = engineConfig(selection.config, model, event.preparation.settings, omitsSerializedOutputCap(model) || subscriptionBilling(model, ctx.modelRegistry));
      const intent = compactFor;
      const target = intent?.target;
      if (intent) {
        if (event.reason !== "manual" || event.customInstructions !== intent.marker || intent.claimed ||
            intent.generation !== generation || intent.sessionId !== binding.sessionId || intent.leafId !== manager.getLeafId()) {
          throw new EngineError("CANCELLED", "Targeted compaction invocation changed or was already consumed");
        }
        intent.claimed = true;
        config.extraction.toolResults = "full";
      }
      const entries = manager.buildContextEntries();
      const projected = project(entries);
      const sourceRevision = memoryRevision(binding.sessionId, manager.getLeafId(), entries);
      const sourceEntryIds = new Set(entries.map(entry => entry.id));
      const frozenProjection = structuredClone(projected);
      const eligible = eligibleStarts(event.branchEntries, projected.active, projected.latestId);
      const enabled = cleanupEnabled(ctx);
      const opportunity = { enabled, scope: enabled ? compactionCleanupScope(projected.active, projected.cleanup) : [] };
      const active = effectiveActive(projected, opportunity.enabled);
      // Freeze delivered R only. Pending/future D is neither observed nor consumed.
      const loaded = await loadPolicy({ ...selection.config, ...(selection.configFile ? { configFile: selection.configFile } : {}) });
      const policy = { ...loaded, user: loaded.user + (!intent && event.customInstructions ? `\nAdditional user maintenance preferences:\n${event.customInstructions}` : "") };
      if (controller.signal.aborted) throw new EngineError("CANCELLED", "Maintenance cancelled");
      config.toolResultCleanup = opportunity.enabled;
      contextView.beginMaintenance({ ctx, model, fixed: f, memory: projected.memory, active, reason: event.reason, config });
      ui.refresh(ctx);
      const input = { binding, model, ...(target ? { target } : {}), fixed: f, memory: projected.memory, active,
        eligibleUsageEntryIds: eligibleUsageEntryIds(entries, active), eligibleKeptEntryIds: eligible, cleanupCandidateScope: opportunity.scope, policy, config, signal: controller.signal };
      const calibration = projectMaintenanceCalibration(manager.getBranch(), input);
      const maintenanceInput = { ...input, calibration };
      const result = await maintain(maintenanceInput, admission.complete(piComplete(ctx.modelRegistry, thinking)));
      contextView.noteEngine(result);
      ui.refresh(ctx);
      // Native subscription receipts/catalog estimates are not an observed USD bill.
      if (subscriptionBilling(model, ctx.modelRegistry)) result.observations.usage.cost = null;
      try { pi.events.emit("nunc:maintenance", { reason: event.reason, willRetry: event.willRetry, result: structuredClone(result.ok ? result : { ok: false, code: result.code, message: result.message, observations: result.observations }) } satisfies MaintenanceEvent); } catch { /* Notification only. */ }
      const accounting = result.observations.accounting;
      if (accounting && !accounting.normalHeadroomSufficient && !headroomWarned) {
        headroomWarned = true;
        notify(ctx, `Normal-trigger extraction estimate ${accounting.normalExtractionAtTrigger} exceeds the extraction input limit planned with the minimum maintenance output reserve; consider Pi reserveTokens >= ${accounting.suggestedReserveTokens} (and compatible keepRecentTokens). Current maintenance resolved reserve ${accounting.outputReserveTokens} is checked separately; settings were not changed.`);
      }
      const currentEntries = manager.buildContextEntries();
      const current = project(currentEntries);
      const branch = manager.getBranch();
      // A later D may extend the frozen path without changing its consumed source.
      // Reuse manual-memory ancestry/revision rules; native context edits target
      // old entries without rewriting their stored bodies, so check those too.
      const editedSource = branch.slice(branch.findIndex(entry => entry.id === binding.leafId) + 1)
        .some(entry => entry.type === "context_edit" && sourceEntryIds.has(entry.targetId));
      const sourceUnchanged = !editedSource && revisionApplies(sourceRevision, manager.getSessionId(), manager.getLeafId(), currentEntries, branch) &&
        isDeepStrictEqual(current.active.slice(0, frozenProjection.active.length), frozenProjection.active) &&
        isDeepStrictEqual({ ...current, active: [] }, { ...frozenProjection, active: [] });
      if (controller.signal.aborted || event.signal.aborted || String(generation) !== binding.generation ||
          manager.getSessionId() !== binding.sessionId || manager.getSessionFile() !== file || !sourceUnchanged ||
          !isDeepStrictEqual(ctx.model, model) || ctx.thinkingLevel !== thinking || !isDeepStrictEqual(fixed(ctx), f) ||
          !isDeepStrictEqual(readConfig(pi.getFlag("nunc-config"), ctx.cwd), selection) || !isDeepStrictEqual(settings(ctx), host) ||
          cleanupEnabled(ctx) !== opportunity.enabled) {
        throw new EngineError("CANCELLED", "Session, path, model, tools or configuration changed during maintenance; candidate discarded");
      }
      if (target && (!isDeepStrictEqual(ctx.modelRegistry.find(target.model.provider, target.model.id), target.model) ||
          !isDeepStrictEqual(engineConfig({ ...selection.config, extraction: { ...selection.config.extraction, outputTokens: "auto" } }, target.model,
            getHostSettings(ctx, target.model).compaction), target.config))) {
        throw new EngineError("CANCELLED", "Target model or target settings changed during maintenance");
      }
      const savedCalibration = maintenanceCalibrationRecord(maintenanceInput, result);
      if (!result.ok) {
        if (savedCalibration) pi.appendEntry(MAINTENANCE_CALIBRATION_TYPE, savedCalibration);
        notify(ctx, `${result.code}: ${result.message}`);
        return { cancel: true };
      }
      if (intent && result.observations.target) intent.outcome = result.observations.target;
      if (!eligibleStarts(branch, current.active, current.latestId).includes(result.candidate.firstKeptEntryId)) throw new EngineError("INPUT", "Candidate boundary is no longer host-visible");
      const retained = new Set(result.candidate.kept.map(e => e.entryId));
      const nextDecisions = [...projected.cleanup, ...(result.candidate.toolResultCleanup?.applied ?? [])].filter(d => retained.has(d.entryId) &&
        !d.sourceRefs?.some(ref => !retained.has(ref.entryId)));
      return { compaction: { summary: result.candidate.summary, firstKeptEntryId: result.candidate.firstKeptEntryId, tokensBefore: result.observations.accounting!.mainBeforeTokens,
        details: { nunc: result.candidate.memory, toolResultCleanup: sealDecisions(projected.active, nextDecisions),
          ...(savedCalibration ? { maintenanceCalibration: savedCalibration } : {}) } } };
    } catch (error) {
      contextView.noteInvalidated();
      notify(ctx, `${error instanceof EngineError ? error.code + ": " : ""}${error instanceof Error ? error.message : "Maintenance failed"}`);
      return { cancel: true };
    } finally {
      if (event.signal.aborted && event.reason !== "manual") admission.cancelRun();
      event.signal.removeEventListener("abort", abort); running = undefined;
    }
  });
  pi.registerShortcut("f7", { description: "Open Nunc overlay", handler: async ctx => {
    if (ctx.mode !== "tui") return;
    try {
      supported(ctx);
      await ui.openOverlay(ctx);
    } catch (error) { notify(ctx, error instanceof Error ? error.message : "Invalid configuration"); }
  } });
  pi.registerCommand("nunc", { description: "Show memory/report, or compact for a target model",
    getArgumentCompletions: prefix => commandCompletions(prefix, completionRegistry?.getAll() ?? []),
    handler: async (args, ctx) => {
    try {
      const mode = args.trim();
      const compactMatch = /^compact-for\s+(\S+)$/.exec(mode);
      if (compactMatch) {
        supported(ctx);
        if (!ctx.isIdle() || ctx.hasPendingMessages() || running || uiRunning || compactFor) throw new EngineError("INPUT", "Wait for an idle session without pending messages before compact-for");
        if (!ctx.model) throw new EngineError("CONFIG", "No current execution model");
        const name = compactMatch[1]!;
        const catalog = ctx.modelRegistry.getAll();
        const exact = catalog.find(m => `${m.provider}/${m.id}` === name);
        const matches = exact ? [exact] : catalog.filter(m => m.id === name);
        if (matches.length !== 1) throw new EngineError("CONFIG", matches.length ? "Ambiguous target; use provider/model-id" : `Unknown target model: ${name}`);
        const targetModel = structuredClone(matches[0]!);
        const selection = readConfig(pi.getFlag("nunc-config"), ctx.cwd);
        const targetConfig = engineConfig({ ...selection.config, extraction: { ...selection.config.extraction, outputTokens: "auto" } }, targetModel,
          getHostSettings(ctx, targetModel).compaction);
        const intent: CompactForIntent = { marker: `nunc-compact-for:${randomUUID()}`, sessionId: ctx.sessionManager.getSessionId(),
          leafId: ctx.sessionManager.getLeafId(), generation, target: { model: targetModel, config: targetConfig }, claimed: false };
        compactFor = intent;
        try {
          await new Promise<void>((resolve, reject) => ctx.compact({ customInstructions: intent.marker,
            onComplete: () => resolve(), onError: reject }));
          if (!intent.outcome || generation !== intent.generation || ctx.sessionManager.getSessionId() !== intent.sessionId) {
            throw new EngineError("CANCELLED", "Targeted compaction has no current confirmed result");
          }
          notify(ctx, `Saved compaction for ${targetModel.provider}/${targetModel.id}: projected input ${intent.outcome.estimatedInputTokens}, planning limit ${intent.outcome.plannedInputLimit}, growth reserve ${intent.outcome.growthReserve}. Current model unchanged; switch manually. Later prompt/tools/input can change actual capacity.`, "info");
        } finally { if (compactFor === intent) compactFor = undefined; }
        return;
      }
      if (mode && mode !== "details") { notify(ctx, COMMAND_USAGE); return; }
      supported(ctx);
      if (!mode && ctx.mode === "tui") { await ui.openOverlay(ctx); return; }
      const warning = ui.currentWarning();
      const report = detailsLines({ view: contextView.read(ctx), diagnostics: ui.recentDiagnostics(), ...(warning ? { currentWarning: warning } : {}) });
      try { pi.events.emit("nunc:diagnostic", { level: "info", message: report }); } catch { /* Observer only. */ }
      try { if (ctx.hasUI) ctx.ui.notify(`Nunc: ${report}`, "info"); else console.error(`Nunc: ${report}`); } catch { /* Never fall through to default summary. */ }
    } catch (error) { notify(ctx, error instanceof Error ? error.message : "Invalid configuration"); }
  } });
}
