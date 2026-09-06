import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { EngineConfig } from "../engine/index.js";
import { EngineError, record, validateConfig } from "../engine/validation.js";

export interface NuncConfig {
  policyFile?: string;
  memory?: { fraction?: number; maxTokens?: number };
  rolling?: { keepRecentFraction?: number };
  extraction?: { toolResults?: "auto" | "full"; headTailChars?: number; outputTokens?: number };
  budget?: { safetyTokens?: number; growthTokens?: number; extraMainInputTokens?: number; extraExtractionInputTokens?: number; inputLimit?: number; imageTokens?: number };
}
function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EngineError("CONFIG", `${label} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new EngineError("CONFIG", `Unknown ${label}.${key}`);
  return value as Record<string, unknown>;
}
export function parseConfig(value: unknown): NuncConfig {
  const root = object(value, ["policyFile", "memory", "rolling", "extraction", "budget"], "nunc");
  if (root.policyFile !== undefined && (typeof root.policyFile !== "string" || !root.policyFile.trim())) throw new EngineError("CONFIG", "policyFile must be a nonempty path");
  const sections: Record<string, string[]> = {
    memory: ["fraction", "maxTokens"], rolling: ["keepRecentFraction"], extraction: ["toolResults", "headTailChars", "outputTokens"],
    budget: ["safetyTokens", "growthTokens", "extraMainInputTokens", "extraExtractionInputTokens", "inputLimit", "imageTokens"],
  };
  for (const [section, keys] of Object.entries(sections)) {
    if (root[section] === undefined) continue;
    for (const [key, v] of Object.entries(object(root[section], keys, section))) {
      const valid = key === "toolResults" ? v === "auto" || v === "full"
        : key === "fraction" ? typeof v === "number" && v >= 0 && v < 1
        : key === "keepRecentFraction" ? typeof v === "number" && v > 0 && v < 1
        : typeof v === "number" && Number.isSafeInteger(v) && (key.startsWith("extra") ? v >= 0 : v > 0);
      if (!valid) throw new EngineError("CONFIG", `Invalid ${section}.${key}`);
    }
  }
  return structuredClone(root) as NuncConfig; // Every allowed field is checked above.
}
export function readConfig(flag: unknown, cwd: string): { config: NuncConfig; configFile?: string } {
  if (flag === undefined) return { config: {} };
  if (typeof flag !== "string" || !flag.trim()) throw new EngineError("CONFIG", "--nunc-config requires a path");
  const configFile = isAbsolute(flag) ? flag : resolve(cwd, flag);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(configFile));
    return { config: parseConfig(JSON.parse(text)), configFile };
  } catch (cause) {
    if (cause instanceof EngineError) throw cause;
    throw new EngineError("CONFIG", `Cannot load Nunc configuration: ${configFile}`, { cause });
  }
}
export interface HostCompactionSettings { reserveTokens: number; keepRecentTokens: number }
export function engineConfig(config: NuncConfig, model: Model<Api>, settings: HostCompactionSettings): EngineConfig {
  const triggerTokens = model.contextWindow - settings.reserveTokens;
  if (!Number.isSafeInteger(settings.reserveTokens) || settings.reserveTokens <= 0 || triggerTokens <= 0 ||
      !Number.isSafeInteger(settings.keepRecentTokens) || settings.keepRecentTokens < 0 || settings.keepRecentTokens >= triggerTokens) {
    throw new EngineError("CONFIG", "Pi reserveTokens must leave a positive H, and 0 <= keepRecentTokens < H; lower keepRecentTokens with an earlier trigger");
  }
  // Pi 0.85.1's stock streamSimple supplies no per-turn maxTokens. Its default
  // uses model.maxTokens (thinking inside that ceiling), possibly clamped DOWN
  // to available context. Reserve that actual host-default upper bound. A host
  // overriding stream options/payload must provide a separately verified adapter.
  const mainOutput = model.maxTokens;
  const uncapped = model.api === "openai-codex-responses" ||
    (model.api === "openai-responses" && record(model.compat) && model.compat.supportsMaxOutputTokens === false);
  const outputTokens = config.extraction?.outputTokens ?? (uncapped ? model.maxTokens : Math.min(4096, model.maxTokens));
  const common = { safetyTokens: config.budget?.safetyTokens ?? 1024, ...(config.budget?.inputLimit === undefined ? {} : { inputLimit: config.budget.inputLimit }) };
  const result: EngineConfig = {
    triggerTokens,
    memory: { fraction: config.memory?.fraction ?? 0.1, ...(config.memory?.maxTokens === undefined ? {} : { maxTokens: config.memory.maxTokens }) },
    keepRecentFraction: config.rolling?.keepRecentFraction ?? 0.67,
    growthTokens: config.budget?.growthTokens ?? 1024,
    main: { ...common, outputTokens: mainOutput, extraInputTokens: config.budget?.extraMainInputTokens ?? 0 },
    extraction: { ...common, outputTokens, extraInputTokens: config.budget?.extraExtractionInputTokens ?? 0, toolResults: config.extraction?.toolResults ?? "auto", headTailChars: config.extraction?.headTailChars ?? 200 },
    ...(config.budget?.imageTokens === undefined ? {} : { imageTokens: config.budget.imageTokens }),
  };
  validateConfig(result);
  return result;
}
