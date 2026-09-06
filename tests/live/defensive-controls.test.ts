import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxProvider, type Context, type Provider } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createReadToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { boundedProvider, BudgetLedger, ledgerSummary, readLedger } from "../../src/live/budget.js";
import observer from "../../src/live/observer.js";
import { openHost } from "../../src/live/host.js";
import { execute } from "../../src/live/runner.js";
import { fixture, repository } from "./fixtures.js";

const SECRET = "fake-secret-s3ntinel";
const context: Context = { systemPrompt: "Use available evidence.", messages: [{ role: "user", content: "Inspect the pending work.", timestamp: 1 }] };
const hostChild = join(repository, "tests/live/host-child.mjs");
const supervisorLoopWorker = join(repository, "tests/live/supervisor-loop-worker.mjs");

function leak(value: unknown): void {
  assert.doesNotMatch(JSON.stringify(value), new RegExp(SECRET));
}

function fetchProvider(base: Provider, afterFetch?: (output: AssistantMessageEventStream) => void): Provider {
  return {
    ...base,
    stream: (model, ctx, options) => {
      const output = new AssistantMessageEventStream();
      void (async () => {
        try {
          const payload = { model: model.id, stream: true, max_tokens: options?.maxTokens ?? 16 };
          await options?.onPayload?.(payload, model);
          await (options?.fetch ?? fetch)(new URL("/v1", model.baseUrl).href, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
          afterFetch?.(output);
        } catch {
          output.end();
        }
      })();
      return output;
    },
    streamSimple(model, ctx, options) { return this.stream(model, ctx, options); },
  };
}

test("native OpenAI adapter keeps HTTP 429 facts and drops secrets from the consumed terminal", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const base = openaiProvider(), model = base.getModels().find(m => m.id === "gpt-4.1"); assert(model);
    const ledger = new BudgetLedger(join(input.target.stateRoot, "calls.jsonl"), input.limits, Date.now() + 10000, new AbortController().signal);
    let requests = 0;
    const transport: typeof fetch = async (resource, init) => {
      requests++;
      const request = new Request(resource, init);
      return new Response(JSON.stringify({ error: { message: SECRET, type: "rate_limit_error" } }), { status: 429, headers: { "content-type": "application/json", "x-secret": SECRET, "retry-after": "0" } });
    };
    const provider = boundedProvider(base, [model], ledger, { fetch: transport });
    const response = await provider.streamSimple(model, context, { maxTokens: 1000, apiKey: "offline-fixture-key" }).result();
    assert.equal(response.stopReason, "error"); assert.equal(requests, 1);
    assert.match(response.errorMessage ?? "", /status=429/); assert.match(response.errorMessage ?? "", /PROVIDER_HTTP/); assert.match(response.errorMessage ?? "", /transport=started/);
    leak(response); leak(readLedger(ledger.path));
    const terminal = readLedger(ledger.path).find(r => r.kind === "terminal");
    assert(terminal && terminal.kind === "terminal");
    assert.equal(terminal.diagnostic?.httpStatus, 429);
    assert.equal(terminal.usage.totalTokens, null);
    assert.equal((await provider.streamSimple(model, context, { maxTokens: 1000, apiKey: "offline-fixture-key" }).result()).stopReason, "error");
    assert.equal(requests, 1);
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});

test("native OpenAI adapter distinguishes network failure from 200 protocol failure", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const base = openaiProvider(), model = base.getModels().find(m => m.id === "gpt-4.1"); assert(model);
    for (const kind of ["network", "protocol"] as const) {
      const path = join(input.target.stateRoot, `${kind}.jsonl`);
      const ledger = new BudgetLedger(path, input.limits, Date.now() + 10000, new AbortController().signal);
      const transport: typeof fetch = async () => {
        if (kind === "network") {
          const cause = Object.assign(new Error("connect"), { code: "ECONNREFUSED" });
          throw Object.assign(new TypeError("fetch failed"), { cause });
        }
        return new Response(`not-sse ${SECRET}`, { status: 200, headers: { "content-type": "text/event-stream", "x-secret": SECRET } });
      };
      const response = await boundedProvider(base, [model], ledger, { fetch: transport }).streamSimple(model, context, { maxTokens: 1000, apiKey: "offline-fixture-key" }).result();
      assert.equal(response.stopReason, "error");
      leak(response); leak(readLedger(path));
      if (kind === "network") {
        assert.match(response.errorMessage ?? "", /NETWORK|transport=started|errno=ECONNREFUSED/);
        assert.doesNotMatch(response.errorMessage ?? "", /status=/);
      } else {
        assert.match(response.errorMessage ?? "", /status=200/);
        assert.match(response.errorMessage ?? "", /PROVIDER_PROTOCOL|protocol/);
      }
      const terminal = readLedger(path).find(r => r.kind === "terminal");
      assert(terminal && terminal.kind === "terminal");
      assert.equal(ledgerSummary(readLedger(path)).unreconciledCallIds.length, 0);
    }
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});

test("local payload rejection terminals without transport; post-send gap stays unresolved", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const base = openaiProvider(), model = base.getModels().find(m => m.id === "gpt-4.1"); assert(model);
    const localPath = join(input.target.stateRoot, "local.jsonl");
    let localSends = 0;
    const localLedger = new BudgetLedger(localPath, input.limits, Date.now() + 10000, new AbortController().signal);
    const local = boundedProvider(base, [model], localLedger, { fetch: async () => { localSends++; return new Response("no"); } });
    const blocked = await local.streamSimple(model, context, { maxTokens: 1000, apiKey: "offline-fixture-key", onPayload: () => ({ stream: false, model: model.id }) }).result();
    assert.equal(blocked.stopReason, "error"); assert.equal(localSends, 0);
    assert.match(blocked.errorMessage ?? "", /PAYLOAD/); assert.match(blocked.errorMessage ?? "", /transport=not-started|stage=payload/);
    const localRecords = readLedger(localPath);
    assert.equal(localRecords.filter(r => r.kind === "reserve").length, 1);
    assert.equal(localRecords.filter(r => r.kind === "terminal").length, 1);
    assert.deepEqual(ledgerSummary(localRecords).unreconciledCallIds, []);

    const faux = fauxProvider({ provider: "nunc-live-controlled", models: [{ id: "test", contextWindow: 60000, maxTokens: 8192 }] });
    const custom = { ...faux.getModel(), baseUrl: "https://api.example.test" };
    const gapPath = join(input.target.stateRoot, "gap.jsonl");
    const gapLedger = new BudgetLedger(gapPath, input.limits, Date.now() + 10000, new AbortController().signal);
    let gapSends = 0;
    const gap = boundedProvider(fetchProvider(faux.provider, output => output.end()), [custom], gapLedger, { fetch: async () => { gapSends++; return new Response("{}", { status: 200 }); } });
    const hanging = await gap.streamSimple(custom, context, { maxTokens: 16 }).result();
    assert.equal(gapSends, 1);
    assert.deepEqual(ledgerSummary(readLedger(gapPath)).unreconciledCallIds, [1]);
    assert.equal(readLedger(gapPath).filter(r => r.kind === "terminal").length, 0);
    assert.equal(hanging.stopReason, "error");
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});

test("first fetch then a denied second attempt without a provider terminal stays unresolved", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const faux = fauxProvider({ provider: "nunc-live-controlled", models: [{ id: "test", contextWindow: 60000, maxTokens: 8192 }] });
    const custom = { ...faux.getModel(), baseUrl: "https://api.example.test" };
    const path = join(input.target.stateRoot, "retry.jsonl");
    const ledger = new BudgetLedger(path, input.limits, Date.now() + 10000, new AbortController().signal);
    let sends = 0;
    const twice: Provider = {
      ...faux.provider,
      stream(model, ctx, options) {
        const output = new AssistantMessageEventStream();
        void (async () => {
          const payload = { model: model.id, stream: true, max_tokens: options?.maxTokens ?? 16 };
          await options?.onPayload?.(payload, model);
          await (options?.fetch ?? fetch)(new URL("/v1", model.baseUrl).href, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
          try { await (options?.fetch ?? fetch)(new URL("/v1", model.baseUrl).href, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }); }
          catch { /* expected local CALL_LIMIT after the first send */ }
          output.end();
        })();
        return output;
      },
      streamSimple(model, ctx, options) { return this.stream(model, ctx, options); },
    };
    const response = await boundedProvider(twice, [custom], ledger, { fetch: async () => { sends++; return new Response("{}", { status: 200 }); } }).streamSimple(custom, context, { maxTokens: 16 }).result();
    assert.equal(sends, 1);
    assert.equal(readLedger(path).filter(r => r.kind === "terminal").length, 0);
    assert.deepEqual(ledgerSummary(readLedger(path)).unreconciledCallIds, [1]);
    assert.equal(response.stopReason, "error");
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});

test("same-case failed terminal still blocks a second send; a later case can reserve", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const model = input.resolvedModels![0]!;
    const path = join(input.target.stateRoot, "calls.jsonl");
    const first = new BudgetLedger(path, input.limits, Date.now() + 10000, new AbortController().signal, "c1");
    const reservation = first.reserve(model, context, 16);
    first.finish(reservation, { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: "nunc live stopped: PROVIDER_HTTP", timestamp: Date.now() });
    assert.throws(() => first.reserve(model, context, 16), /this scenario/);
    const second = new BudgetLedger(path, input.limits, Date.now() + 10000, new AbortController().signal, "c2");
    const next = second.reserve(model, context, 16);
    assert.equal(next.id, 2); assert.equal(next.caseKey, "c2");
    second.finish(next, { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
    const summary = ledgerSummary(readLedger(path));
    assert.equal(summary.calls, 2); assert.equal(summary.totalTokens, null); assert.deepEqual(summary.unreconciledCallIds, []);
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});

test("supervisor loop: failed PAUSED does not resume; STOPPED/CLEANUP stops; semantic UNPROVEN continues", { timeout: 60000 }, async () => {
  for (const mode of ["paused-unproven", "stopped-cleanup", "unproven-main"] as const) {
    const input = await fixture();
    input.mode = "native";
    const config = input.scenarios[0]!.config;
    input.scenarios = mode === "paused-unproven" ? [{ id: "c3", config }, { id: "c2", config }] : [{ id: "c1", config }, { id: "c2", config }];
    input.overrides = [{ requirement: `supervisor-loop:${mode}`, reason: "Supervisor loop regression; not a native worker proof" }];
    try {
      const report = await execute(input, repository, supervisorLoopWorker, new AbortController().signal);
      assert.equal(report.status, "UNPROVEN");
      if (mode === "stopped-cleanup") {
        assert.equal(report.children.length, 1);
        assert.equal(report.segments.length, 1);
        assert.equal(report.segments[0]?.status, "STOPPED");
        assert.equal(report.reason, "CLEANUP");
      } else {
        assert.equal(report.children.length, 2);
        assert.equal(report.segments.length, 2);
        assert.equal(report.segments[1]?.scenario, "c2");
        assert.equal(report.segments[1]?.status, "OBSERVED");
        if (mode === "paused-unproven") {
          assert.equal(report.segments[0]?.status, "PAUSED");
          await assert.rejects(lstat(join(input.target.stateRoot, "c3", "resumed-observation.json")), { code: "ENOENT" });
        } else assert.equal(report.segments[0]?.status, "UNPROVEN");
      }
    } finally { await rm(input.target.stateRoot, { recursive: true, force: true }); }
  }
});

test("observer allows cwd read for native directory error and keeps distinct denials", async () => {
  const input = await fixture();
  const cwd = join(input.target.stateRoot, "task");
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, "note.txt"), "ok");
  const events = join(input.target.stateRoot, "events.jsonl");
  await writeFile(events, "");
  const binding = join(input.target.stateRoot, "binding.json");
  await writeFile(binding, JSON.stringify({ input, models: input.resolvedModels, deadline: Date.now() + 20000, events, ledger: join(input.target.stateRoot, "calls.jsonl"), cwd, caseKey: "c2" }));
  const previous = process.env.NUNC_LIVE_OBSERVER;
  process.env.NUNC_LIVE_OBSERVER = binding;
  const handlers = new Map<string, (event: never) => unknown>();
  try {
    observer({
      on(event: string, handler: (event: never) => unknown) { handlers.set(event, handler); },
      events: { on() { /* observer also subscribes to nunc events */ } },
      registerProvider() { /* unused in tool-path checks */ },
      registerCommand() { /* unused in tool-path checks */ },
    } as unknown as ExtensionAPI);
    const toolCall = handlers.get("tool_call"); assert(toolCall);
    assert.equal(await toolCall({ toolName: "read", toolCallId: "1", input: { path: "." } } as never), undefined);
    const writeRoot = await toolCall({ toolName: "write", toolCallId: "2", input: { path: ".", content: "no" } } as never) as { block: boolean; reason: string };
    assert.equal(writeRoot.block, true); assert.match(writeRoot.reason, /path/i);
    const kind = await toolCall({ toolName: "bash", toolCallId: "3", input: { command: "ls" } } as never) as { block: boolean; reason: string };
    assert.equal(kind.block, true); assert.match(kind.reason, /kind/i);
    const size = await toolCall({ toolName: "write", toolCallId: "4", input: { path: "huge.txt", content: "x".repeat(1_000_001) } } as never) as { block: boolean; reason: string };
    assert.equal(size.block, true); assert.match(size.reason, /exceeds bound/i);
    await symlink("/etc/passwd", join(cwd, "link"));
    const linked = await toolCall({ toolName: "read", toolCallId: "5", input: { path: "link" } } as never) as { block: boolean; reason: string };
    assert.equal(linked.block, true); assert.match(linked.reason, /path/i);
    const traversal = await toolCall({ toolName: "read", toolCallId: "6", input: { path: "../calls.jsonl" } } as never) as { block: boolean; reason: string };
    assert.equal(traversal.block, true); assert.match(traversal.reason, /path/i);
    const protectedName = await toolCall({ toolName: "read", toolCallId: "7", input: { path: ".pi/settings.json" } } as never) as { block: boolean; reason: string };
    assert.equal(protectedName.block, true); assert.match(protectedName.reason, /path/i);
    const reasons = [writeRoot.reason, kind.reason, size.reason];
    assert.equal(new Set(reasons).size, 3);
    const tool = createReadToolDefinition(cwd);
    const ctx = { cwd } as never;
    await assert.rejects(async () => tool.execute("cwd", { path: "." }, undefined, undefined, ctx), (error: NodeJS.ErrnoException) => error.code === "EISDIR" || /directory|EISDIR|illegal operation/i.test(String(error)));
    const file = await tool.execute("file", { path: "note.txt" }, undefined, undefined, ctx);
    assert(file && typeof file === "object");
  } finally {
    if (previous === undefined) delete process.env.NUNC_LIVE_OBSERVER; else process.env.NUNC_LIVE_OBSERVER = previous;
    await rm(input.target.stateRoot, { recursive: true, force: true });
  }
});

async function hostFixture() {
  const input = await fixture();
  await mkdir(join(input.target.stateRoot, "tmp"), { recursive: true });
  const caseRoot = join(input.target.stateRoot, "c2");
  await mkdir(join(caseRoot, "task"), { recursive: true });
  await mkdir(join(caseRoot, "sessions"), { recursive: true });
  return { input, caseRoot };
}

test("host malformed RPC, output limit and observer drain keep distinct failure codes", { timeout: 40000 }, async () => {
  for (const mode of ["malformed", "overflow", "drain"] as const) {
    const { input, caseRoot } = await hostFixture();
    try {
      const command = { command: process.execPath, args: [hostChild, mode === "drain" ? "rpc" : mode] };
      if (mode === "drain") {
        const host = await openHost({ repository, input, selection: input.scenarios[0]!, caseRoot, modelTargets: input.resolvedModels!, deadline: Date.now() + 15000, signal: new AbortController().signal, testCommand: command });
        try {
          const events = (await readdir(caseRoot)).find(name => name.startsWith("events-")); assert(events);
          await writeFile(join(caseRoot, events), "{not-an-observer-record\n");
          await new Promise(resolve => setTimeout(resolve, 80));
          await assert.rejects(host.refresh(), (error: { code?: string }) => error.code === "OBSERVER" || error.code === "HOST_EXIT");
          await assert.rejects(host.refresh(), (error: { code?: string }) => error.code === "OBSERVER");
        } finally { await host.close(); }
      } else {
        await assert.rejects(openHost({ repository, input, selection: input.scenarios[0]!, caseRoot, modelTargets: input.resolvedModels!, deadline: Date.now() + (mode === "overflow" ? 20000 : 8000), signal: new AbortController().signal, testCommand: command }), (error: { code?: string }) => error.code === (mode === "malformed" ? "HOST_RPC" : "OUTPUT"));
      }
    } finally { await rm(input.target.stateRoot, { recursive: true, force: true }); }
  }
});
