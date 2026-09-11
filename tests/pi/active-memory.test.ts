import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall, type Model, type Provider } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { type ExtensionAPI, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { memoryMessage, renderMemory, emptyMemory } from "../../src/engine/memory.js";
import { memoryTokens } from "../../src/engine/accounting.js";
import { project } from "../../src/pi/projection.js";
import { memorySurface, type MemorySurface } from "../../src/pi/manual.js";
import type { AdmissionObservation } from "../../src/pi/admission.js";
import { fixture, memoryPatch } from "./fixtures.js";

function mains(observations: AdmissionObservation[]) {
  return observations.filter(o => o.kind === "main");
}

test("flag --nunc-memory-tools exposes nunc_memory_read and nunc_memory_patch; default off leaves toolset untouched", async t => {
  // Default off
  const fDefault = await fixture();
  t.after(() => fDefault.close());
  const defaultTools = fDefault.runtime.session.getAllTools();
  assert(!defaultTools.some(tool => tool.name === "nunc_memory_read"), "nunc_memory_read must not be exposed by default");
  assert(!defaultTools.some(tool => tool.name === "nunc_memory_patch"), "nunc_memory_patch must not be exposed by default");

  // Enabled via flag
  const fEnabled = await fixture({
    flagValues: [["nunc-memory-tools", "true"]],
  });
  t.after(() => fEnabled.close());
  const enabledTools = fEnabled.runtime.session.getAllTools();
  assert(enabledTools.some(tool => tool.name === "nunc_memory_read"), "nunc_memory_read must be exposed when flag is true");
  assert(enabledTools.some(tool => tool.name === "nunc_memory_patch"), "nunc_memory_patch must be exposed when flag is true");
});

test("nunc_memory_read returns detached snapshot with revision, slots, budget, and writable status without side effects", async t => {
  let ctxRef: ExtensionContext | undefined;
  const f = await fixture({
    flagValues: [["nunc-memory-tools", "true"]],
    extras: [{
      name: "capture-ctx",
      factory(pi) {
        pi.on("session_start", (_event, ctx) => { ctxRef = ctx; });
      },
    }],
  });
  t.after(() => f.close());

  assert(ctxRef);
  const readTool = (f.runtime.session as any).getToolDefinition("nunc_memory_read");
  assert(readTool);

  const entriesBefore = f.runtime.session.sessionManager.getEntries().length;
  const result = await readTool.execute("call-read-1", {}, undefined, undefined, ctxRef);
  assert(result);
  assert.equal(result.isError, undefined);
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(typeof parsed.revision, "string");
  assert(Array.isArray(parsed.slots));
  assert.equal(parsed.slots.length, 0);
  assert.equal(parsed.writable, true);
  assert.equal(parsed.budget.usedTokens, 0);
  assert(typeof parsed.budget.limitTokens === "number");

  // Read does not add entries or call models
  assert.equal(f.runtime.session.sessionManager.getEntries().length, entriesBefore);
  assert.equal(f.faux.state.callCount, 0);
});

test("nunc_memory_patch executes atomic add, update, remove, and enforces unique keys and existence", async t => {
  let ctxRef: ExtensionContext | undefined;
  const f = await fixture({
    flagValues: [["nunc-memory-tools", "true"]],
    extras: [{
      name: "capture-ctx",
      factory(pi) {
        pi.on("session_start", (_event, ctx) => { ctxRef = ctx; });
      },
    }],
  });
  t.after(() => f.close());

  assert(ctxRef);
  const readTool = (f.runtime.session as any).getToolDefinition("nunc_memory_read");
  const patchTool = (f.runtime.session as any).getToolDefinition("nunc_memory_patch");
  assert(readTool && patchTool);

  // 1. Initial read
  const read1 = JSON.parse((await readTool.execute("c1", {}, undefined, undefined, ctxRef)).content[0].text);

  // 2. Add two notes
  const patch1Result = await patchTool.execute("c2", {
    expectedRevision: read1.revision,
    add: [
      { key: "alpha", text: "Alpha note content" },
      { key: "beta", text: "Beta note content" },
    ],
  }, undefined, undefined, ctxRef);
  assert.equal(patch1Result.isError, undefined);
  const patch1Data = JSON.parse(patch1Result.content[0].text);
  assert.equal(patch1Data.ok, true);
  assert.equal(patch1Data.added.alpha, "s1");
  assert.equal(patch1Data.added.beta, "s2");

  // Verify memory via read
  const read2 = JSON.parse((await readTool.execute("c3", {}, undefined, undefined, ctxRef)).content[0].text);
  assert.equal(read2.slots.length, 2);
  assert.equal(read2.slots[0].id, "s1");
  assert.equal(read2.slots[0].text, "Alpha note content");
  assert.equal(read2.slots[1].id, "s2");
  assert.equal(read2.slots[1].text, "Beta note content");

  // 3. Update s1 and remove s2 and add gamma in one atomic patch
  const patch2Result = await patchTool.execute("c4", {
    expectedRevision: read2.revision,
    update: [{ id: "s1", text: "Updated alpha note" }],
    remove: ["s2"],
    add: [{ key: "gamma", text: "Gamma note content" }],
  }, undefined, undefined, ctxRef);
  assert.equal(patch2Result.isError, undefined);
  const patch2Data = JSON.parse(patch2Result.content[0].text);
  assert.equal(patch2Data.ok, true);
  assert.equal(patch2Data.added.gamma, "s3");

  const read3 = JSON.parse((await readTool.execute("c5", {}, undefined, undefined, ctxRef)).content[0].text);
  assert.equal(read3.slots.length, 2);
  assert.equal(read3.slots[0].id, "s1");
  assert.equal(read3.slots[0].text, "Updated alpha note");
  assert.equal(read3.slots[1].id, "s3");
  assert.equal(read3.slots[1].text, "Gamma note content");

  // 4. Stale revision must conflict
  const staleConflict = await patchTool.execute("c6", {
    expectedRevision: read1.revision,
    update: [{ id: "s1", text: "Stale edit" }],
  }, undefined, undefined, ctxRef);
  assert.equal(staleConflict.isError, true);
  const conflictData = JSON.parse(staleConflict.content[0].text);
  assert.equal(conflictData.ok, false);
  assert.equal(conflictData.code, "conflict");
  assert.equal(conflictData.recovery.revision, read3.revision);

  // 5. Atomic failure on invalid update target: nothing is committed, nextId not consumed
  const badUpdate = await patchTool.execute("c7", {
    expectedRevision: read3.revision,
    update: [{ id: "nonexistent", text: "Bad" }],
    add: [{ key: "delta", text: "Should not be added" }],
  }, undefined, undefined, ctxRef);
  assert.equal(badUpdate.isError, true);
  const badUpdateData = JSON.parse(badUpdate.content[0].text);
  assert.equal(badUpdateData.code, "invalid");

  // Verify next add uses s4, not s5 (no ID leaked)
  const patch3Result = await patchTool.execute("c8", {
    expectedRevision: read3.revision,
    add: [{ key: "delta", text: "Delta valid note" }],
  }, undefined, undefined, ctxRef);
  assert.equal(patch3Result.isError, undefined);
  const patch3Data = JSON.parse(patch3Result.content[0].text);
  assert.equal(patch3Data.added.delta, "s4");

  // 6. Conflicting update and remove of same ID in one batch fails atomically
  const read4 = JSON.parse((await readTool.execute("c9", {}, undefined, undefined, ctxRef)).content[0].text);
  const conflictBatch = await patchTool.execute("c10", {
    expectedRevision: read4.revision,
    update: [{ id: "s1", text: "Conflicting update" }],
    remove: ["s1"],
  }, undefined, undefined, ctxRef);
  assert.equal(conflictBatch.isError, true);
  const conflictBatchData = JSON.parse(conflictBatch.content[0].text);
  assert.equal(conflictBatchData.code, "invalid");

  // 7. Duplicate add keys fail atomically
  const dupAdd = await patchTool.execute("c11", {
    expectedRevision: read4.revision,
    add: [
      { key: "same", text: "first" },
      { key: "same", text: "second" },
    ],
  }, undefined, undefined, ctxRef);
  assert.equal(dupAdd.isError, true);
  assert.equal(JSON.parse(dupAdd.content[0].text).code, "invalid");

  // 8. Key colliding with existing slot ID fails atomically
  const collideKey = await patchTool.execute("c12", {
    expectedRevision: read4.revision,
    add: [{ key: "s1", text: "collides with existing slot s1" }],
  }, undefined, undefined, ctxRef);
  assert.equal(collideKey.isError, true);
  assert.equal(JSON.parse(collideKey.content[0].text).code, "invalid");

  // 9. Explicit remove of all slots empties memory
  const clearAll = await patchTool.execute("c13", {
    expectedRevision: read4.revision,
    remove: ["s1", "s3", "s4"],
  }, undefined, undefined, ctxRef);
  assert.equal(clearAll.isError, undefined);
  const readEmpty = JSON.parse((await readTool.execute("c14", {}, undefined, undefined, ctxRef)).content[0].text);
  assert.equal(readEmpty.slots.length, 0);
  assert.equal(readEmpty.budget.usedTokens, 0);
});

test("no-op patch does not append entry, bump revision, or invalidate receipt", async t => {
  let ctxRef: ExtensionContext | undefined;
  const admissions: AdmissionObservation[] = [];
  const f = await fixture({
    flagValues: [["nunc-memory-tools", "true"]],
    extras: [{
      name: "capture-ctx",
      factory(pi) {
        pi.on("session_start", (_event, ctx) => { ctxRef = ctx; });
        pi.events.on("nunc:admission", val => admissions.push(val as AdmissionObservation));
      },
    }],
  });
  t.after(() => f.close());

  assert(ctxRef);
  const readTool = (f.runtime.session as any).getToolDefinition("nunc_memory_read");
  const patchTool = (f.runtime.session as any).getToolDefinition("nunc_memory_patch");

  // Add one slot
  const read1 = JSON.parse((await readTool.execute("c1", {}, undefined, undefined, ctxRef)).content[0].text);
  await patchTool.execute("c2", {
    expectedRevision: read1.revision,
    add: [{ key: "k1", text: "Initial slot" }],
  }, undefined, undefined, ctxRef);

  // Send request to establish receipt
  await f.runtime.session.prompt("Establish receipt");
  const read2 = JSON.parse((await readTool.execute("c3", {}, undefined, undefined, ctxRef)).content[0].text);
  const entriesBefore = f.runtime.session.sessionManager.getEntries().length;

  // Execute no-op patch (update with identical text)
  const noopResult = await patchTool.execute("c4", {
    expectedRevision: read2.revision,
    update: [{ id: "s1", text: "Initial slot" }],
  }, undefined, undefined, ctxRef);
  assert.equal(noopResult.isError, undefined);
  const noopData = JSON.parse(noopResult.content[0].text);
  assert.equal(noopData.ok, true);
  assert.equal(noopData.revision, read2.revision);
  assert.equal(f.runtime.session.sessionManager.getEntries().length, entriesBefore);

  // Follow-up request must still reuse receipt
  await f.runtime.session.prompt("Follow-up after noop");
  const last = mains(admissions).at(-1);
  assert.equal(last?.estimator, "pi-usage-backed");
  assert.equal(last?.estimateReason, "matching-receipt");
});

test("budget constraints: unknown budget blocks growth, overbudget blocks growth but permits shrinking", async t => {
  let ctxRef: ExtensionContext | undefined;
  const f = await fixture({
    config: { memory: { maxTokens: 100 } },
    flagValues: [["nunc-memory-tools", "true"]],
    extras: [{
      name: "capture-ctx",
      factory(pi) {
        pi.on("session_start", (_event, ctx) => { ctxRef = ctx; });
      },
    }],
  });
  t.after(() => f.close());

  assert(ctxRef);
  const readTool = (f.runtime.session as any).getToolDefinition("nunc_memory_read");
  const patchTool = (f.runtime.session as any).getToolDefinition("nunc_memory_patch");

  const read1 = JSON.parse((await readTool.execute("c1", {}, undefined, undefined, ctxRef)).content[0].text);

  // 1. Overbudget growth fails
  const overgrowth = await patchTool.execute("c2", {
    expectedRevision: read1.revision,
    add: [{ key: "giant", text: "word ".repeat(500) }],
  }, undefined, undefined, ctxRef);
  assert.equal(overgrowth.isError, true);
  const overData = JSON.parse(overgrowth.content[0].text);
  assert.equal(overData.code, "overbudget");

  // 2. Modest fit succeeds
  const fitResult = await patchTool.execute("c3", {
    expectedRevision: read1.revision,
    add: [{ key: "fit", text: "A modest note" }],
  }, undefined, undefined, ctxRef);
  assert.equal(fitResult.isError, undefined);
  const read2 = JSON.parse((await readTool.execute("c4", {}, undefined, undefined, ctxRef)).content[0].text);

  // 3. Shrinking overbudget memory: reducing edit must succeed
  const shrinkResult = await patchTool.execute("c5", {
    expectedRevision: read2.revision,
    update: [{ id: "s1", text: "Tiny" }],
  }, undefined, undefined, ctxRef);
  assert.equal(shrinkResult.isError, undefined);
  const read3 = JSON.parse((await readTool.execute("c6", {}, undefined, undefined, ctxRef)).content[0].text);
  assert.equal(read3.slots[0].text, "Tiny");
});

test("freeze to native terminal mutual exclusion: patch rejected while maintenance active", async t => {
  let ctxRef: ExtensionContext | undefined;
  let surfaceRef: MemorySurface | undefined;
  let patchDuringFreezeResult: any;
  const f = await fixture({
    flagValues: [["nunc-memory-tools", "true"]],
    extras: [{
      name: "capture-ctx",
      factory(pi) {
        pi.on("session_start", (_event, ctx) => { ctxRef = ctx; });
        surfaceRef = memorySurface(pi);
        pi.on("session_before_compact", (_event, ctx) => {
          if (!surfaceRef) return;
          const view = surfaceRef.read(ctx);
          patchDuringFreezeResult = surfaceRef.patch(ctx, {
            expectedRevision: view.revision,
            add: [{ key: "frozen", text: "Should be rejected" }],
          });
        });
      },
    }],
  });
  t.after(() => f.close());

  assert(ctxRef && surfaceRef);
  f.seed();
  f.respond(memoryPatch);

  await f.runtime.session.compact();
  assert(patchDuringFreezeResult);
  assert.equal(patchDuringFreezeResult.ok, false);
  assert.equal(patchDuringFreezeResult.code, "occupied");

  // After maintenance completes, freeze is unlocked and patch succeeds
  const viewAfter = surfaceRef.read(ctxRef);
  const patchAfter = surfaceRef.patch(ctxRef, {
    expectedRevision: viewAfter.revision,
    add: [{ key: "unfrozen", text: "Successfully added" }],
  });
  assert.equal(patchAfter.ok, true);
});

test("four receipt formula cases: empty->empty, empty->nonempty, nonempty->empty, nonempty->nonempty", async t => {
  const admissions: AdmissionObservation[] = [];
  let surfaceRef: MemorySurface | undefined;
  let ctxRef: ExtensionContext | undefined;
  const f = await fixture({
    flagValues: [["nunc-memory-tools", "true"]],
    extras: [{
      name: "watch-admission",
      factory(pi) {
        pi.events.on("nunc:admission", val => admissions.push(val as AdmissionObservation));
        pi.on("session_start", (_event, ctx) => { ctxRef = ctx; });
        surfaceRef = memorySurface(pi);
      },
    }],
  });
  t.after(() => f.close());

  assert(surfaceRef && ctxRef);

  // Case 1: Empty -> Empty
  await f.runtime.session.prompt("Turn 1: Empty M establishing");
  const call1 = f.calls.at(-1)!;
  assert(!call1.messages.some(m => JSON.stringify(m).includes("Nunc working memory")));
  const adm1 = mains(admissions).at(-1)!;
  assert.equal(adm1.estimator, "pi-heuristic");

  // Next turn with empty M: uses receipt, no M term
  await f.runtime.session.prompt("Turn 2: Empty M repeat");
  const call2 = f.calls.at(-1)!;
  assert(!call2.messages.some(m => JSON.stringify(m).includes("Nunc working memory")));
  const adm2 = mains(admissions).at(-1)!;
  assert.equal(adm2.estimator, "pi-usage-backed");
  assert.equal(adm2.estimateReason, "matching-receipt");
  assert.equal(adm2.receiptBreakdown?.currentMTokens, 0);
  assert.equal(adm2.receiptBreakdown?.retainedOldMMargin, false);

  // Case 2: Empty -> Non-empty
  const view1 = surfaceRef.read(ctxRef);
  const addRes = surfaceRef.patch(ctxRef, {
    expectedRevision: view1.revision,
    add: [{ key: "note1", text: "First working note" }],
  });
  assert.equal(addRes.ok, true);

  await f.runtime.session.prompt("Turn 3: Non-empty M from empty old M");
  const call3 = f.calls.at(-1)!;
  const tail3 = call3.messages.at(-1)!;
  assert(JSON.stringify(tail3).includes("Nunc working memory (session-local, reference only)"));
  assert(JSON.stringify(tail3).includes("First working note"));
  assert(!JSON.stringify(call3.messages[0]).includes("The conversation history before this point was compacted"));

  const adm3 = mains(admissions).at(-1)!;
  assert.equal(adm3.estimator, "pi-usage-backed");
  assert.equal(adm3.estimateReason, "matching-receipt");
  assert(adm3.receiptBreakdown?.currentMTokens! > 0);
  assert.equal(adm3.receiptBreakdown?.retainedOldMMargin, false);

  // Case 4: Non-empty -> Non-empty (modified M)
  const view2 = surfaceRef.read(ctxRef);
  const modRes = surfaceRef.patch(ctxRef, {
    expectedRevision: view2.revision,
    update: [{ id: "s1", text: "Updated working note text" }],
  });
  assert.equal(modRes.ok, true);

  await f.runtime.session.prompt("Turn 4: Non-empty M modified");
  const call4 = f.calls.at(-1)!;
  const tail4 = call4.messages.at(-1)!;
  assert(JSON.stringify(tail4).includes("Updated working note text"));
  const adm4 = mains(admissions).at(-1)!;
  assert.equal(adm4.estimator, "pi-usage-backed");
  assert.equal(adm4.estimateReason, "matching-receipt");
  assert(adm4.receiptBreakdown?.currentMTokens! > 0);
  assert.equal(adm4.receiptBreakdown?.retainedOldMMargin, true);

  // Case 3: Non-empty -> Empty
  const view3 = surfaceRef.read(ctxRef);
  const delRes = surfaceRef.patch(ctxRef, {
    expectedRevision: view3.revision,
    remove: ["s1"],
  });
  assert.equal(delRes.ok, true);

  await f.runtime.session.prompt("Turn 5: Non-empty M to empty M");
  const call5 = f.calls.at(-1)!;
  assert(!call5.messages.some(m => JSON.stringify(m).includes("Nunc working memory")));
  const adm5 = mains(admissions).at(-1)!;
  assert.equal(adm5.estimator, "pi-usage-backed");
  assert.equal(adm5.estimateReason, "matching-receipt");
  assert.equal(adm5.receiptBreakdown?.currentMTokens, 0);
  assert.equal(adm5.receiptBreakdown?.retainedOldMMargin, true);
});

test("tail layout: single F->R->M layout, no compactionSummary wrapper, R tool calls and results preserved", async t => {
  let toolCalls = 0;
  let surfaceRef: MemorySurface | undefined;
  let ctxRef: ExtensionContext | undefined;
  const f = await fixture({
    flagValues: [["nunc-memory-tools", "true"]],
    extras: [{
      name: "capture",
      factory(pi) {
        pi.on("session_start", (_event, ctx) => { ctxRef = ctx; });
        surfaceRef = memorySurface(pi);
      },
    }],
    tools: [{
      name: "calc",
      label: "calc",
      description: "perform calculation",
      parameters: Type.Object({ expr: Type.String() }),
      execute: async (_id, args: any) => {
        toolCalls++;
        return { content: [{ type: "text" as const, text: `result of ${args.expr}` }], details: {} };
      },
    }],
  });
  t.after(() => f.close());

  assert(surfaceRef && ctxRef);
  const v = surfaceRef.read(ctxRef);
  surfaceRef.patch(ctxRef, { expectedRevision: v.revision, add: [{ key: "k", text: "Persistent note" }] });

  f.respond((context) => {
    if (context.messages.some(m => m.role === "toolResult")) {
      return fauxAssistantMessage("Tool completed.");
    }
    return fauxAssistantMessage(fauxToolCall("calc", { expr: "1+1" }, { id: "c1" }), { stopReason: "toolUse" });
  });

  await f.runtime.session.prompt("Calculate 1+1");
  assert.equal(toolCalls, 1);
  assert.equal(f.calls.length, 2);

  const contCall = f.calls[1]!;
  const msgs = contCall.messages;

  // 1. First message must be User message ("Calculate 1+1"), NOT compactionSummary or memory
  assert.equal(msgs[0]?.role, "user");
  assert(JSON.stringify(msgs[0]?.content).includes("Calculate 1+1"));

  // 2. Assistant tool call message preserved
  const assistantCall = msgs.find(m => m.role === "assistant");
  assert(assistantCall);

  // 3. Tool result preserved
  const toolRes = msgs.find(m => m.role === "toolResult");
  assert(toolRes);

  // 4. Memory carrier is at the TAIL (last message)
  const lastMsg = msgs.at(-1)!;
  assert.equal(lastMsg.role, "user");
  assert(JSON.stringify(lastMsg.content).includes("Nunc working memory (session-local, reference only)"));
  assert(JSON.stringify(lastMsg.content).includes("Persistent note"));

  // 5. No compactionSummary anywhere in the request
  assert(!msgs.some(m => (m as any).role === "compactionSummary"));
  assert(!msgs.some(m => JSON.stringify(m).includes("The conversation history before this point was compacted")));
});

test("idempotent conversion: old checkpoint with compactionSummary is converted to tail M without rewriting JSONL", async t => {
  const f = await fixture();
  t.after(() => f.close());

  f.seed();
  f.respond(memoryPatch);
  await f.runtime.session.compact();

  // Inspect session JSONL: compaction entry exists on disk
  const entries = f.runtime.session.sessionManager.getEntries();
  const comp = entries.find(e => e.type === "compaction");
  assert(comp);
  const entriesCountBefore = entries.length;

  // Next prompt: Nunc converts context to tail M
  f.respond(() => fauxAssistantMessage("Acknowledged."));
  await f.runtime.session.prompt("Prompt 1 after compact");

  const call1 = f.calls.at(-1)!;
  assert(!call1.messages.some(m => (m as any).role === "compactionSummary"));
  assert(!JSON.stringify(call1.messages).includes("The conversation history before this point was compacted"));
  const tail1 = call1.messages.at(-1)!;
  assert(JSON.stringify(tail1).includes("Nunc working memory (session-local, reference only)"));

  // Second prompt: must still idempotently convert (cannot skip via migrationDone)
  await f.runtime.session.prompt("Prompt 2 after compact");
  const call2 = f.calls.at(-1)!;
  assert(!call2.messages.some(m => (m as any).role === "compactionSummary"));
  assert(!JSON.stringify(call2.messages).includes("The conversation history before this point was compacted"));
  const tail2 = call2.messages.at(-1)!;
  assert(JSON.stringify(tail2).includes("Nunc working memory (session-local, reference only)"));

  // Verify JSONL was NOT rewritten
  const entriesCountAfter = f.runtime.session.sessionManager.getEntries().length;
  assert.equal(entriesCountAfter, entriesCountBefore + 4);
});

test("unrelated message progression on same path does not conflict, while real M update or fork conflicts", async t => {
  let ctxRef: ExtensionContext | undefined;
  let surfaceRef: MemorySurface | undefined;
  const f = await fixture({
    flagValues: [["nunc-memory-tools", "true"]],
    extras: [{
      name: "capture",
      factory(pi) {
        pi.on("session_start", (_event, ctx) => { ctxRef = ctx; });
        surfaceRef = memorySurface(pi);
      },
    }],
  });
  t.after(() => f.close());

  assert(surfaceRef && ctxRef);
  const v1 = surfaceRef.read(ctxRef);

  // Normal user message progresses the path (advances leafId)
  f.runtime.session.sessionManager.appendMessage({ role: "user", content: "Unrelated message", timestamp: 1 });
  f.runtime.session.sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Unrelated reply" }], timestamp: 2, api: "openai-completions", provider: "nunc-pi-fixture", model: "large", stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

  // Patch with v1 expectedRevision: same branch, M has not changed, so it MUST succeed
  const patch1 = surfaceRef.patch(ctxRef, {
    expectedRevision: v1.revision,
    add: [{ key: "unrelated-ok", text: "Added after unrelated message" }],
  });
  assert.equal(patch1.ok, true, "Unrelated message progression on same path must not cause conflict");

  // Real M update occurred (revision changed) -> repeat with stale v1 revision must conflict
  const patchStale = surfaceRef.patch(ctxRef, {
    expectedRevision: v1.revision,
    add: [{ key: "fail", text: "Stale" }],
  });
  assert.equal(patchStale.ok, false);
  assert.equal(patchStale.code, "conflict");
});

test("in-flight request sent with old M completes, records receipt, and next request reuses receipt with new M", async t => {
  const admissions: AdmissionObservation[] = [];
  let surfaceRef: MemorySurface | undefined;
  let ctxRef: ExtensionContext | undefined;
  const f = await fixture({
    flagValues: [["nunc-memory-tools", "true"]],
    extras: [{
      name: "watch",
      factory(pi) {
        pi.events.on("nunc:admission", val => admissions.push(val as AdmissionObservation));
        pi.on("session_start", (_event, ctx) => { ctxRef = ctx; });
        surfaceRef = memorySurface(pi);
      },
    }],
  });
  t.after(() => f.close());

  assert(surfaceRef && ctxRef);

  // Set initial memory M1
  const v0 = surfaceRef.read(ctxRef);
  surfaceRef.patch(ctxRef, {
    expectedRevision: v0.revision,
    add: [{ key: "m1", text: "Old memory M1" }],
  });

  const requestStarted = Promise.withResolvers<void>();
  const releaseRequest = Promise.withResolvers<void>();

  // While request 1 is in-flight, update memory to M2
  f.respond(async () => {
    requestStarted.resolve();
    await releaseRequest.promise;
    return fauxAssistantMessage("Response to in-flight request.");
  });

  const promptPromise = f.runtime.session.prompt("Prompt sent with M1");
  await requestStarted.promise;

  // Mid-flight: update M to M2
  const v1 = surfaceRef.read(ctxRef);
  const patchMidFlight = surfaceRef.patch(ctxRef, {
    expectedRevision: v1.revision,
    update: [{ id: "s1", text: "New memory M2 mid-flight" }],
  });
  assert.equal(patchMidFlight.ok, true);

  // Release the in-flight request to finish
  releaseRequest.resolve();
  await promptPromise;

  // Now send request 2 with M2: it must reuse the receipt established by the in-flight request
  f.respond(() => fauxAssistantMessage("Response to request 2."));
  await f.runtime.session.prompt("Prompt 2 with M2");

  const lastMain = mains(admissions).at(-1);
  assert.equal(lastMain?.outcome, "delegate");
  assert.equal(lastMain?.estimator, "pi-usage-backed");
  assert.equal(lastMain?.estimateReason, "matching-receipt");
  assert(lastMain?.receiptBreakdown?.currentMTokens! > 0);
  assert.equal(lastMain?.receiptBreakdown?.retainedOldMMargin, true);
});

test("mutation during resolver listener: in-flight request preserves old snapshot and receipt eligibility", async t => {
  const admissions: AdmissionObservation[] = [];
  let surfaceRef: MemorySurface | undefined;
  let ctxRef: ExtensionContext | undefined;
  let mutatedDuringResolver = false;

  const f = await fixture({
    flagValues: [["nunc-memory-tools", "true"]],
    extras: [{
      name: "resolver-race-test",
      factory(pi) {
        pi.events.on("nunc:admission", val => admissions.push(val as AdmissionObservation));
        pi.on("session_start", (_event, ctx) => { ctxRef = ctx; });
        surfaceRef = memorySurface(pi);
        // Simulate a resolver listener that performs an M-only write during the system prompt resolution window
        pi.events.on("larva:resolve-system-prompt:v1", () => {
          if (!mutatedDuringResolver && surfaceRef && ctxRef) {
            mutatedDuringResolver = true;
            const cur = surfaceRef.read(ctxRef);
            // Nonempty -> Empty mutation during the resolver window
            surfaceRef.patch(ctxRef, {
              expectedRevision: cur.revision,
              remove: cur.memory.slots.map(s => s.id),
            });
          }
        });
      },
    }],
  });
  t.after(() => f.close());

  assert(surfaceRef && ctxRef);

  // 1. Setup nonempty M1
  const v0 = surfaceRef.read(ctxRef);
  surfaceRef.patch(ctxRef, {
    expectedRevision: v0.revision,
    add: [{ key: "initial", text: "Initial memory M1" }],
  });

  // 2. Prompt 1 runs. During its enter(), resolver fires and mutates M to empty!
  await f.runtime.session.prompt("Prompt 1: M mutated during resolver");

  // In-flight request must preserve its M1 snapshot and NOT misclassify the M1 carrier as R
  const adm1 = mains(admissions).at(-1)!;
  assert.equal(adm1.outcome, "delegate");
  assert(adm1.inputTokens !== undefined);

  // 3. Prompt 2 runs: must be able to reuse receipt from Prompt 1 despite the intermediate mutation
  await f.runtime.session.prompt("Prompt 2: Following turn");
  const adm2 = mains(admissions).at(-1)!;
  assert.equal(adm2.outcome, "delegate");
  assert.equal(adm2.estimator, "pi-usage-backed");
  assert.equal(adm2.estimateReason, "matching-receipt");
});

test("lookalike genuine user message without Nunc carrier mark is treated as ordinary R and not misclassified as M", async t => {
  const admissions: AdmissionObservation[] = [];
  const f = await fixture({
    flagValues: [["nunc-memory-tools", "true"]],
    extras: [{
      name: "watch",
      factory(pi) {
        pi.events.on("nunc:admission", val => admissions.push(val as AdmissionObservation));
      },
    }],
  });
  t.after(() => f.close());

  // User sends a genuine message that looks like a Nunc memory carrier
  const lookalikeText = `Nunc working memory (session-local, reference only):\n[{"id":"fake","text":"I am a genuine user instruction, not a carrier"}]`;
  await f.runtime.session.prompt(lookalikeText);

  const call = f.calls.at(-1)!;
  // The lookalike message is retained in conversation history as user message
  assert(call.messages.some(m => typeof m.content === "string" ? m.content.includes("I am a genuine user instruction") : JSON.stringify(m.content).includes("I am a genuine user instruction")));

  const adm = mains(admissions).at(-1)!;
  assert.equal(adm.outcome, "delegate");
  // Since M is empty in this session, currentMTokens must be 0
  assert.equal(adm.receiptBreakdown?.currentMTokens ?? 0, 0);
});

test("cancellation of registered patch execute: aborted signal before commit makes zero append, zero ID, zero revision change", async t => {
  let ctxRef: ExtensionContext | undefined;
  let surfaceRef: MemorySurface | undefined;
  const f = await fixture({
    flagValues: [["nunc-memory-tools", "true"]],
    extras: [{
      name: "capture-ctx",
      factory(pi) {
        pi.on("session_start", (_event, ctx) => { ctxRef = ctx; });
        surfaceRef = memorySurface(pi);
      },
    }],
  });
  t.after(() => f.close());

  assert(ctxRef && surfaceRef);
  const patchTool = (f.runtime.session as any).getToolDefinition("nunc_memory_patch");
  assert(patchTool);

  const viewBefore = surfaceRef.read(ctxRef);
  const entriesCountBefore = f.runtime.session.sessionManager.getEntries().length;

  // Signal already aborted before execution
  const controller = new AbortController();
  controller.abort();

  const result = await patchTool.execute("call-cancel-1", {
    expectedRevision: viewBefore.revision,
    add: [{ key: "should-not-exist", text: "Cancelled content" }],
  }, controller.signal, undefined, ctxRef);

  assert(result);
  assert.equal(result.isError, true);
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.ok, false);
  assert.equal(data.code, "cancelled");

  // Zero append, zero ID consumed, zero revision change
  const viewAfter = surfaceRef.read(ctxRef);
  assert.equal(viewAfter.revision, viewBefore.revision);
  assert.equal(viewAfter.memory.slots.length, viewBefore.memory.slots.length);
  assert.equal(viewAfter.memory.nextId, viewBefore.memory.nextId);
  assert.equal(f.runtime.session.sessionManager.getEntries().length, entriesCountBefore);
});

test("authoritative validation rejection of null arrays, unknown fields, and prototype safety", async t => {
  let ctxRef: ExtensionContext | undefined;
  let surfaceRef: MemorySurface | undefined;
  const f = await fixture({
    flagValues: [["nunc-memory-tools", "true"]],
    extras: [{
      name: "capture-ctx",
      factory(pi) {
        pi.on("session_start", (_event, ctx) => { ctxRef = ctx; });
        surfaceRef = memorySurface(pi);
      },
    }],
  });
  t.after(() => f.close());

  assert(ctxRef && surfaceRef);
  const patchTool = (f.runtime.session as any).getToolDefinition("nunc_memory_patch")!;
  const v = surfaceRef.read(ctxRef);
  const entriesCountBefore = f.runtime.session.sessionManager.getEntries().length;

  // 1. null add rejected as invalid
  const r1 = await patchTool.execute("c1", { expectedRevision: v.revision, add: null }, undefined, undefined, ctxRef);
  assert.equal(JSON.parse(r1.content[0].text).code, "invalid");

  // 2. null update rejected as invalid
  const r2 = await patchTool.execute("c2", { expectedRevision: v.revision, update: null }, undefined, undefined, ctxRef);
  assert.equal(JSON.parse(r2.content[0].text).code, "invalid");

  // 3. null remove rejected as invalid
  const r3 = await patchTool.execute("c3", { expectedRevision: v.revision, remove: null }, undefined, undefined, ctxRef);
  assert.equal(JSON.parse(r3.content[0].text).code, "invalid");

  // 4. unknown top-level field rejected as invalid
  const r4 = await patchTool.execute("c4", { expectedRevision: v.revision, extraField: "forbidden" }, undefined, undefined, ctxRef);
  assert.equal(JSON.parse(r4.content[0].text).code, "invalid");

  // 5. unknown field inside add item rejected as invalid
  const r5 = await patchTool.execute("c5", { expectedRevision: v.revision, add: [{ key: "k", text: "t", extra: 1 }] }, undefined, undefined, ctxRef);
  assert.equal(JSON.parse(r5.content[0].text).code, "invalid");

  // 6. unknown field inside update item rejected as invalid
  const r6 = await patchTool.execute("c6", { expectedRevision: v.revision, update: [{ id: "s1", text: "t", extra: 1 }] }, undefined, undefined, ctxRef);
  assert.equal(JSON.parse(r6.content[0].text).code, "invalid");

  // 7. non-string remove item rejected as invalid
  const r7 = await patchTool.execute("c7", { expectedRevision: v.revision, remove: [123] }, undefined, undefined, ctxRef);
  assert.equal(JSON.parse(r7.content[0].text).code, "invalid");

  // Ensure nothing was committed during any invalid attempt
  assert.equal(f.runtime.session.sessionManager.getEntries().length, entriesCountBefore);

  // 8. Prototype safety: add with key '__proto__'
  const rProto = await patchTool.execute("c8", {
    expectedRevision: v.revision,
    add: [{ key: "__proto__", text: "Prototype key note" }],
  }, undefined, undefined, ctxRef);
  assert.equal(rProto.isError, undefined);
  const protoData = JSON.parse(rProto.content[0].text);
  assert.equal(protoData.ok, true);
  // Verify addedMap has own property '__proto__' without prototype pollution
  assert.equal(Object.prototype.hasOwnProperty.call(protoData.added, "__proto__"), true);
  assert.equal(protoData.added["__proto__"], "s1");
});

test("no recursive margin accumulation across multiple turns: U always comes from actual response", async t => {
  const admissions: AdmissionObservation[] = [];
  let surfaceRef: MemorySurface | undefined;
  let ctxRef: ExtensionContext | undefined;
  const f = await fixture({
    flagValues: [["nunc-memory-tools", "true"]],
    extras: [{
      name: "watch",
      factory(pi) {
        pi.events.on("nunc:admission", val => admissions.push(val as AdmissionObservation));
        pi.on("session_start", (_event, ctx) => { ctxRef = ctx; });
        surfaceRef = memorySurface(pi);
      },
    }],
  });
  t.after(() => f.close());

  assert(surfaceRef && ctxRef);
  const v0 = surfaceRef.read(ctxRef);
  surfaceRef.patch(ctxRef, {
    expectedRevision: v0.revision,
    add: [{ key: "note", text: "Persistent note across turns" }],
  });

  // Turn 1
  await f.runtime.session.prompt("Prompt 1");
  const a1 = f.runtime.session.messages.find(m => m.role === "assistant");
  assert(a1 && a1.role === "assistant");
  const u1 = a1.usage.totalTokens;
  assert(u1 > 0);

  // Turn 2
  await f.runtime.session.prompt("Prompt 2");
  const adm2 = mains(admissions).at(-1)!;
  assert.equal(adm2.estimator, "pi-usage-backed");
  assert.equal(adm2.receiptBreakdown?.observedU, u1); // From Turn 1 actual response!

  const a2 = f.runtime.session.messages.filter(m => m.role === "assistant")[1];
  assert(a2 && a2.role === "assistant");
  const u2 = a2.usage.totalTokens;
  assert(u2 > 0);

  // Turn 3
  await f.runtime.session.prompt("Prompt 3");
  const adm3 = mains(admissions).at(-1)!;
  assert.equal(adm3.estimator, "pi-usage-backed");
  assert.equal(adm3.receiptBreakdown?.observedU, u2); // From Turn 2 actual response, NOT recursively computed!
  assert.notEqual(adm3.receiptBreakdown?.observedU, adm2.receiptBreakdown!.observedU + adm2.receiptBreakdown!.deltaRTokens);
});

test("earlier receipt is reused when later response has invalid usage", async t => {
  const admissions: AdmissionObservation[] = [];
  let corruptSecond = false;
  const f = await fixture({
    extras: [{
      name: "watch",
      factory(pi) {
        pi.events.on("nunc:admission", val => admissions.push(val as AdmissionObservation));
        pi.on("context", event => {
          if (!corruptSecond) return;
          const messages = structuredClone(event.messages);
          const assistants = messages.filter(m => m.role === "assistant");
          if (assistants.length >= 2) {
            // Corrupt the second assistant's usage so its receipt anchor is unusable
            const lastAssistant = assistants.at(-1)!;
            lastAssistant.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
            return { messages };
          }
        });
      },
    }],
  });
  t.after(() => f.close());

  // Turn 1: valid response establishing receipt 1
  await f.runtime.session.prompt("Turn 1 prompt");
  const a1 = f.runtime.session.messages.find(m => m.role === "assistant");
  assert(a1 && a1.role === "assistant");
  const u1 = a1.usage.totalTokens;
  assert(u1 > 0);

  // Turn 2: response establishing receipt 2
  await f.runtime.session.prompt("Turn 2 prompt");

  // Turn 3: second assistant usage is corrupted in context, forcing fallback to receipt 1
  corruptSecond = true;
  await f.runtime.session.prompt("Turn 3 prompt");

  const adm3 = mains(admissions).at(-1)!;
  assert.equal(adm3.estimator, "pi-usage-backed");
  assert.equal(adm3.estimateReason, "matching-receipt");
  assert.equal(adm3.receiptBreakdown?.observedU, u1); // Reused earlier valid receipt from Turn 1!
  assert(adm3.anchorTrailingMessages! >= 2);
});

test("public tool nunc_memory_patch rejects when session state is unconfirmed", async t => {
  let ctxRef: ExtensionContext | undefined;
  let surfaceRef: MemorySurface | undefined;
  const f = await fixture({
    flagValues: [["nunc-memory-tools", "true"]],
    extras: [{
      name: "capture-ctx",
      factory(pi) {
        pi.on("session_start", (_event, ctx) => { ctxRef = ctx; });
        surfaceRef = memorySurface(pi);
      },
    }],
  });
  t.after(() => f.close());

  assert(ctxRef && surfaceRef);
  const patchTool = (f.runtime.session as any).getToolDefinition("nunc_memory_patch")!;

  // Seed one prompt so session file is written to disk
  await f.runtime.session.prompt("Seed session");

  // Simulate unconfirmed by making sessionFile inaccessible, causing an append failure
  const file = f.runtime.session.sessionFile!;
  const { rename, mkdir, rm } = await import("node:fs/promises");
  await rename(file, file + ".saved");
  await mkdir(file);

  const view = surfaceRef.read(ctxRef);
  const result = await patchTool.execute("call-unconfirmed-1", {
    expectedRevision: view.revision,
    add: [{ key: "unconfirmed-note", text: "Should fail unconfirmed" }],
  }, undefined, undefined, ctxRef);

  assert(result.isError);
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.ok, false);
  assert.equal(data.code, "unconfirmed");

  // Restore session file
  await rm(file, { recursive: true });
  await rename(file + ".saved", file);

  // Subsequent patch attempt while still unconfirmed also fails
  const vUnconfirmed = surfaceRef.read(ctxRef);
  assert.equal(vUnconfirmed.status.unconfirmed, true);

  const result2 = await patchTool.execute("call-unconfirmed-2", {
    expectedRevision: vUnconfirmed.revision,
    add: [{ key: "follow-up", text: "Also should fail unconfirmed" }],
  }, undefined, undefined, ctxRef);

  assert(result2.isError);
  const data2 = JSON.parse(result2.content[0].text);
  assert.equal(data2.ok, false);
  assert.equal(data2.code, "unconfirmed");
});
