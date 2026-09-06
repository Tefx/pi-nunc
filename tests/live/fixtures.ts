import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryCredentialStore, type Api, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parseInput, type RunInput } from "../../src/live/contract.js";
export const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
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
  input.target.repository = repository; input.target.stateRoot = join(repository, ".scratch", `nunc-live-${randomUUID()}`);
  await mkdir(join(repository, ".scratch", "tmp"), { recursive: true });
  const parsed = parseInput(input);
  parsed.resolvedModels = await nativeModels(...parsed.models);
  return parsed;
}
