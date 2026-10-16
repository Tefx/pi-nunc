import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { answer } from "../engine/fixtures.js";
import { memorySurface } from "../../src/pi/manual.js";
import { effectiveActive, project } from "../../src/pi/projection.js";
import { fixture } from "./fixtures.js";

async function setup(t: { after(fn: () => unknown): unknown }) {
  let ctx: ExtensionContext | undefined, api: ExtensionAPI | undefined;
  const f = await fixture({ diskSettings: true, globalSettings: { nunc: { memoryTools: true } },
    extras: [{ name: "source-binding", factory(pi) {
      api = pi; pi.on("session_start", (_event, current) => { ctx = current; });
    } }] });
  t.after(() => f.close());
  assert(ctx && api);
  const surface = memorySurface(api)!;
  const created = surface.patch(ctx, { expectedRevision: surface.read(ctx).revision,
    add: [{ key: "task", text: "Keep the diagnostic result for the current task." }] });
  assert(created.ok);
  f.respond(() => fauxAssistantMessage("Memory anchor established."));
  await f.runtime.session.prompt("Send current memory");
  const manager = f.runtime.session.sessionManager;
  const bodies = ["Keeper full source. ".repeat(80), "Target full source. ".repeat(80), "Newest full source. ".repeat(80)];
  const ids = bodies.map((body, i) => {
    const callId = `binding-${i}`;
    manager.appendMessage({ ...answer({}, f.faux.getModel()), stopReason: "toolUse",
      content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: callId } }] });
    return manager.appendMessage({ role: "toolResult", toolCallId: callId, toolName: "read", isError: false,
      content: [{ type: "text", text: body }], timestamp: 2 });
  });
  f.runtime.session.agent.state.messages = manager.buildSessionContext().messages;
  return { f, ctx, api, surface, manager, bodies, ids };
}

for (const changed of ["target", "dependency", "unrelated"] as const) test(`manual cleanup binds current native sources: ${changed}`, async t => {
  const { f, ctx, surface, manager, ids } = await setup(t);
  const read = surface.read(ctx);
  const tool = (f.runtime.session as any).getToolDefinition("nunc_memory_patch");
  manager.appendContextEdit(ids[changed === "target" ? 1 : changed === "dependency" ? 0 : 2]!,
    { content: [{ type: "text", text: "Corrected native result. ".repeat(80) }] });
  const result = await tool.execute("binding-patch", { expectedRevision: read.revision,
    update: [{ id: read.memory.slots[0]!.id, text: "Legal memory update after native edit." }],
    toolResultEdits: [{ entryId: ids[1], messageIndex: 0, action: "replace", text: "Consumed result; complete source retained.",
      sourceRefs: [{ entryId: ids[0], messageIndex: 0 }] }] }, undefined, undefined, ctx);
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const saved = JSON.parse(result.content[0].text);
  assert.equal(surface.read(ctx).memory.slots[0]!.text, "Legal memory update after native edit.");
  assert.equal(saved.toolResultCleanup.applied.length, changed === "unrelated" ? 1 : 0);
  if (changed !== "unrelated") assert(saved.toolResultCleanup.skipped.some((row: { details?: string }) => row.details?.includes("context_edit")));
});

test("saved dependency snapshots restore target on native keeper edit and same-length source drift", async t => {
  const { f, ctx, surface, manager, bodies, ids } = await setup(t);
  const read = surface.read(ctx);
  const result = surface.patch(ctx, { expectedRevision: read.revision,
    update: [{ id: read.memory.slots[0]!.id, text: "Source consumed; keeper remains available." }],
    toolResultEdits: [{ entryId: ids[1], messageIndex: 0, action: "replace", text: "Consumed result.", sourceRefs: [{ entryId: ids[0], messageIndex: 0 }] }] });
  assert(result.ok);
  assert.equal(result.cleanup?.applied.length, 1);
  const reopened = () => project(SessionManager.open(f.runtime.session.sessionFile!, f.sessionDir).buildContextEntries());
  assert.equal(reopened().cleanup.length, 1);
  for (const change of ["body", "toolCallId", "toolName", "role"] as const) {
    const entries = structuredClone(manager.buildContextEntries());
    const source = entries.find(e => e.id === ids[0]);
    assert(source?.type === "message" && source.message.role === "toolResult");
    if (change === "body") source.message.content = [{ type: "text", text: `${bodies[0]!.slice(0, -1)}X` }];
    else if (change === "role") source.message = { role: "user", content: bodies[0]!, timestamp: 2 };
    else source.message[change] = "different-association";
    const changed = project(entries);
    assert.equal(changed.cleanup.length, 0, change);
    assert(changed.unavailable.includes(`${ids[1]}:0`));
    assert(JSON.stringify(effectiveActive(changed, true)).includes(bodies[1]!));
  }
  manager.appendContextEdit(ids[0]!, { content: [{ type: "text", text: "Native keeper correction." }] });
  const changed = reopened();
  assert.equal(changed.cleanup.length, 0);
  assert(JSON.stringify(effectiveActive(changed, true)).includes(bodies[1]!));
});

for (const malformed of [{}, [null], [{ entryId: "keeper", messageIndex: -1 }], [{ entryId: 7, messageIndex: 0 }]]) {
  test(`invalid persisted sourceRefs skip only the malformed decision: ${JSON.stringify(malformed)}`, async t => {
    const { ctx, surface, manager, api, ids, bodies } = await setup(t);
    const read = surface.read(ctx);
    const result = surface.patch(ctx, { expectedRevision: read.revision,
      update: [{ id: read.memory.slots[0]!.id, text: "Persist independently valid memory." }],
      toolResultEdits: [0, 1].map(i => ({ entryId: ids[i], messageIndex: 0, action: "replace", text: `Result ${i} consumed.` })) });
    assert(result.ok);
    assert.equal(result.cleanup?.applied.length, 2);
    const saved = manager.getEntry(manager.getLeafId()!);
    assert(saved?.type === "custom");
    const data = structuredClone(saved.data) as { toolResultCleanup: Record<string, unknown>[] };
    data.toolResultCleanup[0]!.sourceRefs = malformed;
    api.appendEntry(saved.customType, data);
    const projected = project(manager.buildContextEntries());
    assert.equal(projected.memory.slots[0]!.text, "Persist independently valid memory.");
    assert.deepEqual(projected.cleanup.map(d => d.entryId), [ids[1]]);
    assert(projected.unavailable.includes(`${ids[0]}:0`));
    assert(JSON.stringify(effectiveActive(projected, true)).includes(bodies[0]!));
  });
}
