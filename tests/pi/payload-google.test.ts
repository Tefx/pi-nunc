import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { ModelRegistry, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { authorizePayload, classifyPayloadChange, jsonView, payloadMode } from "../../src/pi/payload.js";
import { fixture } from "./fixtures.js";

function googleSSE(text: string): string {
  return `data: ${JSON.stringify({
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 },
  })}\n\n`;
}

async function googleBody(model: Model<"google-generative-ai">): Promise<unknown> {
  let body: unknown;
  const result = await googleProvider().stream(model, { messages: [{ role: "user", content: "Synthetic question", timestamp: 1 }] }, {
    apiKey: "synthetic-not-a-credential",
    maxTokens: 128,
    onPayload: payload => {
      body = jsonView(payload);
      throw new Error("synthetic pre-HTTP stop");
    },
  }).result();
  assert.equal(result.stopReason, "error");
  assert(body && typeof body === "object");
  return body;
}

test("native Google serializer config control fields reject before HTTP", { timeout: 30000 }, async () => {
  const google = googleProvider();
  const catalog = google.getModels().find(m => m.id === "gemini-2.5-flash");
  assert(catalog && catalog.api === "google-generative-ai");
  const before = await googleBody(catalog);
  assert.equal((before as { config?: { maxOutputTokens?: number } }).config?.maxOutputTokens, 128);
  const context = { messages: [{ role: "user" as const, content: "Synthetic question", timestamp: 1 }] };
  const auth = (after: unknown) => {
    const afterView = jsonView(after);
    const delta = classifyPayloadChange(before, afterView, payloadMode(before, afterView, after, before));
    authorizePayload({ model: catalog, delta, before, after, inputTokens: 100, inputLimit: 50000, authorizedOutput: 128, context });
  };
  const rec = before as { config: Record<string, unknown> };
  assert.throws(() => auth({ ...rec, config: { ...rec.config, maxOutputTokens: 256 } }), /native serialized ceiling|exceeds authorization/);
  assert.throws(() => auth({ ...rec, config: { ...rec.config, systemInstruction: "Synthetic new instructions" } }), /unvalidated payload input/);
  assert.throws(() => auth({ ...rec, config: { ...rec.config, tools: [{ functionDeclarations: [{ name: "synthetic_tool" }] }] } }), /unvalidated payload tools/);
  assert.throws(() => auth({ ...rec, config: { ...rec.config, thinkingConfig: { thinkingBudget: 256 } } }), /unvalidated payload thinking/);
  auth(before);
});

test("native Google serializer hits baseUrl loopback; nested control rewrite is zero-send", { timeout: 90000 }, async t => {
  const google = googleProvider();
  const catalog = google.getModels().find(m => m.id === "gemini-2.5-flash");
  assert(catalog && catalog.api === "google-generative-ai");
  const requests: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests.push(`${req.method} ${req.url ?? ""}`);
    res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    res.end(googleSSE("Controlled native response."));
  });
  t.after(() => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1beta`;
  const boundModel = { ...catalog, baseUrl } as Model<"google-generative-ai">;
  const wrapped: Provider = {
    ...google,
    streamSimple: (_m, context, options) => google.streamSimple(boundModel, context, { ...options, apiKey: "offline-fixture-key", maxRetries: 0 }),
    stream: (_m, context, options) => google.stream(boundModel, context, { ...options, apiKey: "offline-fixture-key", maxRetries: 0 } as Parameters<typeof google.stream>[2]),
  };
  const allowed = await fixture();
  t.after(() => allowed.close());
  new ModelRegistry(allowed.modelRuntime).registerProvider(wrapped);
  await allowed.modelRuntime.setRuntimeApiKey("google", "offline-fixture-key");
  await allowed.runtime.session.setModel(boundModel);
  await allowed.runtime.session.prompt("Native Google identity request");
  const last = allowed.runtime.session.messages.at(-1);
  assert.equal(last?.role, "assistant");
  assert.equal(requests.length, 1, JSON.stringify({ stop: last?.role === "assistant" ? last.stopReason : undefined, error: last?.role === "assistant" ? last.errorMessage : undefined, requests }));

  requests.length = 0;
  const blocked = await fixture({ extras: [{ name: "google-expand", factory(pi) {
    pi.on("before_provider_request", event => {
      const payload = event.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
      const rec = payload as { config?: Record<string, unknown> };
      if (!rec.config) return rec;
      const current = rec.config.maxOutputTokens;
      return { ...rec, config: { ...rec.config, maxOutputTokens: typeof current === "number" ? current + 1 : 99_999_999 } };
    });
  } }] });
  t.after(() => blocked.close());
  new ModelRegistry(blocked.modelRuntime).registerProvider(wrapped);
  await blocked.modelRuntime.setRuntimeApiKey("google", "offline-fixture-key");
  await blocked.runtime.session.setModel(boundModel);
  await blocked.runtime.session.prompt("Native Google expanded output");
  const rejected = blocked.runtime.session.messages.at(-1);
  assert.equal(rejected?.role, "assistant");
  assert.equal(rejected.stopReason, "error");
  assert.equal(requests.length, 0);
});
