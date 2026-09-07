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
  inputGrewTokens: number;
  imagesAdded: number;
  unsupportedAdded: string[];
  outputBefore: number | undefined;
  outputAfter: number | undefined;
}
export type OutputCapState =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "conflict" }
  | { kind: "value"; value: number };

const OUTPUT_KEYS = new Set(["max_tokens", "max_output_tokens", "max_completion_tokens", "generationConfig"]);
const INPUT_KEYS = new Set(["messages", "input", "contents", "system", "instructions", "prompt", "system_instruction", "systemInstruction"]);
const TOOL_KEYS = new Set(["tools", "functions", "tool_choice", "toolChoice"]);
const STREAM_KEYS = new Set(["stream", "background"]);
const MODEL_KEYS = new Set(["model"]);
const THINKING_KEYS = new Set(["thinking", "reasoning", "thinkingConfig", "reasoning_effort", "reasoningEffort", "reasoning_details"]);
const IMAGE_TYPES = new Set(["image", "input_image", "image_url"]);
const UNSUPPORTED_TYPES = new Set(["audio", "input_audio", "pdf", "document", "video", "file", "input_file"]);
const UNVALIDATED = new Set<PayloadCategory>(["input", "tools", "media", "thinking"]);
const CAP_KEYS = ["max_tokens", "max_output_tokens", "max_completion_tokens"] as const;

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

function subtreeSize(view: unknown, keys: Set<string>): number {
  if (!record(view)) return 0;
  let size = 0;
  for (const key of keys) {
    if (!Object.hasOwn(view, key)) continue;
    size += textTokens(canonical(view[key]));
  }
  return size;
}

export function outputCapPaths(body: unknown): string[] {
  if (!record(body)) return [];
  const paths: string[] = [];
  for (const key of CAP_KEYS) if (Object.hasOwn(body, key)) paths.push(key);
  if (record(body.generationConfig) && Object.hasOwn(body.generationConfig, "maxOutputTokens")) paths.push("generationConfig.maxOutputTokens");
  return paths.sort();
}

export function outputCapState(body: unknown): OutputCapState {
  if (!record(body)) return { kind: "missing" };
  const found: number[] = [];
  let invalid = false;
  const take = (value: unknown): void => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) invalid = true;
    else found.push(value);
  };
  for (const key of CAP_KEYS) if (Object.hasOwn(body, key)) take(body[key]);
  if (record(body.generationConfig) && Object.hasOwn(body.generationConfig, "maxOutputTokens")) take(body.generationConfig.maxOutputTokens);
  if (invalid) return { kind: "invalid" };
  if (found.length === 0) return { kind: "missing" };
  if (found.some(n => n !== found[0])) return { kind: "conflict" };
  return { kind: "value", value: found[0]! };
}

export function payloadOutputCeiling(body: unknown): number | undefined {
  const state = outputCapState(body);
  return state.kind === "value" ? state.value : undefined;
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

interface BlockCensus { images: number; unsupported: string[] }

function census(value: unknown, acc: { images: number; unsupported: Set<string> } = { images: 0, unsupported: new Set() }): BlockCensus {
  if (Array.isArray(value)) { for (const child of value) census(child, acc); return { images: acc.images, unsupported: [...acc.unsupported] }; }
  if (!record(value)) return { images: acc.images, unsupported: [...acc.unsupported] };
  if (typeof value.type === "string") {
    if (IMAGE_TYPES.has(value.type)) acc.images++;
    if (UNSUPPORTED_TYPES.has(value.type)) acc.unsupported.add(value.type);
  }
  for (const child of Object.values(value)) census(child, acc);
  return { images: acc.images, unsupported: [...acc.unsupported] };
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
  const beforeBlocks = census(beforeView), afterBlocks = census(afterView);
  if (beforeBlocks.images !== afterBlocks.images || afterBlocks.unsupported.some(t => !beforeBlocks.unsupported.includes(t))) categories.add("media");
  const outputState = outputCapState(afterView);
  return {
    mode,
    categories: [...categories],
    grewTokens: Math.max(0, textTokens(canonical(afterView)) - textTokens(canonical(beforeView))),
    inputGrewTokens: Math.max(0, subtreeSize(afterView, INPUT_KEYS) - subtreeSize(beforeView, INPUT_KEYS)),
    imagesAdded: Math.max(0, afterBlocks.images - beforeBlocks.images),
    unsupportedAdded: afterBlocks.unsupported.filter(t => !beforeBlocks.unsupported.includes(t)),
    outputBefore: payloadOutputCeiling(beforeView),
    outputAfter: outputState.kind === "value" ? outputState.value : undefined,
  };
}

function outputFloor(model: Model<Api>): number {
  return ["openai-responses", "azure-openai-responses"].includes(model.api) ? 16 : 1;
}

export function authorizePayload(args: {
  model: Model<Api>;
  delta: PayloadDelta;
  before: unknown;
  after: unknown;
  inputTokens: number;
  inputLimit: number;
  authorizedOutput: number;
}): void {
  const prior = jsonView(args.before);
  const body = jsonView(args.after);
  if (!record(body)) throw new EngineError("CONFIG", "Nunc: native payload is not a JSON object; request was not sent");
  const priorRec = record(prior) ? prior : {};
  if (Object.hasOwn(priorRec, "stream")) {
    if (!Object.hasOwn(body, "stream") || body.stream !== true) throw new EngineError("CONFIG", "Nunc: payload removed or changed its native stream field; request was not sent");
  } else if (body.stream === false) throw new EngineError("CONFIG", "Nunc: non-streaming payload is unsupported; request was not sent");
  if (body.background === true) throw new EngineError("CONFIG", "Nunc: background payload is unsupported; request was not sent");
  if (Object.hasOwn(priorRec, "model")) {
    if (!Object.hasOwn(body, "model") || body.model !== args.model.id) throw new EngineError("CONFIG", "Nunc: payload removed or changed its native model field; request was not sent");
  } else if (Object.hasOwn(body, "model") && body.model !== args.model.id) throw new EngineError("CONFIG", "Nunc: payload model differs from the selected model; request was not sent");
  const beforePaths = outputCapPaths(prior), afterPaths = outputCapPaths(body);
  if (beforePaths.length > 0 && beforePaths.join("\0") !== afterPaths.join("\0")) throw new EngineError("CONFIG", "Nunc: payload output cap field was replaced or removed; request was not sent");
  const caps = outputCapState(body);
  if (caps.kind === "invalid") throw new EngineError("CONFIG", "Nunc: payload output cap is not a positive integer; request was not sent");
  if (caps.kind === "conflict") throw new EngineError("CONFIG", "Nunc: payload output cap fields disagree; request was not sent");
  const uncapped = omitsSerializedOutputCap(args.model);
  const floor = outputFloor(args.model);
  if (uncapped) {
    if (caps.kind === "value") throw new EngineError("CONFIG", "Nunc: payload invented an output cap on an uncapped API; request was not sent");
  } else if (args.delta.outputBefore !== undefined) {
    if (caps.kind !== "value") throw new EngineError("CONFIG", "Nunc: payload omitted its output cap; request was not sent");
    if (caps.value > args.delta.outputBefore) throw new EngineError("CONFIG", "Nunc: payload output cap exceeds the native serialized ceiling; request was not sent");
    if (caps.value < floor) throw new EngineError("CONFIG", "Nunc: payload output cap is below the serializer floor; request was not sent");
    if (caps.value > args.authorizedOutput) throw new EngineError("CONFIG", "Nunc: payload output cap exceeds authorization; request was not sent");
  } else if (caps.kind === "value") {
    if (caps.value < floor || caps.value > args.authorizedOutput) throw new EngineError("CONFIG", "Nunc: payload output cap exceeds authorization; request was not sent");
  }
  if (args.delta.unsupportedAdded.length) throw new EngineError("UNSUPPORTED_INPUT", "Nunc: payload contains unsupported media; request was not sent");
  if (args.delta.imagesAdded > 0 && !args.model.input.includes("image")) throw new EngineError("UNSUPPORTED_INPUT", "Current model does not support images");
  const structural = args.delta.categories.filter(c => UNVALIDATED.has(c));
  if (structural.length) throw new EngineError("CONFIG", `Nunc: unvalidated payload ${structural.join(",")} rewrite; request was not sent`);
  if (args.delta.grewTokens > 0 && args.inputTokens + args.delta.grewTokens > args.inputLimit) {
    throw new EngineError("CAPACITY", `Payload input growth ${args.delta.grewTokens} exceeds remaining safe input; request was not sent`);
  }
}
