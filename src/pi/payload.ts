import type { Api, Model } from "@earendil-works/pi-ai";
import { omitsSerializedOutputCap, textTokens } from "../engine/accounting.js";
import { EngineError, record } from "../engine/validation.js";

export type PayloadMode = "noop" | "identity" | "in-place" | "replacement";
export type PayloadCategory = "output" | "input" | "tools" | "model" | "stream" | "media" | "thinking" | "metadata";
export interface PayloadObservation { mode: PayloadMode; categories: PayloadCategory[] }
export interface PayloadDelta {
  mode: PayloadMode;
  categories: PayloadCategory[];
  grewTokens: number;
  outputBefore: number | undefined;
  outputAfter: number | undefined;
}

/** JSON-enumerable view. Drops prototypes, undefined, functions; matches HTTP JSON bytes. */
export function jsonView(value: unknown): unknown {
  try { return JSON.parse(JSON.stringify(value)); }
  catch (cause) { throw new EngineError("CONFIG", "Nunc: native payload is not JSON-serializable; request was not sent", { cause }); }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function canonicalJson(value: unknown): string { return canonical(jsonView(value)); }

export function payloadOutputCeiling(body: unknown): number | undefined {
  if (!record(body)) return undefined;
  const direct = body.max_tokens ?? body.max_output_tokens ?? body.max_completion_tokens;
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  if (record(body.generationConfig) && typeof body.generationConfig.maxOutputTokens === "number" && Number.isFinite(body.generationConfig.maxOutputTokens)) {
    return body.generationConfig.maxOutputTokens;
  }
}

const OUTPUT_KEYS = new Set(["max_tokens", "max_output_tokens", "max_completion_tokens", "generationConfig"]);
const INPUT_KEYS = new Set(["messages", "input", "contents", "system", "instructions", "prompt", "system_instruction", "systemInstruction"]);
const TOOL_KEYS = new Set(["tools", "functions", "tool_choice", "toolChoice"]);
const STREAM_KEYS = new Set(["stream", "background"]);
const MODEL_KEYS = new Set(["model"]);
const THINKING_KEYS = new Set(["thinking", "reasoning", "thinkingConfig", "reasoning_effort", "reasoningEffort", "reasoning_details"]);

function hasImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasImage);
  if (!record(value)) return false;
  if (value.type === "image" || value.type === "input_image" || value.type === "image_url") return true;
  return Object.values(value).some(hasImage);
}

function categorize(key: string): PayloadCategory {
  if (OUTPUT_KEYS.has(key)) return "output";
  if (INPUT_KEYS.has(key)) return "input";
  if (TOOL_KEYS.has(key)) return "tools";
  if (STREAM_KEYS.has(key)) return "stream";
  if (MODEL_KEYS.has(key)) return "model";
  if (THINKING_KEYS.has(key)) return "thinking";
  return "metadata";
}

export function payloadMode(beforeView: unknown, afterView: unknown, replacement: unknown, original: unknown): PayloadMode {
  const equal = canonical(beforeView) === canonical(afterView);
  const sameRef = replacement === undefined || replacement === original;
  if (equal) return replacement === undefined ? "noop" : "identity";
  return sameRef ? "in-place" : "replacement";
}

export function classifyPayloadChange(beforeView: unknown, afterView: unknown, mode: PayloadMode): PayloadDelta {
  const categories = new Set<PayloadCategory>();
  const beforeRec = record(beforeView) ? beforeView : {};
  const afterRec = record(afterView) ? afterView : {};
  for (const key of new Set([...Object.keys(beforeRec), ...Object.keys(afterRec)])) {
    if (canonical(beforeRec[key]) === canonical(afterRec[key])) continue;
    categories.add(categorize(key));
  }
  if (!record(beforeView) || !record(afterView)) {
    if (canonical(beforeView) !== canonical(afterView)) categories.add("metadata");
  }
  if (hasImage(afterView) && !hasImage(beforeView)) categories.add("media");
  return {
    mode,
    categories: [...categories],
    grewTokens: Math.max(0, textTokens(canonical(afterView)) - textTokens(canonical(beforeView))),
    outputBefore: payloadOutputCeiling(beforeView),
    outputAfter: payloadOutputCeiling(afterView),
  };
}

export function authorizePayload(args: {
  model: Model<Api>;
  delta: PayloadDelta;
  after: unknown;
  inputTokens: number;
  inputLimit: number;
  authorizedOutput: number;
}): void {
  const body = jsonView(args.after);
  if (!record(body)) throw new EngineError("CONFIG", "Nunc: native payload is not a JSON object; request was not sent");
  if (body.stream === false) throw new EngineError("CONFIG", "Nunc: non-streaming payload is unsupported; request was not sent");
  if (body.background === true) throw new EngineError("CONFIG", "Nunc: background payload is unsupported; request was not sent");
  if (Object.hasOwn(body, "model") && body.model !== args.model.id) throw new EngineError("CONFIG", "Nunc: payload model differs from the selected model; request was not sent");
  const ceiling = payloadOutputCeiling(body);
  if (ceiling === undefined) {
    if (args.delta.outputBefore !== undefined && args.authorizedOutput !== args.model.maxTokens && !omitsSerializedOutputCap(args.model)) {
      throw new EngineError("CONFIG", "Nunc: payload omitted its output cap; request was not sent");
    }
  } else if (!(Number.isSafeInteger(ceiling) && ceiling > 0 && ceiling <= args.authorizedOutput)) {
    throw new EngineError("CONFIG", "Nunc: payload output cap exceeds authorization; request was not sent");
  }
  if (args.delta.grewTokens > 0 && args.inputTokens + args.delta.grewTokens > args.inputLimit) {
    throw new EngineError("CAPACITY", `Payload input growth ${args.delta.grewTokens} exceeds remaining safe input; request was not sent`);
  }
  if (args.delta.categories.includes("media") && !args.model.input.includes("image")) {
    throw new EngineError("UNSUPPORTED_INPUT", "Current model does not support images");
  }
}
