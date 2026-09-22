import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readFile, realpath, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { Api, Model } from "@earendil-works/pi-ai";
import { engineConfig, parseConfig, type NuncConfig } from "../pi/config.js";
export type { NuncConfig } from "../pi/config.js";

export class RunnerError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function requireValue(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new RunnerError(code, message);
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function namedRequirement(input: { overrides?: Record<string, unknown>[] }, requirement: string): boolean {
  return (input.overrides ?? []).some(o => object(o) && o.requirement === requirement);
}
/** Named live override: load the tracked synthetic last-user append callback. */
export function payloadAppendEnabled(input: { overrides?: Record<string, unknown>[] }): boolean {
  return namedRequirement(input, "payload-append");
}
/** Second tracked last-user append; compose with `payload-append` for two suffix parts. */
export function payloadAppendBEnabled(input: { overrides?: Record<string, unknown>[] }): boolean {
  return namedRequirement(input, "payload-append-b");
}
/** Transparent Provider wrap after the first settled turn so Nunc re-captures the chain. */
export function providerWrapEnabled(input: { overrides?: Record<string, unknown>[] }): boolean {
  return namedRequirement(input, "provider-wrap");
}
/** Verification-only: drop frozen prestate after session_before_compact so a real persist can still miss identity. */
export function identityPrestateProbeEnabled(input: { overrides?: Record<string, unknown>[] }): boolean {
  return namedRequirement(input, "identity-prestate-probe");
}
function keys(value: unknown, allowed: string[], label: string): asserts value is Record<string, unknown> {
  requireValue(object(value), "INPUT", `${label} must be an object`);
  requireValue(Object.keys(value).every(k => allowed.includes(k)), "INPUT", `Unknown ${label} field`);
}
function positive(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= max;
}
function optionalPositive(value: unknown, key: string): number | null {
  if (value === undefined || value === null) return null;
  requireValue(positive(value), "LIMIT", `Positive bounded ${key} required`);
  return value;
}
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 4096; }
export interface BatchAuthority {
  firstDispatchAt?: number | string;
  deadline?: number | string;
  priorLedgers?: string[];
  sharedLedger?: string;
}
export interface Limits {
  maxCalls: number | null;
  maxTotalTokens: number | null;
  maxCostUsd: number | null;
  maxDurationMs: number;
  maxOutputTokens: number;
  firstDispatchAt?: number | string;
  deadline?: number | string;
  priorLedgers?: string[];
  sharedLedger?: string;
}
export interface RetentionCalibrationRange { minFraction: number; maxFraction: number }
export interface RunConfig { nunc: NuncConfig; compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number }; retentionCalibration?: RetentionCalibrationRange }
export interface ScenarioAssets { inputs?: string; observer?: string }
export interface Selection { id: "c1" | "c2" | "c3" | "c4" | "c5" | "e1" | "e2" | "e3" | "e4" | "g1" | "g2" | "g3" | "g4" | "g5" | "g6" | "g7" | "g8" | "m1" | "m2" | "m3" | "m4"; variant?: "full" | "capacity" | "late-d" | "fits-required" | "required-too-large" | "archive-closeout" | "conflict" | "unconfirmed" | "moving" | "fixed" | "keep-0.67" | "keep-0.5" | "task-file" | "active-edit" | "scoped-tasks" | "source-loss" | "source-unavailable" | "commit-conflict" | "commit-unconfirmed"; config: RunConfig; assets?: ScenarioAssets }
export type ComparisonMode = "defaults" | "matched";
export type ComparisonGroup = "native" | "current" | "candidate";
export interface ComparisonTarget { repository: string; ref?: string }
/** Only the incremental variants select the new model contract; legacy g4 stays legacy. */
export function taskRetentionSelection(s: { id?: unknown; variant?: unknown }): boolean {
  return s.id === "g3" && s.variant === "scoped-tasks" || s.id === "g4" &&
    ["task-file", "active-edit", "source-loss", "source-unavailable", "commit-conflict", "commit-unconfirmed"].includes(String(s.variant));
}
export function taskRetentionRun(input: { scenarios: unknown; overrides?: unknown }): boolean {
  return Array.isArray(input.scenarios) && input.scenarios.some(s => object(s) && taskRetentionSelection(s)) ||
    Array.isArray(input.overrides) && input.overrides.some(o => object(o) && o.requirement === "task-retention-luna");
}
export interface ComparisonConfig {
  modes: ComparisonMode[];
  targets: {
    native: ComparisonTarget;
    current: ComparisonTarget;
    candidate: ComparisonTarget;
  };
}
export interface RunInput {
  version: 1;
  effective?: { source: "invoking-runtime" | "standalone-defaults"; provider: string; model: string; thinking: string; transport: string; compaction: RunConfig["compaction"]; settings: Record<string, unknown> };
  overrides?: Record<string, unknown>[];
  resolvedModels?: Model<Api>[];
  mode: "controlled" | "native";
  target: { repository: string; stateRoot: string; cleanup: "retain" | "remove" };
  models: Array<{ provider: string; id: string; contextWindow: number; maxTokens: number; baseUrl: string }>;
  limits: Limits;
  scenarios: Selection[];
  receipt?: Receipt;
  observations?: Array<"stock_rpc" | "stock_tui" | "continuation">;
  comparison?: ComparisonConfig;
  assets?: ScenarioAssets;
  batch?: BatchAuthority;
  authority?: BatchAuthority;
}
export interface Receipt { version: 1; binding: string; candidate: string; node: string; pi: "0.86.1"; callsMade: 0 }
export const MAX_STDIN_BYTES = 65536;
export async function readBoundedJson(stream: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>): Promise<unknown> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk); length += bytes.length;
    requireValue(length <= MAX_STDIN_BYTES, "INPUT_SIZE", "stdin exceeds 65536 bytes"); chunks.push(bytes);
  }
  requireValue(length > 0, "INPUT", "A bounded task selection JSON object is required on stdin");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw new RunnerError("INPUT", "stdin must contain one JSON object"); }
}
export function within(path: string, parent: string): boolean {
  const rel = relative(parent, path); return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
export function validateConfig(value: unknown): asserts value is RunConfig {
  keys(value, ["nunc", "compaction", "retentionCalibration"], "scenario config");
  if (value.retentionCalibration !== undefined) {
    keys(value.retentionCalibration, ["minFraction", "maxFraction"], "retentionCalibration");
    const { minFraction, maxFraction } = value.retentionCalibration;
    requireValue(typeof minFraction === "number" && typeof maxFraction === "number" && Number.isFinite(minFraction) && Number.isFinite(maxFraction) && minFraction > 0 && minFraction <= maxFraction && maxFraction < 1, "CONFIG", "Calibration requires explicit 0 < minFraction <= maxFraction < 1 authorization");
  }
  keys(value.compaction, ["enabled", "reserveTokens", "keepRecentTokens"], "compaction");
  requireValue(typeof value.compaction.enabled === "boolean" && positive(value.compaction.reserveTokens) && Number.isSafeInteger(value.compaction.keepRecentTokens) && Number(value.compaction.keepRecentTokens) >= 0, "CONFIG", "Explicit enabled/reserveTokens/keepRecentTokens required");
  const config = parseConfig(value.nunc);
  if (config.policyFile !== undefined) requireValue(text(config.policyFile) && isAbsolute(config.policyFile), "CONFIG", "Runner policyFile must be absolute and repository-local");
}
export function parseInput(value: unknown, execution = false): RunInput {
  keys(value, ["version", "mode", "target", "models", "limits", "scenarios", "receipt", "observations", "effective", "overrides", "resolvedModels", "comparison", "assets", "batch", "authority"], "input");
  requireValue(value.version === 1, "INPUT", "Expected input version 1");
  requireValue(value.mode === "controlled" || value.mode === "native", "INPUT", "Invalid internal execution mode");
  if (execution) {
    if (value.comparison === undefined) {
      requireValue(value.mode === "native", "EXECUTION", "Controlled observations cannot dispatch native service calls");
    } else if (value.mode === "controlled") {
      for (const model of (value.models as any[] ?? [])) {
        let url: URL | undefined;
        try { url = new URL(model.baseUrl); } catch { /* handled */ }
        const isLoopback = url && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1");
        requireValue(isLoopback, "AUTHORIZATION", "Controlled execution requires an explicit loopback or synthetic endpoint; real service endpoints are forbidden in controlled mode");
      }
    }
  }
  keys(value.target, ["repository", "stateRoot", "cleanup"], "target");
  requireValue(text(value.target.repository) && isAbsolute(value.target.repository) && text(value.target.stateRoot) && isAbsolute(value.target.stateRoot), "TARGET", "Explicit absolute repository and new stateRoot required");
  requireValue(value.target.cleanup === "retain" || value.target.cleanup === "remove", "TARGET", "Explicit cleanup disposition required");
  keys(value.limits, ["maxCalls", "maxTotalTokens", "maxCostUsd", "maxDurationMs", "maxOutputTokens", "firstDispatchAt", "deadline", "priorLedgers", "sharedLedger"], "limits");
  value.limits.maxCalls = optionalPositive(value.limits.maxCalls, "maxCalls");
  value.limits.maxTotalTokens = optionalPositive(value.limits.maxTotalTokens, "maxTotalTokens");
  for (const key of ["maxDurationMs", "maxOutputTokens"]) requireValue(positive(value.limits[key]), "LIMIT", `Positive bounded ${key} required`);
  requireValue(Number(value.limits.maxDurationMs) <= 86400000 && (value.limits.maxCostUsd === null || typeof value.limits.maxCostUsd === "number" && Number.isFinite(value.limits.maxCostUsd) && value.limits.maxCostUsd > 0), "LIMIT", "Invalid time/cost ceiling");
  const lim = value.limits as any;
  if (lim.firstDispatchAt !== undefined) {
    requireValue((typeof lim.firstDispatchAt === "number" && Number.isFinite(lim.firstDispatchAt) && lim.firstDispatchAt > 0) || (typeof lim.firstDispatchAt === "string" && !isNaN(Date.parse(lim.firstDispatchAt))), "LIMIT", "limits.firstDispatchAt must be a positive timestamp or valid ISO date");
  }
  if (lim.deadline !== undefined) {
    requireValue((typeof lim.deadline === "number" && Number.isFinite(lim.deadline) && lim.deadline > 0) || (typeof lim.deadline === "string" && !isNaN(Date.parse(lim.deadline))), "LIMIT", "limits.deadline must be a positive timestamp or valid ISO date");
  }
  if (lim.priorLedgers !== undefined) {
    requireValue(Array.isArray(lim.priorLedgers) && lim.priorLedgers.every((p: any) => typeof p === "string" && p.trim().length > 0), "LIMIT", "limits.priorLedgers must be an array of non-empty paths");
  }
  if (lim.sharedLedger !== undefined) {
    requireValue(typeof lim.sharedLedger === "string" && lim.sharedLedger.trim().length > 0, "LIMIT", "limits.sharedLedger must be a non-empty string path");
  }
  for (const bKey of ["batch", "authority"] as const) {
    if ((value as any)[bKey] !== undefined) {
      requireValue(object((value as any)[bKey]), "BATCH", `${bKey} must be an object`);
      keys((value as any)[bKey], ["firstDispatchAt", "deadline", "priorLedgers", "sharedLedger"], bKey);
      const b = (value as any)[bKey];
      if (b.firstDispatchAt !== undefined) {
        requireValue((typeof b.firstDispatchAt === "number" && Number.isFinite(b.firstDispatchAt) && b.firstDispatchAt > 0) || (typeof b.firstDispatchAt === "string" && !isNaN(Date.parse(b.firstDispatchAt))), "BATCH", `${bKey}.firstDispatchAt must be a positive timestamp or valid ISO date`);
      }
      if (b.deadline !== undefined) {
        requireValue((typeof b.deadline === "number" && Number.isFinite(b.deadline) && b.deadline > 0) || (typeof b.deadline === "string" && !isNaN(Date.parse(b.deadline))), "BATCH", `${bKey}.deadline must be a positive timestamp or valid ISO date`);
      }
      if (b.priorLedgers !== undefined) {
        requireValue(Array.isArray(b.priorLedgers) && b.priorLedgers.every((p: any) => typeof p === "string" && p.trim().length > 0), "BATCH", `${bKey}.priorLedgers must be an array of non-empty paths`);
      }
      if (b.sharedLedger !== undefined) {
        requireValue(typeof b.sharedLedger === "string" && b.sharedLedger.trim().length > 0, "BATCH", `${bKey}.sharedLedger must be a non-empty string path`);
      }
    }
  }
  requireValue(Array.isArray(value.models) && value.models.length >= 1 && value.models.length <= 2, "MODEL", "Authorize one or two exact models");
  const modelKeys = new Set<string>();
  const isGuidance = Array.isArray(value.scenarios) && value.scenarios.some((s: any) => typeof s?.id === "string" && s.id.startsWith("g"));
  const isTaskRetention = taskRetentionRun({ scenarios: value.scenarios, overrides: value.overrides });
  for (const model of value.models) {
    keys(model, ["provider", "id", "contextWindow", "maxTokens", "baseUrl"], "model");
    requireValue(text(model.provider) && text(model.id) && positive(model.contextWindow) && positive(model.maxTokens) && text(model.baseUrl), "MODEL", "Authorize provider/id with native capacity and endpoint");
    if (isTaskRetention) {
      const id = String(model.id).toLowerCase();
      const provider = String(model.provider).toLowerCase();
      const isForbidden = id.includes("astra") || provider.includes("astra");
      const isExactLuna = id === "gpt-5.6-luna" || id === "openai/gpt-5.6-luna";
      requireValue(!isForbidden && isExactLuna, "MODEL", "Complete-task retention scenarios authorize exact model gpt-5.6-luna or openai/gpt-5.6-luna only; Gemini, Astra and model aliases are forbidden");
    } else if (isGuidance) {
      const id = String(model.id).toLowerCase();
      const provider = String(model.provider).toLowerCase();
      const isForbidden = id.includes("astra") || provider === "openai-codex" || id.includes("codex") || provider.includes("astra");
      const isGemini = (id.includes("gemini") || id.includes("google/gemini")) && !isForbidden;
      requireValue(!isForbidden && isGemini, "MODEL", "Legacy guidance scenarios authorize OpenRouter google/gemini-3.8-flash only; Astra and non-Gemini models are forbidden");
    }
    const isStableMemory = Array.isArray(value.scenarios) && value.scenarios.some((s: any) => typeof s?.id === "string" && s.id.startsWith("m"));
    if (isStableMemory) {
      const id = String(model.id).toLowerCase();
      const provider = String(model.provider).toLowerCase();
      requireValue(!id.includes("astra") && !provider.includes("astra"), "MODEL", "Stable-memory observations forbid Astra");
    }
    const key = `${model.provider}/${model.id}`; requireValue(!modelKeys.has(key), "MODEL", "Duplicate model"); modelKeys.add(key);
  }
  if (isTaskRetention) {
    requireValue(object(value.effective) && value.effective.thinking === "low", "CONFIG", 'Complete-task retention scenarios require exact thinking level "low"');
    for (const override of (Array.isArray(value.overrides) ? value.overrides : [])) {
      if (object(override) && override.maintenanceThinking !== undefined) requireValue(override.maintenanceThinking === "low", "CONFIG", 'Complete-task maintenance requires exact thinking level "low"');
    }
  }
  requireValue(Array.isArray(value.scenarios) && value.scenarios.length > 0, "SCENARIO", "Nonempty scenario selection required");
  const ids = new Set<string>();
  for (const selection of value.scenarios) {
    keys(selection, ["id", "variant", "config", "assets"], "scenario");
    requireValue(["c1", "c2", "c3", "c4", "c5", "e1", "e2", "e3", "e4", "g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8", "m1", "m2", "m3", "m4"].includes(String(selection.id)), "SCENARIO", "Unknown scenario");
    if (selection.id === "c4") {
      requireValue(["full", "capacity"].includes(String(selection.variant)), "SCENARIO", "c4 requires full/capacity");
    } else if (selection.id === "c1") {
      requireValue(selection.variant === undefined || selection.variant === "late-d", "SCENARIO", "c1 may select late-d; others have no variant");
    } else if (selection.id === "e3") {
      requireValue(selection.variant === undefined || selection.variant === "archive-closeout", "SCENARIO", "e3 may select archive-closeout");
    } else if (selection.id === "e4") {
      requireValue(["fits-required", "required-too-large"].includes(String(selection.variant)), "SCENARIO", "e4 requires fits-required or required-too-large");
    } else if (selection.id === "g3") {
      requireValue(selection.variant === undefined || selection.variant === "scoped-tasks", "SCENARIO", "g3 may select scoped-tasks; others have no variant");
    } else if (selection.id === "g4") {
      requireValue(selection.variant === undefined || ["task-file", "active-edit", "source-loss", "source-unavailable", "commit-conflict", "commit-unconfirmed"].includes(String(selection.variant)), "SCENARIO", "g4 variant must be one of: task-file, active-edit, source-loss, source-unavailable, commit-conflict, commit-unconfirmed");
    } else if (selection.id === "g7") {
      requireValue(selection.variant === undefined || ["conflict", "unconfirmed"].includes(String(selection.variant)), "SCENARIO", "g7 may select conflict or unconfirmed");
    } else if (selection.id === "g8") {
      requireValue(["fits-required", "required-too-large"].includes(String(selection.variant)), "SCENARIO", "g8 requires fits-required or required-too-large");
    } else if (selection.id === "m1") {
      requireValue(["moving", "fixed"].includes(String(selection.variant)), "SCENARIO", "m1 requires moving/fixed");
    } else if (selection.id === "m4") {
      requireValue(["keep-0.67", "keep-0.5"].includes(String(selection.variant)), "SCENARIO", "m4 requires keep-0.67/keep-0.5");
    } else {
      requireValue(selection.variant === undefined, "SCENARIO", `${selection.id} has no variant`);
    }
    const key = `${selection.id}/${selection.variant ?? ""}`; requireValue(!ids.has(key), "SCENARIO", "Duplicate scenario"); ids.add(key);
    validateConfig(selection.config);
    if (selection.assets !== undefined) {
      keys(selection.assets, ["inputs", "observer"], "scenario.assets");
      if (selection.assets.inputs !== undefined) requireValue(text(selection.assets.inputs), "ASSETS", "scenario.assets.inputs must be a non-empty string path");
      if (selection.assets.observer !== undefined) requireValue(text(selection.assets.observer), "ASSETS", "scenario.assets.observer must be a non-empty string path");
    }
    if (selection.id === "c4" && selection.variant === "full") requireValue(selection.config.nunc.extraction?.toolResults === "full", "CONFIG", "c4/full requires full extraction");
    if (selection.id === "c5") requireValue(value.models.length === 2 && Number(value.models[1].contextWindow) < Number(value.models[0].contextWindow), "MODEL", "c5 requires a distinct authorized strictly smaller model");
    if (selection.id === "m4") {
      requireValue(selection.config.retentionCalibration === undefined, "CONFIG", "m4 compares explicit keepRecentFraction values; retentionCalibration is forbidden");
      requireValue(selection.config.nunc.rolling?.keepRecentFraction === (selection.variant === "keep-0.67" ? 0.67 : 0.5), "CONFIG", "m4 requires an explicit keepRecentFraction matching the selected variant");
    }
  }
  if (value.assets !== undefined) {
    keys(value.assets, ["inputs", "observer"], "assets");
    if (value.assets.inputs !== undefined) requireValue(text(value.assets.inputs), "ASSETS", "assets.inputs must be a non-empty string path");
    if (value.assets.observer !== undefined) requireValue(text(value.assets.observer), "ASSETS", "assets.observer must be a non-empty string path");
  }
  if (value.comparison !== undefined) {
    keys(value.comparison, ["modes", "targets"], "comparison");
    requireValue(Array.isArray(value.comparison.modes) && value.comparison.modes.length > 0 && new Set(value.comparison.modes).size === value.comparison.modes.length && value.comparison.modes.every(m => ["defaults", "matched"].includes(String(m))), "COMPARISON", "comparison.modes must be a nonempty unique array of 'defaults' and/or 'matched'");
    keys(value.comparison.targets, ["native", "current", "candidate"], "comparison.targets");
    for (const group of ["native", "current", "candidate"] as const) {
      let t = value.comparison.targets[group];
      if (typeof t === "string") t = { repository: t };
      keys(t, group === "current" ? ["repository", "ref"] : ["repository"], `comparison.targets.${group}`);
      requireValue(text(t.repository) && isAbsolute(t.repository), "TARGET", `comparison.targets.${group}.repository must be an absolute canonical path`);
      if (t.ref !== undefined) requireValue(text(t.ref) && !t.ref.startsWith("-"), "TARGET", "Current target ref must name a Git commit/ref in the runner repository");
      if (group === "current" && isTaskRetention) requireValue(text(t.ref), "TARGET", "Complete-task comparison requires an explicit current target ref");
      value.comparison.targets[group] = { repository: resolve(t.repository), ...(t.ref === undefined ? {} : { ref: t.ref }) };
    }
  }
  if (value.observations !== undefined) requireValue(Array.isArray(value.observations) && value.observations.length > 0 && new Set(value.observations).size === value.observations.length && value.observations.every(m => ["stock_rpc", "stock_tui", "continuation"].includes(String(m))) && (!value.observations.includes("continuation") || value.observations.length === 1), "OBSERVATION", "Select stock_rpc/stock_tui together, or continuation alone; controlled and live budgets use separate runs");
  // The supervisor generates execution binding internally; callers need no receipt ceremony.
  // All fields and nested boundary values were validated above; no external values are used before this point.
  return value as unknown as RunInput;
}
export async function validateTarget(input: RunInput, repository: string, existingOwnedWorker = false): Promise<void> {
  requireValue(await realpath(input.target.repository) === await realpath(repository), "TARGET", "Repository differs from this runner checkout");
  const root = input.target.stateRoot, parent = dirname(root);
  requireValue(resolve(root) === root && /^nunc-live-[a-zA-Z0-9_-]+$/.test(root.slice(parent.length + 1)), "TARGET", "stateRoot must be a canonical new nunc-live-<name> directory");
  requireValue(!root.split(sep).some(p => [".pi", ".agents", ".git"].includes(p) || p.startsWith(".env")), "TARGET", "Daily/global/protected state is forbidden");
  const canonicalParent = await realpath(parent);
  requireValue(canonicalParent === parent, "TARGET", "stateRoot parent must use its real path, without symlink aliases");
  const temp = await realpath(tmpdir());
  requireValue(parent === temp || within(parent, temp) || parent === join(repository, ".scratch") || within(parent, join(repository, ".scratch")), "TARGET", "New state must be under the OS temp directory or this checkout's .scratch");
  if (existingOwnedWorker) {
    const stat = await lstat(root); requireValue(stat.isDirectory() && !stat.isSymbolicLink(), "TARGET", "Owned worker root must be a real directory");
  } else {
    try { await lstat(root); throw new RunnerError("TARGET_EXISTS", "stateRoot already exists; execution never resumes an earlier run"); } catch (error) { if (!(object(error) && error.code === "ENOENT")) throw error; }
  }
}
export function selectedModels(input: RunInput): Model<Api>[] {
  requireValue(Array.isArray(input.resolvedModels) && input.resolvedModels.length === input.models.length, "MODEL", "Native-resolved model metadata is required; no catalog fallback");
  return input.models.map(target => {
    const model = input.resolvedModels!.find(m => m.id === target.id && m.provider === target.provider);
    requireValue(model, "MODEL", "Authorized model is absent from native-resolved metadata");
    requireValue(model.contextWindow === target.contextWindow && model.maxTokens === target.maxTokens && model.baseUrl === target.baseUrl, "MODEL", "Authorized model capacity/endpoint differs from native resolution");
    requireValue(!model.headers && !model.samplingParams, "MODEL", "Model header/sampling overrides require a supported native accounting contract");
    requireValue(input.limits.maxOutputTokens >= model.maxTokens, "LIMIT", "Authorize the stock main model's total default output ceiling, including thinking");
    if (model.api === "openai-codex-responses") requireValue(input.limits.maxCostUsd === null, "BILLING", "Codex OAuth subscription billing requires unknown USD billing");
    if (input.limits.maxCostUsd !== null) requireValue([model.cost, ...(model.cost.tiers ?? [])].every(rate => [rate.input, rate.output, rate.cacheRead, rate.cacheWrite].every(n => Number.isFinite(n) && n >= 0)) && Math.max(model.cost.input, model.cost.output) > 0, "MODEL", "Known catalog pricing required for a USD reservation");
    for (const s of input.scenarios) {
      const config = engineConfig(s.config.nunc, model, s.config.compaction);
      // The model ceiling is authorized above; extraction.outputTokens only plans
      // headroom on uncapped APIs and must not reduce that authorization.
      const h = model.contextWindow - s.config.compaction.reserveTokens;
      requireValue(h > 0 && s.config.compaction.keepRecentTokens < h, "CONFIG", "reserve/keepRecent cannot establish a usable hook threshold");
      requireValue(config.extraction.outputTokens <= input.limits.maxOutputTokens, "CONFIG", "Extraction output exceeds authorization");
    }
    return model;
  });
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export async function preflight(input: RunInput, repository: string, existingOwnedWorker = false): Promise<Receipt> {
  await validateTarget(input, repository, existingOwnedWorker); selectedModels(input);
  const node = (await readFile(join(repository, ".node-version"), "utf8")).trim();
  requireValue(process.versions.node === node && !process.env.NODE_OPTIONS, "ENVIRONMENT", `Use Node ${node} with NODE_OPTIONS unset`);
  const lock = JSON.parse(await readFile(join(repository, "package-lock.json"), "utf8"));
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "typescript"]) {
    const pkg = JSON.parse(await readFile(join(repository, "node_modules", name, "package.json"), "utf8"));
    requireValue(pkg.version === lock.packages[`node_modules/${name}`]?.version, "DEPENDENCY", `Local ${name} differs from lock; no installation is performed`);
    if (name.startsWith("@earendil-works/pi-")) requireValue(pkg.version === "0.86.1", "DEPENDENCY", "This runner supports Pi 0.86.1 only");
  }
  const { loadScenario } = await import("./scenarios.js");
  for (const selection of input.scenarios) {
    const { observer } = await loadScenario(repository, selection, input.assets);
    if (selection.config.retentionCalibration) requireValue(observer.controls.filter(c => c.action === "rollover").every(c => c.placement !== undefined), "CONFIG", "Retention calibration requires an explicit observer placement for every rollover");
  }
  if (!existingOwnedWorker) {
    const { assertBuildParity } = await import("./build.js");
    await assertBuildParity(repository);
  }
  if (input.comparison !== undefined) {
    let candRepo: string;
    try { candRepo = await realpath(input.comparison.targets.candidate.repository); }
    catch { throw new RunnerError("TARGET", "Candidate target repository does not exist"); }
    requireValue(candRepo === await realpath(input.target.repository), "TARGET", "Candidate target repository must match runner target repository");

    let curRepo: string;
    try { curRepo = await realpath(input.comparison.targets.current.repository); }
    catch { throw new RunnerError("TARGET", "Current baseline target repository does not exist"); }
    const curStat = await lstat(curRepo);
    requireValue(curStat.isDirectory(), "TARGET", "Current baseline target must be a real directory");
    const gitEnv = { ...process.env, DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? "/Library/Developer/CommandLineTools" };
    const curHead = execFileSync("/usr/bin/git", ["-C", curRepo, "rev-parse", "HEAD"], { encoding: "utf8", env: gitEnv }).trim();
    const requestedRef = input.comparison.targets.current.ref ?? "70dacad";
    let expectedCommit: string;
    try { expectedCommit = execFileSync("/usr/bin/git", ["-C", repository, "rev-parse", "--verify", `${requestedRef}^{commit}`], { encoding: "utf8", env: gitEnv, stdio: ["pipe", "pipe", "pipe"] }).trim(); }
    catch { throw new RunnerError("TARGET", `Current baseline ref ${requestedRef} cannot be resolved`); }
    requireValue(curHead === expectedCommit, "TARGET", `Current baseline HEAD ${curHead} differs from declared ref ${requestedRef} (${expectedCommit})`);
    const curDirty = execFileSync("/usr/bin/git", ["-C", curRepo, "status", "--porcelain", "--untracked-files=normal", "--", "src", "policies", "package.json", "package-lock.json", "tsconfig.json"], { encoding: "utf8", env: gitEnv }).trim();
    requireValue(curDirty === "", "CANDIDATE", "Current baseline target repository must have a committed clean working tree");
    const curIndex = join(curRepo, "dist/src/index.js");
    try { const stat = await lstat(curIndex); requireValue(stat.isFile(), "BUILD", "Current baseline target missing dist/src/index.js"); }
    catch { throw new RunnerError("BUILD", "Current baseline target must have compiled dist/src/index.js"); }
    const curPkg = JSON.parse(await readFile(join(curRepo, "package-lock.json"), "utf8"));
    const curPiVersion = curPkg.packages?.["node_modules/@earendil-works/pi-coding-agent"]?.version;
    requireValue(curPiVersion === (requestedRef === "70dacad" ? "0.85.1" : "0.86.1"), "DEPENDENCY", "Current target uses an unsupported locked Pi version");
    // Verify baseline build parity against its tracked source
    if (!existingOwnedWorker) {
      const { assertBuildParity } = await import("./build.js");
      await assertBuildParity(curRepo);
    }

    let natRepo: string;
    try { natRepo = await realpath(input.comparison.targets.native.repository); }
    catch { throw new RunnerError("TARGET", "Native target repository does not exist"); }
    const natStat = await lstat(natRepo);
    requireValue(natStat.isDirectory(), "TARGET", "Native target must be a real directory");
    const natPiPkg = join(natRepo, "node_modules/@earendil-works/pi-coding-agent/package.json");
    try { const stat = await lstat(natPiPkg); requireValue(stat.isFile(), "DEPENDENCY", "Native target missing Pi package.json"); }
    catch { throw new RunnerError("DEPENDENCY", "Native target must have installed @earendil-works/pi-coding-agent"); }
    const natPiManifest = JSON.parse(await readFile(natPiPkg, "utf8"));
    requireValue(natPiManifest.version === "0.86.1", "DEPENDENCY", `Native target requires Pi 0.86.1, found ${natPiManifest.version}`);
    const natCliBin = join(natRepo, "node_modules/@earendil-works/pi-coding-agent", natPiManifest.bin?.pi ?? "dist/bundle/cli.js");
    try { const stat = await lstat(natCliBin); requireValue(stat.isFile(), "DEPENDENCY", "Native target missing Pi CLI bin"); }
    catch { throw new RunnerError("DEPENDENCY", "Native target must have executable Pi CLI binary"); }
  }
  const gitEnv = { ...process.env, DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? "/Library/Developer/CommandLineTools" };
  const candidate = execFileSync("/usr/bin/git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8", env: gitEnv }).trim();
  if (input.mode === "native") {
    const dirty = execFileSync("/usr/bin/git", ["-C", repository, "status", "--porcelain", "--untracked-files=normal", "--", "src", "scripts", "tests", "policies", "package.json", "package-lock.json", "tsconfig.json"], { encoding: "utf8", env: gitEnv });
    requireValue(dirty === "", "CANDIDATE", "Live execution requires committed clean product/check inputs");
  }
  // Receipt has a named identity consumer: later execution of this exact target and compiled candidate.
  const digest = createHash("sha256");
  const { receipt: _receipt, ...bindingInput } = input;
  digest.update(canonical(bindingInput)); digest.update(candidate); digest.update(node);
  if (input.comparison !== undefined) {
    const curRepo = resolve(input.comparison.targets.current.repository);
    const curHead = execFileSync("/usr/bin/git", ["-C", curRepo, "rev-parse", "HEAD"], { encoding: "utf8", env: gitEnv }).trim();
    digest.update(curHead);
    digest.update(await readFile(join(curRepo, "dist/src/index.js")));
    const curPolicy = join(curRepo, "policies/default.md");
    if (existsSync(curPolicy)) digest.update(await readFile(curPolicy));
    digest.update(await readFile(join(curRepo, "package-lock.json")));
    const natRepo = resolve(input.comparison.targets.native.repository);
    const natPiManifest = JSON.parse(await readFile(join(natRepo, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
    digest.update(natPiManifest.version);
  }
  async function bind(path: string): Promise<void> {
    const stat = await lstat(path); requireValue(!stat.isSymbolicLink(), "CANDIDATE", "Bound input must not be a symlink");
    if (stat.isDirectory()) { for (const name of (await readdir(path)).sort()) await bind(join(path, name)); }
    else { digest.update(relative(repository, path)); digest.update(await readFile(path)); }
  }
  const explicitAssets = [
    input.assets?.inputs,
    input.assets?.observer,
    ...input.scenarios.flatMap(s => [s.assets?.inputs, s.assets?.observer])
  ].filter((p): p is string => typeof p === "string" && p.trim().length > 0);
  for (const assetFile of explicitAssets) {
    const p = isAbsolute(assetFile) ? assetFile : join(repository, assetFile);
    if (existsSync(p)) {
      const stat = await lstat(p);
      if (stat.isFile()) digest.update(await readFile(p));
    }
  }
  for (const name of ["src", "scripts", "dist/src", "tests/scenarios", "policies", "package.json", "package-lock.json", "tsconfig.json"]) await bind(join(repository, name));
  await lstat(join(repository, "dist/src/index.js"));
  for (const s of input.scenarios) if (s.config.nunc.policyFile) {
    requireValue(within(s.config.nunc.policyFile, join(repository, "policies")), "CONFIG", "Runner user policies must be tracked under this checkout's policies/");
    execFileSync("/usr/bin/git", ["-C", repository, "ls-files", "--error-unmatch", s.config.nunc.policyFile], { stdio: "pipe", env: gitEnv });
    await bind(s.config.nunc.policyFile);
  }
  const larvaOverrides = input.overrides?.filter(o => o.requirement === "stable-memory-larva") ?? [];
  requireValue(larvaOverrides.length <= 1, "EXTENSION", "Select one explicit Larva composition override");
  const larva = larvaOverrides[0];
  if (larva) {
    if (larva.compactionOwner !== undefined) requireValue(larva.compactionOwner === "nunc" && input.scenarios.every(s => s.id.startsWith("m")) && input.comparison === undefined, "EXTENSION", "Nunc compaction ownership applies only to explicit stable-memory Nunc/Larva observations");
    requireValue(typeof larva.extension === "string" && isAbsolute(larva.extension), "EXTENSION", "Larva composition requires an explicit absolute extension path");
    const info = await lstat(larva.extension);
    requireValue(info.isFile(), "EXTENSION", "Larva extension must be a readable source file");
    digest.update(larva.extension); digest.update(await readFile(larva.extension));
  }
  const receipt: Receipt = { version: 1, binding: digest.digest("hex"), candidate, node, pi: "0.86.1", callsMade: 0 };
  if (input.receipt !== undefined) requireValue(canonical(input.receipt) === canonical(receipt), "RECEIPT", "Preflight receipt does not match current target/config/scenarios/candidate");
  return receipt;
}
export function parseComparisonInput(value: unknown, execution = false): RunInput {
  requireValue(object(value) && (value as { comparison?: unknown }).comparison !== undefined, "COMPARISON", "comparison configuration is required for compare-extraction");
  return parseInput(value, execution);
}
export function publicInput(input: RunInput): RunInput { return structuredClone(input); }
