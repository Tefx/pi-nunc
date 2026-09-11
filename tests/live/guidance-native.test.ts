import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { repository } from "./fixtures.js";

// Synthetic SSE supplies tools, not model judgments. All effects run through the
// public CLI -> supervisor -> worker -> stock Pi -> original tools and filesystem.
test("guidance public preflight and all ten stock scenes preserve actual tools, faults, split and capacity evidence", { timeout: 300000 }, async () => {
  const { StockFixture, text } = await import(join(repository, "scripts/stock-driver.mjs"));
  const f = await new StockFixture().setup({ timeoutMs: 280000 });
  const provider = "openrouter", model = "google/gemini-guidance-fixture";
  await writeFile(join(f.state, "agent/models.json"), JSON.stringify({ providers: { [provider]: { baseUrl: f.endpoint, apiKey: "isolated-nunc-fixture", models: [{ id: model, api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 60000, maxTokens: 20000 }] } } }));
  f.limits = { ...f.limits, maxCalls: 160, maxTotalTokens: 24000000 };
  const selections = [{ id: "g1" }, { id: "g2" }, { id: "g3" }, { id: "g4" }, { id: "g5" }, { id: "g6" }, { id: "g7", variant: "conflict" }, { id: "g7", variant: "unconfirmed" }, { id: "g8", variant: "fits-required" }, { id: "g8", variant: "required-too-large" }];
  const assets = JSON.parse(await readFile(join(repository, "tests/scenarios/guidance-inputs.json"), "utf8"));
  const scenarios = selections.map(s => { const base = assets.cases.find((c: any) => c.id === s.id); return { ...base, ...base.variants?.find((v: any) => v.id === s.variant), id: s.id, variant: s.variant }; });
  let scenarioIndex = -1, turn = "", step = 0, finished = true;
  const tool = (name: string, input: unknown) => ({ tool: { name, input } });
  const write = (path: string, value: unknown) => tool("write", { path, content: typeof value === "string" ? value : JSON.stringify(value) });
  const verify = () => tool("bash", { command: "python3 verify.py" });
  f.response = (row: any, source: any) => {
    const scenario = scenarios[scenarioIndex];
    if (source) {
      const capacity = scenario?.id === "g8";
      const add = capacity ? [{ key: "req", text: "n".repeat(scenario.variant === "required-too-large" ? 1000 : 120) }, { key: "extra", text: "x".repeat(200) }, { key: "opt", text: "o" }] : [{ key: "task", text: scenario?.id === "g6" ? "Wait for deployment lock release; then write deployed.json for orders-pipeline and verify." : "Pending milestone; recover original obligations from obligations.txt." }];
      return JSON.stringify({ add, remove: source.M.map((s: any) => s.id), priority: capacity ? ["opt", "extra", "req"] : ["task"], required: [add[0]!.key] });
    }
    const messages = row.payload.messages.filter((m: any) => !text(m).includes("Nunc working memory"));
    const last = messages.at(-1), lastText = last ? text(last) : "";
    if (last?.role === "user" && finished && scenarios[scenarioIndex + 1]?.turns[0].text === lastText) {
      scenarioIndex++; turn = "a"; step = 0; finished = false;
    } else if (last?.role === "user") {
      const next = scenarios[scenarioIndex]?.turns.find((t: any) => t.text === lastText);
      if (next && next.id !== turn) { turn = next.id; step = 0; finished = false; }
    }
    const current = scenarios[scenarioIndex], n = step++, key = `${current?.id}:${turn}`;
    const stop = () => { finished = true; return { text: "Controlled task turn complete; semantic quality untested.", input: 2000 }; };
    const patch = (note: string, update = false) => {
      const read = JSON.parse(lastText);
      return tool("nunc_memory_patch", { expectedRevision: read.revision, ...(update ? { update: [{ id: read.slots[0].id, text: note }] } : { add: [{ key: "note", text: note }] }) });
    };
    if (key === "g1:a") return n === 0 ? tool("read", { path: "reference.txt" }) : stop();
    if (key === "g2:a") return n === 0 ? tool("read", { path: "diagnostics.json" }) : n === 1 ? tool("nunc_memory_read", {}) : n === 2 ? patch("migration-v2 rejected due to ERR_SCHEMA_V2; use run-migration --v1 --port 5433.") : stop();
    if (key === "g2:b") return n === 0 ? write("recovery.json", { route: "pipeline-v1-fallback", argv: ["run-migration", "--v1", "--port", "5433"], error: "ERR_SCHEMA_V2" }) : n === 1 ? verify() : stop();
    if (key === "g3:a" || key === "g3:b") return n === 0 ? tool("nunc_memory_read", {}) : n === 1 ? patch(turn === "a" ? "Port 8080; database sqlite." : "Port 9090 replaces obsolete 8080; database sqlite.", turn === "b") : stop();
    if (key === "g3:c") return n === 0 ? write("config.json", { port: 9090, database: "sqlite" }) : stop();
    if (key === "g4:a" || key === "g4:c") return n === 0 ? tool("read", { path: "obligations.txt" }) : key === "g4:c" && n === 1 ? write("pending.json", ["Token rotation", "Rate limiting", "Security regressions"]) : stop();
    if (key === "g5:a") return n === 0 ? write("solution.py", "def double(x): return x + x\n") : stop();
    if (key === "g5:b") return n === 0 ? verify() : stop();
    if (key === "g6:a") return n === 0 ? { ...tool("read", { path: "status.json" }), input: 15000 } : stop();
    if (key === "g6:b") return n === 0 ? write("deployed.json", { deployed: true, service: "orders-pipeline" }) : n === 1 ? verify() : stop();
    if (key === "g7:a") {
      if (n === 0) return tool("read", { path: "notes.txt" });
      if (n === 1 || n === 3 && current.variant === "conflict") return tool("nunc_memory_read", {});
      if (n === 2 || n === 4 && current.variant === "conflict") return patch("Deployment checklist: run schema migration; not yet executed.");
      return stop();
    }
    if (key === "g7:b") return n === 0 ? tool("read", { path: "notes.txt" }) : stop();
    if (key === "g8:a") return n === 0 ? tool("read", { path: "lanes.json" }) : stop();
    if (key === "g8:b") return n === 0 ? write("count.json", 8) : stop();
    if (key === "g8:c") return n === 0 ? write("routing.json", JSON.parse(current.files["lanes.json"])) : stop();
    return stop();
  };
  const selection: any = { target: { repository, stateRoot: join(f.dir, "nunc-live-guidance"), cleanup: "retain" }, limits: { maxCalls: 160, maxTotalTokens: 24000000, maxDurationMs: 240000, maxOutputTokens: 20000, maxCostUsd: null }, scenarios: selections,
    overrides: [{ requirement: "offline-guidance-mechanics", reason: "Synthetic loopback protocol only; no live model calls", model: { provider, id: model }, config: { nunc: { extraction: { outputTokens: 1024 } }, compaction: { enabled: false, reserveTokens: 36000, keepRecentTokens: 1 }, retentionCalibration: { minFraction: 0.000001, maxFraction: 0.999999 } } },
      { requirement: "split", reason: "Actual automatic native split", scenario: "g6", config: { compaction: { enabled: true } } },
      ...["fits-required", "required-too-large"].map(variant => ({ requirement: "capacity", reason: "Measured finite memory competition", scenario: `g8/${variant}`, config: { nunc: { memory: { maxTokens: 100 }, extraction: { outputTokens: 1024 } } } }))] };
  const run = async (args: string[], input = selection) => {
    const child = spawn(process.execPath, [join(repository, "scripts/verify-live.mjs"), ...args], { cwd: repository, env: f.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
    child.stdin.end(JSON.stringify(input));
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    return { code, stderr, report: stdout ? JSON.parse(stdout) : undefined };
  };
  let observed: any;
  try {
    const preflight = await run(["--preflight"]);
    assert.equal(preflight.code, 0, JSON.stringify(preflight)); assert.equal(preflight.report.receipt.callsMade, 0); assert.equal(f.requests.length, 0);
    await assert.rejects(stat(selection.target.stateRoot));
    assert.equal(preflight.report.scenarios.length, 10);
    // Scope errors are rejected before any effect and model route stays global.
    const invalid = structuredClone(selection); invalid.overrides.at(-1).scenario = "g8/missing";
    assert.notEqual((await run(["--preflight"], invalid)).code, 0); assert.equal(f.requests.length, 0);
    const nonGemini = structuredClone(selection); nonGemini.overrides[0].model = { provider: "openai-codex", id: "gpt-6-astra" };
    assert.notEqual((await run(["--preflight"], nonGemini)).code, 0); assert.equal(f.requests.length, 0);
    observed = await run([]);
    await writeFile(join(f.dir, "guidance-report.json"), JSON.stringify(observed));
    assert.equal(observed.code, 0, JSON.stringify({ code: observed.code, reason: observed.report?.reason, stderr: observed.stderr }));
    const segments = observed.report.segments;
    assert.equal(segments.length, 10, JSON.stringify(observed.report));
    for (const segment of segments) {
      assert(segment.prerequisites.some((p: any) => p.check === "memory tools exposed in session" && p.status === "PROVEN"), segment.scenario);
      assert(segment.score?.actionReview.filter((c: any) => c.check.startsWith("semantic:")).every((c: any) => c.status === "UNPROVEN"));
    }
    const g2 = segments.find((s: any) => s.scenario === "g2");
    assert(g2.actions.some((a: any) => a.event.type === "memory_state" && a.event.slots.length));
    assert(g2.score.actionReview.filter((c: any) => !c.check.startsWith("semantic:")).every((c: any) => c.status === "PROVEN"), JSON.stringify(g2.score));
    const g6 = segments.find((s: any) => s.scenario === "g6");
    assert(g6.prerequisites.some((p: any) => p.check.includes("automatic native split compaction") && p.status === "PROVEN"), JSON.stringify(g6));
    assert(g6.score.actionReview.filter((c: any) => !c.check.startsWith("semantic:")).every((c: any) => c.status === "PROVEN"), JSON.stringify(g6.score));
    const faults = segments.filter((s: any) => s.scenario === "g7");
    assert.equal(faults[0].score.actionReview[0].status, "PROVEN", JSON.stringify(faults[0]));
    assert.equal(faults[1].score.actionReview[0].status, "PROVEN", JSON.stringify(faults[1]));
    assert(faults[1].actions.some((a: any) => a.event.phase === "save-file-restored"));
    assert.equal((await stat(faults[1].sessionFile)).mode & 0o200, 0o200);
    for (const s of segments.filter((s: any) => s.scenario === "g8")) assert.equal(s.score.actionReview[0].status, "PROVEN", JSON.stringify(s));
  } finally { await f.close({ guidance: observed }); }
});
