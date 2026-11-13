import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import { EngineError, record } from "./validation.js";
import type { Complete } from "./types.js";
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
 * OpenAI-compatible raw calls need explicit effort; omitting it does not inherit
 * the session's thinking level. Other APIs retain their existing raw-call behavior. */
export function piComplete(registry: Pick<ModelRegistry, "complete">, thinking?: ModelThinkingLevel): Complete {
  return ({ model, context, outputTokens, signal }) => registry.complete(model, context, {
    maxTokens: outputTokens,
    signal,
    maxRetries: 0,
    cacheRetention: "none",
    transport: "sse",
    sessionId: randomUUID(),
    ...rawThinking(model, thinking),
  });
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
  if (/\b4(?!29\b)\d{2}\b|Nunc local|context[_ ]length|context window|overflow|malformed|invalid json|quota|billing|usage.limit|out of budget|available balance|cancel|abort/i.test(message)) return false;
  return /\b(?:429|5\d{2})\b|rate.?limit|too many requests|stream ended before (?:a terminal response event|message_stop)|stream (?:was interrupted|disconnected before completion)|terminated|connection.?(?:error|lost|refused|reset|closed)|network.?error|fetch failed|socket hang up|other side closed|upstream_stream_read_error/i.test(message);
}
function rawThinking(model: Model<Api>, thinking?: ModelThinkingLevel): { reasoningEffort?: Exclude<ModelThinkingLevel, "off"> } {
  if (thinking === undefined || !["openai-completions", "openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(model.api)) return {};
  if (clampThinkingLevel(model, thinking) !== thinking) throw new EngineError("CONFIG", `Maintenance thinking ${thinking} is unsupported by the current native model`);
  return thinking === "off" ? {} : { reasoningEffort: thinking };
}
