import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import append, { SYNTHETIC_LAST_USER_APPEND } from "../../src/live/append.js";
import { payloadAppendEnabled } from "../../src/live/contract.js";
import { liveExtensionFlags } from "../../src/live/host.js";
import observer from "../../src/live/observer.js";
import { fixture } from "./fixtures.js";

test("payload-append override selects the tracked synthetic append extension", async () => {
  const input = await fixture();
  assert.equal(payloadAppendEnabled(input), false);
  assert.deepEqual(liveExtensionFlags("/repo", input), ["-e", "/repo/dist/src/live/observer.js", "-e", "/repo/dist/src/index.js"]);
  input.overrides = [{ requirement: "payload-append", reason: "Exercise last-user text append on the selected native route" }];
  assert.equal(payloadAppendEnabled(input), true);
  assert.deepEqual(liveExtensionFlags("/repo", input), [
    "-e", "/repo/dist/src/live/observer.js", "-e", "/repo/dist/src/live/append.js", "-e", "/repo/dist/src/index.js",
  ]);
});

test("live observer plus append callback injects synthetic last-user text without logging it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nunc-append-"));
  const events = join(dir, "events.jsonl");
  const ledger = join(dir, "calls.jsonl");
  const binding = join(dir, "observer.json");
  await writeFile(events, "");
  await writeFile(ledger, "");
  await writeFile(binding, JSON.stringify({
    input: { overrides: [{ requirement: "payload-append", reason: "synthetic" }] },
    models: [{ provider: "engine-test", id: "engine-test" }],
    deadline: Date.now() + 10_000,
    events,
    ledger,
    cwd: dir,
  }));
  const previous = process.env.NUNC_LIVE_OBSERVER;
  process.env.NUNC_LIVE_OBSERVER = binding;
  try {
    const handlers = new Map<string, Array<(event: { payload: unknown }) => unknown>>();
    const pi = {
      on(name: string, fn: (event: { payload: unknown }) => unknown) { (handlers.get(name) ?? handlers.set(name, []).get(name)!).push(fn); },
      events: { on() {} },
      registerProvider() {},
      registerCommand() {},
    };
    observer(pi as unknown as ExtensionAPI);
    append(pi as unknown as ExtensionAPI);
    let payload: unknown = { model: "engine-test", stream: true, messages: [{ role: "user", content: "hello" }] };
    for (const handler of handlers.get("before_provider_request") ?? []) {
      const next = handler({ payload });
      if (next !== undefined) payload = next;
    }
    assert.deepEqual((payload as { messages: Array<{ content: unknown }> }).messages[0]?.content, [
      { type: "text", text: "hello" }, { type: "text", text: SYNTHETIC_LAST_USER_APPEND },
    ]);
    const log = await readFile(events, "utf8");
    assert.doesNotMatch(log, /nunc-synthetic-last-user-append/);
    assert.match(log, /"mode":"observe"/);
  } finally {
    if (previous === undefined) delete process.env.NUNC_LIVE_OBSERVER;
    else process.env.NUNC_LIVE_OBSERVER = previous;
  }
});
