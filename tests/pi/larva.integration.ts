import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, chmodSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { zstdDecompressSync } from "node:zlib";
import { fauxAssistantMessage, fauxToolCall, type Model, type Provider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { ModelRegistry, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, type AdmissionObservation } from "../../src/pi/admission.js";
import { applyLastUserTextAppend } from "../../src/pi/payload.js";
import { memorySurface, type MemorySurface } from "../../src/pi/manual.js";
import { renderMemory } from "../../src/engine/memory.js";
import { memoryTokens } from "../../src/engine/accounting.js";
import { fixture, memoryPatch } from "./fixtures.js";
import { oauthFixture } from "./oauth-fixture.js";

// Check NUNC_LARVA_EXTENSION: must be present and exist; no skipping or double substitution allowed.
const larvaExtensionPath = process.env.NUNC_LARVA_EXTENSION;
if (!larvaExtensionPath || !existsSync(larvaExtensionPath)) {
  console.error(`Missing or inaccessible NUNC_LARVA_EXTENSION: ${larvaExtensionPath ?? "undefined"}`);
  process.exit(1);
}

// Clean any inherited parent session LARVA_* environment variables to prevent host leakage.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("LARVA_") && key !== "LARVA_CLI_ARGV_JSON") {
    delete process.env[key];
  }
}

// Setup task-isolated mock Larva CLI for synthetic persona specs
const isolatedDir = mkdtempSync(join(tmpdir(), "nunc-larva-int-"));
const mockLarvaScript = join(isolatedDir, "mock-larva.mjs");

writeFileSync(
  mockLarvaScript,
  `
const args = process.argv.slice(2);
if (args[0] === "resolve") {
  const id = args[1];
  const model = id.includes("responses") ? "openai/gpt-4.1" : "openai-codex/gpt-6-astra";
  console.log(JSON.stringify({
    data: {
      id,
      description: "Synthetic persona " + id,
      prompt: "You are synthetic persona " + id + ". Specialized instructions active.",
      model,
      capabilities: {},
      model_params: {},
      can_spawn: true,
      spec_version: "0.1.0"
    }
  }));
  process.exit(0);
}
if (args[0] === "list") {
  console.log(JSON.stringify({
    data: [
      { id: "synth-codex-primary", description: "Primary", prompt: "Primary prompt", model: "openai-codex/gpt-6-astra", capabilities: {}, model_params: {}, can_spawn: true, spec_version: "0.1.0" },
      { id: "synth-codex-specialist", description: "Specialist", prompt: "Specialist prompt", model: "openai-codex/gpt-6-astra", capabilities: {}, model_params: {}, can_spawn: true, spec_version: "0.1.0" },
      { id: "synth-responses", description: "Responses", prompt: "Responses prompt", model: "openai/gpt-4.1", capabilities: {}, model_params: {}, can_spawn: true, spec_version: "0.1.0" }
    ]
  }));
  process.exit(0);
}
process.exit(1);
`
);
chmodSync(mockLarvaScript, 0o755);

process.env.LARVA_CLI_ARGV_JSON = JSON.stringify([process.execPath, mockLarvaScript]);

// Helper for Responses SSE stream
function responsesSSE(modelId: string, text: string) {
  const item = { type: "message", id: "msg-1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: "response-1", model: modelId, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "response-1", model: modelId, status: "completed", output: [item], usage: { input_tokens: 128, output_tokens: 4, total_tokens: 132, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ];
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

// Helper for Codex SSE stream
function codexSSE(modelId: string, text: string) {
  const item = { type: "message", id: "msg-1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: "response-1", model: modelId, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "response-1", model: modelId, status: "completed", output: [item], usage: { input_tokens: 128, output_tokens: 4, total_tokens: 132, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ];
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

// Bounded wait helper to prevent indefinite hanging
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timeout after ${timeoutMs}ms: ${message}`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

after(() => {
  rmSync(isolatedDir, { recursive: true, force: true });
  assert(!existsSync(isolatedDir), "Isolated test directory must be completely removed");
});

test("real loader loads user-supplied Larva v1 and resolves system prompt through native Responses serializer", async t => {
  const admissions: AdmissionObservation[] = [];
  const bodies: Record<string, unknown>[] = [];

  const f = await fixture({
    extensions: [larvaExtensionPath],
    flagValues: [["larva-agent-persona-switch", "auto"]],
    extras: [{
      name: "watch-admission",
      factory(pi) {
        pi.events.on("nunc:admission", val => admissions.push(val as AdmissionObservation));
      },
    }],
  });
  t.after(async () => {
    await f.close();
  });

  const provider = openaiProvider();
  const model = provider.getModels().find(m => m.id === "gpt-4.1");
  assert(model);

  const transport: typeof fetch = async (resource, init) => {
    const request = new Request(resource, init);
    const body = await request.json() as Record<string, unknown>;
    bodies.push(body);
    return responsesSSE(model.id, "Controlled Responses answer.");
  };

  const bound = { apiKey: "offline-test-key", fetch: transport, maxRetries: 0 as const };
  const wrapped: Provider = {
    ...provider,
    stream: (m, context, options) => provider.stream(m as Model<"openai-responses">, context, { ...options, ...bound } as Parameters<typeof provider.stream>[2]),
    streamSimple: (m, context, options) => provider.streamSimple(m as Model<"openai-responses">, context, { ...options, ...bound }),
  };
  new ModelRegistry(f.modelRuntime).registerProvider(wrapped);
  await f.modelRuntime.setRuntimeApiKey("openai", "offline-test-key");
  await f.runtime.session.setModel(model);

  await f.runtime.session.prompt("/larva-persona synth-responses");
  await f.runtime.session.prompt("Execute task via native Responses serializer");

  assert.equal(bodies.length, 1);
  const wireInput = JSON.stringify(bodies[0]?.input);
  assert(wireInput.includes("synth-responses"));
  assert(wireInput.includes("Specialized instructions active"));

  const main = admissions.filter(a => a.kind === "main").at(-1);
  assert(main);
  assert.equal(main.outcome, "delegate");
  assert.equal(main.resolution, "resolved");
});

test("stable actual Larva state leaves target instructions unchanged in native Codex serializer and establishes reusable receipt", async t => {
  const admissions: AdmissionObservation[] = [];
  const bodies: Record<string, unknown>[] = [];

  const f = await fixture({
    extensions: [larvaExtensionPath],
    flagValues: [["larva-agent-persona-switch", "auto"]],
    extras: [{
      name: "watch-admission",
      factory(pi) {
        pi.events.on("nunc:admission", val => admissions.push(val as AdmissionObservation));
      },
    }],
  });
  t.after(async () => {
    await f.close();
  });

  const provider = openaiCodexProvider();
  const model = provider.getModels().find(m => m.id === "gpt-6-astra");
  assert(model);

  const transport: typeof fetch = async (resource, init) => {
    const request = new Request(resource, init);
    const bytes = Buffer.from(await request.arrayBuffer());
    const decoded = request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes;
    const body = JSON.parse(decoded.toString("utf8")) as Record<string, unknown>;
    bodies.push(body);
    return codexSSE(model.id, "Controlled Codex answer.");
  };

  const credential = oauthFixture();
  await f.credentials.modify(model.provider, async () => credential);
  const bound = { apiKey: credential.access, fetch: transport, transport: "sse" as const, maxRetries: 0 as const };
  const nativeModel = (m: Model<any>): Model<"openai-codex-responses"> => ({ ...m, api: "openai-codex-responses" });
  const wrapped: Provider = {
    ...provider,
    stream: (m, context, options) => provider.stream(nativeModel(m), context, { ...options, ...bound } as Parameters<typeof provider.stream>[2]),
    streamSimple: (m, context, options) => provider.streamSimple(nativeModel(m), context, { ...options, ...bound }),
  };
  new ModelRegistry(f.modelRuntime).registerProvider(wrapped);
  await f.runtime.session.setModel(model);

  await f.runtime.session.prompt("/larva-persona synth-codex-primary");

  // Turn 1: establishes receipt under stable Larva persona
  await f.runtime.session.prompt("Turn 1 Codex prompt");
  assert.equal(bodies.length, 1);
  assert(typeof bodies[0]?.instructions === "string");
  assert(bodies[0]!.instructions.includes("synth-codex-primary"));
  assert(bodies[0]!.instructions.includes("Specialized instructions active"));

  const turn1 = admissions.filter(a => a.kind === "main").at(-1);
  assert(turn1);
  assert.equal(turn1.outcome, "delegate");
  assert.equal(turn1.resolution, "resolved");
  assert.equal(turn1.estimator, "pi-heuristic");

  // Turn 2: stable state repeat must reuse receipt and keep payload instructions unchanged
  await f.runtime.session.prompt("Turn 2 Codex prompt with unchanged Larva state");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1]!.instructions, bodies[0]!.instructions);

  const turn2 = admissions.filter(a => a.kind === "main").at(-1);
  assert(turn2);
  assert.equal(turn2.outcome, "delegate");
  assert.equal(turn2.resolution, "resolved");
  assert.equal(turn2.estimator, "pi-usage-backed");
  assert.equal(turn2.estimateReason, "matching-receipt");
});

test("temporary borrow and automatic restoration with adjacent M writes, continuation and idle callback on native Codex serializer", async t => {
  const admissions: AdmissionObservation[] = [];
  const bodies: Record<string, unknown>[] = [];
  let piRef: ExtensionAPI | undefined;
  let ctxRef: ExtensionContext;
  let surfaceRef: MemorySurface;
  let borrowedWrite = false;
  const settledResolvers: Array<() => void> = [];

  const f = await fixture({
    extensions: [larvaExtensionPath],
    flagValues: [["larva-agent-persona-switch", "auto"]],
    extras: [{
      name: "watch-admission",
      factory(pi) {
        piRef = pi;
        surfaceRef = memorySurface(pi)!;
        pi.on("session_start", (_event, ctx) => { ctxRef = ctx; });
        pi.on("tool_result", (event, ctx) => {
          if (event.toolName !== "larva_persona_switch") return;
          const v = surfaceRef.read(ctx);
          const result = surfaceRef.patch(ctx, { expectedRevision: v.revision, update: [{ id: "s1", text: "M2 after actual borrow" }] });
          assert.equal(result.ok, true);
          borrowedWrite = true;
        });
        pi.events.on("nunc:admission", val => admissions.push(val as AdmissionObservation));
        pi.on("agent_settled", () => {
          const r = settledResolvers.shift();
          r?.();
        });
      },
    }],
  });
  t.after(async () => {
    await f.close();
  });

  const provider = openaiCodexProvider();
  const model = provider.getModels().find(m => m.id === "gpt-6-astra");
  assert(model);

  function toolCallSSE(modelId: string, toolName: string, args: Record<string, unknown>, callId: string) {
    const item = {
      type: "function_call",
      id: "fc_borrow_1",
      call_id: callId,
      name: toolName,
      arguments: JSON.stringify(args),
    };
    const events = [
      { type: "response.created", response: { id: "r1", model: modelId, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "r1", model: modelId, status: "completed", output: [item], usage: { input_tokens: 120, output_tokens: 25, total_tokens: 145, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
    ];
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }

  let continuationDelivered: () => void;
  const continuationPromise = new Promise<void>(resolve => { continuationDelivered = resolve; });

  let sendCount = 0;
  const transport: typeof fetch = async (resource, init) => {
    sendCount++;
    const request = new Request(resource, init);
    const bytes = Buffer.from(await request.arrayBuffer());
    const decoded = request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes;
    const body = JSON.parse(decoded.toString("utf8")) as Record<string, unknown>;
    bodies.push(body);
    if (sendCount === 1) {
      // Turn 1: Return tool call to larva_persona_switch borrowing synth-codex-specialist with continue_task: true
      return toolCallSSE(model.id, "larva_persona_switch", {
        persona_id: "synth-codex-specialist",
        reason: "Route rationale: temporary borrow for specialized computation",
        continue_task: true,
      }, "call-borrow-1");
    }
    if (sendCount === 2) {
      // Turn 2: Continuation turn runs under borrowed specialist
      continuationDelivered();
      return codexSSE(model.id, "Specialist continuation completed.");
    }
    // Turn 3: Idle callback turn runs under restored primary persona
    return codexSSE(model.id, "Idle turn completed.");
  };

  const credential = oauthFixture();
  await f.credentials.modify(model.provider, async () => credential);
  const bound = { apiKey: credential.access, fetch: transport, transport: "sse" as const, maxRetries: 0 as const };
  const nativeModel = (m: Model<any>): Model<"openai-codex-responses"> => ({ ...m, api: "openai-codex-responses" });
  const wrapped: Provider = {
    ...provider,
    stream: (m, context, options) => provider.stream(nativeModel(m), context, { ...options, ...bound } as Parameters<typeof provider.stream>[2]),
    streamSimple: (m, context, options) => provider.streamSimple(nativeModel(m), context, { ...options, ...bound }),
  };
  new ModelRegistry(f.modelRuntime).registerProvider(wrapped);
  await f.runtime.session.setModel(model);

  await f.runtime.session.prompt("/larva-persona synth-codex-primary");

  assert.equal(surfaceRef!.patch(ctxRef!, { expectedRevision: surfaceRef!.read(ctxRef!).revision, add: [{ key: "initial", text: "M1 before borrow" }] }).ok, true);

  // Step 1: Start turn 1 that triggers tool call to larva_persona_switch
  const settled1 = withTimeout(new Promise<void>(resolve => settledResolvers.push(resolve)), 15000, "Turn 1 settle timeout");
  await f.runtime.session.prompt("Calculate task requiring specialized borrow");
  await settled1;

  // Step 2: Await turn 2 continuation delivery and settling via actual lifecycle events
  const settled2 = withTimeout(new Promise<void>(resolve => settledResolvers.push(resolve)), 15000, "Turn 2 settle timeout");
  await withTimeout(continuationPromise, 15000, "Continuation delivery timeout");
  await settled2;

  // Turn 2 assertions (Continuation):
  assert.equal(borrowedWrite, true);
  assert.equal(bodies.length, 2);
  assert(JSON.stringify((bodies[0]!.input as unknown[]).at(-1)).includes("M1 before borrow"));
  assert(JSON.stringify((bodies[1]!.input as unknown[]).at(-1)).includes("M2 after actual borrow"));
  const contBody = bodies[1]!;
  assert(typeof contBody.instructions === "string");
  assert(contBody.instructions.includes("synth-codex-specialist"));
  assert(contBody.instructions.includes("larva_persona_switch_continuation"));
  assert(contBody.instructions.includes("Switched from synth-codex-primary to synth-codex-specialist"));

  // Check Nunc admission for continuation turn
  const contAdmission = admissions.filter(a => a.kind === "main" && a.outcome === "delegate" && a.payload)[1];
  assert(contAdmission);
  assert.equal(contAdmission.resolution, "resolved");
  assert.equal(contAdmission.payload?.mode, "identity");

  assert.equal(surfaceRef!.patch(ctxRef!, { expectedRevision: surfaceRef!.read(ctxRef!).revision, update: [{ id: "s1", text: "M3 after automatic restoration" }] }).ok, true);
  // Step 3: Trigger idle callback, proving lease automatically restored to synth-codex-primary and continuation expired
  assert(piRef);
  const settled3 = withTimeout(new Promise<void>(resolve => settledResolvers.push(resolve)), 15000, "Idle turn settle timeout");
  piRef.sendMessage({ customType: "idle-callback", content: "Idle ping", display: true }, { triggerTurn: true, deliverAs: "steer" });
  await settled3;

  assert.equal(bodies.length, 3);
  const idleBody = bodies[2]!;
  assert(typeof idleBody.instructions === "string");
  assert(idleBody.instructions.includes("synth-codex-primary"));
  assert.doesNotMatch(idleBody.instructions, /synth-codex-specialist/);
  assert.doesNotMatch(idleBody.instructions, /larva_persona_switch_continuation/);

  // Wire instructions for idle turn strictly equals the Turn 1 primary wire instructions
  assert.equal(idleBody.instructions, bodies[0]!.instructions);

  // Check Nunc admission for idle callback turn: restored primary prompt resolved and receipt reused
  const idleAdmission = admissions.filter(a => a.kind === "main" && a.outcome === "delegate").at(-1);
  assert(idleAdmission);
  assert.equal(idleAdmission.resolution, "resolved");
  assert.equal(idleAdmission.estimator, "pi-usage-backed");
  assert.equal(idleAdmission.estimateReason, "matching-receipt");
  assert.equal(idleAdmission.receiptBreakdown?.currentMTokens, memoryTokens(surfaceRef!.read(ctxRef!).memory.slots));
  assert.equal(idleAdmission.receiptBreakdown?.retainedOldMMargin, true);
  assert.equal(idleAdmission.receiptBreakdown?.observedU, 145);
  assert(JSON.stringify((idleBody.input as unknown[]).at(-1)).includes("M3 after automatic restoration"));
});

test("real resource reload invalidates old resolver listener and native maintenance stays isolated", async t => {
  let capturedBus: any;
  let maintenanceActive = false;
  let maintenanceResolverEmissions = 0;

  const f = await fixture({
    extensions: [larvaExtensionPath],
    flagValues: [["larva-agent-persona-switch", "auto"]],
    bus(b) {
      capturedBus = b;
      const origEmit = b.emit;
      b.emit = (channel, data) => {
        if (channel === LARVA_RESOLVE_SYSTEM_PROMPT_EVENT && maintenanceActive) {
          maintenanceResolverEmissions++;
        }
        return origEmit(channel, data);
      };
    },
  });
  t.after(async () => {
    await f.close();
  });

  await f.runtime.session.prompt("/larva-persona synth-codex-primary");

  // Step 1: Prove exactly ONE resolver reply from initial instance
  let repliesBefore = 0;
  capturedBus.emit(LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, {
    scope: "main",
    systemPrompt: "test",
    reply: () => { repliesBefore++; },
  });
  assert.equal(repliesBefore, 1);

  // Step 2: Native maintenance isolation - count emissions during compact()
  f.seed();
  f.respond(memoryPatch);
  maintenanceActive = true;
  await f.runtime.session.compact();
  maintenanceActive = false;
  // Maintenance must cause exactly ZERO resolver event emissions!
  assert.equal(maintenanceResolverEmissions, 0);

  // Step 3: Real resource reload
  await f.runtime.session.reload();

  // Step 4: After real reload, old listener was invalidated; exactly ONE reply from new instance
  let repliesAfter = 0;
  capturedBus.emit(LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, {
    scope: "main",
    systemPrompt: "test",
    reply: () => { repliesAfter++; },
  });
  assert.equal(repliesAfter, 1, "Old instance must be unregistered; exactly one new resolver replies");
});

test("genuine late change at before_provider_request validates and charges growth", async t => {
  const admissions: AdmissionObservation[] = [];
  const EXTRA_TEXT = "\nLate appended instruction note.";

  const f = await fixture({
    extensions: [larvaExtensionPath],
    flagValues: [["larva-agent-persona-switch", "auto"]],
    extras: [{
      name: "late-hook",
      factory(pi) {
        pi.events.on("nunc:admission", val => admissions.push(val as AdmissionObservation));
        pi.on("before_provider_request", (event: any) => {
          const applied = applyLastUserTextAppend(event.payload, EXTRA_TEXT);
          return applied.changed ? applied.payload : undefined;
        });
      },
    }],
  });
  t.after(async () => {
    await f.close();
  });

  const openai = openaiProvider();
  const model = openai.getModels().find(m => m.id === "gpt-4.1")!;
  const wrapped: Provider = {
    ...openai,
    stream: (m, context, options) => openai.stream(m as Model<"openai-responses">, context, {
      ...options,
      apiKey: "offline-test-key",
      maxRetries: 0 as const,
      fetch: async () => responsesSSE(model.id, "Answer with late hook."),
    } as Parameters<typeof openai.stream>[2]),
    streamSimple: (m, context, options) => openai.streamSimple(m as Model<"openai-responses">, context, {
      ...options,
      apiKey: "offline-test-key",
      maxRetries: 0 as const,
      fetch: async () => responsesSSE(model.id, "Answer with late hook."),
    }),
  };
  new ModelRegistry(f.modelRuntime).registerProvider(wrapped);
  await f.modelRuntime.setRuntimeApiKey("openai", "offline-test-key");
  await f.runtime.session.setModel(model);

  await f.runtime.session.prompt("/larva-persona synth-responses");
  await f.runtime.session.prompt("Turn with late modification");

  const main = admissions.filter(a => a.kind === "main" && a.outcome === "delegate" && a.payload).at(-1);
  assert(main);
  assert.equal(main.outcome, "delegate");
  assert.equal(main.resolution, "resolved");
  assert(main.payload);
  assert.equal(main.payload.transform, "last-user-text-append");
});

test("real Pi/Larva/Nunc joint loop: model-tool M mutation, native serializer wire payload verification, tail carrier, and usage-backed receipt reuse", async t => {
  const admissions: AdmissionObservation[] = [];
  const bodies: Record<string, unknown>[] = [];
  const settledResolvers: Array<() => void> = [];
  let surfaceRef: any;
  let ctxRef: any;

  const f = await fixture({
    extensions: [larvaExtensionPath],
    flagValues: [
      ["larva-agent-persona-switch", "auto"],
      ["nunc-memory-tools", "true"],
    ],
    extras: [{
      name: "watch-admission",
      factory(pi) {
        pi.events.on("nunc:admission", val => admissions.push(val as AdmissionObservation));
        pi.on("session_start", (_event, ctx) => { ctxRef = ctx; });
        surfaceRef = memorySurface(pi);
        pi.on("agent_settled", () => {
          const r = settledResolvers.shift();
          r?.();
        });
      },
    }],
  });
  t.after(async () => {
    await f.close();
  });

  const provider = openaiCodexProvider();
  const model = provider.getModels().find(m => m.id === "gpt-6-astra")!;
  assert(model);

  function toolCallSSE(modelId: string, toolName: string, args: Record<string, unknown>, callId: string) {
    const item = {
      type: "function_call",
      id: "fc_" + callId,
      call_id: callId,
      name: toolName,
      arguments: JSON.stringify(args),
    };
    const events = [
      { type: "response.created", response: { id: "r_" + callId, model: modelId, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "r_" + callId, model: modelId, status: "completed", output: [item], usage: { input_tokens: 150, output_tokens: 30, total_tokens: 180, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
    ];
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }

  let sendCount = 0;
  const transport: typeof fetch = async (resource, init) => {
    sendCount++;
    const request = new Request(resource, init);
    const bytes = Buffer.from(await request.arrayBuffer());
    const decoded = request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes;
    const body = JSON.parse(decoded.toString("utf8")) as Record<string, unknown>;
    bodies.push(body);

    if (sendCount === 1) {
      // Prompt 1, turn 1: Call nunc_memory_read
      return toolCallSSE(model.id, "nunc_memory_read", {}, "call-read-1");
    }
    if (sendCount === 2) {
      // Prompt 1, turn 2: Read output received, call nunc_memory_patch to add note
      const currentRev = surfaceRef.read(ctxRef).revision;
      return toolCallSSE(model.id, "nunc_memory_patch", {
        expectedRevision: currentRev,
        add: [{ key: "task-goal", text: "Verified joint Larva Nunc integration note" }],
      }, "call-patch-1");
    }
    if (sendCount === 3) {
      // Prompt 1, turn 3: Patch output received, complete turn 1
      return codexSSE(model.id, "Memory updated successfully.");
    }
    // Prompt 2 (turn 2): Return completion
    return codexSSE(model.id, "Second prompt completed.");
  };

  const credential = oauthFixture();
  await f.credentials.modify(model.provider, async () => credential);
  const bound = { apiKey: credential.access, fetch: transport, transport: "sse" as const, maxRetries: 0 as const };
  const nativeModel = (m: Model<any>): Model<"openai-codex-responses"> => ({ ...m, api: "openai-codex-responses" });
  const wrapped: Provider = {
    ...provider,
    stream: (m, context, options) => provider.stream(nativeModel(m), context, { ...options, ...bound } as Parameters<typeof provider.stream>[2]),
    streamSimple: (m, context, options) => provider.streamSimple(nativeModel(m), context, { ...options, ...bound }),
  };
  new ModelRegistry(f.modelRuntime).registerProvider(wrapped);
  await f.runtime.session.setModel(model);

  // Set persona via Larva
  await f.runtime.session.prompt("/larva-persona synth-codex-primary");

  // Step 1: Prompt 1 triggers tool loop (read -> patch -> done)
  const settled1 = withTimeout(new Promise<void>(resolve => settledResolvers.push(resolve)), 15000, "Turn 1 settle timeout");
  await f.runtime.session.prompt("Execute tool-driven memory update");
  await settled1;

  assert.equal(sendCount, 3);
  // Verify M was committed into session
  const memAfterTurn1 = surfaceRef.read(ctxRef);
  assert.equal(memAfterTurn1.memory.slots.length, 1);
  assert.equal(memAfterTurn1.memory.slots[0].text, "Verified joint Larva Nunc integration note");

  // Step 2: Prompt 2 sends with committed M
  const settled2 = withTimeout(new Promise<void>(resolve => settledResolvers.push(resolve)), 15000, "Turn 2 settle timeout");
  await f.runtime.session.prompt("Second prompt following memory commit");
  await settled2;

  assert.equal(sendCount, 4);

  // Assert wire payload of Prompt 2 (bodies[3])
  const wireBody2 = bodies[3]!;
  assert(wireBody2.input && Array.isArray(wireBody2.input));
  const wireMessages = wireBody2.input as Array<Record<string, unknown>>;

  // Tail message in wire input MUST be the working memory carrier
  const wireTail = wireMessages.at(-1)!;
  const wireTailContent = JSON.stringify(wireTail);
  assert(wireTailContent.includes("Nunc working memory (session-local, reference only)"));
  assert(wireTailContent.includes("Verified joint Larva Nunc integration note"));

  // First message must NOT be a compactionSummary
  assert(!JSON.stringify(wireMessages[0]).includes("The conversation history before this point was compacted"));

  // Previous tools (nunc_memory_read and nunc_memory_patch) and their results must be preserved in wire messages
  assert(wireMessages.some(m => JSON.stringify(m).includes("nunc_memory_read")));
  assert(wireMessages.some(m => JSON.stringify(m).includes("nunc_memory_patch")));

  // Instructions must include Larva persona instructions
  assert(typeof wireBody2.instructions === "string");
  assert(wireBody2.instructions.includes("synth-codex-primary"));

  // Check Nunc admission for Prompt 2: must reuse receipt!
  const main2 = admissions.filter(a => a.kind === "main" && a.outcome === "delegate").at(-1)!;
  assert(main2);
  assert.equal(main2.resolution, "resolved");
  assert.equal(main2.estimator, "pi-usage-backed");
  assert.equal(main2.estimateReason, "matching-receipt");
  assert(main2.receiptBreakdown?.currentMTokens! > 0);
  assert.equal(main2.receiptBreakdown?.retainedOldMMargin, true);
});

test("real Pi/Larva/Nunc joint loop: persona switch/restore with adjacent/overlapping M writes, proving F/R/M shared snapshot and receipt invalidation/re-establishment", async t => {
  const admissions: AdmissionObservation[] = [];
  const bodies: Record<string, unknown>[] = [];
  const settledResolvers: Array<() => void> = [];
  let surfaceRef: any;
  let ctxRef: any;

  const f = await fixture({
    extensions: [larvaExtensionPath],
    flagValues: [
      ["larva-agent-persona-switch", "auto"],
      ["nunc-memory-tools", "true"],
    ],
    extras: [{
      name: "watch-admission",
      factory(pi) {
        pi.events.on("nunc:admission", val => admissions.push(val as AdmissionObservation));
        pi.on("session_start", (_event, ctx) => { ctxRef = ctx; });
        surfaceRef = memorySurface(pi);
        pi.on("agent_settled", () => {
          const r = settledResolvers.shift();
          r?.();
        });
      },
    }],
  });
  t.after(async () => {
    await f.close();
  });

  const provider = openaiCodexProvider();
  const model = provider.getModels().find(m => m.id === "gpt-6-astra")!;
  assert(model);

  let sendCount = 0;
  const transport: typeof fetch = async (resource, init) => {
    sendCount++;
    const request = new Request(resource, init);
    const bytes = Buffer.from(await request.arrayBuffer());
    const decoded = request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes;
    const body = JSON.parse(decoded.toString("utf8")) as Record<string, unknown>;
    bodies.push(body);
    return codexSSE(model.id, `Response ${sendCount}`);
  };

  const credential = oauthFixture();
  await f.credentials.modify(model.provider, async () => credential);
  const bound = { apiKey: credential.access, fetch: transport, transport: "sse" as const, maxRetries: 0 as const };
  const nativeModel = (m: Model<any>): Model<"openai-codex-responses"> => ({ ...m, api: "openai-codex-responses" });
  const wrapped: Provider = {
    ...provider,
    stream: (m, context, options) => provider.stream(nativeModel(m), context, { ...options, ...bound } as Parameters<typeof provider.stream>[2]),
    streamSimple: (m, context, options) => provider.streamSimple(nativeModel(m), context, { ...options, ...bound }),
  };
  new ModelRegistry(f.modelRuntime).registerProvider(wrapped);
  await f.runtime.session.setModel(model);

  // Initial persona: synth-codex-primary
  await f.runtime.session.prompt("/larva-persona synth-codex-primary");

  // Step 1: Write M1 under primary persona
  const v0 = surfaceRef.read(ctxRef);
  const p1 = surfaceRef.patch(ctxRef, {
    expectedRevision: v0.revision,
    add: [{ key: "note1", text: "Primary persona note M1" }],
  });
  assert(p1.ok);

  // Turn 1: Prompt 1 sends with primary persona and M1
  const settled1 = withTimeout(new Promise<void>(resolve => settledResolvers.push(resolve)), 15000, "Turn 1 settle timeout");
  await f.runtime.session.prompt("Prompt 1 under primary");
  await settled1;

  assert.equal(sendCount, 1);
  const wire1 = bodies[0]!;
  assert(typeof wire1.instructions === "string" && wire1.instructions.includes("synth-codex-primary"));
  const tail1 = (wire1.input as Array<Record<string, unknown>>).at(-1)!;
  assert(JSON.stringify(tail1).includes("Primary persona note M1"));

  // Turn 2: Follow-up prompt under same primary persona and same M1 -> reuses receipt 1!
  const settled2 = withTimeout(new Promise<void>(resolve => settledResolvers.push(resolve)), 15000, "Turn 2 settle timeout");
  await f.runtime.session.prompt("Prompt 2 under primary (expect receipt reuse)");
  await settled2;

  assert.equal(sendCount, 2);
  const adm2 = admissions.filter(a => a.kind === "main" && a.outcome === "delegate").at(-1)!;
  assert.equal(adm2.estimator, "pi-usage-backed");
  assert.equal(adm2.estimateReason, "matching-receipt");

  // Step 2: Persona switch to specialist AND overlapping M update to M2
  await f.runtime.session.prompt("/larva-persona synth-codex-specialist");
  const v1 = surfaceRef.read(ctxRef);
  const p2 = surfaceRef.patch(ctxRef, {
    expectedRevision: v1.revision,
    add: [{ key: "note2", text: "Specialist persona note M2" }],
  });
  assert(p2.ok);

  // Turn 3: Prompt 3 sends under specialist persona and M2
  const settled3 = withTimeout(new Promise<void>(resolve => settledResolvers.push(resolve)), 15000, "Turn 3 settle timeout");
  await f.runtime.session.prompt("Prompt 3 under specialist");
  await settled3;

  assert.equal(sendCount, 3);
  const wire3 = bodies[2]!;
  assert(typeof wire3.instructions === "string" && wire3.instructions.includes("synth-codex-specialist"));
  const tail3 = (wire3.input as Array<Record<string, unknown>>).at(-1)!;
  assert(JSON.stringify(tail3).includes("Specialist persona note M2"));

  // Check Nunc admission for Prompt 3: systemPrompt changed, so cannot reuse receipt 2!
  const adm3 = admissions.filter(a => a.kind === "main" && a.outcome === "delegate").at(-1)!;
  assert.equal(adm3.estimateReason, "system-mismatch");
  assert.equal(adm3.estimator, "pi-heuristic");

  // Turn 4: Follow-up prompt under specialist persona with M2 -> reuses receipt 3!
  const settled4 = withTimeout(new Promise<void>(resolve => settledResolvers.push(resolve)), 15000, "Turn 4 settle timeout");
  await f.runtime.session.prompt("Prompt 4 under specialist (expect receipt reuse)");
  await settled4;

  assert.equal(sendCount, 4);
  const adm4 = admissions.filter(a => a.kind === "main" && a.outcome === "delegate").at(-1)!;
  assert.equal(adm4.estimator, "pi-usage-backed");
  assert.equal(adm4.estimateReason, "matching-receipt");

  // Step 3: Restore persona back to primary
  await f.runtime.session.prompt("/larva-persona synth-codex-primary");

  // Turn 5: Prompt 5 sends under restored primary persona
  const settled5 = withTimeout(new Promise<void>(resolve => settledResolvers.push(resolve)), 15000, "Turn 5 settle timeout");
  await f.runtime.session.prompt("Prompt 5 under restored primary");
  await settled5;

  assert.equal(sendCount, 5);
  const wire5 = bodies[4]!;
  assert(typeof wire5.instructions === "string" && wire5.instructions.includes("synth-codex-primary"));
  const tail5 = (wire5.input as Array<Record<string, unknown>>).at(-1)!;
  assert(JSON.stringify(tail5).includes("Specialist persona note M2"));

  // Reuses the earlier compatible receipt from Turn 2 (with deltaR covering Turns 3 and 4)!
  const adm5 = admissions.filter(a => a.kind === "main" && a.outcome === "delegate").at(-1)!;
  assert.equal(adm5.estimator, "pi-usage-backed");
  assert.equal(adm5.estimateReason, "matching-receipt");
  assert(adm5.anchorTrailingMessages! >= 2);
});

test("real Pi/Larva/Nunc: idle M, compact engine-to-native-terminal exclusion, then reload reconstructs M and receipts", { timeout: 30000 }, async t => {
  const admissions: AdmissionObservation[] = [];
  const bodies: Record<string, unknown>[] = [];
  const settledResolvers: Array<() => void> = [];
  let piRef: ExtensionAPI | undefined;
  let surfaceRef: MemorySurface;
  let ctxRef: ExtensionContext;
  let inMaintenance = false;
  let nativeSaved = 0;
  let engineReturned = false;
  const beforeTerminal = Promise.withResolvers<void>();
  const releaseTerminal = Promise.withResolvers<void>();
  t.after(() => releaseTerminal.resolve());

  const f = await fixture({
    extensions: [larvaExtensionPath],
    flagValues: [
      ["larva-agent-persona-switch", "auto"],
      ["nunc-memory-tools", "true"],
    ],
    extras: [{
      name: "watch-admission",
      factory(pi) {
        piRef = pi;
        pi.events.on("nunc:admission", val => admissions.push(val as AdmissionObservation));
        pi.on("session_start", (_event, ctx) => { ctxRef = ctx; });
        surfaceRef = memorySurface(pi)!;
        pi.events.on("nunc:maintenance", (value: any) => { engineReturned = value.result.ok; });
        // This later public hook runs after Nunc returned the candidate, while Pi
        // still has not appended its compaction or emitted the terminal event.
        pi.on("session_before_compact", async () => {
          assert.equal(engineReturned, true);
          beforeTerminal.resolve();
          await withTimeout(releaseTerminal.promise, 15000, "release native terminal");
        });
        pi.on("session_compact", (event, ctx) => {
          assert(ctx.sessionManager.getEntries().some(e => e.id === event.compactionEntry.id));
          assert.equal(surfaceRef.read(ctx).status.occupied, false);
          nativeSaved++;
        });
        pi.on("agent_settled", () => {
          const r = settledResolvers.shift();
          r?.();
        });
      },
    }],
  });
  t.after(async () => {
    await f.close();
  });

  const provider = openaiCodexProvider();
  const model = provider.getModels().find(m => m.id === "gpt-6-astra")!;
  assert(model);

  let sendCount = 0;
  const transport: typeof fetch = async (resource, init) => {
    sendCount++;
    const request = new Request(resource, init);
    const bytes = Buffer.from(await request.arrayBuffer());
    const decoded = request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes;
    const body = JSON.parse(decoded.toString("utf8")) as Record<string, unknown>;
    bodies.push(body);
    return codexSSE(model.id, inMaintenance
      ? JSON.stringify({ add: [], remove: [], priority: ["s1"], required: [] })
      : `Turn response ${sendCount}`);
  };

  const credential = oauthFixture();
  await f.credentials.modify(model.provider, async () => credential);
  const bound = { apiKey: credential.access, fetch: transport, transport: "sse" as const, maxRetries: 0 as const };
  const nativeModel = (m: Model<any>): Model<"openai-codex-responses"> => ({ ...m, api: "openai-codex-responses" });
  const wrapped: Provider = {
    ...provider,
    stream: (m, context, options) => provider.stream(nativeModel(m), context, { ...options, ...bound } as Parameters<typeof provider.stream>[2]),
    streamSimple: (m, context, options) => provider.streamSimple(nativeModel(m), context, { ...options, ...bound }),
  };
  new ModelRegistry(f.modelRuntime).registerProvider(wrapped);
  await f.runtime.session.setModel(model);

  await f.runtime.session.prompt("/larva-persona synth-codex-primary");

  // Step 1: Commit initial M
  const v0 = surfaceRef!.read(ctxRef!);
  assert.equal(surfaceRef!.patch(ctxRef!, {
    expectedRevision: v0.revision,
    add: [{ key: "heartbeat-note", text: "Persistent note across idle and reload" }],
  }).ok, true);

  // Prompt 1 runs and finishes
  const settled1 = withTimeout(new Promise<void>(resolve => settledResolvers.push(resolve)), 15000, "Turn 1 settle timeout");
  await f.runtime.session.prompt("Prompt 1 establishing initial receipt");
  await settled1;

  assert.equal(sendCount, 1);

  // Step 2: Trigger idle callback with active M
  assert(piRef);
  const settledIdle = withTimeout(new Promise<void>(resolve => settledResolvers.push(resolve)), 15000, "Idle settle timeout");
  piRef.sendMessage({ customType: "idle-callback", content: "Background tick", display: true }, { triggerTurn: true, deliverAs: "steer" });
  await settledIdle;

  assert.equal(sendCount, 2);
  const idleBody = bodies[1]!;
  // Wire body instructions must have restored primary persona
  assert(typeof idleBody.instructions === "string" && idleBody.instructions.includes("synth-codex-primary"));
  // Wire body tail input MUST contain the active working memory carrier!
  const idleTail = (idleBody.input as Array<Record<string, unknown>>).at(-1)!;
  assert(JSON.stringify(idleTail).includes("Persistent note across idle and reload"));

  // Step 3: Maintenance freeze mutual exclusion THROUGH terminal
  const patchTool = (f.runtime.session as any).getToolDefinition("nunc_memory_patch");
  assert(patchTool);

  inMaintenance = true;
  const compact = f.runtime.session.compact();
  await withTimeout(beforeTerminal.promise, 15000, "engine returned before native terminal");
  assert.equal(nativeSaved, 0);
  assert.equal(f.runtime.session.sessionManager.getEntries().filter(e => e.type === "compaction").length, 0);
  const curView = surfaceRef!.read(ctxRef!);
  assert.equal(curView.status.occupied, true);
  // Attempt tool patch while maintenance is active: MUST be rejected with "occupied"
  const occupiedRes = await patchTool.execute("call-occ-1", {
    expectedRevision: curView.revision,
    add: [{ key: "during-freeze", text: "Should be blocked" }],
  }, undefined, undefined, ctxRef!);

  assert(occupiedRes.isError);
  const occupiedData = JSON.parse(occupiedRes.content[0].text);
  assert.equal(occupiedData.ok, false);
  assert.equal(occupiedData.code, "occupied");

  const manualBlocked = surfaceRef!.replace(ctxRef!, curView.revision, "s1", "blocked manual edit");
  assert.equal(manualBlocked.ok, false);
  if (!manualBlocked.ok) assert.equal(manualBlocked.code, "occupied");
  releaseTerminal.resolve();
  await withTimeout(compact, 15000, "native compaction terminal");
  inMaintenance = false;
  assert.equal(nativeSaved, 1);
  assert.equal(surfaceRef!.read(ctxRef!).status.occupied, false);
  assert.equal(sendCount, 3);
  assert(admissions.some(a => a.kind === "maintenance" && a.outcome === "delegate" && a.payload));
  assert(!JSON.stringify(bodies[2]!.input).includes(renderMemory(curView.memory.slots)), "maintenance uses extraction sources, never the main carrier");

  // Patch now succeeds against the newly saved checkpoint revision.
  const successRes = await patchTool.execute("call-succ-1", {
    expectedRevision: surfaceRef!.read(ctxRef!).revision,
    add: [{ key: "after-freeze", text: "Successfully added after maintenance unlocked" }],
  }, undefined, undefined, ctxRef!);

  assert(!successRes.isError);
  const successData = JSON.parse(successRes.content[0].text);
  assert.equal(successData.ok, true);

  // Native maintenance invalidated receipts. Rebuild a new one, then perform
  // actual resource reload with active M (no reread/replay of session storage).
  await f.runtime.session.prompt("Prompt following maintenance unlock");
  assert.equal(admissions.filter(a => a.kind === "main").at(-1)!.estimator, "pi-heuristic");
  await f.runtime.session.prompt("Establish reuse before reload");
  assert.equal(admissions.filter(a => a.kind === "main").at(-1)!.estimator, "pi-usage-backed");
  const beforeReload = surfaceRef!.read(ctxRef!).memory;
  const memoryEntries = () => f.runtime.session.sessionManager.getEntries().filter(e => e.type === "compaction" || e.type === "custom" && e.customType === "nunc.memory");
  const entriesBeforeReload = memoryEntries();
  await f.runtime.session.reload();
  assert.deepEqual(surfaceRef!.read(ctxRef!).memory, beforeReload);
  assert.deepEqual(memoryEntries(), entriesBeforeReload);
  await f.runtime.session.prompt("First rebuilt request after reload");
  assert.equal(admissions.filter(a => a.kind === "main").at(-1)!.estimator, "pi-heuristic");
  const rebuiltTail = (bodies.at(-1)!.input as Array<{ content: Array<{ text: string }> }>).at(-1)!;
  assert.equal(rebuiltTail.content[0]!.text, renderMemory(beforeReload.slots));
  await f.runtime.session.prompt("Reuse rebuilt request after reload");
  const last = admissions.filter(a => a.kind === "main").at(-1)!;
  assert.equal(last.estimator, "pi-usage-backed");
  assert.equal(last.receiptBreakdown?.currentMTokens, memoryTokens(beforeReload.slots));
  assert.equal(sendCount, 7);
});
