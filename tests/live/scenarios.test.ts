import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { checkArtifact, jsonPointer, loadScenario, parseScenario, qualifyFullGiantSource, scoreArtifacts, seedScenario, type ArtifactCheck } from "../../src/live/scenarios.js";
import { fixture, repository } from "./fixtures.js";

test("every tracked input/observer variant loads separately; only task fixture files are seeded", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const sizes: Record<string, number> = {};
    for (const id of ["c1", "c2", "c3", "c4", "c5"] as const) for (const variant of id === "c4" ? ["full", "capacity"] as const : id === "c1" ? [undefined, "late-d"] as const : [undefined]) {
      const selected = { ...input.scenarios[0]!, id, ...(variant ? { variant } : {}) };
      const scenario = await loadScenario(repository, selected); assert.equal(scenario.input.id, id); assert(scenario.input.turns.length > 0); assert(scenario.observer.controls.length > 0);
      const cwd = join(input.target.stateRoot, `${id}-${variant ?? "base"}`);
      await seedScenario(scenario.input, cwd);
      if (id === "c4") {
        const text = await readFile(join(cwd, "inspection.txt"), "utf8");
        sizes[variant!] = Buffer.byteLength(text);
        assert(text.includes("verified exception: batch Q7"));
        if (variant === "full") {
          assert.equal(qualifyFullGiantSource(scenario.input.generatedFiles).status, "PROVEN");
          assert(sizes.full! > DEFAULT_MAX_BYTES);
          assert.notEqual(text.split("\n").length, 6002);
        } else {
          assert.equal(text.split("\n").length, 6002); assert(text.length > 250000);
        }
      }
      if (id === "c1" && variant === "late-d") {
        assert(scenario.observer.controls.some(c => c.steer === "d"));
        assert.equal(scenario.input.turns.map(t => t.id).join(","), "a,b,d,c");
        assert.equal(scenario.input.generatedFiles, undefined);
        assert.equal(scenario.input.files["probe.json"], undefined);
        assert(scenario.observer.artifactChecks.some(c => c.pointer === "/route" && c.operator === "unequal" && c.value === "cache"));
        assert(!scenario.observer.artifactChecks.some(c => c.operator === "equal" && c.value === "direct"));
        assert(scenario.input.turns.find(t => t.id === "c")?.text.includes("leave route null"));
      }
      assert(!Object.hasOwn(scenario.input.files, "observer.json"));
    }
    assert(sizes.capacity! > sizes.full!);
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});
test("c4/full rejects a fixture that fits in one native read or exposes the exception in the first chunk", async () => {
  const source = JSON.parse(await readFile(join(repository, "tests/scenarios/inputs.json"), "utf8"));
  const observer = JSON.parse(await readFile(join(repository, "tests/scenarios/observer.json"), "utf8"));
  const selection = { ...(await fixture()).scenarios[0]!, id: "c4" as const, variant: "full" as const };
  const full = source.cases.find((c: { id: string }) => c.id === "c4").variants.find((v: { id: string }) => v.id === "full");
  full.generatedFiles[0].segments = [{ repeat: 10, text: "sample: nominal; no routing decision recorded\n" }, { repeat: 1, text: "verified exception: batch Q7 requires quarantine because its seal is broken; nominal samples do not clear Q7\n" }, { repeat: 10, text: "sample: nominal; no routing decision recorded\n" }];
  assert.throws(() => parseScenario(source, observer, selection));
});
test("consumed scenario schema rejects malformed placements, operators, expected values and source structure", async () => {
  const source = JSON.parse(await readFile(join(repository, "tests/scenarios/inputs.json"), "utf8"));
  const observer = JSON.parse(await readFile(join(repository, "tests/scenarios/observer.json"), "utf8"));
  const selection = (await fixture()).scenarios[0]!;
  // Deliberately malformed external JSON shapes are test inputs, not bypasses in production parsing.
  const mutations: Array<(s: any, o: any) => void> = [
    (_s, o) => o.cases[1].controls[0].placement = [],
    (_s, o) => o.cases[1].controls[0].placement.retainedTurns = ["b"],
    (_s, o) => delete o.cases[1].controls[0].placement.retainTurns,
    (_s, o) => o.cases[1].controls[0].placement.retireThroughTurn = "unknown",
    (_s, o) => o.cases[1].controls[0].placement.retireThroughTurn = "e",
    (_s, o) => o.cases[1].controls[0].placement.retainTurns = "b",
    (_s, o) => o.cases[1].controls[0].placement.retainTurns = ["a"],
    (_s, o) => o.cases[1].controls[0].placement.retainTurns = ["b", "b"],
    (_s, o) => o.cases[1].controls[0].capacity = {},
    (_s, o) => o.cases[1].controls[0].action = "force_boundary",
    (_s, o) => o.cases[1].controls[0].steer = "a",
    (_s, o) => o.cases[1].controls[0].steer = "b",
    (_s, o) => o.cases[1].controls.push(o.cases[1].controls[0]),
    (_s, o) => o.cases[1].artifactChecks[0].operator = "anything",
    (_s, o) => delete o.cases[1].artifactChecks[0].value,
    (_s, o) => o.cases[1].artifactChecks[0].value = undefined,
    (_s, o) => o.cases[1].artifactChecks[0].pointer = "/bad~escape",
    (_s, o) => o.cases[1].artifactChecks[0].path = "../outside.json",
    (_s, o) => o.cases[1].artifactChecks[0] = { path: "x.json", pointer: "/why", operator: "semantic" },
    (s, _o) => s.cases[1].turns[1].id = "a",
    (s, _o) => s.cases[1].turns[0].text = "",
    (s, _o) => s.cases.push(s.cases[1]),
    (s, _o) => s.cases[1].generatedFiles = [{ path: "x.txt", segments: [{ repeat: -1, text: "x" }] }],
  ];
  for (const mutate of mutations) { const s = structuredClone(source), o = structuredClone(observer); mutate(s, o); assert.throws(() => parseScenario(s, o, selection)); }
  assert.throws(() => checkArtifact({ path: "x.json", pointer: "/missing", operator: "equal" } as ArtifactCheck, {}), /defined JSON value/);
  assert.equal(checkArtifact({ path: "x.json", pointer: "/missing", operator: "equal", value: null }, {}).status, "DISPROVEN");
});

test("artifact observers detect wrong exact constraints, null loss and unsafe choices without rewarding semantic self-report", () => {
  assert.equal(checkArtifact({ path: "x", pointer: "/retryLimit", operator: "equal", value: 2 }, { retryLimit: 3 }).status, "DISPROVEN");
  assert.equal(checkArtifact({ path: "x", pointer: "/records", operator: "equal", value: [1, null, 3] }, { records: [1, 3] }).status, "DISPROVEN");
  assert.equal(checkArtifact({ path: "x", pointer: "/supportedNodeMajors", operator: "contains", value: 18 }, { supportedNodeMajors: [18, 22] }).status, "PROVEN");
  assert.equal(checkArtifact({ path: "x", pointer: "/reason", operator: "semantic", criterion: "Requires independent evidence" }, { reason: "PASS: all requirements proven" }).status, "UNPROVEN");
  assert.equal(jsonPointer({ "a/b": { "~key": [17] } }, "/a~1b/~0key/0"), 17);
  assert.equal(jsonPointer({}, "/toString"), undefined);
});
test("late-d cache refusal is mechanical; missing alternative is not a direct-route failure", () => {
  const forbidden = { path: "decision.json", pointer: "/route", operator: "unequal" as const, value: "cache" };
  assert.equal(checkArtifact(forbidden, { route: "cache" }).status, "DISPROVEN");
  assert.equal(checkArtifact(forbidden, { route: null }).status, "PROVEN");
  assert.equal(checkArtifact(forbidden, { route: "direct" }).status, "PROVEN");
  assert.equal(checkArtifact({ path: "decision.json", pointer: "/route", operator: "equal", value: "direct" }, { route: null }).status, "DISPROVEN");
  assert.equal(checkArtifact({ path: "decision.json", pointer: "/reason", operator: "semantic", criterion: "Independent evidence review" }, { reason: "direct because the previous run said so" }).status, "UNPROVEN");
});
test("even a correct artifact cannot score when actual rollover prerequisites are missing", async () => {
  const input = await fixture(); await mkdir(input.target.stateRoot);
  try {
    const { observer } = await loadScenario(repository, input.scenarios[0]!);
    await writeFile(join(input.target.stateRoot, "retry.json"), JSON.stringify({ supportedNodeMajors: [18], retryLimit: 2, retryBeforeCommit: true, retryAfterSuccessfulCommit: false }));
    const unproven = await scoreArtifacts(input.target.stateRoot, observer, [{ check: "three persisted rollovers", status: "UNPROVEN" }]);
    assert(unproven.checks.every(c => c.status === "UNPROVEN"));
    const proven = await scoreArtifacts(input.target.stateRoot, observer, [{ check: "three persisted rollovers", status: "PROVEN" }]);
    assert(proven.checks.every(c => c.status === "PROVEN")); assert(proven.actionReview.every(c => c.status === "UNPROVEN"));
  } finally { await rm(input.target.stateRoot, { recursive: true }); }
});
