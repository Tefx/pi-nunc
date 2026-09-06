import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fail = message => { console.error(`check: ${message}`); process.exit(1); };
const json = path => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const pkg = json("package.json");
const selected = process.argv.slice(2);
if (selected.length !== 1 || !["engine", "all"].includes(selected[0])) fail("Expected nonempty selection: engine or all.");
const version = readFileSync(resolve(root, ".node-version"), "utf8").trim();
if (process.versions.node !== version || pkg.engines.node !== version) fail(`Requires selected Node ${version}; found ${process.versions.node}`);
if (process.env.NODE_OPTIONS) fail("Unset NODE_OPTIONS for reproducible checks");
const lock = json("package-lock.json");
for (const name of Object.keys(pkg.devDependencies)) {
  const path = `node_modules/${name}/package.json`;
  if (!existsSync(resolve(root, path))) fail(`Missing local ${name}; install from package-lock.json separately`);
  const wanted = lock.packages?.[`node_modules/${name}`]?.version;
  if (!wanted || json(path).version !== wanted) fail(`Local ${name} differs from the tracked lock`);
}
const npmCli = "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js";
if (!existsSync(npmCli)) fail("Missing selected npm CLI; no automatic installation");
const npm = spawnSync(process.execPath, [npmCli, "--version"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: resolve(root, ".scratch/offline-home"), npm_config_cache: resolve(root, ".npm-cache"), npm_config_update_notifier: "false" } });
if (npm.status !== 0 || npm.stdout.trim() !== pkg.engines.npm) fail(`Requires npm ${pkg.engines.npm}; found ${npm.stdout?.trim() || npm.error || npm.status}`);
const tests = readdirSync(resolve(root, "tests"), { recursive: true }).filter(name => name.endsWith(".test.ts") && (selected[0] === "all" || name.startsWith("engine/"))).sort();
if (tests.length === 0) fail("Empty test selection");
if (selected[0] === "all") for (const suite of ["engine", "pi", "live"]) {
  if (!tests.some(name => name.startsWith(`${suite}/`))) fail(`Missing required ${suite} inventory`);
}
function run(args) {
  console.log(`> ${process.execPath} ${args.join(" ")}`);
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", env: { PATH: "/usr/bin:/bin", HOME: resolve(root, ".scratch/offline-home"), PI_CODING_AGENT_DIR: resolve(root, ".scratch/offline-agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" } });
  if (result.error || result.status !== 0) fail(`Command failed: ${result.error?.message ?? result.signal ?? result.status}`);
}
run([resolve(root, "node_modules/typescript/bin/tsc"), "--project", "tsconfig.json"]);
const compiled = tests.map(name => `dist/tests/${name.replace(/\.ts$/, ".js")}`);
for (const test of compiled) if (!existsSync(resolve(root, test))) fail(`Missing emitted test ${test}`);
run(["--test", ...compiled]);
console.log(`${selected[0]} checks completed (${tests.length} test files). ${selected[0] === "all" ? "Actual stock CLI/RPC/TUI, native transports/auth delegation and JSONL with controlled services; bounded preflight stdin included." : "Engine/model bridge with controlled service only."} Real-model task effectiveness remains separately authorized evidence.`);
