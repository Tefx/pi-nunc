import { isDeepStrictEqual } from "node:util";
import { getAgentDir, SettingsManager, VERSION, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent, type CompactionSettings } from "@earendil-works/pi-coding-agent";
import type { FixedContext, MaintenanceResult } from "./engine/index.js";
import { maintain, piComplete, loadPolicy } from "./engine/index.js";
import { EngineError } from "./engine/validation.js";
import { omitsSerializedOutputCap } from "./engine/accounting.js";
import { engineConfig, readConfig } from "./pi/config.js";
import { eligibleStarts, project, withEffectiveMemory } from "./pi/projection.js";
import { createMemorySurface } from "./pi/manual.js";
import { createContextSurface } from "./pi/context.js";
import { Admission, type AdmissionLayoutEvent } from "./pi/admission.js";
import { COMMAND_USAGE, commandCompletions, createNuncUi, detailsLines } from "./ui/index.js";

/** Optional public settings source for component fixtures; stock CLI uses its settings. */
export interface HostSettingsSource { readSettings: () => { compaction: Required<CompactionSettings>; blockImages: boolean } }
export interface MaintenanceEvent { reason: SessionBeforeCompactEvent["reason"]; willRetry: boolean; result: MaintenanceResult }

export default function nunc(pi: ExtensionAPI): void {
  pi.registerFlag("nunc-config", { description: "Nunc JSON configuration path (relative to cwd); policy paths are relative to this file", type: "string" });
  let generation = 0;
  let running: AbortController | undefined;
  let hostSettings: HostSettingsSource | undefined;
  let headroomWarned = false;
  const invalidate = () => { generation++; running?.abort(); admission.invalidateUsage(); headroomWarned = false; };
  pi.events.on("nunc:host-settings", (value: unknown) => {
    if (!value || typeof value !== "object" || !("readSettings" in value) || typeof value.readSettings !== "function") return;
    invalidate(); hostSettings = value as HostSettingsSource;
  });
  const settings = (ctx: ExtensionContext) => {
    if (hostSettings) return structuredClone(hostSettings.readSettings());
    const manager = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
    return { compaction: manager.getCompactionSettings(), blockImages: manager.getBlockImages() };
  };
  const supported = (ctx: ExtensionContext) => {
    if (VERSION !== "0.85.1") throw new EngineError("CONFIG", `Supported Pi target is 0.85.1; found ${VERSION}`);
    if (!ctx.sessionManager.getSessionFile()) throw new EngineError("CONFIG", "Persistent sessions only; start Pi without --no-session");
    if (settings(ctx).blockImages) throw new EngineError("CONFIG", "Image-blocking conversion is unsupported; preserve native media");
  };
  let observeLayout = (_event: AdmissionLayoutEvent) => {};
  const admission = new Admission(pi, (ctx, model) => {
    supported(ctx);
    project(ctx.sessionManager.buildContextEntries());
    return engineConfig(readConfig(pi.getFlag("nunc-config"), ctx.cwd).config, model, settings(ctx).compaction);
  }, event => observeLayout(event));
  const fixed = (ctx: ExtensionContext): FixedContext => {
    const all = pi.getAllTools();
    return { systemPrompt: ctx.getSystemPrompt(), tools: pi.getActiveTools().map(name => {
      const tool = all.find(t => t.name === name);
      if (!tool) throw new EngineError("INPUT", `Active tool definition unavailable: ${name}`);
      return { name, description: tool.description, parameters: tool.parameters };
    }) };
  };
  const memory = createMemorySurface({ pi, fixed, settings, onCommitted: () => { admission.invalidateUsage(); ui.refresh(); } });
  const contextView = createContextSurface({
    pi, memory, fixed,
    config: (ctx, model) => engineConfig(readConfig(pi.getFlag("nunc-config"), ctx.cwd).config, model, settings(ctx).compaction),
  });
  const ui = createNuncUi({ memory, context: contextView, supported });
  const notify = (ctx: ExtensionContext, message: string, level: "warning" | "info" = "warning") => {
    ui.noteDiagnostic(level, message);
    try { pi.events.emit("nunc:diagnostic", { level, message }); } catch { /* Notification only. */ }
    try { if (ctx.hasUI) ctx.ui.notify(`Nunc: ${message}`, level); else console.error(`Nunc: ${message}`); } catch { /* Never fall through to default summary. */ }
    if (level !== "info") ui.refresh(ctx);
  };
  observeLayout = event => {
    contextView.observeAdmission(event);
    if (event.observation.kind === "main" && event.observation.outcome === "reject") {
      ui.noteDiagnostic("warning", `Admission ${event.observation.code ?? "reject"}`);
    } else if (event.observation.kind === "main" && event.observation.outcome === "delegate") {
      ui.recover();
    }
    ui.refresh(event.ctx);
  };
  pi.on("session_compact", (_event, ctx) => { admission.invalidateUsage(); memory.endFreeze(); contextView.noteNative("saved"); ui.recover(); ui.refresh(ctx); });
  pi.on("session_compact_failed", (_event, ctx) => { if (!memory.noteForeignFailure()) { memory.endFreeze(); contextView.noteNative("failed"); } ui.refresh(ctx); });
  pi.on("session_start", (_event, ctx) => {
    invalidate(); contextView.resetPath();
    try {
      admission.ensure(ctx); supported(ctx);
      const selected = ctx.model ? readConfig(pi.getFlag("nunc-config"), ctx.cwd).config : undefined;
      if (ctx.model && selected) engineConfig(selected, ctx.model, settings(ctx).compaction);
      project(ctx.sessionManager.buildContextEntries());
      ui.attach(ctx);
      if (ctx.model && selected && omitsSerializedOutputCap(ctx.model) && selected.extraction?.outputTokens === ctx.model.maxTokens) {
        notify(ctx, `Explicit extraction.outputTokens=${ctx.model.maxTokens} still reserves the full output capability. This API has no output cap; remove the legacy override to use the 8192 planning default. Settings were not changed.`);
      }
    } catch (error) { notify(ctx, error instanceof Error ? error.message : "Invalid startup configuration"); }
  });
  pi.on("session_before_switch", () => { invalidate(); contextView.resetPath(); });
  pi.on("session_before_fork", () => { invalidate(); contextView.resetPath(); });
  pi.on("session_before_tree", () => { invalidate(); contextView.resetPath(); });
  pi.on("session_tree", (_event, ctx) => { invalidate(); ui.refresh(ctx); });
  pi.on("session_shutdown", (_event, ctx) => { memory.endFreeze(); invalidate(); contextView.resetPath(); admission.close(ctx); ui.shutdown(ctx); });
  pi.on("model_select", (_event, ctx) => { invalidate(); admission.ensure(ctx); ui.refresh(ctx); });
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
      return { messages: withEffectiveMemory(event.messages, project(ctx.sessionManager.buildContextEntries()).memory) };
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
      const model = structuredClone(ctx.model), f = structuredClone(fixed(ctx));
      const config = engineConfig(selection.config, model, event.preparation.settings);
      const projected = project(manager.buildContextEntries());
      const eligible = eligibleStarts(event.branchEntries, projected.active, projected.latestId);
      // Freeze delivered R only. Pending/future D is neither observed nor consumed.
      const loaded = await loadPolicy({ ...selection.config, ...(selection.configFile ? { configFile: selection.configFile } : {}) });
      const policy = { ...loaded, user: loaded.user + (event.customInstructions ? `\nAdditional user maintenance preferences:\n${event.customInstructions}` : "") };
      if (controller.signal.aborted) throw new EngineError("CANCELLED", "Maintenance cancelled");
      contextView.beginMaintenance({ ctx, model, fixed: f, memory: memory.read(ctx).memory, active: projected.active, reason: event.reason, config });
      ui.refresh(ctx);
      const result = await maintain({ binding, model, fixed: f, memory: projected.memory, active: projected.active, eligibleKeptEntryIds: eligible, policy, config, signal: controller.signal }, admission.complete(piComplete(ctx.modelRegistry)));
      contextView.noteEngine(result);
      ui.refresh(ctx);
      // Native Codex OAuth's subscription zero is not an observed USD bill.
      if (model.api === "openai-codex-responses") result.observations.usage.cost = null;
      try { pi.events.emit("nunc:maintenance", { reason: event.reason, willRetry: event.willRetry, result: structuredClone(result.ok ? result : { ok: false, code: result.code, message: result.message, observations: result.observations }) } satisfies MaintenanceEvent); } catch { /* Notification only. */ }
      const accounting = result.observations.accounting;
      if (accounting && !accounting.normalHeadroomSufficient && !headroomWarned) {
        headroomWarned = true;
        notify(ctx, `Normal-trigger extraction estimate ${accounting.normalExtractionAtTrigger} exceeds planned input ${accounting.extractionInputLimit}; consider Pi reserveTokens >= ${accounting.suggestedReserveTokens} (and compatible keepRecentTokens). Current maintenance is checked separately; settings were not changed.`);
      }
      if (!result.ok) { notify(ctx, `${result.code}: ${result.message}`); return { cancel: true }; }
      if (controller.signal.aborted || event.signal.aborted || String(generation) !== binding.generation ||
          manager.getSessionId() !== binding.sessionId || manager.getSessionFile() !== file || manager.getLeafId() !== binding.leafId ||
          !isDeepStrictEqual(ctx.model, model) || !isDeepStrictEqual(fixed(ctx), f) ||
          !isDeepStrictEqual(readConfig(pi.getFlag("nunc-config"), ctx.cwd), selection) || !isDeepStrictEqual(settings(ctx), host)) {
        throw new EngineError("CANCELLED", "Session, path, model, tools or configuration changed during maintenance; candidate discarded");
      }
      if (!eligible.includes(result.candidate.firstKeptEntryId)) throw new EngineError("INPUT", "Candidate boundary is no longer host-visible");
      return { compaction: { summary: result.candidate.summary, firstKeptEntryId: result.candidate.firstKeptEntryId, tokensBefore: result.observations.accounting!.mainBeforeTokens, details: { nunc: result.candidate.memory } } };
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
  pi.registerCommand("nunc", { description: "Show memory overlay or complete text report (no request)",
    getArgumentCompletions: prefix => commandCompletions(prefix),
    handler: async (args, ctx) => {
    try {
      const mode = args.trim();
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
