import { appendFileSync, readFileSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { boundedProvider, BudgetLedger } from "./budget.js";
import { RunnerError, requireValue, type RunInput } from "./contract.js";
import { toolPath } from "./tool-path.js";

function toolBlockReason(error: unknown, aborted: boolean): string {
  if (aborted || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))) return "Tool action after deadline";
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
  const binding = JSON.parse(readFileSync(source, "utf8")) as { input: RunInput; models: Model<Api>[]; deadline: number; events: string; ledger: string; cwd: string; caseKey?: string };
  const signal = AbortSignal.timeout(Math.max(1, binding.deadline - Date.now()));
  const log = (type: string, data: unknown) => appendFileSync(binding.events, JSON.stringify({ type, data }) + "\n", { mode: 0o600 });
  const ledger = new BudgetLedger(binding.ledger, binding.input.limits, binding.deadline, signal, binding.caseKey);
  pi.on("session_start", (_event, ctx) => {
    for (const id of new Set(binding.models.map(m => m.provider))) {
      const base = ctx.modelRegistry.getProvider(id);
      requireValue(base, "MODEL", "Authorized native provider unavailable");
      pi.registerProvider(boundedProvider(base, binding.models.filter(m => m.provider === id), ledger, { checkAuth: model => { if (model.provider === "openai-codex") requireValue(ctx.modelRegistry.isUsingOAuth(model), "AUTHORIZATION", "Selected Codex route requires native OAuth in the isolated host"); }, onContext: (model, context, kind) => log("context", { model, context, kind }) }));
    }
    log("ready", { sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), model: ctx.model });
  });
  pi.events.on("nunc:maintenance", event => log("maintenance", event));
  pi.events.on("nunc:admission", event => log("admission", event));
  pi.on("before_provider_request", event => {
    const payload = event.payload;
    log("payload", { mode: "observe", keys: payload && typeof payload === "object" && !Array.isArray(payload) ? Object.keys(payload) : [] });
  });
  pi.on("before_provider_request", event => event.payload);
  pi.on("session_before_compact", event => log("lifecycle", { phase: "maintenance-start", reason: event.reason, willRetry: event.willRetry }));
  pi.on("session_compact", event => log("lifecycle", { phase: "maintenance-end", reason: event.reason, willRetry: event.willRetry }));
  pi.on("session_compact_failed", event => log("lifecycle", { phase: "maintenance-failed", reason: event.reason, aborted: event.aborted, willRetry: event.willRetry }));
  pi.on("tool_call", async event => {
    try {
      signal.throwIfAborted();
      requireValue(["read", "write", "edit"].includes(event.toolName), "TOOL_KIND", "Only scenario-local read/write/edit are authorized");
      await toolPath(binding.cwd, "path" in event.input ? event.input.path : undefined, event.toolName as "read" | "write" | "edit");
      if (event.toolName === "write") requireValue(typeof event.input.content === "string" && Buffer.byteLength(event.input.content) <= 1_000_000, "WRITE_SIZE", "Artifact write exceeds bound");
      log("action", { type: "tool_call", toolName: event.toolName, toolCallId: event.toolCallId, input: event.input });
    } catch (error) { return { block: true, reason: toolBlockReason(error, signal.aborted) }; }
  });
  pi.on("tool_result", event => log("action", { type: "tool_result", toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError, content: event.content }));
  pi.registerCommand("nunc-observer-quit", { handler: async (_args, ctx) => ctx.shutdown() });
}
