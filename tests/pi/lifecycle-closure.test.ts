import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryPatch, preparedSurface } from "./fixtures.js";
import { memoryTokens, messageTokens } from "../../src/engine/accounting.js";

for (const targeted of [false, true]) test(`repeated unchanged-M native compaction confirms the newest checkpoint: targeted=${targeted}`, async t => {
  const notes: string[] = [];
  const { f, context, ctx } = await preparedSurface(t, { bus: bus => bus.on("nunc:diagnostic", value => notes.push((value as { message: string }).message)) });
  f.respond(memoryPatch);
  let firstSummary: string | undefined;
  for (let i = 0; i < 3; i++) {
    f.seed(`turn-${i}`);
    if (targeted) await f.runtime.session.prompt("/nunc compact-for nunc-pi-fixture/small");
    else await f.runtime.session.compact();
    const branch = f.runtime.session.sessionManager.getBranch();
    const saved = branch.findLast(entry => entry.type === "compaction");
    assert(saved?.type === "compaction");
    firstSummary ??= saved.summary;
    assert.equal(saved.summary, firstSummary);
    assert.equal(branch.filter(entry => entry.type === "compaction").length, i + 1);
    const view = context().read(ctx());
    assert.equal(view.lastMaintenance?.native, "saved");
    assert(view.lastMaintenance.after);
    assert.equal(view.lastMaintenance.candidate!.firstKeptEntryId, saved.firstKeptEntryId);
  }
  if (targeted) assert.equal(notes.filter(note => note.includes("Saved compaction for")).length, 3);
});

test("fallback carrier occupancy matches current layout and bound receipt", async t => {
  const { f, context, ctx, admissions } = await preparedSurface(t);
  f.seed();
  const { fauxAssistantMessage } = await import("@earendil-works/pi-ai");
  f.respond(() => fauxAssistantMessage("broken"));
  await f.runtime.session.compact();
  const before = context().read(ctx());
  const fallback = before.current.mechanicalFallback;
  assert(fallback);
  const expected = memoryTokens([], undefined, fallback);
  assert.equal(before.current.layout.memory!.tokens, expected);
  f.respond(() => fauxAssistantMessage("Continued"));
  await f.runtime.session.prompt("Continue");
  const carrier = f.calls.at(-1)!.messages.find(message => JSON.stringify(message).includes("Nunc Mechanical Roll Fallback"));
  assert(carrier);
  assert.equal(messageTokens(carrier), expected);
  await f.runtime.session.prompt("Continue again");
  const receipt = admissions.findLast(row => row.receiptBreakdown);
  assert.equal(receipt?.receiptBreakdown?.currentMTokens, expected);
  assert.equal(receipt?.receiptBreakdown?.oldMTokensEstimate, expected);
  assert.equal(context().read(ctx()).lastMain!.layout.memory!.tokens, expected);
});
