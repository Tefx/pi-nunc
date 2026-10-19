import { createHash } from "node:crypto";
import type { ActiveEntry, MaintenanceCalibrationRecord, MaintenanceInput, MaintenanceResult, ProviderOverflow } from "./types.js";
import { applyToolResultCleanup } from "./cleanup.js";
import { mainPlanningEstimate } from "./accounting.js";
import { integer, nonempty, record } from "./validation.js";

type Snapshot = Omit<MaintenanceInput, "signal" | "binding" | "eligibleKeptEntryIds">;
function digest(value: unknown): string {
  // Persisted version 1 digests require JSON.stringify's integer-index key order.
  return createHash("sha256").update(JSON.stringify(value, (_key, item: unknown) => record(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest("hex");
}
function limitsDigest(input: Snapshot): string {
  const { toolResults: _mode, headTailChars: _chars, ...extraction } = input.config.extraction;
  return digest({ contextWindow: input.model.contextWindow, maxTokens: input.model.maxTokens, extraction, imageTokens: input.config.imageTokens });
}
function contextDigest(input: Snapshot): string {
  const { toolResults: _mode, headTailChars: _chars, ...extraction } = input.config.extraction;
  // Cleanup eligibility and B/K placement can grow with a legal source append.
  // Neither changes the original source prefix; including them would cause a blind full resend.
  return digest({ fixed: { systemPrompt: input.fixed.systemPrompt, tools: input.fixed.tools }, memory: input.memory, policy: input.policy,
    config: { ...input.config, extraction } });
}
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(nonempty) && new Set(value).size === value.length;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function valid(value: unknown): value is MaintenanceCalibrationRecord {
  if (!record(value) || value.version !== 1 || !nonempty(value.provider) || !nonempty(value.api) || !nonempty(value.modelId) ||
      !ids(value.sourceEntryIds) || !hash(value.sourceDigest) || !hash(value.limitsDigest)) return false;
  const overflow = value.providerOverflow, measurement = value.measurement;
  if (overflow !== undefined && (!record(overflow) || overflow.provider !== value.provider || overflow.api !== value.api || overflow.modelId !== value.modelId ||
      !["full", "reduced"].includes(String(overflow.mode)) || !ids(overflow.sourceEntryIds) ||
      JSON.stringify(overflow.sourceEntryIds) !== JSON.stringify(value.sourceEntryIds) || !hash(value.contextDigest) ||
      (overflow.mode === "reduced" && !integer(value.headTailChars, 1)) || !integer(overflow.estimatedInputTokens) ||
      !integer(overflow.extractionInputLimit, 1) || !integer(overflow.outputReserveTokens, 1) ||
      (overflow.reportedInputTokens !== null && !integer(overflow.reportedInputTokens)) ||
      (overflow.errorMessage !== undefined && typeof overflow.errorMessage !== "string"))) return false;
  if (measurement !== undefined && (!record(measurement) || !ids(measurement.sourceEntryIds) || !integer(measurement.estimatedInputTokens) ||
      !integer(measurement.actualInputTokens, 1) || !integer(measurement.undercountTokens) ||
      measurement.undercountTokens !== Math.max(0, measurement.actualInputTokens - measurement.estimatedInputTokens))) return false;
  return overflow !== undefined || measurement !== undefined;
}

/** Chronological selected-branch records in, at most three latest applicable records out.
 * Keep full/reduced refusals and measurement independently: an unknown-usage refusal must not erase either predecessor. */
export function selectMaintenanceCalibration(input: Snapshot, records: readonly unknown[] = input.calibration ?? []): MaintenanceCalibrationRecord[] {
  const limits = limitsDigest(input), context = contextDigest(input);
  let full: MaintenanceCalibrationRecord | undefined, reduced: MaintenanceCalibrationRecord | undefined, measured: MaintenanceCalibrationRecord | undefined;
  // Digests are per prefix, not leaf ID. Appending state or later delivered D leaves the old prefix applicable.
  const prefixes = new Map<number, string>();
  for (const value of records) {
    if (!valid(value) || value.provider !== input.model.provider || value.api !== input.model.api || value.modelId !== input.model.id || value.limitsDigest !== limits ||
        !value.sourceEntryIds.every((id, index) => input.active[index]?.entryId === id)) continue;
    const length = value.sourceEntryIds.length;
    let prefix = prefixes.get(length);
    if (!prefix) { prefix = digest(input.active.slice(0, length)); prefixes.set(length, prefix); }
    if (prefix !== value.sourceDigest) continue;
    if (value.measurement) measured = value;
    if (value.contextDigest !== context) continue;
    if (value.providerOverflow?.mode === "full") full = value;
    if (value.providerOverflow?.mode === "reduced" && value.headTailChars === input.config.extraction.headTailChars) reduced = value;
  }
  // Drop an inapplicable refusal from a still-applicable measurement record (and vice versa).
  return [...new Set([full, reduced, measured])].filter((value): value is MaintenanceCalibrationRecord => value !== undefined)
    .sort((a, b) => records.indexOf(a) - records.indexOf(b)).map(value => {
      const { providerOverflow, contextDigest: context, headTailChars, measurement, ...binding } = value;
      return { ...binding,
        ...((value === full || value === reduced) && providerOverflow ? { providerOverflow, contextDigest: context!, ...(headTailChars === undefined ? {} : { headTailChars }) } : {}),
        ...(value === measured && measurement ? { measurement } : {}) };
    });
}

/** Current-prefix provider usage bounds heuristic error without becoming persisted maintenance evidence. */
export function activeUsageUndercount(input: Snapshot, selectedSource: readonly ActiveEntry[] = input.active): number {
  const eligible = input.eligibleUsageEntryIds === undefined ? undefined : new Set(input.eligibleUsageEntryIds);
  if (!eligible && input.active.some(entry => entry.outputUsageUnavailable)) return 0;
  let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
  let anchor: { entryIndex: number; messageIndex: number; usageTokens: number } | undefined;
  for (const [entryIndex, entry] of input.active.entries()) {
    for (const [messageIndex, message] of entry.messages.entries()) {
      if (message.role === "assistant" && (!eligible || eligible.has(entry.entryId)) && !entry.outputUsageUnavailable &&
          message.timestamp >= latestPrefixTimestamp && message.stopReason !== "aborted" && message.stopReason !== "error" &&
          message.model === input.model.id && message.provider === input.model.provider && message.api === input.model.api &&
          record(message.usage) && [message.usage.input, message.usage.output, message.usage.cacheRead, message.usage.cacheWrite, message.usage.totalTokens].every(n => integer(n))) {
        const usageTokens = message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
        if (usageTokens >= 1) anchor = { entryIndex, messageIndex, usageTokens };
      }
      latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
    }
  }
  if (!anchor) return 0;
  const prefixTokens = (source: readonly ActiveEntry[]) => mainPlanningEstimate(input.fixed, input.memory.slots,
    [...source.slice(0, anchor.entryIndex), { ...source[anchor.entryIndex]!, messages: source[anchor.entryIndex]!.messages.slice(0, anchor.messageIndex + 1) }],
    input.model, input.config.imageTokens, input.config.main.extraInputTokens).tokens;
  const fullPrefixTokens = prefixTokens(input.active);
  const rawUndercount = Math.max(0, anchor.usageTokens - fullPrefixTokens);
  if (rawUndercount === 0 || fullPrefixTokens <= 0) return 0;
  if (selectedSource === input.active) return rawUndercount;
  return Math.ceil(rawUndercount * Math.min(1, prefixTokens(selectedSource) / fullPrefixTokens));
}

export function maintenanceFeedback(input: Snapshot, selectedSource: readonly ActiveEntry[] = input.active) {
  const selected = selectMaintenanceCalibration(input);
  const measurement = selected.findLast(value => value.measurement)?.measurement;
  const maintenanceUndercountTokens = measurement?.undercountTokens ?? 0;
  const activeUndercountTokens = activeUsageUndercount(input, selectedSource);
  return { full: selected.findLast(value => value.providerOverflow?.mode === "full")?.providerOverflow,
    reduced: selected.findLast(value => value.providerOverflow?.mode === "reduced")?.providerOverflow,
    calibratedUndercountTokens: Math.max(maintenanceUndercountTokens, activeUndercountTokens),
    maintenanceUndercountTokens, activeUndercountTokens, measurement };
}

export function sameRejectedRequest(overflow: ProviderOverflow | undefined, active: readonly ActiveEntry[], resolved: { extractionInputLimit: number; outputTokens: number }): boolean {
  return overflow !== undefined && overflow.sourceEntryIds.length === active.length &&
    overflow.extractionInputLimit === resolved.extractionInputLimit && overflow.outputReserveTokens === resolved.outputTokens;
}

/** Failed attempts save evidence only. Successful native handoffs rebind the measured correction to original K,
 * whose source is still active after compaction, while retaining the measured request's original provenance. */
export function maintenanceCalibrationRecord(input: Snapshot, result: MaintenanceResult): MaintenanceCalibrationRecord | undefined {
  if (result.observations.requests !== 1) return;
  const providerOverflow = result.ok ? undefined : result.observations.providerOverflow;
  const measurement = result.observations.maintenanceCalibration ?? (result.ok ? maintenanceFeedback(input).measurement : undefined);
  if (!providerOverflow && !measurement) return;
  const active = result.ok ? applyToolResultCleanup(result.candidate.kept, result.candidate.toolResultCleanup?.applied ?? []) : input.active;
  return { version: 1, provider: input.model.provider, api: input.model.api, modelId: input.model.id,
    sourceEntryIds: active.map(entry => entry.entryId), sourceDigest: digest(active), limitsDigest: limitsDigest(input),
    ...(providerOverflow ? { providerOverflow, contextDigest: contextDigest(input),
      ...(providerOverflow.mode === "reduced" ? { headTailChars: input.config.extraction.headTailChars } : {}) } : {}),
    ...(measurement ? { measurement } : {}) };
}
