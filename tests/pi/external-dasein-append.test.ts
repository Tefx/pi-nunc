import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { ModelRegistry, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { SYNTHETIC_LAST_USER_APPEND } from "../../src/live/append.js";
import { applyLastUserTextAppend, canonicalJson } from "../../src/pi/payload.js";
import { responsesSSE, fixture } from "./fixtures.js";

const DASEIN_INJECTOR = process.env.NUNC_DASEIN_INJECTOR ?? "/Users/tefx/Projects/dasein-pi-extension/src/core/provider-payload-injector.ts";
const available = existsSync(DASEIN_INJECTOR);
const SYNTHETIC = SYNTHETIC_LAST_USER_APPEND;

type DaseinInjector = { injectAmbientProviderPayload: (input: { payload: unknown; content: string }) => { changed: boolean; payload: unknown } };

async function loadDaseinInjector(): Promise<DaseinInjector> {
  return await import(pathToFileURL(DASEIN_INJECTOR).href) as DaseinInjector;
}


test("named external Dasein injector matches tracked last-user append", { skip: !available }, async () => {
  const dasein = await loadDaseinInjector();
  const cases: unknown[] = [
    { model: "m", stream: true, messages: [{ role: "user", content: "ask" }] },
    { model: "m", stream: true, messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] },
    { model: "m", stream: true, input: [{ role: "user", content: "ask" }] },
    { model: "m", stream: true, input: [{ role: "assistant", content: "no" }] },
    { model: "m", stream: true, input: [{ role: "user", content: "" }] },
    { model: "m", stream: true },
  ];
  for (const payload of cases) {
    const ours = applyLastUserTextAppend(payload, SYNTHETIC);
    const theirs = dasein.injectAmbientProviderPayload({ payload, content: SYNTHETIC });
    assert.equal(ours.changed, theirs.changed, canonicalJson(payload));
    assert.equal(canonicalJson(ours.payload), canonicalJson(theirs.payload), canonicalJson(payload));
  }
});

test("named external Dasein injector last-user append reaches Responses HTTP", { skip: !available, timeout: 90000 }, async t => {
  const dasein = await loadDaseinInjector();
  let sends = 0;
  const bodies: Record<string, unknown>[] = [];
  const openai = openaiProvider();
  const catalog = openai.getModels().find(m => m.id === "gpt-4.1");
  assert(catalog);
  const transport: typeof fetch = async (resource, init) => {
    sends++;
    bodies.push(await new Request(resource, init).json() as Record<string, unknown>);
    return responsesSSE(catalog.id, "Controlled native response.");
  };
  const bound = { apiKey: "offline-fixture-key", fetch: transport, maxRetries: 0 as const };
  const wrapped: Provider = {
    ...openai,
    streamSimple: (m, context, options) => openai.streamSimple(m as Model<"openai-responses">, context, { ...options, ...bound }),
    stream: (m, context, options) => openai.stream(m as Model<"openai-responses">, context, { ...options, ...bound } as Parameters<typeof openai.stream>[2]),
  };
  const extras: InlineExtension[] = [
    { name: "append", factory(pi) { pi.on("before_provider_request", event => {
      const result = dasein.injectAmbientProviderPayload({ payload: event.payload, content: SYNTHETIC });
      return result.changed ? result.payload : undefined;
    }); } },
  ];
  const f = await fixture({ config: { budget: { inputLimit: 8000 } }, extras });
  t.after(() => f.close());
  new ModelRegistry(f.modelRuntime).registerProvider(wrapped);
  await f.modelRuntime.setRuntimeApiKey("openai", "offline-fixture-key");
  await f.runtime.session.setModel(catalog);
  await f.runtime.session.prompt("Native last-user append request");
  assert.equal(sends, 1);
  const input = bodies[0]?.input;
  assert(Array.isArray(input));
  const lastUser = [...input].reverse().find((item): item is { content: Array<{ text?: string }> } =>
    !!item && typeof item === "object" && (item as { role?: unknown }).role === "user");
  assert.equal(lastUser?.content.at(-1)?.text, SYNTHETIC);
});
