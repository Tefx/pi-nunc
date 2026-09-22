import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { repository } from "./fixtures.js";
import { loadScenario } from "../../src/live/scenarios.js";

test("public comparison binds explicit pre-change ref and executes scoped-task hosts in both modes", { timeout: 160000 }, async () => {
  const { StockFixture, text } = await import(join(repository, "scripts/stock-driver.mjs"));
  const f = await new StockFixture().setup({ timeoutMs: 150000 });
  const model = { id: "openai/gpt-5.6-luna", api: "openai-completions", reasoning: true, input: ["text"], contextWindow: 60000, maxTokens: 20000 };
  await writeFile(join(f.state, "agent/models.json"), JSON.stringify({ providers: { openrouter: { baseUrl: f.endpoint, apiKey: "isolated-nunc-fixture", models: [model] } } }));
  const config = { nunc: { extraction: { outputTokens: 1024 } }, compaction: { enabled: false, reserveTokens: 36000, keepRecentTokens: 1 }, retentionCalibration: { minFraction: 0.000001, maxFraction: 0.999999 } };
  const scenario = (await loadScenario(repository, { id: "g3", variant: "scoped-tasks", config })).input;
  const selection = { target: { repository, stateRoot: join(f.dir, "nunc-live-compare"), cleanup: "retain" },
    limits: { maxCalls: 120, maxTotalTokens: 9600000, maxOutputTokens: 20000, maxDurationMs: 140000, maxCostUsd: null }, observations: ["stock_rpc"], scenarios: [{ id: "g3", variant: "scoped-tasks" }],
    overrides: [{ requirement: "task-retention-luna", reason: "Controlled comparison with explicit isolated model/config", model: { provider: "openrouter", id: model.id }, thinking: "low", config }, { requirement: "maintenance-thinking", reason: "Observe actual low serialization", maintenanceThinking: "low" }],
    comparison: { modes: ["defaults", "matched"], targets: { native: { repository }, current: { repository: join(repository, ".scratch/prechange"), ref: "refs/nunc/task-retention-pre-change" }, candidate: { repository } } } };
  let turn = "", step = 0;
  f.limits.maxCalls = 120; f.limits.maxTotalTokens = 9600000;
  const tool = (name: string, input: any) => ({ tool: { name, input } });
  f.response = (row: any, source: any) => {
    assert.equal(row.payload.reasoning?.effort ?? row.payload.reasoning_effort, "low");
    if (source) return JSON.stringify({ add: [{ key: "note", text: "Continue the remaining local service draft." }], remove: source.M.map((s: any) => s.id), priority: ["note"], required: ["note"] });
    if (row.payload.messages.some((m: any) => text(m).includes("<conversation>"))) return "## Goal\nFinish remaining local service draft.\n## Progress\nArchive arithmetic completed; west cancelled; east remains pending.\n## Constraints\nUse sqlite, no sharing. No startup or network. Respect the scoped east revision.\n## Next Steps\nAfter the side question, continue remaining work using current source evidence.";
    const last = row.payload.messages.filter((m: any) => !text(m).startsWith("Nunc working memory (session-local")).at(-1);
    const request = last?.role === "user" && scenario.turns.find(t => t.text === text(last));
    if (request && request.id !== turn) { turn = request.id; step = 0; }
    const n = step++;
    if (turn === "a") return [tool("read", { path: "TASK.md" }), tool("read", { path: "archive.json" }), tool("write", { path: "closeout.json", content: '{"netUnits":13}' }), "Archive done; service drafts remain pending."][n];
    if (turn === "d" && n === 0) return tool("write", { path: "east.json", content: '{"port":9090,"timeoutMs":650,"database":"sqlite","crossTenantSharing":false}' });
    return "Controlled turn ended.";
  };
  const run = async (input: any, preflight: boolean) => {
    const child = spawn(process.execPath, [join(repository, "scripts/compare-extraction.mjs"), ...(preflight ? ["--preflight"] : [])], { cwd: repository, env: f.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; }); child.stdin.end(JSON.stringify(input));
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    return { code, stderr, report: stdout ? JSON.parse(stdout) : undefined };
  };
  try {
    const preflight = await run(selection, true);
    assert.equal(preflight.code, 0, JSON.stringify(preflight)); assert.equal(f.requests.length, 0);
    assert.equal(preflight.report.receipt.callsMade, 0);
    await assert.rejects(stat(selection.target.stateRoot));
    const wrong = structuredClone(selection); wrong.comparison.targets.current.ref = "HEAD";
    assert.notEqual((await run(wrong, true)).code, 0, "unrelated current HEAD cannot masquerade as declared prechange");
    assert.equal(f.requests.length, 0);
    const result = await run(selection, false);
    await writeFile(join(f.dir, "comparison-result.json"), JSON.stringify(result));
    assert.equal(result.code, 0, JSON.stringify({ code: result.code, reason: result.report?.reason, matrix: result.report?.matrix?.map((m: any) => ({ group: m.group, status: m.status, reason: m.reason })) }));
    assert.equal(result.report.matrix.length, 6);
    const expected = execFileSync("/usr/bin/git", ["-C", repository, "rev-parse", "refs/nunc/task-retention-pre-change"], { encoding: "utf8", env: { ...process.env, DEVELOPER_DIR: "/Library/Developer/CommandLineTools" } }).trim();
    for (const mode of result.report.comparison.modes) {
      assert.equal(mode.groups.current.revision, expected);
      assert.notEqual(mode.groups.current.revision, mode.groups.candidate.revision);
    }
    assert.equal(result.report.usage.calls, f.requests.length);
    assert.deepEqual(result.report.usage.unreconciledCallIds, []);
    for (const segment of result.report.rawSegments) {
      assert.equal(segment.nextTurn, 4); assert.equal(segment.rollovers.length, 2);
      assert.equal(segment.score.actionReview.find((c: any) => c.check === "scoped-artifacts").status, "PROVEN");
    }
  } finally { await f.close(); }
});
