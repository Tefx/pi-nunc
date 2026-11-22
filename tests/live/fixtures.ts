import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { after } from "node:test";
import { homedir, tmpdir } from "node:os";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, realpath, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryCredentialStore, type Api, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parseInput, type RunInput } from "../../src/live/contract.js";
export const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export async function temporaryBaseline(ref = "70dacad"): Promise<string> {
  const parent = await mkdtemp(join(await realpath(tmpdir()), "nunc-baseline-"));
  const path = join(parent, "checkout");
  const hostHome = process.env.HOME ?? homedir();
  const nodeDirectories = [dirname(process.execPath), dirname(realpathSync(process.execPath))];
  const npmCli = [...nodeDirectories.flatMap(dir => [
    resolve(dir, "../lib/node_modules/npm/bin/npm-cli.js"),
    resolve(dir, "node_modules/npm/bin/npm-cli.js"),
  ]), "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js"].find(p => existsSync(p));
  const env = { ...process.env, NODE_OPTIONS: "", DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? "/Library/Developer/CommandLineTools",
    npm_config_cache: process.env.npm_config_cache ?? (existsSync(join(hostHome, ".npm")) ? join(hostHome, ".npm") : join(repository, ".npm-cache")),
    npm_config_update_notifier: "false" };
  let attached = false;
  const cleanup = async () => {
    try {
      if (attached) {
        execFileSync("/usr/bin/git", ["-C", repository, "worktree", "remove", "--force", path], { env, stdio: "pipe" });
        attached = false;
      }
    } finally { await rm(parent, { recursive: true, force: true }); }
  };
  after(cleanup);
  try {
    execFileSync("/usr/bin/git", ["-C", repository, "worktree", "add", "--detach", path, ref], { env, stdio: "pipe" });
    attached = true;
    const npmArgs = ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"];
    execFileSync(npmCli ? process.execPath : "npm", npmCli ? [npmCli, ...npmArgs] : npmArgs, { cwd: path, env, stdio: "pipe" });
    execFileSync(process.execPath, [join(repository, "node_modules/typescript/bin/tsc"), "--project", join(path, "tsconfig.json")], { cwd: path, env, stdio: "pipe" });
    return path;
  } catch (error) { await cleanup(); throw error; }
}
export async function temporaryState(): Promise<string> {
  const path = await mkdtemp(join(await realpath(tmpdir()), "nunc-test-state-"));
  after(() => rm(path, { recursive: true, force: true }));
  await mkdir(join(path, "host"), { recursive: true });
  await mkdir(join(path, "tmp"), { recursive: true });
  return path;
}
export async function nativeModels(...targets: Array<{ provider: string; id: string }>): Promise<Model<Api>[]> {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), refreshOnCreate: false, allowModelNetwork: false });
  if (runtime.getError()) throw new Error(runtime.getError());
  return targets.map(target => {
    const model = runtime.getModel(target.provider, target.id);
    if (!model) throw new Error(`native model missing: ${target.provider}/${target.id}`);
    return structuredClone(model);
  });
}
export function publicSelection(input: RunInput) {
  return { target: input.target, limits: input.limits, observations: input.observations ?? ["stock_rpc"], scenarios: input.scenarios.map(({ id, variant }) => ({ id, ...(variant ? { variant } : {}) })), overrides: [{ requirement: "controlled-host-regression", reason: "Named synthetic model/configuration for offline stock mechanics", model: { provider: input.models[0]!.provider, id: input.models[0]!.id }, ...(input.models[1] ? { smallerModel: { provider: input.models[1].provider, id: input.models[1].id } } : {}), config: input.scenarios[0]!.config }] };
}
export async function fixture(codex = false): Promise<RunInput> {
  const input = JSON.parse(await readFile(join(repository, codex ? "tests/live/preflight-codex-input.json" : "tests/live/preflight-input.json"), "utf8"));
  input.target.repository = repository;
  input.target.stateRoot = join(repository, ".scratch", `nunc-live-${randomUUID()}`);
  const stateRoot = input.target.stateRoot;
  after(() => rm(stateRoot, { recursive: true, force: true }));
  await mkdir(join(repository, ".scratch", "tmp"), { recursive: true });
  const parsed = parseInput(input);
  parsed.resolvedModels = await nativeModels(...parsed.models);
  return parsed;
}
