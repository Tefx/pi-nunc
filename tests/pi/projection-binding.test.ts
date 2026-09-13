import { test } from "node:test";
import assert from "node:assert/strict";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { Context, Model, Provider } from "@earendil-works/pi-ai";
import { ModelRegistry, type ExtensionContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AdmissionObservation } from "../../src/pi/admission.js";
import { memorySurface, type MemorySurface } from "../../src/pi/manual.js";
import { admissionEstimate, memoryTokens, textTokens } from "../../src/engine/accounting.js";
import { isNuncCarrier } from "../../src/pi/projection.js";
import { contextSurface, type ContextSurface } from "../../src/pi/context.js";
import { fixture } from "./fixtures.js";

// Only transport is controlled: the loader, context hooks, Provider and native
// Responses serializer all execute. Both provider methods use this fetch.
async function nativeFixture(t: { after: (f: () => Promise<void>) => void }, hook?: (pi: ExtensionAPI) => void) {
  const observations: AdmissionObservation[] = [];
  const bodies: any[] = [];
  const contexts: Context[] = [];
  let ctx: ExtensionContext;
  let surface: MemorySurface;
  let contextView: ContextSurface;
  let nested: ((model: Model<any>, context: Context, options: any) => Promise<void>) | undefined;
  const f = await fixture({ extras: [{ name: "projection-binding-observer", factory(pi) {
    pi.events.on("nunc:admission", v => observations.push(v as AdmissionObservation));
    pi.on("session_start", (_e, c) => { ctx = c; });
    surface = memorySurface(pi)!;
    contextView = contextSurface(pi)!;
    hook?.(pi);
  } }] });
  t.after(() => f.close());
  const native = openaiProvider();
  const model = native.getModels().find(m => m.id === "gpt-4o")!;
  assert(model);
  const fetch: typeof globalThis.fetch = async (resource, init) => {
    bodies.push(await new Request(resource, init).json());
    const id = `response-${bodies.length}`;
    const item = { type: "message", id: `msg-${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: id, annotations: [] }] };
    const events = [
      { type: "response.created", response: { id, model: model.id, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id, model: model.id, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 7, total_tokens: 107, input_tokens_details: { cached_tokens: 30 }, output_tokens_details: { reasoning_tokens: 2 } } } },
    ];
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  };
  const bound = { apiKey: "offline-fixture", fetch, maxRetries: 0 as const };
  const provider: Provider = {
    ...native,
    stream: (m, c, o) => native.stream(m as Model<"openai-responses">, c, { ...o, ...bound } as Parameters<typeof native.stream>[2]),
    streamSimple: (m, c, o) => {
      contexts.push(c);
      // A composed provider may start an independent call during delegation.
      // Pause its native onPayload while awaiting the nested controlled call.
      const work = nested;
      nested = undefined;
      const promise = work?.(m, c, o);
      return native.streamSimple(m as Model<"openai-responses">, c, { ...o, ...bound, onPayload: async (payload, selected) => {
        await promise;
        return o?.onPayload?.(payload, selected);
      } });
    },
  };
  new ModelRegistry(f.modelRuntime).registerProvider(provider);
  await f.modelRuntime.setRuntimeApiKey(model.provider, "offline-fixture");
  await f.runtime.session.setModel(model);
  return { f, model, observations, bodies, contexts, ctx: () => ctx!, surface: () => surface!, view: () => contextView!.read(ctx!), nest: (fn: NonNullable<typeof nested>) => { nested = fn; },
    last: () => observations.filter(v => v.kind === "main").at(-1)!,
    note: (text: string) => {
      const view = surface!.read(ctx!);
      const result = surface!.patch(ctx!, { expectedRevision: view.revision, ...(view.memory.slots.length ? { update: [{ id: "s1", text }] } : { add: [{ key: "note", text }] }) });
      assert.equal(result.ok, true);
    },
  };
}

for (const hasM of [false, true]) test(`native projection survives earlier unknown raw/simple calls; empty M=${!hasM}`, { timeout: 15000 }, async t => {
  let independent = true;
  const n = await nativeFixture(t, pi => {
    pi.on("context", async (_event: unknown, ctx: ExtensionContext) => {
      if (!independent) return;
      independent = false;
      const provider = ctx.modelRegistry.getProvider(ctx.model!.provider)!;
      const context: Context = { messages: [{ role: "user", content: "independent", timestamp: 0 }] };
      const simple = await provider.streamSimple(ctx.model!, context, { signal: new AbortController().signal, sessionId: ctx.sessionManager.getSessionId() }).result();
      assert.equal(simple.stopReason, "stop");
      const raw = await provider.stream(ctx.model!, context, { signal: ctx.signal, maxTokens: 100 }).result();
      assert.equal(raw.stopReason, "stop");
    });
  });
  if (hasM) n.note("initial M");
  await n.f.runtime.session.prompt("bound first request");
  await n.f.runtime.session.prompt("bound next request");
  assert.equal(n.bodies.length, 4);
  assert.equal(n.observations.filter(o => o.kind === "unknown").length, 2);
  assert.equal(n.last().estimator, "pi-usage-backed");
  assert.equal(n.last().receiptBreakdown?.observedU, 107);
  assert.equal(n.last().receiptBreakdown?.currentMTokens, memoryTokens(n.surface().read(n.ctx()).memory.slots));
  assert.equal(n.last().receiptBreakdown?.retainedOldMMargin, hasM);
});

for (const hasM of [false, true]) test(`native independent nested Context and repeated call cannot inherit projection; empty M=${!hasM}`, { timeout: 15000 }, async t => {
  const n = await nativeFixture(t);
  if (hasM) n.note("bound M");
  await n.f.runtime.session.prompt("first receipt");
  let nestedObservation: AdmissionObservation | undefined;
  let held: { context: Context; options: any } | undefined;
  n.nest(async (model, context, options) => {
    held = { context, options };
    const provider = n.ctx().modelRegistry.getProvider(model.provider)!;
    // Same R/M objects and same signal/session, but a distinct Context invocation.
    const nestedOptions = { ...options, onPayload: undefined };
    const result = await provider.streamSimple(model, { ...context }, nestedOptions).result();
    assert.equal(result.stopReason, "stop");
    nestedObservation = n.last();
    const repeated = await provider.streamSimple(model, context, nestedOptions).result();
    assert.equal(repeated.stopReason, "stop");
    assert.equal(n.last().estimator, "pi-heuristic");
    assert.equal(n.last().estimateReason, "messages-mismatch");
  });
  await n.f.runtime.session.prompt("second receipt with nested request");
  assert.equal(nestedObservation?.estimator, "pi-heuristic");
  assert.equal(nestedObservation?.estimateReason, "messages-mismatch");
  // Replaying the consumed projection after the ALS run is also unassociated.
  assert(held);
  const result = await n.ctx().modelRegistry.getProvider(n.model.provider)!.streamSimple(n.model, held.context, { ...held.options, signal: n.ctx().signal }).result();
  assert.equal(result.stopReason, "stop");
  await n.f.runtime.session.prompt("genuine next projection");
  assert.equal(n.last().estimator, "pi-usage-backed");
  assert.equal(n.last().receiptBreakdown?.currentMTokens, memoryTokens(n.surface().read(n.ctx()).memory.slots));
});

test("native later context hook edits the identical carrier before serialization: full fresh accounting, no receipt, overlarge zero-send", { timeout: 15000 }, async t => {
  let replacement: string | undefined;
  const n = await nativeFixture(t, pi => {
    pi.on("context", event => {
      if (replacement === undefined) return;
      const carrier = event.messages.find(message => isNuncCarrier(message));
      assert(carrier);
      assert.equal(carrier.role, "user");
      if (carrier.role !== "user") throw new Error("Expected native user carrier");
      carrier.content = [{ type: "text", text: replacement }];
      return { messages: event.messages };
    });
  });
  n.note("small M");
  await n.f.runtime.session.prompt("establish small receipt");
  replacement = "changed before native serialization ".repeat(1000);
  await n.f.runtime.session.prompt("mutated carrier request");
  const changed = n.last();
  assert.equal(changed.estimator, "pi-heuristic");
  assert.equal(changed.estimateReason, "messages-mismatch");
  assert.equal(changed.payload?.mode, "identity", "onPayload cannot detect an earlier Context mutation");
  assert.equal(changed.inputTokens, admissionEstimate(n.contexts.at(-1)!, n.model).tokens + textTokens("{}"));
  const mutatedText = replacement ?? "";
  assert(JSON.stringify(n.bodies.at(-1)).includes(mutatedText));
  replacement = "x".repeat(600000);
  await n.f.runtime.session.prompt("oversized mutated carrier");
  assert.equal(n.last().code, "CAPACITY");
  assert.equal(n.last().estimator, "pi-heuristic");
  assert.equal(n.bodies.length, 2);
  replacement = undefined;
  await n.f.runtime.session.prompt("restore genuine projection");
  assert.equal(n.last().receiptBreakdown?.observedU, 107);
  assert(n.last().anchorTrailingMessages! >= 2, "mutated carrier response never became a receipt");
  const restoredBody = JSON.stringify(n.bodies.at(-1));
  assert(restoredBody.includes(n.surface().read(n.ctx()).memory.slots[0]!.text));
  assert(!restoredBody.includes("changed before native serialization"));
});

test("native in-flight M update leaves Last main on sent M, Current on new M, and next receipt uses full new M", { timeout: 15000 }, async t => {
  const n = await nativeFixture(t);
  n.note("sent M1");
  const old = n.surface().read(n.ctx()).memory;
  n.nest(async () => { n.note("current M2 with additional detail"); });
  await n.f.runtime.session.prompt("send old M while next M is committed");
  const view = n.view();
  assert.deepEqual(view.lastMain?.layout.memory?.slots, old.slots);
  assert.equal(view.lastMain?.layout.messages.length, 1);
  assert.deepEqual(view.current.layout.memory?.slots, n.surface().read(n.ctx()).memory.slots);
  assert.equal(view.lastMain?.layout.memory?.tokens, memoryTokens(old.slots));
  const entries = n.f.runtime.session.sessionManager.getEntries().length;
  const sends = n.bodies.length;
  n.view();
  assert.equal(n.bodies.length, sends);
  assert.equal(n.f.runtime.session.sessionManager.getEntries().length, entries);
  await n.f.runtime.session.prompt("next constructed M2");
  assert.equal(n.last().estimator, "pi-usage-backed");
  assert.equal(n.last().receiptBreakdown?.oldMTokensEstimate, memoryTokens(old.slots));
  assert.equal(n.last().receiptBreakdown?.currentMTokens, n.view().lastMain?.layout.memory?.tokens);
  assert.equal(n.last().receiptBreakdown?.currentMTokens, n.view().current.layout.memory?.tokens);
});

for (const hasM of [false, true]) test(`native complete clone loses M association and cannot mint a receipt; empty M=${!hasM}`, { timeout: 15000 }, async t => {
  let clone = true;
  const n = await nativeFixture(t, pi => {
    pi.on("context", event => clone ? { messages: structuredClone(event.messages) } : undefined);
  });
  if (hasM) n.note("M whose text does not prove provenance");
  await n.f.runtime.session.prompt("unassociated clone");
  assert.equal(n.last().estimateReason, "messages-mismatch");
  clone = false;
  await n.f.runtime.session.prompt("first associated request");
  assert.equal(n.last().estimator, "pi-heuristic");
  await n.f.runtime.session.prompt("second associated request");
  assert.equal(n.last().estimator, "pi-usage-backed");
});
