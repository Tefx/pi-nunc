import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { repository } from "./fixtures.js";

test("verify-live completes every stable-memory scenario through real loader, HTTP serializer, tools, ledger and native compaction", { timeout: 540000 }, async t => {
  const { StockFixture, text } = await import(join(repository, "scripts/stock-driver.mjs"));
  const f = await new StockFixture().setup({ timeoutMs: 520000 });
  const provider = "openrouter", model = "google/gemini-stable-memory-fixture";
  await writeFile(join(f.state, "agent/models.json"), JSON.stringify({ providers: { [provider]: { baseUrl: f.endpoint, apiKey: "isolated-nunc-fixture", models: [{ id: model, api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 60000, maxTokens: 20000 }] } } }));
  f.limits = { ...f.limits, maxCalls: 160, maxTotalTokens: 12800000 };
  const assets = JSON.parse(await readFile(join(repository, "tests/scenarios/stable-memory-inputs.json"), "utf8"));
  const selections = [{ id: "m1", variant: "fixed" }, { id: "m1", variant: "moving" }, { id: "m2" }, { id: "m3" }, { id: "m4", variant: "keep-0.67" }, { id: "m4", variant: "keep-0.5" }];
  const scenarios = selections.map(s => ({ ...assets.cases.find((c: any) => c.id === s.id), ...s }));
  const selection: any = {
    target: { repository, stateRoot: join(f.dir, "nunc-live-stable-memory"), cleanup: "retain" },
    limits: { maxCalls: 160, maxTotalTokens: 12800000, maxDurationMs: 500000, maxOutputTokens: 20000, maxCostUsd: null }, scenarios: selections,
    overrides: [
      { requirement: "offline-stable-memory-mechanics", reason: "Synthetic loopback protocol only; no model-quality proof or live calls", model: { provider, id: model }, config: { nunc: { extraction: { outputTokens: 1024 } }, compaction: { enabled: true, reserveTokens: 36000, keepRecentTokens: 1 } } },
      { requirement: "provider-wrap", reason: "Recapture transparent provider composition after turn a" },
      { requirement: "stable-memory-bounded-window", reason: "Fixed native 24000 threshold, unchanged q" },
      ...["fixed", "moving"].map(variant => ({ requirement: `cache-${variant}`, reason: "Isolate layout/cache epochs from compaction", scenario: `m1/${variant}`, config: { nunc: { extraction: { outputTokens: 1024 } }, compaction: { enabled: false } } })),
      { requirement: "m2-source-retirement", reason: "Explicitly prepare retired source turns for M-only mechanics; never calibrate m4", scenario: "m2", config: { nunc: { extraction: { outputTokens: 1024 } }, retentionCalibration: { minFraction: 0.001, maxFraction: 0.2 } } },
      ...[0.67, 0.5].map(q => ({ requirement: `explicit-retention-${q}`, reason: "Fixed ratio comparison", scenario: `m4/keep-${q}`, config: { nunc: { rolling: { keepRecentFraction: q }, extraction: { outputTokens: 1024 } } } })),
    ],
  };
  if (process.env.NUNC_LARVA_EXTENSION) selection.overrides.push({ requirement: "stable-memory-larva", reason: "Explicit read-only actual Larva loader composition; task-local sole Nunc compaction owner and manual persona switching", extension: process.env.NUNC_LARVA_EXTENSION, compactionOwner: "nunc" });
  const run = async (args: string[], input = selection) => {
    const child = spawn(process.execPath, [join(repository, "scripts/verify-live.mjs"), ...args], { cwd: repository, env: f.env, stdio: ["pipe", "pipe", "pipe"], signal: t.signal });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
    child.stdin.end(JSON.stringify(input));
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    return { code, stderr, report: stdout ? JSON.parse(stdout) : undefined };
  };
  let scenarioIndex = -1, turn = "", step = 0;
  const tool = (name: string, input: unknown) => ({ tool: { name, input } });
  const write = (path: string, value: unknown) => tool("write", { path, content: JSON.stringify(value) });
  f.response = (row: any, source: any) => {
    if (source) return JSON.stringify({ add: [], remove: [], priority: source.M.map((s: any) => s.id), required: source.M.map((s: any) => s.id) });
    const messages = row.payload.messages;
    const last = messages.at(-1), lastText = text(last);
    // Select task turns from actual delivered user messages, ignoring our own
    // carrier and tool continuations. Matching uses the full fixture prompt.
    const task = [...messages].reverse().find((m: any) => m.role === "user" && scenarios.some(s => s.turns.some((v: any) => v.text === text(m))));
    const taskText = task ? text(task) : "";
    if (taskText === scenarios[scenarioIndex + 1]?.turns[0].text && (turn !== "a" || scenarioIndex < 0 || taskText !== scenarios[scenarioIndex]?.turns[0].text)) { scenarioIndex++; turn = ""; }
    // Fixed/moving have identical first prompts but start a fresh native history.
    else if (turn && taskText === scenarios[scenarioIndex + 1]?.turns[0].text && !messages.some((m: any) => m.role === "assistant")) { scenarioIndex++; turn = ""; }
    const current = scenarios[scenarioIndex];
    assert(current, `Unrecognized first native prompt: ${taskText}`);
    const selectedTurn = current.turns.find((v: any) => v.text === taskText)?.id;
    if (selectedTurn && selectedTurn !== turn) { turn = selectedTurn; step = 0; }
    const n = step++, key = `${current.id}:${turn}`;
    const stop = () => ({ text: "Controlled protocol turn complete. Semantic quality remains untested." });
    const patch = (note?: string, replace = false) => {
      const read = JSON.parse(text(messages.findLast((m: any) => m.role === "tool")));
      assert.equal(typeof read.revision, "string", `Patch must consume real memory-read result: ${lastText}`);
      return tool("nunc_memory_patch", { expectedRevision: read.revision, ...(replace ? { remove: read.slots.map((s: any) => s.id) } : {}), ...(note ? { add: [{ key: "note", text: note }] } : {}) });
    };
    if (["m1:a", "m2:a", "m2:c", "m3:a", "m4:a"].includes(key)) {
      const file = key === "m1:a" ? "brief.txt" : key === "m2:a" ? "lock.txt" : key === "m2:c" ? "lock-correction.txt" : key === "m3:a" ? "note.txt" : "policy.txt";
      if (n === 0) return tool("read", { path: file });
      if (key === "m1:a" && n <= 2) return tool("read", { path: "warmup.txt", offset: n === 1 ? 1 : 301, limit: 300 });
      const offset = key === "m1:a" ? 2 : 0;
      if (n === 1 + offset) return tool("nunc_memory_read", {});
      if (n === 2 + offset) return patch(key === "m2:a" ? "unlock-code: cedar-17" : key === "m2:c" ? "unlock-code: maple-29" : key === "m1:a" ? "project: orchard-router" : key === "m4:a" ? "Node 20 remains required" : "Continuing composition constraint", key === "m2:c");
      return stop();
    }
    if (key === "m1:e" || key === "m2:e") {
      if (n === 0) return tool("nunc_memory_read", {});
      if (n === 1) return key === "m2:e" ? patch(undefined, true) : patch("retry budget: two attempts");
      return stop();
    }
    if (key.startsWith("m4:load")) {
      const batch = Number(turn.slice(4));
      if (n === 0) return tool("read", { path: "scratch.txt" });
      if (n === 1) return write(`batch-${batch}.json`, { batch, lines: 145 });
      return stop();
    }
    const files: Record<string, [string, unknown]> = {
      "m1:b": ["round-b.json", { n: 1 }], "m1:c": ["round-c.json", { n: 2 }], "m1:d": ["round-d.json", { n: 3 }], "m1:f": ["round-f.json", { n: 4 }], "m1:g": ["status.json", { project: "orchard-router", retries: 2 }], "m1:h": ["done.json", { done: true }],
      "m2:b": ["waiting.json", { status: "pending" }], "m2:b2": ["initial.json", { code: "cedar-17" }], "m2:d": ["waiting2.json", { status: "ready" }], "m2:d2": ["corrected.json", { code: "maple-29" }], "m2:e2": ["deleted-wait.json", { waiting: true }], "m2:f": ["unlock.json", { code: null }],
      "m3:b": ["composed.json", { status: "ready" }], "m4:e": ["kept.json", { nodeMajor: 20 }],
    };
    assert(files[key], `Unexecuted fixture branch ${key}`);
    if (n === 0) return write(...files[key]!);
    return stop();
  };
  try {
    const preflight = await run(["--preflight"]);
    assert.equal(preflight.code, 0, JSON.stringify(preflight));
    const astra = structuredClone(selection); astra.overrides[0].model = { provider: "openai-codex", id: "gpt-6-astra" };
    assert.notEqual((await run(["--preflight"], astra)).code, 0);
    const invalidOwner = structuredClone(selection);
    invalidOwner.overrides = invalidOwner.overrides.filter((o: any) => o.requirement !== "stable-memory-larva");
    invalidOwner.overrides.push({ requirement: "stable-memory-larva", reason: "invalid owner must fail before setup", extension: "/not-loaded/larva.ts", compactionOwner: "larva" });
    const rejectedOwner = await run(["--preflight"], invalidOwner);
    assert.notEqual(rejectedOwner.code, 0);
    assert.equal(JSON.parse(rejectedOwner.stderr).code, "OVERRIDE");
    const observed = await run([]);
    await writeFile(join(f.dir, "native-test-report.json"), JSON.stringify({ ...observed, fixtureError: f.error?.message }, null, 2));
    t.diagnostic(`Native controlled artifacts: ${f.dir}`);
    assert.equal(observed.code, 0, JSON.stringify({ code: observed.code, reason: observed.report?.reason, segments: observed.report?.segments?.map((s: any) => ({ scenario: s.scenario, reason: s.reason, diagnostic: s.diagnostic, checks: s.prerequisites?.filter((p: any) => p.status !== "PROVEN") })), stderr: observed.stderr }));
    const segments = observed.report.segments;
    assert.equal(segments.length, selections.length);
    assert.equal(scenarioIndex, selections.length - 1);
    for (const [i, segment] of segments.entries()) {
      assert.equal(segment.status, "OBSERVED");
      assert.equal(segment.nextTurn, scenarios[i].turns.length);
      assert(segment.layouts.length >= scenarios[i].turns.length);
      assert(segment.layouts.some((r: any) => r.memoryPresent === true));
      for (const layout of segment.layouts) {
        assert.equal(layout.deliveredMemoryMatches, true);
        assert.equal(layout.payloadSyntheticMissing, false);
        assert.equal(typeof layout.input, "number");
        const request = segment.requests.find((r: any) => r.callId === layout.callId);
        assert(request?.finalPayload);
      }
      assert(segment.score.checks.some((c: any) => c.status === "UNPROVEN"), "Controlled mechanics must leave semantic scoring to the downstream observer");
      if (process.env.NUNC_LARVA_EXTENSION) {
        const setting = segment.actions.find((r: any) => r.event?.phase === "larva-compaction-owner")?.event;
        assert.equal(setting?.valid, true);
        assert.equal(setting?.enabled, false);
        assert.equal(setting?.scope, "isolated-task-child");
        assert(setting.configFile.startsWith(selection.target.stateRoot + "/"));
        assert.deepEqual(JSON.parse(await readFile(setting.configFile, "utf8")), { enabled: false });
        assert(segment.requests.filter((r: any) => r.kind === "main").every((r: any) => r.admission?.resolution === "resolved"));
      }
      for (const rollover of segment.rollovers ?? []) {
        assert.equal(rollover.callIds.length, 1, "one successful Nunc extraction; no competing Larva maintenance call");
        assert.equal(rollover.result?.ok, true);
        assert.equal(rollover.snapshot?.summary, rollover.result.candidate.summary);
        assert.equal(rollover.snapshot?.firstKeptEntryId, rollover.result.candidate.firstKeptEntryId);
        assert.deepEqual(rollover.snapshot?.details?.nunc, rollover.result.candidate.memory);
      }
      if (segment.scenario === "m2") {
        assert.equal(segment.prerequisites.filter((p: any) => p.check.startsWith("M-only") && p.status === "PROVEN").length, 6);
        assert.deepEqual(segment.artifactSnapshots, { "initial.json": { code: "cedar-17" }, "corrected.json": { code: "maple-29" } });
        assert.deepEqual(segment.score.artifacts["unlock.json"], { code: null });
      }
      if (segment.scenario === "m4") {
        assert(segment.rolloverSeries.length >= 3);
        assert(segment.rolloverSeries.every((r: any) => r.reason === "threshold" && typeof r.releasedInput === "number"));
        assert.equal(segment.calibrations.length, 0);
        assert(segment.segmentUsage.calls > segment.layouts.length, "Combined cost inventory includes real maintenance calls");
      }
    }
    assert(f.requests.some((r: any) => r.kind === "maintenance"));
    assert(f.requests.length <= 160, "The complete mechanical workload must fit the accepted live call ceiling");
  } finally { await f.close(); }
});
