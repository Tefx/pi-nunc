import { resolve } from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { convertToLlm, sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { project } from "../pi/projection.js";
import { memoryMessage } from "../engine/memory.js";
import { readSourceRecords } from "../engine/request.js";
import { semanticEvidence, type CheckResult, type ScenarioInput } from "./scenarios.js";
import { guidanceExchanges, type GuidanceAction } from "./guidance.js";
import { metricsCommand } from "./tool-path.js";
import type { RequestObservation, RolloverObservation } from "./comparison-observation.js";

export const contentText = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content)
  ? content.filter(b => b?.type === "text").map(b => b.text).join("") : "";
const pathIs = (cwd: string, actual: unknown, wanted: string) => typeof actual === "string" && resolve(cwd, actual.replace(/^@/, "")) === resolve(cwd, wanted);
const messages = (entries: SessionEntry[]) => convertToLlm(entries.flatMap(e => sessionEntryToContextMessages(e))).map(semanticEvidence);
const subsequence = (haystack: unknown[], needle: unknown[]) => needle.length > 0 && haystack.some((_v, i) => same(haystack.slice(i, i + needle.length), needle));

/** A preparation is not a commit. Join unique saved snapshots, exact cuts and the subsequent dispatched request. */
export function retainedRollover(row: RolloverObservation, branch: SessionEntry[], requests: RequestObservation[], all: RolloverObservation[]) {
  const snap = row.snapshot;
  const cut = snap ? row.active.findIndex(e => e.id === snap.firstKeptEntryId) : -1;
  const kept = cut < 0 ? [] : row.active.slice(cut).filter(e => e.type !== "compaction");
  const retired = cut < 0 ? [] : row.active.slice(0, cut).filter(e => e.type !== "compaction");
  const saved = Boolean(snap && row.association?.status === "resolved" &&
    !row.branch.some(e => e.id === snap.id) && branch.filter(e => e.id === snap.id).length === 1 &&
    same(branch.find(e => e.id === snap.id), snap) && all.filter(r => r.snapshot?.id === snap.id).length === 1 &&
    row.rebuilt?.some(e => same(e, snap)) && same(row.rebuilt.filter(e => e.type !== "compaction"), kept));
  const next = requests.find(r => r.callId === row.continuationCallId && r.kind === "main");
  const delivered = next?.context.messages.map(semanticEvidence) ?? [];
  const memory = row.rebuilt ? project(row.rebuilt).memory.slots : [];
  const summary = snap?.fromHook ? (memory.length ? [semanticEvidence(memoryMessage(memory))] : []) : snap ? messages([snap]) : [];
  const continued = Boolean(saved && cut >= 0 && next && subsequence(delivered, messages(kept)) &&
    (summary.length === 0 || summary.every(m => delivered.some(d => same(d, m)))));
  return { saved, continued, snapshotId: snap?.id, firstKeptEntryId: snap?.firstKeptEntryId,
    continuationCallId: next?.callId, retiredEntryIds: retired.map(e => e.id), keptEntryIds: kept.map(e => e.id), memory };
}

/** Paired public tool effect and persisted result; a basename or successful unrelated read supplies no source evidence. */
export function taskRead(scenario: ScenarioInput, branch: SessionEntry[], actions: GuidanceAction[], cwd: string) {
  const read = guidanceExchanges(actions).find(x => x.call.event.toolName === "read" && pathIs(cwd, x.call.event.input?.path, "TASK.md") &&
    x.result?.isError === false && contentText(x.result.content) === scenario.files["TASK.md"]);
  const entry = read && branch.find(e => e.type === "message" && e.message.role === "toolResult" &&
    e.message.toolCallId === read.call.event.toolCallId && e.message.toolName === "read" && !e.message.isError &&
    contentText(e.message.content) === scenario.files["TASK.md"]);
  return { complete: Boolean(entry), callId: read?.call.event.toolCallId, entryId: entry?.id, resultIndex: read?.resultIndex };
}

/** Mechanical edit facts are independent from semantic replacement/merge/deletion safety. */
export function confirmedEdits(actions: GuidanceAction[]) {
  return guidanceExchanges(actions).filter(x => x.call.event.toolName === "nunc_memory_patch").map(x => {
    const id = x.call.event.toolCallId;
    const before = actions.slice(0, x.callIndex).findLast(a => a.event?.type === "memory_state" && a.event.phase === "before" && a.event.toolCallId === id)?.event;
    const after = actions.slice(x.resultIndex + 1).find(a => a.event?.type === "memory_state" && a.event.phase === "after" && a.event.toolCallId === id)?.event;
    const read = guidanceExchanges(actions).findLast(r => r.call.event.toolName === "nunc_memory_read" && r.resultIndex >= 0 && r.resultIndex < x.callIndex && r.result?.isError === false);
    const confirmed = Boolean(x.resultIndex >= 0 && x.result?.isError === false && x.result.details?.ok === true && before && after &&
      before.unconfirmed === false && after.unconfirmed === false && x.call.event.input.expectedRevision === read?.result?.details?.revision &&
      after.revision === x.result.details.revision && Array.isArray(before.slots) && Array.isArray(after.slots));
    return { turn: x.call.turn, toolCallId: id, callIndex: x.callIndex, resultIndex: x.resultIndex, confirmed,
      attempted: x.call.event.input, result: x.result, before, after,
      // Counts identify candidates for review, never preservation of meaning.
      updated: confirmed ? before.slots.filter((s: any) => after.slots.some((t: any) => s.id === t.id && s.text !== t.text)) : [],
      removed: confirmed ? before.slots.filter((s: any) => !after.slots.some((t: any) => s.id === t.id)) : [],
      added: confirmed ? after.slots.filter((s: any) => !before.slots.some((t: any) => s.id === t.id)) : [] };
  });
}

type SetupArgs = [ScenarioInput, Record<string, string[]>, SessionEntry[], SessionEntry[], RolloverObservation[], GuidanceAction[], string, RequestObservation[]?];
const check = (name: string, proven: boolean, observed: unknown): CheckResult => ({ check: name, status: proven ? "PROVEN" : "UNPROVEN", observed });
const semantic = (name: string, observed: unknown): CheckResult => ({ check: name, status: "UNPROVEN", reason: "Independent semantic assessment required; observed effects alone do not establish this meaning.", observed });
function behaviorWork(action: GuidanceAction, cwd: string): boolean {
  return ["write", "edit"].includes(action.event?.toolName) && ["solution.py", "test_solution.py"].some(path => pathIs(cwd, action.event.input?.path, path)) ||
    action.event?.toolName === "bash" && ["tests", "solution"].includes(metricsCommand(action.event.input?.command ?? "") ?? "");
}
function buildSequence(actions: GuidanceAction[], cwd: string) {
  const effects = guidanceExchanges(actions);
  const builds = effects.filter(x => x.call.event.toolName === "bash" && metricsCommand(x.call.event.input?.command ?? "") === "build");
  const failed = builds.find(x => x.result?.isError === true);
  const succeeded = builds.find(x => failed && x.callIndex > failed.resultIndex && x.result?.isError === false);
  const laterWork = effects.find(x => succeeded && x.callIndex > succeeded.resultIndex && x.result?.isError === false &&
    behaviorWork(x.call, cwd));
  return { failedCallId: failed?.call.event.toolCallId, successfulCallId: succeeded?.call.event.toolCallId, laterWorkCallId: laterWork?.call.event.toolCallId };
}

export function taskFileChecks(...[scenario, turns, branch, active, rollovers, actions, cwd, requests = []]: SetupArgs): CheckResult[] {
  const read = taskRead(scenario, branch, actions, cwd);
  const delivered = branch.filter(e => e.type === "message" && e.message.role === "user");
  const ordinary = scenario.turns.length === 1 && delivered.length === 1 && contentText((delivered[0] as any)?.message.content) === scenario.turns[0]!.text;
  const facts = rollovers.map(r => retainedRollover(r, branch, requests, rollovers));
  const first = facts[0], second = facts[1], third = facts[2];
  const thirdRequests = rollovers[2]?.callIds.map(id => requests.find(r => r.callId === id && r.kind === "maintenance")).filter(Boolean) ?? [];
  const records = thirdRequests.flatMap(r => r!.context.messages.flatMap(m => typeof m.content === "string" ? readSourceRecords(m.content) : m.content.flatMap(b => b.type === "text" ? readSourceRecords(b.text) : [])));
  const previousMemory = rollovers[1]?.rebuilt ? project(rollovers[1].rebuilt!).memory.slots : [];
  const maintainedGenerated = previousMemory.length > 0 && records.filter(r => r.source === "F/M").length === 1 &&
    same(records.find(r => r.source === "F/M")?.M, previousMemory);
  const series = Boolean(read.entryId && first?.continued && second?.continued && third?.continued &&
    first.keptEntryIds.includes(read.entryId) && second.retiredEntryIds.includes(read.entryId) &&
    !third.keptEntryIds.includes(read.entryId) && maintainedGenerated);
  const build = buildSequence(actions, cwd);
  return [
    check("TASK.md requirements entered through the sole ordinary user request and a complete persisted read", ordinary && read.complete, { read, deliveredUserIds: delivered.map(e => e.id) }),
    check("Three committed same-task compactions: task read in K, retirement, then maintenance of generated M and actual continuation", series, { facts, maintainedGenerated }),
    check("Observed build failure, successful repair build, then remaining task work in temporal order", Boolean(build.failedCallId && build.successfulCallId && build.laterWorkCallId), build),
    semantic("Input/oracle separation and condition availability versus execution", { deliveredTurns: turns, activeEntryIds: active.map(e => e.id), evidence: "scenario input asset; report.actions, contexts, requests and rollovers" }),
  ];
}

export function activeEditChecks(...[scenario, turns, branch, active, rollovers, actions, cwd, requests = []]: SetupArgs): CheckResult[] {
  const read = taskRead(scenario, branch, actions, cwd), build = buildSequence(actions, cwd), edits = confirmedEdits(actions);
  const facts = rollovers.map(r => retainedRollover(r, branch, requests, rollovers));
  const d = edits.filter(e => e.turn === "d" && e.confirmed);
  const workAfter = d.some(e => guidanceExchanges(actions).some(x => x.callIndex > e.resultIndex && x.result?.isError === false && behaviorWork(x.call, cwd)));
  return [
    check("Task read and build failure/repair observed before continuation", read.complete && Boolean(build.failedCallId && build.successfulCallId), { read, build }),
    semantic("Model-authored saved note mixed resolved progress and unfinished obligations", { notes: edits.filter(e => e.turn === "b"), turnStates: actions.filter(a => a.turn === "b" && a.event?.type === "turn_complete") }),
    check("Two unique committed rollovers supplied generated M/K to subsequent requests", facts.length >= 2 && facts.every(f => f.continued), facts),
    check("Confirmed turn-d memory edit precedes successful task work", d.length > 0 && workAfter, d),
    ...["replacement", "merge", "deletion"].map(op => semantic(`Mixed-note ${op} preserves all remaining obligations`, { edits: d, activeEntryIds: active.map(e => e.id) })),
    semantic("No gold notes or expected patches supplied; setup provenance and source retention assessed independently", { turns, suppliedTurns: scenario.turns }),
  ];
}

export function sourceLossChecks(scenario: ScenarioInput, branch: SessionEntry[], rollovers: RolloverObservation[], actions: GuidanceAction[], cwd: string, unavailable: boolean): CheckResult[] {
  const read = taskRead(scenario, branch, actions, cwd);
  const transition = actions.find(a => a.event?.type === "fixture_state" && a.event.path === "TASK.md" && a.event.removed === true);
  const omissions = rollovers.flatMap(r => r.result?.observations.omissions ?? []).filter(o => o.entryId === read.entryId && o.toolCallId === read.callId);
  const recovery = guidanceExchanges(actions).filter(x => x.call.event.toolName === "read" && pathIs(cwd, x.call.event.input?.path, "source/TASK.md") && x.result?.isError === false && contentText(x.result.content) === scenario.files["TASK.md"]);
  return [check("Task detail was actually omitted from maintenance after a real read and source transition", Boolean(read.complete && transition && omissions.length), { read, transition, omissions }),
    semantic(unavailable ? "Unavailable necessary detail is reported honestly, or remains available in actual M/K" : "Recovery supplies missing detail before dependent work; known conditions remain directly retained", { recoveryCallIds: recovery.map(x => x.call.event.toolCallId), continuationSnapshots: rollovers.map(r => r.snapshot?.id), evidence: "report.actions, requests, rollovers: inspect condition meanings and action order" })];
}

export function scopedTasksChecks(...[scenario, turns, branch, active, rollovers, actions, cwd, requests = []]: SetupArgs): CheckResult[] {
  const read = taskRead(scenario, branch, actions, cwd);
  const effects = guidanceExchanges(actions);
  const archive = effects.find(x => x.call.turn === "a" && ["write", "edit"].includes(x.call.event.toolName) && pathIs(cwd, x.call.event.input?.path, "closeout.json") && x.result?.isError === false);
  const premature = effects.some(x => x.call.turn !== "d" && ["write", "edit"].includes(x.call.event.toolName) && ["east.json", "west.json"].some(p => pathIs(cwd, x.call.event.input?.path, p)));
  const facts = rollovers.map(r => retainedRollover(r, branch, requests, rollovers));
  return [check("Task document read before archive work while service drafts remained pending", Boolean(read.complete && archive && read.resultIndex! < archive.callIndex && !premature), { read, archive, premature }),
    check("Two unique saved rollovers expose then retire the delivered east-only revision", Boolean(facts.length === 2 && facts.every(f => f.continued) && turns.b?.length && turns.b.every(id => facts[0]!.keptEntryIds.includes(id) && !facts[1]!.keptEntryIds.includes(id))), facts),
    semantic("Legitimate archive/west retirement preserves remaining east work across the side question", { activeEntryIds: active.map(e => e.id), evidence: "report.actions, requests and rollovers" })];
}
