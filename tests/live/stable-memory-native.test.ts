import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { repository } from "./fixtures.js";

test("verify-live executes m1/m2/m3/m4 controlled seams and binds layout to each request's admission and usage", { timeout: 280000 }, async () => {
  const { StockFixture, text } = await import(join(repository, "scripts/stock-driver.mjs"));
  const f = await new StockFixture().setup({ timeoutMs: 260000 });
  const provider = "openrouter", model = "google/gemini-stable-memory-fixture";
  await writeFile(join(f.state, "agent/models.json"), JSON.stringify({ providers: { [provider]: { baseUrl: f.endpoint, apiKey: "isolated-nunc-fixture", models: [{ id: model, api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 60000, maxTokens: 20000 }] } } }));
  f.limits = { ...f.limits, maxCalls: 120, maxTotalTokens: 18000000 };
  const assets = JSON.parse(await readFile(join(repository, "tests/scenarios/stable-memory-inputs.json"), "utf8"));
  const selections = [{ id: "m1", variant: "fixed" }, { id: "m2" }, { id: "m3" }, { id: "m4", variant: "keep-0.5" }];
  const scenarios = selections.map(s => ({ ...assets.cases.find((c: any) => c.id === s.id), ...s }));
  const selection: any = {
    target: { repository, stateRoot: join(f.dir, "nunc-live-stable-memory"), cleanup: "retain" },
    limits: { maxCalls: 120, maxTotalTokens: 18000000, maxDurationMs: 240000, maxOutputTokens: 20000, maxCostUsd: null },
    scenarios: selections,
    overrides: [
      { requirement: "offline-stable-memory-mechanics", reason: "Synthetic loopback protocol only; no live model calls", model: { provider, id: model }, config: { nunc: { extraction: { outputTokens: 1024 } }, compaction: { enabled: true, reserveTokens: 36000, keepRecentTokens: 1 } } },
      { requirement: "payload-append", reason: "m3 composes the tracked last-user append with Nunc and the observer" },
      { requirement: "explicit-retention-0.5", reason: "m4 requires an explicit keepRecentFraction", scenario: "m4/keep-0.5", config: { nunc: { rolling: { keepRecentFraction: 0.5 }, extraction: { outputTokens: 1024 } } } },
    ],
  };
  const run = async (args: string[], input = selection) => {
    const child = spawn(process.execPath, [join(repository, "scripts/verify-live.mjs"), ...args], { cwd: repository, env: f.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
    child.stdin.end(JSON.stringify(input));
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    return { code, stderr, report: stdout ? JSON.parse(stdout) : undefined };
  };
  let scenarioIndex = -1, turn = "", step = 0, finished = true;
  const tool = (name: string, input: unknown) => ({ tool: { name, input } });
  const write = (path: string, value: unknown) => tool("write", { path, content: typeof value === "string" ? value : JSON.stringify(value) });
  f.response = (row: any, source: any) => {
    if (source) return JSON.stringify({ add: [{ key: "task", text: "Continuing constraint." }], remove: source.M.map((s: any) => s.id), priority: ["task"], required: ["task"] });
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
    const patch = (note: string, remove = false) => {
      let read: any = {};
      try { read = JSON.parse(lastText); } catch { /* tool result may wrap JSON */ }
      if (remove) return tool("nunc_memory_patch", { expectedRevision: read.revision, remove: (read.slots ?? []).map((s: any) => s.id) });
      return tool("nunc_memory_patch", { expectedRevision: read.revision, add: [{ key: "note", text: note }] });
    };
    if (key === "m1:a" || key === "m2:a" || key === "m2:c" || key === "m3:a" || key === "m4:a") {
      if (n === 0) return tool("read", { path: key === "m1:a" ? "brief.txt" : key === "m2:a" ? "lock.txt" : key === "m2:c" ? "lock-correction.txt" : key === "m3:a" ? "note.txt" : "policy.txt" });
      if (n === 1) return tool("nunc_memory_read", {});
      if (n === 2) return patch(key === "m2:c" ? "corrected" : "saved");
      return stop();
    }
    if (key === "m1:e" || key === "m2:e") {
      if (n === 0) return tool("nunc_memory_read", {});
      if (n === 1) return key === "m2:e" ? patch("", true) : patch("retry two");
      return stop();
    }
    if (key?.startsWith("m1:") || key?.startsWith("m2:") || key?.startsWith("m3:") || key?.startsWith("m4:")) {
      const files: Record<string, [string, unknown]> = {
        "m1:b": ["round-b.json", { n: 1 }], "m1:c": ["round-c.json", { n: 2 }], "m1:d": ["round-d.json", { n: 3 }], "m1:f": ["round-f.json", { n: 4 }], "m1:g": ["status.json", { project: "unknown", retries: 2 }],
        "m2:b": ["waiting.json", { status: "pending" }], "m2:d": ["waiting2.json", { status: "ready" }], "m2:f": ["unlock.json", { code: null }],
        "m3:b": ["composed.json", { status: "ready" }],
        "m4:b": ["sum.json", { value: 46 }], "m4:c": ["product.json", { value: 104 }], "m4:d": ["difference.json", { value: 63 }], "m4:e": ["kept.json", { nodeMajor: 20 }],
      };
      const file = files[key];
      if (file && n === 0) return write(file[0] as string, file[1]);
      return stop();
    }
    return stop();
  };
  try {
    const preflight = await run(["--preflight"]);
    assert.equal(preflight.code, 0, JSON.stringify(preflight));
    const astra = structuredClone(selection);
    astra.overrides[0].model = { provider: "openai-codex", id: "gpt-6-astra" };
    assert.notEqual((await run(["--preflight"], astra)).code, 0);
    const observed = await run([]);
    assert(observed.report, JSON.stringify({ code: observed.code, stderr: observed.stderr }));
    const segments = observed.report.segments ?? [];
    assert.equal(segments.length, selections.length, JSON.stringify({ reason: observed.report.reason, stderr: observed.stderr }));
    for (const segment of segments) {
      assert(Array.isArray(segment.layouts) || segment.status === "UNPROVEN" || segment.status === "STOPPED", JSON.stringify(segment));
      for (const layout of segment.layouts ?? []) {
        if (layout.callId !== undefined) assert((segment.requests ?? []).some((r: any) => r.callId === layout.callId));
      }
    }
  } finally {
    await f.close();
  }
});
