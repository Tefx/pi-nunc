import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { convertToLlm, sessionEntryToContextMessages, DEFAULT_MAX_BYTES, truncateHead, type SessionEntry, type SessionManager } from "@earendil-works/pi-coding-agent";
import { readSourceRecords } from "../engine/request.js";
import type { Context, Message } from "@earendil-works/pi-ai";
import type { MaintenanceResult } from "../engine/types.js";
import { object, requireValue, within, type Selection } from "./contract.js";

export interface Turn { id: string; text: string }
export interface GeneratedFile { path: string; segments: Array<{ repeat: number; text: string }> }
export interface ScenarioInput { id: string; files: Record<string, string>; generatedFiles?: GeneratedFile[]; turns: Turn[] }
export interface ToolExchange { occurrence: number; pathArgument: string; toolName: string; turn: string }
export interface ToolTrigger { occurrence: number; pathArgument: string; toolName: string; when: "after_result_before_continuation" }
export interface Control { afterTurn?: string; duringTurn?: string; action: "rollover" | "pause_resume_same_session" | "switch_to_authorized_smaller_model" | "rollover_at_tool_boundary"; placement?: { retireThroughTurn?: string; retainTurns?: string[]; retireEvidenceFromTurn?: string; retireRequestOfTurn?: string; retainToolExchange?: ToolExchange }; capacity?: string; steer?: string; trigger?: ToolTrigger }
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ArtifactCheck = { path: string; pointer: string } & ({ operator: "equal" | "contains" | "unequal"; value: JsonValue } | { operator: "semantic"; criterion: string });
export interface ScenarioObserver { id: string; controls: Control[]; setupChecks: string[]; artifactChecks: ArtifactCheck[]; actionChecks: string[] }
export interface CheckResult { check: string; status: "PROVEN" | "DISPROVEN" | "UNPROVEN"; observed?: unknown; reason?: string }

function fields(value: unknown, allowed: string[], label: string): asserts value is Record<string, unknown> {
  requireValue(object(value) && Object.keys(value).every(k => allowed.includes(k)), "SCENARIO", `Invalid ${label} fields`);
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function localPath(value: unknown): value is string { return nonempty(value) && !isAbsolute(value) && value.split(/[\\/\\\\]/).every(part => part.length > 0 && part !== "." && part !== ".." && !part.startsWith(".")); }
function stringList(value: unknown): value is string[] { return Array.isArray(value) && value.every(nonempty); }
function jsonValue(value: unknown): value is JsonValue {
  return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || (Array.isArray(value) ? value.every(jsonValue) : object(value) && Object.values(value).every(jsonValue));
}
export function validateArtifactCheck(value: unknown): asserts value is ArtifactCheck {
  fields(value, ["path", "pointer", "operator", "value", "criterion"], "artifact check");
  requireValue(localPath(value.path) && typeof value.pointer === "string" && /^(?:|\/(?:[^~]|~[01])*)$/.test(value.pointer), "SCENARIO", "Invalid artifact path/JSON pointer");
  if (value.operator === "semantic") requireValue(nonempty(value.criterion) && !Object.hasOwn(value, "value"), "SCENARIO", "Semantic check requires an independent criterion");
  else requireValue((value.operator === "equal" || value.operator === "contains" || value.operator === "unequal") && Object.hasOwn(value, "value") && jsonValue(value.value) && !Object.hasOwn(value, "criterion"), "SCENARIO", "Exact artifact check requires a defined JSON value and supported operator");
}
export function expandGeneratedText(file: GeneratedFile): string {
  return file.segments.map(s => s.text.repeat(s.repeat)).join("");
}
export function qualifyFullGiantSource(generated: GeneratedFile[] | undefined): CheckResult {
  const file = generated?.[0];
  const exception = file?.segments.find(s => s.repeat === 1)?.text.trim();
  const text = file ? expandGeneratedText(file) : "";
  const bytes = Buffer.byteLength(text);
  const truncation = truncateHead(text);
  const inFirst = Boolean(exception) && truncation.content.includes(exception!);
  const pass = Boolean(file) && bytes > DEFAULT_MAX_BYTES && truncation.truncated === true && Boolean(exception) && text.includes(exception!) && !inFirst;
  return { check: "c4/full source exceeds native read truncation and hides the middle exception until complete exposure", status: pass ? "PROVEN" : "UNPROVEN", observed: { bytes, nativeMaxBytes: DEFAULT_MAX_BYTES, truncated: truncation.truncated, truncatedBy: truncation.truncatedBy, firstChunkLines: truncation.outputLines, exceptionInFirstChunk: inFirst } };
}
export function validateControl(value: unknown, turns: string[]): asserts value is Control {
  fields(value, ["afterTurn", "duringTurn", "action", "placement", "capacity", "steer", "trigger"], "control");
  requireValue(nonempty(value.action) && ["rollover", "pause_resume_same_session", "switch_to_authorized_smaller_model", "rollover_at_tool_boundary"].includes(String(value.action)), "SCENARIO", "Invalid control action");
  if (value.action === "rollover_at_tool_boundary") {
    requireValue(nonempty(value.duringTurn) && turns.includes(value.duringTurn), "SCENARIO", "Invalid duringTurn");
    requireValue(value.afterTurn === undefined && value.capacity === undefined && value.steer === undefined, "SCENARIO", "Invalid rollover_at_tool_boundary fields");
    fields(value.trigger, ["occurrence", "pathArgument", "toolName", "when"], "trigger");
    const trig = value.trigger as Record<string, unknown>;
    requireValue(Number.isSafeInteger(trig.occurrence) && Number(trig.occurrence) > 0, "SCENARIO", "Invalid trigger occurrence");
    requireValue(localPath(trig.pathArgument), "SCENARIO", "Invalid trigger pathArgument");
    requireValue(nonempty(trig.toolName), "SCENARIO", "Invalid trigger toolName");
    requireValue(trig.when === "after_result_before_continuation", "SCENARIO", "trigger when must be after_result_before_continuation");
    fields(value.placement, ["retireRequestOfTurn", "retainToolExchange"], "placement");
    const p = value.placement as Record<string, unknown>;
    requireValue(p.retireRequestOfTurn === value.duringTurn, "SCENARIO", "retireRequestOfTurn must match duringTurn");
    fields(p.retainToolExchange, ["occurrence", "pathArgument", "toolName", "turn"], "retainToolExchange");
    const ex = p.retainToolExchange as Record<string, unknown>;
    requireValue(Number.isSafeInteger(ex.occurrence) && Number(ex.occurrence) > 0, "SCENARIO", "Invalid retainToolExchange occurrence");
    requireValue(ex.pathArgument === trig.pathArgument, "SCENARIO", "retainToolExchange pathArgument must match trigger");
    requireValue(ex.toolName === trig.toolName, "SCENARIO", "retainToolExchange toolName must match trigger");
    requireValue(ex.turn === value.duringTurn, "SCENARIO", "retainToolExchange turn must match duringTurn");
    return;
  }
  requireValue(nonempty(value.afterTurn) && turns.includes(value.afterTurn), "SCENARIO", "Invalid control afterTurn");
  const after = turns.indexOf(value.afterTurn);
  if (value.action !== "rollover") { requireValue(value.placement === undefined && value.capacity === undefined && value.steer === undefined, "SCENARIO", "Placement/capacity/steer apply only to rollover"); return; }
  requireValue(value.capacity === undefined || nonempty(value.capacity), "SCENARIO", "Invalid capacity condition");
  requireValue(value.steer === undefined || nonempty(value.steer) && turns.includes(value.steer) && turns.indexOf(value.steer) > after, "SCENARIO", "Steer must name a later task turn");
  requireValue(value.placement !== undefined || value.capacity !== undefined, "SCENARIO", "Rollover needs a placement or capacity prerequisite");
  if (value.placement !== undefined) {
    fields(value.placement, ["retireThroughTurn", "retainTurns", "retireEvidenceFromTurn"], "placement");
    const p = value.placement;
    const reference = (t: unknown) => nonempty(t) && turns.includes(t) && turns.indexOf(t) <= after;
    requireValue((p.retireThroughTurn !== undefined) !== (p.retireEvidenceFromTurn !== undefined), "SCENARIO", "Placement needs exactly one retirement rule");
    if (p.retireThroughTurn !== undefined) requireValue(reference(p.retireThroughTurn) && stringList(p.retainTurns) && p.retainTurns.length > 0, "SCENARIO", "Retiring complete turns requires explicit retained turns");
    if (p.retireEvidenceFromTurn !== undefined) requireValue(reference(p.retireEvidenceFromTurn), "SCENARIO", "Invalid retiring evidence turn");
    if (p.retainTurns !== undefined) {
      requireValue(stringList(p.retainTurns) && p.retainTurns.length > 0 && new Set(p.retainTurns).size === p.retainTurns.length && p.retainTurns.every(reference), "SCENARIO", "Invalid retained turns");
      const retiredThrough = turns.indexOf(String(p.retireThroughTurn ?? p.retireEvidenceFromTurn));
      requireValue(p.retainTurns.every(t => turns.indexOf(t) > retiredThrough), "SCENARIO", "Retained turns conflict with retirement");
    }
  }
}
export function parseScenario(source: unknown, reference: unknown, selection: Selection): { input: ScenarioInput; observer: ScenarioObserver } {
  requireValue(object(source) && source.formatVersion === 1 && Array.isArray(source.cases), "SCENARIO", "Unsupported inputs format");
  requireValue(object(reference) && reference.formatVersion === 1 && (reference.inputs === "inputs.json" || reference.inputs === "extraction-inputs.json") && reference.visibility === "runner-and-observer-only" && Array.isArray(reference.cases), "SCENARIO", "Unsupported observer format");
  for (const cases of [source.cases, reference.cases]) requireValue(cases.length > 0 && cases.every(c => object(c) && nonempty(c.id)) && new Set(cases.map(c => c.id)).size === cases.length, "SCENARIO", "Invalid/duplicate case IDs");
  const raw: unknown = source.cases.find(c => c.id === selection.id);
  let obs: unknown = reference.cases.find(c => c.id === selection.id);
  fields(raw, ["id", "files", "generatedFiles", "turns", "variants"], "scenario input");
  if (raw.variants !== undefined) {
    requireValue(Array.isArray(raw.variants) && raw.variants.every(v => object(v) && nonempty(v.id)) && new Set(raw.variants.map(v => String(v.id))).size === raw.variants.length, "SCENARIO", "Invalid/duplicate input variants");
    if (selection.variant) {
      const overlay = raw.variants.find(v => v.id === selection.variant);
      if (overlay !== undefined) {
        fields(overlay, ["id", "files", "generatedFiles", "turns"], "input variant");
        if (overlay.files !== undefined) raw.files = overlay.files;
        if (overlay.generatedFiles !== undefined) raw.generatedFiles = overlay.generatedFiles;
        if (overlay.turns !== undefined) raw.turns = overlay.turns;
      }
    }
  }
  requireValue(object(raw.files) && Object.entries(raw.files).every(([path, text]) => localPath(path) && typeof text === "string"), "SCENARIO", "Invalid fixture files");
  requireValue(Array.isArray(raw.turns) && raw.turns.length > 0, "SCENARIO", "Missing task turns");
  const turns: string[] = [];
  for (const t of raw.turns) { fields(t, ["id", "text"], "turn"); requireValue(nonempty(t.id) && nonempty(t.text) && !turns.includes(t.id), "SCENARIO", "Invalid/duplicate task turn"); turns.push(t.id); }
  const files = new Set(Object.keys(raw.files));
  if (raw.generatedFiles !== undefined) {
    requireValue(Array.isArray(raw.generatedFiles), "SCENARIO", "Invalid generatedFiles");
    for (const file of raw.generatedFiles) {
      fields(file, ["path", "segments"], "generated file");
      requireValue(localPath(file.path) && !files.has(file.path) && Array.isArray(file.segments) && file.segments.length > 0, "SCENARIO", "Invalid/duplicate generated file"); files.add(file.path);
      let bytes = 0;
      for (const s of file.segments) { fields(s, ["repeat", "text"], "generated segment"); requireValue(Number.isSafeInteger(s.repeat) && Number(s.repeat) > 0 && typeof s.text === "string", "SCENARIO", "Invalid generated segment"); bytes += Number(s.repeat) * Buffer.byteLength(s.text); }
      requireValue(bytes <= 1_000_000, "SCENARIO", "Generated file exceeds bound");
    }
  }
  if (selection.id === "c4" && selection.variant === "full") requireValue(qualifyFullGiantSource(raw.generatedFiles as GeneratedFile[] | undefined).status === "PROVEN", "SCENARIO", "c4/full fixture must exceed native read truncation and hide the middle exception from the first chunk");
  if (selection.id === "c4" && selection.variant === "capacity") {
    const bytes = (raw.generatedFiles as GeneratedFile[] | undefined)?.reduce((n, file) => n + Buffer.byteLength(expandGeneratedText(file)), 0) ?? 0;
    requireValue(bytes > DEFAULT_MAX_BYTES, "SCENARIO", "c4/capacity must keep a giant source above the native read threshold");
  }
  fields(obs, ["id", "covers", "controls", "setupChecks", "artifactChecks", "actionChecks", "failureExample", "variants"], "observer");
  const obsRecord = obs as Record<string, unknown>;
  if (selection.variant) {
    requireValue(Array.isArray(obsRecord.variants) && obsRecord.variants.every(v => object(v) && nonempty(v.id)) && new Set(obsRecord.variants.map(v => v.id)).size === obsRecord.variants.length, "SCENARIO", "Invalid/duplicate variants");
    const variant = (obsRecord.variants as unknown[]).find(v => object(v) && v.id === selection.variant);
    requireValue(variant !== undefined, "SCENARIO", `Variant ${selection.variant} not found in observer`);
    fields(variant, ["id", "controls", "setupChecks", "artifactChecks", "actionChecks"], "variant");
    const varRecord = variant as Record<string, unknown>;
    obs = {
      ...obsRecord,
      id: selection.id,
      controls: varRecord.controls ?? obsRecord.controls,
      setupChecks: [...(Array.isArray(obsRecord.setupChecks) ? obsRecord.setupChecks : []), ...(Array.isArray(varRecord.setupChecks) ? varRecord.setupChecks : [])],
      actionChecks: [...(Array.isArray(obsRecord.actionChecks) ? obsRecord.actionChecks : []), ...(Array.isArray(varRecord.actionChecks) ? varRecord.actionChecks : [])],
      artifactChecks: varRecord.artifactChecks ?? obsRecord.artifactChecks ?? [],
    };
  }
  const finalObs = obs as Record<string, unknown>;
  requireValue(Array.isArray(finalObs.controls) && finalObs.controls.length > 0, "SCENARIO", "Missing observer controls");
  let lastTurn = -1; const controls = new Set<string>(); const steered = new Set<string>();
  for (const control of finalObs.controls as unknown[]) {
    validateControl(control, turns);
    const targetTurn = (control as Control).afterTurn ?? (control as Control).duringTurn!;
    const at = turns.indexOf(targetTurn), key = `${at}/${(control as Control).action}`;
    requireValue(at >= lastTurn && !controls.has(key), "SCENARIO", "Duplicate/out-of-order observer control"); lastTurn = at; controls.add(key);
    if ((control as Control).steer) { requireValue(!steered.has((control as Control).steer!), "SCENARIO", "Duplicate steer turn"); steered.add((control as Control).steer!); }
    if ((control as Control).action !== "rollover" && (control as Control).action !== "rollover_at_tool_boundary") {
      const hasRollover = controls.has(`${at}/rollover`) || controls.has(`${at}/rollover_at_tool_boundary`);
      requireValue(hasRollover && ((control as Control).action === "pause_resume_same_session" ? ["c3", "e1", "e3"].includes(selection.id) : selection.id === "c5"), "SCENARIO", "Unsupported restart/switch placement");
    }
  }
  requireValue(Array.isArray(finalObs.artifactChecks), "SCENARIO", "Missing artifact checks"); (finalObs.artifactChecks as unknown[]).forEach(validateArtifactCheck);
  requireValue(stringList(finalObs.setupChecks) && stringList(finalObs.actionChecks), "SCENARIO", "Invalid observer criteria");
  return { input: raw as unknown as ScenarioInput, observer: { ...finalObs, id: selection.id } as unknown as ScenarioObserver };
}
export async function loadScenario(repository: string, selection: Selection, explicitAssets?: { inputs?: string; observer?: string }): Promise<{ input: ScenarioInput; observer: ScenarioObserver }> {
  const assets = selection.assets ?? explicitAssets;
  const isExtraction = selection.id.startsWith("e");
  const inputsFile = assets?.inputs ?? (isExtraction ? "tests/scenarios/extraction-inputs.json" : "tests/scenarios/inputs.json");
  const observerFile = assets?.observer ?? (isExtraction ? "tests/scenarios/extraction-observer.json" : "tests/scenarios/observer.json");
  const inputsPath = isAbsolute(inputsFile) ? inputsFile : join(repository, inputsFile);
  const observerPath = isAbsolute(observerFile) ? observerFile : join(repository, observerFile);
  return parseScenario(JSON.parse(await readFile(inputsPath, "utf8")), JSON.parse(await readFile(observerPath, "utf8")), selection);
}
export async function seedScenario(input: ScenarioInput, cwd: string): Promise<void> {
  await mkdir(cwd, { recursive: true });
  const files = { ...input.files };
  for (const generated of input.generatedFiles ?? []) {
    requireValue(Array.isArray(generated.segments) && generated.segments.every(s => Number.isSafeInteger(s.repeat) && s.repeat > 0 && typeof s.text === "string" && s.repeat * Buffer.byteLength(s.text) <= 1_000_000), "SCENARIO", "Invalid generated fixture");
    files[generated.path] = expandGeneratedText(generated);
  }
  for (const [path, text] of Object.entries(files)) {
    const target = join(cwd, path); requireValue(within(target, cwd), "SCENARIO", "Fixture escapes task directory");
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, text, { flag: "wx", mode: 0o600 });
  }
}
export function jsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) return undefined;
  let current = value;
  for (const part of pointer.slice(1).split("/").map(p => p.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (Array.isArray(current)) current = /^(0|[1-9][0-9]*)$/.test(part) ? current[Number(part)] : undefined;
    else current = object(current) && Object.hasOwn(current, part) ? current[part] : undefined;
  }
  return current;
}
export function checkArtifact(check: ArtifactCheck, artifact: unknown): CheckResult {
  validateArtifactCheck(check);
  const observed = jsonPointer(artifact, check.pointer);
  if (check.operator === "semantic") return { check: `${check.path}${check.pointer}`, status: "UNPROVEN", observed: observed ?? null, reason: check.criterion ?? "Independent semantic review required" };
  const passed = observed !== undefined && (
    check.operator === "equal" ? isDeepStrictEqual(observed, check.value) :
    check.operator === "unequal" ? !isDeepStrictEqual(observed, check.value) :
    (typeof observed === "string" && typeof check.value === "string" ? observed.includes(check.value) : Array.isArray(observed) && observed.some(v => isDeepStrictEqual(v, check.value)))
  );
  return { check: `${check.path}${check.pointer}`, status: passed ? "PROVEN" : "DISPROVEN", observed: observed ?? null };
}
function userTextFromMessage(message: Message): string | undefined {
  if (message.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return message.content.filter(b => b.type === "text").map(b => (b as any).text).join("");
  return undefined;
}
function readContextRecords(ctx: Context, region: "B" | "K"): Array<{ region: string; messages: Message[] }> {
  const records: Array<{ region: string; messages: Message[] }> = [];
  for (const message of ctx.messages ?? []) {
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "text") {
          records.push(...(readSourceRecords(block.text).filter(r => r.region === region) as any));
        }
      }
    }
  }
  return records;
}
export async function scoreArtifacts(cwd: string, observer: ScenarioObserver, prerequisites: CheckResult[], context?: { actions?: unknown[]; turns?: Record<string, string[]> }) {
  const artifacts: Record<string, unknown> = {};
  for (const check of observer.artifactChecks) {
    if (Object.hasOwn(artifacts, check.path)) continue;
    requireValue(within(join(cwd, check.path), cwd), "SCENARIO", "Artifact escapes task directory");
    try { const raw = await readFile(join(cwd, check.path), "utf8"); requireValue(Buffer.byteLength(raw) <= 1_000_000, "ARTIFACT", "Artifact exceeds observer bound"); artifacts[check.path] = JSON.parse(raw); }
    catch { artifacts[check.path] = null; }
  }
  const eligible = prerequisites.length > 0 && prerequisites.every(p => p.status === "PROVEN");
  const checks = observer.artifactChecks.map(check => eligible ? checkArtifact(check, artifacts[check.path]) : { check: `${check.path}${check.pointer}`, status: "UNPROVEN" as const, reason: "Required persisted source placement/restart/capacity prerequisites did not pass" });

  const rawActions = (context?.actions ?? []) as Array<{ turn?: string; event?: any }>;
  const actionReview = observer.actionChecks.map(check => {
    if (check.includes("python3 verify.py")) {
      const requiredTurn = observer.id === "e1" ? "e" : observer.id === "e3" ? "b" : undefined;
      const verifyCalls = rawActions.filter(a => object(a) && object(a.event) && a.event.type === "tool_call" && a.event.toolName === "bash" && typeof (a.event.input as any)?.command === "string" && ((a.event.input as any).command as string).includes("verify.py"));

      if (verifyCalls.length === 0) {
        return { check, status: "UNPROVEN" as const, reason: "No python3 verify.py command was executed" };
      }

      // Check premature execution
      const premature = verifyCalls.find(c => requiredTurn !== undefined && c.turn !== requiredTurn);
      if (premature) {
        return { check, status: "DISPROVEN" as const, reason: `Verification command executed prematurely during turn ${premature.turn} instead of required turn ${requiredTurn}` };
      }

      const matchingCall = verifyCalls.find(c => requiredTurn === undefined || c.turn === requiredTurn);
      if (!matchingCall) {
        return { check, status: "UNPROVEN" as const, reason: `No python3 verify.py executed during required turn ${requiredTurn}` };
      }

      // Check matching tool_result
      const callId = matchingCall.event.toolCallId;
      const resultAction = rawActions.find(a => object(a) && object(a.event) && a.event.type === "tool_result" && a.event.toolCallId === callId);
      if (!resultAction || resultAction.event.isError) {
        return { check, status: "DISPROVEN" as const, reason: "Verification command failed with an error" };
      }

      // Check verification artifact created and passed
      const artifactName = observer.id === "e1" ? "verification.json" : "verified.json";
      const targetExport = observer.id === "e1" ? "export.json" : "ready.json";
      const artifactPath = join(cwd, artifactName);
      if (!artifacts[artifactName] && existsSync(artifactPath)) {
        try { artifacts[artifactName] = JSON.parse(readFileSync(artifactPath, "utf8")); } catch {}
      }
      const verifyArtifact = artifacts[artifactName];
      if (!object(verifyArtifact) || (verifyArtifact as any).passed !== true) {
        return { check, status: "DISPROVEN" as const, reason: `Verification artifact ${artifactName} missing or passed !== true` };
      }

      // Check whether verify.py was modified
      const scriptModified = rawActions.some(a => {
        if (!object(a) || !object(a.event)) return false;
        const e = a.event;
        if (e.type !== "tool_call" || !["write", "edit"].includes(String(e.toolName))) return false;
        const rawPath = typeof (e.input as any)?.path === "string" ? (e.input as any).path : "";
        const normPath = relative(cwd, resolve(cwd, rawPath));
        if (normPath !== "verify.py") return false;
        const callId = e.toolCallId;
        const res = rawActions.find(r => object(r) && object(r.event) && r.event.type === "tool_result" && r.event.toolCallId === callId);
        return Boolean(res && !res.event.isError);
      });
      if (scriptModified) {
        return { check, status: "DISPROVEN" as const, reason: "Verification script verify.py was modified" };
      }

      // Check whether verification artifact was authored directly by tool call
      const directWrite = rawActions.some(a => {
        if (!object(a) || !object(a.event)) return false;
        const e = a.event;
        if (e.type !== "tool_call" || !["write", "edit"].includes(String(e.toolName))) return false;
        const rawPath = typeof (e.input as any)?.path === "string" ? (e.input as any).path : "";
        const normPath = relative(cwd, resolve(cwd, rawPath));
        if (normPath !== artifactName) return false;
        const callId = e.toolCallId;
        const res = rawActions.find(r => object(r) && object(r.event) && r.event.type === "tool_result" && r.event.toolCallId === callId);
        return Boolean(res && !res.event.isError);
      });
      if (directWrite) {
        return { check, status: "DISPROVEN" as const, reason: `Verification artifact ${artifactName} was authored directly by tool call rather than python3 verify.py` };
      }

      // Check that target export was not modified after this verification command
      const callIndex = rawActions.indexOf(matchingCall);
      const laterEdits = rawActions.slice(callIndex + 1).some(a => {
        if (!object(a) || !object(a.event)) return false;
        const e = a.event;
        if (e.type !== "tool_call" || !["write", "edit"].includes(String(e.toolName))) return false;
        const rawPath = typeof (e.input as any)?.path === "string" ? (e.input as any).path : "";
        const normPath = relative(cwd, resolve(cwd, rawPath));
        if (normPath !== targetExport) return false;
        const callId = e.toolCallId;
        const res = rawActions.find(r => object(r) && object(r.event) && r.event.type === "tool_result" && r.event.toolCallId === callId);
        return Boolean(res && !res.event.isError);
      });
      if (laterEdits) {
        return { check, status: "DISPROVEN" as const, reason: `Target artifact ${targetExport} was modified after verification command ran` };
      }

      return { check, status: "PROVEN" as const, observed: { toolCallId: callId, turn: matchingCall.turn, artifact: artifactName, passed: true } };
    }
    return { check, status: "UNPROVEN" as const, reason: "Independent observer must inspect actual session/tool actions; no judge model is called" };
  });

  return { artifacts, checks, actionReview };
}
export function evaluateCapacityPredicates(
  variant: "fits-required" | "required-too-large",
  patch: { add?: Array<{ key: string; text: string }>; remove?: string[]; priority?: string[]; required?: string[] } | undefined,
  memoryLimit: number,
  measure: (slots: Array<{ id: string; text: string }>) => number,
  survivingOldSlots: Array<{ id: string; text: string }> = [],
  nextId: number = 1
): CheckResult[] {
  const results: CheckResult[] = [];
  if (!patch || !Array.isArray(patch.priority)) {
    results.push({ check: "valid patch for capacity predicate evaluation", status: "UNPROVEN", reason: "No valid patch observed" });
    return results;
  }
  const requiredKeys = new Set(patch.required ?? []);
  const removedKeys = new Set(patch.remove ?? []);
  const existingIds = new Set(survivingOldSlots.map(s => s.id));
  let curId = nextId;

  const candidates: Array<{ key: string; slot: { id: string; text: string } }> = [];
  for (const s of survivingOldSlots) {
    if (!removedKeys.has(s.id)) {
      candidates.push({ key: s.id, slot: { id: s.id, text: s.text } });
    }
  }
  for (const a of patch.add ?? []) {
    let id: string;
    do { id = `s${curId++}`; } while (existingIds.has(id));
    existingIds.add(id);
    candidates.push({ key: a.key, slot: { id, text: a.text } });
  }

  const requiredCandidates = candidates.filter(c => requiredKeys.has(c.key));
  const optionalCandidates = candidates.filter(c => !requiredKeys.has(c.key));

  const reqSize = measure(requiredCandidates.map(c => c.slot));
  const totalSize = measure(candidates.map(c => c.slot));

  if (variant === "fits-required") {
    const reqFits = reqSize <= memoryLimit;
    results.push({
      check: "all marked necessary candidates jointly fit within memory limit with growth space",
      status: reqFits ? "PROVEN" : "UNPROVEN",
      observed: { requiredTokens: reqSize, memoryLimit }
    });
    const totalExceeds = totalSize > memoryLimit;
    results.push({
      check: "all candidates together exceed memory limit (actual competition)",
      status: totalExceeds ? "PROVEN" : "UNPROVEN",
      observed: { totalCandidateTokens: totalSize, memoryLimit }
    });
    const largerFound = requiredCandidates.some(req => optionalCandidates.some(opt => measure([req.slot]) > measure([opt.slot])));
    results.push({
      check: "at least one necessary candidate is larger than an optional candidate",
      status: optionalCandidates.length > 0 && largerFound ? "PROVEN" : "UNPROVEN",
      observed: { requiredCount: requiredCandidates.length, optionalCount: optionalCandidates.length, largerFound }
    });
  } else if (variant === "required-too-large") {
    const reqExceeds = reqSize > memoryLimit;
    results.push({
      check: "marked necessary set exceeds rendered memory limit or leaves insufficient growth space",
      status: reqExceeds ? "PROVEN" : "UNPROVEN",
      observed: { requiredTokens: reqSize, memoryLimit }
    });
    const optFits = optionalCandidates.length > 0 && optionalCandidates.some(opt => measure([opt.slot]) <= memoryLimit);
    results.push({
      check: "at least one optional candidate fits within memory limit",
      status: optFits ? "PROVEN" : "UNPROVEN",
      observed: { optionalCount: optionalCandidates.length, optionalFits: optFits }
    });
  }
  return results;
}
export function evaluateE2SetupChecks(
  turnEntries: Record<string, string[]>,
  branch: SessionEntry[],
  rebuilt: SessionEntry[],
  maintenanceEvents: MaintenanceResult[],
  observedContexts: Array<{ turn: string; kind: string; context: Context }> = [],
  actions: unknown[] = []
): CheckResult[] {
  const checks: CheckResult[] = [];
  const m1 = maintenanceEvents[0];
  const maintContext1 = observedContexts.find(c => c.kind === "maintenance");
  const bRecords = maintContext1 ? readContextRecords(maintContext1.context, "B") : [];
  const turnAIds = new Set(turnEntries["a"] ?? []);
  const bHasTurnA = turnAIds.size > 0 && bRecords.some(r => r.messages.some(m => userTextFromMessage(m)?.includes("regional lookup configurations")));
  checks.push({
    check: "initial request in B at first maintenance",
    status: bHasTurnA ? "PROVEN" : "UNPROVEN",
    observed: { bRecordsFound: bRecords.length, bHasTurnA, turnACount: turnAIds.size }
  });

  const m2 = maintenanceEvents[1];
  const maintContext2 = observedContexts.filter(c => c.kind === "maintenance")[1];
  const kRecords = maintContext2 ? readContextRecords(maintContext2.context, "K") : [];
  const turnCIds = new Set(turnEntries["c"] ?? []);
  const kHasTurnC = turnCIds.size > 0 && kRecords.some(r => r.messages.some(m => userTextFromMessage(m)?.includes("Read probe.json")));

  const rawActions = actions as Array<{ turn?: string; event?: any }>;
  const probeCall = rawActions.find(a => object(a) && object(a.event) && a.event.type === "tool_call" && a.event.toolName === "read" && typeof (a.event.input as any)?.path === "string" && (a.event.input as any).path.includes("probe.json"));
  const probeCallId = probeCall?.event?.toolCallId;
  const probeResult = probeCallId ? rawActions.find(a => object(a) && object(a.event) && a.event.type === "tool_result" && a.event.toolCallId === probeCallId && !a.event.isError) : undefined;
  const kHasProbe = Boolean(probeResult && kRecords.some(r => r.messages.some(m => m.role === "toolResult")));

  const turnBIds = turnEntries["b"] ?? [];
  const bRetired = Boolean(m2?.ok && turnBIds.length > 0 && turnBIds.every(id => !rebuilt.some(e => e.id === id)));
  checks.push({
    check: "correction and probe in K at second maintenance while b retires",
    status: kHasTurnC && kHasProbe && bRetired ? "PROVEN" : "UNPROVEN",
    observed: { kHasTurnC, kHasProbe, bRetired, turnBCount: turnBIds.length }
  });

  checks.push({
    check: "natural pre-c M carried provisional route or timeout without prompting",
    status: "UNPROVEN",
    reason: "Independent semantic review required to determine whether natural pre-c M carried the provisional shared route or timeout without prompting"
  });
  checks.push({
    check: "partial mixed-slot update, split or merge occurred without coaching",
    status: "UNPROVEN",
    reason: "Independent semantic review required to determine whether natural model slot organization performed mixed-slot split or merge without coaching"
  });
  return checks;
}
export function maintenanceResult(event: unknown): MaintenanceResult | undefined {
  const result = object(event) && object(event.result) ? event.result : event;
  if (!object(result) || typeof result.ok !== "boolean" || !object(result.observations)) return undefined;
  return result as unknown as MaintenanceResult;
}
/** Independent observer projection: compare task evidence, excluding native replay metadata. */
export function semanticEvidence(message: Message): Record<string, unknown> {
  const content = typeof message.content === "string" ? message.content : message.content.filter(b => b.type !== "thinking" || !b.redacted).map(block => {
    if (block.type === "text") return { type: block.type, text: block.text };
    if (block.type === "thinking") return { type: block.type, thinking: block.thinking };
    if (block.type === "toolCall") return { type: block.type, id: block.id, name: block.name, arguments: block.arguments, ...(block.namespace === undefined ? {} : { namespace: block.namespace }) };
    return block;
  });
  return { role: message.role, ...(message.role === "toolResult" ? { toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError } : {}), ...(message.role === "assistant" ? { stopReason: message.stopReason } : {}), content };
}
export function checkFullExtraction(beforeActive: SessionEntry[], context: Context | undefined): CheckResult {
  const expected = beforeActive.filter(e => e.type !== "compaction").map(e => ({ entryId: e.id, messages: convertToLlm(sessionEntryToContextMessages(e).filter(m => m.role !== "compactionSummary" && !(m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted")))) })).filter(e => e.messages.length > 0);
  const records: Record<string, unknown>[] = [];
  for (const message of context?.messages ?? []) if (Array.isArray(message.content)) for (const block of message.content) if (block.type === "text") {
    records.push(...readSourceRecords(block.text));
  }
  // JSON transport omits undefined host metadata (e.g. toolResult.details/usage); it carries no evidence bytes.
  const actual = records.filter(r => r.region === "B" || r.region === "K").map(r => ({ entryId: r.entryId, messages: r.messages }));
  const latest = beforeActive.find(e => e.type === "compaction");
  const slots: unknown = latest?.type === "compaction" && object(latest.details) && object(latest.details.nunc) ? latest.details.nunc.slots : [];
  const memory = records.find(r => r.source === "F/M");
  return { check: "actual full extraction contains all Pi-visible source messages and saved M without loss", status: expected.length > 0 && isDeepStrictEqual(actual, expected.map(e => ({ ...e, messages: e.messages.map(semanticEvidence) }))) && isDeepStrictEqual(memory?.M, slots) ? "PROVEN" : "UNPROVEN" };
}
export function checkRollover(before: SessionEntry[], after: SessionEntry[], persisted: SessionManager, result: MaintenanceResult | undefined, control: Control, turnEntries: Record<string, string[]>): CheckResult[] {
  const checks: CheckResult[] = [];
  const add = (check: string, pass: boolean, reason?: string) => checks.push({ check, status: pass ? "PROVEN" : "UNPROVEN", ...(reason ? { reason } : {}) });
  const newSnapshots = after.filter(e => e.type === "compaction" && !before.some(b => b.id === e.id));
  const snapshot = newSnapshots[0];
  add("one actual persisted Nunc rollover", newSnapshots.length === 1 && snapshot?.type === "compaction" && snapshot.fromHook === true && object(snapshot.details) && object(snapshot.details.nunc));
  if (!result?.ok || snapshot?.type !== "compaction") { add("successful maintenance candidate", false, result && !result.ok ? `${result.code}: ${result.message}` : "No successful Nunc event/snapshot"); return checks; }
  add("candidate and persisted summary/boundary agree", snapshot.summary === result.candidate.summary && snapshot.firstKeptEntryId === result.candidate.firstKeptEntryId);
  const rebuilt = persisted.buildContextEntries();
  // Stock rebuild can include obsolete carriers inside a legal overlapping K.
  // Nunc removes them at the context seam; the current native snapshot is first.
  add("native rebuild selects latest memory snapshot first", rebuilt[0]?.type === "compaction" && rebuilt[0].id === snapshot.id);
  const retained = result.candidate.kept.map(e => e.entryId);
  // Compare JSONL-representable data. Pi's in-memory tool results can own undefined details/usage that have no persisted bytes.
  add("actual retained K entries retain bytes/order", isDeepStrictEqual(rebuilt.filter(e => retained.includes(e.id)), JSON.parse(JSON.stringify(before.filter(e => retained.includes(e.id))))));
  add("retired entries absent from rebuilt verbatim window", result.candidate.retiredEntryIds.every(id => !rebuilt.some(e => e.id === id)));
  const placement = control.placement;
  if (placement?.retireThroughTurn) {
    const keys = Object.keys(turnEntries), stop = keys.indexOf(placement.retireThroughTurn);
    const ids = keys.slice(0, stop + 1).flatMap(k => turnEntries[k] ?? []);
    add(`retired complete turns through ${placement.retireThroughTurn}`, stop >= 0 && ids.length > 0 && ids.every(id => !rebuilt.some(e => e.id === id)));
  }
  for (const turn of placement?.retainTurns ?? []) {
    const ids = turnEntries[turn] ?? []; add(`complete turn ${turn} retained with tool associations`, ids.length > 0 && ids.every(id => rebuilt.some(e => e.id === id)));
  }
  if (placement?.retireEvidenceFromTurn) {
    const ids = turnEntries[placement.retireEvidenceFromTurn] ?? [];
    const evidence = before.filter(e => ids.includes(e.id) && e.type === "message" && e.message.role === "toolResult");
    add("giant tool evidence actually retired", evidence.length > 0 && evidence.every(e => !rebuilt.some(r => r.id === e.id)));
  }
  const a = result.observations.accounting;
  add("complete accounting with final growth and selected extraction fit", a !== null && a.mainAfterTokens !== null && a.mainAfterTokens < a.effectiveTrigger && (a.growthTokens ?? 0) > 0 && a.extractionTokens <= a.extractionInputLimit);
  return checks;
}
