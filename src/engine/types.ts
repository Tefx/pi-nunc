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
  /** Requested extraction output (including reasoning), or native main capability.
   * On uncapped APIs this is a planning value, never an enforceable cap. */
  outputTokens: number;
  /** Main-only planning headroom; native transport owns output sizing/overflow. */
  nativeOutputReserve?: number;
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
  /** Optional per-image planning override; absent uses Pi's heuristic, not a hard upper bound. */
  imageTokens?: number;
  /** Enable tool result cleanup on M change (default true). */
  toolResultCleanup?: boolean;
}
export interface MaintenanceInput {
  binding: Binding;
  model: Model<Api>;
  fixed: FixedContext;
  memory: Memory;
  active: ActiveEntry[];
  /** Optional host-path restrictions (e.g. avoid a kept range crossing an older compaction). */
  eligibleKeptEntryIds?: string[];
  /** Optional caller-supplied candidate scope for tool result cleanup. */
  cleanupCandidateScope?: ToolResultRef[];
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
export interface RequiredObservation {
  declared: string[];
  retainedSlotIds: string[];
  failed: boolean;
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
  estimator: "pi-heuristic";
  outputReserveTokens: number;
  outputCapTokens: number | null;
  normalHeadroomSufficient: boolean;
  suggestedReserveTokens: number;
  inputExceededPlan: boolean;
  outputExceededPlan: boolean;
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
  required?: RequiredObservation;
  toolResultCleanup?: ToolResultCleanupResult;
}
export type FailureCode = "CONFIG" | "INPUT" | "UNSUPPORTED_INPUT" | "CAPACITY" | "RESPONSE" | "MODEL" | "CANCELLED";

export type ToolResultRef = { entryId: string; messageIndex: number };
export type SourceRef = { entryId: string; messageIndex: number };

export interface ToolResultEdit {
  entryId: string;
  messageIndex: number;
  action: "omit" | "replace";
  text?: string | undefined;
  memoryRefs?: string[] | undefined;
  sourceRefs?: SourceRef[] | undefined;
}

export type CleanupAction = "omit" | "replace" | "deduplicate" | "compact_json" | "clean_terminal" | "strip_boilerplate";

export interface ToolResultDecision {
  entryId: string;
  messageIndex: number;
  toolCallId: string;
  toolName: string;
  kind: "mechanical" | "semantic";
  action: CleanupAction;
  text: string;
  originalLength: number;
  cleanedLength: number;
  netSavings: number;
  memoryRefs?: string[] | undefined;
  sourceRefs?: SourceRef[] | undefined;
}

export type CleanupSkippedReason =
  | "not_in_candidate_scope"
  | "not_a_tool_result"
  | "has_omissions"
  | "invalid_shape"
  | "duplicate_edit"
  | "batch_conflict"
  | "missing_memory_dependency"
  | "missing_source_dependency"
  | "no_net_savings"
  | "keeper_protected"
  | "m_unchanged"
  | "non_text_content";

export interface CleanupSkipped {
  entryId: string;
  messageIndex: number;
  toolCallId?: string | undefined;
  action?: string | undefined;
  reason: CleanupSkippedReason;
  details?: string | undefined;
}

export interface ToolResultCleanupResult {
  applied: ToolResultDecision[];
  skipped: CleanupSkipped[];
}

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
    toolResultCleanup?: ToolResultCleanupResult;
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
