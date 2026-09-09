import { test } from "node:test";
import assert from "node:assert/strict";
import { zstdDecompressSync } from "node:zlib";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { record } from "../../src/engine/validation.js";
import { applyLastUserTextAppend, authorizePayload, classifyPayloadChange, codexSystemInstructionRewrite } from "../../src/pi/payload.js";
import type { AdmissionObservation } from "../../src/pi/admission.js";
import { fixture } from "./fixtures.js";
import { oauthFixture } from "./oauth-fixture.js";

const provider = openaiCodexProvider();
const model = provider.getModels().find(m => m.id === "gpt-6-astra")!;
assert(model);
const original = () => ({
  model: model.id, stream: true, instructions: "Base rules. Borrowed role.",
  input: [
    { role: "user", content: [{ type: "input_text", text: "Keep original task." }] },
    { type: "function_call", name: "probe", call_id: "c1", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: "Keep tool result." },
    { role: "user", content: [{ type: "input_text", text: "Callback." }] },
  ],
});
function authorize(before: unknown, after: unknown, extra: Partial<Parameters<typeof authorizePayload>[0]> = {}) {
  return authorizePayload({ model, before, after, delta: classifyPayloadChange(before, after, "replacement"),
    inputTokens: 100, inputLimit: 8000, authorizedOutput: model.maxTokens, context: { messages: [] }, allowSystemInstructionRewrite: true, ...extra });
}

test("Codex main instructions can restore identity without rewriting history, including a composed last-user append", () => {
  const before = original(), after = { ...before, instructions: "Base rules. Restored role." };
  authorize(before, after);
  const result = applyLastUserTextAppend(after, "Additional callback context.");
  assert(result.changed);
  const mapped = codexSystemInstructionRewrite(model, before, result.payload);
  assert(mapped.ok && mapped.append.ok);
  authorize(before, result.payload);
  assert.deepEqual(before.input, original().input);
  assert.throws(() => authorize(before, after, { allowSystemInstructionRewrite: false }), /unvalidated payload input/);
  assert.throws(() => authorize(before, after, { model: { ...model, api: "openai-responses" } }), /unvalidated payload input/);
});

test("instructions mapper rejects malformed instructions, hidden inputs, message/tool/media rewrites and cap changes", () => {
  const before = original();
  const after = { ...before, instructions: "Restored role." };
  for (const instructions of [undefined, null, 7, [], "", " \n"]) {
    assert.throws(() => authorize(before, { ...after, instructions }), /unvalidated payload input/);
  }
  const mutations = [
    { ...after, input: after.input.slice(1) },
    { ...after, input: after.input.toReversed() },
    { ...after, input: [...after.input, { role: "user", content: "new message" }] },
    { ...after, input: after.input.map((m, i) => i === 0 ? { role: "user", content: "replaced task" } : m) },
    { ...after, input: after.input.map((m, i) => i === 2 ? { ...m, output: "replaced tool result" } : m) },
    { ...after, input: after.input.map((m, i) => i === 3 ? { ...m, content: [{ type: "input_image", image_url: "https://invalid.example/added.png" }] } : m) },
    { ...after, tools: [{ type: "function", name: "unexpected" }] },
    { ...after, previous_response_id: "hidden-input" },
    { ...after, conversation: "hidden-history" },
    { ...after, model: "different-model" },
    { ...after, stream: false },
    { ...after, max_output_tokens: 8192 },
  ];
  for (const mutation of mutations) assert.throws(() => authorize(before, mutation));
});

test("instruction shrinkage never pays for appended text or metadata growth; admission boundary includes JSON framing", () => {
  const before = { ...original(), instructions: "x".repeat(16000) };
  const append = applyLastUserTextAppend({ ...before, instructions: "Short restored identity." }, "\\".repeat(800));
  assert(append.changed);
  for (const after of [append.payload, { ...before, instructions: "Short identity.", metadata: { note: "m".repeat(3200) } }]) {
    const mapped = codexSystemInstructionRewrite(model, before, after);
    assert(mapped.ok && mapped.addedTokens >= 400);
    // Entire payload shrinks, but growth in another field still consumes headroom.
    assert.equal(classifyPayloadChange(before, after, "replacement").grewTokens, 0);
    assert.throws(() => authorize(before, after, { inputLimit: 101 }), /Payload input growth/);
    authorize(before, after, { inputLimit: 100 + mapped.addedTokens });
    assert.throws(() => authorize(before, after, { inputLimit: 99 + mapped.addedTokens }), /Payload input growth/);
  }
  const tiny = original();
  assert.throws(() => authorize(tiny, { ...tiny, instructions: "i".repeat(32000) }), /Payload input growth/);
});

function responseSSE() {
  const item = { type: "message", id: "msg-fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Completed.", annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: "response-fixture", model: model.id, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Completed." },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "response-fixture", model: model.id, status: "completed", output: [item], usage: { input_tokens: 128, output_tokens: 4, total_tokens: 132, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ];
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

test("real loader and Codex serializer deliver restored instructions on idle callback; growth, arbitrary rewrites and cancellation send nothing", { timeout: 90000 }, async t => {
  type Mode = "unchanged" | "restore" | "overflow" | "rewrite-history" | "cancel";
  let mode: Mode = "unchanged";
  const admissions: AdmissionObservation[] = [], bodies: Record<string, unknown>[] = [];
  const f = await fixture({ config: { budget: { inputLimit: 8000 } }, extras: [{ name: "identity-projection", factory(pi) {
    pi.events.on("nunc:admission", value => admissions.push(value as AdmissionObservation));
    pi.on("before_agent_start", event => ({ systemPrompt: event.systemPrompt + "\nBorrowed role." }));
    pi.on("before_provider_request", (event, ctx) => {
      if (mode === "unchanged") return;
      assert(record(event.payload) && typeof event.payload.instructions === "string");
      if (mode === "cancel") ctx.abort();
      return { ...event.payload, instructions: mode === "overflow" ? "x".repeat(40000) : event.payload.instructions.replace("Borrowed role.", "Restored role.") };
    });
  } }, { name: "independent-last-user-append", factory(pi) {
    pi.on("before_provider_request", event => {
      if (mode === "unchanged") return;
      if (mode === "rewrite-history") return { ...event.payload as Record<string, unknown>, input: [{ role: "user", content: "Replaced history." }] };
      const appended = applyLastUserTextAppend(event.payload, "Additional callback context.");
      assert(appended.changed);
      return appended.payload;
    });
  } }] });
  t.after(() => f.close());
  const transport: typeof fetch = async (resource, init) => {
    const request = new Request(resource, init);
    const bytes = Buffer.from(await request.arrayBuffer());
    const decoded = request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes;
    const body: unknown = JSON.parse(decoded.toString("utf8"));
    assert(record(body)); bodies.push(body);
    return responseSSE();
  };
  const credential = oauthFixture();
  await f.credentials.modify(model.provider, async () => credential);
  const bound = { apiKey: credential.access, fetch: transport, transport: "sse" as const, maxRetries: 0 as const };
  const nativeModel = (m: Model<Api>): Model<"openai-codex-responses"> => {
    assert.equal(m.api, "openai-codex-responses");
    return { ...m, api: "openai-codex-responses" };
  };
  const wrapped: Provider = { ...provider,
    // Provider's generic raw signature loses the model/options correlation; this fixture binds Codex only.
    stream: (m, context, options) => provider.stream(nativeModel(m), context, { ...options, ...bound } as Parameters<typeof provider.stream>[2]),
    streamSimple: (m, context, options) => provider.streamSimple(nativeModel(m), context, { ...options, ...bound }),
  };
  new ModelRegistry(f.modelRuntime).registerProvider(wrapped);
  await f.runtime.session.setModel(model);
  await f.runtime.session.prompt("Keep this task in history.");
  assert.equal(bodies.length, 1);
  mode = "restore";
  await f.runtime.session.sendCustomMessage({ customType: "child-result", content: "Child completed.", display: true }, { triggerTurn: true });
  assert.equal(bodies.length, 2);
  assert.match(String(bodies[1]!.instructions), /Restored role\./);
  assert.doesNotMatch(String(bodies[1]!.instructions), /Borrowed role\./);
  assert.match(JSON.stringify(bodies[1]!.input), /Keep this task in history/);
  assert.match(JSON.stringify(bodies[1]!.input), /Additional callback context/);
  const restored = f.runtime.session.messages.at(-1);
  assert(restored?.role === "assistant");
  assert.equal(restored.stopReason, "stop");
  assert.equal(f.runtime.session.sessionManager.getBranch().filter(e => e.type === "custom_message" && e.customType === "child-result").length, 1);
  const mapped = admissions.findLast(o => o.payload?.transform === "codex-system-instructions");
  assert.equal(mapped?.outcome, "delegate");
  assert(mapped.inputTokens! > 0);
  // Projected wire instructions must not create an original-Context usage receipt.
  const nextStart = admissions.length;
  await f.runtime.session.prompt("Next request.");
  assert.equal(bodies.length, 3);
  const next = admissions.slice(nextStart).find(o => o.kind === "main");
  assert.equal(next?.estimator, "pi-usage-backed");
  // Only the first, unmodified response remains an eligible anchor. The callback,
  // its projected response and this new user message must all be re-estimated.
  assert.equal(next.anchorTrailingMessages, 3);
  for (const failure of ["overflow", "rewrite-history", "cancel"] as const) {
    mode = failure;
    const sends: number = bodies.length;
    await f.runtime.session.prompt("Check refusal.");
    assert.equal(bodies.length, sends, failure);
    const last = f.runtime.session.messages.at(-1);
    assert(last?.role === "assistant");
    if (failure === "cancel") assert.equal(last.stopReason, "aborted");
    else assert.match(last.errorMessage ?? "", failure === "overflow" ? /context_length_exceeded:.*CAPACITY/ : /unvalidated payload input/);
  }
});
