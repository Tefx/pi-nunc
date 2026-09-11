import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMemoryTools, parseNuncSettings, validateNuncSettings } from "../../src/pi/config.js";
import { EngineError } from "../../src/engine/validation.js";
import { fixture } from "./fixtures.js";

test("parseNuncSettings validates shape and rejects non-boolean memoryTools", () => {
  // Valid cases
  assert.deepEqual(parseNuncSettings(undefined), {});
  assert.deepEqual(parseNuncSettings({}), {});
  assert.deepEqual(parseNuncSettings({ memoryTools: true }), { memoryTools: true });
  assert.deepEqual(parseNuncSettings({ memoryTools: false }), { memoryTools: false });

  // Invalid root shape
  assert.throws(() => parseNuncSettings("invalid"), /settings\.json: nunc must be an object/);
  assert.throws(() => parseNuncSettings(null), /settings\.json: nunc must be an object/);
  assert.throws(() => parseNuncSettings([1, 2]), /settings\.json: nunc must be an object/);
  assert.throws(() => parseNuncSettings(42), /settings\.json: nunc must be an object/);

  // Unknown keys
  assert.throws(() => parseNuncSettings({ unknownKey: true }), /Unknown settings\.json: nunc\.unknownKey/);

  // Non-boolean memoryTools: must never be coerced by Boolean(...)
  assert.throws(() => parseNuncSettings({ memoryTools: "false" }), /expected boolean, got string/);
  assert.throws(() => parseNuncSettings({ memoryTools: "true" }), /expected boolean, got string/);
  assert.throws(() => parseNuncSettings({ memoryTools: 1 }), /expected boolean, got number/);
  assert.throws(() => parseNuncSettings({ memoryTools: 0 }), /expected boolean, got number/);
  assert.throws(() => parseNuncSettings({ memoryTools: null }), /expected boolean, got object/);
  assert.throws(() => parseNuncSettings({ memoryTools: [] }), /expected boolean, got object/);
  assert.throws(() => parseNuncSettings({ memoryTools: {} }), /expected boolean, got object/);
});

test("resolveMemoryTools implements strict precedence: CLI > trusted project > global > false", () => {
  // 1. Explicit CLI flag true overrides everything
  assert.equal(resolveMemoryTools({ cliFlag: true, projectNunc: { memoryTools: false }, globalNunc: { memoryTools: false }, projectTrusted: true }), true);
  assert.equal(resolveMemoryTools({ cliFlag: "true", projectNunc: { memoryTools: false }, globalNunc: { memoryTools: false }, projectTrusted: true }), true);

  // 2. Trusted project overrides global
  assert.equal(resolveMemoryTools({ cliFlag: undefined, projectNunc: { memoryTools: false }, globalNunc: { memoryTools: true }, projectTrusted: true }), false);
  assert.equal(resolveMemoryTools({ cliFlag: undefined, projectNunc: { memoryTools: true }, globalNunc: { memoryTools: false }, projectTrusted: true }), true);

  // 3. Untrusted project does NOT take effect
  assert.equal(resolveMemoryTools({ cliFlag: undefined, projectNunc: { memoryTools: true }, globalNunc: { memoryTools: false }, projectTrusted: false }), false);
  assert.equal(resolveMemoryTools({ cliFlag: undefined, projectNunc: { memoryTools: true }, globalNunc: undefined, projectTrusted: false }), false);
  assert.equal(resolveMemoryTools({ cliFlag: undefined, projectNunc: { memoryTools: false }, globalNunc: { memoryTools: true }, projectTrusted: false }), true);

  // 4. Global setting takes effect when project does not specify
  assert.equal(resolveMemoryTools({ cliFlag: undefined, projectNunc: {}, globalNunc: { memoryTools: true }, projectTrusted: true }), true);
  assert.equal(resolveMemoryTools({ cliFlag: undefined, projectNunc: undefined, globalNunc: { memoryTools: true }, projectTrusted: true }), true);
  assert.equal(resolveMemoryTools({ cliFlag: undefined, projectNunc: undefined, globalNunc: { memoryTools: false }, projectTrusted: true }), false);

  // 5. Default is false
  assert.equal(resolveMemoryTools({ cliFlag: undefined, projectNunc: undefined, globalNunc: undefined }), false);
  assert.equal(resolveMemoryTools({ cliFlag: undefined, projectNunc: {}, globalNunc: {} }), false);
});

test("stock Pi settings: global settings.json with nunc.memoryTools: true enables tools in session", async t => {
  const f = await fixture({
    diskSettings: true,
    globalSettings: { nunc: { memoryTools: true } },
  });
  t.after(() => f.close());

  const allTools = f.runtime.session.getAllTools();
  const activeTools = f.runtime.session.getActiveToolNames();
  assert(allTools.some(tool => tool.name === "nunc_memory_read"), "nunc_memory_read must be in all tools");
  assert(allTools.some(tool => tool.name === "nunc_memory_patch"), "nunc_memory_patch must be in all tools");
  assert(activeTools.includes("nunc_memory_read"), "nunc_memory_read must be active");
  assert(activeTools.includes("nunc_memory_patch"), "nunc_memory_patch must be active");
});

test("stock Pi settings: trusted project settings with nunc.memoryTools: false overrides global true", async t => {
  const f = await fixture({
    diskSettings: true,
    globalSettings: { nunc: { memoryTools: true } },
    projectSettings: { nunc: { memoryTools: false } },
    projectTrusted: true,
  });
  t.after(() => f.close());

  const allTools = f.runtime.session.getAllTools();
  const activeTools = f.runtime.session.getActiveToolNames();
  assert(!allTools.some(tool => tool.name === "nunc_memory_read"), "nunc_memory_read must not be registered when project overrides false");
  assert(!allTools.some(tool => tool.name === "nunc_memory_patch"), "nunc_memory_patch must not be registered when project overrides false");
  assert(!activeTools.includes("nunc_memory_read"));
  assert(!activeTools.includes("nunc_memory_patch"));
});

test("stock Pi settings: trusted project settings with nunc.memoryTools: true overrides global false", async t => {
  const f = await fixture({
    diskSettings: true,
    globalSettings: { nunc: { memoryTools: false } },
    projectSettings: { nunc: { memoryTools: true } },
    projectTrusted: true,
  });
  t.after(() => f.close());

  const allTools = f.runtime.session.getAllTools();
  const activeTools = f.runtime.session.getActiveToolNames();
  assert(allTools.some(tool => tool.name === "nunc_memory_read"), "nunc_memory_read must be registered when project overrides true");
  assert(allTools.some(tool => tool.name === "nunc_memory_patch"), "nunc_memory_patch must be registered when project overrides true");
  assert(activeTools.includes("nunc_memory_read"));
  assert(activeTools.includes("nunc_memory_patch"));
});

test("stock Pi settings: untrusted project settings with nunc.memoryTools: true does NOT take effect", async t => {
  const f = await fixture({
    diskSettings: true,
    globalSettings: { nunc: { memoryTools: false } },
    projectSettings: { nunc: { memoryTools: true } },
    projectTrusted: false,
  });
  t.after(() => f.close());

  const allTools = f.runtime.session.getAllTools();
  const activeTools = f.runtime.session.getActiveToolNames();
  assert(!allTools.some(tool => tool.name === "nunc_memory_read"), "untrusted project must not enable memory tools");
  assert(!allTools.some(tool => tool.name === "nunc_memory_patch"), "untrusted project must not enable memory tools");
  assert(!activeTools.includes("nunc_memory_read"));
  assert(!activeTools.includes("nunc_memory_patch"));
});

test("stock Pi settings: explicit CLI flag --nunc-memory-tools overrides project false and global false", async t => {
  const f = await fixture({
    diskSettings: true,
    globalSettings: { nunc: { memoryTools: false } },
    projectSettings: { nunc: { memoryTools: false } },
    projectTrusted: true,
    flagValues: [["nunc-memory-tools", "true"]],
  });
  t.after(() => f.close());

  const allTools = f.runtime.session.getAllTools();
  const activeTools = f.runtime.session.getActiveToolNames();
  assert(allTools.some(tool => tool.name === "nunc_memory_read"), "CLI flag must override settings false");
  assert(allTools.some(tool => tool.name === "nunc_memory_patch"), "CLI flag must override settings false");
  assert(activeTools.includes("nunc_memory_read"));
  assert(activeTools.includes("nunc_memory_patch"));
});

test("stock Pi settings: missing settings default to false", async t => {
  const f = await fixture({
    diskSettings: true,
    globalSettings: {},
    projectSettings: {},
    projectTrusted: true,
  });
  t.after(() => f.close());

  const allTools = f.runtime.session.getAllTools();
  const activeTools = f.runtime.session.getActiveToolNames();
  assert(!allTools.some(tool => tool.name === "nunc_memory_read"), "default must be off");
  assert(!allTools.some(tool => tool.name === "nunc_memory_patch"), "default must be off");
  assert(!activeTools.includes("nunc_memory_read"));
  assert(!activeTools.includes("nunc_memory_patch"));
});

test("stock Pi settings: non-boolean memoryTools string 'false' rejects with CONFIG error and does NOT enable tools", async t => {
  const f = await fixture({
    diskSettings: true,
    globalSettings: { nunc: { memoryTools: "false" } },
  });
  t.after(() => f.close());

  const allTools = f.runtime.session.getAllTools();
  assert(!allTools.some(tool => tool.name === "nunc_memory_read"), "string 'false' must not enable tools");
  assert(!allTools.some(tool => tool.name === "nunc_memory_patch"), "string 'false' must not enable tools");

  await f.runtime.session.prompt("Prompt testing invalid settings handling");
  const last = f.runtime.session.messages.at(-1);
  assert.equal(last?.role, "assistant");
  assert.equal(last?.stopReason, "error");
  assert.match(last?.errorMessage ?? "", /Nunc local CONFIG/);
  assert.match(last?.errorMessage ?? "", /expected boolean/);
});

test("stock Pi settings: non-object nunc in settings.json rejects with CONFIG error", async t => {
  const f = await fixture({
    diskSettings: true,
    globalSettings: { nunc: 123 },
  });
  t.after(() => f.close());

  await f.runtime.session.prompt("Prompt testing non-object nunc");
  const last = f.runtime.session.messages.at(-1);
  assert.equal(last?.role, "assistant");
  assert.equal(last?.stopReason, "error");
  assert.match(last?.errorMessage ?? "", /Nunc local CONFIG/);
  assert.match(last?.errorMessage ?? "", /must be an object/);
});

test("stock Pi settings: unknown keys in nunc reject with CONFIG error", async t => {
  const f = await fixture({
    diskSettings: true,
    globalSettings: { nunc: { memoryTools: true, unknownOption: "bad" } },
  });
  t.after(() => f.close());

  await f.runtime.session.prompt("Prompt testing unknown nunc key");
  const last = f.runtime.session.messages.at(-1);
  assert.equal(last?.role, "assistant");
  assert.equal(last?.stopReason, "error");
  assert.match(last?.errorMessage ?? "", /Nunc local CONFIG/);
  assert.match(last?.errorMessage ?? "", /Unknown global settings\.json: nunc\.unknownOption/);
});
