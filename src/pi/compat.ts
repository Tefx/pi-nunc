import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EngineError } from "../engine/validation.js";

/** Runtime policy: stable1.x from the tested public-API baseline; Pi supplies host peers. */
export const SUPPORTED_PI_RANGE = "^1.0.3";
export function isSupportedPiVersion(version: unknown): boolean {
  if (typeof version !== "string") return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match || match[0] !== version) return false;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  return [major, minor, patch].every(Number.isSafeInteger) && major === 1 && (minor! > 0 || patch! >= 3);
}
export function assertSupportedPiVersion(version: unknown): void {
  if (!isSupportedPiVersion(version)) throw new EngineError("CONFIG", `Nunc requires stable Pi ${SUPPORTED_PI_RANGE}; found ${String(version)}. Prereleases and other major versions require explicit compatibility work.`);
}

/** Fail before provider/session operations if a host violates the baseline public API. */
export function assertPiContextCompatibility(ctx: ExtensionContext): void {
  const groups: [unknown, string, string[]][] = [
    [ctx, "ExtensionContext", ["isProjectTrusted", "getSystemPrompt"]],
    [ctx.sessionManager, "SessionManager", ["buildContextEntries", "getBranch", "getSessionFile", "getSessionId", "getLeafId"]],
    [ctx.modelRegistry, "ModelRegistry", ["getProvider", "getRegisteredNativeProvider", "getRegisteredProviderConfig", "registerProvider"]],
  ];
  for (const [owner, label, methods] of groups) for (const name of methods) {
    if (owner === null || typeof owner !== "object" || typeof (owner as Record<string, unknown>)[name] !== "function") {
      throw new EngineError("CONFIG", `Pi compatibility error: required public ${label}.${name}() is unavailable; no maintenance candidate can be saved.`);
    }
  }
}
