import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { convertToLlm, sessionEntryToContextMessages, DEFAULT_MAX_BYTES, truncateHead, type SessionEntry, type SessionManager } from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai";
import type { MaintenanceResult } from "../engine/types.js";
import { object, requireValue, within, type Selection } from "./contract.js";

export interface Turn { id: string; text: string }
export interface GeneratedFile { path: string; segments: Array<{ repeat: number; text: string }> }
export interface ScenarioInput { id: string; files: Record<string, string>; generatedFiles?: GeneratedFile[]; turns: Turn[] }
export interface Control { afterTurn: string; action: "rollover" | "pause_resume_same_session" | "switch_to_authorized_smaller_model"; placement?: { retireThroughTurn?: string; retainTurns?: string[]; retireEvidenceFromTurn?: string }; capacity?: string; steer?: string }
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
  fields(value, ["afterTurn", "action", "placement", "capacity", "steer"], "control");
  requireValue(nonempty(value.afterTurn) && turns.includes(value.afterTurn) && ["rollover", "pause_resume_same_session", "switch_to_authorized_smaller_model"].includes(String(value.action)), "SCENARIO", "Invalid control action/turn");
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
  requireValue(object(reference) && reference.formatVersion === 1 && reference.inputs === "inputs.json" && reference.visibility === "runner-and-observer-only" && Array.isArray(reference.cases), "SCENARIO", "Unsupported observer format");
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
  if (selection.variant) {
    requireValue(Array.isArray(obs.variants) && obs.variants.every(v => object(v) && nonempty(v.id)) && new Set(obs.variants.map(v => v.id)).size === obs.variants.length, "SCENARIO", "Invalid/duplicate variants");
    obs = obs.variants.find(v => v.id === selection.variant);
    fields(obs, ["id", "controls", "setupChecks", "artifactChecks", "actionChecks"], "variant");
  }
  requireValue(Array.isArray(obs.controls) && obs.controls.length > 0, "SCENARIO", "Missing observer controls");
  let lastTurn = -1; const controls = new Set<string>(); const steered = new Set<string>();
  for (const control of obs.controls) {
    validateControl(control, turns); const at = turns.indexOf(control.afterTurn), key = `${at}/${control.action}`;
    requireValue(at >= lastTurn && !controls.has(key), "SCENARIO", "Duplicate/out-of-order observer control"); lastTurn = at; controls.add(key);
    if (control.steer) { requireValue(!steered.has(control.steer), "SCENARIO", "Duplicate steer turn"); steered.add(control.steer); }
    if (control.action !== "rollover") requireValue(controls.has(`${at}/rollover`) && (control.action === "pause_resume_same_session" ? selection.id === "c3" : selection.id === "c5"), "SCENARIO", "Unsupported restart/switch placement");
  }
  requireValue(Array.isArray(obs.artifactChecks), "SCENARIO", "Missing artifact checks"); obs.artifactChecks.forEach(validateArtifactCheck);
  requireValue(stringList(obs.setupChecks) && stringList(obs.actionChecks), "SCENARIO", "Invalid observer criteria");
  return { input: raw as unknown as ScenarioInput, observer: { ...obs, id: selection.id } as unknown as ScenarioObserver };
}
export async function loadScenario(repository: string, selection: Selection): Promise<{ input: ScenarioInput; observer: ScenarioObserver }> {
  return parseScenario(JSON.parse(await readFile(join(repository, "tests/scenarios/inputs.json"), "utf8")), JSON.parse(await readFile(join(repository, "tests/scenarios/observer.json"), "utf8")), selection);
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
  const passed = observed !== undefined && (check.operator === "equal" ? isDeepStrictEqual(observed, check.value) : check.operator === "unequal" ? !isDeepStrictEqual(observed, check.value) : Array.isArray(observed) && observed.some(v => isDeepStrictEqual(v, check.value)));
  return { check: `${check.path}${check.pointer}`, status: passed ? "PROVEN" : "DISPROVEN", observed: observed ?? null };
}
export async function scoreArtifacts(cwd: string, observer: ScenarioObserver, prerequisites: CheckResult[]) {
  const artifacts: Record<string, unknown> = {};
  for (const check of observer.artifactChecks) {
    if (Object.hasOwn(artifacts, check.path)) continue;
    requireValue(within(join(cwd, check.path), cwd), "SCENARIO", "Artifact escapes task directory");
    try { const raw = await readFile(join(cwd, check.path), "utf8"); requireValue(Buffer.byteLength(raw) <= 1_000_000, "ARTIFACT", "Artifact exceeds observer bound"); artifacts[check.path] = JSON.parse(raw); }
    catch { artifacts[check.path] = null; }
  }
  const eligible = prerequisites.length > 0 && prerequisites.every(p => p.status === "PROVEN");
  const checks = observer.artifactChecks.map(check => eligible ? checkArtifact(check, artifacts[check.path]) : { check: `${check.path}${check.pointer}`, status: "UNPROVEN" as const, reason: "Required persisted source placement/restart/capacity prerequisites did not pass" });
  return { artifacts, checks, actionReview: observer.actionChecks.map(check => ({ check, status: "UNPROVEN" as const, reason: "Independent observer must inspect actual session/tool actions; no judge model is called" })) };
}
export function maintenanceResult(event: unknown): MaintenanceResult | undefined {
  const result = object(event) && object(event.result) ? event.result : event;
  if (!object(result) || typeof result.ok !== "boolean" || !object(result.observations)) return undefined;
  return result as unknown as MaintenanceResult;
}
export function checkFullExtraction(beforeActive: SessionEntry[], context: Context | undefined): CheckResult {
  const expected = beforeActive.filter(e => e.type !== "compaction").map(e => ({ entryId: e.id, messages: convertToLlm(sessionEntryToContextMessages(e).filter(m => m.role !== "compactionSummary" && !(m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted")))) })).filter(e => e.messages.length > 0);
  const records: Record<string, unknown>[] = [];
  for (const message of context?.messages ?? []) if (Array.isArray(message.content)) for (const block of message.content) if (block.type === "text") {
    try { const value: unknown = JSON.parse(block.text); if (object(value)) records.push(value); } catch { /* Non-record control text is not evidence. */ }
  }
  // JSON transport omits undefined host metadata (e.g. toolResult.details/usage); it carries no evidence bytes.
  const actual = records.filter(r => r.region === "B" || r.region === "K").map(r => ({ entryId: r.entryId, messages: r.messages }));
  const latest = beforeActive.find(e => e.type === "compaction");
  const slots: unknown = latest?.type === "compaction" && object(latest.details) && object(latest.details.nunc) ? latest.details.nunc.slots : [];
  const memory = records.find(r => r.source === "F/M");
  return { check: "actual full extraction contains all Pi-visible source messages and saved M without loss", status: expected.length > 0 && isDeepStrictEqual(actual, JSON.parse(JSON.stringify(expected))) && isDeepStrictEqual(memory?.M, slots) ? "PROVEN" : "UNPROVEN" };
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
