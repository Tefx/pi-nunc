import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadScenario, scoreArtifacts } from "../../src/live/scenarios.js";
import { fixture, repository } from "./fixtures.js";

for (const id of ["e1", "e3"] as const) test(`${id} verification selects an ordered successful receipt after repair or reverification`, async () => {
  const { observer } = await loadScenario(repository, { id, config: (await fixture()).scenarios[0]!.config });
  const cwd = await mkdtemp(join(repository, ".scratch/verify-history-"));
  const turn = id === "e1" ? "e" : "b", target = id === "e1" ? "export.json" : "ready.json", artifact = id === "e1" ? "verification.json" : "verified.json";
  const receipt = { scriptUnchanged: true, artifact: { artifact: target, passed: true } };
  let counter = 0;
  const verify = (isError = false, verification: unknown = receipt, at: string = turn) => {
    const toolCallId = `verify-${counter++}`;
    return [
      { turn: at, event: { type: "tool_call", toolName: "bash", toolCallId, input: { command: "python3 verify.py" } } },
      { turn: at, event: { type: "tool_result", toolName: "bash", toolCallId, isError, verification } },
    ];
  };
  const edit = (path: string = target, isError = false) => {
    const toolCallId = `edit-${counter++}`;
    return [
      { turn, event: { type: "tool_call", toolName: "edit", toolCallId, input: { path } } },
      { turn, event: { type: "tool_result", toolName: "edit", toolCallId, isError } },
    ];
  };
  const score = async (actions: unknown[]) => (await scoreArtifacts(cwd, observer, [{ check: "placement", status: "PROVEN" }], { actions, requireVerificationReceipt: true })).actionReview[0]!;
  try {
    await writeFile(join(cwd, artifact), JSON.stringify(receipt.artifact));
    const last = verify();
    for (const history of [[...verify(true), ...edit(), ...last], [...verify(), ...edit(), ...last]]) {
      const result = await score(history);
      assert.equal(result.status, "PROVEN");
      assert.equal((result.observed as any).toolCallId, last[0]!.event.toolCallId);
    }
    assert.equal((await score([...verify(), ...edit(), ...verify(true)])).status, "DISPROVEN");
    assert.equal((await score([...verify(), ...edit(), ...last, ...edit()])).status, "DISPROVEN");
    assert.equal((await score([...verify(), ...edit(target, true)])).status, "PROVEN");
    for (const path of ["verify.py", artifact]) assert.equal((await score([...edit(path), ...last])).status, "DISPROVEN");
    assert.equal((await score([...verify(false, receipt, "a"), ...last])).status, "DISPROVEN");
    assert.equal((await score(verify(false, null))).status, "UNPROVEN");
    assert.equal((await score(verify(false, { ...receipt, scriptUnchanged: false }))).status, "UNPROVEN");
    assert.equal((await score(verify(false, { ...receipt, artifact: { passed: true, artifact: "other.json" } }))).status, "UNPROVEN");
    assert.equal((await score(verify().reverse())).status, "DISPROVEN");
    const mismatched = verify(); mismatched[1]!.turn = "other";
    assert.equal((await score(mismatched)).status, "DISPROVEN");
    const overlapping = edit(), earlier = verify();
    assert.equal((await score([overlapping[0], ...earlier, overlapping[1]])).status, "DISPROVEN");
    assert.equal((await score([overlapping[0], ...earlier, overlapping[1], ...last])).status, "PROVEN");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
