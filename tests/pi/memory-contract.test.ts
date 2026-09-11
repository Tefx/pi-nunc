import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMemorySurface, memorySurface, type MemorySurface } from "../../src/pi/manual.js";
import { MANUAL_MEMORY_TYPE, project } from "../../src/pi/projection.js";
import { legacyRenderMemory, renderMemory } from "../../src/engine/memory.js";
import { memoryTokens } from "../../src/engine/accounting.js";
import type { Memory } from "../../src/engine/types.js";
import type { AdmissionObservation } from "../../src/pi/admission.js";
import { fixture } from "./fixtures.js";

async function memoryFixture(t: { after: (f: () => Promise<void>) => void }) {
  let ctx: ExtensionContext;
  let surface: MemorySurface;
  let api: ExtensionAPI;
  const observations: AdmissionObservation[] = [];
  const f = await fixture({ flagValues: [["nunc-memory-tools", "true"]], extras: [{ name: "memory-contract", factory(pi) {
    api = pi;
    pi.on("session_start", (_event, c) => { ctx = c; });
    surface = memorySurface(pi)!;
    pi.events.on("nunc:admission", value => observations.push(value as AdmissionObservation));
  } }] });
  t.after(() => f.close());
  return { f, ctx: () => ctx!, surface: () => surface!, api: () => api!, observations };
}

test("atomic final budget, overlimit reduction, unknown-budget shrinking and manual/model conflicts share native M", async t => {
  const e = await memoryFixture(t);
  const read = () => e.surface().read(e.ctx());
  const patch = (params: Parameters<MemorySurface["patch"]>[1]) => e.surface().patch(e.ctx(), params);
  const original = read();
  const initial = patch({ expectedRevision: original.revision, add: [{ key: "a", text: "A".repeat(180) }, { key: "b", text: "B".repeat(180) }] });
  assert.equal(initial.ok, true);
  const before = read();
  await writeFile(e.f.configFile, JSON.stringify({ memory: { maxTokens: before.budget.tokens } }));
  const entries = e.f.runtime.session.sessionManager.getEntries().length;
  const combined = patch({ expectedRevision: before.revision, remove: ["s1"], add: [{ key: "c", text: "C".repeat(160) }] });
  assert.equal(combined.ok, true, "final candidate fits even though add-before-remove would exceed M budget");
  assert.deepEqual(read().memory.slots.map(s => s.id), ["s2", "s3"]);
  assert.equal(e.f.runtime.session.sessionManager.getEntries().length, entries + 1);
  assert.equal(read().memory.slots[0]!.text, before.memory.slots[1]!.text);
  await writeFile(e.f.configFile, JSON.stringify({ memory: { maxTokens: 8 } }));
  assert.equal(read().budget.overLimit, true);
  assert.equal(patch({ expectedRevision: read().revision, update: [{ id: "s2", text: "B".repeat(100) }] }).ok, true);
  assert.equal(read().budget.overLimit, true, "shrink need not bring all M under the lowered cap");
  const count = e.f.runtime.session.sessionManager.getEntries().length;
  e.f.settings.applyOverrides({ compaction: { reserveTokens: 100000, keepRecentTokens: 1 } });
  const unknown = read();
  assert.equal(unknown.budget.limit, null);
  const growth = patch({ expectedRevision: unknown.revision, add: [{ key: "d", text: "growth" }] });
  assert(!growth.ok);
  assert.equal(growth.code, "unknown-budget");
  assert.equal(e.f.runtime.session.sessionManager.getEntries().length, count);
  assert.equal(e.surface().replace(e.ctx(), unknown.revision, "s2", "short").ok, true);
  const stale = patch({ expectedRevision: unknown.revision, remove: ["s3"] });
  assert(!stale.ok);
  assert.equal(stale.code, "conflict");
  const latest = read();
  assert.equal(patch({ expectedRevision: latest.revision, remove: ["s3"] }).ok, true);
  const staleManual = e.surface().delete(e.ctx(), latest.revision, "s2");
  assert(!staleManual.ok);
  assert.equal(staleManual.code, "conflict");
  assert.equal(read().memory.nextId, 4, "failed unknown-budget growth consumed no ID");
});

test("legacy checkpoint and later revision retain IDs/order/nextId across repeated requests and actual resume/reload/tree/fork/new", { timeout: 20000 }, async t => {
  const e = await memoryFixture(t);
  const { f } = e;
  const seeded = f.seed();
  const old: Memory = { version: 1, nextId: 41, slots: [{ id: "s8", text: "older first" }, { id: "s3", text: "older second" }] };
  const checkpoint = f.runtime.session.sessionManager.appendCompaction(legacyRenderMemory(old.slots), seeded.kept, 20000, { nunc: old });
  const revised: Memory = { version: 1, nextId: 77, slots: [{ id: "s8", text: "revised first" }, { id: "s41", text: "later addition" }] };
  const head = f.runtime.session.sessionManager.appendCustomEntry(MANUAL_MEMORY_TYPE, { nunc: revised });
  const file = f.runtime.session.sessionFile!;
  const rawBefore = await readFile(file, "utf8");
  await f.runtime.switchSession(file);
  assert.deepEqual(e.surface().read(e.ctx()).memory, revised);
  f.respond(() => fauxAssistantMessage("native path response"));
  const send = async (label: string, expected: Memory) => {
    await f.runtime.session.prompt(label);
    const messages = f.calls.at(-1)!.messages;
    assert.deepEqual(e.surface().read(e.ctx()).memory, expected);
    if (expected.slots.length) assert.deepEqual(messages.at(-1), { role: "user", content: [{ type: "text", text: renderMemory(expected.slots) }], timestamp: 0 });
    else assert.equal(messages.at(-1)?.role, "user");
    assert(!JSON.stringify(messages).includes("The conversation history before this point was compacted"));
    assert.equal(messages.filter(m => m.role === "user" && Array.isArray(m.content) && m.content.some(b => b.type === "text" && b.text === renderMemory(expected.slots))).length, expected.slots.length ? 1 : 0);
  };
  await send("first old reconstruction", revised);
  assert.equal(e.observations.filter(o => o.kind === "main").at(-1)!.estimator, "pi-heuristic");
  await send("second old reconstruction", revised);
  assert.equal(e.observations.filter(o => o.kind === "main").at(-1)!.estimator, "pi-usage-backed", "conversion does not invalidate every new receipt");
  assert((await readFile(file, "utf8")).startsWith(rawBefore), "old JSONL was not rewritten");
  assert.equal(f.runtime.session.sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === MANUAL_MEMORY_TYPE).length, 1);
  await f.runtime.session.reload();
  await send("resource reload reconstruction", revised);
  assert.equal(e.observations.filter(o => o.kind === "main").at(-1)!.estimator, "pi-heuristic");
  await f.runtime.session.navigateTree(checkpoint, { summarize: false });
  await send("checkpoint path", old);
  await f.runtime.session.navigateTree(head, { summarize: false });
  await f.runtime.fork(head, { position: "at" });
  await send("fork retained revision", revised);
  const view = e.surface().read(e.ctx());
  const added = e.surface().patch(e.ctx(), { expectedRevision: view.revision, add: [{ key: "next", text: "new after old nextId" }] });
  assert(added.ok);
  assert.equal(added.added.next, "s77");
  assert.equal(added.memory.nextId, 78);
  await f.runtime.newSession();
  await send("new empty M", { version: 1, nextId: 1, slots: [] });
  assert.equal(e.surface().read(e.ctx()).budget.tokens, 0);
});

for (const kind of ["conflicting", "unknown-version", "corrupt-summary"] as const) test(`old ${kind} data fails before transport and preserves native history`, async t => {
  const e = await memoryFixture(t);
  const seed = e.f.seed();
  const memory = { version: kind === "unknown-version" ? 2 : 1, nextId: 44, slots: [{ id: "s3", text: "keep this source" }] };
  const summary = kind === "conflicting" ? "disagrees with details" : kind === "corrupt-summary" ? "Nunc working memory (session-local):\n{bad json" : legacyRenderMemory(memory.slots);
  e.f.runtime.session.sessionManager.appendCompaction(summary, seed.kept, 20000, kind === "corrupt-summary" ? undefined : { nunc: memory });
  const before = e.f.runtime.session.sessionManager.getEntries();
  assert.throws(() => project(e.f.runtime.session.sessionManager.buildContextEntries()));
  await e.f.runtime.session.prompt("must reject broken memory");
  assert.equal(e.f.calls.length, 0);
  assert.equal(e.observations.filter(o => o.kind === "main").at(-1)?.outcome, "reject");
  assert.deepEqual(e.f.runtime.session.sessionManager.getEntries().slice(0, before.length), before);
});

test("cancellation observed after confirmed public append reports the committed patch without rollback", async t => {
  const e = await memoryFixture(t);
  await e.f.runtime.session.prompt("persist this isolated session");
  const controller = new AbortController();
  // Exercise the shared commit boundary with its real appendEntry; only the
  // notification callback supplies the post-confirmation cancellation timing.
  const surface = createMemorySurface({ pi: e.api(), fixed: ctx => ({ systemPrompt: ctx.getSystemPrompt(), tools: [] }), settings: () => ({ compaction: e.f.settings.getCompactionSettings(), blockImages: false }), onCommitted: () => controller.abort() });
  const result = surface.patch(e.ctx(), { expectedRevision: surface.read(e.ctx()).revision, add: [{ key: "confirmed", text: "committed before cancellation" }] }, controller.signal);
  assert.equal(controller.signal.aborted, true);
  assert(result.ok);
  assert.equal(result.added.confirmed, "s1");
  assert.equal(surface.read(e.ctx()).status.unconfirmed, false);
  const entries = (await readFile(e.f.runtime.session.sessionFile!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(entries.filter(e => e.type === "custom" && e.customType === MANUAL_MEMORY_TYPE).length, 1);
  assert.equal(result.memory.slots[0]?.text, "committed before cancellation");
});

test("actual host tool preflight cancellation prevents memory patch execution and native M append", { timeout: 10000 }, async t => {
  let revision = "";
  let ctx: ExtensionContext;
  let surface: MemorySurface;
  let calls = 0;
  const f = await fixture({ flagValues: [["nunc-memory-tools", "true"]], extras: [{ name: "cancel-model-patch", factory(pi) {
    surface = memorySurface(pi)!;
    pi.on("session_start", (_e, c) => { ctx = c; });
    pi.on("tool_call", async (event, c) => {
      if (event.toolName !== "nunc_memory_patch") return;
      calls++;
      void c.abort();
      assert.equal(c.signal?.aborted, true);
    });
  } }] });
  t.after(() => f.close());
  revision = surface!.read(ctx!).revision;
  f.respond(() => fauxAssistantMessage(fauxToolCall("nunc_memory_patch", { expectedRevision: revision, add: [{ key: "cancelled", text: "must not append" }] }, { id: "patch-cancel" }), { stopReason: "toolUse" }));
  await f.runtime.session.prompt("request cancelled at actual tool boundary");
  assert.equal(calls, 1);
  assert.equal(f.faux.state.callCount, 1);
  assert.deepEqual(surface!.read(ctx!).memory, { version: 1, nextId: 1, slots: [] });
  assert.equal(f.runtime.session.sessionManager.getEntries().filter(e => e.type === "custom" && e.customType === MANUAL_MEMORY_TYPE).length, 0);
  assert.equal(memoryTokens(surface!.read(ctx!).memory.slots), 0);
});
