import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rename, mkdir, rm, writeFile } from "node:fs/promises";
import { SessionManager, type ExtensionContext, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { MANUAL_MEMORY_TYPE, memorySurface, type MemorySurface } from "pi-nunc/pi";
import { isManualMemoryEntry, project } from "../../src/pi/projection.js";
import type { AdmissionObservation } from "../../src/pi/admission.js";
import { fixture, memoryPatch } from "./fixtures.js";

function port(admissions?: AdmissionObservation[]): { extras: InlineExtension[]; surface: () => MemorySurface; ctx: () => ExtensionContext } {
  let api: { events: { emit: (channel: string, data: unknown) => void } } | undefined;
  let ctx: ExtensionContext | undefined;
  return {
    extras: [{ name: "nunc-memory-port", factory(pi) {
      api = pi;
      pi.on("session_start", (_event, next) => { ctx = next; });
      if (admissions) pi.events.on("nunc:admission", value => admissions.push(value as AdmissionObservation));
    } }],
    surface() { const value = memorySurface(api!); assert(value); return value; },
    ctx() { assert(ctx); return ctx; },
  };
}

async function prepared(t: { after: (fn: () => Promise<void>) => void }, options: Parameters<typeof fixture>[0] = {}, admissions?: AdmissionObservation[]) {
  const captured = port(admissions);
  const f = await fixture({ ...options, extras: [...(options.extras ?? []), ...captured.extras] });
  t.after(() => f.close());
  f.seed(); f.respond(memoryPatch);
  await f.runtime.session.compact();
  return { f, ...captured };
}

test("public appendEntry save is the only M carrier, stays out of R, and survives native reopen", async t => {
  const { f, surface, ctx } = await prepared(t, { publicFactory: true });
  const before = project(f.runtime.session.sessionManager.buildContextEntries());
  const view = surface().read(ctx());
  const slot = view.memory.slots[0]!;
  const saved = surface().replace(ctx(), view.revision, slot.id, "Edited constraint.");
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const after = project(f.runtime.session.sessionManager.buildContextEntries());
  assert.equal(after.memory.slots[0]?.text, "Edited constraint.");
  assert.equal(after.memory.slots[0]?.id, slot.id);
  assert.deepEqual(after.active.map(e => e.entryId), before.active.map(e => e.entryId));
  assert.equal(after.active.some(e => {
    const entry = f.runtime.session.sessionManager.getEntry(e.entryId);
    return entry ? isManualMemoryEntry(entry) : false;
  }), false);
  const raw = await readFile(f.runtime.session.sessionFile!, "utf8");
  assert(raw.includes(MANUAL_MEMORY_TYPE));
  assert(raw.includes("Edited constraint."));
  const loaded = SessionManager.open(f.runtime.session.sessionFile!, f.sessionDir);
  assert.equal(project(loaded.buildContextEntries()).memory.slots[0]?.text, "Edited constraint.");
  await f.runtime.session.prompt("Continue with the edited memory.");
  const main = f.calls.at(-1)!;
  assert(JSON.stringify(main.messages).includes("Edited constraint."));
  assert.equal(main.messages.filter(m => JSON.stringify(m).includes(MANUAL_MEMORY_TYPE)).length, 0);
});

test("resume/reload/new/tree/fork/clone follow the selected path; new is empty", async t => {
  const { f, surface, ctx } = await prepared(t);
  const view = surface().read(ctx());
  assert.equal(surface().replace(ctx(), view.revision, view.memory.slots[0]!.id, "Path-local edit.").ok, true);
  const snapshotId = f.runtime.session.sessionManager.getLeafId()!;
  const originalId = f.runtime.session.sessionId;
  const originalFile = f.runtime.session.sessionFile!;
  const memory = project(f.runtime.session.sessionManager.buildContextEntries()).memory;
  const beforeMemory = f.runtime.session.sessionManager.getBranch().find(e => e.type === "compaction")!.parentId!;
  await f.runtime.switchSession(originalFile);
  assert.equal(f.runtime.session.sessionId, originalId);
  assert.deepEqual(project(f.runtime.session.sessionManager.buildContextEntries()).memory, memory);
  await f.runtime.session.navigateTree(beforeMemory, { summarize: false });
  assert.notEqual(project(f.runtime.session.sessionManager.buildContextEntries()).memory.slots[0]?.text, "Path-local edit.");
  await f.runtime.session.navigateTree(snapshotId, { summarize: false });
  assert.equal(project(f.runtime.session.sessionManager.buildContextEntries()).memory.slots[0]?.text, "Path-local edit.");
  await f.runtime.fork(snapshotId, { position: "at" });
  assert.notEqual(f.runtime.session.sessionId, originalId);
  assert.equal(project(f.runtime.session.sessionManager.buildContextEntries()).memory.slots[0]?.text, "Path-local edit.");
  await f.runtime.fork(beforeMemory, { position: "at" });
  assert.notEqual(project(f.runtime.session.sessionManager.buildContextEntries()).memory.slots[0]?.text, "Path-local edit.");
  await f.runtime.newSession();
  assert.equal(project(f.runtime.session.sessionManager.buildContextEntries()).memory.slots.length, 0);
});

test("next native checkpoint absorbs effective M and does not replay older manual records", async t => {
  const { f, surface, ctx } = await prepared(t);
  const view = surface().read(ctx());
  assert.equal(surface().replace(ctx(), view.revision, view.memory.slots[0]!.id, "Manual before absorb.").ok, true);
  f.seed("after-edit");
  f.respond(context => {
    const records = context.messages.flatMap(m => typeof m.content === "string" ? [] : m.content.flatMap(b => {
      if (b.type !== "text") return [];
      try { return [JSON.parse(b.text) as Record<string, unknown>]; } catch { return []; }
    }));
    const slots = ((records.find(r => r.M)?.M ?? []) as { id: string; text: string }[]);
    assert.equal(slots[0]?.text, "Manual before absorb.");
    return fauxAssistantMessage(JSON.stringify({ add: [{ key: "absorbed", text: "Checkpoint absorbed text." }], remove: slots.map(s => s.id), priority: ["absorbed"] }));
  });
  await f.runtime.session.compact();
  const projected = project(f.runtime.session.sessionManager.buildContextEntries());
  assert.equal(projected.memory.slots[0]?.text, "Checkpoint absorbed text.");
  assert.equal(f.runtime.session.sessionManager.getEntries().filter(isManualMemoryEntry).length, 1);
});

test("new constructed requests see saved M; in-flight context and queue stay legitimate", async t => {
  const { f, surface, ctx } = await prepared(t);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let inflightHasEdit = false;
  let first = true;
  f.respond(async context => {
    if (first) {
      first = false;
      inflightHasEdit = JSON.stringify(context.messages).includes("Post-save memory");
      started.resolve();
      await release.promise;
    }
    return fauxAssistantMessage("In-flight turn.");
  });
  const turn = f.runtime.session.prompt("In-flight request");
  await started.promise;
  await f.runtime.session.followUp("queued-follow-up");
  assert.equal(f.runtime.session.getFollowUpMessages().length, 1);
  const view = surface().read(ctx());
  const saved = surface().replace(ctx(), view.revision, view.memory.slots[0]!.id, "Post-save memory");
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(f.runtime.session.getFollowUpMessages().length, 1);
  release.resolve();
  await turn;
  assert.equal(inflightHasEdit, false);
  f.respond(context => {
    assert(JSON.stringify(context.messages).includes("Post-save memory"));
    return fauxAssistantMessage("Next constructed request.");
  });
  await f.runtime.session.prompt("Request after save");
  assert(JSON.stringify(f.calls.at(-1)!.messages).includes("Post-save memory"));
});

test("saving invalidates pre-save usage attribution on the next constructed main request", async t => {
  const admissions: AdmissionObservation[] = [];
  const { f, surface, ctx } = await prepared(t, {}, admissions);
  f.respond(() => fauxAssistantMessage("Prefix established."));
  await f.runtime.session.prompt("Establish usage prefix");
  const view = surface().read(ctx());
  assert.equal(surface().replace(ctx(), view.revision, view.memory.slots[0]!.id, "Attribution cut").ok, true);
  admissions.length = 0;
  f.respond(() => fauxAssistantMessage("After attribution cut."));
  await f.runtime.session.prompt("First constructed request after save");
  const afterSave = admissions.filter(a => a.kind === "main");
  assert(afterSave.length > 0, JSON.stringify(afterSave));
  assert(afterSave.every(a => a.estimator !== "pi-usage-backed"), JSON.stringify(afterSave));
});

test("candidate-to-native terminal gap occupies save; ordinary agent run does not", async t => {
  const gap: { result?: ReturnType<MemorySurface["replace"]> } = {};
  const captured = port();
  const f = await fixture({ publicFactory: true, extras: [
    ...captured.extras,
    { name: "nunc-memory-gap", factory(pi) {
      pi.on("session_before_compact", (_event, ctx) => {
        const surface = captured.surface();
        const view = surface.read(ctx);
        gap.result = surface.replace(ctx, view.revision, view.memory.slots[0]?.id ?? "s1", "illegal-gap");
      });
    } },
  ] });
  t.after(() => f.close());
  f.seed(); f.respond(memoryPatch);
  await f.runtime.session.compact();
  assert.equal(gap.result?.ok, false);
  assert.equal(gap.result && !gap.result.ok ? gap.result.code : "", "occupied");
  const view = captured.surface().read(captured.ctx());
  const after = captured.surface().replace(captured.ctx(), view.revision, view.memory.slots[0]!.id, "After native terminal");
  assert.equal(after.ok, true, JSON.stringify(after));
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.respond(async () => { started.resolve(); await release.promise; return fauxAssistantMessage("agent run"); });
  const turn = f.runtime.session.prompt("Ordinary run");
  await started.promise;
  const during = captured.surface().read(captured.ctx());
  const runSave = captured.surface().replace(captured.ctx(), during.revision, during.memory.slots[0]!.id, "During ordinary run");
  assert.equal(runSave.ok, true, JSON.stringify(runSave));
  release.resolve();
  await turn;
});

test("revision conflicts on memory changes; unrelated custom entries do not", async t => {
  const { f, surface, ctx } = await prepared(t);
  const first = surface().read(ctx());
  f.runtime.session.sessionManager.appendCustomEntry("other.extension", { note: "unrelated" });
  const still = surface().replace(ctx(), first.revision, first.memory.slots[0]!.id, "Allowed after unrelated entry");
  assert.equal(still.ok, true, JSON.stringify(still));
  const stale = surface().replace(ctx(), first.revision, first.memory.slots[0]!.id, "Stale revision");
  assert.equal(stale.ok, false);
  assert.equal(stale.ok ? "" : stale.code, "conflict");
});

test("tree switch between branches sharing a checkpoint rejects a stale path draft", async t => {
  const { f, surface, ctx } = await prepared(t);
  const checkpoint = f.runtime.session.sessionManager.getLeafId()!;
  f.seed("branch-a");
  const draft = surface().read(ctx());
  await f.runtime.session.navigateTree(checkpoint, { summarize: false });
  f.seed("branch-b");
  assert.notEqual(f.runtime.session.sessionManager.getLeafId(), checkpoint);
  const result = surface().replace(ctx(), draft.revision, draft.memory.slots[0]!.id, "from-other-branch");
  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.code, "conflict");
  const current = surface().read(ctx());
  const ok = surface().replace(ctx(), current.revision, current.memory.slots[0]!.id, "on-selected-branch");
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test("growing edits obey M budget; delete/shorten may reduce over-budget M without moving K", async t => {
  const { f, surface, ctx } = await prepared(t);
  const beforeActive = project(f.runtime.session.sessionManager.buildContextEntries()).active.map(e => e.entryId);
  await writeFile(f.configFile, JSON.stringify({ memory: { maxTokens: 8 } }));
  const view = surface().read(ctx());
  assert.equal(view.budget.unknown, false);
  const grow = surface().replace(ctx(), view.revision, view.memory.slots[0]!.id, "too large ".repeat(400));
  assert.equal(grow.ok, false);
  assert.equal(grow.ok ? "" : grow.code, "overbudget");
  const shrink = surface().replace(ctx(), view.revision, view.memory.slots[0]!.id, "tiny");
  assert.equal(shrink.ok, true, JSON.stringify(shrink));
  assert.equal(shrink.ok ? shrink.memory.slots[0]?.text : "", "tiny");
  const over = surface().read(ctx());
  const removed = surface().delete(ctx(), over.revision, over.memory.slots[0]!.id);
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(removed.ok ? removed.memory.slots.length : -1, 0);
  assert.deepEqual(project(f.runtime.session.sessionManager.buildContextEntries()).active.map(e => e.entryId), beforeActive);
});

test("empty text, unknown budget, and skipped save do not append", async t => {
  const { f, surface, ctx } = await prepared(t);
  const before = f.runtime.session.sessionManager.getEntries().length;
  const view = surface().read(ctx());
  const empty = surface().replace(ctx(), view.revision, view.memory.slots[0]!.id, "   ");
  assert.equal(empty.ok, false);
  assert.equal(empty.ok ? "" : empty.code, "invalid");
  f.settings.applyOverrides({ compaction: { reserveTokens: 100000, keepRecentTokens: 1 } });
  const unknown = surface().replace(ctx(), view.revision, view.memory.slots[0]!.id, `${view.memory.slots[0]!.text} and more`);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.ok ? "" : unknown.code, "unknown-budget");
  assert.equal(f.runtime.session.sessionManager.getEntries().length, before);
});

test("native append I/O failure is unconfirmed and does not claim unchanged memory", async t => {
  const { f, surface, ctx } = await prepared(t);
  const file = f.runtime.session.sessionFile!;
  const beforeText = surface().read(ctx()).memory.slots[0]!.text;
  await rename(file, file + ".saved"); await mkdir(file);
  const view = surface().read(ctx());
  const result = surface().replace(ctx(), view.revision, view.memory.slots[0]!.id, "Unconfirmed write");
  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.code, "unconfirmed");
  assert.equal(result.ok ? false : result.view.status.unconfirmed, true);
  assert.notEqual(JSON.stringify(result.ok ? undefined : result.view.memory), JSON.stringify(view.memory));
  await rm(file, { recursive: true }); await rename(file + ".saved", file);
  const reread = surface().read(ctx());
  assert.equal(reread.status.unconfirmed, true);
  const again = surface().replace(ctx(), reread.revision, reread.memory.slots[0]!.id, "Follow-up without reconcile");
  assert.equal(again.ok, false);
  assert.equal(again.ok ? "" : again.code, "unconfirmed");
  await f.runtime.switchSession(file);
  const restored = surface().read(ctx());
  assert.equal(restored.status.unconfirmed, false);
  assert.equal(restored.memory.slots[0]?.text, beforeText);
  const reopened = SessionManager.open(file, f.sessionDir);
  assert.equal(project(reopened.buildContextEntries()).memory.slots[0]?.text, beforeText);
  const saved = surface().replace(ctx(), restored.revision, restored.memory.slots[0]!.id, "After native reload");
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(project(SessionManager.open(file, f.sessionDir).buildContextEntries()).memory.slots[0]?.text, "After native reload");
});

test("abortCompaction failed terminal unlocks save; overlapping compact does not stick occupied", async t => {
  const { f, surface, ctx } = await prepared(t);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.respond(async context => {
    started.resolve();
    await release.promise;
    return memoryPatch(context);
  });
  f.seed("freeze");
  const compacting = f.runtime.session.compact();
  await started.promise;
  const during = surface().read(ctx());
  const blocked = surface().replace(ctx(), during.revision, during.memory.slots[0]!.id, "during freeze");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok ? "" : blocked.code, "occupied");
  const second = f.runtime.session.compact();
  f.runtime.session.abortCompaction();
  release.resolve();
  await Promise.allSettled([compacting, second]);
  const after = surface().read(ctx());
  assert.equal(after.status.occupied, false);
  const saved = surface().replace(ctx(), after.revision, after.memory.slots[0]!.id, "after failed terminal");
  assert.equal(saved.ok, true, JSON.stringify(saved));
});

test("legacy summary plus later manual revision is effective M", async t => {
  const { f, surface, ctx } = await prepared(t);
  const kept = f.runtime.session.sessionManager.getLeafId()!;
  f.runtime.session.sessionManager.appendCompaction("Legacy constraints.", kept, 5000);
  f.seed("after-legacy");
  const view = surface().read(ctx());
  assert.equal(view.memory.slots[0]?.id, "legacy");
  const saved = surface().replace(ctx(), view.revision, "legacy", "Legacy edited.");
  assert.equal(saved.ok, true, JSON.stringify(saved));
  f.respond(() => fauxAssistantMessage("After legacy edit."));
  await f.runtime.session.prompt("Use the edited legacy memory");
  assert(JSON.stringify(f.calls.at(-1)!.messages).includes("Legacy edited."));
});
