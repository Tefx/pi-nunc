import { randomUUID } from "node:crypto";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Complete } from "./types.js";

/** Public Pi 0.85.1 `ModelRegistry.complete`. Host auth/Provider headers apply; SDK `before_provider_headers` / request / response hooks do not. */
export function piComplete(registry: Pick<ModelRegistry, "complete">): Complete {
  return ({ model, context, outputTokens, signal }) => registry.complete(model, context, {
    maxTokens: outputTokens,
    signal,
    maxRetries: 0,
    cacheRetention: "none",
    transport: "sse",
    sessionId: randomUUID(),
  });
}
