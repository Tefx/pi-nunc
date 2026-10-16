import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { memorySurface } from "../../src/pi/manual.js";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { answer } from "../engine/fixtures.js";
import { effectiveActive, project } from "../../src/pi/projection.js";
import { fixture, memoryPatch } from "./fixtures.js";

test("mechanical dedup keeper edit invalidates saved target cleanup across native reopen", async t => {
  let ctx: ExtensionContext | undefined, api: ExtensionAPI | undefined;
  const f = await fixture({ diskSettings: true, globalSettings: { nunc: { memoryTools: true } },
    extras: [{ name: "dedup-binding", factory(pi) {
      api = pi; pi.on("session_start", (_event, current) => { ctx = current; });
    } }] });
  t.after(() => f.close());
  f.seed(); f.respond(memoryPatch);
  await f.runtime.session.compact();
  assert(ctx && api);
  f.respond(() => fauxAssistantMessage("Establish cleanup prefix anchor."));
  await f.runtime.session.prompt("Use current memory");
  const manager = f.runtime.session.sessionManager;
  const original = "Same complete diagnostic for the same read arguments. ".repeat(80);
  const ids = [0, 1, 2].map(i => {
    const id = `dedup-${i}`;
    manager.appendMessage({ ...answer({}, f.faux.getModel()), stopReason: "toolUse",
      content: [{ type: "toolCall", id, name: "read", arguments: { path: i === 2 ? "newest" : "same-source" } }] });
    return manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "read", isError: false,
      content: [{ type: "text", text: i === 2 ? "Newer diagnostic.".repeat(80) : original }], timestamp: 2 });
  });
  f.runtime.session.agent.state.messages = manager.buildSessionContext().messages;
  const surface = memorySurface(api)!;
  const read = surface.read(ctx);
  const committed = surface.patch(ctx, { expectedRevision: read.revision,
    update: [{ id: read.memory.slots[0]!.id, text: "Identical diagnostic consumed; keeper retained." }] });
  assert(committed.ok);
  const saved = project(manager.buildContextEntries());
  const decision = saved.cleanup.find(d => d.entryId === ids[1]);
  assert(decision, JSON.stringify({ cleanup: committed.cleanup, saved: saved.cleanup, active: saved.active.map(e => ({ id: e.entryId, roles: e.messages.map(m => m.role) })) }));
  assert.equal(decision.kind, "mechanical");
  assert.deepEqual(decision.sourceRefs, [{ entryId: ids[0], messageIndex: 0 }]);
  const reopen = () => project(SessionManager.open(f.runtime.session.sessionFile!, f.sessionDir).buildContextEntries());
  assert.equal(reopen().cleanup.length, 1);
  manager.appendContextEdit(ids[0]!, { content: [{ type: "text", text: "Revised native keeper body." }] });
  const changed = reopen();
  assert.equal(changed.cleanup.length, 0);
  assert(changed.unavailable.includes(`${ids[1]}:0`));
  assert(JSON.stringify(effectiveActive(changed, true)).includes(original));
  f.respond(() => fauxAssistantMessage("Continue with restored source."));
  await f.runtime.session.prompt("Continue after keeper correction");
  const sent = f.calls.at(-1)!.messages.find(m => m.role === "toolResult" && m.toolCallId === "dedup-1");
  assert(sent?.role === "toolResult");
  assert.deepEqual(sent.content, [{ type: "text", text: original }]);
});
