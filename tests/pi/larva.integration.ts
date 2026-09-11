import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, chmodSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, type AdmissionObservation } from "../../src/pi/admission.js";
import { applyLastUserTextAppend } from "../../src/pi/payload.js";
import { fixture, memoryPatch } from "./fixtures.js";

function responsesSSE(modelId: string, text: string) {
  const item = { type: "message", id: "msg-1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: "response-1", model: modelId, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "response-1", model: modelId, status: "completed", output: [item], usage: { input_tokens: 80, output_tokens: 4, total_tokens: 84, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ];
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

// Check NUNC_LARVA_EXTENSION: must be present and exist; no skipping or double substitution allowed.
const larvaExtensionPath = process.env.NUNC_LARVA_EXTENSION;
if (!larvaExtensionPath || !existsSync(larvaExtensionPath)) {
  console.error(`Missing or inaccessible NUNC_LARVA_EXTENSION: ${larvaExtensionPath ?? "undefined"}`);
  process.exit(1);
}

// Clean any inherited parent session LARVA_* environment variables to prevent host leakage,
// while preserving clean isolated test-local configuration.
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
  console.log(JSON.stringify({
    data: {
      id,
      description: "Synthetic persona " + id,
      prompt: "You are synthetic persona " + id + ". Specialized instructions active.",
      model: "nunc-pi-fixture/large",
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
      { id: "synth-specialist", description: "Specialist", prompt: "Specialist prompt", model: "nunc-pi-fixture/large", capabilities: {}, model_params: {}, can_spawn: true, spec_version: "0.1.0" }
    ]
  }));
  process.exit(0);
}
process.exit(1);
`
);
chmodSync(mockLarvaScript, 0o755);

process.env.LARVA_CLI_ARGV_JSON = JSON.stringify([process.execPath, mockLarvaScript]);

test("real loader loads user-supplied Larva v1 and resolves system prompt on normal request", async t => {
  const admissions: AdmissionObservation[] = [];
  const f = await fixture({
    extensions: [larvaExtensionPath],
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

  // Switch to synthetic primary persona
  await f.runtime.session.prompt("/larva-persona synth-primary");

  f.respond((context) => {
    // Assert that the real Larva extension resolved the prompt and it reached the native provider
    assert(context.systemPrompt?.includes("synth-primary"));
    assert(context.systemPrompt?.includes("<!-- larva:identity-policy:begin -->"));
    assert(context.systemPrompt?.includes("<!-- larva:active-persona:begin -->"));
    return fauxAssistantMessage("Normal response under synth-primary.");
  });

  await f.runtime.session.prompt("Execute normal task");

  const main = admissions.filter(a => a.kind === "main").at(-1);
  assert(main);
  assert.equal(main.outcome, "delegate");
  assert.equal(main.resolution, "resolved");
});

test("stable actual Larva state leaves final prompt unchanged and establishes reusable receipt", async t => {
  const admissions: AdmissionObservation[] = [];
  const f = await fixture({
    extensions: [larvaExtensionPath],
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

  await f.runtime.session.prompt("/larva-persona synth-primary");

  f.respond(() => fauxAssistantMessage("First response establishes receipt."));
  await f.runtime.session.prompt("Turn 1");

  const turn1 = admissions.filter(a => a.kind === "main").at(-1);
  assert(turn1);
  assert.equal(turn1.outcome, "delegate");
  assert.equal(turn1.resolution, "resolved");
  assert.equal(turn1.estimator, "pi-heuristic");

  // Turn 2 with stable Larva state: prompt must match exactly and reuse receipt
  f.respond(() => fauxAssistantMessage("Second response reuses receipt."));
  await f.runtime.session.prompt("Turn 2: stable repeat");

  const turn2 = admissions.filter(a => a.kind === "main").at(-1);
  assert(turn2);
  assert.equal(turn2.outcome, "delegate");
  assert.equal(turn2.resolution, "resolved");
  assert.equal(turn2.estimator, "pi-usage-backed");
  assert.equal(turn2.estimateReason, "matching-receipt");
});

test("continuous tools, persona switch and restore, and idle callback", async t => {
  const admissions: AdmissionObservation[] = [];
  let piRef: any;
  let resolveSettled: (() => void) | undefined;

  const f = await fixture({
    extensions: [larvaExtensionPath],
    tools: [{
      name: "calc",
      label: "calc",
      description: "Calculator tool",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "42" }], details: {} }),
    }],
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

  // Step 1: Continuous tools in a single user prompt turn
  let turn = 0;
  f.respond((context) => {
    turn++;
    if (turn === 1) {
      assert(context.systemPrompt?.includes("synth-primary"));
      return fauxAssistantMessage(fauxToolCall("calc", {}, { id: "call-1" }), { stopReason: "toolUse" });
    }
    assert(context.systemPrompt?.includes("synth-primary"));
    return fauxAssistantMessage("Calculation completed.");
  });

  await f.runtime.session.prompt("Calculate turn with tools");
  assert.equal(turn, 2);

  // Step 2: Persona switch to specialist
  await f.runtime.session.prompt("/larva-persona synth-specialist");
  f.respond((context) => {
    assert(context.systemPrompt?.includes("synth-specialist"));
    return fauxAssistantMessage("Specialist response.");
  });
  await f.runtime.session.prompt("Run under specialist");
  assert(f.calls.at(-1)?.systemPrompt?.includes("synth-specialist"));

  // Step 3: Switch back to primary
  await f.runtime.session.prompt("/larva-persona synth-primary");
  f.respond((context) => {
    assert(context.systemPrompt?.includes("synth-primary"));
    return fauxAssistantMessage("Primary restored.");
  });
  await f.runtime.session.prompt("Run restored primary");
  assert(f.calls.at(-1)?.systemPrompt?.includes("synth-primary"));

  // Step 4: Idle callback triggers independent prompt turn
  const settled = new Promise<void>(resolve => { resolveSettled = resolve; });
  piRef.sendMessage({ customType: "idle-callback", content: "Background idle check", display: true }, { triggerTurn: true, deliverAs: "steer" });
  await settled;

  assert(f.calls.at(-1)?.systemPrompt?.includes("synth-primary"));
});

test("real reload invalidates old resolver listener and maintenance stays isolated", async t => {
  const admissions: AdmissionObservation[] = [];
  const f = await fixture({
    extensions: [larvaExtensionPath],
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

  await f.runtime.session.prompt("/larva-persona synth-primary");
  await f.runtime.session.prompt("Turn before maintenance");

  // Maintenance must make ZERO resolver calls and remain isolated
  f.seed();
  f.respond(memoryPatch);
  const admissionsBeforeCompact = admissions.length;
  await f.runtime.session.compact();

  const maintenanceAdmission = admissions.slice(admissionsBeforeCompact).find(a => a.kind === "maintenance");
  assert(maintenanceAdmission);
  assert.equal(maintenanceAdmission.resolution, undefined);

  // Reload session: old listener must be invalidated on session_shutdown / new session
  await f.runtime.newSession();

  f.respond(() => fauxAssistantMessage("Fresh turn in new session."));
  await f.runtime.session.prompt("Turn in new session");

  const newSessionMain = admissions.filter(a => a.kind === "main").at(-1);
  assert(newSessionMain);
  assert.equal(newSessionMain.outcome, "delegate");
});

test("genuine late change at before_provider_request validates and charges growth", async t => {
  const admissions: AdmissionObservation[] = [];
  const EXTRA_TEXT = "\nLate appended instruction note.";

  const f = await fixture({
    extensions: [larvaExtensionPath],
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
  const wrapped = {
    ...openai,
    streamSimple: (m: any, context: any, options: any) => openai.streamSimple(m, context, {
      ...options,
      apiKey: "offline-test-key",
      maxRetries: 0,
      fetch: async () => responsesSSE(model.id, "Answer with late hook."),
    }),
  };
  new ModelRegistry(f.modelRuntime).registerProvider(wrapped);
  await f.modelRuntime.setRuntimeApiKey("openai", "offline-test-key");
  await f.runtime.session.setModel(model);

  await f.runtime.session.prompt("Turn with late modification");

  const main = admissions.filter(a => a.kind === "main" && a.outcome === "delegate" && a.payload).at(-1);
  assert(main);
  assert.equal(main.outcome, "delegate");
  assert.equal(main.resolution, "resolved");
  assert(main.payload);
  assert.equal(main.payload.transform, "last-user-text-append");
});

test("cleanup isolated temporary fixtures", () => {
  try {
    rmSync(isolatedDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
});
