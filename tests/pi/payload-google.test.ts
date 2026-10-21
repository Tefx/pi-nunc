import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { normalizeContext, type Model, type Provider } from "@earendil-works/pi-ai";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { googleVertexProvider } from "@earendil-works/pi-ai/providers/google-vertex";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { messageTokens, textTokens } from "../../src/engine/accounting.js";
import type { AdmissionObservation } from "../../src/pi/admission.js";
import { authorizePayload, classifyPayloadChange, jsonView, payloadMode } from "../../src/pi/payload.js";
import { fixture } from "./fixtures.js";

function googleSSE(content: string | { functionCall: { id: string; name: string; args: Record<string, unknown> } }, usage: {
  promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number; cachedContentTokenCount?: number;
} = { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 }): string {
  return `data: ${JSON.stringify({
    candidates: [{ content: { role: "model", parts: [typeof content === "string" ? { text: content } : content] }, finishReason: "STOP" }],
    usageMetadata: usage,
  })}\n\n`;
}

async function googleBody(model: Model<"google-generative-ai">): Promise<unknown> {
  let body: unknown;
  const result = await googleProvider().stream(model, normalizeContext({ messages: [{ role: "user", content: "Synthetic question", timestamp: 1 }] }), {
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
  assert.throws(() => auth({ ...rec, config: { ...rec.config, candidateCount: 2 } }), /unrecognized payload field/);
  assert.throws(() => auth({ ...rec, config: { ...rec.config, cachedContent: "cachedContents/synthetic" } }), /unrecognized payload field/);
  assert.throws(() => auth({ ...rec, config: { ...rec.config, responseModalities: ["AUDIO"] } }), /unrecognized payload field/);
  auth(before);
  auth({ ...rec, config: { ...rec.config, temperature: 0 } });
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

for (const providerFactory of [googleProvider, googleVertexProvider]) {
  for (const mode of ["auto-on", "auto-off", "explicit-limit", "window-overflow"] as const) {
    const google: Provider = providerFactory();
    test(`${google.id} native main capacity with ${mode} preserves output sizing and single tool delivery`, { timeout: 30000 }, async t => {
      const catalog = google.getModels().find(m => m.id === "gemini-2.5-flash");
      assert(catalog);
      assert.equal(catalog.contextWindow, 1048576);
      assert.equal(catalog.maxTokens, 65536);
      const allowed = mode === "auto-on" || mode === "auto-off";
      const enabled = mode === "auto-on";
      // Calibrate the usage fixture to the exact admission boundary without freezing Pi's text heuristic.
      const expectedInput = mode === "window-overflow" ? 1048576 : 988095;
      const trailingTokens = messageTokens({ role: "user", content: [{ type: "text", text: "Continue" }], timestamp: 0 }) + textTokens("{}");
      const promptTokens = expectedInput - trailingTokens - 4;
      const bodies: { generationConfig: { maxOutputTokens: number }; contents: { parts: { text?: string }[] }[] }[] = [];
      const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
        res.end(bodies.length === 1
          ? googleSSE("Usage anchor.", { promptTokenCount: promptTokens, candidatesTokenCount: 4, totalTokenCount: promptTokens + 4, cachedContentTokenCount: 960000 })
          : bodies.length === 2
            ? googleSSE({ functionCall: { id: "capacity-call", name: "capacity_probe", args: {} } })
            : googleSSE("Tool result received."));
      });
      t.after(() => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())));
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const address = server.address();
      assert(address && typeof address === "object");
      const model = { ...catalog, baseUrl: `http://127.0.0.1:${address.port}/${google.id === "google-vertex" ? "v1" : "v1beta"}` };
      const admissions: AdmissionObservation[] = [];
      const nativeEstimates: number[] = [];
      let toolRuns = 0;
      const f = await fixture({
        enabled,
        ...(mode === "explicit-limit" ? { config: { budget: { inputLimit: 982016 } } } : {}),
        tools: [{ name: "capacity_probe", label: "Capacity probe", description: "Return one bounded test result", parameters: Type.Object({}),
          execute: async () => { toolRuns++; return { content: [{ type: "text", text: "probe-ok" }], details: {} }; } }],
        extras: [{ name: "google-capacity-observer", factory(pi) {
          pi.events.on("nunc:admission", value => admissions.push(value as AdmissionObservation));
        } }],
      });
      t.after(() => f.close());
      f.settings.applyOverrides({ compaction: { enabled, reserveTokens: 16384, keepRecentTokens: 20000 } });
      const wrapped: Provider = {
        ...google,
        streamSimple: (_m, context, options) => {
          nativeEstimates.push(estimateContextTokens(context).tokens);
          return google.streamSimple(model, context, { ...options, apiKey: "offline-fixture-key", maxRetries: 0 });
        },
        stream: (_m, context, options) => google.stream(model, context, { ...options, apiKey: "offline-fixture-key", maxRetries: 0 } as Parameters<typeof google.stream>[2]),
      };
      new ModelRegistry(f.modelRuntime).registerProvider(wrapped);
      await f.modelRuntime.setRuntimeApiKey(google.id, "offline-fixture-key");
      await f.runtime.session.setModel(model);
      await f.runtime.session.prompt("Establish native Google usage");
      assert.equal(bodies.length, 1);
      const anchor = f.runtime.session.messages.at(-1);
      assert(anchor?.role === "assistant");
      assert.equal(anchor.stopReason, "stop", anchor.errorMessage ?? "");
      assert.equal(anchor.usage.cacheRead, 960000);
      await f.runtime.session.prompt("Continue");
      const near = admissions.find(o => o.kind === "main" && o.estimator === "pi-usage-backed");
      assert(near, JSON.stringify(admissions));
      assert.equal(near.inputTokens, expectedInput);
      assert.equal(near.inputLimit, mode === "explicit-limit" ? 982016 : 1048575);
      const last = f.runtime.session.messages.at(-1);
      assert(last?.role === "assistant");
      if (allowed) {
        assert.equal(near.outcome, "delegate", last.errorMessage ?? "");
        assert.equal(near.plannedInputLimit, 1031168);
        assert.equal(near.outputReserveTokens, 16384);
        assert.equal(last.stopReason, "stop", last.errorMessage ?? "");
        assert.equal(bodies.length, 3, "one anchor, one tool call, one tool-result response");
        assert.equal(toolRuns, 1);
        assert.equal(bodies[0]!.generationConfig.maxOutputTokens, 65536);
        const cap = bodies[1]!.generationConfig.maxOutputTokens;
        assert(cap > 0 && cap < 65536, `native output cap ${cap}`);
        assert.equal(nativeEstimates[1]! + cap + 4096, 1048576, "native serializer retains its context-sized output and safety margin");
        const texts = bodies[2]!.contents.flatMap(c => c.parts.flatMap(p => p.text ? [p.text] : []));
        assert.equal(texts.filter(text => text === "Continue").length, 1);
        assert.equal(admissions.some(o => o.outcome === "reject"), false);
      } else {
        assert.equal(near.outcome, "reject");
        assert.equal(near.code, "CAPACITY");
        assert.equal(last.stopReason, "error");
        assert.match(last.errorMessage ?? "", /context_length_exceeded: Nunc local CAPACITY/);
        assert.equal(bodies.length, 1, "oversized follow-up never reaches HTTP");
        assert.equal(toolRuns, 0);
      }
      assert.equal(f.events.length, 0, "no fabricated maintenance for the near-limit request");
      assert.equal(f.runtime.session.sessionManager.getEntries().filter(e => e.type === "compaction").length, 0);
      assert.equal(f.settings.getCompactionSettings(model).enabled, enabled);
    });
  }
}
