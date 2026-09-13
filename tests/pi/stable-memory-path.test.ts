import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { renderMemory } from "../../src/engine/memory.js";
import { withEffectiveMemory, carrierIndexIn, clearMemoryAnchors, injectedCarrierIndex } from "../../src/pi/projection.js";
import { memorySurface, type MemorySurface } from "../../src/pi/manual.js";
import type { AdmissionObservation } from "../../src/pi/admission.js";
import { fixture } from "./fixtures.js";

const memory = { version: 1 as const, nextId: 2, slots: [{ id: "s1", text: "retained" }] };
const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });
const entry = (id: string, content: string): SessionEntry => ({ id, parentId: null, timestamp: "2026-01-01", type: "message", message: user(content) });

test("unmapped, partially mapped and ambiguous source boundaries rebuild without discarding hook messages", () => {
  for (const mode of ["unmapped", "partial", "ambiguous"]) {
    clearMemoryAnchors();
    const prefix = mode === "partial" ? [user("ancestor"), user("replacement")] : [user("replacement")];
    const old = mode === "partial" ? [entry("root", "ancestor"), entry("a", "original A")] : mode === "ambiguous" ? [entry("a", "replacement"), entry("duplicate", "replacement")] : [entry("a", "original A")];
    const first = withEffectiveMemory(prefix, memory, { sessionId: mode, entries: old });
    assert.equal(carrierIndexIn(first), prefix.length);
    const nextPrefix = [...structuredClone(prefix), user("later")];
    const changed = mode === "partial" ? [entry("root", "ancestor"), entry("b", "original B")] : mode === "ambiguous" ? old : [entry("b", "original B")];
    const next = withEffectiveMemory(nextPrefix, memory, { sessionId: mode, entries: changed });
    assert.equal(carrierIndexIn(next), nextPrefix.length);
    assert.deepEqual(next.filter((_, i) => i !== carrierIndexIn(next)), nextPrefix);
  }
});

test("real loader cloned/modified hook on a disjoint selected path cannot reuse an unbound prefix", async t => {
  const dir = await mkdtemp(resolve(".scratch/stable-hook-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const extension = join(dir, "transform.mjs");
  await writeFile(extension, `export default function(pi) { let requests = 0; pi.on('context', event => {
    requests++; const messages = event.messages.map(m => m.role === 'user' ? { ...m, content: 'extension replacement', timestamp: 1 } : m);
    if (requests > 1) messages.push({ role:'user', content:'extension later', timestamp:2 });
    return { messages };
  }); }`);
  let ctx: ExtensionContext | undefined, surface: MemorySurface | undefined;
  const observations: AdmissionObservation[] = [];
  const f = await fixture({ beforeNunc: [extension], flagValues: [["nunc-memory-tools", "true"]], extras: [{ name: "observe-path", factory(pi) {
    surface = memorySurface(pi); pi.on("session_start", (_, c) => { ctx = c; }); pi.events.on("nunc:admission", e => observations.push(e as AdmissionObservation));
  } }] });
  t.after(() => f.close());
  assert(ctx && surface);
  assert(surface.patch(ctx, { expectedRevision: surface.read(ctx).revision, add: [{ key: "note", text: "retained" }] }).ok);
  const root = f.runtime.session.sessionManager.getLeafId()!;
  await f.runtime.session.prompt("original A");
  assert.equal(observations.filter(o => o.kind === "main").at(-1)?.memoryIndex, 1);
  const switched = await f.runtime.session.navigateTree(root, { summarize: false });
  assert(!switched.cancelled);
  await f.runtime.session.prompt("original B");
  const request = f.calls.at(-1)!;
  const observed = observations.filter(o => o.kind === "main").at(-1)!;
  assert.equal(observed.memoryIndex, 2);
  assert.equal(observed.memoryCarrierCount, 1);
  assert.equal(request.messages.length, 3);
  assert.equal(request.messages[0]?.content, "extension replacement");
  assert.equal(request.messages[1]?.content, "extension later");
});

test("actual admission distinguishes identical timestamp-zero user lookalikes from injected M", async t => {
  const observations: AdmissionObservation[] = [];
  let ctx: ExtensionContext | undefined, surface: MemorySurface | undefined;
  const f = await fixture({ flagValues: [["nunc-memory-tools", "true"]], extras: [{ name: "lookalike-observe", factory(pi) {
    surface = memorySurface(pi); pi.on("session_start", (_, c) => { ctx = c; }); pi.events.on("nunc:admission", e => observations.push(e as AdmissionObservation));
  } }] });
  t.after(() => f.close()); assert(ctx && surface);
  assert(surface.patch(ctx, { expectedRevision: surface.read(ctx).revision, add: [{ key: "note", text: "retained" }] }).ok);
  const body = renderMemory(surface.read(ctx).memory.slots);
  const sm = f.runtime.session.sessionManager;
  sm.appendMessage({ role: "user", content: [{ type: "text", text: body }], timestamp: 0 });
  sm.appendMessage({ role: "user", content: [{ type: "text", text: body }], timestamp: 0 });
  f.runtime.session.agent.state.messages = sm.buildSessionContext().messages;
  await f.runtime.session.prompt("continue");
  const a = observations.filter(o => o.kind === "main").at(-1)!;
  assert.equal(a.memoryPresent, true, JSON.stringify({ a, calls: f.calls })); assert.equal(a.memoryCarrierCount, 1); assert.equal(a.memoryIndex, 3);
  assert.equal(f.calls.at(-1)!.messages.length, 4);
  assert.equal(f.calls.at(-1)!.messages.filter(m => JSON.stringify(m.content).includes("retained")).length, 3);
  assert.equal(injectedCarrierIndex(f.calls.at(-1)!.messages), undefined, "clone has no process-local provenance even with a recognizable envelope");
  const noTimestamp = { role: "user", content: body };
  const projected = withEffectiveMemory([noTimestamp], memory);
  assert.equal(projected[0], noTimestamp);
  assert.equal(injectedCarrierIndex(projected), 1, "a timestampless lookalike has no carrier provenance");
});

test("native same-session recovery has no reusable anchor and establishes a new legal tail", async t => {
  const observations: AdmissionObservation[] = [];
  let ctx: ExtensionContext | undefined, surface: MemorySurface | undefined;
  const f = await fixture({ flagValues: [["nunc-memory-tools", "true"]], extras: [{ name: "recovery-observe", factory(pi) {
    surface = memorySurface(pi); pi.on("session_start", (_, c) => { ctx = c; }); pi.events.on("nunc:admission", e => observations.push(e as AdmissionObservation));
  } }] });
  t.after(() => f.close()); assert(ctx && surface);
  assert(surface.patch(ctx, { expectedRevision: surface.read(ctx).revision, add: [{ key: "note", text: "retained" }] }).ok);
  await f.runtime.session.prompt("one"); await f.runtime.session.prompt("two");
  assert.equal(observations.filter(o => o.kind === "main").at(-1)?.memoryIndex, 1);
  await f.runtime.switchSession(f.runtime.session.sessionFile!);
  await f.runtime.session.prompt("after recovery");
  const index = observations.filter(o => o.kind === "main").at(-1)?.memoryIndex;
  assert.equal(index, f.calls.at(-1)!.messages.length - 1);
  assert(index! > 1);
  await f.runtime.session.prompt("stable again");
  assert.equal(observations.filter(o => o.kind === "main").at(-1)?.memoryIndex, index);
});
