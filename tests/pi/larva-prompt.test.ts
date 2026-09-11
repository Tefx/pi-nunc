import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { ModelRegistry, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, type AdmissionObservation, type ResolveSystemPromptRequest, type ResolveSystemPromptResult } from "../../src/pi/admission.js";
import { contextSurface } from "pi-nunc/pi";
import { detailsLines } from "../../src/ui/status.js";
import { fixture, memoryPatch } from "./fixtures.js";

const RESOLVED_PROMPT_A = "You are Larva Persona Alpha. Obey all specialized instructions.";
const RESOLVED_PROMPT_B = "You are Larva Persona Beta. Obey all specialized instructions.";

test("synchronous ok reply creates request-local effective context and preserves original context", async t => {
  const admissions: AdmissionObservation[] = [];
  let resolverCalls = 0;
  let receivedScope: string | undefined;
  let receivedPrompt: string | undefined;

  const f = await fixture({
    extras: [{
      name: "larva-test-listener",
      factory(pi) {
        pi.events.on("nunc:admission", val => admissions.push(val as AdmissionObservation));
        pi.events.on(LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, data => {
          resolverCalls++;
          const req = data as ResolveSystemPromptRequest;
          receivedScope = req.scope;
          receivedPrompt = req.systemPrompt;
          req.reply({ status: "ok", systemPrompt: RESOLVED_PROMPT_A });
        });
      },
    }],
  });
  t.after(() => f.close());

  const originalPromptBefore = f.runtime.session.agent.state.systemPrompt;
  f.respond((context) => {
    // Check that the provider sees the resolved prompt, not the host default!
    assert.equal(context.systemPrompt, RESOLVED_PROMPT_A);
    return fauxAssistantMessage("Task response from provider.");
  });

  await f.runtime.session.prompt("Execute initial task");
  assert.equal(resolverCalls, 1);
  assert.equal(receivedScope, "main");
  assert.equal(typeof receivedPrompt, "string");

  // Original global session prompt must not be overwritten
  assert.equal(f.runtime.session.agent.state.systemPrompt, originalPromptBefore);

  // Admission observation must record resolved
  const lastMain = admissions.filter(a => a.kind === "main").at(-1);
  assert(lastMain);
  assert.equal(lastMain.outcome, "delegate");
  assert.equal(lastMain.resolution, "resolved");

  // Host prompt did not match resolved prompt
  assert.equal(lastMain.hostPromptMatchesRequest, false);
});

test("zero replies path falls back to legacy-no-reply and preserves original context", async t => {
  const admissions: AdmissionObservation[] = [];

  const f = await fixture({
    extras: [{
      name: "watch-admission",
      factory(pi) {
        pi.events.on("nunc:admission", val => admissions.push(val as AdmissionObservation));
        // No listener on LARVA_RESOLVE_SYSTEM_PROMPT_EVENT -> 0 replies
      },
    }],
  });
  t.after(() => f.close());

  f.respond((context) => {
    // Provider sees original systemPrompt
    assert(context.systemPrompt?.includes("Perform the current task."));
    return fauxAssistantMessage("Legacy response.");
  });

  await f.runtime.session.prompt("Run with legacy path");
  const lastMain = admissions.filter(a => a.kind === "main").at(-1);
  assert(lastMain);
  assert.equal(lastMain.outcome, "delegate");
  assert.equal(lastMain.resolution, "legacy-no-reply");
});

test("legal unavailable reply results in local CONFIG refusal with zero provider transport", async t => {
  const admissions: AdmissionObservation[] = [];

  const f = await fixture({
    extras: [{
      name: "larva-unavailable",
      factory(pi) {
        pi.events.on("nunc:admission", val => admissions.push(val as AdmissionObservation));
        pi.events.on(LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, data => {
          const req = data as ResolveSystemPromptRequest;
          req.reply({ status: "unavailable", reason: "Persona initialization in progress" });
        });
      },
    }],
  });
  t.after(() => f.close());

  await f.runtime.session.prompt("Attempt request when unavailable");
  assert.equal(f.faux.state.callCount, 0);

  const lastMessage = f.runtime.session.messages.at(-1);
  assert.equal(lastMessage?.role, "assistant");
  assert.equal(lastMessage?.stopReason, "error");
  assert.match(lastMessage?.errorMessage ?? "", /Nunc local CONFIG/);
  assert.match(lastMessage?.errorMessage ?? "", /currently unavailable/);
  // Untrusted reason should not be leaked in error message
  assert.doesNotMatch(lastMessage?.errorMessage ?? "", /Persona initialization in progress/);

  const lastMain = admissions.filter(a => a.kind === "main").at(-1);
  assert(lastMain);
  assert.equal(lastMain.outcome, "reject");
  assert.equal(lastMain.code, "CONFIG");
  assert.equal(lastMain.resolution, "unavailable");
});

test("duplicate synchronous replies cause protocol-error and local CONFIG refusal", async t => {
  const admissions: AdmissionObservation[] = [];

  const f = await fixture({
    extras: [{
      name: "larva-duplicate",
      factory(pi) {
        pi.events.on("nunc:admission", val => admissions.push(val as AdmissionObservation));
        pi.events.on(LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, data => {
          const req = data as ResolveSystemPromptRequest;
          req.reply({ status: "ok", systemPrompt: RESOLVED_PROMPT_A });
          // Second synchronous reply (even identical): protocol error!
          req.reply({ status: "ok", systemPrompt: RESOLVED_PROMPT_A });
        });
      },
    }],
  });
  t.after(() => f.close());

  await f.runtime.session.prompt("Attempt request with duplicate replies");
  assert.equal(f.faux.state.callCount, 0);

  const lastMessage = f.runtime.session.messages.at(-1);
  assert.equal(lastMessage?.role, "assistant");
  assert.equal(lastMessage?.stopReason, "error");
  assert.match(lastMessage?.errorMessage ?? "", /Nunc local CONFIG/);

  const lastMain = admissions.filter(a => a.kind === "main").at(-1);
  assert(lastMain);
  assert.equal(lastMain.outcome, "reject");
  assert.equal(lastMain.code, "CONFIG");
  assert.equal(lastMain.resolution, "protocol-error");
});

test("invalid reply shapes trigger protocol-error and local CONFIG refusal", async t => {
  const invalidReplies: unknown[] = [
    { status: "unknown" },
    { status: "ok", systemPrompt: 12345 },
    { status: "ok" }, // missing systemPrompt
    { status: "unavailable", reason: "" }, // empty reason
    { status: "unavailable" }, // missing reason
    "not-a-record",
    null,
  ];

  for (const invalid of invalidReplies) {
    const admissions: AdmissionObservation[] = [];
    const f = await fixture({
      extras: [{
        name: "larva-invalid",
        factory(pi) {
          pi.events.on("nunc:admission", val => admissions.push(val as AdmissionObservation));
          pi.events.on(LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, data => {
            const req = data as ResolveSystemPromptRequest;
            req.reply(invalid as ResolveSystemPromptResult);
          });
        },
      }],
    });

    await f.runtime.session.prompt("Attempt request with invalid reply");
    assert.equal(f.faux.state.callCount, 0);

    const lastMain = admissions.filter(a => a.kind === "main").at(-1);
    assert(lastMain);
    assert.equal(lastMain.outcome, "reject");
    assert.equal(lastMain.code, "CONFIG");
    assert.equal(lastMain.resolution, "protocol-error");

    await f.close();
  }
});

test("dispatch exception inside emit causes protocol-error and local CONFIG refusal", async t => {
  const admissions: AdmissionObservation[] = [];

  const f = await fixture({
    bus(b) {
      const origEmit = b.emit;
      b.emit = (channel, data) => {
        if (channel === LARVA_RESOLVE_SYSTEM_PROMPT_EVENT) {
          throw new Error("Simulated emit failure");
        }
        return origEmit(channel, data);
      };
    },
    extras: [{
      name: "watch-admission",
      factory(pi) {
        pi.events.on("nunc:admission", val => admissions.push(val as AdmissionObservation));
      },
    }],
  });
  t.after(() => f.close());

  await f.runtime.session.prompt("Attempt request when emit throws");
  assert.equal(f.faux.state.callCount, 0);

  const lastMain = admissions.filter(a => a.kind === "main").at(-1);
  assert(lastMain);
  assert.equal(lastMain.outcome, "reject");
  assert.equal(lastMain.code, "CONFIG");
  assert.equal(lastMain.resolution, "protocol-error");
});

test("late replies arriving after emit returns are ignored and cannot affect decisions", async t => {
  const admissions: AdmissionObservation[] = [];
  let capturedReply: ((result: ResolveSystemPromptResult) => void) | undefined;

  const f = await fixture({
    extras: [{
      name: "larva-late",
      factory(pi) {
        pi.events.on("nunc:admission", val => admissions.push(val as AdmissionObservation));
        pi.events.on(LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, data => {
          const req = data as ResolveSystemPromptRequest;
          // Capture reply callback but do not invoke it synchronously!
          capturedReply = req.reply;
        });
      },
    }],
  });
  t.after(() => f.close());

  f.respond(() => fauxAssistantMessage("First call completed."));
  await f.runtime.session.prompt("First call");

  // At emit return, 0 replies were received, so it must be legacy-no-reply
  const firstMain = admissions.filter(a => a.kind === "main").at(-1);
  assert(firstMain);
  assert.equal(firstMain.outcome, "delegate");
  assert.equal(firstMain.resolution, "legacy-no-reply");

  // Now invoke the late reply asynchronously
  assert(capturedReply);
  capturedReply({ status: "ok", systemPrompt: "LATE_PROMPT_INJECTION" });

  // Next call should independently resolve its own prompt
  f.respond((context) => {
    assert.doesNotMatch(context.systemPrompt ?? "", /LATE_PROMPT_INJECTION/);
    return fauxAssistantMessage("Second call completed.");
  });
  await f.runtime.session.prompt("Second call");
  const secondMain = admissions.filter(a => a.kind === "main").at(-1);
  assert(secondMain);
  assert.equal(secondMain.resolution, "legacy-no-reply");
});

test("stable resolved prompt reuses usage receipt; prompt change falls back to fresh estimate while keeping anchor", async t => {
  const admissions: AdmissionObservation[] = [];
  let activePrompt = RESOLVED_PROMPT_A;

  const f = await fixture({
    extras: [{
      name: "larva-switching",
      factory(pi) {
        pi.events.on("nunc:admission", val => admissions.push(val as AdmissionObservation));
        pi.events.on(LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, data => {
          const req = data as ResolveSystemPromptRequest;
          req.reply({ status: "ok", systemPrompt: activePrompt });
        });
      },
    }],
  });
  t.after(() => f.close());

  f.respond(() => fauxAssistantMessage("Turn 1 response."));
  await f.runtime.session.prompt("Turn 1: establishes receipt under Prompt A");

  const turn1 = admissions.filter(a => a.kind === "main").at(-1);
  assert(turn1);
  assert.equal(turn1.outcome, "delegate");
  assert.equal(turn1.resolution, "resolved");
  assert.equal(turn1.estimator, "pi-heuristic");

  // Turn 2 with same resolved Prompt A -> should reuse receipt
  f.respond(() => fauxAssistantMessage("Turn 2 response."));
  await f.runtime.session.prompt("Turn 2: same prompt should reuse receipt");

  const turn2 = admissions.filter(a => a.kind === "main").at(-1);
  assert(turn2);
  assert.equal(turn2.resolution, "resolved");
  assert.equal(turn2.estimator, "pi-usage-backed");
  assert.equal(turn2.estimateReason, "matching-receipt");

  // Turn 3 switches to Prompt B -> should fall back to fresh estimate (system-mismatch)
  activePrompt = RESOLVED_PROMPT_B;
  f.respond(() => fauxAssistantMessage("Turn 3 response."));
  await f.runtime.session.prompt("Turn 3: prompt change requires fresh estimate");

  const turn3 = admissions.filter(a => a.kind === "main").at(-1);
  assert(turn3);
  assert.equal(turn3.resolution, "resolved");
  assert.equal(turn3.estimator, "pi-heuristic");
  assert.equal(turn3.estimateReason, "system-mismatch");
});

test("maintenance and unknown paths perform zero resolver calls and do not report resolved", async t => {
  let resolverCalls = 0;
  const admissions: AdmissionObservation[] = [];

  const f = await fixture({
    extras: [{
      name: "larva-counter",
      factory(pi) {
        pi.events.on("nunc:admission", val => admissions.push(val as AdmissionObservation));
        pi.events.on(LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, data => {
          resolverCalls++;
          const req = data as ResolveSystemPromptRequest;
          req.reply({ status: "ok", systemPrompt: RESOLVED_PROMPT_A });
        });
      },
    }],
  });
  t.after(() => f.close());

  f.seed();
  f.respond(memoryPatch);

  const callsBeforeCompact = resolverCalls;
  await f.runtime.session.compact();
  // Maintenance must make ZERO resolver calls!
  assert.equal(resolverCalls, callsBeforeCompact);

  const maintenanceAdmission = admissions.find(a => a.kind === "maintenance");
  assert(maintenanceAdmission);
  assert.equal(maintenanceAdmission.resolution, undefined);
});

test("empty string ok reply is legal and sets effective context system prompt to empty string", async t => {
  const admissions: AdmissionObservation[] = [];
  const f = await fixture({
    extras: [{
      name: "larva-empty",
      factory(pi) {
        pi.events.on("nunc:admission", val => admissions.push(val as AdmissionObservation));
        pi.events.on(LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, data => {
          const req = data as ResolveSystemPromptRequest;
          req.reply({ status: "ok", systemPrompt: "" });
        });
      },
    }],
  });
  t.after(() => f.close());

  f.respond((context) => {
    assert.equal(context.systemPrompt, "");
    return fauxAssistantMessage("Empty prompt answer.");
  });

  await f.runtime.session.prompt("Request with empty prompt");
  const lastMain = admissions.filter(a => a.kind === "main").at(-1);
  assert(lastMain);
  assert.equal(lastMain.outcome, "delegate");
  assert.equal(lastMain.resolution, "resolved");
});

test("continuous tool requests re-resolve prompt per turn without cross-request caching", async t => {
  const admissions: AdmissionObservation[] = [];
  let resolverTurns = 0;
  const f = await fixture({
    tools: [{
      name: "calc",
      label: "calc",
      description: "Simple calculator",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "42" }], details: {} }),
    }],
    extras: [{
      name: "larva-tools",
      factory(pi) {
        pi.events.on("nunc:admission", val => admissions.push(val as AdmissionObservation));
        pi.events.on(LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, data => {
          resolverTurns++;
          const req = data as ResolveSystemPromptRequest;
          req.reply({ status: "ok", systemPrompt: `${RESOLVED_PROMPT_A} turn ${resolverTurns}` });
        });
      },
    }],
  });
  t.after(() => f.close());

  let turn = 0;
  f.respond((context) => {
    turn++;
    if (turn === 1) {
      assert(context.systemPrompt?.includes("turn 1"));
      return fauxAssistantMessage(fauxToolCall("calc", {}, { id: "call-1" }), { stopReason: "toolUse" });
    }
    assert(context.systemPrompt?.includes("turn 2"));
    return fauxAssistantMessage("Final answer after tool.");
  });

  await f.runtime.session.prompt("Calculate something");
  assert.equal(resolverTurns, 2);
  const mainDelegates = admissions.filter(a => a.kind === "main" && a.outcome === "delegate");
  assert.equal(mainDelegates.length, 2);
  assert.equal(mainDelegates[0]?.resolution, "resolved");
  assert.equal(mainDelegates[1]?.resolution, "resolved");
});

test("cancellation precedence aborts before resolver call and maintains CANCELLED outcome", async t => {
  let resolverCalls = 0;
  const admissions: AdmissionObservation[] = [];
  let capturedCtx: ExtensionContext | undefined;
  const controller = new AbortController();
  controller.abort(); // pre-aborted signal

  const f = await fixture({
    extras: [{
      name: "larva-cancel-check",
      factory(pi) {
        pi.on("session_start", (_event, ctx) => { capturedCtx = ctx; });
        pi.events.on("nunc:admission", val => admissions.push(val as AdmissionObservation));
        pi.events.on(LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, data => {
          resolverCalls++;
          const req = data as ResolveSystemPromptRequest;
          req.reply({ status: "ok", systemPrompt: RESOLVED_PROMPT_A });
        });
      },
    }],
  });
  t.after(() => f.close());

  assert(capturedCtx);
  Object.defineProperty(capturedCtx, "signal", { value: controller.signal, configurable: true });
  const registry = new ModelRegistry(f.modelRuntime);
  const provider = registry.getRegisteredNativeProvider("nunc-pi-fixture");
  assert(provider);
  const model = f.faux.getModel();
  const context: Context = { messages: [{ role: "user", content: "Pre-aborted call", timestamp: 1 }] };
  const res = await provider.streamSimple(model, context, { signal: controller.signal, sessionId: capturedCtx.sessionManager.getSessionId() }).result();

  // Pre-aborted signal must take precedence and make ZERO resolver calls!
  assert.equal(resolverCalls, 0);
  assert.equal(res.stopReason, "aborted");
  assert.equal(f.faux.state.callCount, 0);

  const lastMain = admissions.filter(a => a.kind === "main").at(-1);
  assert(lastMain);
  assert.equal(lastMain.outcome, "reject");
  assert.equal(lastMain.code, "CANCELLED");
});

test("observation and details surfaces expose resolved and error states without leaking private text", async t => {
  let activeResult: ResolveSystemPromptResult = { status: "ok", systemPrompt: RESOLVED_PROMPT_A };
  let apiRef: ExtensionAPI | undefined;
  let ctxRef: ExtensionContext | undefined;

  const f = await fixture({
    extras: [{
      name: "larva-status-observer",
      factory(pi) {
        apiRef = pi;
        pi.on("session_start", (_event, ctx) => { ctxRef = ctx; });
        pi.events.on(LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, data => {
          const req = data as ResolveSystemPromptRequest;
          req.reply(activeResult);
        });
      },
    }],
  });
  t.after(() => f.close());

  f.respond(() => fauxAssistantMessage("Response for observer check."));
  await f.runtime.session.prompt("Normal request for observer");

  assert(apiRef);
  assert(ctxRef);
  const surface = contextSurface(apiRef);
  assert(surface);
  const view = surface.read(ctxRef);
  assert(view.lastMain);
  assert.equal(view.lastMain.resolution, "resolved");

  // Check details lines output
  const report = detailsLines({ view, diagnostics: [] });
  assert.match(report, /Resolution: resolved/);
  assert.doesNotMatch(report, new RegExp(RESOLVED_PROMPT_A)); // Do not leak full system prompt in details summary

  // Current projection remains independent
  assert.notEqual(view.current.layout.system.text, RESOLVED_PROMPT_A);
});
