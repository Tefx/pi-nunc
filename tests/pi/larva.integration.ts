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
  const model = id === "synth-codex" ? "openai-codex/gpt-6-astra"
    : id === "synth-responses" ? "openai/gpt-4.1"
    : "nunc-pi-fixture/large";
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
      { id: "synth-primary", description: "Primary", prompt: "Primary prompt", model: "nunc-pi-fixture/large", capabilities: {}, model_params: {}, can_spawn: true, spec_version: "0.1.0" },
      { id: "synth-specialist", description: "Specialist", prompt: "Specialist prompt", model: "nunc-pi-fixture/large", capabilities: {}, model_params: {}, can_spawn: true, spec_version: "0.1.0" },
      { id: "synth-responses", description: "Responses", prompt: "Responses prompt", model: "openai/gpt-4.1", capabilities: {}, model_params: {}, can_spawn: true, spec_version: "0.1.0" },
      { id: "synth-codex", description: "Codex", prompt: "Codex prompt", model: "openai-codex/gpt-6-astra", capabilities: {}, model_params: {}, can_spawn: true, spec_version: "0.1.0" }
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
    { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "response-1", model: modelId, status: "completed", output: [item], usage: { input_tokens: 128, output_tokens: 4, total_tokens: 132, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ];
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
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

  await f.runtime.session.prompt("/larva-persona synth-codex");

  // Turn 1: establishes receipt under stable Larva persona
  await f.runtime.session.prompt("Turn 1 Codex prompt");
  assert.equal(bodies.length, 1);
  assert(typeof bodies[0]?.instructions === "string");
  assert(bodies[0]!.instructions.includes("synth-codex"));
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

test("continuous tools, temporary borrow, continuation lifecycle and idle callback", async t => {
  const admissions: AdmissionObservation[] = [];
  let piRef: ExtensionAPI | undefined;
  let resolveSettled: (() => void) | undefined;

  const f = await fixture({
    extensions: [larvaExtensionPath],
    flagValues: [["larva-agent-persona-switch", "auto"]],
    extras: [{
      name: "watch-admission",
      factory(pi) {
        piRef = pi;
        pi.events.on("nunc:admission", val => admissions.push(val as AdmissionObservation));
        pi.on("agent_settled", () => resolveSettled?.());
      },
    }],
  });
  t.after(async () => {
    await f.close();
  });

  await f.runtime.session.prompt("/larva-persona synth-primary");

  let turn = 0;
  f.respond((context) => {
    turn++;
    if (turn === 1) {
      // Turn 1: Assistant calls larva_persona_switch to borrow synth-specialist with continue_task: true
      assert(context.systemPrompt?.includes("synth-primary"));
      return fauxAssistantMessage(fauxToolCall("larva_persona_switch", {
        persona_id: "synth-specialist",
        reason: "Route rationale: temporary borrow for specialized computation",
        continue_task: true,
      }, { id: "call-borrow-1" }), { stopReason: "toolUse" });
    }
    if (turn === 2) {
      // Turn 2: Continuation turn runs under borrowed synth-specialist with continuation prompt block active!
      assert(context.systemPrompt?.includes("synth-specialist"));
      assert(context.systemPrompt?.includes("larva_persona_switch_continuation"));
      assert(context.systemPrompt?.includes("Switched from synth-primary to synth-specialist"));
      return fauxAssistantMessage("Specialist continuation work completed.");
    }
    // Turn 3: Subsequent turn (e.g. idle callback) after continuation expired and lease restored!
    assert(context.systemPrompt?.includes("synth-primary"));
    assert.doesNotMatch(context.systemPrompt ?? "", /larva_persona_switch_continuation/);
    assert.doesNotMatch(context.systemPrompt ?? "", /synth-specialist/);
    return fauxAssistantMessage("Restored primary answer.");
  });

  // Start turn that borrows persona
  await f.runtime.session.prompt("Please perform specialized calculation");
  // Allow deferred continuation delivery to trigger and complete turn 2
  await new Promise(r => setTimeout(r, 250));

  assert.equal(turn, 2);

  // Turn 3: Send idle callback, proving lease restored to synth-primary and continuation expired
  assert(piRef);
  const settled = new Promise<void>(resolve => { resolveSettled = resolve; });
  piRef.sendMessage({ customType: "idle-callback", content: "Background idle check", display: true }, { triggerTurn: true, deliverAs: "steer" });
  await settled;

  assert.equal(turn, 3);
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

  await f.runtime.session.prompt("/larva-persona synth-primary");

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
