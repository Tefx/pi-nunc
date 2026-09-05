import { randomUUID } from "node:crypto";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Complete } from "./types.js";

/** Public Pi 0.85.0 seam. Auth remains host-owned; no registry creation, keys or transport copy. */
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
