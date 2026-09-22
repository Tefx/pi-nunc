import { isDeepStrictEqual } from "node:util";
import { getCurrentSystemPrompt, type Context, type TranscriptContext } from "@earendil-works/pi-ai";
import type { Memory, MaintenanceResult } from "../engine/types.js";
import { memoryTokens } from "../engine/accounting.js";
import { readSourceRecords } from "../engine/request.js";
import { evaluateCapacityPredicates, type CheckResult } from "./scenarios.js";

/** Qualifies the observed response against this transaction's frozen source, never a config estimate. */
export function qualifyCapacity(
  variant: "fits-required" | "required-too-large",
  memory: Memory,
  result: MaintenanceResult | undefined,
  contexts: Array<Context | TranscriptContext>,
  responses: Array<{ model: string; stopReason: string; patch: unknown }>,
  model: string,
  growth?: { growthReserve: number; fixedTokens: number; memoryLimit: number; keptTokens: number; effectiveTrigger: number },
): CheckResult[] {
  const check = "capacity predicate bound to one frozen request and complete response";
  const limit = result?.observations.accounting?.memoryLimit;
  try {
    if (contexts.length !== 1 || responses.length !== 1 || limit === undefined ||
        responses[0]!.stopReason !== "stop" || responses[0]!.model !== model) throw new Error("Missing transaction evidence");
    const context = contexts[0]!;
    const rawPrompt = ("systemPrompt" in context && typeof context.systemPrompt === "string") ? context.systemPrompt : getCurrentSystemPrompt(context.messages);
    const declared = rawPrompt?.match(/Rendered memory limit: (\d+) estimated tokens/);
    const records = context.messages.flatMap(m => typeof m.content === "string" ? readSourceRecords(m.content) :
      m.content.flatMap(b => b.type === "text" ? readSourceRecords(b.text) : []));
    const fm = records.filter(r => r.source === "F/M");
    if (!declared || Number(declared[1]) !== limit || fm.length !== 1 || !isDeepStrictEqual(fm[0]!.M, memory.slots)) throw new Error("Frozen source differs");
    const a = result?.observations.accounting;
    const growthMatches = growth && a && ["fixedTokens", "memoryLimit", "keptTokens", "effectiveTrigger"].every(k => (growth as any)[k] === (a as any)[k]);
    const growthFits = growthMatches && growth!.fixedTokens + limit + growth!.keptTokens + growth!.growthReserve <= growth!.effectiveTrigger;
    return [{ check, status: "PROVEN", observed: { model, memoryLimit: limit, nextId: memory.nextId, memory: memory.slots, response: responses[0]!.patch } },
      { check: "growth reserved once outside the full memory limit", status: growthFits ? "PROVEN" : "UNPROVEN", observed: growth ?? null },
      ...evaluateCapacityPredicates(variant, responses[0]!.patch, limit, memoryTokens, memory.slots, memory.nextId)];
  } catch {
    return [{ check, status: "UNPROVEN", reason: "Missing or inconsistent current request/response, frozen memory or actual memory limit" }];
  }
}

/** Bind the engine's declared required IDs to the actual saved candidate. */
export function checkRequiredRetention(result: MaintenanceResult | undefined, saved: Memory): CheckResult {
  const req = result?.observations.required;
  const pass = result?.ok === true && req && !req.failed && req.declared.length > 0 &&
    new Set(req.retainedSlotIds).size === req.declared.length && req.retainedSlotIds.length === req.declared.length &&
    req.retainedSlotIds.every(id => result.candidate.memory.slots.some(s => s.id === id)) &&
    isDeepStrictEqual(result.candidate.memory, saved);
  return { check: "all marked necessary candidates jointly retained in final memory", status: pass ? "PROVEN" : "UNPROVEN", observed: { required: req ?? null, saved } };
}

/** A completed assistant alone cannot establish recovery after a failed rollover. */
export function checkCapacityRecovery(facts: {
  capacityFailed: boolean; deliveredCount: number; terminalStop: boolean;
  memoryAndBoundaryUnchanged: boolean; additionalMaintenance: number;
}): CheckResult {
  return { check: "continuation following capacity failure (failure-path recovery)",
    status: facts.capacityFailed && facts.deliveredCount === 1 && facts.terminalStop &&
      facts.memoryAndBoundaryUnchanged && facts.additionalMaintenance === 0 ? "PROVEN" : "UNPROVEN", observed: facts };
}
