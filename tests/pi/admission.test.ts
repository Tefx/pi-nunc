import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, type AssistantMessage } from "@earendil-works/pi-ai";
import { azureOpenAIResponsesProvider } from "@earendil-works/pi-ai/providers/azure-openai-responses";
import { fixture, memoryPatch } from "./fixtures.js";
import { sourceRecords } from "../engine/fixtures.js";
import type { AdmissionObservation } from "../../src/pi/admission.js";
import { Type } from "typebox";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";

test("constrained tool metadata unavailable at native maintenance seam is explicitly unsupported before main dispatch", async t => {
  const f = await fixture({ tools: [{ name: "constrained", label: "Constrained", description: "Accept a constrained value", parameters: Type.Object({ value: Type.String() }), constrainedSampling: { type: "grammar", variants: { openai_regex: "x+" } }, execute: async () => ({ content: [{ type: "text", text: "unused" }], details: {} }) }] });
  t.after(() => f.close()); await f.runtime.session.prompt("Use the configured tool");
  assert.equal(f.faux.state.callCount, 0);
  const last = f.runtime.session.messages.at(-1); assert(last?.role === "assistant"); assert.match(last.errorMessage ?? "", /Constrained tool sampling is unsupported/);
});

test("admission delegates a registered native Azure Responses provider outside the old API list", async t => {
  const admissions: Array<{ outcome?: string; code?: string }> = [];
  const f = await fixture({ extras: [{ name: "watch-admission", factory(pi) { pi.events.on("nunc:admission", (value: unknown) => admissions.push(value as { outcome?: string; code?: string })); } }] });
  t.after(() => f.close());
  const azure = azureOpenAIResponsesProvider();
  new ModelRegistry(f.modelRuntime).registerProvider(azure);
  const model = azure.getModels().find(m => m.id === "gpt-4o-mini");
  assert(model && model.api === "azure-openai-responses");
  assert(!["openai-completions", "openai-responses", "anthropic-messages", "openai-codex-responses"].includes(model.api));
  await f.modelRuntime.setRuntimeApiKey("azure-openai-responses", "offline-fixture-key");
  await f.runtime.session.setModel(model);
  await f.runtime.session.prompt("Use the currently selected native provider").catch(() => {});
  assert.equal(f.faux.state.callCount, 0);
  const last = admissions.at(-1);
  assert.equal(last?.outcome, "delegate", JSON.stringify(admissions));
  assert.notEqual(last?.code, "CONFIG");
});

test("nested independent complete during maintenance delegates without inheriting the extraction budget", async t => {
  const f = await fixture(); t.after(() => f.close()); f.seed();
  let foreign: AssistantMessage | undefined;
  f.respond(async (context, options) => {
    if (!sourceRecords(context).length) return fauxAssistantMessage("Independent nested complete");
    assert(options?.signal);
    foreign = await new ModelRegistry(f.modelRuntime).complete(f.faux.getModel(), { messages: [{ role: "user", content: "Separate nested source", timestamp: 1 }] }, { maxTokens: 512, signal: options.signal });
    return memoryPatch(context);
  });
  await f.runtime.session.compact();
  assert.equal(f.faux.state.callCount, 2); assert.equal(foreign?.stopReason, "stop");
  assert(f.events[0]?.result.ok); assert.equal(f.runtime.session.sessionManager.getBranch().filter(e => e.type === "compaction").length, 1);
});

test("maintenance ALS rejects a second stream of the same context instead of escaping as foreign", async t => {
  const f = await fixture(); t.after(() => f.close()); f.seed();
  let replay: AssistantMessage | undefined;
  f.respond(async (context, options) => {
    if (!sourceRecords(context).length) return fauxAssistantMessage("Replay incorrectly reached service");
    replay = await new ModelRegistry(f.modelRuntime).complete(f.faux.getModel(), context, { ...(options?.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }), ...(options?.signal ? { signal: options.signal } : {}) });
    return memoryPatch(context);
  });
  await f.runtime.session.compact();
  assert.equal(f.faux.state.callCount, 1); assert.equal(replay?.stopReason, "error");
  assert.match(replay?.errorMessage ?? "", /already used or changed binding/);
  assert(f.events[0]?.result.ok);
});

test("later context hooks may add or drop their own messages; independent raw calls do not block the main request", async t => {
  const admissions: Array<{ kind?: string; outcome?: string; code?: string }> = [];
  let foreign: AssistantMessage | undefined;
  const f = await fixture({ extras: [{ name: "later-context", factory(pi) {
    pi.events.on("nunc:admission", (value: unknown) => admissions.push(value as { kind?: string; outcome?: string; code?: string }));
    pi.on("context", async (event, ctx) => {
      foreign = await ctx.modelRegistry.complete(ctx.model!, { messages: [{ role: "user", content: "Independent controlled side request", timestamp: 1 }] }, { maxTokens: 64 });
      return { messages: [...event.messages.slice(0, -1), { role: "user", content: "Later-owned extra note", timestamp: 2 }, event.messages.at(-1)!] };
    });
  } }] });
  t.after(() => f.close());
  await f.runtime.session.prompt("Controlled native main request");
  const main = f.runtime.session.messages.at(-1);
  assert.equal(foreign?.stopReason, "stop");
  assert.equal(main?.role, "assistant"); assert.equal(main.stopReason, "stop");
  assert.equal(f.faux.state.callCount, 2);
  assert(f.calls.some(c => JSON.stringify(c.messages).includes("Later-owned extra note")));
  assert(admissions.some(a => a.kind === "unknown" && a.outcome === "delegate"));
  assert(admissions.some(a => a.kind === "main" && a.outcome === "delegate"));
});

test("later context that exceeds the actual main budget is rejected with zero provider calls", async t => {
  const f = await fixture({ extras: [{ name: "oversize", factory(pi) {
    pi.on("context", event => ({ messages: [...event.messages, { role: "user", content: "n".repeat(320000), timestamp: 3 }] }));
  } }] });
  t.after(() => f.close());
  await f.runtime.session.prompt("Stay within the current model");
  const last = f.runtime.session.messages.at(-1);
  assert.equal(f.faux.state.callCount, 0);
  assert(last?.role === "assistant"); assert.equal(last.stopReason, "error");
  assert.match(last.errorMessage ?? "", /exceeds main input limit/);
});

test("applicable usage anchors main admission, but changing the effective system prefix invalidates it", async t => {
  const observations: AdmissionObservation[] = [];
  let changed = false;
  const f = await fixture({ extras: [{ name: "budget-observer", factory(pi) {
    pi.events.on("nunc:admission", value => observations.push(value as AdmissionObservation));
    pi.on("before_agent_start", event => changed ? { systemPrompt: event.systemPrompt + "\nChanged effective constraint." } : undefined);
  } }] });
  t.after(() => f.close());
  f.respond(() => fauxAssistantMessage("Controlled response."));
  await f.runtime.session.prompt("First request");
  const first = f.runtime.session.messages.at(-1)!; assert(first.role === "assistant");
  const reported = first.usage.totalTokens; assert(reported > 0);
  await f.runtime.session.prompt("Same prefix");
  const anchored = observations.filter(o => o.kind === "main" && o.outcome === "delegate").at(-1)!;
  assert.equal(anchored.estimator, "pi-usage-backed"); assert(anchored.inputTokens! >= reported);
  changed = true;
  await f.runtime.session.prompt("Changed prefix");
  const fresh = observations.filter(o => o.kind === "main" && o.outcome === "delegate").at(-1)!;
  assert.equal(fresh.estimator, "pi-heuristic"); assert(fresh.inputTokens! < 2000);
});

test("later context that breaks tool association is rejected before dispatch", async t => {
  const f = await fixture({ extras: [{ name: "orphan-tool", factory(pi) {
    pi.on("context", event => ({ messages: [...event.messages, { role: "toolResult", toolCallId: "missing", toolName: "probe", content: [{ type: "text", text: "orphan" }], isError: false, timestamp: 4 }] }));
  } }] });
  t.after(() => f.close());
  await f.runtime.session.prompt("Continue with current tools");
  const last = f.runtime.session.messages.at(-1);
  assert.equal(f.faux.state.callCount, 0);
  assert(last?.role === "assistant"); assert.equal(last.stopReason, "error");
  assert.match(last.errorMessage ?? "", /Orphan|Nunc local INPUT/);
});

test("wrapping the current Provider between settled calls still sends the next main request", async t => {
  const f = await fixture();
  t.after(() => f.close());
  await f.runtime.session.prompt("First settled request");
  assert.equal(f.faux.state.callCount, 1);
  const id = f.faux.getModel().provider;
  const registry = new ModelRegistry(f.modelRuntime);
  const previous = registry.getProvider(id);
  assert(previous);
  let outerCalls = 0;
  registry.registerProvider({
    ...previous,
    streamSimple: (model, context, options) => { outerCalls++; return previous.streamSimple(model, context, options); },
    stream: (model, context, options) => { outerCalls++; return previous.stream(model, context, options); },
  });
  await f.runtime.session.prompt("Second settled request");
  const last = f.runtime.session.messages.at(-1);
  assert.equal(last?.role, "assistant");
  assert.equal(last.stopReason, "stop", last.errorMessage ?? "");
  assert.equal(f.faux.state.callCount, 2);
  assert.equal(outerCalls, 1);
});

test("same-run streamSimple with a different model is rejected; the matching main request still sends", async t => {
  let side: AssistantMessage | undefined;
  const f = await fixture({ extras: [{ name: "model-mismatch", factory(pi) {
    pi.on("context", async (_event, ctx) => {
      const small = ctx.modelRegistry.find("nunc-pi-fixture", "small");
      const provider = ctx.modelRegistry.getProvider("nunc-pi-fixture");
      if (!small || !provider || !ctx.signal) return;
      side = await provider.streamSimple(small, { messages: [{ role: "user", content: "Wrong model helper", timestamp: 1 }] }, { signal: ctx.signal, sessionId: ctx.sessionManager.getSessionId() }).result();
    });
  } }] });
  t.after(() => f.close());
  await f.runtime.session.prompt("Matching session model");
  const main = f.runtime.session.messages.at(-1);
  assert.equal(side?.stopReason, "error");
  assert.match(side?.errorMessage ?? "", /does not match the current session model/);
  assert.equal(main?.role, "assistant"); assert.equal(main.stopReason, "stop");
  assert.equal(f.faux.state.callCount, 1);
});
