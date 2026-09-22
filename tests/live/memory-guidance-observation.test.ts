import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadScenario, scoreArtifacts, seedScenario, type CheckResult } from "../../src/live/scenarios.js";
import { scoreGuidance, TOOLS_CHECK, SPLIT_CHECK, type GuidanceAction } from "../../src/live/guidance.js";
import { repository } from "./fixtures.js";
import { checkRequiredRetention } from "../../src/live/capacity-observation.js";
import type { Selection } from "../../src/live/contract.js";

const config = { nunc: {}, compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 4000 } };
const exposed: CheckResult[] = [{ check: TOOLS_CHECK, status: "PROVEN" }];
const split: CheckResult[] = [...exposed, { check: SPLIT_CHECK, status: "PROVEN" }, { check: "deployment lock cleared in task fixture before turn b", status: "PROVEN" }];
const call = (turn: string, toolName: string, input: unknown, toolCallId = "c"): GuidanceAction => ({ turn, event: { type: "tool_call", toolName, input, toolCallId } });
const response = (c: GuidanceAction, details: unknown = {}, isError: boolean | undefined = false): GuidanceAction => ({ turn: c.turn!, event: { type: "tool_result", toolName: c.event.toolName, toolCallId: c.event.toolCallId, details, isError } });
const terminal = (turn: string): GuidanceAction => ({ turn, event: { type: "turn_complete", stopReason: "stop" } });
const score = (id: string, check: string, actions: GuidanceAction[], prerequisites = exposed, cwd = repository) => scoreGuidance(id, check, actions, prerequisites, cwd);
const state = (turn: string, text: string, revision = "new"): GuidanceAction => ({ turn, event: { type: "memory_state", revision, unconfirmed: false, slots: text ? [{ id: "s1", text }] : [] } });

test("guidance assets seed task inputs without private observer or future-turn files", async () => {
  const dir = join(repository, ".scratch", `guidance-assets-${Date.now()}`);
  try {
    for (const selection of [{ id: "g1" }, { id: "g2" }, { id: "g3" }, { id: "g4" }, { id: "g5" }, { id: "g6" }, { id: "g7", variant: "conflict" }, { id: "g7", variant: "unconfirmed" }, { id: "g8", variant: "fits-required" }, { id: "g8", variant: "required-too-large" }] as const) {
      const { input } = await loadScenario(repository, { ...selection, config });
      const cwd = join(dir, `${selection.id}-${"variant" in selection ? selection.variant : "base"}`);
      await seedScenario(input, cwd);
      assert.deepEqual((await readdir(cwd)).sort(), Object.keys(input.files).sort());
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("complete-task variants load and seed only task files, with independent observer checks", async () => {
  const dir = join(repository, ".scratch", `task-retention-assets-${Date.now()}`);
  try {
    for (const [id, variant] of [["g4", "task-file"], ["g4", "active-edit"], ["g3", "scoped-tasks"]] as const) {
      const selection: Selection = { id, variant, config };
      const { input, observer } = await loadScenario(repository, selection);
      const cwd = join(dir, `${id}-${variant}`);
      await seedScenario(input, cwd);
      assert.deepEqual((await readdir(cwd)).sort(), Object.keys(input.files).sort());
      for (const [path, contents] of Object.entries(input.files)) {
        assert.equal(await readFile(join(cwd, path), "utf8"), contents);
      }
      assert(observer.artifactChecks.length > 0);
      // A seeded workspace has no completed artifact. It cannot pass merely
      // because scenario data is valid or a future turn asks for completion.
      const result = await scoreArtifacts(cwd, observer, exposed);
      for (const [index, check] of result.checks.entries()) assert.equal(check.status, observer.artifactChecks[index]!.operator === "semantic" ? "UNPROVEN" : "DISPROVEN");
      assert(result.actionReview.every(check => check.status === "UNPROVEN"));
      await writeFile(join(cwd, "handoff.json"), '{"complete":true,"verified":true}');
      const claimed = await scoreArtifacts(cwd, observer, exposed, { actions: [terminal("d")], fixtures: Object.fromEntries(Object.entries(input.files).filter(([name]) => name !== "solution.py")) });
      assert.equal(claimed.actionReview.find(check => check.check === (id === "g4" ? "metrics-artifact" : "scoped-artifacts"))?.status, "DISPROVEN", "Self-reported success cannot replace executable final artifacts");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("g1 and unknown checks cannot prove missing observations", () => {
  assert.equal(score("g1", "routine-no-memory", []).status, "UNPROVEN");
  assert.equal(score("g1", "routine-no-memory", [terminal("a")], []).status, "UNPROVEN");
  assert.equal(score("g1", "routine-no-memory", [terminal("a")]).status, "PROVEN");
  assert.equal(score("g1", "routine-no-memory", [call("a", "nunc_memory_read", {})]).status, "DISPROVEN");
  assert.equal(score("g7", "misspelled-check", [terminal("a")]).status, "UNPROVEN");
});

test("g2/g3 distinguish calls, real saves and unavailable semantic evidence without prose heuristics", () => {
  for (const [id, check, turn] of [["g2", "decision-save", "a"], ["g3", "correction-save", "b"]]) {
    const c = call(turn!, "nunc_memory_patch", { expectedRevision: "old", update: [{ id: "s1", text: "new" }] });
    const prior = id === "g3" ? [state("a", "port 8080; sqlite")] : [];
    assert.equal(score(id!, check!, [...prior, c]).status, "UNPROVEN");
    assert.equal(score(id!, check!, [...prior, c, response(c, { ok: false, code: "conflict" })]).status, "UNPROVEN");
    assert.equal(score(id!, check!, [...prior, c, response(c, { ok: true, revision: "new" })]).status, "UNPROVEN");
    assert.equal(score(id!, check!, [...prior, c, response(c, { ok: true, revision: "new" }), state(turn!, "current", "wrong")]).status, "UNPROVEN");
    assert.equal(score(id!, check!, [...prior, c, response(c, { ok: true, revision: "new" }), state(turn!, "current")]).status, "PROVEN");
  }
  // Neither false positives nor false negatives from free-form strings. The
  // semantic observer must distinguish contradictory active notes from history.
  for (const text of ["run-migration here; --v1 elsewhere; 5433 ERR_SCHEMA_V2", "migration-v2 was rejected; use run-migration --v1 --port 5433 due to ERR_SCHEMA_V2", "Use 8080. Also use 9090. sqlite.", "Use 9090, replacing obsolete 8080; sqlite remains.", "有用的说明。".repeat(150)]) {
    assert.equal(score("g2", "semantic: diagnostic meaning", [state("a", text)]).status, "UNPROVEN");
    assert.equal(score("g3", "semantic: current obligations", [state("b", text)]).status, "UNPROVEN");
  }
});

test("g3 actual config values reject stale execution independently of valid historical note mentions", async () => {
  const dir = join(repository, ".scratch", `guidance-config-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  try {
    const { observer } = await loadScenario(repository, { id: "g3", config });
    for (const port of [8080, 9090]) {
      await writeFile(join(dir, "config.json"), JSON.stringify({ port, database: "sqlite" }));
      const result = await scoreArtifacts(dir, observer, exposed, { actions: [state("b", "9090 replaces obsolete 8080; sqlite unchanged")] });
      assert.equal(result.checks[0]!.status, port === 8080 ? "DISPROVEN" : "PROVEN");
      assert.equal(result.actionReview.at(-1)!.status, "UNPROVEN");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("g4 missing, empty or irrelevant M cannot prove lost or retained obligations; M+K/recovery stays available for judgment", () => {
  for (const actions of [[], [state("b", "")], [state("b", "HTTP 429")], [terminal("c"), state("b", "all obligations")]]) {
    assert.equal(score("g4", "semantic: obligations", actions).status, "UNPROVEN");
  }
});

test("g5/g6 verification requires identity, result, original receipt and final-artifact write order", async () => {
  const dir = join(repository, ".scratch", `guidance-verification-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  try {
    for (const id of ["g5", "g6"]) {
      const target = id === "g5" ? "solution.py" : "deployed.json";
      const source = id === "g5" ? "def double(x): return x*2\n" : '{"deployed":true,"service":"orders-pipeline"}';
      const receipt = { passed: true, artifact: target, source };
      await writeFile(join(dir, target), source); await writeFile(join(dir, "verified.json"), JSON.stringify(receipt));
      const w = call("b", "write", { path: join(dir, target), content: source }, "write");
      const c = call("b", "bash", { command: "python3 verify.py" }, "verify");
      const r = response(c); r.event.verification = { scriptUnchanged: true, artifact: receipt };
      const good = [w, response(w), c, r, terminal("b")];
      assert.equal(score(id, "verification-effects", good, split, dir).status, "PROVEN");
      for (const bad of [
        [w, response(w), c],
        [w, response(w), c, response(c, {}, undefined)],
        [w, response(w), c, { ...r, turn: "a" }],
        [w, response(w), c, { ...r, event: { ...r.event, toolName: "read" } }],
        [w, response(w), c, response(c)],
        [w, c, r, response(w)],
        [...good, call("b", "edit", { path: target }, "late"), response(call("b", "edit", {}, "late"))],
        [w, response(w), call("b", "bash", { command: "echo verify.py" }), r],
      ]) assert.notEqual(score(id, "verification-effects", bad, split, dir).status, "PROVEN");
      assert.equal(score(id, "verification-effects", [w, response(w), c, response(c, {}, true)], split, dir).status, "DISPROVEN");
      await writeFile(join(dir, target), source + "changed");
      assert.notEqual(score(id, "verification-effects", good, split, dir).status, "PROVEN");
    }
    assert.equal(score("g2", "verification-effects", [call("a", "write", { path: "@recovery.json" })], exposed, dir).status, "DISPROVEN");
    assert.equal(score("g5", "no-premature-verification", []).status, "UNPROVEN");
    assert.equal(score("g5", "no-premature-verification", [terminal("a")]).status, "PROVEN");
    assert.equal(score("g5", "no-premature-verification", [call("a", "bash", { command: "python3 verify.py" })]).status, "DISPROVEN");
    for (const text of ["verified and accepted; other feature unverified", "unverified, pending user acceptance", "Tests did not pass", "未经验证"]) {
      assert.equal(score("g5", "semantic: status claims", [state("a", text)]).status, "UNPROVEN");
    }
    assert.equal(score("g6", "wait-before-action", [], split).status, "UNPROVEN");
    assert.equal(score("g6", "wait-before-action", [terminal("a")]).status, "UNPROVEN");
    assert.equal(score("g6", "wait-before-action", [terminal("a")], split).status, "PROVEN");
    for (const path of [join(dir, "deployed.json"), "./deployed.json", "@deployed.json"]) {
      assert.equal(score("g6", "wait-before-action", [call("a", "write", { path })], split, dir).status, "DISPROVEN");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("g2 fixture executes diagnostic/argv relation, g5 executes behavior rather than source tokens", async () => {
  const dir = join(repository, ".scratch", `guidance-python-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  try {
    for (const id of ["g2", "g5"] as const) {
      const { input } = await loadScenario(repository, { id, config });
      const cwd = join(dir, id); await seedScenario(input, cwd);
      if (id === "g2") {
        const write = (argv: string[]) => writeFile(join(cwd, "recovery.json"), JSON.stringify({ route: "pipeline-v1-fallback", argv, error: "ERR_SCHEMA_V2", rationale: "migration-v2 was rejected" }));
        await write(["run-migration", "--v1", "--port", "5433"]);
        execFileSync("/usr/bin/python3", ["verify.py"], { cwd });
        await write(["echo", "run-migration", "--v1", "5433"]);
        assert.throws(() => execFileSync("/usr/bin/python3", ["verify.py"], { cwd, stdio: "pipe" }));
      } else {
        await writeFile(join(cwd, "solution.py"), "# return x * 2\ndef double(x): return 0\n");
        assert.throws(() => execFileSync("/usr/bin/python3", ["verify.py"], { cwd, stdio: "pipe" }));
        await writeFile(join(cwd, "solution.py"), "def double(x): return x + x\n");
        execFileSync("/usr/bin/python3", ["verify.py"], { cwd });
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("g7 conflict binds native error and ordered successful reread/current revision/save", () => {
  const p = [...exposed, { check: "actual revision conflict triggered on nunc_memory_patch", status: "PROVEN" as const }];
  const c = call("a", "nunc_memory_patch", { expectedRevision: "old" }, "initial");
  const error = response(c, { ok: false, code: "conflict" });
  const read = call("a", "nunc_memory_read", {}, "read");
  const rr = response(read, { revision: "new", slots: [{ id: "s1", text: "current" }] });
  const retry = call("a", "nunc_memory_patch", { expectedRevision: "new" }, "retry");
  const done = response(retry, { ok: true, revision: "saved" });
  const good = [c, error, read, rr, retry, done];
  assert.equal(score("g7", "conflict-order", good, p).status, "PROVEN");
  assert.equal(score("g7", "conflict-order", good).status, "UNPROVEN");
  assert.equal(score("g7", "conflict-order", [c, { ...error, event: { ...error.event, toolCallId: "unrelated" } }, read, rr, retry, done], p).status, "UNPROVEN");
  for (const bad of [[c, error, retry], [c, error, read, retry, rr], [c, error, read, rr, call("a", "nunc_memory_patch", { expectedRevision: "old" })]]) {
    assert.equal(score("g7", "conflict-order", bad, p).status, "DISPROVEN");
  }
  assert.equal(score("g7", "conflict-order", [c, error, read, rr], p).status, "UNPROVEN");
  assert.equal(score("g7", "conflict-order", good.slice(0, -1), p).status, "UNPROVEN");
});

test("g7 unconfirmed needs actual result plus later opportunity and counts blocked replay attempts", () => {
  const p = [...exposed, { check: "actual unconfirmed save triggered on nunc_memory_patch", status: "PROVEN" as const }];
  const c = call("a", "nunc_memory_patch", { expectedRevision: "old" });
  const r = response(c, { ok: false, code: "unconfirmed" });
  assert.equal(score("g7", "unconfirmed-no-replay", [c, r], p).status, "UNPROVEN");
  assert.equal(score("g7", "unconfirmed-no-replay", [c, r, terminal("b")], p).status, "PROVEN");
  for (const type of ["tool_call", "tool_blocked", "tool_intent"]) {
    const replay = call("b", "nunc_memory_patch", { expectedRevision: "other" }); replay.event.type = type;
    assert.equal(score("g7", "unconfirmed-no-replay", [c, r, replay, terminal("b")], p).status, "DISPROVEN");
  }
  assert.equal(score("g7", "unconfirmed-no-replay", [c, response(c, { ok: true, message: "unconfirmed mentioned" }), terminal("b")], p).status, "UNPROVEN");
});

test("required retention is bound to saved memory and complete distinct required IDs", () => {
  const saved = { version: 1 as const, nextId: 3, slots: [{ id: "s1", text: "needed" }, { id: "s2", text: "also needed" }] };
  const result: any = { ok: true, candidate: { memory: saved }, observations: { required: { declared: ["a", "b"], retainedSlotIds: ["s1", "s2"], failed: false } } };
  assert.equal(checkRequiredRetention(result, saved).status, "PROVEN");
  for (const retainedSlotIds of [["s1"], ["s1", "s1"], ["s1", "missing"]]) {
    assert.equal(checkRequiredRetention({ ...result, observations: { required: { ...result.observations.required, retainedSlotIds } } }, saved).status, "UNPROVEN");
  }
  assert.equal(checkRequiredRetention(result, { ...saved, slots: saved.slots.slice(0, 1) }).status, "UNPROVEN");
});

test("g8 candidate size flags alone never prove actual retention or CAPACITY/recovery effects", () => {
  const binding = ["capacity predicate bound to one frozen request and complete response", "growth reserved once outside the full memory limit"];
  for (const [check, names] of [
    ["capacity-fit-effects", [...binding, "all marked necessary candidates jointly fit within full memory limit", "all candidates together exceed memory limit (actual competition)", "all marked necessary candidates jointly retained in final memory"]],
    ["capacity-failure-effects", [...binding, "marked necessary set exceeds rendered memory limit", "at least one optional candidate fits within memory limit", "marked necessary set exceeding limit fails with CAPACITY without commit", "failed maintenance preserved prior saved memory/boundary", "continuation following capacity failure (failure-path recovery)"]],
  ] as const) {
    const p = [...exposed, ...names.map(check => ({ check, status: "PROVEN" as const }))];
    assert.equal(score("g8", check, [], p).status, "PROVEN");
    for (const name of names) assert.equal(score("g8", check, [], p.filter(p => p.check !== name)).status, "UNPROVEN", name);
    assert.equal(score("g8", "semantic: necessary dependencies", [], p).status, "UNPROVEN");
  }
});
