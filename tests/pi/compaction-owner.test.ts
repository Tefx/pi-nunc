import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixtures.js";

test("later compaction owner result wins; cancel skips later handlers", async t => {
  const order: string[] = [];
  let keptId = "";
  const lastWins = await fixture({ extras: [
    { name: "compact-a", factory(pi) { pi.on("session_before_compact", async () => { order.push("a"); return { compaction: { summary: "A", firstKeptEntryId: keptId, tokensBefore: 1 } }; }); } },
    { name: "compact-b", factory(pi) { pi.on("session_before_compact", async () => { order.push("b"); return { compaction: { summary: "B", firstKeptEntryId: keptId, tokensBefore: 1 } }; }); } },
  ] });
  t.after(() => lastWins.close());
  keptId = lastWins.seed().kept;
  await lastWins.runtime.session.compact();
  assert.deepEqual(order, ["a", "b"]);
  const lastSummary = lastWins.runtime.session.sessionManager.getBranch().filter(e => e.type === "compaction").at(-1);
  assert.equal(lastSummary?.type, "compaction");
  assert.equal(lastSummary.type === "compaction" ? lastSummary.summary : undefined, "B");

  order.length = 0;
  const cancelled = await fixture({ extras: [
    { name: "compact-cancel", factory(pi) { pi.on("session_before_compact", async () => { order.push("cancel"); return { cancel: true }; }); } },
    { name: "compact-later", factory(pi) { pi.on("session_before_compact", async () => { order.push("later"); return { compaction: { summary: "later", firstKeptEntryId: "synthetic", tokensBefore: 1 } }; }); } },
  ] });
  t.after(() => cancelled.close());
  cancelled.seed();
  await assert.rejects(() => cancelled.runtime.session.compact(), /cancelled/i);
  assert.deepEqual(order, ["cancel"]);
  assert.equal(cancelled.runtime.session.sessionManager.getBranch().filter(e => e.type === "compaction").length, 0);
});
