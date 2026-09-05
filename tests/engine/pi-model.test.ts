import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, convertToLlm } from "@earendil-works/pi-coding-agent";
import { maintain, memoryMessage, piComplete, renderMemory } from "pi-nunc/engine";
import { input, noChange, sourceRecords } from "./fixtures.js";

test("public package export -> engine -> piComplete -> real Pi registry/runtime -> controlled pi-ai provider", async () => {
  const faux = fauxProvider({ provider: "nunc-engine-fixture", models: [{ id: "fixture-model", contextWindow: 60000, maxTokens: 8192 }] });
  // Explicit in-memory stores and no models file/catalog refresh: never use daily auth/config.
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  registry.registerProvider(faux.provider);
  const source = await input(); source.model = faux.getModel();
  faux.setResponses([(context, options, _state, model) => {
    assert.equal(model.id, source.model.id);
    assert.deepEqual(sourceRecords(context).flatMap(r => r.messages), source.active.flatMap(e => e.messages));
    assert.deepEqual(context.tools, []);
    assert.equal(options?.signal, source.signal);
    assert.equal(options?.maxTokens, source.config.extraction.outputTokens);
    assert.equal(options?.cacheRetention, "none"); assert.equal(options?.maxRetries, 0);
    assert.equal(options?.transport, "sse"); assert(options?.sessionId);
    return fauxAssistantMessage(JSON.stringify(noChange));
  }]);
  const result = await maintain(source, piComplete(registry));
  assert(result.ok, result.ok ? "" : `${result.message}: ${String(result.cause)}`);
  assert.equal(faux.state.callCount, 1);
  assert.equal(result.observations.requests, 1);
  assert(result.observations.usage.contextInput! > 0);
  // Exercise the host projection used in budgeting, without claiming loader/persistence coverage.
  assert.deepEqual(memoryMessage(result.candidate.memory.slots), convertToLlm([{ role: "compactionSummary", summary: renderMemory(result.candidate.memory.slots), tokensBefore: 0, timestamp: 0 }])[0]);
});
