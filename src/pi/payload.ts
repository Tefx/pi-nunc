import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { estimateContextTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { omitsSerializedOutputCap, textTokens } from "../engine/accounting.js";
import { EngineError, record } from "../engine/validation.js";

export type PayloadMode = "noop" | "identity" | "in-place" | "replacement";
export type PayloadCategory = "output" | "input" | "tools" | "model" | "stream" | "media" | "thinking" | "control" | "metadata";
export interface PayloadObservation { mode: PayloadMode; categories: PayloadCategory[]; transform?: "last-user-text-append" }
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
const TOOL_KEYS = new Set(["tools", "functions", "tool_choice", "toolChoice", "toolConfig"]);
const STREAM_KEYS = new Set(["stream", "background"]);
const MODEL_KEYS = new Set(["model"]);
const THINKING_KEYS = new Set(["thinking", "reasoning", "thinkingConfig", "reasoning_effort", "reasoningEffort", "reasoning_details"]);
const CONTROL_KEYS = new Set(["n"]);
const IMAGE_TYPES = new Set(["image", "input_image", "image_url"]);
const UNSUPPORTED_TYPES = new Set(["audio", "input_audio", "pdf", "document", "video", "file", "input_file"]);
const UNVALIDATED = new Set<PayloadCategory>(["input", "tools", "media", "thinking", "control"]);
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

function takeOutputCap(body: Record<string, unknown>, take: (value: unknown) => void): void {
  for (const key of CAP_KEYS) if (Object.hasOwn(body, key)) take(body[key]);
  if (record(body.generationConfig) && Object.hasOwn(body.generationConfig, "maxOutputTokens")) take(body.generationConfig.maxOutputTokens);
  if (record(body.config) && Object.hasOwn(body.config, "maxOutputTokens")) take(body.config.maxOutputTokens);
}

export function outputCapPaths(body: unknown): string[] {
  if (!record(body)) return [];
  const paths: string[] = [];
  for (const key of CAP_KEYS) if (Object.hasOwn(body, key)) paths.push(key);
  if (record(body.generationConfig) && Object.hasOwn(body.generationConfig, "maxOutputTokens")) paths.push("generationConfig.maxOutputTokens");
  if (record(body.config) && Object.hasOwn(body.config, "maxOutputTokens")) paths.push("config.maxOutputTokens");
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
  takeOutputCap(body, take);
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
  if (CONTROL_KEYS.has(key)) return "control";
  return "metadata";
}

function classifyGoogleConfig(beforeVal: unknown, afterVal: unknown, categories: Set<PayloadCategory>): void {
  if (!record(beforeVal) && !record(afterVal)) {
    if (canonical(beforeVal) !== canonical(afterVal)) categories.add("metadata");
    return;
  }
  const beforeRec = record(beforeVal) ? beforeVal : {};
  const afterRec = record(afterVal) ? afterVal : {};
  let nested = false;
  for (const key of new Set([...Object.keys(beforeRec), ...Object.keys(afterRec)])) {
    if (canonical(beforeRec[key]) === canonical(afterRec[key])) continue;
    nested = true;
    categories.add(key === "maxOutputTokens" ? "output" : categorize(key));
  }
  if (!nested && canonical(beforeVal) !== canonical(afterVal)) categories.add("metadata");
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
    if (key === "config") classifyGoogleConfig(beforeRec[key], afterRec[key], categories);
    else categories.add(categorize(key));
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

const LAST_USER_TEXT_PART = { input: "input_text", messages: "text" } as const;
export type LastUserTextAppendReason = "empty-content" | "unsupported-payload-shape" | "missing-user-message" | "unsupported-user-content-shape";
export type LastUserTextAppendResult =
  | { changed: true; payload: unknown }
  | { changed: false; payload: unknown; reason: LastUserTextAppendReason };

function lastUserIndex(messages: unknown[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (record(message) && message.role === "user") return index;
  }
  return -1;
}

function textPart(type: "input_text" | "text", text: string): { type: "input_text" | "text"; text: string } {
  return { type, text };
}

function appendTextPart(message: Record<string, unknown>, content: string, textPartType: "input_text" | "text"): LastUserTextAppendReason | null {
  const currentContent = message.content;
  const ambientPart = textPart(textPartType, content);
  if (typeof currentContent === "string") {
    if (currentContent.trim().length === 0) return "unsupported-user-content-shape";
    message.content = [textPart(textPartType, currentContent), ambientPart];
    return null;
  }
  if (!Array.isArray(currentContent)) return "unsupported-user-content-shape";
  message.content = [...currentContent, ambientPart];
  return null;
}

/** Last-user text append: clone input[]/messages[], keep prefix, wrap a nonempty string, add one text part. Authorization accepts a nonempty pure-text suffix of one or more such parts. */
export function applyLastUserTextAppend(payload: unknown, content: string): LastUserTextAppendResult {
  if (content.trim().length === 0) return { changed: false, payload, reason: "empty-content" };
  if (!record(payload)) return { changed: false, payload, reason: "unsupported-payload-shape" };
  const inject = (key: "input" | "messages", part: "input_text" | "text"): LastUserTextAppendResult => {
    const next = structuredClone(payload);
    const list = next[key];
    if (!Array.isArray(list)) return { changed: false, payload, reason: "unsupported-payload-shape" };
    const index = lastUserIndex(list);
    if (index < 0) return { changed: false, payload, reason: "missing-user-message" };
    const message = list[index];
    if (!record(message)) return { changed: false, payload, reason: "unsupported-user-content-shape" };
    const reason = appendTextPart(message, content, part);
    return reason === null ? { changed: true, payload: next } : { changed: false, payload, reason };
  };
  if (Array.isArray(payload.input)) return inject("input", "input_text");
  if (Array.isArray(payload.messages)) return inject("messages", "text");
  return { changed: false, payload, reason: "unsupported-payload-shape" };
}

function addedLastUserText(beforeContent: unknown, afterContent: unknown, partType: "input_text" | "text"): string | undefined {
  const isPart = (value: unknown): value is { type: string; text: string } => {
    if (!record(value) || value.type !== partType || typeof value.text !== "string" || value.text.trim().length === 0) return false;
    return Object.keys(value).filter(k => value[k] !== undefined).sort().join("\0") === "text\0type";
  };
  const suffix = (prefixLength: number, afterParts: unknown[], prefixEqual: (index: number) => boolean): string | undefined => {
    if (!Array.isArray(afterParts) || afterParts.length <= prefixLength) return;
    for (let i = 0; i < prefixLength; i++) if (!prefixEqual(i)) return;
    const added: string[] = [];
    for (let i = prefixLength; i < afterParts.length; i++) {
      const part = afterParts[i];
      if (!isPart(part)) return;
      added.push(part.text);
    }
    return added.length ? added.join("") : undefined;
  };
  if (typeof beforeContent === "string") {
    if (beforeContent.trim().length === 0 || !Array.isArray(afterContent)) return;
    return suffix(1, afterContent, index => index === 0 && canonical(afterContent[0]) === canonical(textPart(partType, beforeContent)));
  }
  if (!Array.isArray(beforeContent) || !Array.isArray(afterContent)) return;
  return suffix(beforeContent.length, afterContent, index => canonical(beforeContent[index]) === canonical(afterContent[index]));
}

export function lastUserTextAppend(before: unknown, after: unknown): { ok: true; addedTokens: number; addedText: string } | { ok: false } {
  if (!record(before) || !record(after)) return { ok: false };
  const key: "input" | "messages" | undefined = Array.isArray(before.input) && Array.isArray(after.input) ? "input"
    : !Array.isArray(before.input) && !Array.isArray(after.input) && Array.isArray(before.messages) && Array.isArray(after.messages) ? "messages"
    : undefined;
  if (!key) return { ok: false };
  for (const field of INPUT_KEYS) {
    if (field === key) continue;
    if (canonical(before[field]) !== canonical(after[field])) return { ok: false };
  }
  const beforeList = before[key] as unknown[];
  const afterList = after[key] as unknown[];
  if (beforeList.length !== afterList.length) return { ok: false };
  const index = lastUserIndex(beforeList);
  if (index < 0 || lastUserIndex(afterList) !== index) return { ok: false };
  for (let i = 0; i < beforeList.length; i++) {
    if (i === index) continue;
    if (canonical(beforeList[i]) !== canonical(afterList[i])) return { ok: false };
  }
  const prior = beforeList[index], next = afterList[index];
  if (!record(prior) || !record(next) || next.role !== "user") return { ok: false };
  const priorKeys = Object.keys(prior).filter(k => k !== "content" && prior[k] !== undefined).sort();
  const nextKeys = Object.keys(next).filter(k => k !== "content" && next[k] !== undefined).sort();
  if (priorKeys.join("\0") !== nextKeys.join("\0")) return { ok: false };
  for (const field of priorKeys) if (canonical(prior[field]) !== canonical(next[field])) return { ok: false };
  const added = addedLastUserText(prior.content, next.content, LAST_USER_TEXT_PART[key]);
  if (added === undefined) return { ok: false };
  return { ok: true, addedTokens: textTokens(added), addedText: added };
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
  context: Context;
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
  const append = lastUserTextAppend(prior, body);
  const structural = args.delta.categories.filter(c => UNVALIDATED.has(c));
  if (append.ok) {
    if (structural.some(c => c !== "input")) throw new EngineError("CONFIG", `Nunc: unvalidated payload ${structural.join(",")} rewrite; request was not sent`);
    const added = Math.max(args.delta.grewTokens, args.delta.inputGrewTokens, append.addedTokens);
    if (args.inputTokens + added > args.inputLimit) {
      throw new EngineError("CAPACITY", `Payload input growth ${added} exceeds remaining safe input; request was not sent`);
    }
    const serializedOutput = args.delta.outputAfter ?? args.delta.outputBefore;
    if (serializedOutput !== undefined) {
      const nativeOccupied = estimateContextTokens(args.context).tokens;
      const nativeAdded = Math.max(estimateTextTokens(append.addedText), Math.ceil(added / 4));
      if (nativeOccupied + nativeAdded + serializedOutput > args.model.contextWindow) {
        throw new EngineError("CAPACITY", `Payload input growth ${added} exceeds remaining context after native output clamp; request was not sent`);
      }
    }
    return;
  }
  if (structural.length) throw new EngineError("CONFIG", `Nunc: unvalidated payload ${structural.join(",")} rewrite; request was not sent`);
  if (args.delta.grewTokens > 0 && args.inputTokens + args.delta.grewTokens > args.inputLimit) {
    throw new EngineError("CAPACITY", `Payload input growth ${args.delta.grewTokens} exceeds remaining safe input; request was not sent`);
  }
}
