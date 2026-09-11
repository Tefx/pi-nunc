import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai";
import { renderMemory } from "../../src/engine/memory.js";
import { checkFullExtraction } from "../../src/live/scenarios.js";

const memory = (text: string) => ({ version: 1 as const, slots: [{ id: "s1", text }], nextId: 2 });
// Independent known user records: no project()/extractionContext() call supplies
// either the expected M or B/K to the checker under test.
function contextFor(entries: SessionEntry[], slots: Array<{ id: string; text: string }>): Context {
  const visible = entries.filter(e => e.type === "message" && e.message.role === "user");
  return { messages: [{ role: "user", timestamp: 0, content: [
    { type: "text", text: JSON.stringify({ source: "F/M", F: { systemPrompt: "", tools: [] }, M: slots, omissions: [] }) },
    ...visible.map((e, i) => {
      assert(e.type === "message" && e.message.role === "user");
      return { type: "text" as const, text: JSON.stringify({ region: i === visible.length - 1 ? "K" : "B", entryId: e.id, messages: [{ role: "user", content: e.message.content }] }) };
    }),
  ] }] };
}

test("full extraction selects first/later manual M, checkpoint M over kept old carriers, and selected post-checkpoint revision", () => {
  const sm = SessionManager.inMemory();
  sm.appendMessage({ role: "user", content: "Original obligation.", timestamp: 1 });
  const initial = memory("first manual save");
  sm.appendCustomEntry("nunc.memory", { nunc: initial });
  const check = (expected: ReturnType<typeof memory>, stale?: ReturnType<typeof memory>) => {
    const active = sm.buildContextEntries();
    assert.equal(checkFullExtraction(active, contextFor(active, expected.slots)).status, "PROVEN");
    for (const wrong of [[], [{ id: "s1", text: "wrong" }], [{ id: "wrong-id", text: expected.slots[0]!.text }], ...(stale ? [stale.slots] : [])]) {
      assert.equal(checkFullExtraction(active, contextFor(active, wrong)).status, "UNPROVEN");
    }
  };
  check(initial);
  const kept = sm.appendMessage({ role: "user", content: "Keep this actual suffix.", timestamp: 2 });
  const newer = memory("newer manual save before compaction");
  const oldCarrier = sm.appendCustomEntry("nunc.memory", { nunc: newer });
  check(newer, initial);

  const checkpoint = memory("checkpoint replaces pre-compaction manual notes");
  sm.appendCompaction(renderMemory(checkpoint.slots), kept, 100, { nunc: checkpoint }, true);
  assert(sm.buildContextEntries().some(e => e.id === oldCarrier), "native kept range contains obsolete manual carrier");
  check(checkpoint, newer);

  sm.appendMessage({ role: "user", content: "New instruction after checkpoint.", timestamp: 3 });
  const updated = memory("manual update after checkpoint");
  const selectedLeaf = sm.appendCustomEntry("nunc.memory", { nunc: updated });
  check(updated, checkpoint);
  const latest = memory("another manual revision after checkpoint");
  sm.appendCustomEntry("nunc.memory", { nunc: latest });
  check(latest, updated);
  sm.branch(selectedLeaf);
  check(updated, latest); // A newer off-path save does not belong to selected M.
});

test("full extraction independently rejects missing/duplicate M and missing/reordered/altered B/K", () => {
  const sm = SessionManager.inMemory();
  sm.appendMessage({ role: "user", content: "Retiring source.", timestamp: 1 });
  const saved = memory("actual manual note");
  sm.appendCustomEntry("nunc.memory", { nunc: saved });
  sm.appendMessage({ role: "user", content: "Retained source.", timestamp: 2 });
  const active = sm.buildContextEntries(), good = contextFor(active, saved.slots);
  const mutate = (change: (blocks: any[]) => void) => {
    const context = structuredClone(good);
    const blocks = context.messages[0]!.content as any[];
    change(blocks);
    assert.equal(checkFullExtraction(active, context).status, "UNPROVEN");
  };
  assert.equal(checkFullExtraction(active, good).status, "PROVEN");
  assert.equal(checkFullExtraction(active, undefined).status, "UNPROVEN");
  mutate(b => { b.shift(); });
  mutate(b => { b.push(structuredClone(b[0])); });
  mutate(b => { b.splice(1, 1); });
  mutate(b => { b.splice(2, 1); });
  mutate(b => { [b[1], b[2]] = [b[2], b[1]]; });
  mutate(b => { const record = JSON.parse(b[1].text); record.messages[0].content = "Changed source."; b[1].text = JSON.stringify(record); });
});
