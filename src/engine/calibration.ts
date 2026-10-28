import { createHash } from "node:crypto";
import type { ActiveEntry, MaintenanceCalibrationRecord, MaintenanceInput, MaintenanceResult, ProviderOverflow } from "./types.js";
import { applyToolResultCleanup } from "./cleanup.js";
import { mainPlanningEstimate, messagePlanningEstimate } from "./accounting.js";
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
    config: { ...input.config, extraction }, ...(input.target ? { target: input.target } : {}) });
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

export interface ActiveUsageObservation {
  entryIndex: number;
  messageIndex: number;
  rawUndercountTokens: number;
  undercountTokens: number;
}

/** Current-prefix provider usage bounds heuristic error without becoming persisted maintenance evidence. */
export function activeUsageObservation(input: Snapshot, selectedSource: readonly ActiveEntry[] = input.active): ActiveUsageObservation | undefined {
  const eligible = input.eligibleUsageEntryIds === undefined ? undefined : new Set(input.eligibleUsageEntryIds);
  if (!eligible && input.active.some(entry => entry.outputUsageUnavailable)) return undefined;
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
  if (!anchor) return undefined;
  const prefixEntries = (source: readonly ActiveEntry[]) => [
    ...source.slice(0, anchor.entryIndex),
    { ...source[anchor.entryIndex]!, messages: source[anchor.entryIndex]!.messages.slice(0, anchor.messageIndex + 1) },
  ];
  const fullPlan = mainPlanningEstimate(input.fixed, input.memory.slots, prefixEntries(input.active),
    input.model, input.config.imageTokens, input.config.main.extraInputTokens);
  const anchorEntry = input.active[anchor.entryIndex]!;
  const anchorMessage = anchorEntry.messages[anchor.messageIndex]!;
  const anchorPlan = messagePlanningEstimate(anchorMessage, input.model, input.config.imageTokens, anchorEntry.outputUsageUnavailable);
  // Normalize only this anchor's encrypted-reasoning proxy; earlier forecast-only
  // response-output proxies cannot reduce observed visible-equivalent error.
  const visibleUsageTokens = Math.max(0, anchor.usageTokens - anchorPlan.additionalTokens);
  const fullPrefixTokens = fullPlan.visibleTokens;
  const rawUndercount = Math.max(0, visibleUsageTokens - fullPrefixTokens);
  const undercountTokens = rawUndercount === 0 || fullPrefixTokens <= 0 || selectedSource === input.active
    ? rawUndercount
    : Math.ceil(rawUndercount * Math.min(1, mainPlanningEstimate(input.fixed, input.memory.slots, prefixEntries(selectedSource),
      input.model, input.config.imageTokens, input.config.main.extraInputTokens).visibleTokens / fullPrefixTokens));
  return { entryIndex: anchor.entryIndex, messageIndex: anchor.messageIndex, rawUndercountTokens: rawUndercount, undercountTokens };
}

export function activeUsageUndercount(input: Snapshot, selectedSource: readonly ActiveEntry[] = input.active): number {
  return activeUsageObservation(input, selectedSource)?.undercountTokens ?? 0;
}

export function maintenanceFeedback(input: Snapshot, selectedSource: readonly ActiveEntry[] = input.active, candidateExtractionTokens?: number) {
  const selected = selectMaintenanceCalibration(input);
  const measuredRecord = selected.findLast(value => value.measurement);
  const measurement = measuredRecord?.measurement;
  const activeObs = activeUsageObservation(input, selectedSource);
  const rawMaintenanceUndercountTokens = measurement?.undercountTokens ?? 0;
  let maintenanceUndercountTokens = 0;
  if (measuredRecord && measurement && measurement.undercountTokens > 0) {
    const rebound = measuredRecord.sourceEntryIds.length < measurement.sourceEntryIds.length ||
      measuredRecord.sourceEntryIds.some((id, index) => measurement.sourceEntryIds[index] !== id);
    if (rebound && activeObs !== undefined && activeObs.entryIndex >= measuredRecord.sourceEntryIds.length) {
      maintenanceUndercountTokens = activeObs.undercountTokens;
    } else if (selectedSource === input.active) {
      maintenanceUndercountTokens = measurement.undercountTokens;
    } else {
      const measuredIds = new Set(measurement.sourceEntryIds);
      const survivingActive = input.active.filter(entry => measuredIds.has(entry.entryId));
      const survivingSelected = selectedSource.filter(entry => measuredIds.has(entry.entryId));
      if (survivingSelected.length > 0 && measurement.estimatedInputTokens > 0) {
        const candidateTokens = !rebound && survivingActive.length === measurement.sourceEntryIds.length &&
          input.active.length === measurement.sourceEntryIds.length && candidateExtractionTokens !== undefined
          ? candidateExtractionTokens
          : mainPlanningEstimate(input.fixed, input.memory.slots, survivingSelected,
            input.model, input.config.imageTokens, input.config.extraction.extraInputTokens).visibleTokens;
        const ratio = Math.min(1, Math.max(0, candidateTokens) / measurement.estimatedInputTokens);
        maintenanceUndercountTokens = Math.ceil(measurement.undercountTokens * ratio);
      }
    }
  }
  const activeUndercountTokens = activeObs?.undercountTokens ?? 0;
  return { full: selected.findLast(value => value.providerOverflow?.mode === "full")?.providerOverflow,
    reduced: selected.findLast(value => value.providerOverflow?.mode === "reduced")?.providerOverflow,
    calibratedUndercountTokens: Math.max(maintenanceUndercountTokens, activeUndercountTokens),
    maintenanceUndercountTokens, rawMaintenanceUndercountTokens, activeUndercountTokens, measurement };
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
