import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { RunnerError } from "../../bench/live/contract.js";
import { openHost, type NativeHost } from "../../bench/live/host.js";
import { fixture, repository } from "./fixtures.js";

function groqPair(endpoint: string): { authorized: Model<Api>; other: Model<Api>; controlledModels: unknown } {
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const authorized: Model<Api> = { id: "nunc-native", name: "nunc-native", provider: "groq", api: "openai-completions", baseUrl: endpoint, reasoning: false, input: ["text", "image"], contextWindow: 60000, maxTokens: 20000, cost };
  const other: Model<Api> = { id: "nunc-small", name: "nunc-small", provider: "groq", api: "openai-completions", baseUrl: endpoint, reasoning: false, input: ["text"], contextWindow: 52000, maxTokens: 12000, cost };
  return { authorized, other, controlledModels: { providers: { groq: { baseUrl: endpoint, apiKey: "isolated-nunc-fixture", models: [{ ...authorized, provider: undefined, cost: undefined }, { ...other, provider: undefined, cost: undefined }] } } } };
}

test("startup thinking restoration uses post-model state and restores explicit off", { timeout: 15000 }, async () => {
  for (const desired of ["off", "low"]) {
    const input = await fixture();
    const model = input.resolvedModels![0]!;
    input.effective = { source: "standalone-defaults", provider: model.provider, model: model.id, thinking: desired, transport: "sse", compaction: input.scenarios[0]!.config.compaction, settings: {} };
    const caseRoot = join(input.target.stateRoot, "c2");
    await mkdir(join(caseRoot, "task"), { recursive: true });
    const script = `
      const fs = require('node:fs');
      const binding = JSON.parse(fs.readFileSync(process.env.NUNC_LIVE_OBSERVER, 'utf8'));
      const state = { sessionId: 'fixture', model: { provider: 'other', id: 'other' }, thinkingLevel: ${JSON.stringify(desired)} };
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const msg = JSON.parse(line);
        if (msg.message === '/nunc-observer-quit') { process.exit(0); return; }
        if (msg.type === 'set_model') { state.model = binding.models[0]; state.thinkingLevel = 'high'; }
        if (msg.type === 'set_thinking_level') state.thinkingLevel = msg.level;
        process.stdout.write(JSON.stringify({ type: 'response', id: msg.id, success: true, data: msg.type === 'get_state' ? state : {} }) + '\\n');
      });`;
    const host = await openHost({ repository, input, selection: input.scenarios[0]!, caseRoot, modelTargets: [model], deadline: Date.now() + 10000, signal: new AbortController().signal, testCommand: { command: process.execPath, args: ["-e", script] } });
    try {
      const state = await host.command("get_state") as { thinkingLevel: string; model: { id: string } };
      assert.equal(state.model.id, model.id);
      assert.equal(state.thinkingLevel, desired);
    } finally { await host.close(); }
  }
});

test("native RPC restores authorized CLI model after a later session_start apply and still rejects unauthorized set_model", { timeout: 60000 }, async t => {
  const { StockFixture } = await import(join(repository, "scripts/stock-driver.mjs"));
  const f = await new StockFixture().setup({ timeoutMs: 55000, compaction: { enabled: false } });
  let host: NativeHost | undefined;
  t.after(async () => { if (host) await host.close(); await f.close(); });
  const { authorized, other, controlledModels } = groqPair(f.endpoint);
  const input = await fixture();
  input.mode = "controlled";
  input.target.stateRoot = join(f.state, "nunc-live-startup-model");
  input.models = [{ provider: authorized.provider, id: authorized.id, contextWindow: authorized.contextWindow, maxTokens: authorized.maxTokens, baseUrl: authorized.baseUrl }];
  input.resolvedModels = [authorized];
  const caseRoot = join(input.target.stateRoot, "c2");
  await mkdir(join(caseRoot, "task"), { recursive: true });
  const applyPath = join(repository, "dist/tests/live/apply-startup-model.js");
  const ready: Array<{ provider?: string; id?: string }> = [];
  host = await openHost({
    repository, input, selection: input.scenarios[0]!, caseRoot, modelTargets: [authorized], deadline: Date.now() + 50000,
    signal: t.signal, group: "native", controlledModels, testExtensions: [applyPath],
    onObservation: (type, data) => { if (type === "ready" && data && typeof data === "object" && "model" in data) ready.push((data as { model?: { provider?: string; id?: string } }).model ?? {}); },
  });
  const state = await host.command("get_state") as { model?: { provider?: string; id?: string } };
  assert.equal(state.model?.provider, authorized.provider);
  assert.equal(state.model?.id, authorized.id);
  assert.equal(host.model?.provider, authorized.provider);
  assert.equal(host.model?.id, authorized.id);
  const applyLog = JSON.parse(await readFile(join(caseRoot, "apply-startup-model.json"), "utf8")) as { before?: { id?: string }; after?: { provider?: string; id?: string }; accepted?: boolean };
  assert.equal(applyLog.after?.provider, other.provider);
  assert.equal(applyLog.after?.id, other.id);
  assert.notEqual(applyLog.after?.id, applyLog.before?.id);
  const entries = host.sessionFile ? SessionManager.open(host.sessionFile).getEntries() : [];
  await host.prompt("Confirm the restored authorized model.");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]?.payload?.model, authorized.id);
  await assert.rejects(host.setModel(other), (error: unknown) => error instanceof RunnerError && error.code === "MODEL");
  await writeFile(join(f.dir, "startup-model-proof.json"), JSON.stringify({
    ready, applyLog, getState: { provider: state.model?.provider, id: state.model?.id },
    requestModel: f.requests[0]?.payload?.model,
    sessionEntries: entries.map(e => e.type === "model_change" ? { type: e.type, provider: e.provider, modelId: e.modelId } : { type: e.type }),
  }, null, 2));
});
