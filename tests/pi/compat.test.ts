import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DefaultResourceLoader, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import { assertPiContextCompatibility, assertSupportedPiVersion, isSupportedPiVersion, SUPPORTED_PI_RANGE } from "../../src/pi/compat.js";
import { EngineError } from "../../src/engine/validation.js";
import { calculateContextTokens, estimateContextTokens, estimateTextAndImageContentTokens, estimateTextTokens, textTokens } from "../../src/engine/accounting.js";
import { calculateContextTokens as sdkCalculateContextTokens, estimateContextTokens as sdkEstimateContextTokens, estimateTextAndImageContentTokens as sdkEstimateContentTokens, estimateTextTokens as sdkEstimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { normalizeContext, type Message, type TextContent, type ImageContent } from "@earendil-works/pi-ai";
import { answer, usage } from "../engine/fixtures.js";
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

test("Nunc text estimates preserve Pi's SDK heuristic", () => {
  for (const text of ["", "next", "user", "中文文本", "x".repeat(14000)]) {
    assert.equal(estimateTextTokens(text), sdkEstimateTextTokens(text));
    assert.equal(textTokens(text), sdkEstimateTextTokens(text));
  }
});

test("local content, usage and context estimates preserve Pi SDK semantics", () => {
  const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
  const contents: (string | Array<TextContent | ImageContent>)[] = [
    "", "small text", [], [image], [image, image],
    [{ type: "text", text: "short" }, image, { type: "text", text: "中文" }],
  ];
  for (const content of contents) assert.equal(estimateTextAndImageContentTokens(content), sdkEstimateContentTokens(content));
  for (const sample of [usage, { ...usage, totalTokens: 0 }, { ...usage, totalTokens: 999 }]) {
    assert.equal(calculateContextTokens(sample), sdkCalculateContextTokens(sample));
  }
  const system: Message = { role: "system", content: [{ type: "text", text: "Base." }],
    sections: { first: "Section.", removed: null }, timestamp: 10,
    toolsAdded: [{ name: "read", description: "Read text", parameters: { type: "object" } }],
    toolsRemoved: [{ name: "old" }] };
  const user: Message = { role: "user", content: [{ type: "text", text: "Ask" }, image], timestamp: 11 };
  const assistant = { ...answer(), timestamp: 12, content: [
    { type: "text", text: "Answer." }, { type: "thinking", thinking: "Consider.", thinkingSignature: "not-counted" },
    { type: "toolCall", id: "not-counted", name: "read", arguments: { path: "file.txt" } },
  ] } satisfies Message;
  const tool: Message = { role: "toolResult", toolCallId: "not-counted", toolName: "read", isError: false,
    content: [{ type: "text", text: "Result" }, image], timestamp: 13 };
  const zeroUsage = { ...usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const unserializable = { ...assistant, content: [{ type: "toolCall" as const, id: "call", name: "broken", arguments: {} }] };
  // Keep the fixture typed while exercising JSON.stringify's failure/undefined
  // branches using the same runtime serialization hooks real tool values can have.
  Object.defineProperty(unserializable.content[0]!.arguments, "toJSON", { value: () => circular, configurable: true });
  const cases: Message[][] = [
    [], [system], [user], [tool], [assistant],
    [system, user, { ...assistant, usage: zeroUsage }, tool],
    [system, user, assistant, tool],
    [system, user, { ...assistant, usage: { ...usage, totalTokens: 0 } }, tool],
    [system, { ...assistant, stopReason: "error" }, tool],
    [system, { ...assistant, stopReason: "aborted" }, tool],
    [{ ...system, timestamp: 20 }, user, assistant, tool], // inserted newer prefix invalidates usage
    [system, assistant, { ...assistant, usage: zeroUsage, timestamp: 14 }, tool], // retains earlier valid usage
    [assistant, { ...assistant, timestamp: 14, usage: { ...usage, totalTokens: 999 } }, tool],
    [unserializable, user, { ...assistant, usage: zeroUsage }],
  ];
  const compare = (messages: Message[]) => {
    assert.deepEqual(estimateContextTokens(messages), sdkEstimateContextTokens(messages));
    const context = normalizeContext({ messages });
    assert.deepEqual(estimateContextTokens(context), sdkEstimateContextTokens(context));
  };
  for (const messages of cases) compare(messages);
  // These must take the heuristic path so tool-call serialization is measured.
  compare([{ ...unserializable, usage: zeroUsage }]);
  Object.defineProperty(unserializable.content[0]!.arguments, "toJSON", { value: () => undefined });
  compare([{ ...unserializable, usage: zeroUsage }]);
});

const root = fileURLToPath(new URL("../../../", import.meta.url));
const builtSource = join(root, "dist/src");
const loaderModules = new Set([
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-tui",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-ai/compat",
  "@earendil-works/pi-ai/models",
  "@earendil-works/pi-ai/oauth",
  "@earendil-works/pi-ai/providers/all",
]);

test("built runtime Pi imports belong to the extension loader's exact virtual module allowlist", async () => {
  const files = (await readdir(builtSource, { recursive: true })).filter(file => file.endsWith(".js"));
  assert(files.length > 0, "scan the emitted runtime, not an empty directory");
  const imports: string[] = [];
  for (const file of files) {
    const source = ts.createSourceFile(file, await readFile(join(builtSource, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = (node: ts.Node): void => {
      const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
        : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require") ? node.arguments[0]
        : undefined;
      if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith("@earendil-works/")) {
        imports.push(specifier.text);
        assert(loaderModules.has(specifier.text), `${file}: unsupported Pi runtime module ${specifier.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert(imports.length > 0, "the built extension must exercise host module imports");
});

test("Pi loads the unpacked built extension outside the repository without local node_modules", async t => {
  const isolated = await realpath(await mkdtemp(join(tmpdir(), "nunc-loader-")));
  t.after(() => rm(isolated, { recursive: true, force: true }));
  assert(relative(await realpath(root), isolated).startsWith(`..${sep}`), "unpack outside the repository");
  const unpacked = join(isolated, "package");
  for (const path of ["package.json", "dist/src", "policies"]) {
    await cp(join(root, path), join(unpacked, path), { recursive: true });
  }
  // Check every potential ancestor search location, not just the package itself.
  for (let path = unpacked; ; path = dirname(path)) {
    await assert.rejects(lstat(join(path, "node_modules")), { code: "ENOENT" });
    if (path === dirname(path)) break;
  }
  const entry = join(unpacked, "dist/src/index.js");
  // This public resource loader delegates to Pi's loadExtensionsCached and its
  // host module aliases; no inline factory or mocked module resolver is involved.
  const loader = new DefaultResourceLoader({
    cwd: isolated, agentDir: join(isolated, "agent"), settingsManager: SettingsManager.inMemory({}),
    additionalExtensionPaths: [entry], noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  const extension = result.extensions[0]!;
  assert.equal(extension.resolvedPath, entry);
  assert(extension.flags.has("nunc-config"), "the real Nunc factory registered its flag");
  assert(extension.commands.has("nunc"), "the real Nunc factory registered its command");
  assert(extension.handlers.has("session_start"), "the real Nunc factory registered its lifecycle handler");
});
