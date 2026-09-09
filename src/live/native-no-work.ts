import { isDeepStrictEqual } from "node:util";
import { findCutPoint, sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { RunnerError, type RunConfig } from "./contract.js";

export interface NativeRpcDiagnostic {
  command: string;
  stage: "native-prehook" | "native-rpc";
  reason: "no-retirable-prefix" | "already-compacted" | "compaction-cancelled" | "unknown";
}
export class NativeRpcError extends RunnerError {
  constructor(readonly diagnostic: NativeRpcDiagnostic) {
    super("RPC", `Native ${diagnostic.command} failed: ${diagnostic.reason}`);
  }
}
/** Exact stock errors only; never retain exception bodies, even for unknown auth/RPC failures. */
export function nativeRpcError(command: string, error: unknown): NativeRpcError {
  const reason = command !== "compact" ? "unknown" : error === "Nothing to compact (session too small)" ? "no-retirable-prefix"
    : error === "Already compacted" ? "already-compacted" : error === "Compaction cancelled" ? "compaction-cancelled" : "unknown";
  return new NativeRpcError({ command, reason, stage: reason === "no-retirable-prefix" || reason === "already-compacted" ? "native-prehook" : "native-rpc" });
}
/** Public cut arithmetic corroborates the captured stock no-work response. */
export function noRetirablePrefix(branch: SessionEntry[], settings: RunConfig["compaction"]): boolean {
  if (branch.at(-1)?.type === "compaction") return true;
  const previous = branch.findLast(e => e.type === "compaction");
  const start = previous?.type === "compaction" ? branch.findIndex(e => e.id === previous.firstKeptEntryId) : 0;
  if (start < 0) return false;
  const cut = findCutPoint(branch, start, branch.length, settings.keepRecentTokens);
  return !branch.slice(start, cut.firstKeptEntryIndex).some(e => e.type !== "compaction" && sessionEntryToContextMessages(e).length > 0);
}
/** A captured no-work response alone is insufficient: reconcile source, native cut and effects. */
export function ordinaryNoWork(error: unknown, facts: {
  defaults: boolean; before: SessionEntry[]; after: SessionEntry[]; settings: RunConfig["compaction"];
  newPreparations: number; newMaintenance: number; newRequests: number; unresolved: number;
  isCompacting: boolean; pendingMessageCount: number;
}): boolean {
  return error instanceof NativeRpcError && ["no-retirable-prefix", "already-compacted"].includes(error.diagnostic.reason) &&
    facts.defaults && isDeepStrictEqual(facts.before, facts.after) &&
    facts.newPreparations === 0 && facts.newMaintenance === 0 && facts.newRequests === 0 && facts.unresolved === 0 &&
    !facts.isCompacting && facts.pendingMessageCount === 0 && noRetirablePrefix(facts.after, facts.settings);
}
