import { test } from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream, fauxProvider, InMemoryCredentialStore, type Api, type SimpleStreamOptions, type TranscriptContext, fauxAssistantMessage, getCurrentSystemPrompt, getCurrentTools, getSystemMessageText, normalizeContext, renderSystemMessageUpdate, type AssistantMessage, type AzureOpenAIResponsesOptions, type Model, type Context, type SystemMessage, type Tool, type ToolReference } from "@earendil-works/pi-ai";
import { fixture, memoryPatch, responsesSSE } from "./fixtures.js";
import { answer, sourceRecords } from "../engine/fixtures.js";
import { project } from "../../src/pi/projection.js";
import { outputFloor, messageTokens, requestTokens, textTokens } from "../../src/engine/accounting.js";
import { Admission, LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, type AdmissionObservation, type ResolveSystemPromptRequest } from "../../src/pi/admission.js";
import { Type } from "typebox";
import { createEventBus, ModelRuntime, ModelRegistry, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { contextSurface } from "pi-nunc/pi";
import { buildContextNodes } from "../../src/ui/context-tree.js";
import { engineConfig } from "../../src/pi/config.js";
import { omitsRouteOutputCap } from "../../src/engine/pi-model.js";
import { outputCapState } from "../../src/pi/payload.js";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

test("native grammar declaration reaches the main provider with its exact variant", async t => {
  const grammar = { type: "grammar" as const, variants: { openai_regex: "x+" } };
  const f = await fixture({ tools: [{ name: "constrained", label: "Constrained", description: "Accept a constrained value", parameters: Type.Object({ value: Type.String() }), constrainedSampling: grammar, execute: async () => ({ content: [{ type: "text", text: "unused" }], details: {} }) }] });
  t.after(() => f.close()); await f.runtime.session.prompt("Use the configured tool");
  assert.equal(f.faux.state.callCount, 1);
  assert.deepEqual(getCurrentTools(f.calls[0]!.messages).find(t => t.name === "constrained")?.constrainedSampling, grammar);
  const last = f.runtime.session.messages.at(-1); assert(last?.role === "assistant"); assert.equal(last.stopReason, "stop", last.errorMessage ?? "");
});

test("Pi prepareLoadout descriptions and hidden declarations remain authoritative on the actual main Context", async t => {
  let hidden = true;
  const tools: ToolDefinition[] = [
    { name: "constrained", label: "Constrained", description: "original", parameters: Type.Object({ value: Type.String() }),
      constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /[a-z]+/" } },
      prepareLoadout: () => ({ descriptions: { constrained: hidden ? "hidden mode" : "visible mode" }, hiddenDeclarations: hidden ? ["aux"] : [] }),
      execute: async () => ({ content: [{ type: "text", text: "unused" }], details: {} }) },
    { name: "aux", label: "Auxiliary", description: "only when visible", parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "unused" }], details: {} }) },
  ];
  const f = await fixture({ tools, extras: [{ name: "activate-loadout", factory(pi) {
    pi.on("before_agent_start", () => { pi.setActiveTools(["constrained", "aux"]); });
  } }] });
  t.after(() => f.close());
  await f.runtime.session.prompt("First loadout");
  const first = getCurrentTools(f.calls[0]!.messages);
  assert.deepEqual(first.map(t => t.name), ["constrained"]);
  assert.equal(first[0]?.description, "hidden mode");
  assert.deepEqual(first[0]?.constrainedSampling, tools[0]!.constrainedSampling);
  hidden = false;
  await f.runtime.session.prompt("Changed loadout");
  const second = getCurrentTools(f.calls[1]!.messages);
  assert.deepEqual(second.map(t => t.name).sort(), ["aux", "constrained"]);
  assert.equal(second.find(t => t.name === "constrained")?.description, "visible mode");
  assert.deepEqual(second.find(t => t.name === "constrained")?.constrainedSampling, tools[0]!.constrainedSampling);
});

test("a grammar-only request-local tool delta invalidates the earlier usage receipt", async t => {
  const observations: AdmissionObservation[] = [];
  let changed = false;
  const original = { type: "grammar" as const, variants: { openai_regex: "x+" } };
  const replacement = { type: "grammar" as const, variants: { openai_regex: "y+" } };
  const definition: ToolDefinition = { name: "constrained", label: "Constrained", description: "same", parameters: Type.Object({ value: Type.String() }),
    constrainedSampling: original, execute: async () => ({ content: [{ type: "text", text: "unused" }], details: {} }) };
  const f = await fixture({ tools: [definition], extras: [{ name: "change-grammar", factory(pi) {
    pi.events.on("nunc:admission", value => observations.push(value as AdmissionObservation));
    pi.on("context", event => changed ? { messages: [...event.messages, { role: "system", content: "", toolsAdded: [{ name: definition.name, description: definition.description, parameters: definition.parameters, constrainedSampling: replacement }], timestamp: 2 }] } : undefined);
  } }] });
  t.after(() => f.close());
  await f.runtime.session.prompt("First request");
  changed = true;
  await f.runtime.session.prompt("Same name, new grammar");
  assert.equal(f.faux.state.callCount, 2);
  assert.deepEqual(getCurrentTools(f.calls[1]!.messages).find(t => t.name === definition.name)?.constrainedSampling, replacement);
  assert.equal(observations.filter(o => o.kind === "main" && o.outcome === "delegate").at(-1)?.estimator, "pi-heuristic");
});

test("admission delegates a registered native Azure Responses provider outside the old API list", async t => {
  const admissions: Array<{ outcome?: string; code?: string }> = [];
  const f = await fixture({ extras: [{ name: "watch-admission", factory(pi) { pi.events.on("nunc:admission", (value: unknown) => admissions.push(value as { outcome?: string; code?: string })); } }] });
  t.after(() => f.close());
  const azure = f.modelRuntime.getProvider("azure"); assert(azure);
  const bodies: Record<string, unknown>[] = [];
  const transport: typeof fetch = async (resource, init) => {
    const request = new Request(resource, init);
    const body = await request.json() as Record<string, unknown>;
    bodies.push(body);
    return responsesSSE("gpt-4o-mini", "Controlled Azure answer");
  };
  const bound = { apiKey: "offline-fixture-key", fetch: transport, maxRetries: 0 as const,
    azureBaseUrl: "https://controlled.openai.azure.com/openai/v1", env: { AZURE_OPENAI_BASE_URL: "https://controlled.openai.azure.com/openai/v1", AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-4o-mini=mapped-deployment" } };
  new ModelRegistry(f.modelRuntime).registerProvider({ ...azure,
    stream: (m, c, o) => azure.stream(m as Model<"azure-openai-responses">, c, { ...o, ...bound } as AzureOpenAIResponsesOptions),
    streamSimple: (m, c, o) => azure.streamSimple(m, c, { ...o, ...bound }),
  });
  const model = azure.getModels().find(m => m.id === "gpt-4o-mini");
  assert(model && model.api === "azure-openai-responses");
  assert(!["openai-completions", "openai-responses", "anthropic-messages", "openai-codex-responses"].includes(model.api));
  await f.modelRuntime.setRuntimeApiKey(model.provider, "offline-fixture-key");
  await f.runtime.session.setModel(model);
  await f.runtime.session.prompt("Use the currently selected native provider");
  assert.equal(bodies.length, 1, JSON.stringify({ admissions, response: f.runtime.session.messages.at(-1) }));
  assert.equal(bodies[0]?.model, "mapped-deployment");
  const response = f.runtime.session.messages.at(-1);
  assert(response?.role === "assistant");
  assert.equal(response.stopReason, "stop", response.errorMessage ?? "");
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
  const f = await fixture({ config: { budget: { inputLimit: 50000 } }, extras: [{ name: "oversize", factory(pi) {
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
  const delivered = fNormal.calls[0]!.messages;
  assert.equal(delivered[0]?.role, "system", "Pi's host system state remains ahead of the extension section");
  assert.deepEqual(delivered[1], normalSys, "native section and tool declarations are unchanged");
  const userMsgTokens = messageTokens(delivered[2]!);
  const expectedRequestTokens = 64 + messageTokens(delivered[0]!) + promptTokens + toolTokens + userMsgTokens;
  const actualTokens = requestTokens({ messages: delivered });
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
  assert.equal(contextSurface(api!)!.read(ctx!).current.layout.tools.unknown, true, "unsent loadout is a partial estimate");
  await f.runtime.session.prompt("Prompt to establish active tools");
  const sent = contextSurface(api!)!.read(ctx!).lastMain?.layout.tools;
  assert.equal(sent?.unknown, false, "last main reflects the complete actual Context");
  assert.deepEqual(sent?.definitions[0]?.constrainedSampling, toolWithSampling.constrainedSampling);
  const nodes = buildContextNodes(contextSurface(api!)!.read(ctx!));
  assert.match(nodes.get("last-main:F")?.preview ?? "", /last actual main Context/);
  assert.match(nodes.get("last-main:F:tools:constrained_reader")?.preview ?? "", /Constrained sampling/);
  assert.match(nodes.get("current:F")?.preview ?? "", /current history/);
  await f.runtime.session.compact();

  const view = contextSurface(api!)!.read(ctx!).current.layout;
  assert(view.system.text.includes("Perform the current task."));
  assert.deepEqual(view.tools.names, ["constrained_reader"]);
  const declared: Tool = { name: toolWithSampling.name, description: toolWithSampling.description,
    parameters: toolWithSampling.parameters, constrainedSampling: toolWithSampling.constrainedSampling! };
  assert.equal(view.tools.tokens, textTokens(JSON.stringify([declared])), "real fixed accounting includes constrainedSampling");
  assert.equal(view.tools.definitions[0]?.tokens, textTokens(JSON.stringify(declared)));
  assert.deepEqual(view.tools.definitions[0]?.constrainedSampling, toolWithSampling.constrainedSampling);
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
  f.respond(context => {
    const fm = context.messages.flatMap(m => typeof m.content === "string" ? [] : m.content.flatMap(b => {
      if (b.type !== "text") return [];
      try { return [JSON.parse(b.text) as { source?: string; F?: { systemPrompt: string; tools: Tool[]; toolState?: string } }]; } catch { return []; }
    })).find(r => r.source === "F/M");
    assert.equal(fm?.F?.systemPrompt, "");
    assert.deepEqual(fm?.F?.tools, []);
    assert.equal(fm?.F?.toolState, undefined, "explicit empty persisted declarations are authoritative");
    return memoryPatch(context);
  });
  await f.runtime.session.compact();
  assert.equal(f.events[0]?.result.ok, true);
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

// Controlled serialized payloads exercise Admission's real wrapper/callback and
// completion receipt path. Native serializers have separate Google/OpenAI tests.
async function harness(t: { after(fn: () => void): void }, api: Api = "openai-completions", subscription = false) {
  const faux = fauxProvider({ api, provider: "cap-fixture", models: [{ id: "dense", contextWindow: 100000, maxTokens: 90000 }] });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  const observations: AdmissionObservation[] = [];
  const sent: unknown[] = [];
  let payload: unknown;
  let usage = 12000;
  // Controlled public auth metadata isolates route selection without credentials or HTTP.
  if (subscription) registry.isUsingOAuth = () => true;
  registry.registerProvider({ ...faux.provider, ...(subscription ? { auth: openaiProvider().auth } : {}), streamSimple(model, _context, options) {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const message = { ...fauxAssistantMessage("anchor"), api: model.api, provider: model.provider, model: model.id };
      try {
        const replacement = await options?.onPayload?.(payload, model);
        sent.push(replacement === undefined ? payload : replacement);
        message.usage = { ...message.usage, input: usage, output: 4, totalTokens: usage + 4 };
        stream.push({ type: "done", reason: "stop", message }); stream.end(message);
      } catch (error) {
        const failed = { ...message, stopReason: "error" as const, errorMessage: String(error) };
        stream.push({ type: "error", reason: "error", error: failed }); stream.end(failed);
      }
    })();
    return stream;
  } });
  const model = faux.getModel();
  const signal = new AbortController().signal;
  const ctx = { model, signal, sessionManager: { getSessionId: () => "caps" }, modelRegistry: registry } as unknown as ExtensionContext;
  const events = createEventBus();
  events.on("nunc:admission", value => observations.push(value as AdmissionObservation));
  const admission = new Admission({ events,
    registerProvider(...args: Parameters<ModelRegistry["registerProvider"]>) { registry.registerProvider(...args); },
    unregisterProvider(id: string) { registry.unregisterProvider(id); },
  } as unknown as ExtensionAPI, () => engineConfig({ budget: { safetyTokens: 100 } }, model, { reserveTokens: 10000, keepRecentTokens: 1 }));
  admission.ensure(ctx);
  t.after(() => admission.close(ctx));
  const options = { signal, sessionId: "caps" };
  return { model, admission, observations, sent, options, registry, ctx,
    setUsage(n: number) { usage = n; },
    async run(body: unknown, messages: TranscriptContext["messages"] = [{ role: "user", content: "x".repeat(20000), timestamp: 1 }], hook?: SimpleStreamOptions["onPayload"]) {
      payload = body;
      const context = normalizeContext({ messages });
      admission.bindProjection({ ...options, model, messages: context.messages, memory: { version: 1, nextId: 1, slots: [] } });
      return registry.getProvider(model.provider)!.streamSimple(model, context, { ...options, ...(hook ? { onPayload: hook } : {}) }).result();
    },
  };
}

test("actual native Responses serialization sends the post-authorization clamp and final observation", async t => {
  const native = openaiProvider();
  const catalog = native.getModels().find(m => m.id === "gpt-4.1");
  assert(catalog && catalog.api === "openai-responses");
  const model = { ...catalog, contextWindow: 100000, maxTokens: 90000, compat: { ...catalog.compat, supportsMaxOutputTokens: true } };
  let nativeCap: number | undefined;
  let sentCap: number | undefined;
  const observations: AdmissionObservation[] = [];
  const f = await fixture({ extras: [{ name: "capture-native-output", factory(pi) {
    pi.events.on("nunc:admission", value => observations.push(value as AdmissionObservation));
    pi.on("before_provider_request", event => {
      const state = outputCapState(event.payload);
      if (state.kind === "value") nativeCap = state.value;
    });
  } }] });
  t.after(() => f.close());
  const fetch: typeof globalThis.fetch = async (resource, init) => {
    const body = await new Request(resource, init).json();
    const state = outputCapState(body);
    assert.equal(state.kind, "value");
    if (state.kind === "value") sentCap = state.value;
    return responsesSSE(model.id, "Controlled response");
  };
  new ModelRegistry(f.modelRuntime).registerProvider({ ...native,
    getModels: () => [model],
    streamSimple: (_m, context, options) => native.streamSimple(model, context, { ...options, apiKey: "sk-offline-fixture-key", fetch, maxRetries: 0 }),
    stream: (_m, context, options) => native.stream(model, context, { ...options, apiKey: "sk-offline-fixture-key", fetch, maxRetries: 0 } as Parameters<typeof native.stream>[2]),
  });
  await f.modelRuntime.setRuntimeApiKey(model.provider, "sk-offline-fixture-key");
  await f.runtime.session.setModel(model);
  await f.runtime.session.prompt("Dense input " + "x".repeat(20000));
  assert(nativeCap && sentCap && sentCap < nativeCap && sentCap >= 36000, JSON.stringify({ nativeCap, sentCap, last: f.runtime.session.messages.at(-1), observations }));
  assert.equal(observations.at(-1)?.outputCapTokens, sentCap);
  assert.deepEqual(observations.at(-1)?.payload?.categories, []);
  const last = f.runtime.session.messages.at(-1);
  assert(last?.role === "assistant");
  assert.equal(last.stopReason, "stop", last.errorMessage ?? "");
});

test("clamping preserves live SDK fields and only clones cap containers", async t => {
  const h = await harness(t, "google-generative-ai");
  const signal = new AbortController().signal;
  const thinkingConfig = { thinkingBudget: 0 };
  const body = { contents: [{ role: "user", parts: [{ text: "x".repeat(20000) }] }],
    config: { maxOutputTokens: 90000, abortSignal: signal, thinkingConfig } };
  assert.equal((await h.run(body)).stopReason, "stop");
  const sent = h.sent[0] as typeof body;
  assert.notEqual(sent, body);
  assert.notEqual(sent.config, body.config);
  assert.equal(sent.contents, body.contents);
  assert.equal(sent.config.abortSignal, signal);
  assert.equal(sent.config.thinkingConfig, thinkingConfig);
  assert.equal(body.config.maxOutputTokens, 90000);
  assert(sent.config.maxOutputTokens < 90000);
});

for (const phase of ["serialize", "throw", "reject", "invalidate", "replace-provider"] as const) test(`payload ${phase} settles rejection without speculative delegate`, async t => {
  const h = await harness(t);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const body = phase === "serialize" ? circular : { max_tokens: 90000, messages: [] };
  const response = await h.run(body, undefined, async () => {
    if (phase === "throw") throw new Error("hook failed");
    if (phase === "reject") return Promise.reject(new Error("hook rejected"));
    if (phase === "invalidate") h.admission.invalidateUsage();
    if (phase === "replace-provider") h.registry.unregisterProvider(h.model.provider);
  });
  assert.equal(response.stopReason, "error");
  assert.equal(h.sent.length, 0);
  assert.deepEqual(h.observations.map(o => o.outcome), ["reject"]);
  assert.equal(h.observations[0]?.code, phase === "invalidate" || phase === "replace-provider" ? "CANCELLED" : "CONFIG");
});

for (const key of ["samplingParams", "samplingParamsByThinkingLevel"] as const) test(`raw model ${key} rejects before provider or hook`, async t => {
  const h = await harness(t);
  Object.assign(h.model, { [key]: key === "samplingParams" ? { max_tokens: 1 } : { off: { max_tokens: 1 } } });
  let hooks = 0;
  const response = await h.run({ max_tokens: 90000 }, undefined, () => { hooks++; });
  assert.equal(response.stopReason, "error");
  assert.match(response.errorMessage ?? "", /Raw sampling payload overrides/);
  assert.equal(hooks, 0);
  assert.equal(h.sent.length, 0);
  assert.deepEqual(h.observations.map(o => [o.outcome, o.code]), [["reject", "CONFIG"]]);
});

const caps = { max_tokens: 90000, max_output_tokens: 90000, max_completion_tokens: 90000,
  generationConfig: { maxOutputTokens: 90000 }, config: { maxOutputTokens: 90000, thinkingConfig: { thinkingBudget: 0 } } };

test("post-authorization clamp clones every cap path, reports final cap, and preserves an output-only receipt", async t => {
  const h = await harness(t);
  const user = { role: "user" as const, content: "x".repeat(20000), timestamp: 1 };
  const body = { ...structuredClone(caps), messages: [user] };
  const original = structuredClone(body);
  const first = await h.run(body, [user], () => undefined);
  assert.equal(first.stopReason, "stop");
  assert.deepEqual(body, original);
  const sent = h.sent[0] as typeof body;
  assert.notEqual(sent, body);
  assert.notEqual(sent.config, body.config);
  assert.notEqual(sent.generationConfig, body.generationConfig);
  const state = outputCapState(sent);
  assert.equal(state.kind, "value");
  assert(state.kind === "value" && state.value >= 25000 && state.value < 80000);
  const observed = h.observations.at(-1)!;
  assert.equal(observed.outputCapTokens, state.kind === "value" ? state.value : -1);
  assert.equal(observed.payload?.mode, "noop");
  assert.deepEqual(observed.payload?.categories, []);
  const follow = { role: "user" as const, content: "next", timestamp: 2 };
  await h.run({ ...structuredClone(caps), messages: [user, first, follow] }, [user, first, follow]);
  assert.equal(h.observations.at(-1)?.estimateReason, "matching-receipt");
  assert.equal(h.observations.at(-1)?.receiptBreakdown?.observedU, 12004);
});

test("provider replacement invalidates completed receipts before the next projection is bound", async t => {
  const h = await harness(t);
  const prefix = { role: "user" as const, content: "establish receipt", timestamp: 1 };
  const first = await h.run({ max_tokens: 100, messages: [prefix] }, [prefix]);
  const prior = h.registry.getProvider(h.model.provider)!;
  h.registry.registerProvider({ ...prior });
  h.admission.ensure(h.ctx);
  const messages = [prefix, first, { role: "user" as const, content: "next", timestamp: 2 }];
  await h.run({ max_tokens: 100, messages }, messages);
  assert.equal(h.observations.at(-1)?.estimateReason, "no-receipt");
  assert.equal(h.observations.at(-1)?.estimator, "pi-heuristic");
});

test("hook expansion and input over-budget growth reject before clamp", async t => {
  const h = await harness(t);
  const body = { max_tokens: 90000, messages: [{ role: "user", content: "x".repeat(20000) }] };
  const expanded = await h.run(body, undefined, p => ({ ...p as typeof body, max_tokens: 90001 }));
  assert.equal(expanded.stopReason, "error");
  assert.match(expanded.errorMessage ?? "", /native serialized ceiling/);
  const grown = await h.run(body, undefined, p => ({ ...p as typeof body, metadata: { text: "z".repeat(400000) } }));
  assert.equal(grown.stopReason, "error");
  assert.match(grown.errorMessage ?? "", /remaining context/);
  assert.equal(h.sent.length, 0);
});

for (const thinking of [
  { thinking: { budget_tokens: 1 } },
  ...["thinking_budget", "thinking_token_budget", "thinking_budget_tokens"].flatMap(key => [{ [key]: 1 }, { thinking: { [key]: 1 } }]),
  { config: { generationConfig: { thinkingConfig: { thinkingBudget: 1 } } } },
  ...["root", "config", "generationConfig"].map(key => key === "root" ? { thinkingConfig: { thinkingBudget: 1 } } : { [key]: { thinkingConfig: { thinkingBudget: 1 } } }),
]) test(`positive coupled thinking budget skips clamp: ${JSON.stringify(thinking)}`, async t => {
  const h = await harness(t);
  const body = { max_tokens: 90000, messages: [{ role: "user", content: "x".repeat(20000) }], ...thinking };
  assert.equal((await h.run(body)).stopReason, "stop");
  assert.equal(h.sent[0], body);
  assert.equal(h.observations.at(-1)?.outputCapTokens, 90000);
});

test("true full-context and below-floor conservative headroom leave native cap untouched without local CAPACITY", async t => {
  const h = await harness(t);
  for (const length of [76000, 110000]) {
    const body = { max_tokens: 90000, messages: [{ role: "user", content: "x".repeat(length) }] };
    assert.equal((await h.run(body)).stopReason, "stop");
    assert.equal(h.sent.at(-1), body);
    assert.equal(h.observations.at(-1)?.outcome, "delegate");
  }
});

test("matching receipt never re-charges a huge measured prefix", async t => {
  const h = await harness(t);
  const prefix = { role: "user" as const, content: "x".repeat(80000), timestamp: 1 };
  const first = await h.run({ max_tokens: 90000, messages: [prefix] }, [prefix]);
  const tail = { role: "user" as const, content: "tiny", timestamp: 2 };
  const body = { max_tokens: 80000, messages: [prefix, first, tail] };
  await h.run(body, [prefix, first, tail]);
  assert.equal(h.observations.at(-1)?.estimateReason, "matching-receipt");
  assert.equal(h.sent.at(-1), body, "observed 12004 + tiny delta fits; serialized prefix is already measured");
});

test("matched receipt charges only trailing characters when mitigation needs a clamp", async t => {
  const h = await harness(t);
  const prefix = { role: "user" as const, content: "x".repeat(20000), timestamp: 1 };
  const first = await h.run({ max_tokens: 90000, messages: [prefix] }, [prefix]);
  const tail = { role: "user" as const, content: "z".repeat(48000), timestamp: 2 };
  await h.run({ max_tokens: 80000, messages: [prefix, first, tail] }, [prefix, first, tail]);
  assert.equal(h.observations.at(-1)?.estimateReason, "matching-receipt");
  const state = outputCapState(h.sent.at(-1));
  assert(state.kind === "value" && state.value > 39000 && state.value < 40000, JSON.stringify(state));
});

test("uncapped routes and missing cap states leave payloads untouched", async t => {
  for (const api of ["openai-codex-responses", "openai-completions"] as const) {
    const h = await harness(t, api);
    const body = { input: [{ role: "user", content: "x".repeat(20000) }] };
    assert.equal((await h.run(body)).stopReason, "stop");
    assert.equal(h.sent.at(-1), body);
    assert.equal(h.observations.at(-1)?.outputCapTokens, null);
  }
});

test("OAuth Responses route rejects hook-invented caps through the real admission callback", async t => {
  const body = { model: "dense", stream: true, input: [{ role: "user", content: "Task" }] };
  for (const subscription of [false, true]) {
    const h = await harness(t, "openai-responses", subscription);
    const unchanged = await h.run(body);
    assert.equal(unchanged.stopReason, "stop");
    const changed = await h.run(body, undefined, payload => ({ ...payload as typeof body, max_output_tokens: 8192 }));
    assert.equal(changed.stopReason, subscription ? "error" : "stop");
    if (subscription) {
      assert.match(changed.errorMessage ?? "", /invented an output cap/);
      assert.equal(h.sent.length, 1, "rejected hook never reaches controlled transport");
      assert.equal(h.observations.at(-1)?.outcome, "reject");
    }
  }
});

test("route omission distinguishes Anthropic subscription from Responses and shares serializer floors", () => {
  const registry = { isUsingOAuth: () => true, getProvider: () => ({ auth: { oauth: { isSubscription: true } } }) } as unknown as Parameters<typeof omitsRouteOutputCap>[1];
  for (const [api, omitted, floor] of [["anthropic-messages", false, 1], ["openai-responses", true, 16], ["azure-openai-responses", false, 16], ["openai-codex-responses", true, 1]] as const) {
    const model = { api } as Model<Api>;
    assert.equal(omitsRouteOutputCap(model, registry), omitted);
    assert.equal(outputFloor(model), floor);
  }
});
