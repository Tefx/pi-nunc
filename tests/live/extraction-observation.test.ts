import { test } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "@earendil-works/pi-ai";
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
  const maintenance = [{ ok: true }, { ok: true, candidate: { retiredEntryIds: ["b-user"] } }] as MaintenanceResult[];
  const turns = { a: ["a-user"], b: ["b-user"], c: ["c-user", "c-call", "c-result"] };
  const run = () => evaluateE2SetupChecks(turns, [], [], maintenance, contexts, actions, "/task", "complete probe result");
  return { records, context, contexts, actions, maintenance, turns, run };
}

test("E2 binds complete successful probe exchange to turn c and retirement to the second maintenance", () => {
  const f = fixture();
  assert.equal(f.run()[0]!.status, "PROVEN");
  assert.equal(f.run()[1]!.status, "PROVEN");
  // Semantic slot layout remains a distinct independent judgment.
  assert.equal(f.run()[2]!.status, "UNPROVEN");
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
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    assert(f.run().slice(0, 2).some(c => c.status === "UNPROVEN"));
  }
});
