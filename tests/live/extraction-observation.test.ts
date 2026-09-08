import { test } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { RolloverObservation } from "../../src/live/comparison-observation.js";
import type { MaintenanceResult } from "../../src/engine/types.js";
import { evaluateE2SetupChecks } from "../../src/live/scenarios.js";

function fixture() {
  const input = { path: "probe.json" };
  const content = [{ type: "text", text: "complete probe result" }];
  const records = [
    { region: "K", entryId: "c-user", messages: [{ role: "user", content: "Correction, then read." }] },
    { region: "K", entryId: "c-call", messages: [{ role: "assistant", content: [{ type: "toolCall", id: "probe", name: "read", arguments: input }] }] },
    { region: "K", entryId: "c-result", messages: [{ role: "toolResult", toolCallId: "probe", toolName: "read", isError: false, content }] },
  ];
  const context = (rows: unknown[]): Context => ({ messages: [{ role: "user", timestamp: 0, content: rows.map(r => ({ type: "text" as const, text: JSON.stringify(r) })) }] });
  const contexts = [
    { turn: "b", kind: "maintenance", context: context([{ region: "B", entryId: "a-user", messages: [{ role: "user", content: "original request" }] }]) },
    { turn: "c", kind: "maintenance", context: context(records) },
  ];
  const actions = [
    { turn: "c", event: { type: "tool_call", toolName: "read", toolCallId: "probe", input } },
    { turn: "c", event: { type: "tool_result", toolName: "read", toolCallId: "probe", isError: false, content } },
  ];
  // Partial maintenance fixtures isolate placement observation; they claim no native execution.
  const maintenance = [{ ok: true }, { ok: true, candidate: { retiredEntryIds: ["b-user"] } }, { ok: true, candidate: { retiredEntryIds: ["c-user", "c-call", "c-result"] } }] as MaintenanceResult[];
  const turns = { a: ["a-user"], b: ["b-user"], c: ["c-user", "c-call", "c-result"] };
  const run = () => evaluateE2SetupChecks(turns, [], [], maintenance, contexts, actions, "/task", "complete probe result");
  return { records, context, contexts, actions, maintenance, turns, run };
}

test("E2 binds complete successful probe exchange to turn c and retirement to the second maintenance", () => {
  const f = fixture();
  assert.equal(f.run()[0]!.status, "PROVEN");
  assert.equal(f.run()[1]!.status, "PROVEN");
  // Semantic slot layout remains a distinct independent judgment.
  assert.equal(f.run()[2]!.status, "PROVEN");
  assert.equal(f.run()[3]!.status, "UNPROVEN");
});

test("E2 rejects wrong source IDs, paths, turns, incomplete exchange and later-only retirement", () => {
  const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.turns.a = ["other-user"]; },
    f => { f.actions[0]!.turn = "a"; },
    f => { f.actions[0]!.event.input!.path = "old-probe.json"; },
    f => { f.actions[1]!.event.isError = true; },
    f => { f.actions[1]!.event.content![0]!.text = "truncated"; f.contexts[1]!.context = f.context(f.records); },
    f => { f.actions[1]!.event.content = [{ type: "text", text: "different result" }]; },
    f => { f.contexts[1]!.context = f.context(f.records.filter(r => r.entryId !== "c-call")); },
    f => { f.maintenance[1] = { ok: true, candidate: { retiredEntryIds: [] } } as unknown as MaintenanceResult; },
    f => { f.maintenance[2] = { ok: true, candidate: { retiredEntryIds: [] } } as unknown as MaintenanceResult; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    assert(f.run().slice(0, 3).some(c => c.status === "UNPROVEN"));
  }
});

function nativeFixture() {
  const f = fixture();
  // Structural observer fixtures only; no provider, memory-quality or host-execution claim.
  const entry = (id: string, message: unknown) => ({ type: "message", id, parentId: null, timestamp: "2026-09-09T00:00:00Z", message }) as SessionEntry;
  const a = [entry("a-user", { role: "user", content: "original request", timestamp: 0 })];
  const b = [entry("b-user", { role: "user", content: "side question", timestamp: 0 })];
  const c = f.records.map(r => entry(r.entryId, { ...r.messages[0], timestamp: 0 }));
  const d = [entry("d-user", { role: "user", content: "another side question", timestamp: 0 })];
  const branch: SessionEntry[] = [...a, ...b, ...c, ...d];
  const row = (turn: string, before: SessionEntry[], kept: SessionEntry[], previous?: SessionEntry) => {
    const snapshot = { type: "compaction", id: `snapshot-${turn}`, parentId: null, timestamp: "2026-09-09T00:00:00Z", firstKeptEntryId: kept[0]!.id, summary: "controlled summary", tokensBefore: 1 } as SessionEntry;
    branch.push(snapshot);
    return { turn, active: [...(previous ? [previous] : []), ...before, ...kept], branch: [...branch], snapshot,
      rebuilt: [snapshot, ...kept], callIds: [branch.length],
      preparation: { firstKeptEntryId: kept[0]!.id, isSplitTurn: false, messagesToSummarize: before.map(e => (e as any).message), turnPrefixMessages: [] } } as unknown as RolloverObservation;
  };
  const first = row("b", a, b), second = row("c", b, c, first.snapshot), third = row("d", c, d, second.snapshot);
  const rows = [first, second, third];
  const run = () => evaluateE2SetupChecks(f.turns, branch, third.rebuilt!, f.maintenance, f.contexts, f.actions, "/task", "complete probe result", rows);
  return { ...f, rows, branch, run };
}
test("native E2 derives all three placements from preparation and persisted boundaries without Nunc carriers", () => {
  const f = nativeFixture(); f.maintenance.length = 0; f.contexts.length = 0;
  assert(f.run().slice(0, 3).every(c => c.status === "PROVEN"));
  assert(f.run().slice(3).every(c => c.status === "UNPROVEN"));
});
test("native E2 rejects mismatched boundaries, source, probe units and late retirement without Nunc fallback", () => {
  const mutations: Array<(f: ReturnType<typeof nativeFixture>) => void> = [
    f => { f.rows.length = 0; },
    f => { f.rows[0]!.snapshot!.fromHook = true; },
    f => { f.rows[0]!.preparation.firstKeptEntryId = "other"; },
    f => { f.rows[0]!.preparation.messagesToSummarize = []; },
    f => { f.rows[1]!.turn = "d"; },
    f => { f.rows[1]!.rebuilt = f.rows[1]!.rebuilt!.filter(e => e.id !== "c-call"); },
    f => { f.rows[1]!.active = f.rows[1]!.active.filter(e => e.id !== "c-call"); },
    f => { f.actions[1]!.event.isError = true; },
    f => { f.actions[1]!.event.content = [{ type: "text", text: "truncated" }]; },
    f => { f.actions[0]!.event.input!.path = "old-probe.json"; },
    f => { f.rows[2]!.rebuilt!.push(f.rows[1]!.active.find(e => e.id === "c-user")!); },
    f => { f.branch.splice(f.branch.findIndex(e => e.id === f.rows[2]!.snapshot!.id), 1); },
  ];
  for (const mutate of mutations) {
    const f = nativeFixture(); mutate(f);
    assert(f.run().slice(0, 3).some(c => c.status === "UNPROVEN"));
  }
});
