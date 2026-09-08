import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { comparisonStock, compareCli } from "./comparison-native-fixture.js";

// Synthetic executable/effect fixtures test authorization, never task-model quality.
test("stock CLI/worker rejects absent, unprovided, modified and concurrently written scripts before private reads or effects; original verification and recovery run", { timeout: 120000 }, async () => {
  for (const provided of [false, true]) {
    const f = await comparisonStock();
    const tag = provided ? "script-provided" : "script-unprovided";
    try {
      const sentinels = ["oracle", "future-input", "old-fixture"].map(name => ({ path: join(f.dir, `${name}.txt`), value: `PRIVATE-${name}-${tag}` }));
      for (const s of sentinels) await writeFile(s.path, s.value);
      const effect = join(f.dir, "unexpected-script-effect");
      const rewritten = `from pathlib import Path\nfor p in ${JSON.stringify(sentinels.map(s => s.path))}:\n print(Path(p).read_text())\nPath(${JSON.stringify(effect)}).write_text('executed')\n`;
      const original = "import json\nfrom pathlib import Path\na=json.loads(Path('product.json').read_text())\nassert a == {'value': 7}\nPath('verified.json').write_text(json.dumps({'artifact':'product.json','passed':True}))\n";
      const inputs = join(f.dir, "script-inputs.json"), observer = join(f.dir, "script-observer.json");
      await writeFile(inputs, JSON.stringify({ formatVersion: 1, cases: [{ id: "c2", files: provided ? { "verify.py": original } : {}, turns: [{ id: "a", text: "Exercise the local file operations." }, { id: "b", text: "End the controlled file operation check." }] }] }));
      await writeFile(observer, JSON.stringify({ formatVersion: 1, inputs: "inputs.json", visibility: "runner-and-observer-only", cases: [{ id: "c2", controls: [{ afterTurn: "b", action: "rollover", placement: { retireThroughTurn: "a", retainTurns: ["b"] } }], setupChecks: [], artifactChecks: [], actionChecks: [] }] }));
      const write = (path: string, content: string) => ({ tool: { name: "write", input: { path, content } } });
      const verify = { tool: { name: "bash", input: { command: "python3 verify.py" } } };
      const note = write("notes.txt", "Ordinary recovery note.");
      const read = { tool: { name: "read", input: { path: "notes.txt" } } };
      const replies = provided ? [verify, write("verify.py", rewritten), verify, write("verify.py", original),
        { tools: [write("verify.py", rewritten).tool, verify.tool] }, write("verify.py", original), verify, note, read,
        write("product.json", '{"value":7}'), verify, "Finished controlled operations."] :
        [verify, write("verify.py", rewritten), verify, note, read, "Finished controlled operations."];
      let step = 0, groupIndex = -1;
      f.response = (row: any, source: any) => {
        const text = (m: any) => typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        if (source) return JSON.stringify({ add: [], remove: source.M.map((s: any) => s.id), priority: [], ...(JSON.stringify(row.payload).includes("four required fields") ? { required: [] } : {}) });
        if (row.payload.messages.some((m: any) => text(m).includes("<conversation>"))) return "Controlled file-operation fixture finished.";
        const last = row.payload.messages.at(-1);
        if (last?.role === "user" && text(last).includes("End the controlled")) return "File operation check ended.";
        if (last?.role === "user") {
          step = 0; groupIndex++;
          if (provided) {
            // Simulate a missing seeded executable, before any tool execution.
            const group = ["native", "current", "candidate"][groupIndex];
            unlinkSync(join(f.dir, `nunc-live-${tag}`, `defaults-${group}-c2`, "task/verify.py"));
          }
        }
        return replies[step++]!;
      };
      const { code, report, stderr } = await compareCli(f, [{ id: "c2", assets: { inputs, observer } }], ["defaults"], tag);
      assert.equal(code, 0, JSON.stringify({ stderr, reason: report?.reason, matrix: report?.matrix }));
      assert.equal(groupIndex, 2);
      assert.equal(existsSync(effect), false, "no unauthorized script effect");
      for (const s of sentinels) {
        assert.equal(JSON.stringify(f.requests).includes(s.value), false, "private content never reached a provider");
        assert.equal(JSON.stringify(report.rawSegments.map((s: any) => s.actions)).includes(s.value), false, "private content never returned from a tool");
      }
      for (const segment of report.rawSegments) {
        const actions = segment.actions.map((a: any) => a.event);
        const blocked = actions.filter((a: any) => a.type === "tool_blocked");
        assert.equal(blocked.length, provided ? 3 : 2);
        if (provided) {
          assert.match(blocked[0].reason, /missing/);
          assert.match(blocked[1].reason, /modified/);
          assert.match(blocked[2].reason, /same tool batch/);
          const invoked = actions.filter((a: any) => a.type === "tool_call" && a.toolName === "bash");
          assert.equal(invoked.length, 2, "only unchanged originals were executed");
          const results = invoked.map((a: any) => actions.find((r: any) => r.type === "tool_result" && r.toolCallId === a.toolCallId));
          assert.equal(results[0].isError, true, "legitimate verification failure remains repairable");
          assert.equal(results[1].isError, false);
          assert.deepEqual(results[1].verification, { scriptUnchanged: true, artifact: { artifact: "product.json", passed: true } });
        } else {
          assert(blocked.every((a: any) => /No fixture verification script was provided/.test(a.reason)));
          assert.equal(actions.filter((a: any) => a.type === "tool_call" && a.toolName === "bash").length, 0);
        }
        assert(actions.some((a: any) => a.type === "tool_result" && a.toolName === "read" && !a.isError && JSON.stringify(a.content).includes("Ordinary recovery note.")));
      }
      assert.equal(report.usage.calls, f.requests.length);
      assert.deepEqual(report.usage.unreconciledCallIds, []);
    } finally { await f.close({ tag }); }
  }
});
