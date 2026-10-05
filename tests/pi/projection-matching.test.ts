import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ToolResultDecision } from "../../src/engine/types.js";
import { carrierIndexIn, clearMemoryAnchors, peekMemoryAnchor, withEffectiveMemory } from "../../src/pi/projection.js";

const memory = { version: 1 as const, nextId: 2, slots: [{ id: "s1", text: "Keep the task constraint." }] };
const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });
function source(id: string, message: Extract<SessionEntry, { type: "message" }>["message"]): SessionEntry {
  return { type: "message", id, parentId: null, timestamp: "2026-01-01", message };
}

test("projection indexes reuse normalized representations instead of serializing every message pair", () => {
  clearMemoryAnchors();
  let serializations = 0;
  const messages = Array.from({ length: 300 }, (_, index) => ({ ...user(`${index}:` + "detail ".repeat(200)),
    toJSON() { serializations++; return { role: this.role, content: this.content, timestamp: this.timestamp }; },
  }));
  const entries = messages.map((message, index) => source(String(index), message));
  const result = withEffectiveMemory(messages, memory, { sessionId: "indexed-scale", entries, decisions: [] });
  assert.equal(carrierIndexIn(result), messages.length);
  assert.deepEqual(result.slice(0, -1), messages);
  assert.deepEqual(peekMemoryAnchor("indexed-scale")?.prefixEntryIds, entries.map(item => item.id));
  assert(serializations <= 6 * messages.length, `Expected bounded per-message serialization, observed ${serializations}`);
});

test("object field order preserves source equality and anchor reuse", () => {
  clearMemoryAnchors();
  const message = { role: "user" as const, content: [{ type: "text" as const, text: "original" }], timestamp: 1 };
  const hook = { timestamp: 1, content: [{ text: "original", type: "text" as const }], role: "user" as const };
  const session = { sessionId: "key-order", entries: [source("one", message)] };
  withEffectiveMemory([hook], memory, session);
  const next = withEffectiveMemory([hook, user("later")], memory, session);
  assert.equal(carrierIndexIn(next), 1);
  assert.deepEqual(next.filter((_, index) => index !== 1), [hook, user("later")]);
});

test("duplicate source units and repeated hook positions never establish a reusable boundary", () => {
  for (const repeatedSource of [true, false]) {
    clearMemoryAnchors();
    const original = user("same");
    const entries = repeatedSource ? [source("one", original), source("two", { timestamp: 1, content: "same", role: "user" })] : [source("one", original)];
    const hook = repeatedSource ? [original] : [original, structuredClone(original)];
    const session = { sessionId: "duplicates", entries };
    withEffectiveMemory(hook, memory, session);
    assert.deepEqual(peekMemoryAnchor(session.sessionId)?.prefixEntryIds, []);
    const next = withEffectiveMemory([...hook, user("later")], memory, session);
    assert.equal(carrierIndexIn(next), hook.length + 1);
  }
});

test("a foreign in-place rewrite cannot reuse a cached source correspondence across projections", () => {
  clearMemoryAnchors();
  const original = user("original");
  const hook = structuredClone(original);
  const session = { sessionId: "mutable-hook", entries: [source("one", original)] };
  withEffectiveMemory([hook], memory, session);
  hook.content = "foreign rewrite";
  const next = withEffectiveMemory([hook, user("later")], memory, session);
  assert.equal(carrierIndexIn(next), 2);
  assert.equal(next[0], hook);
  assert.equal(next[0]?.content, "foreign rewrite");
});

test("own cleanup replacement is restored when disabled and applied again without rewriting foreign content", () => {
  clearMemoryAnchors();
  const original = { role: "toolResult" as const, toolCallId: "call", toolName: "read", content: [{ type: "text" as const, text: "full original body" }], isError: false, timestamp: 1 };
  const decision: ToolResultDecision = { entryId: "result", messageIndex: 0, toolCallId: "call", toolName: "read", kind: "semantic", action: "replace", text: "short", originalLength: 18, cleanedLength: 5, netSavings: 13 };
  const session = { sessionId: "cleanup-index", entries: [source("result", original)], decisions: [decision], enabled: true };
  const cleaned = withEffectiveMemory([original], memory, session);
  assert.deepEqual(cleaned[0]?.content, [{ type: "text", text: "short" }]);
  const restored = withEffectiveMemory(cleaned, memory, { ...session, enabled: false });
  assert.deepEqual(restored[0], original);
  const reapplied = withEffectiveMemory(restored, memory, session);
  assert.deepEqual(reapplied[0], cleaned[0]);
  const foreign = { ...original, content: [{ type: "text" as const, text: "foreign rewrite" }] };
  const retained = withEffectiveMemory([foreign], memory, session);
  assert.equal(retained[0], foreign);
});
