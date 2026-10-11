import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { assertPiContextCompatibility, assertSupportedPiVersion, isSupportedPiVersion, SUPPORTED_PI_RANGE } from "../../src/pi/compat.js";
import { EngineError } from "../../src/engine/validation.js";
import { textTokens } from "../../src/engine/accounting.js";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { fixture } from "./fixtures.js";

test("stable1.x minor and patch updates pass without release-specific changes", () => {
  assert.equal(SUPPORTED_PI_RANGE, "^1.0.3");
  for (const version of ["1.0.3", "1.0.4", "1.0.97", "1.1.0", "1.2.8", "1.99.0", "1.1.0+build.007", VERSION]) {
    assert.equal(isSupportedPiVersion(version), true, version);
    assert.doesNotThrow(() => assertSupportedPiVersion(version));
  }
  for (const version of [undefined, 1, "", "0.99.0", "1.0.2", "2.0.0", "1.1.0-beta.1", "1.1", "v1.1.0", "1.01.0", "1.0.03", "1.1.0+", "1.1.0\n", "1.1.0\r", "1.9007199254740992.0"]) {
    assert.equal(isSupportedPiVersion(version), false, String(version));
    assert.throws(() => assertSupportedPiVersion(version), (e: unknown) => e instanceof EngineError && e.code === "CONFIG");
  }
});

test("host-provided peers follow Pi packaging; development lock is a tested reproducible target", async () => {
  const pkg = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../../../package-lock.json", import.meta.url), "utf8"));
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
    assert.equal(pkg.peerDependencies[name], "*");
    assert.equal(pkg.dependencies?.[name], undefined, "host SDK is never a runtime dependency");
    assert(isSupportedPiVersion(pkg.devDependencies[name]));
    assert.equal(pkg.devDependencies[name], lock.packages[`node_modules/${name}`].version);
  }
});

test("actual host context exposes required public operations; missing APIs fail before mutation", async t => {
  let ctx!: ExtensionContext;
  const f = await fixture({ extras: [{ name: "compat-observer", factory(pi) {
    pi.on("session_start", (_event, c) => { ctx = c; });
  } }] }); t.after(() => f.close());
  assert.doesNotThrow(() => assertPiContextCompatibility(ctx));
  const before = f.runtime.session.sessionManager.getEntries().length;
  for (const [owner, name] of [["sessionManager", "buildContextEntries"], ["modelRegistry", "getProvider"]] as const) {
    const broken = Object.create(ctx[owner]) as Record<string, unknown>;
    broken[name] = undefined;
    assert.throws(() => assertPiContextCompatibility({ ...ctx, [owner]: broken }), (e: unknown) => e instanceof EngineError && e.code === "CONFIG" && e.message.includes(name));
  }
  assert.equal(f.runtime.session.sessionManager.getEntries().length, before);
  assert.equal(f.events.length, 0);
});

test("Nunc text estimates follow the imported SDK heuristic rather than a release-specific divisor", () => {
  for (const text of ["", "next", "user", "中文文本", "x".repeat(14000)]) assert.equal(textTokens(text), estimateTextTokens(text));
});
