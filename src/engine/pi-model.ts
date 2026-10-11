import { randomUUID } from "node:crypto";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import { EngineError } from "./validation.js";
import type { Complete } from "./types.js";

/** Read only public native auth metadata, never the credential or an API-key prefix.
 * Legacy Codex's API is subscription-only; other OAuth providers declare their
 * subscription status through the native provider contract. */
export function subscriptionBilling(model: Model<Api>, registry: Pick<ModelRegistry, "isUsingOAuth" | "getProvider">): boolean {
  return model.api === "openai-codex-responses" ||
    (registry.isUsingOAuth(model) && registry.getProvider(model.provider)?.auth?.oauth?.isSubscription === true);
}

/** Public Pi complete: native authentication/transport remain host-owned.
 * Responses raw calls need explicit effort; omitting it does not inherit the
 * session's thinking level. Other APIs retain their existing raw-call behavior. */
export function piComplete(registry: Pick<ModelRegistry, "complete">, thinking?: ModelThinkingLevel): Complete {
  return ({ model, context, outputTokens, signal }) => registry.complete(model, context, {
    maxTokens: outputTokens,
    signal,
    maxRetries: 0,
    cacheRetention: "none",
    transport: "sse",
    sessionId: randomUUID(),
    ...responsesThinking(model, thinking),
  });
}
function responsesThinking(model: Model<Api>, thinking?: ModelThinkingLevel): { reasoningEffort?: Exclude<ModelThinkingLevel, "off"> } {
  if (thinking === undefined || !["openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(model.api)) return {};
  if (clampThinkingLevel(model, thinking) !== thinking) throw new EngineError("CONFIG", `Maintenance thinking ${thinking} is unsupported by the current native model`);
  return thinking === "off" ? {} : { reasoningEffort: thinking };
}
