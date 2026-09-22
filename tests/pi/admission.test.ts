import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, getCurrentSystemPrompt, getCurrentTools, getSystemMessageText, normalizeContext, renderSystemMessageUpdate, type AssistantMessage, type Context, type SystemMessage, type Tool, type ToolReference } from "@earendil-works/pi-ai";
import { azureOpenAIResponsesProvider } from "@earendil-works/pi-ai/providers/azure-openai-responses";
import { fixture, memoryPatch } from "./fixtures.js";
import { answer, sourceRecords } from "../engine/fixtures.js";
import { project } from "../../src/pi/projection.js";
import { messageTokens, requestTokens, textTokens } from "../../src/engine/accounting.js";
import { LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, type AdmissionObservation, type ResolveSystemPromptRequest } from "../../src/pi/admission.js";
import { Type } from "typebox";
import { ModelRegistry, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { contextSurface } from "pi-nunc/pi";

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
      side = await provider.streamSimple(small, normalizeContext({ messages: [{ role: "user", content: "Wrong model helper", timestamp: 1 }] }), { signal: ctx.signal, sessionId: ctx.sessionManager.getSessionId() }).result();
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

test("leading sections and tools are preserved in provider-bound request and affect admission boundary", async t => {
  const customTool: Tool = {
    name: "custom_probe",
    description: "Probe tool for testing boundary",
    parameters: Type.Object({ q: Type.String() }),
  };
  const largeSection = "X".repeat(24000); // ~6000 tokens
  const normalSys: SystemMessage = {
    role: "system",
    content: "Base system instructions",
    sections: { project_context: "Project rules: do not guess", skills: "Available tools: read, bash" },
    toolsAdded: [customTool],
    timestamp: 1,
  };
  const oversizedSys: SystemMessage = {
    ...normalSys,
    sections: { ...normalSys.sections, large_doc: largeSection },
  };

  // 1. Boundary reject: when oversized section exceeds inputLimit (5000 tokens)
  const fOver = await fixture({
    config: { budget: { inputLimit: 5000 } },
    extras: [{ name: "oversized-loadout", factory(pi) {
      pi.on("context", event => ({ messages: [oversizedSys, ...event.messages.filter(m => m.role !== "system")] }));
    } }],
  });
  t.after(() => fOver.close());
  await fOver.runtime.session.prompt("Prompt exceeding budget due to large section");
  const overLast = fOver.runtime.session.messages.at(-1);
  assert.equal(overLast?.role, "assistant");
  assert.equal(overLast?.stopReason, "error");
  assert.match(overLast?.errorMessage ?? "", /exceeds main input limit/);
  assert.equal(fOver.faux.state.callCount, 0, "Oversized section must reject before provider call");

  // 2. Boundary accept & independently derived expected token contribution:
  const fNormal = await fixture({
    config: { budget: { inputLimit: 10000 } },
    extras: [{ name: "normal-loadout", factory(pi) {
      pi.on("context", event => ({ messages: [normalSys, ...event.messages.filter(m => m.role !== "system")] }));
    } }],
  });
  t.after(() => fNormal.close());
  await fNormal.runtime.session.prompt("Prompt within budget");
  const normLast = fNormal.runtime.session.messages.at(-1);
  assert.equal(normLast?.role, "assistant");
  assert.equal(normLast?.stopReason, "stop");
  assert.equal(fNormal.faux.state.callCount, 1);

  // Independently derived expected token contributions:
  const promptTokens = textTokens(getSystemMessageText(normalSys));
  const toolTokens = textTokens(JSON.stringify(normalSys.toolsAdded));
  const userMsgTokens = messageTokens(fNormal.calls[0]!.messages[1]!);
  const expectedRequestTokens = 64 + promptTokens + toolTokens + userMsgTokens;
  const actualTokens = requestTokens({ messages: fNormal.calls[0]!.messages });
  assert.equal(actualTokens, expectedRequestTokens, "requestTokens must match independently derived expected tokens");

  // 3. Mixed legacy + system normalization:
  const mixedContext: Context = {
    systemPrompt: "Legacy base prompt",
    tools: [{ ...customTool, name: "legacy_tool" }],
    messages: [normalSys, { role: "user", content: "Hi", timestamp: 2 }],
  };
  const normalizedMixed = normalizeContext(mixedContext);
  assert.equal(normalizedMixed.messages.length, 3);
  assert.equal(normalizedMixed.messages[0]?.role, "system");
  assert.equal(normalizedMixed.messages[1]?.role, "system");
  const mixedTokens = requestTokens(mixedContext);
  assert.equal(mixedTokens, 64 + textTokens("Legacy base prompt") + textTokens(JSON.stringify(mixedContext.tools)) + messageTokens(normalSys) + messageTokens(mixedContext.messages[1]!));
});

test("mid-conversation section replacement, deletion, and tool changes on persisted history reflected in provider-bound request", async t => {
  let turn = 0;
  const f = await fixture({
    extras: [{
      name: "updater",
      factory(pi) {
        pi.on("before_agent_start", event => {
          turn++;
          if (turn === 1) {
            event.systemPromptOptions.sections.sec_a = "section A value";
            event.systemPromptOptions.sections.sec_b = "section B to be removed";
            pi.setActiveTools(["read"]);
          } else {
            event.systemPromptOptions.sections.sec_a = "section A updated";
            delete event.systemPromptOptions.sections.sec_b;
            event.systemPromptOptions.sections.sec_c = "section C added";
            pi.setActiveTools(["bash"]);
          }
        });
      }
    }]
  });
  t.after(() => f.close());

  f.respond(() => fauxAssistantMessage("Turn 1 response"));
  await f.runtime.session.prompt("Turn 1 user request");

  assert.equal(f.faux.state.callCount, 1);
  const turn1Req = f.calls[0]!;
  const turn1Prompt = getCurrentSystemPrompt(turn1Req.messages);
  assert(turn1Prompt.includes("section A value"), "Baseline prompt must have section A");
  assert(turn1Prompt.includes("section B to be removed"), "Baseline prompt must have section B");
  const turn1Tools = getCurrentTools(turn1Req.messages);
  assert(turn1Tools.some(t => t.name === "read"), "Baseline tools must include read");
  assert(!turn1Tools.some(t => t.name === "bash"), "Baseline tools must not include bash");

  // Prompt turn 2 on this persisted history
  f.respond(() => fauxAssistantMessage("Turn 2 response"));
  await f.runtime.session.prompt("Turn 2 user request");

  const last = f.runtime.session.messages.at(-1);
  assert.equal(last?.role, "assistant");
  assert.equal(last?.stopReason, "stop", last?.errorMessage ?? "");
  assert.equal(f.faux.state.callCount, 2);

  // Verify that both system messages were persisted in session entries
  const entries = f.runtime.session.sessionManager.getEntries();
  const sysEntries = entries.filter(e => e.type === "message" && e.message.role === "system");
  assert.equal(sysEntries.length, 2, "Both initial and update system messages must be persisted in session");

  // Verify that project(entries).active excludes BOTH system messages from R
  const projected = project(entries);
  assert(!projected.active.some(e => (e.sourceRole as string) === "system"), "System messages must not be in R");

  const turn2Req = f.calls[1]!;
  const turn2Prompt = getCurrentSystemPrompt(turn2Req.messages);
  // Replaced section reflected:
  assert(turn2Prompt.includes("section A updated"), "Updated section A must be in prompt");
  assert(!turn2Prompt.includes("section A value"), "Old section A must be replaced");
  // Deleted section reflected (delete deletes sec_b):
  assert(!turn2Prompt.includes("section B to be removed"), "Deleted section B must be absent");
  // Added section reflected:
  assert(turn2Prompt.includes("section C added"), "Added section C must be in prompt");
  // Tool changes reflected:
  const turn2Tools = getCurrentTools(turn2Req.messages);
  assert(turn2Tools.some(t => t.name === "bash"), "Added bash must be in active tools");
  assert(!turn2Tools.some(t => t.name === "read"), "Removed read must NOT be in active tools");

  // Verify accounting:
  const turn2Tokens = requestTokens({ messages: turn2Req.messages });
  assert(turn2Tokens > 64);
});

test("real Nunc compaction plus continuation preserves native replayed system and tool state without fixture re-injection", async t => {
  const customTool: ToolDefinition = {
    name: "persisted_helper",
    label: "Helper",
    description: "Tool that survives compaction",
    parameters: Type.Object({ action: Type.String() }),
    execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
  };
  const f = await fixture({
    tools: [customTool],
  });
  t.after(() => f.close());
  f.seed();
  f.respond(memoryPatch);

  // Set active tools before compaction to activate persisted_helper (persists tool state in session)
  f.runtime.session.setActiveToolsByName(["persisted_helper"]);
  await f.runtime.session.prompt("Prompt 1 before compaction");

  // Verify that before compaction, session entries contain native system messages
  const entriesBefore = f.runtime.session.sessionManager.getEntries();
  assert(entriesBefore.some(e => e.type === "message" && e.message.role === "system"), "Session should have system message before compaction");

  // Perform real Nunc compaction
  await f.runtime.session.compact();
  assert(f.events[0]?.result.ok, "Compaction must succeed");

  // Verify that system messages were excluded from summarizable R
  const projectedAfter = project(f.runtime.session.sessionManager.buildContextEntries());
  assert(projectedAfter.latestId);
  assert(!projectedAfter.active.some(e => (e.sourceRole as string) === "system"), "System messages must not be in R");

  // Continue session after compaction WITHOUT ANY fixture re-injection or context hook
  f.respond(() => fauxAssistantMessage("Continuation reply"));
  await f.runtime.session.prompt("Continue task after compaction");
  const last = f.runtime.session.messages.at(-1);
  assert.equal(last?.role, "assistant");
  assert.equal(last?.stopReason, "stop", last?.errorMessage ?? "");

  // Assert effective system/tool state in continuation request via native replay:
  const continuationCall = f.calls.at(-1)!;
  const contPrompt = getCurrentSystemPrompt(continuationCall.messages);
  assert(contPrompt.includes("Perform the current task."), "Continuation request must contain native replayed system prompt");
  const contTools = getCurrentTools(continuationCall.messages);
  assert(contTools.some(t => t.name === "persisted_helper"), "Continuation request must preserve active tools via native replay");
});

test("Larva system prompt resolution with mid-conversation system updates preserves updates without double application", async t => {
  let resolverCalls = 0;
  let turn = 0;
  const f = await fixture({
    extras: [{
      name: "larva-mid-convo-test",
      factory(pi) {
        pi.events.on("larva:resolve-system-prompt:v1", data => {
          resolverCalls++;
          const req = data as ResolveSystemPromptRequest;
          req.reply({ status: "ok", systemPrompt: "RESOLVED_BASE_PROMPT\n" + req.systemPrompt });
        });
        pi.on("before_agent_start", event => {
          turn++;
          if (turn === 1) {
            event.systemPromptOptions.sections.project_rules = "Original project rules";
          } else {
            event.systemPromptOptions.sections.project_rules = "Updated project rules";
            event.systemPromptOptions.sections.extra_info = "Extra info";
          }
        });
      },
    }],
  });
  t.after(() => f.close());

  f.respond(() => fauxAssistantMessage("Turn 1 response"));
  await f.runtime.session.prompt("Turn 1 query");

  f.respond(() => fauxAssistantMessage("Turn 2 response"));
  await f.runtime.session.prompt("Turn 2 query");

  assert.equal(resolverCalls, 2, "Resolver called once per prompt turn");
  const sentCall = f.calls.at(-1)!;
  const effectivePrompt = getCurrentSystemPrompt(sentCall.messages);

  // Resolved base prompt is present
  assert(effectivePrompt.includes("RESOLVED_BASE_PROMPT"));
  // Mid-convo update was applied on top
  assert(effectivePrompt.includes("Updated project rules"));
  assert(effectivePrompt.includes("Extra info"));
  // Original base prompt was replaced
  assert(!effectivePrompt.includes("Original project rules"));

  // Check that "Updated project rules" only occurs ONCE (not applied twice)
  const occurrences = (effectivePrompt.match(/Updated project rules/g) || []).length;
  assert.equal(occurrences, 1, "Mid-convo section update must appear exactly once, not duplicated");
});

test("fixed context preserves constrainedSampling metadata and effective system prompt from transcript without loss", async t => {
  const toolWithSampling: ToolDefinition = {
    name: "constrained_reader",
    label: "Constrained Reader",
    description: "Read with constrained JSON schema",
    parameters: Type.Object({ path: Type.String() }),
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
  };
  let api: ExtensionAPI;
  let ctx: ExtensionContext;
  const f = await fixture({
    tools: [toolWithSampling],
    extras: [{
      name: "fixed-inspector",
      factory(pi) {
        api = pi;
        pi.on("session_start", (_event, current) => { ctx = current; });
      }
    }]
  });
  t.after(() => f.close());
  f.seed();
  f.respond(memoryPatch);

  f.runtime.session.setActiveToolsByName(["constrained_reader"]);
  await f.runtime.session.prompt("Prompt to establish active tools");
  await f.runtime.session.compact();

  const view = contextSurface(api!)!.read(ctx!).current.layout;
  assert(view.system.text.includes("Perform the current task."));
  assert.deepEqual(view.tools.names, ["constrained_reader"]);
  const declared: Tool = { name: toolWithSampling.name, description: toolWithSampling.description,
    parameters: toolWithSampling.parameters, constrainedSampling: toolWithSampling.constrainedSampling! };
  assert.equal(view.tools.tokens, textTokens(JSON.stringify([declared])), "real fixed accounting includes constrainedSampling");
});

test("explicit empty transcript prompt/tools do not revive host defaults in fixed accounting", async t => {
  let api: ExtensionAPI;
  let ctx: ExtensionContext;
  const f = await fixture({ extras: [{ name: "empty-state-view", factory(pi) {
    api = pi;
    pi.on("session_start", (_event, current) => { ctx = current; });
  } }] });
  t.after(() => f.close());
  assert(contextSurface(api!)!.read(ctx!).current.layout.system.text.length > 0, "absent state uses host defaults");
  const sm = f.runtime.session.sessionManager;
  sm.appendMessage({ role: "system", content: "", sections: { only: "old section" },
    toolsAdded: [{ name: "retired", description: "old tool", parameters: Type.Object({}) }], timestamp: 1 });
  sm.appendMessage({ role: "system", content: "", sections: { only: null }, toolsRemoved: [{ name: "retired" }], timestamp: 2 });
  f.seed();
  const current = contextSurface(api!)!.read(ctx!).current;
  assert.equal(current.layout.system.text, "");
  assert.deepEqual(current.layout.tools.names, []);
  assert.equal(f.faux.state.callCount, 0, "inspection sends nothing");
});

test("resolved system history keeps the delivered memory index and conversation layout exact", async t => {
  const observations: AdmissionObservation[] = [];
  let api: ExtensionAPI;
  let ctx: ExtensionContext;
  const f = await fixture({ extras: [{ name: "resolved-memory-layout", factory(pi) {
    api = pi;
    pi.on("session_start", (_event, current) => { ctx = current; });
    pi.events.on("nunc:admission", value => observations.push(value as AdmissionObservation));
    pi.events.on(LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, value => {
      const request = value as ResolveSystemPromptRequest;
      request.reply({ status: "ok", systemPrompt: "Resolved persona\n" + request.systemPrompt });
    });
  } }] });
  t.after(() => f.close());
  f.seed(); f.respond(memoryPatch);
  await f.runtime.session.compact();
  const sm = f.runtime.session.sessionManager;
  sm.appendMessage({ role: "system", content: "Additional state", sections: { temporary: "remove me" }, timestamp: 2 });
  sm.appendMessage({ role: "system", content: "", sections: { temporary: null }, timestamp: 3 });
  f.runtime.session.agent.state.messages = sm.buildSessionContext().messages;
  f.respond(context => {
    assert(!("systemPrompt" in context), "delegation carries one normalized representation");
    assert.equal(context.messages.filter(m => m.role === "system").length, 1);
    assert(!getCurrentSystemPrompt(context.messages).includes("remove me"));
    return fauxAssistantMessage("Continued");
  });
  await f.runtime.session.prompt("Continue with resolved state");
  const observed = observations.filter(o => o.kind === "main").at(-1)!;
  assert.equal(observed.outcome, "delegate");
  assert.equal(observed.memoryPresent, true);
  const request = f.calls.at(-1)!;
  const index = request.messages.findIndex(m => m.role === "user" &&
    (typeof m.content === "string" ? m.content : m.content.filter(b => b.type === "text").map(b => b.text).join("")) === observed.memoryContent);
  assert(index >= 0);
  assert.equal(observed.memoryIndex, index);
  const view = contextSurface(api!)!.read(ctx!).lastMain!;
  assert.equal(view.layout.memoryIndex, index);
  assert.equal(view.layout.messageCount, request.messages.filter(m => m.role !== "system").length - 1);
});
