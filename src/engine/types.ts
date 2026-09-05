import type { Api, Context, Message, Model, Tool } from "@earendil-works/pi-ai";

export interface Slot { id: string; text: string }
export interface Memory { version: 1; slots: Slot[]; nextId: number }
/** One indivisible, context-visible host entry. No old compaction entries. */
export interface ActiveEntry {
  entryId: string;
  sourceRole: "user" | "assistant" | "toolResult" | "custom" | "bashExecution" | "branchSummary";
  messages: Message[];
}
export interface FixedContext { systemPrompt: string; tools: Tool[] }
/** Identity is an adapter-owned generation, advanced on session/path/model/options change. */
export interface Binding { sessionId: string; leafId: string; generation: string }
export interface PolicySnapshot { builtin: string; user: string }
export interface RequestBudget {
  /** Total output ceiling, INCLUDING reasoning. Must match the actual request. */
  outputTokens: number;
  safetyTokens: number;
  /** Independent provider input/output ceilings, if narrower than model metadata. */
  inputLimit?: number;
  outputLimit?: number;
  /** Extra provider framing/options input not represented by Context. */
  extraInputTokens: number;
}
export interface EngineConfig {
  /** Pi's effective contextWindow - compaction.reserveTokens, not another scheduler. */
  triggerTokens: number;
  memory: { fraction: number; maxTokens?: number };
  keepRecentFraction: number;
  growthTokens: number;
  main: RequestBudget;
  extraction: RequestBudget & {
    toolResults: "full" | "auto";
    /** One reduction pass: this many Unicode code points at EACH end per tool text block. */
    headTailChars: number;
  };
  /** Explicit provider-specific upper bound per native image; absent means unsupported capacity. */
  imageTokens?: number;
}
export interface MaintenanceInput {
  binding: Binding;
  model: Model<Api>;
  fixed: FixedContext;
  memory: Memory;
  active: ActiveEntry[];
  /** Optional host-path restrictions (e.g. avoid a kept range crossing an older compaction). */
  eligibleKeptEntryIds?: string[];
  policy: PolicySnapshot;
  config: EngineConfig;
  signal: AbortSignal;
}
export interface Omission {
  entryId: string;
  messageIndex: number;
  blockIndex: number;
  toolCallId: string;
  omittedCodePoints: number;
  headChars: number;
  tailChars: number;
}
export interface UsageObservation {
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  /** Sum of input + cacheRead + cacheWrite; cached tokens still occupy context. */
  contextInput: number | null;
  output: number | null;
  reasoning: number | null;
  totalTokens: number | null;
  cost: number | null;
}
export interface Accounting {
  estimator: "utf8-upper-estimate-v1";
  fixedTokens: number;
  mainBeforeTokens: number;
  mainInputLimit: number;
  extractionInputLimit: number;
  effectiveTrigger: number;
  memoryLimit: number;
  keepTarget: number;
  keptTokens: number;
  fullExtractionTokens: number;
  extractionTokens: number;
  normalExtractionAtTrigger: number;
  mainAfterTokens: number | null;
  memoryTokens: number | null;
  growthTokens: number | null;
}
export interface Observations {
  requests: number;
  elapsedMs: number;
  usage: UsageObservation;
  accounting: Accounting | null;
  omissions: Omission[];
  droppedSlotIds: string[];
}
export type FailureCode = "CONFIG" | "INPUT" | "UNSUPPORTED_INPUT" | "CAPACITY" | "RESPONSE" | "MODEL" | "CANCELLED";
export type MaintenanceResult = {
  ok: true;
  binding: Binding;
  candidate: {
    memory: Memory;
    summary: string;
    firstKeptEntryId: string;
    /** Detached original suffix, never the reduced extraction copy. */
    kept: ActiveEntry[];
    retiredEntryIds: string[];
  };
  observations: Observations;
} | {
  ok: false;
  code: FailureCode;
  message: string;
  observations: Observations;
  cause?: unknown;
};
export interface ModelRequest {
  model: Model<Api>;
  context: Context;
  outputTokens: number;
  signal: AbortSignal;
}
/** The only effect seam. Implementations must propagate signal; responses remain untrusted. */
export type Complete = (request: ModelRequest) => Promise<unknown>;
