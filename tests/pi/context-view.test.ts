import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, type Context, type Model, type Provider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { ModelRegistry, ModelRuntime, type ExtensionAPI, type ExtensionContext, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { bindHostSettings, contextSurface, memorySurface, type ContextSurface, type MemorySurface } from "pi-nunc/pi";
import { emptyMemory } from "../../src/engine/index.js";
import { mainContext, memoryTokens, requestTokens, textTokens } from "../../src/engine/accounting.js";
import { Admission, type AdmissionObservation } from "../../src/pi/admission.js";
import { createContextSurface } from "../../src/pi/context.js";
import { engineConfig } from "../../src/pi/config.js";
import { applyLastUserTextAppend } from "../../src/pi/payload.js";
import { project } from "../../src/pi/projection.js";
import { SYNTHETIC_LAST_USER_APPEND } from "../../src/live/append.js";
import { SYNTHETIC_LAST_USER_APPEND_B } from "../../src/live/append-b.js";
import { answer } from "../engine/fixtures.js";
import { fixture, memoryPatch } from "./fixtures.js";

const LONG = "Exact body 中文 🦉\n" + "z".repeat(4000);
const HOOK_A = "HOOK_A_TEMP_INJECTION";
const HOOK_B = "HOOK_B_TEMP_INJECTION";
const QUEUED = "queued-D-not-in-layout";

function port(admissions: AdmissionObservation[] = []): {
  extras: InlineExtension[];
  memory: () => MemorySurface;
  context: () => ContextSurface;
  ctx: () => ExtensionContext;
  pi: () => ExtensionAPI;
  admissions: AdmissionObservation[];
} {
  let api: ExtensionAPI | undefined;
  let ctx: ExtensionContext | undefined;
  return {
    extras: [{ name: "nunc-context-port", factory(pi) {
      api = pi;
      pi.on("session_start", (_event, next) => { ctx = next; });
      pi.events.on("nunc:admission", value => admissions.push(value as AdmissionObservation));
    } }],
    memory() { const value = memorySurface(api!); assert(value); return value; },
    context() { const value = contextSurface(api!); assert(value); return value; },
    ctx() { assert(ctx); return ctx; },
    pi() { assert(api); return api; },
    admissions,
  };
}

async function prepared(t: { after: (fn: () => Promise<void>) => void }, options: Parameters<typeof fixture>[0] = {}, admissions: AdmissionObservation[] = []) {
  const captured = port(admissions);
  const f = await fixture({ ...options, extras: [...(options.extras ?? []), ...captured.extras] });
  t.after(() => f.close());
  return { f, ...captured };
}

test("current F/M/R counts, tool association, packaging, and long bodies stay original", async t => {
  const { f, memory, context, ctx, pi } = await prepared(t);
  f.seed(); f.respond(memoryPatch);
  await f.runtime.session.compact();
  const manager = f.runtime.session.sessionManager;
  manager.appendMessage({ role: "user", content: LONG, timestamp: 2 });
  manager.appendMessage({ ...answer({}, f.faux.getModel()), stopReason: "toolUse", content: [{ type: "thinking", thinking: "Need the file" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "fixture.txt", exact: "ARG_BODY" } }] });
  manager.appendMessage({ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "TOOL_BODY_ORIGINAL" }], isError: false, timestamp: 0 });
  f.runtime.session.agent.state.messages = manager.buildSessionContext().messages;
  const before = manager.getEntries().length;
  const view = context().read(ctx());
  const mem = memory().read(ctx());
  assert.equal(view.current.revision, mem.revision);
  assert.deepEqual(view.current.layout.memory?.slots, mem.memory.slots);
  assert.equal(view.current.contextLayout.slotCount, mem.contextLayout.slotCount);
  assert.equal(view.current.layout.messageCount, view.current.layout.messages.length);
  assert.equal(view.current.layout.blockCount, view.current.layout.messages.reduce((n, message) => n + message.blocks.length, 0));
  assert.notEqual(view.current.layout.messageCount, view.current.layout.blockCount);
  const long = view.current.layout.messages.find(message => message.blocks.some(block => block.text === LONG));
  assert(long);
  assert.equal(long.blocks.find(block => block.type === "text")?.text, LONG);
  const assoc = view.current.layout.associations.find(item => item.toolCallId === "c1");
  assert(assoc);
  assert.equal(assoc.toolName, "read");
  const call = view.current.layout.messages[assoc.callOrder]!;
  const result = view.current.layout.messages[assoc.resultOrder]!;
  assert.equal(call.blocks.some(block => block.type === "toolCall" && block.arguments && (block.arguments as { exact?: string }).exact === "ARG_BODY"), true);
  assert.equal(result.toolCallId, "c1");
  assert.equal(result.blocks.some(block => block.text === "TOOL_BODY_ORIGINAL"), true);
  const projected = project(manager.buildContextEntries());
  const expected = requestTokens(mainContext({ systemPrompt: ctx().getSystemPrompt(), tools: pi().getActiveTools().map(name => {
    const tool = pi().getAllTools().find(item => item.name === name);
    assert(tool);
    return { name, description: tool.description, parameters: tool.parameters };
  }) }, projected.memory.slots, projected.active));
  assert.equal(view.current.layout.heuristic.unknown, false);
  assert.equal(view.current.layout.heuristic.tokens, expected);
  assert.equal(view.current.layout.memory?.tokens, memoryTokens(projected.memory.slots));
  assert.equal(manager.getEntries().length, before);
  assert.equal(f.faux.state.callCount, 1);
  manager.appendMessage({ role: "user", content: [{ type: "text", text: "see" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 3 });
  f.runtime.session.agent.state.messages = manager.buildSessionContext().messages;
  const imaged = context().read(ctx());
  const image = imaged.current.layout.messages.flatMap(message => message.blocks).find(block => block.type === "image");
  assert(image);
  assert.equal(image.tokens, null);
  assert.equal(image.unknown, true);
  assert.equal(imaged.current.layout.heuristic.unknown, true);
  assert.notEqual(imaged.current.layout.heuristic.tokens, 0);
});

test("manual M revision matches the memory surface; model change keeps last-main labels", async t => {
  const admissions: AdmissionObservation[] = [];
  const { f, memory, context, ctx } = await prepared(t, {}, admissions);
  f.seed(); f.respond(memoryPatch);
  await f.runtime.session.compact();
  f.respond(() => fauxAssistantMessage("Prefix established."));
  await f.runtime.session.prompt("Establish usage prefix");
  await f.runtime.session.prompt("Same prefix");
  const anchored = context().read(ctx()).lastMain;
  assert.equal(anchored?.estimator, "pi-usage-backed");
  assert.notEqual(anchored?.layout.heuristic.tokens, null);
  const view = memory().read(ctx());
  assert.equal(memory().replace(ctx(), view.revision, view.memory.slots[0]!.id, "Edited for context view.").ok, true);
  const after = context().read(ctx());
  assert.equal(after.current.revision, memory().read(ctx()).revision);
  assert.equal(after.current.layout.memory?.slots[0]?.text, "Edited for context view.");
  f.respond(() => fauxAssistantMessage("After attribution cut."));
  await f.runtime.session.prompt("First constructed request after save");
  const fresh = context().read(ctx()).lastMain;
  assert.equal(fresh?.estimator, "pi-heuristic");
  const previousModel = fresh?.model.id;
  await f.runtime.session.setModel(f.faux.getModel("small")!);
  const switched = context().read(ctx());
  assert.equal(switched.current.model?.id, "small");
  assert.equal(switched.lastMain?.model.id, previousModel);
  assert.notEqual(switched.lastMain?.model.id, switched.current.model?.id);
});

test("planned and enforced limits stay distinct; plan overrun can still delegate", async t => {
  let pad = "";
  const { f, context, ctx } = await prepared(t, { extras: [{ name: "pad-plan", factory(pi) {
    pi.on("context", event => pad ? { messages: [...event.messages, { role: "user", content: pad, timestamp: 9 }] } : undefined);
  } }] });
  f.seed(); f.respond(memoryPatch);
  await f.runtime.session.compact();
  const budget = context().read(ctx());
  assert.notEqual(budget.current.budget.plannedInputLimit, null);
  assert.notEqual(budget.current.budget.mainAdmissionLimit, null);
  assert.notEqual(budget.current.budget.extractionInputLimit, null);
  assert(budget.current.budget.plannedInputLimit! < budget.current.budget.mainAdmissionLimit!);
  assert.equal(budget.current.budget.extractionOutputCapTokens, budget.current.budget.extractionOutputTokens);
  assert.equal(budget.current.budget.extractionOutputCapKnown, true);
  assert.equal(budget.current.budget.outputCapKnown, false);
  const current = budget.current.layout.heuristic.tokens ?? 0;
  const target = Math.min(budget.current.budget.plannedInputLimit! + 256, budget.current.budget.mainAdmissionLimit! - 256);
  pad = "n".repeat(Math.max(4, (target - current) * 4));
  f.respond(() => fauxAssistantMessage("Delegated past the planning target."));
  await f.runtime.session.prompt("Stay under the main guard");
  const last = context().read(ctx()).lastMain;
  assert.equal(last?.outcome, "delegate");
  assert.equal(last?.inputExceededPlan, true);
  assert(last?.inputTokens !== undefined && last.inputLimit !== undefined && last.inputTokens <= last.inputLimit);
  assert.equal(f.faux.state.callCount > 0, true);
});

test("rejected requests are not sent; candidate is not saved; fail/cancel have no after layout", async t => {
  const { f, context, ctx } = await prepared(t, { extras: [{ name: "oversize", factory(pi) {
    pi.on("context", event => ({ messages: [...event.messages, { role: "user", content: "n".repeat(320000), timestamp: 3 }] }));
  } }] });
  await f.runtime.session.prompt("Stay within the current model");
  const rejected = context().read(ctx()).lastMain;
  assert.equal(rejected?.outcome, "reject");
  assert.equal(f.faux.state.callCount, 0);
  const { f: g, context: context2, ctx: ctx2 } = await prepared(t);
  g.seed(); g.respond(memoryPatch);
  await g.runtime.session.compact();
  const saved = context2().read(ctx2());
  assert.equal(saved.lastMaintenance?.engine, "ok");
  assert.equal(saved.lastMaintenance?.native, "saved");
  assert(saved.lastMaintenance?.after);
  assert(saved.lastMaintenance.cut?.retiredEntryIds.length);
  assert.deepEqual(saved.current.layout.entries?.map(entry => entry.entryId), saved.lastMaintenance.cut?.keptEntryIds);
  const retired = saved.lastMaintenance.cut!.retiredEntryIds[0]!;
  assert(saved.lastMaintenance.before.entries.some(entry => entry.entryId === retired && entry.messages.some(message => message.blocks.length > 0)));
  assert.equal(saved.current.layout.entries?.some(entry => entry.entryId === retired), false);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  g.seed("freeze");
  g.respond(async context => { started.resolve(); await release.promise; return memoryPatch(context); });
  const compacting = g.runtime.session.compact();
  await started.promise;
  const pending = context2().read(ctx2());
  assert.equal(pending.lastMaintenance?.native, "pending");
  assert.equal(pending.lastMaintenance?.engine, undefined);
  assert.equal(pending.lastMaintenance?.after, undefined);
  assert(pending.lastMaintenance?.cut?.firstKeptEntryId);
  assert.equal(pending.lastMaintenance.cut.retiredEntryIds.length > 0, true);
  g.runtime.session.abortCompaction();
  release.resolve();
  await Promise.allSettled([compacting]);
  const cancelled = context2().read(ctx2());
  assert.equal(cancelled.lastMaintenance?.engine, "cancel");
  assert.equal(cancelled.lastMaintenance?.native, "failed");
  assert.equal(cancelled.lastMaintenance?.after, undefined);
  g.seed("invalid");
  g.respond(() => fauxAssistantMessage("broken"));
  await assert.rejects(g.runtime.session.compact(), /cancel/i);
  const failed = context2().read(ctx2());
  assert.equal(failed.lastMaintenance?.engine, "fail");
  assert.equal(failed.lastMaintenance?.native, "failed");
  assert.equal(failed.lastMaintenance?.after, undefined);
  assert(failed.lastMaintenance?.cut?.firstKeptEntryId);
});

test("later hooks appear only on last-main; independent calls and queued D stay out of current/maintenance", async t => {
  const { f, context, ctx } = await prepared(t, { extras: [
    { name: "hook-a", factory(pi) { pi.on("context", event => ({ messages: [...event.messages, { role: "user", content: HOOK_A, timestamp: 9 }] })); } },
    { name: "hook-b", factory(pi) {
      pi.on("context", async (event, ctx) => {
        await ctx.modelRegistry.complete(ctx.model!, { messages: [{ role: "user", content: "Independent controlled side request", timestamp: 1 }] }, { maxTokens: 64 });
        return { messages: [...event.messages, { role: "user", content: HOOK_B, timestamp: 10 }] };
      });
    } },
  ] });
  f.seed(); f.respond(memoryPatch);
  await f.runtime.session.compact();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.respond(async context => {
    if (JSON.stringify(context.messages).includes("visible delivered")) {
      started.resolve();
      await release.promise;
      return fauxAssistantMessage("In-flight turn.");
    }
    return memoryPatch(context);
  });
  const turn = f.runtime.session.prompt("visible delivered");
  await started.promise;
  await f.runtime.session.followUp(QUEUED);
  const during = context().read(ctx());
  assert.equal(JSON.stringify(during.current.layout).includes(QUEUED), false);
  assert.equal(during.current.layout.messages.some(message => JSON.stringify(message).includes("visible delivered")), true);
  release.resolve();
  await turn;
  const after = context().read(ctx());
  assert(after.lastMain);
  assert.equal(JSON.stringify(after.lastMain.layout).includes(HOOK_A), true);
  assert.equal(JSON.stringify(after.lastMain.layout).includes(HOOK_B), true);
  assert.equal(JSON.stringify(after.lastMain.layout).includes("Independent controlled side request"), false);
  assert.equal(JSON.stringify(after.current.layout).includes(HOOK_A), false);
  assert.equal(JSON.stringify(after.current.layout).includes(HOOK_B), false);
  f.seed("after-hooks");
  f.respond(memoryPatch);
  await f.runtime.session.compact();
  const maintained = context().read(ctx());
  assert.equal(JSON.stringify(maintained.lastMaintenance?.before).includes(HOOK_A), false);
  assert.equal(JSON.stringify(maintained.lastMaintenance?.before).includes(HOOK_B), false);
});

test("native serializer last-user appends are observed without diagnostic bodies; unmapped rewrites reject", async t => {
  const catalog = openaiProvider().getModels().find(m => m.id === "gpt-4.1");
  assert(catalog);
  let sends = 0;
  const admissions: AdmissionObservation[] = [];
  const openai = openaiProvider();
  const transport: typeof fetch = async (resource, init) => {
    sends++;
    await new Request(resource, init).json();
    const item = { type: "message", id: "msg-1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Controlled native response.", annotations: [] }] };
    const events = [
      { type: "response.created", response: { id: "response-1", model: catalog.id, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Controlled native response." },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "response-1", model: catalog.id, status: "completed", output: [item], usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
    ];
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  };
  const bound = { apiKey: "offline-fixture-key", fetch: transport, maxRetries: 0 as const };
  const wrapped: Provider = {
    ...openai,
    streamSimple: (model, context, options) => openai.streamSimple(model as Model<"openai-responses">, context, { ...options, ...bound }),
    stream: (model, context, options) => openai.stream(model as Model<"openai-responses">, context, { ...options, ...bound } as Parameters<typeof openai.stream>[2]),
  };
  const captured = port(admissions);
  const f = await fixture({
    config: { budget: { inputLimit: 8000 } },
    extras: [
      ...captured.extras,
      { name: "append", factory(pi) { pi.on("before_provider_request", event => {
        const first = applyLastUserTextAppend(event.payload, SYNTHETIC_LAST_USER_APPEND);
        return first.changed ? first.payload : undefined;
      }); } },
      { name: "append-b", factory(pi) { pi.on("before_provider_request", event => {
        const second = applyLastUserTextAppend(event.payload, SYNTHETIC_LAST_USER_APPEND_B);
        return second.changed ? second.payload : undefined;
      }); } },
    ],
  });
  t.after(() => f.close());
  new ModelRegistry(f.modelRuntime).registerProvider(wrapped);
  await f.modelRuntime.setRuntimeApiKey("openai", "offline-fixture-key");
  await f.runtime.session.setModel(catalog);
  await f.runtime.session.prompt("Native last-user append request");
  assert.equal(sends, 1);
  const last = captured.context().read(captured.ctx()).lastMain;
  assert.equal(last?.outcome, "delegate");
  assert.equal(last?.payload?.transform, "last-user-text-append");
  assert.equal(last?.payload?.addedText?.includes(SYNTHETIC_LAST_USER_APPEND), true);
  assert.equal(last?.payload?.addedText?.includes(SYNTHETIC_LAST_USER_APPEND_B), true);
  assert(last?.payload?.addedTokens !== undefined && last.payload.addedTokens >= textTokens(SYNTHETIC_LAST_USER_APPEND + SYNTHETIC_LAST_USER_APPEND_B));
  assert.equal(JSON.stringify(admissions).includes(SYNTHETIC_LAST_USER_APPEND), false);
  assert.equal(JSON.stringify(admissions).includes(SYNTHETIC_LAST_USER_APPEND_B), false);

  let replaceSends = 0;
  const replaceBound = { apiKey: "offline-fixture-key", fetch: (async (resource, init) => {
    replaceSends++;
    await new Request(resource, init).json();
    return new Response("", { status: 500 });
  }) as typeof fetch, maxRetries: 0 as const };
  const replaceProvider: Provider = {
    ...openai,
    streamSimple: (model, context, options) => openai.streamSimple(model as Model<"openai-responses">, context, { ...options, ...replaceBound }),
    stream: (model, context, options) => openai.stream(model as Model<"openai-responses">, context, { ...options, ...replaceBound } as Parameters<typeof openai.stream>[2]),
  };
  const replaced = port();
  const g = await fixture({
    extras: [
      ...replaced.extras,
      { name: "replace", factory(pi) { pi.on("before_provider_request", event => {
        const payload = event.payload as { input?: Array<{ role?: string; content?: unknown }>; messages?: Array<{ role?: string; content?: unknown }> };
        for (const list of [payload.input, payload.messages]) {
          const lastUser = list && [...list].reverse().find(message => message.role === "user");
          if (lastUser) lastUser.content = "replaced-not-append";
        }
      }); } },
    ],
  });
  t.after(() => g.close());
  new ModelRegistry(g.modelRuntime).registerProvider(replaceProvider);
  await g.modelRuntime.setRuntimeApiKey("openai", "offline-fixture-key");
  await g.runtime.session.setModel(catalog);
  await g.runtime.session.prompt("Unmapped rewrite");
  const rejected = replaced.context().read(replaced.ctx()).lastMain;
  assert.equal(rejected?.outcome, "reject", JSON.stringify(rejected?.payload));
  assert.equal(replaceSends, 0);
  assert.notEqual(rejected?.payload?.transform, "last-user-text-append");
  assert.equal(rejected?.payload?.unmappedIncrement?.unknown, true);
});

test("session/path/reload drop observations; read does not write or compact", async t => {
  const captured = port();
  const f = await fixture({ extras: captured.extras });
  t.after(() => f.close());
  f.seed(); f.respond(memoryPatch);
  await f.runtime.session.compact();
  f.respond(() => fauxAssistantMessage("Observed main."));
  await f.runtime.session.prompt("Keep this observation");
  assert(captured.context().read(captured.ctx()).lastMain);
  assert(captured.context().read(captured.ctx()).lastMaintenance);
  const calls = f.faux.state.callCount;
  const entries = f.runtime.session.sessionManager.getEntries().length;
  captured.context().read(captured.ctx());
  assert.equal(f.faux.state.callCount, calls);
  assert.equal(f.runtime.session.sessionManager.getEntries().length, entries);
  await f.runtime.newSession();
  const empty = captured.context().read(captured.ctx());
  assert.equal(empty.lastMain, undefined);
  assert.equal(empty.lastMaintenance, undefined);
  f.seed(); f.respond(memoryPatch);
  await f.runtime.session.compact();
  await f.runtime.session.prompt("Branch observation");
  const snapshot = f.runtime.session.sessionManager.getBranch().find(entry => entry.type === "compaction")?.parentId;
  assert(snapshot);
  await f.runtime.session.navigateTree(snapshot, { summarize: false });
  const other = captured.context().read(captured.ctx());
  assert.equal(other.lastMain, undefined);
  f.seed(); f.respond(memoryPatch);
  await f.runtime.session.compact();
  await f.runtime.session.prompt("Reload observation");
  await f.runtime.session.reload({ beforeSessionStart: () => { bindHostSettings(captured.pi().events, f.settings); } });
  const fresh = contextSurface(captured.pi());
  assert(fresh);
  const reloaded = fresh.read(captured.ctx());
  assert.equal(reloaded.lastMain, undefined);
  assert.equal(reloaded.lastMaintenance, undefined);
});

test("a throwing layout observer cannot change delegation or payload", async () => {
  const faux = fauxProvider({ api: "openai-completions", provider: "synthetic-review", models: [{ id: "synthetic", contextWindow: 60000, maxTokens: 8192 }] });
  faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("synthetic answer")));
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  registry.registerProvider(faux.provider);
  const model = faux.getModel();
  const signal = new AbortController().signal;
  const ctx = {
    model,
    signal,
    sessionManager: { getSessionId: () => "synthetic-session", getLeafId: () => "leaf" },
    modelRegistry: registry,
  } as unknown as ExtensionContext;
  const admission = new Admission({
    registerProvider(...args: Parameters<ModelRegistry["registerProvider"]>) { registry.registerProvider(...args); },
    unregisterProvider(id: string) { registry.unregisterProvider(id); },
    events: { emit() { /* diagnostic */ } },
  } as unknown as ExtensionAPI, () => engineConfig({}, model, { reserveTokens: 36000, keepRecentTokens: 1 }), () => { throw new Error("observer fault"); });
  admission.ensure(ctx);
  const provider = registry.getProvider(model.provider);
  assert(provider);
  const ok = await provider.streamSimple(model, { messages: [{ role: "user", content: "short synthetic input", timestamp: 1 }] }, { signal, sessionId: "synthetic-session" }).result();
  assert.equal(ok.stopReason, "stop", ok.errorMessage ?? "");
  assert.equal(faux.state.callCount, 1);
});

test("malformed content rejection replaces prior last-main instead of keeping a delegate", async t => {
  let breakIt = false;
  const { f, context, ctx } = await prepared(t, { extras: [{ name: "broken-content", factory(pi) {
    pi.on("context", event => breakIt ? { messages: [...event.messages, { role: "user", content: { broken: true }, timestamp: 4 } as never] } : undefined);
  } }] });
  f.respond(() => fauxAssistantMessage("ok"));
  await f.runtime.session.prompt("legal first request");
  const first = context().read(ctx()).lastMain;
  assert.equal(first?.outcome, "delegate");
  const calls = f.faux.state.callCount;
  breakIt = true;
  await f.runtime.session.prompt("illegal second request");
  const second = context().read(ctx()).lastMain;
  assert.equal(second?.outcome, "reject");
  assert.equal(second?.code, "INPUT");
  assert.notEqual(JSON.stringify(second), JSON.stringify(first));
  assert.equal(f.faux.state.callCount, calls);
});

test("tool definitions and frozen F survive later model change; snapshots stay detached", async t => {
  const { f, context, ctx } = await prepared(t, { tools: [{ name: "read", label: "Read", description: "Read complete file", parameters: Type.Object({ path: Type.String() }), execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) }] });
  f.seed(); f.respond(memoryPatch);
  const systemAtFreeze = ctx().getSystemPrompt();
  await f.runtime.session.compact();
  const saved = context().read(ctx());
  const tool = saved.current.layout.tools.definitions.find(item => item.name === "read");
  assert(tool);
  assert.equal(tool.description, "Read complete file");
  assert.notEqual(tool.tokens, null);
  assert.equal(tool.unknown, false);
  assert.equal(saved.lastMaintenance?.before.system.text, systemAtFreeze);
  assert.equal(saved.lastMaintenance?.before.tools.definitions.find(item => item.name === "read")?.description, "Read complete file");
  if (saved.lastMaintenance?.candidate?.memory.slots[0]) saved.lastMaintenance.candidate.memory.slots[0].text = "consumer-draft";
  if (saved.lastMaintenance?.after?.memory.slots[0]) saved.lastMaintenance.after.memory.slots[0].text = "consumer-draft";
  const again = context().read(ctx());
  assert.notEqual(again.lastMaintenance?.after?.memory.slots[0]?.text, "consumer-draft");
  assert.notEqual(again.lastMaintenance?.candidate?.memory.slots[0]?.text, "consumer-draft");
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.seed("freeze-f");
  f.respond(async request => { started.resolve(); await release.promise; return memoryPatch(request); });
  const compacting = f.runtime.session.compact();
  await started.promise;
  const pending = context().read(ctx());
  assert.equal(pending.lastMaintenance?.native, "pending");
  assert.equal(pending.lastMaintenance?.before.system.text, systemAtFreeze);
  pending.lastMaintenance!.before.system.text = "mutated-freeze";
  await writeFile(f.configFile, JSON.stringify({ memory: { fraction: 0.2 } }));
  release.resolve();
  await Promise.allSettled([compacting]);
  assert.equal(pending.lastMaintenance?.native, "pending");
  const invalidated = context().read(ctx());
  assert.equal(invalidated.lastMaintenance?.engine, "ok");
  assert.equal(invalidated.lastMaintenance?.invalidated, true);
  assert.notEqual(invalidated.lastMaintenance?.native, "saved");
  assert.equal(invalidated.lastMaintenance?.after, undefined);
  assert.notEqual(invalidated.lastMaintenance?.before.system.text, "mutated-freeze");
});

test("append plus metadata exposes text tokens separately from charged overhead; initial metadata is visible", async t => {
  const catalog = openaiProvider().getModels().find(m => m.id === "gpt-4.1");
  assert(catalog);
  let sends = 0;
  const openai = openaiProvider();
  const transport: typeof fetch = async (resource, init) => {
    sends++;
    await new Request(resource, init).json();
    const item = { type: "message", id: "msg-1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Controlled native response.", annotations: [] }] };
    const events = [
      { type: "response.created", response: { id: "response-1", model: catalog.id, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Controlled native response." },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "response-1", model: catalog.id, status: "completed", output: [item], usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
    ];
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  };
  const bound = { apiKey: "offline-fixture-key", fetch: transport, maxRetries: 0 as const };
  const wrapped: Provider = {
    ...openai,
    streamSimple: (model, context, options) => openai.streamSimple(model as Model<"openai-responses">, context, { ...options, ...bound }),
    stream: (model, context, options) => openai.stream(model as Model<"openai-responses">, context, { ...options, ...bound } as Parameters<typeof openai.stream>[2]),
  };
  const note = "y".repeat(4000);
  const captured = port();
  const f = await fixture({
    config: { budget: { inputLimit: 8000 } },
    extras: [
      ...captured.extras,
      { name: "append-meta", factory(pi) { pi.on("before_provider_request", event => {
        const first = applyLastUserTextAppend(event.payload, SYNTHETIC_LAST_USER_APPEND);
        if (!first.changed) return;
        return { ...(first.payload as Record<string, unknown>), metadata: { note } };
      }); } },
    ],
  });
  t.after(() => f.close());
  new ModelRegistry(f.modelRuntime).registerProvider(wrapped);
  await f.modelRuntime.setRuntimeApiKey("openai", "offline-fixture-key");
  await f.runtime.session.setModel(catalog);
  await f.runtime.session.prompt("Native append with metadata");
  assert.equal(sends, 1);
  const last = captured.context().read(captured.ctx()).lastMain;
  assert.equal(last?.outcome, "delegate");
  assert.equal(last?.payload?.transform, "last-user-text-append");
  assert.equal(last?.payload?.addedTokens, textTokens(SYNTHETIC_LAST_USER_APPEND));
  assert(last?.payload?.chargedGrowthTokens !== undefined && last.payload.chargedGrowthTokens > (last.payload.addedTokens ?? 0));
  assert.equal(last.payload?.unallocatedOverheadTokens, (last.payload?.chargedGrowthTokens ?? 0) - (last.payload?.addedTokens ?? 0));
  assert(last.inputTokens !== undefined && last.layout.heuristic.tokens !== null);
  const accounted = (last.layout.heuristic.tokens ?? 0) + (last.initialMetadataTokens ?? 0) + (last.payload?.chargedGrowthTokens ?? 0);
  assert.equal(last.inputTokens, accounted);

  const faux = fauxProvider({ api: "openai-completions", provider: "synthetic-review", models: [{ id: "synthetic", contextWindow: 60000, maxTokens: 8192 }] });
  faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("synthetic answer")));
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  registry.registerProvider(faux.provider);
  const model = faux.getModel();
  const signal = new AbortController().signal;
  const session = { getSessionId: () => "synthetic-session", getLeafId: () => "leaf", getSessionFile: () => "/tmp/nunc-context-meta.jsonl", getBranch: () => [{ id: "leaf" }], buildContextEntries: () => [] };
  const ctx = { model, signal, sessionManager: session, modelRegistry: registry, getSystemPrompt: () => "Perform the current task." } as unknown as ExtensionContext;
  const bind: Array<(surface: unknown) => void> = [];
  const memory: MemorySurface = {
    read: () => ({ revision: "r", memory: emptyMemory(), status: { occupied: false, unconfirmed: false }, budget: { tokens: 0, limit: 100, unknown: false, overLimit: false }, contextLayout: { slotCount: 0, activeEntries: 0 } }),
    replace: () => ({ ok: false, code: "invalid", message: "no", view: memory.read(ctx) }),
    delete: () => ({ ok: false, code: "invalid", message: "no", view: memory.read(ctx) }),
  };
  const host = {
    events: {
      on(name: string, fn: (reply: unknown) => void) { if (name === "nunc:context-bind") bind.push(fn); },
      emit(name: string, value: unknown) {
        if (name === "nunc:context-bind" && typeof value === "function") value(createContextSurface({ pi: host as never, memory, fixed: () => ({ systemPrompt: "Perform the current task.", tools: [] }), config: () => engineConfig({}, model, { reserveTokens: 36000, keepRecentTokens: 1 }) }));
      },
    },
    registerProvider(...args: Parameters<ModelRegistry["registerProvider"]>) { registry.registerProvider(...args); },
  };
  const surface = createContextSurface({
    pi: host as never,
    memory,
    fixed: () => ({ systemPrompt: "Perform the current task.", tools: [] }),
    config: () => engineConfig({}, model, { reserveTokens: 36000, keepRecentTokens: 1 }),
  });
  const admission = new Admission(host as never, () => engineConfig({}, model, { reserveTokens: 36000, keepRecentTokens: 1 }), event => surface.observeAdmission(event));
  admission.ensure(ctx);
  const provider = registry.getProvider(model.provider);
  assert(provider);
  const metadata = { user_id: "m".repeat(2000) };
  const expected = textTokens(JSON.stringify(metadata));
  const sent = await provider.streamSimple(model, { messages: [{ role: "user", content: "short synthetic input", timestamp: 1 }] }, { signal, sessionId: "synthetic-session", metadata }).result();
  assert.equal(sent.stopReason, "stop", sent.errorMessage ?? "");
  const observed = surface.read(ctx).lastMain;
  assert.equal(observed?.outcome, "delegate");
  assert.equal(observed?.initialMetadataTokens, expected);
  assert(observed?.inputTokens !== undefined && observed.inputTokens >= expected);
});
