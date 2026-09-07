import { appendFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SYNTHETIC_LAST_USER_APPEND } from "../../src/live/append.js";
import { applyLastUserTextAppend } from "../../src/pi/payload.js";

/** Controlled-service observer plus explicit public-composition fault commands. Never generates memory. */
export default function (pi: ExtensionAPI): void {
  const file = process.env.NUNC_OBSERVATION_LOG;
  if (!file) throw new Error("Missing isolated observation output");
  const log = (type: string, data: unknown) => appendFileSync(file, JSON.stringify({ type, data }) + "\n");
  const snapshot = (ctx: ExtensionContext, phase = "inspect") => log("snapshot", { phase, mode: ctx.mode, editor: ctx.ui.getEditorText(), pending: ctx.hasPendingMessages(), sessionId: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile(), leaf: ctx.sessionManager.getLeafId(), entries: ctx.sessionManager.getBranch() });
  pi.events.on("nunc:admission", data => log("admission", data));
  pi.events.on("nunc:maintenance", data => log("maintenance", data));
  pi.events.on("nunc:diagnostic", data => log("diagnostic", data));
  pi.on("session_start", (event, ctx) => { log("start", { ...event, mode: ctx.mode }); snapshot(ctx, "start"); });
  pi.on("session_compact", event => log("compact", event));
  pi.on("session_compact_failed", event => log("compact_failed", event));
  pi.on("agent_settled", (_event, ctx) => { log("settled", {}); snapshot(ctx, "settled"); });
  pi.on("input", event => { log("input", event); return { action: "continue" }; });
  pi.on("message_end", event => log("message", event.message));
  pi.on("before_provider_headers", event => { event.headers["x-nunc-fixture"] = "preserved"; });
  let payloadMode = "observe", rewriteContext = false;
  pi.on("context", event => rewriteContext ? { messages: [...event.messages, { role: "user", content: "Unowned late context mutation", timestamp: 1 }] } : undefined);
  pi.registerCommand("fixture-context-rewrite", { handler: async args => { rewriteContext = args === "on"; } });
  pi.on("before_provider_request", event => {
    const payload = event.payload;
    log("payload", { mode: payloadMode, keys: payload && typeof payload === "object" && !Array.isArray(payload) ? Object.keys(payload) : [] });
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const rec = payload as Record<string, unknown>;
    switch (payloadMode) {
      case "identity": return payload;
      case "inplace-meta": rec.nunc_fixture = "meta"; return;
      case "replace-meta": return { ...rec, nunc_fixture: "meta" };
      case "overcap": return { ...rec, max_tokens: 999999, max_output_tokens: 999999, max_completion_tokens: 999999 };
      case "nostream": return { ...rec, stream: false };
      case "grow": return { ...rec, nunc_fixture: "n".repeat(200000) };
      case "illegal-model": return { ...rec, model: "outside-selection" };
      case "append": {
        const result = applyLastUserTextAppend(payload, SYNTHETIC_LAST_USER_APPEND);
        return result.changed ? result.payload : undefined;
      }
      case "append-overflow": {
        const result = applyLastUserTextAppend(payload, "x".repeat(200000));
        return result.changed ? result.payload : undefined;
      }
      case "rewrite-user": {
        const list = Array.isArray(rec.input) ? rec.input : Array.isArray(rec.messages) ? rec.messages : undefined;
        if (!list) return rec;
        for (let index = list.length - 1; index >= 0; index -= 1) {
          const message = list[index];
          if (!message || typeof message !== "object" || Array.isArray(message) || (message as { role?: unknown }).role !== "user") continue;
          const current = (message as { content?: unknown }).content;
          (message as { content: unknown }).content = typeof current === "string" ? `${current} rewritten` : "rewritten";
          return rec;
        }
        return rec;
      }
      default: return;
    }
  });
  pi.registerCommand("fixture-payload-rewrite", { handler: async args => { payloadMode = args === "on" ? "illegal-model" : "observe"; } });
  pi.registerCommand("fixture-payload-mode", { handler: async args => { payloadMode = args.trim() || "observe"; } });
  pi.registerCommand("fixture-native-reset", { handler: async (_args, ctx) => { if (ctx.model) pi.unregisterProvider(ctx.model.provider); } });
  pi.registerCommand("fixture-legacy-stream", { handler: async (_args, ctx) => {
    if (!ctx.model) throw new Error("No model");
    const original = ctx.modelRegistry.getProvider(ctx.model.provider);
    if (!original) throw new Error("No provider");
    pi.registerProvider(ctx.model.provider, { api: ctx.model.api, streamSimple: original.streamSimple });
  } });
  pi.registerCommand("fixture-message", { handler: async args => {
    pi.sendMessage({ customType: "fixture-evidence", content: args, display: true }, { deliverAs: "steer" });
    log("custom_queued", args);
  } });
  pi.registerCommand("fixture-unknown", { handler: async (_args, ctx) => {
    if (!ctx.model) throw new Error("No model");
    const result = await ctx.modelRegistry.complete(ctx.model, { messages: [{ role: "user", content: "Unclassified nested request", timestamp: 1 }] }, { maxTokens: 64 });
    log("unknown_result", { stopReason: result.stopReason, errorMessage: result.errorMessage });
  } });
  pi.registerCommand("fixture-reload", { handler: async (_args, ctx) => { await ctx.reload(); } });
  pi.registerCommand("fixture-tree", { handler: async (args, ctx) => { await ctx.navigateTree(args, { summarize: false }); snapshot(ctx); } });
  pi.registerCommand("fixture-inspect", { handler: async (_args, ctx) => snapshot(ctx) });
  pi.registerShortcut("f6", { handler: ctx => snapshot(ctx), description: "Read-only fixture editor observation" });
  pi.registerCommand("fixture-quit", { handler: async (_args, ctx) => ctx.shutdown() });
}
