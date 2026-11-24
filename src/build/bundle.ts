import { posix } from "node:path";
import ts from "typescript";

/** Bundle the extension's static local graph; standalone package exports stay untouched.
 * CommonJS factories preserve module scopes, re-export getters and cyclic imports.
 * Only host SDKs and Node builtins cross the resulting ESM unit's boundary.
 */
export function bundleExtension(outputs: ReadonlyMap<string, string>): string {
  const modules = new Map<string, { code: string; imports: Map<string, string> }>();
  const externals = new Map<string, string>();
  function visit(file: string): void {
    if (modules.has(file)) return;
    const text = outputs.get(file);
    if (text === undefined) throw new Error(`Bundle: missing local module ${file}`);
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const imports = new Map<string, string>();
    const module = { code: "", imports };
    modules.set(file, module);
    function scan(node: ts.Node): void {
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        throw new Error(`Bundle: dynamic module loading is unsupported in ${file}`);
      }
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const specifier = node.moduleSpecifier;
        if (specifier && ts.isStringLiteral(specifier)) {
          const name = specifier.text;
          if (name.startsWith("./") || name.startsWith("../")) {
            const target = posix.normalize(posix.join(posix.dirname(file), name));
            imports.set(name, target); visit(target);
          } else {
            if (!name.startsWith("node:") && !name.startsWith("@earendil-works/pi-")) throw new Error(`Bundle: unsupported external ${name}`);
            if (!externals.has(name)) externals.set(name, `__nuncExternal${externals.size}`);
          }
        }
      }
      ts.forEachChild(node, scan);
    }
    scan(source);
    module.code = ts.transpileModule(text, {
      fileName: file,
      compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.CommonJS, esModuleInterop: false, sourceMap: false },
      transformers: { before: [context => root => {
        const replace: ts.Visitor = node => ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression) && node.name.text === "url"
          ? context.factory.createIdentifier("__nuncBundleUrl") : ts.visitEachChild(node, replace, context);
        return ts.visitNode(root, replace) as ts.SourceFile;
      }] },
    }).outputText.replace(/^\/\/# sourceMappingURL=.*$/gm, "");
  }
  visit("index.js");
  return [
    "// Generated single-unit Pi extension. Rebuild with npm run build.",
    ...[...externals].map(([name, id]) => `import * as ${id} from ${JSON.stringify(name)};`),
    "const __nuncBundleUrl = import.meta.url;",
    "const __nuncFactories = {",
    ...[...modules].map(([file, module]) => `${JSON.stringify(file)}: (module, exports, require) => {\n${module.code}\n},`),
    "};",
    `const __nuncLinks = ${JSON.stringify(Object.fromEntries([...modules].map(([file, module]) => [file, Object.fromEntries(module.imports)])))};`,
    `const __nuncExternals = {${[...externals].map(([name, id]) => `${JSON.stringify(name)}: ${id}`).join(",")}};`,
    "const __nuncCache = new Map();",
    "function __nuncLoad(id) {",
    "  if (__nuncCache.has(id)) return __nuncCache.get(id).exports;",
    "  const module = { exports: {} };",
    "  __nuncCache.set(id, module);",
    "  __nuncFactories[id](module, module.exports, name => Object.hasOwn(__nuncExternals, name) ? __nuncExternals[name] : __nuncLoad(__nuncLinks[id][name]));",
    "  return module.exports;",
    "}",
    'export default __nuncLoad("index.js").default;',
    "",
  ].join("\n");
}
