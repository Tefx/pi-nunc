import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, type AssistantMessage } from "@earendil-works/pi-ai";
import { azureOpenAIResponsesProvider } from "@earendil-works/pi-ai/providers/azure-openai-responses";
import { fixture, memoryPatch } from "./fixtures.js";
import { sourceRecords } from "../engine/fixtures.js";
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

test("async maintenance scope authorizes only its exact one-shot request, never a nested foreign request", async t => {
  const f = await fixture(); t.after(() => f.close()); f.seed();
  let foreign: AssistantMessage | undefined;
  f.respond(async (context, options) => {
    if (!sourceRecords(context).length) return fauxAssistantMessage("Foreign request incorrectly reached service");
    assert(options?.signal);
    foreign = await new ModelRegistry(f.modelRuntime).complete(f.faux.getModel(), { messages: [{ role: "user", content: "Separate nested source", timestamp: 1 }] }, { maxTokens: 512, signal: options.signal });
    return memoryPatch(context);
  });
  await f.runtime.session.compact();
  assert.equal(f.faux.state.callCount, 1); assert.equal(foreign?.stopReason, "error"); assert.match(foreign?.errorMessage ?? "", /Unknown request source/);
  assert(f.events[0]?.result.ok); assert.equal(f.runtime.session.sessionManager.getBranch().filter(e => e.type === "compaction").length, 1);
});
