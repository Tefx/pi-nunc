import { test } from "node:test";
import assert from "node:assert/strict";
import { type Message, type Model, type Provider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { ModelRegistry, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { emptyMemory, renderMemory } from "../../src/engine/memory.js";
import {
  clearMemoryAnchors,
  injectedCarrierIndex,
  peekMemoryAnchor,
  setObserverMemoryLayout,
  withEffectiveMemory,
} from "../../src/pi/projection.js";
import { contextSurface, memorySurface, type MemorySurface } from "pi-nunc/pi";
import type { AdmissionObservation } from "../../src/pi/admission.js";
import { fixture } from "./fixtures.js";

function user(text: string, timestamp = 1) {
  return { role: "user" as const, content: text, timestamp };
}
function assistant(text: string, timestamp = 2) {
  return { role: "assistant" as const, content: [{ type: "text" as const, text }], timestamp, stopReason: "stop" };
}
function memory(slots: { id: string; text: string }[]) {
  return { version: 1 as const, nextId: slots.length + 1, slots };
}

test("withEffectiveMemory: first construction uses the legal tail; later history does not move unchanged M", () => {
  clearMemoryAnchors();
  const session = { sessionId: "s-stable" };
  const note = memory([{ id: "s1", text: "fixed note" }]);
  const first = withEffectiveMemory([user("one")], note, session);
  assert.equal(injectedCarrierIndex(first), 1);
  const second = withEffectiveMemory([user("one"), assistant("ok"), user("two", 3)], note, session);
  assert.equal(injectedCarrierIndex(second), 1);
  assert.notEqual(injectedCarrierIndex(second), second.length - 1);
  assert.equal(JSON.stringify(second[1]), JSON.stringify(first[1]));
  clearMemoryAnchors();
});

test("withEffectiveMemory: content change rebuilds at the new request tail", () => {
  clearMemoryAnchors();
  const session = { sessionId: "s-update" };
  const first = withEffectiveMemory([user("one")], memory([{ id: "s1", text: "old" }]), session);
  assert.equal(injectedCarrierIndex(first), 1);
  const next = withEffectiveMemory([user("one"), assistant("ok"), user("two", 3)], memory([{ id: "s1", text: "new" }]), session);
  assert.equal(injectedCarrierIndex(next), next.length - 1);
  clearMemoryAnchors();
});

test("withEffectiveMemory: empty M drops the carrier; observer moving layout always uses the tail", () => {
  clearMemoryAnchors();
  const session = { sessionId: "s-empty" };
  withEffectiveMemory([user("one")], memory([{ id: "s1", text: "note" }]), session);
  const emptied = withEffectiveMemory([user("one"), assistant("ok")], emptyMemory(), session);
  assert.equal(injectedCarrierIndex(emptied), undefined);
  assert.equal(peekMemoryAnchor("s-empty"), undefined);
  setObserverMemoryLayout("moving");
  const moving = withEffectiveMemory([user("one")], memory([{ id: "s1", text: "note" }]), { sessionId: "s-move" });
  const moved = withEffectiveMemory([user("one"), assistant("ok"), user("two", 3)], memory([{ id: "s1", text: "note" }]), { sessionId: "s-move" });
  assert.equal(injectedCarrierIndex(moving), moving.length - 1);
  assert.equal(injectedCarrierIndex(moved), moved.length - 1);
  setObserverMemoryLayout("stable");
  clearMemoryAnchors();
});

test("withEffectiveMemory: reused M stays before a later complete parallel tool group", () => {
  clearMemoryAnchors();
  const session = { sessionId: "s-tools" };
  const note = memory([{ id: "s1", text: "note" }]);
  const first = withEffectiveMemory([user("go")], note, session);
  assert.equal(injectedCarrierIndex(first), 1);
  const call = {
    role: "assistant" as const,
    content: [
      { type: "toolCall" as const, id: "a", name: "one", arguments: {} },
      { type: "toolCall" as const, id: "b", name: "two", arguments: {} },
    ],
    timestamp: 2,
    stopReason: "toolUse",
  };
  const r1 = { role: "toolResult" as const, toolCallId: "a", toolName: "one", content: [{ type: "text" as const, text: "A" }], isError: false, timestamp: 3 };
  const r2 = { role: "toolResult" as const, toolCallId: "b", toolName: "two", content: [{ type: "text" as const, text: "B" }], isError: false, timestamp: 4 };
  const placed = withEffectiveMemory([user("go"), call, r1, r2], note, session);
  assert.equal(injectedCarrierIndex(placed), 1);
  assert.equal(placed[2], call);
  assert.equal(placed[3], r1);
  assert.equal(placed[4], r2);
  clearMemoryAnchors();
});

test("ordinary leaf/revision growth does not move unchanged rendered M", async t => {
  let ctx: ExtensionContext | undefined;
  let surface: MemorySurface | undefined;
  const f = await fixture({
    flagValues: [["nunc-memory-tools", "true"]],
    extras: [{ name: "stable-revision", factory(pi) {
      pi.on("session_start", (_event, next) => { ctx = next; });
      surface = memorySurface(pi);
    } }],
  });
  t.after(() => f.close());
  assert(ctx && surface);
  assert.equal(surface.patch(ctx, { expectedRevision: surface.read(ctx).revision, add: [{ key: "k", text: "stable body" }] }).ok, true);
  const revision1 = surface.read(ctx).revision;
  await f.runtime.session.prompt("first");
  const index1 = injectedCarrierIndex(f.calls[0]!.messages);
  const rendered1 = renderMemory(surface.read(ctx).memory.slots);
  await f.runtime.session.prompt("second");
  const revision2 = surface.read(ctx).revision;
  const index2 = injectedCarrierIndex(f.calls[1]!.messages);
  assert.notEqual(revision1, revision2);
  assert.match(revision2, /\n/);
  assert.equal(renderMemory(surface.read(ctx).memory.slots), rendered1);
  assert.equal(index1, 1);
  assert.equal(index2, index1);
  assert.notEqual(index2, f.calls[1]!.messages.length - 1);
});

test("no-op, invalid, conflict and cancelled patches do not relocate a stable M", async t => {
  let ctx: ExtensionContext | undefined;
  let surface: MemorySurface | undefined;
  const f = await fixture({
    flagValues: [["nunc-memory-tools", "true"]],
    extras: [{ name: "stable-cas", factory(pi) {
      pi.on("session_start", (_event, next) => { ctx = next; });
      surface = memorySurface(pi);
    } }],
  });
  t.after(() => f.close());
  assert(ctx && surface);
  const patchTool = (f.runtime.session as any).getToolDefinition("nunc_memory_patch");
  assert.equal(surface.patch(ctx, { expectedRevision: surface.read(ctx).revision, add: [{ key: "k", text: "keep" }] }).ok, true);
  await f.runtime.session.prompt("anchor");
  const index = injectedCarrierIndex(f.calls.at(-1)!.messages);
  const revision = surface.read(ctx).revision;
  const noop = surface.patch(ctx, { expectedRevision: revision, update: [{ id: "s1", text: "keep" }] });
  assert.equal(noop.ok, true);
  const invalid = surface.patch(ctx, { expectedRevision: revision, update: [{ id: "missing", text: "no" }] });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, "invalid");
  const conflict = surface.patch(ctx, { expectedRevision: "not\na\nreal\nrevision", add: [{ key: "x", text: "no" }] });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, "conflict");
  const controller = new AbortController();
  controller.abort();
  const cancelled = await patchTool.execute("cancel-1", { expectedRevision: surface.read(ctx).revision, add: [{ key: "y", text: "no" }] }, controller.signal, undefined, ctx);
  assert.equal(cancelled.isError, true);
  await f.runtime.session.prompt("still stable");
  assert.equal(injectedCarrierIndex(f.calls.at(-1)!.messages), index);
  assert.equal(renderMemory(surface.read(ctx).memory.slots), renderMemory([{ id: "s1", text: "keep" }]));
});

test("UI read does not create or advance a request anchor", async t => {
  let ctx: ExtensionContext | undefined;
  let surface: MemorySurface | undefined;
  let view: ReturnType<typeof contextSurface>;
  const f = await fixture({
    flagValues: [["nunc-memory-tools", "true"]],
    extras: [{ name: "stable-ui", factory(pi) {
      pi.on("session_start", (_event, next) => { ctx = next; });
      surface = memorySurface(pi);
      view = contextSurface(pi);
    } }],
  });
  t.after(() => f.close());
  assert(ctx && surface && view);
  assert.equal(surface.patch(ctx, { expectedRevision: surface.read(ctx).revision, add: [{ key: "k", text: "unread" }] }).ok, true);
  const before = view.read(ctx);
  assert.equal(before.current.layout.memory?.slots[0]?.text, "unread");
  assert.equal(before.current.layout.memoryIndex, undefined);
  assert.equal(peekMemoryAnchor(ctx.sessionManager.getSessionId()), undefined);
  assert.equal(f.calls.length, 0);
  await f.runtime.session.prompt("now send");
  const after = view.read(ctx);
  assert.equal(after.current.layout.memoryIndex, 1);
  assert.equal(f.calls.length, 1);
});

test("native transformMessages does not synthesize missing results when M sits before a complete parallel tool group", () => {
  clearMemoryAnchors();
  const session = { sessionId: "s-serialize" };
  const note = memory([{ id: "s1", text: "note" }]);
  withEffectiveMemory([user("go")], note, session);
  const model = openaiProvider().getModels().find(m => m.id === "gpt-4o")!;
  const call = {
    role: "assistant" as const,
    content: [
      { type: "toolCall" as const, id: "a", name: "one", arguments: {} },
      { type: "toolCall" as const, id: "b", name: "two", arguments: {} },
    ],
    timestamp: 2,
    stopReason: "toolUse" as const,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const r1 = { role: "toolResult" as const, toolCallId: "a", toolName: "one", content: [{ type: "text" as const, text: "A" }], isError: false, timestamp: 3 };
  const r2 = { role: "toolResult" as const, toolCallId: "b", toolName: "two", content: [{ type: "text" as const, text: "B" }], isError: false, timestamp: 4 };
  const placed = withEffectiveMemory([user("go"), call, r1, r2], note, session);
  assert.equal(injectedCarrierIndex(placed), 1);
  const serialized = transformMessages(placed as Message[], model);
  assert.equal(serialized.filter(message => JSON.stringify(message).includes("No result provided")).length, 0);
  assert.equal(serialized.filter(message => message.role === "toolResult").length, 2);
  clearMemoryAnchors();
});

test("native Responses follow-up keeps a unique M that is not the last input item", { timeout: 15000 }, async t => {
  const bodies: any[] = [];
  let ctx: ExtensionContext | undefined;
  let surface: MemorySurface | undefined;
  const f = await fixture({
    flagValues: [["nunc-memory-tools", "true"]],
    extras: [{ name: "stable-wire", factory(pi) {
      pi.on("session_start", (_event, next) => { ctx = next; });
      surface = memorySurface(pi);
    } }],
  });
  t.after(() => f.close());
  const native = openaiProvider();
  const model = native.getModels().find(m => m.id === "gpt-4o")!;
  const fetch: typeof globalThis.fetch = async (resource, init) => {
    const body = await new Request(resource, init).json();
    bodies.push(body);
    const item = { type: "message", id: `msg-${bodies.length}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: `r${bodies.length}`, annotations: [] }] };
    const events = [
      { type: "response.created", response: { id: `r${bodies.length}`, model: model.id, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: `r${bodies.length}`, model: model.id, status: "completed", output: [item], usage: { input_tokens: 40, output_tokens: 4, total_tokens: 44, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
    ];
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  };
  const bound = { apiKey: "offline-fixture", fetch, maxRetries: 0 as const };
  const provider: Provider = {
    ...native,
    stream: (m, c, o) => native.stream(m as Model<"openai-responses">, c, { ...o, ...bound } as Parameters<typeof native.stream>[2]),
    streamSimple: (m, c, o) => native.streamSimple(m as Model<"openai-responses">, c, { ...o, ...bound }),
  };
  new ModelRegistry(f.modelRuntime).registerProvider(provider);
  await f.modelRuntime.setRuntimeApiKey(model.provider, "offline-fixture");
  await f.runtime.session.setModel(model);
  assert(ctx && surface);
  assert.equal(surface.patch(ctx, { expectedRevision: surface.read(ctx).revision, add: [{ key: "k", text: "wire-note" }] }).ok, true);
  await f.runtime.session.prompt("first");
  await f.runtime.session.prompt("second");
  assert.equal(bodies.length, 2);
  const follow = JSON.stringify(bodies[1]);
  assert(follow.includes("wire-note"));
  assert(!follow.includes("No result provided"));
  const input = bodies[1]!.input as unknown[];
  const hits = input.filter(item => JSON.stringify(item).includes("wire-note"));
  assert.equal(hits.length, 1);
  assert.notEqual(input.findIndex(item => JSON.stringify(item).includes("wire-note")), input.length - 1);
});

test("lookalike user text stays in R while the unique injected carrier is M", async t => {
  const admissions: AdmissionObservation[] = [];
  let ctx: ExtensionContext | undefined;
  let surface: MemorySurface | undefined;
  const f = await fixture({
    flagValues: [["nunc-memory-tools", "true"]],
    extras: [{ name: "stable-lookalike", factory(pi) {
      pi.events.on("nunc:admission", value => admissions.push(value as AdmissionObservation));
      pi.on("session_start", (_event, next) => { ctx = next; });
      surface = memorySurface(pi);
    } }],
  });
  t.after(() => f.close());
  assert(ctx && surface);
  assert.equal(surface.patch(ctx, { expectedRevision: surface.read(ctx).revision, add: [{ key: "k", text: "real note" }] }).ok, true);
  const lookalike = `Nunc working memory (session-local, reference only):\n[{"id":"fake","text":"I am a genuine user instruction, not a carrier"}]`;
  await f.runtime.session.prompt(lookalike);
  await f.runtime.session.prompt("follow");
  const follow = f.calls.at(-1)!;
  const carrier = injectedCarrierIndex(follow.messages);
  assert.equal(typeof carrier, "number");
  assert(JSON.stringify(follow.messages[carrier!]).includes("real note"));
  assert(follow.messages.some((m, i) => i !== carrier && JSON.stringify(m).includes("I am a genuine user instruction")));
  const last = admissions.filter(o => o.kind === "main").at(-1)!;
  assert.equal(last.outcome, "delegate");
  assert(last.receiptBreakdown?.currentMTokens! > 0);
});
