import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { repository } from "./fixtures.js";
import { checkFullExtraction } from "../../src/live/scenarios.js";
import { readSourceRecords } from "../../src/engine/request.js";

// Synthetic SSE supplies tools, not model judgments. All effects run through the
// public CLI -> supervisor -> worker -> stock Pi -> original tools and filesystem.
async function guidanceNative(lowUsage = false) {
  const { StockFixture, text } = await import(join(repository, "scripts/stock-driver.mjs"));
  const f = await new StockFixture().setup({ timeoutMs: 280000 });
  const provider = "openrouter", model = "google/gemini-guidance-fixture";
  await writeFile(join(f.state, "agent/models.json"), JSON.stringify({ providers: { [provider]: { baseUrl: f.endpoint, apiKey: "isolated-nunc-fixture", models: [{ id: model, api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 60000, maxTokens: 20000 }] } } }));
  f.limits = { ...f.limits, maxCalls: 160, maxTotalTokens: 24000000 };
  const selections: Array<{ id: string; variant?: string; assets?: { inputs: string; observer: string } }> = lowUsage ? [{ id: "g6" }] : [{ id: "g1" }, { id: "g2" }, { id: "g3" }, { id: "g4" }, { id: "g5" }, { id: "g6" }, { id: "g7", variant: "conflict" }, { id: "g7", variant: "unconfirmed" }, { id: "g8", variant: "fits-required" }, { id: "g8", variant: "required-too-large" }];
  const assets = JSON.parse(await readFile(join(repository, "tests/scenarios/guidance-inputs.json"), "utf8"));
  if (!lowUsage) {
    // A second real rollover sees both an obsolete manual carrier in the kept
    // range and a newer save after the checkpoint. No product state is seeded.
    const g4 = assets.cases.find((c: any) => c.id === "g4");
    g4.turns.push({ id: "d", text: "What is HTTP 503?" }, { id: "e", text: "Confirm which milestone work remains." });
    const privateObserver = JSON.parse(await readFile(join(repository, "tests/scenarios/guidance-observer.json"), "utf8"));
    privateObserver.cases.find((c: any) => c.id === "g4").controls.push({ afterTurn: "d", action: "rollover", placement: { retireThroughTurn: "c", retainTurns: ["d"] } });
    const paths = { inputs: join(f.dir, "guidance-inputs.json"), observer: join(f.dir, "guidance-observer.json") };
    await writeFile(paths.inputs, JSON.stringify(assets)); await writeFile(paths.observer, JSON.stringify(privateObserver));
    selections.find(s => s.id === "g4")!.assets = paths;
  }
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
    if (key === "g4:a") return n === 0 ? tool("read", { path: "obligations.txt" }) : n === 1 ? tool("nunc_memory_read", {}) : n === 2 ? patch("Milestone obligations in obligations.txt.") : stop();
    if (key === "g4:b") return n === 0 ? tool("nunc_memory_read", {}) : n === 1 ? patch("Pending milestone after side question; see obligations.txt.", true) : stop();
    if (key === "g4:c") return n === 0 ? tool("read", { path: "obligations.txt" }) : n === 1 ? write("pending.json", ["Token rotation", "Rate limiting", "Security regressions"]) : n === 2 ? tool("nunc_memory_read", {}) : n === 3 ? patch("Resumed milestone; remaining obligations in pending.json.", true) : stop();
    if (key === "g5:a") return n === 0 ? write("solution.py", "def double(x): return x + x\n") : stop();
    if (key === "g5:b") return n === 0 ? verify() : stop();
    if (key === "g6:a") return n === 0 ? { ...tool("read", { path: "status.json" }), input: lowUsage ? 900 : 15000 } : stop();
    if (key === "g6:b") return n === 0 ? write("deployed.json", { deployed: true, service: "orders-pipeline" }) : n === 1 ? verify() : stop();
    if (key === "g7:a") {
      if (n === 0) return tool("read", { path: "notes.txt" });
      if (n === 1 || n === 3 && current.variant === "conflict") return tool("nunc_memory_read", {});
      if (n === 2 || n === 4 && current.variant === "conflict") return patch("Deployment checklist: run schema migration; not yet executed.");
      return stop();
    }
    if (key === "g7:b") return n === 0 ? tool("read", { path: "notes.txt" }) : stop();
    if (key === "g8:a") return n === 0 ? tool("read", { path: "lanes.json" }) : n === 1 || n === 3 ? tool("nunc_memory_read", {}) : n === 2 ? patch("Lane rules at lanes.json.") : n === 4 ? patch("Lane rules still pending; source lanes.json.", true) : stop();
    if (key === "g8:b") return n === 0 ? write("count.json", 8) : stop();
    if (key === "g8:c") return n === 0 ? write("routing.json", JSON.parse(current.files["lanes.json"])) : stop();
    return stop();
  };
  const selection: any = { target: { repository, stateRoot: join(f.dir, "nunc-live-guidance"), cleanup: "retain" }, limits: { maxCalls: 160, maxTotalTokens: 24000000, maxDurationMs: 240000, maxOutputTokens: 20000, maxCostUsd: null }, scenarios: selections,
    overrides: [{ requirement: "offline-guidance-mechanics", reason: "Synthetic loopback protocol only; no live model calls", model: { provider, id: model }, config: { nunc: { extraction: { outputTokens: 1024 } }, compaction: { enabled: false, reserveTokens: 36000, keepRecentTokens: 1 }, retentionCalibration: { minFraction: 0.000001, maxFraction: 0.999999 } } },
      { requirement: "split", reason: "Actual automatic native split", scenario: "g6", config: { compaction: { enabled: true } } },
      ...(lowUsage ? [] : ["fits-required", "required-too-large"]).map(variant => ({ requirement: "capacity", reason: "Measured finite memory competition", scenario: `g8/${variant}`, config: { nunc: { memory: { maxTokens: 100 }, extraction: { outputTokens: 1024 } } } }))] };
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
    assert.equal(preflight.report.scenarios.length, selections.length);
    // Scope errors are rejected before any effect and model route stays global.
    const invalid = structuredClone(selection); invalid.overrides.at(-1).scenario = "g8/missing";
    assert.notEqual((await run(["--preflight"], invalid)).code, 0); assert.equal(f.requests.length, 0);
    const nonGemini = structuredClone(selection); nonGemini.overrides[0].model = { provider: "openai-codex", id: "gpt-6-astra" };
    assert.notEqual((await run(["--preflight"], nonGemini)).code, 0); assert.equal(f.requests.length, 0);
    observed = await run([]);
    await writeFile(join(f.dir, "guidance-report.json"), JSON.stringify(observed));
    const segments = observed.report.segments;
    assert.equal(segments.length, selections.length, JSON.stringify(observed.report));
    if (lowUsage) {
      assert.equal(observed.code, 2);
      const g6 = segments[0];
      assert.equal(g6.status, "UNPROVEN"); assert.equal(g6.reason, "PREPARATION");
      const inequality = g6.diagnostic.match(/F=(\d+), H=(\d+)/);
      assert(inequality, g6.diagnostic);
      const caseRoot = join(selection.target.stateRoot, "g6");
      const events = (await Promise.all((await readdir(caseRoot)).filter(p => p.startsWith("events-")).map(p => readFile(join(caseRoot, p), "utf8")))).flatMap(s => s.trim().split("\n").map(line => JSON.parse(line)));
      const usage = events.find(e => e.type === "tool-boundary").data.usage.tokens;
      assert(Number(inequality[1]) > Number(inequality[2]));
      assert(Number(inequality[2]) < usage, "native H must remain below observed U");
      assert.equal(f.requests.length, 1, "no maintenance or suffix/turn-b provider call");
      assert.equal(g6.rollovers.length, 0); assert.equal(g6.maintenance.length, 0);
      assert(!g6.commands.some((c: any) => c.message === scenarios[0].turns[1].text));
      assert(!g6.actions.some((a: any) => a.event.type === "fixture_state" || a.turn === "b"));
      assert.equal(JSON.parse(await readFile(join(caseRoot, "task/status.json"), "utf8")).deployLock, true);
      await assert.rejects(stat(join(caseRoot, "task/deployed.json")));
      assert.deepEqual(observed.report.usage.unreconciledCallIds, []);
      return;
    }
    assert.equal(observed.code, 0, JSON.stringify({ code: observed.code, reason: observed.report?.reason, stderr: observed.stderr }));
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
    const prepared = g6.rollovers[0].prepared;
    assert(prepared.native.trigger < prepared.native.contextTokens);
    const a = prepared.calibration.accounting;
    assert(a.fixedTokens + a.memoryLimit + a.keptTokens + a.growthReserve <= a.effectiveTrigger, "feasible split pays real F/M/K/growth");
    for (const s of segments.filter((s: any) => s.scenario === "g4" || s.scenario === "g8")) {
      assertNativeExtraction(s);
      if (s.scenario === "g4") assert.equal(s.rollovers.length, 2, "post-checkpoint manual revision also reached a second native commit");
    }
    const faults = segments.filter((s: any) => s.scenario === "g7");
    assert.equal(faults[0].score.actionReview[0].status, "PROVEN", JSON.stringify(faults[0]));
    assert.equal(faults[1].score.actionReview[0].status, "PROVEN", JSON.stringify(faults[1]));
    assert(faults[1].actions.some((a: any) => a.event.phase === "save-file-restored"));
    assert.equal((await stat(faults[1].sessionFile)).mode & 0o200, 0o200);
    for (const s of segments.filter((s: any) => s.scenario === "g8")) assert.equal(s.score.actionReview[0].status, "PROVEN", JSON.stringify(s));
  } finally { await f.close({ guidance: observed }); }
}

function assertNativeExtraction(segment: any) {
  const contexts = segment.contexts.filter((c: any) => c.kind === "maintenance");
  assert(contexts.length > 0);
  for (const [i, row] of segment.rollovers.entries()) {
    const context = contexts[i].context;
    const blocks = context.messages[0].content;
    const fmIndex = blocks.findIndex((b: any) => b.type === "text" && readSourceRecords(b.text).some(r => r.source === "F/M"));
    const fm = JSON.parse(blocks[fmIndex].text);
    assert(fm.M.length > 0, "actual extraction contains saved manual M");
    const saved = row.active.filter((e: any) => e.type === "custom" && e.customType === "nunc.memory");
    assert(saved.length > 0, "real memory tools produced native custom entries before freeze");
    assert.equal(checkFullExtraction(row.active, context).status, "PROVEN");
    const stale = saved[0].data.nunc.slots;
    assert.notDeepEqual(stale, fm.M, "fixture exercises a genuinely newer manual revision");
    for (const wrong of [[], stale, [{ id: fm.M[0].id, text: "Wrong actual memory" }]]) {
      const changed = structuredClone(context);
      changed.messages[0].content[fmIndex].text = JSON.stringify({ ...fm, M: wrong });
      assert.equal(checkFullExtraction(row.active, changed).status, "UNPROVEN", "observed stock input does not bless corrupted M");
    }
    for (const region of ["F/M", "B", "K"]) {
      const changed = structuredClone(context);
      changed.messages[0].content = blocks.filter((b: any) => b.type !== "text" || !readSourceRecords(b.text).some(r => r.source === region || r.region === region));
      assert.equal(checkFullExtraction(row.active, changed).status, "UNPROVEN", `missing actual ${region}`);
    }
  }
}

test("guidance public native scenes preserve first/manual revisions, post-checkpoint M, source negatives and feasible split", { timeout: 300000 }, () => guidanceNative());
test("guidance public low-usage split is conditionally infeasible and stops before maintenance, unlock or continuation", { timeout: 60000 }, () => guidanceNative(true));
