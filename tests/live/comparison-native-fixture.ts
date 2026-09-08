import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { repository } from "./fixtures.js";

/** Protocol fixtures execute tools and native scheduling; generated content makes no model-quality claim. */
export async function comparisonStock(options: { e3?: "single" | "siblings" | "failed" | "small" | "wrong" | "maintenance-failure" | "long-suffix" | "low-native" | "repeat-threshold" | "restart-threshold"; tooLarge?: boolean; earlyVerify?: boolean; invalidCapacity?: boolean } = {}) {
  const { StockFixture, text } = await import(join(repository, "scripts/stock-driver.mjs"));
  const f = await new StockFixture().setup({ compaction: { enabled: false, reserveTokens: 36000, keepRecentTokens: 1 }, timeoutMs: 300000 });
  f.limits = { ...f.limits, maxCalls: 300, maxTotalTokens: 24000000 }; // Five selections × three groups × two modes, including tool continuations.
  const suite = JSON.parse(await readFile(join(repository, "tests/scenarios/extraction-inputs.json"), "utf8"));
  const turns = suite.cases.flatMap((c: any) => c.turns.map((t: any) => ({ scenario: c.id, ...t })));
  let current: { scenario: string; id: string } | undefined, step = 0;
  const write = (path: string, value: unknown) => ({ tool: { name: "write", input: { path, content: typeof value === "string" ? value : JSON.stringify(value) } } });
  const verify = { tool: { name: "bash", input: { command: "python3 verify.py" } } };
  const lanes = Object.fromEntries([...suite.cases.find((c: any) => c.id === "e4").turns[0].text.matchAll(/(amber|birch|cedar|dune|elm|fir|grove|heath): (-?\d+), (\d+), (true|false), '([^']+)'/g)].map((m: any) => [m[1], { maxC: Number(m[2]), holdMinutes: Number(m[3]), fallbackAllowed: m[4] === "true", condition: m[5] }]));
  f.response = (row: any, source: any) => {
    const messages = row.payload.messages ?? row.payload.input ?? [], last = messages.at(-1);
    const serialized = messages.some((m: any) => text(m).includes("<conversation>"));
    if (serialized && current?.scenario === "e3" && options.e3 === "maintenance-failure") return { status: 503, message: "Controlled failure" };
    if (serialized) return "## Goal\nContinue the authorized local task.\n\n## Progress\nThe preceding ordinary turns completed. Preserve the remaining work and original restrictions.\n\n## Next Steps\nContinue only when the ordinary user turn authorizes it.\n\n## Critical Context\nThe task files remain available through the ordinary file tools. This controlled summary exercises the stock serializer and carries no quality claim.";
    if (source) {
      if (current?.scenario === "e4" && options.invalidCapacity) return "Incomplete capacity response";
      if (current?.scenario === "e3" && options.e3 === "maintenance-failure") return { status: 503, message: "Controlled failure" };
      const required = JSON.stringify(row.payload).includes("four required fields");
      const add = current?.scenario === "e4" ? [{ key: "req", text: "n".repeat(options.tooLarge ? 1000 : 240) }, { key: "extra", text: "x".repeat(200) }, { key: "opt", text: "o" }] : [{ key: "note", text: "Controlled protocol note." }];
      const priority = current?.scenario === "e4" ? ["opt", "extra", "req"] : ["note"];
      return JSON.stringify({ add, remove: source.M.map((s: any) => s.id), priority, ...(required ? { required: [add[0]!.key] } : {}) });
    }
    if (last?.role === "user") { const selected = turns.find((t: any) => t.text === text(last)); if (selected) { current = selected; step = 0; } }
    const key = `${current?.scenario}:${current?.id}`, n = step++;
    if (key === "e1:a") return n === 0 ? { tool: { name: "read", input: { path: "rows.json" } } } : "Input inspected.";
    if (key === "e1:b") return n === 0 ? write("units.txt", "KiB is 1024 bytes; kB is 1000 bytes.") : "Written.";
    if (key === "e1:c") return n === 0 ? write("export.json", { records: [1, null, 3], retryLimit: 2, retryAfterCommit: false }) : n === 1 && options.earlyVerify ? verify : "Draft only.";
    if (key === "e1:d") return n === 0 ? write("seconds.json", 420) : "Written.";
    if (key === "e1:e") return n === 0 ? verify : n === 1 ? write("handoff.json", { implemented: true, verified: true, accepted: false, publishAllowed: false, artifact: "export.json", wait: "User acceptance pending" }) : "Handoff written.";
    if (key === "e2:b") return n === 0 ? write("count.json", 14) : "Written.";
    if (key === "e2:c") return n === 0 ? { tool: { name: "read", input: { path: "probe.json" } } } : "Probe observed; east pending.";
    if (key === "e2:d") return n === 0 ? write("note.txt", "UTC is a time standard.") : "Written.";
    if (key === "e2:e") return n === 0 ? write("east.json", { route: "direct", timeoutMs: 650, crossTenantSharing: false, reason: "Probe excludes cache sharing." }) : "Written.";
    if (key === "e3:a") {
      if (n > 0) {
        if (["long-suffix", "low-native", "repeat-threshold"].includes(options.e3 ?? "")) {
          const response = n === 1 ? { tool: { name: "read", input: { path: "drafts/export-v2.json" } } } : n === 2 ? write("notes.txt", "Draft inspected; awaiting permission.") : n === 3 ? { tool: { name: "read", input: { path: "notes.txt" } } } : { text: "Draft remains pending." };
          return { ...response, input: options.e3 === "repeat-threshold" ? 30000 : 20000 };
        }
        return { text: "Draft remains pending.", input: 2000 };
      }
      const input = options.e3 === "failed" ? { path: "investigation.json", offset: 100 } : { path: options.e3 === "wrong" ? "drafts/export-v2.json" : "investigation.json" };
      return { input: options.e3 === "small" ? 200 : options.e3 === "low-native" ? 900 : 15000, tools: [{ name: "read", input }, ...(options.e3 === "siblings" ? [{ name: "read", input: { path: "drafts/export-v2.json" } }] : [])] };
    }
    if (key === "e3:b") return n === 0 ? write("ready.json", { route: "stream", records: [9, null, 4], status: "ready" }) : n === 1 ? verify : { text: "Ready checked.", input: options.e3 === "restart-threshold" ? 30000 : 2000 };
    if (key === "e4:b") return n === 0 ? write("sum.json", 42) : "Written.";
    if (key === "e4:c") return n === 0 ? write("routing.json", lanes) : "Written.";
    return "Understood; awaiting continuation.";
  };
  await writeFile(join(f.state, "agent/settings.json"), JSON.stringify({ ...f.settings, defaultProvider: f.provider, defaultModel: f.modelId }));
  return f;
}
export async function compareCli(f: any, scenarios: unknown[], modes: string[], tag: string) {
  const stateRoot = join(f.dir, `nunc-live-${tag}`);
  const selection = { target: { repository, stateRoot, cleanup: "remove" }, limits: { maxCalls: 300, maxTotalTokens: 24000000, maxDurationMs: 240000, maxOutputTokens: 20000, maxCostUsd: null }, observations: ["stock_rpc"], scenarios,
    overrides: [{ requirement: "controlled-extraction-observation", reason: "Named isolated loopback native scheduling and measured retention", config: { nunc: { memory: { maxTokens: 100 }, extraction: { outputTokens: 1024 } }, compaction: { enabled: false, reserveTokens: 36000, keepRecentTokens: 1 }, retentionCalibration: { minFraction: 0.000001, maxFraction: 0.999999 } } }],
    comparison: { modes, targets: { native: { repository }, current: { repository: join(repository, ".scratch/baseline-70dacad") }, candidate: { repository } } } };
  const child = spawn(process.execPath, [join(repository, "scripts/compare-extraction.mjs")], { cwd: repository, env: f.env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", b => { stdout += b; if (stdout.length > 64000000) child.kill("SIGTERM"); });
  child.stderr.on("data", b => { stderr += b; });
  child.stdin.end(JSON.stringify(selection));
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  const report = stdout ? JSON.parse(stdout) : undefined;
  await writeFile(join(f.dir, `${tag}-report.json`), JSON.stringify({ code, stderr, report }, null, 2));
  return { code, stderr, report, stateRoot };
}
