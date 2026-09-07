import { isDeepStrictEqual } from "node:util";
import { getAgentDir, SettingsManager, VERSION, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent, type CompactionSettings } from "@earendil-works/pi-coding-agent";
import type { Accounting, FixedContext, MaintenanceResult } from "./engine/index.js";
import { maintain, piComplete, loadPolicy } from "./engine/index.js";
import { EngineError } from "./engine/validation.js";
import { inputLimit, omitsSerializedOutputCap } from "./engine/accounting.js";
import { engineConfig, readConfig } from "./pi/config.js";
import { eligibleStarts, project, withEffectiveMemory } from "./pi/projection.js";
import { createMemorySurface } from "./pi/manual.js";
import { Admission } from "./pi/admission.js";

/** Optional public settings source for component fixtures; stock CLI uses its settings. */
export interface HostSettingsSource { readSettings: () => { compaction: Required<CompactionSettings>; blockImages: boolean } }
export interface MaintenanceEvent { reason: SessionBeforeCompactEvent["reason"]; willRetry: boolean; result: MaintenanceResult }

export default function nunc(pi: ExtensionAPI): void {
  pi.registerFlag("nunc-config", { description: "Nunc JSON configuration path (relative to cwd); policy paths are relative to this file", type: "string" });
  let generation = 0;
  let running: AbortController | undefined;
  let hostSettings: HostSettingsSource | undefined;
  let lastAccounting: Accounting | null = null;
  let headroomWarned = false;
  const invalidate = () => { generation++; running?.abort(); admission.invalidateUsage(); lastAccounting = null; headroomWarned = false; };
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
  const admission = new Admission(pi, (ctx, model) => {
    supported(ctx);
    project(ctx.sessionManager.buildContextEntries());
    return engineConfig(readConfig(pi.getFlag("nunc-config"), ctx.cwd).config, model, settings(ctx).compaction);
  });
  const fixed = (ctx: ExtensionContext): FixedContext => {
    const all = pi.getAllTools();
    return { systemPrompt: ctx.getSystemPrompt(), tools: pi.getActiveTools().map(name => {
      const tool = all.find(t => t.name === name);
      if (!tool) throw new EngineError("INPUT", `Active tool definition unavailable: ${name}`);
      return { name, description: tool.description, parameters: tool.parameters };
    }) };
  };
  const notify = (ctx: ExtensionContext, message: string, level: "warning" | "info" = "warning") => {
    try { pi.events.emit("nunc:diagnostic", { level, message }); } catch { /* Notification only. */ }
    try { if (ctx.hasUI) ctx.ui.notify(`Nunc: ${message}`, level); else console.error(`Nunc: ${message}`); } catch { /* Never fall through to default summary. */ }
  };
  const memory = createMemorySurface({ pi, fixed, settings, onCommitted: () => admission.invalidateUsage() });
  pi.on("session_compact", () => { admission.invalidateUsage(); memory.endFreeze(); });
  pi.on("session_compact_failed", () => { if (!memory.noteForeignFailure()) memory.endFreeze(); });
  pi.on("session_start", (_event, ctx) => {
    memory.clearUnconfirmed();
    invalidate();
    try {
      admission.ensure(ctx); supported(ctx);
      if (ctx.model) {
        const selected = readConfig(pi.getFlag("nunc-config"), ctx.cwd).config;
        engineConfig(selected, ctx.model, settings(ctx).compaction);
        if (omitsSerializedOutputCap(ctx.model) && selected.extraction?.outputTokens === ctx.model.maxTokens) {
          notify(ctx, `Explicit extraction.outputTokens=${ctx.model.maxTokens} still reserves the full output capability. This API has no output cap; remove the legacy override to use the 8192 planning default. Settings were not changed.`);
        }
      }
      project(ctx.sessionManager.buildContextEntries());
    } catch (error) { notify(ctx, error instanceof Error ? error.message : "Invalid startup configuration"); }
  });
  pi.on("session_before_switch", invalidate);
  pi.on("session_before_fork", invalidate);
  pi.on("session_before_tree", invalidate);
  pi.on("session_tree", invalidate);
  pi.on("session_shutdown", (_event, ctx) => { memory.endFreeze(); memory.clearUnconfirmed(); invalidate(); admission.close(ctx); });
  pi.on("model_select", (_event, ctx) => { invalidate(); admission.ensure(ctx); });
  pi.on("thinking_level_select", invalidate);
  pi.on("agent_settled", () => admission.settled());
  pi.on("message_end", event => {
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
      const result = await maintain({ binding, model, fixed: f, memory: projected.memory, active: projected.active, eligibleKeptEntryIds: eligible, policy, config, signal: controller.signal }, admission.complete(piComplete(ctx.modelRegistry)));
      // Native Codex OAuth's subscription zero is not an observed USD bill.
      if (model.api === "openai-codex-responses") result.observations.usage.cost = null;
      try { pi.events.emit("nunc:maintenance", { reason: event.reason, willRetry: event.willRetry, result: structuredClone(result.ok ? result : { ok: false, code: result.code, message: result.message, observations: result.observations }) } satisfies MaintenanceEvent); } catch { /* Notification only. */ }
      lastAccounting = result.observations.accounting;
      if (lastAccounting && !lastAccounting.normalHeadroomSufficient && !headroomWarned) {
        headroomWarned = true;
        notify(ctx, `Normal-trigger extraction estimate ${lastAccounting.normalExtractionAtTrigger} exceeds planned input ${lastAccounting.extractionInputLimit}; consider Pi reserveTokens >= ${lastAccounting.suggestedReserveTokens} (and compatible keepRecentTokens). Current maintenance is checked separately; settings were not changed.`);
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
      notify(ctx, `${error instanceof EngineError ? error.code + ": " : ""}${error instanceof Error ? error.message : "Maintenance failed"}`);
      return { cancel: true };
    } finally {
      if (event.signal.aborted && event.reason !== "manual") admission.cancelRun();
      event.signal.removeEventListener("abort", abort); running = undefined;
    }
  });
  pi.registerCommand("nunc", { description: "Show memory status; /nunc details for budget details (no request)",
    getArgumentCompletions: prefix => "details".startsWith(prefix.trimStart())
      ? [{ value: "details", label: "details", description: "查看预算与最近维护详情" }] : null,
    handler: async (args, ctx) => {
    try {
      const mode = args.trim();
      if (mode && mode !== "details") { notify(ctx, "用法：/nunc [details]"); return; }
      supported(ctx);
      const selection = readConfig(pi.getFlag("nunc-config"), ctx.cwd), memory = project(ctx.sessionManager.buildContextEntries()).memory;
      const config = ctx.model ? engineConfig(selection.config, ctx.model, settings(ctx).compaction) : undefined;
      const count = (n: number) => n.toLocaleString("en-US");
      const summary = [`记忆：${memory.slots.length} 条`, `压缩触发：${config ? count(config.triggerTokens) + " tokens" : "未选择模型"}`];
      if (!mode) { notify(ctx, [...summary, "预算详情：/nunc details"].join("\n"), "info"); return; }
      const details = config && ctx.model ? [
        "", "输入预算（tokens）",
        `  主请求：${count(inputLimit(ctx.model, config.main))}`,
        `  维护：${count(inputLimit(ctx.model, config.extraction))}`,
        "", "输出预留（tokens）",
        `  主请求：${count(config.main.nativeOutputReserve ?? config.main.outputTokens)}`,
        `  维护：${count(config.extraction.outputTokens)}`,
        `  维护输出 cap：${omitsSerializedOutputCap(ctx.model) ? "无" : count(config.extraction.outputTokens)}`,
        `安全余量：${count(config.extraction.safetyTokens)} tokens`,
      ] : [];
      const last = lastAccounting ? [
        "", "最近维护（本上下文）",
        `  输入估算：完整 ${count(lastAccounting.fullExtractionTokens)} → 选用 ${count(lastAccounting.extractionTokens)}`,
        `  正常触发余量：${lastAccounting.normalHeadroomSufficient ? "充足" : "不足；建议 reserveTokens ≥ " + count(lastAccounting.suggestedReserveTokens)}`,
        `  超出规划记录：输入${lastAccounting.inputExceededPlan ? "有" : "无"} / 输出${lastAccounting.outputExceededPlan ? "有" : "无"}`,
      ] : ["", "本上下文暂无维护记录。"];
      notify(ctx, [...summary, ...details, ...last, "", `Pi ${VERSION} · 预算为估算值`].join("\n"), "info");
    } catch (error) { notify(ctx, error instanceof Error ? error.message : "Invalid configuration"); }
  } });
}
