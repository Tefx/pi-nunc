import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, type TUI } from "@earendil-works/pi-tui";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { answer } from "../engine/fixtures.js";
import { memorySurface } from "../../src/pi/manual.js";
import { project } from "../../src/pi/projection.js";
import type { NuncOverlay } from "../../src/ui/overlay.js";
import { fixture } from "./fixtures.js";

initTheme();
for (const updateMode of ["nonempty", "empty", "legacy"] as const) test(`actual UI cleanup ${updateMode} update preserves user-selected M`, async t => {
  let ctx: ExtensionContext | undefined, api: ExtensionAPI | undefined;
  const responseObserved = Promise.withResolvers<void>();
  const f = await fixture({ diskSettings: true, globalSettings: { nunc: { memoryTools: true } },
    extras: [{ name: "capture-ui-cleanup-update", factory(pi) {
      api = pi; pi.on("session_start", (_event, current) => { ctx = current; });
      pi.events.on("nunc:ui-cleanup-usage", () => responseObserved.resolve());
    } }] });
  t.after(() => f.close());
  assert(ctx && api);
  const surface = memorySurface(api)!;
  const created = surface.patch(ctx, { expectedRevision: surface.read(ctx).revision,
    add: [{ key: "task", text: "User-selected task note." }] });
  assert(created.ok, JSON.stringify(created));
  const slot = created.memory.slots[0]!;
  f.respond(() => fauxAssistantMessage("Anchor established."));
  await f.runtime.session.prompt("Send memory before tool cleanup");
  const manager = f.runtime.session.sessionManager;
  for (const [id, body] of [["eligible", "Eligible original evidence. ".repeat(50)], ["newest", "Newest complete evidence. ".repeat(40)]] as const) {
    manager.appendMessage({ ...answer({}, f.faux.getModel()), stopReason: "toolUse",
      content: [{ type: "toolCall", id, name: "read", arguments: { path: id } }] });
    manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "read", isError: false,
      content: [{ type: "text", text: body }], timestamp: 2 });
  }
  f.runtime.session.agent.state.messages = manager.buildSessionContext().messages;
  const resultEntry = project(manager.buildContextEntries()).active.find(entry => entry.messages[0]?.role === "toolResult")!;
  const proposalText = `${slot.text} Edited by user.`;
  f.respond(context => {
    assert(JSON.stringify(context.messages).includes(proposalText), "cleanup model must receive the user's proposed M");
    return fauxAssistantMessage(JSON.stringify({ add: [], remove: [], priority: [slot.id], required: [],
      ...(updateMode === "legacy" ? {} : { update: updateMode === "empty" ? [] : [{ id: slot.id, text: "Unauthorized model revision." }] }),
      toolResultEdits: [{ entryId: resultEntry.entryId, messageIndex: 0, action: "omit", memoryRefs: [slot.id] }] }));
  });
  const ready = Promise.withResolvers<NuncOverlay>(), done = Promise.withResolvers<unknown>();
  t.after(() => done.resolve(null));
  const tuiCtx: ExtensionContext = { ...ctx, mode: "tui", hasUI: true, ui: { ...ctx.ui,
    custom: async (factory: any) => {
      const overlay = factory({ requestRender() {}, terminal: { rows: 40, columns: 120 } } as TUI,
        ctx!.ui.theme, new KeybindingsManager(TUI_KEYBINDINGS), (value: unknown) => done.resolve(value)) as NuncOverlay;
      ready.resolve(overlay);
      return await done.promise as any;
    },
  } };
  const shortcut = f.runtime.services.resourceLoader.getExtensions().extensions.map(extension => extension.shortcuts.get("f7")).find(value => value !== undefined);
  assert(shortcut);
  const opened = shortcut.handler(tuiCtx);
  const overlay = await ready.promise;
  t.after(() => overlay.dispose());
  overlay.handleInput("\r");
  overlay.handleInput(" Edited by user.");
  assert.equal(overlay.draftText(), proposalText);
  overlay.handleInput("\r");
  await responseObserved.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(overlay.layerName, "browse");
  assert.equal(surface.read(ctx).memory.slots[0]?.text, proposalText);
  assert.equal(project(manager.buildContextEntries()).cleanup.length, updateMode === "nonempty" ? 0 : 1);
  assert.equal(f.calls.length, 2, "one anchor request and one cleanup request, no retry");
  overlay.dispose(); done.resolve(null); await opened;
});
