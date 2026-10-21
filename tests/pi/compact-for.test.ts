import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxProvider } from "@earendil-works/pi-ai";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { fixture, memoryPatch, preparedSurface } from "./fixtures.js";
import { project } from "../../src/pi/projection.js";
import { sourceRecords } from "../engine/fixtures.js";

const commandOf = (f: Awaited<ReturnType<typeof fixture>>) => f.runtime.services.resourceLoader.getExtensions().extensions
  .flatMap(e => [...e.commands.values()]).find(c => c.name === "nunc")!;

test("compact-for completes registered model identities dynamically without requests or transcript writes", async t => {
  const { f, ctx } = await preparedSurface(t);
  const command = commandOf(f), before = f.runtime.session.sessionManager.getEntries();
  const completions = await command.getArgumentCompletions!("compact-for sma");
  assert(completions?.some(c => c.value === "compact-for nunc-pi-fixture/small"));
  const native = new CombinedAutocompleteProvider([command], f.cwd);
  const line = "/nunc compact-for sma";
  const suggestions = await native.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
  assert(suggestions);
  const chosen = suggestions.items.find(i => i.value === "compact-for nunc-pi-fixture/small")!;
  assert(chosen);
  assert.equal(native.applyCompletion([line], 0, line.length, chosen, suggestions.prefix).lines[0]!.trimEnd(),
    "/nunc compact-for nunc-pi-fixture/small");
  assert.equal(await command.getArgumentCompletions!("compact-for no-such-model"), null);
  const late = fauxProvider({ provider: "late-provider", models: [{ id: "small", contextWindow: 50000, maxTokens: 8192 }, { id: "nunc-pi-fixture/small", contextWindow: 50000, maxTokens: 8192 }] });
  ctx().modelRegistry.registerProvider(late.provider);
  const fresh = await command.getArgumentCompletions!("compact-for late-provider/");
  assert.deepEqual(fresh?.map(c => c.value), ["compact-for late-provider/nunc-pi-fixture/small", "compact-for late-provider/small"]);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.runtime.session.sessionManager.getEntries(), before);
  // Ambiguous IDs must not silently choose a provider or start compaction.
  await f.runtime.session.prompt("/nunc compact-for small");
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.runtime.session.sessionManager.getEntries(), before);
  f.seed(); f.respond(memoryPatch);
  await f.runtime.session.prompt("/nunc compact-for nunc-pi-fixture/small");
  assert.equal(f.calls.length, 1, "fully-qualified identity wins over another provider model ID containing a slash");
  assert.equal(f.events[0]!.result.observations.target!.provider, "nunc-pi-fixture");
});

test("compact-for saves once using the current model, preserves full sources, and leaves auto-compaction off", async t => {
  const notes: string[] = [];
  const f = await fixture({ bus: bus => bus.on("nunc:diagnostic", value => notes.push((value as { message: string }).message)) });
  t.after(() => f.close());
  await f.runtime.session.setModel({ ...f.faux.getModel(), contextWindow: 200000 });
  f.seed();
  const manager = f.runtime.session.sessionManager;
  const before = project(manager.buildContextEntries()).active;
  const selected = structuredClone(f.runtime.session.model);
  let executionModel: string | undefined;
  f.respond((context, _options, _state, model) => {
    executionModel = model.id;
    const records = sourceRecords(context);
    assert.deepEqual(records.map(r => r.entryId), before.map(r => r.entryId));
    for (let i = 0; i < before.length; i++) {
      if (before[i]!.messages[0]!.role === "user") assert.equal(records[i]!.messages[0]!.content, before[i]!.messages[0]!.content);
    }
    return memoryPatch(context);
  });
  await f.runtime.session.prompt("/nunc compact-for nunc-pi-fixture/small");
  assert.equal(f.calls.length, 1);
  assert.equal(executionModel, "large");
  assert.equal(f.events.length, 1);
  const result = f.events[0]!.result;
  assert(result.ok, result.ok ? "" : result.message);
  assert(result.observations.target!.fits);
  assert.deepEqual(result.observations.omissions, []);
  assert.equal(manager.getEntries().filter(e => e.type === "compaction").length, 1);
  assert.deepEqual(f.runtime.session.model, selected);
  assert.equal(f.settings.getCompactionSettings().enabled, false);
  assert(notes.some(n => n.includes("Saved compaction for nunc-pi-fixture/small")));
  await f.runtime.session.prompt("/nunc details");
  assert(notes.at(-1)!.includes("Target: nunc-pi-fixture/small"));
  assert(notes.at(-1)!.includes("native saved"));
});

test("unknown targets and non-summarizable sessions never send or save", async t => {
  const f = await fixture(); t.after(() => f.close());
  const before = f.runtime.session.sessionManager.getEntries();
  await f.runtime.session.prompt("/nunc compact-for unknown/model");
  await f.runtime.session.prompt("/nunc compact-for nunc-pi-fixture/small");
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.runtime.session.sessionManager.getEntries(), before);
  // The failed native preparation must release the one-shot target intent.
  f.seed(); f.respond(memoryPatch);
  await f.runtime.session.prompt("/nunc compact-for nunc-pi-fixture/small");
  assert.equal(f.calls.length, 1);
  assert.equal(f.runtime.session.sessionManager.getEntries().filter(e => e.type === "compaction").length, 1);
});

test("model changes while extraction is pending invalidate the targeted candidate without a checkpoint", async t => {
  const f = await fixture(); t.after(() => f.close()); f.seed();
  f.respond(async context => {
    await f.runtime.session.setModel(f.faux.getModel("small")!);
    return memoryPatch(context);
  });
  await f.runtime.session.prompt("/nunc compact-for nunc-pi-fixture/small");
  assert.equal(f.calls.length, 1);
  assert.equal(f.runtime.session.sessionManager.getEntries().filter(e => e.type === "compaction").length, 0);
  assert.deepEqual(project(f.runtime.session.sessionManager.buildContextEntries()).memory.slots, []);
});
