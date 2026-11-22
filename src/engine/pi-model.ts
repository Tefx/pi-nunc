import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import { EngineError, record } from "./validation.js";
import type { Complete } from "./types.js";
import { PATCH_RESPONSE_JSON_SCHEMA } from "./memory.js";
import { omitsSerializedOutputCap } from "./accounting.js";

/** Read only public native auth metadata, never the credential or an API-key prefix.
 * Legacy Codex's API is subscription-only; other OAuth providers declare their
 * subscription status through the native provider contract. */
export function subscriptionBilling(model: Model<Api>, registry: Pick<ModelRegistry, "isUsingOAuth" | "getProvider">): boolean {
  return model.api === "openai-codex-responses" ||
    (registry.isUsingOAuth(model) && registry.getProvider(model.provider)?.auth?.oauth?.isSubscription === true);
}

export function omitsRouteOutputCap(model: Model<Api>, registry: Pick<ModelRegistry, "isUsingOAuth" | "getProvider">): boolean {
  return omitsSerializedOutputCap(model) || (model.api === "openai-responses" && subscriptionBilling(model, registry));
}

/** Public Pi complete: native authentication/transport remain host-owned.
 * Raw calls need API-specific thinking options; omitting them does not inherit
 * the session's thinking level. */
export function piComplete(registry: Pick<ModelRegistry, "complete">, thinking?: ModelThinkingLevel): Complete {
  return ({ model, context, outputTokens, signal }) => {
    if (hasRawSamplingParams(model.samplingParams) || hasRawSamplingParams(model.samplingParamsByThinkingLevel)) {
      throw new EngineError("CONFIG", "Raw model sampling overrides are unsupported for maintenance");
    }
    return registry.complete(model, context, {
      maxTokens: outputTokens,
      signal,
      maxRetries: 0,
      cacheRetention: "none",
      transport: "sse",
      sessionId: randomUUID(),
      ...maintenanceThinkingOptions(model, thinking, outputTokens),
      ...(["google-vertex", "google-generative-ai"].includes(model.api) ? {
        onPayload: (payload: unknown) => {
          if (!record(payload)) throw new EngineError("CONFIG", "Expected a Google payload object");
          return { ...structuredClone(payload), config: { ...(record(payload.config) ? payload.config : {}),
            responseMimeType: "application/json", responseJsonSchema: PATCH_RESPONSE_JSON_SCHEMA } };
        },
      } : {}),
    });
  };
}
export function hasRawSamplingParams(value: unknown): boolean {
  return value !== undefined && value !== null && (!record(value) || Object.keys(value).length > 0);
}
export function rateLimited(message: string): boolean {
  return /(?:^|\(|\b(?:http(?:\/[\d.]+)?|status(?:[ _]code)?|error(?: code)?)[\s:=]+|"code"\s*:\s*)429\b|\bRESOURCE_EXHAUSTED\b/i.test(message);
}
/** Retrying must wrap Admission.complete, never run inside its single-use ALS ticket.
 * Only transport interruptions/throttling/server failures qualify; parsing and length
 * failures stay terminal. The delay is injectable for time-decoupled local tests. */
export function retryMaintenanceComplete(complete: Complete, baseDelayMs = 1000): Complete {
  return async request => {
    for (let attempt = 0; ; attempt++) {
      request.signal.throwIfAborted();
      let response: unknown;
      try { response = await complete(request); }
      catch (error) {
        if (request.signal.aborted || attempt >= 2 || !(error instanceof Error) ||
            error.name === "AbortError" || !transientTransportError(error.message)) throw error;
        await delay(baseDelayMs * 2 ** attempt, undefined, { signal: request.signal });
        continue;
      }
      if (request.signal.aborted || attempt >= 2 || !record(response) || response.role !== "assistant" ||
          response.model !== request.model.id || response.provider !== request.model.provider || response.api !== request.model.api ||
          (response.responseModel !== undefined && response.responseModel !== request.model.id) ||
          response.stopReason !== "error" ||
          typeof response.errorMessage !== "string" || !transientTransportError(response.errorMessage)) return response;
      await delay(baseDelayMs * 2 ** attempt, undefined, { signal: request.signal });
    }
  };
}
function transientTransportError(message: string): boolean {
  // A status-bearing deterministic failure wins over incidental retry-like wording.
  const terminalStatus = [...message.matchAll(/\b4(?!29\b)\d{2}\b/g)].some(match => {
    const prefix = message.slice(0, match.index);
    const suffix = message.slice(match.index + match[0].length);
    if (/\b(?:http(?:\/[\d.]+)?|status(?:[ _]?code)?|error[ _]?code|error(?=[:="'])|code)[\s:="']+$/i.test(prefix) && !/^\.\d/.test(suffix)) return true;
    // A three-digit prefix of a decimal quantity is never a status code.
    if (/^\.\d/.test(suffix) || /^\s*(?:ms|s|sec|seconds|tokens|requests|chars|bytes|min|minute)\b/i.test(suffix)) return false;
    const address = /(?<!["'])([\w.[\]:-]*):$/.exec(prefix);
    if (address && !/^(?:http|status|code|status_?code|error_?code)$/i.test(address[1]!)) return false;
    return !prefix || /\($|\b(?:http(?:\/[\d.]+)?|status(?:[ _]?code)?|error(?:[ _]?code)?|code)[\s:="']+$/i.test(prefix);
  });
  if (terminalStatus || /Nunc local|context[_ ]length|context window|overflow|malformed|invalid json|quota|billing|usage.limit|out of budget|available balance|cancel|abort/i.test(message)) return false;
  return /\b(?:429|5\d{2})\b|rate.?limit|too many requests|stream ended before (?:a terminal response event|message_stop)|stream (?:was interrupted|disconnected before completion)|terminated|\bECONN(?:REFUSED|RESET)\b|connection.?(?:error|lost|refused|reset|closed)|network.?error|fetch failed|socket hang up|other side closed|upstream_stream_read_error/i.test(message);
}
export function maintenanceThinkingOptions(model: Model<Api>, thinking: ModelThinkingLevel | undefined, outputTokens: number): Record<string, unknown> {
  if (thinking === undefined || !["openai-completions", "openai-responses", "openai-codex-responses", "azure-openai-responses", "anthropic-messages", "google-generative-ai", "google-vertex"].includes(model.api)) return {};
  if (clampThinkingLevel(model, thinking) !== thinking) throw new EngineError("CONFIG", `Maintenance thinking ${thinking} is unsupported by the current native model`);
  if (model.api === "anthropic-messages") {
    if (thinking === "off") return { thinkingEnabled: false };
    const effort = model.thinkingLevelMap?.[thinking] ?? (thinking === "minimal" ? "low" : thinking);
    // Pi's raw-option helpers are outside the extension loader's module surface.
    // Keep this budget translation local and verify parity against the native SDK.
    const budget = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 16384, max: 16384 }[thinking];
    return { thinkingEnabled: true, effort, thinkingBudgetTokens: Math.min(budget, Math.max(0, outputTokens - 1024)) };
  }
  if (model.api === "google-generative-ai" || model.api === "google-vertex") {
    if (thinking === "off") return { thinking: { enabled: false } };
    const level = (model.thinkingLevelMap?.[thinking] ?? thinking).toLowerCase();
    if (level !== "minimal" && level !== "low" && level !== "medium" && level !== "high") {
      throw new EngineError("CONFIG", `Unsupported Google thinking level mapping for ${model.provider}/${model.id}: ${thinking}`);
    }
    const id = model.id.toLowerCase();
    const usesLevel = /gemini-3(?:\.\d+)?-(?:pro|flash)|gemini-(?:[4-9]|[1-9]\d)|gemma-?4/.test(id) ||
      id === "gemini-flash-latest" || id === "gemini-flash-lite-latest";
    if (usesLevel) return { thinking: { enabled: true, level: level.toUpperCase() } };
    const budgets = { minimal: model.id.includes("flash-lite") ? 512 : 128, low: 2048, medium: 8192, high: model.id.includes("flash") ? 24576 : 32768 };
    return { thinking: { enabled: true, budgetTokens: model.id.includes("2.5") ? budgets[level] : -1 } };
  }
  return thinking === "off" ? {} : { reasoningEffort: thinking };
}

/** Effective native thinking control. Numeric values are token budgets (-1 means automatic),
 * not effort levels. Trailing conversation controls override request-level defaults. */
export function payloadThinking(payload: unknown): string | number | undefined {
  if (!record(payload)) return;
  if (Array.isArray(payload.input)) {
    const updates = payload.input.filter(item => record(item) && item.type === "configuration_update" && record(item.reasoning) && typeof item.reasoning.effort === "string");
    const last = updates.at(-1);
    if (record(last) && record(last.reasoning)) return last.reasoning.effort as string;
  }
  if (record(payload.reasoning) && typeof payload.reasoning.effort === "string") return payload.reasoning.effort;
  if (typeof payload.reasoning_effort === "string") return payload.reasoning_effort;
  if (record(payload.thinking) && payload.thinking.type === "disabled") return "off";
  if (Array.isArray(payload.messages)) {
    const updates = payload.messages.filter(item => record(item) && item.role === "system" && record(item.output_config) && typeof item.output_config.effort === "string");
    const last = updates.at(-1);
    if (record(last) && record(last.output_config)) return last.output_config.effort as string;
  }
  if (record(payload.output_config) && typeof payload.output_config.effort === "string") return payload.output_config.effort;
  if (record(payload.thinking)) {
    if (payload.thinking.type === "enabled" && typeof payload.thinking.budget_tokens === "number") return payload.thinking.budget_tokens;
    if (payload.thinking.type === "adaptive") return "adaptive";
  }
  const config = record(payload.config) ? payload.config : record(payload.generationConfig) ? payload.generationConfig : payload;
  if (record(config.thinkingConfig)) {
    if (typeof config.thinkingConfig.thinkingLevel === "string") return config.thinkingConfig.thinkingLevel.toLowerCase();
    if (typeof config.thinkingConfig.thinkingBudget === "number") return config.thinkingConfig.thinkingBudget;
  }
}
