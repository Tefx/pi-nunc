import * as accounting from "../engine/accounting.js";
import * as request from "../engine/request.js";
import * as validation from "../engine/validation.js";
import type { MaintenanceInput } from "../engine/types.js";
import { requireValue, RunnerError, type RetentionCalibrationRange } from "./contract.js";
import { validateControl, type Control } from "./scenarios.js";

export interface RetentionCalibration {
  afterTurn: string;
  firstKeptEntryId: string;
  previousFraction: number;
  selectedFraction: number;
  authorizedRange: RetentionCalibrationRange;
  model: { provider: string; id: string; contextWindow: number };
  accounting: { effectiveTrigger: number; fixedTokens: number; memoryLimit: number; keepTarget: number; keptTokens: number; mainInputLimit: number; extractionInputLimit: number; fullExtractionTokens: number; extractionTokens: number; normalExtractionAtTrigger: number; growthReserve: number };
}

/** Arithmetic only. No model call, host mutation, boundary injection, padding or observer prose enters a request. */
export function calibrateRetention(source: MaintenanceInput, control: Control, turnEntries: Record<string, string[]>, turnOrder: string[], range: RetentionCalibrationRange, target?: { firstKeptEntryId: string; accounting: typeof import("../engine/accounting.js"); request: typeof import("../engine/request.js"); validation: typeof import("../engine/validation.js") }): RetentionCalibration {
  const { chooseCut, inputLimit, mainContext, messageTokens, requestTokens } = target?.accounting ?? accounting;
  const { extractionContext, reduceToolBodies } = target?.request ?? request;
  const { legalCuts, validateConfig } = target?.validation ?? validation;
  const validateMemory: typeof validation.validateMemory = (target?.validation ?? validation).validateMemory;
  try {
    source.signal.throwIfAborted();
    validateControl(control, turnOrder);
    requireValue((control.action === "rollover" || control.action === "rollover_at_tool_boundary" && target) && control.placement, "CALIBRATION", "Calibration requires explicit rollover placement");
    requireValue(Number.isFinite(range.minFraction) && Number.isFinite(range.maxFraction) && range.minFraction > 0 && range.minFraction <= range.maxFraction && range.maxFraction < 1, "CALIBRATION", "Invalid authorized fraction range");
    validateConfig(source.config); validateMemory(source.memory);
    const { active, config, model } = source;
    const placement = control.placement;
    const ids = new Set(active.map(e => e.entryId));
    const mapped = (turn: string): string[] => {
      const entries = turnEntries[turn];
      requireValue(entries && entries.length > 0 && new Set(entries).size === entries.length, "CALIBRATION", `Missing actual entry mapping for turn ${turn}`);
      return entries;
    };
    const retired = new Set<string>();
    if (placement.retireThroughTurn) for (const turn of turnOrder.slice(0, turnOrder.indexOf(placement.retireThroughTurn) + 1)) for (const id of mapped(turn)) retired.add(id);
    if (placement.retireEvidenceFromTurn) {
      const entries = mapped(placement.retireEvidenceFromTurn);
      const evidence = active.filter(e => entries.includes(e.entryId) && e.messages.some(m => m.role === "toolResult"));
      requireValue(evidence.length > 0, "CALIBRATION", "Required retiring tool evidence is absent from the actual active window");
      for (const entry of evidence) retired.add(entry.entryId);
    }
    const retained = new Set((placement.retainTurns ?? []).flatMap(mapped));
    requireValue([...retained].every(id => ids.has(id) && !retired.has(id)), "CALIBRATION", "Required retained turn is absent or conflicts with retirement");
    let cuts = legalCuts(active);
    if (source.eligibleKeptEntryIds) cuts = cuts.filter(cut => source.eligibleKeptEntryIds!.includes(active[cut]!.entryId));
    const mainInput = inputLimit(model, config.main), extractionInput = inputLimit(model, config.extraction);
    const trigger = Math.min(config.triggerTokens, mainInput);
    const fixed = requestTokens(mainContext(source.fixed, [], []), config.imageTokens) + config.main.extraInputTokens;
    const available = trigger - fixed;
    requireValue(available > 0, "CALIBRATION", `Effective F exhausts the work budget: F=${fixed}, H=${trigger}, mainInputLimit=${mainInput}`);
    const memoryLimit = Math.floor(Math.min(config.memory.fraction * available, config.memory.maxTokens ?? Infinity));
    const denominator = available - memoryLimit;
    const suffix = new Array<number>(active.length + 1).fill(0);
    for (let i = active.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1]! + active[i]!.messages.reduce((sum, message) => sum + messageTokens(message, config.imageTokens), 0);
    const feasible = cuts.filter(cut => fixed + memoryLimit + suffix[cut]! + config.growthTokens <= trigger);
    for (const [position, cut] of feasible.entries()) {
      if (target && active[cut]!.entryId !== target.firstKeptEntryId) continue;
      if (active.slice(cut).some(e => retired.has(e.entryId)) || active.slice(0, cut).some(e => retained.has(e.entryId))) continue;
      // chooseCut selects the first feasible suffix <= floor(q*denominator), or its last feasible suffix if none fit.
      const lowerTarget = position === feasible.length - 1 ? 0 : suffix[cut]!;
      const previous = feasible[position - 1];
      const exclusiveUpper = previous === undefined ? 1 : suffix[previous]! / denominator;
      const lower = Math.max(range.minFraction, lowerTarget / denominator), upper = Math.min(range.maxFraction, exclusiveUpper);
      if (lower > upper) continue;
      const fraction = lower === upper ? lower : lower + (upper - lower) / 2;
      if (fraction < range.minFraction || fraction > range.maxFraction || fraction <= 0 || fraction >= 1) continue;
      const keepTarget = Math.floor(fraction * denominator);
      const chosen = chooseCut(active, cuts, fixed, memoryLimit, keepTarget, trigger, { ...config, keepRecentFraction: fraction });
      if (chosen.cut !== cut) continue; // Includes an empty intersection at an exclusive floating-point edge.
      const context = extractionContext(source, cut, memoryLimit, active, []);
      const fullExtraction = requestTokens(context, config.imageTokens) + config.extraction.extraInputTokens;
      const mainBefore = requestTokens(mainContext(source.fixed, source.memory.slots, active), config.imageTokens) + config.main.extraInputTokens;
      const normalAtTrigger = fullExtraction - mainBefore + trigger;
      // Trigger headroom is advisory. Calibrate against the actual extraction below.
      let extraction = fullExtraction;
      if (fullExtraction > extractionInput && config.extraction.toolResults === "auto") {
        const reduction = reduceToolBodies(active, config.extraction.headTailChars);
        extraction = requestTokens(extractionContext(source, cut, memoryLimit, reduction.source, reduction.omissions), config.imageTokens) + config.extraction.extraInputTokens;
      }
      requireValue(extraction <= extractionInput, "CALIBRATION", "The selected extraction cannot fit; no maintenance call made");
      return {
        afterTurn: (control.afterTurn ?? control.duringTurn)!, firstKeptEntryId: active[cut]!.entryId, previousFraction: config.keepRecentFraction, selectedFraction: fraction, authorizedRange: { ...range },
        model: { provider: model.provider, id: model.id, contextWindow: model.contextWindow },
        accounting: { effectiveTrigger: trigger, fixedTokens: fixed, memoryLimit, keepTarget, keptTokens: chosen.keptTokens, mainInputLimit: mainInput, extractionInputLimit: extractionInput, fullExtractionTokens: fullExtraction, extractionTokens: extraction, normalExtractionAtTrigger: normalAtTrigger, growthReserve: config.growthTokens },
      };
    }
    const wanted = target ? active.findIndex(e => e.entryId === target.firstKeptEntryId) : -1;
    throw new RunnerError("CALIBRATION", `No legal retained boundary within the authorized fraction range satisfies actual turn placement and growth: H=${trigger}, F=${fixed}, memoryLimit=${memoryLimit}, growth=${config.growthTokens}, requestedK=${wanted >= 0 ? suffix[wanted] : "unselected"}, legalCuts=${cuts.length}, feasibleCuts=${feasible.length}`);
  } catch (error) {
    if (error instanceof RunnerError) throw error;
    throw new RunnerError("CALIBRATION", error instanceof Error ? error.message : "Placement accounting failed before any maintenance call");
  }
}
