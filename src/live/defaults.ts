import { SettingsManager, ProjectTrustStore, ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import { object, parseInput, requireValue, type RunInput } from "./contract.js";

/** Public stdin boundary. Native configuration is read-only; no auth API is called. */
export async function resolveInput(value: unknown, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Promise<RunInput> {
  requireValue(object(value) && Object.keys(value).every(k => ["target", "limits", "scenarios", "overrides", "observations", "comparison", "assets"].includes(k)), "INPUT", "Supply target, limits, scenarios and optional named overrides");
  requireValue(object(value.target) && object(value.limits) && Array.isArray(value.scenarios), "INPUT", "Actual target, limits and scenarios are required");
  const global = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false });
  const trusted = new ProjectTrustStore(getAgentDir()).get(cwd) ?? global.getDefaultProjectTrust() === "always";
  const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: trusted });
  requireValue(settings.drainErrors().length === 0, "CONFIG", "Native settings could not be resolved");
  // Shell tools publish these nonsecret values on every invocation, including
  // unsaved runtime choices. Standalone shells instead use saved Pi defaults.
  requireValue(Boolean(env.PI_PROVIDER) === Boolean(env.PI_MODEL), "MODEL", "Incomplete invoking runtime selection");
  let provider = env.PI_PROVIDER ?? settings.getDefaultProvider();
  let id = env.PI_MODEL ?? settings.getDefaultModel();
  let thinking = env.PI_REASONING_LEVEL ?? (provider && id ? settings.getModelThinkingLevel(provider, id) : undefined) ?? settings.getDefaultThinkingLevel() ?? "medium"; // Stock Pi 0.86.1 startup default.
  let second: { provider: string; id: string } | undefined;
  const differences: RunInput["overrides"] = [];
  let config: Record<string, unknown> = { nunc: {}, compaction: settings.getCompactionSettings() };
  const scopedConfigs = new Map<string, Record<string, unknown>>();
  const mergeConfig = (base: Record<string, unknown>, patch: Record<string, unknown>) => ({ ...base, ...patch,
    ...(object(patch.compaction) ? { compaction: { ...(object(base.compaction) ? base.compaction : {}), ...patch.compaction } } : {}) });
  if (value.overrides !== undefined) {
    requireValue(Array.isArray(value.overrides), "OVERRIDE", "Overrides must be named test requirements");
    for (const override of value.overrides) {
      requireValue(object(override) && Object.keys(override).every(k => ["requirement", "reason", "model", "smallerModel", "thinking", "config", "scenario", "extension", "compactionOwner", "memoryTools", "maintenanceThinking"].includes(k)) && typeof override.requirement === "string" && override.requirement.trim() && typeof override.reason === "string" && override.reason.trim(), "OVERRIDE", "Each override requires a named requirement and reason");
      if (override.memoryTools !== undefined) requireValue(typeof override.memoryTools === "boolean", "OVERRIDE", "Invalid memoryTools override");
      if (override.maintenanceThinking !== undefined) requireValue(typeof override.maintenanceThinking === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(override.maintenanceThinking), "OVERRIDE", "Invalid maintenanceThinking override");
      if (override.extension !== undefined) requireValue(override.requirement === "stable-memory-larva" && typeof override.extension === "string" && override.extension.startsWith("/"), "OVERRIDE", "Only stable-memory-larva accepts an explicit absolute extension path");
      if (override.compactionOwner !== undefined) requireValue(override.requirement === "stable-memory-larva" && typeof override.extension === "string" && override.compactionOwner === "nunc", "OVERRIDE", "compactionOwner requires explicit stable-memory-larva composition and must be nunc");
      if (override.scenario !== undefined) {
        requireValue(typeof override.scenario === "string" && value.scenarios.some(s => object(s) && `${s.id}${s.variant ? `/${s.variant}` : ""}` === override.scenario) &&
          object(override.config) && override.model === undefined && override.smallerModel === undefined && override.thinking === undefined && override.extension === undefined && override.compactionOwner === undefined && override.memoryTools === undefined && override.maintenanceThinking === undefined && !scopedConfigs.has(override.scenario),
          "OVERRIDE", "A scenario override must uniquely name a selected id[/variant] and contain only config");
        scopedConfigs.set(override.scenario, override.config);
        differences.push(structuredClone(override));
        continue;
      }
      const before = { provider, model: id, thinking, config: structuredClone(config) };
      for (const key of ["model", "smallerModel"] as const) if (override[key] !== undefined) {
        const model = override[key];
        requireValue(object(model) && Object.keys(model).every(k => ["provider", "id"].includes(k)) && typeof model.provider === "string" && typeof model.id === "string", "MODEL", "Model override supplies provider/id only");
        if (key === "model") { provider = model.provider; id = model.id; } else second = { provider: model.provider, id: model.id };
      }
      if (override.thinking !== undefined) { requireValue(typeof override.thinking === "string", "OVERRIDE", "Invalid thinking override"); thinking = override.thinking; }
      if (override.config !== undefined) { requireValue(object(override.config), "CONFIG", "Invalid config override"); config = mergeConfig(config, override.config); }
      differences.push({ ...structuredClone(override), from: before, to: { provider, model: id, thinking, config: structuredClone(config) } });
    }
  }
  requireValue(["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking), "CONFIG", "Invalid effective thinking level");
  requireValue(provider && id, "MODEL", "Native default model is unresolved; invoke from Pi's public shell context or save a Pi startup default");
  // Metadata-only public native model resolution. No host/session is constructed;
  // the real credential owner is never opened, checked or refreshed here.
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), refreshOnCreate: false, allowModelNetwork: false });
  requireValue(!runtime.getError(), "MODEL", "Native model configuration could not be resolved");
  const resolvedModels = [{ provider, id }, ...(second ? [second] : [])].map(target => {
    const model = runtime.getModel(target.provider, target.id);
    requireValue(model, "MODEL", "Effective model is absent from native metadata; no fallback account is selected");
    requireValue(!model.headers && !model.samplingParams, "MODEL", "Model header/sampling overrides require a supported native accounting contract");
    requireValue(typeof model.baseUrl === "string" && model.baseUrl.trim().length > 0, "MODEL", "Model endpoint is missing from native metadata");
    let url: URL | undefined;
    try { url = new URL(model.baseUrl); } catch { /* requireValue below names the missing field. */ }
    requireValue(url, "MODEL", "Model endpoint is not an absolute URL");
    requireValue(!url.username && !url.password && !url.search && !url.hash, "MODEL", "Model endpoint contains unsupported private or query data");
    return structuredClone(model);
  });
  // Validation above restricts the input to Pi's declared levels. Apply the same
  // public model-capability clamp as stock startup before recording metadata.
  thinking = clampThinkingLevel(resolvedModels[0]!, thinking as Parameters<typeof clampThinkingLevel>[1]);
  const models = resolvedModels.map(model => ({ provider: model.provider, id: model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens, baseUrl: model.baseUrl }));
  const observations = value.observations ?? ["continuation"];
  requireValue(Array.isArray(observations), "OBSERVATION", "Invalid observations");
  const offline = !observations.includes("continuation");
  const limits = { ...value.limits, maxCalls: value.limits.maxCalls ?? null, maxTotalTokens: value.limits.maxTotalTokens ?? null, maxOutputTokens: value.limits.maxOutputTokens ?? Math.max(...resolvedModels.map(model => model.maxTokens)), ...(value.limits.maxCostUsd === undefined && provider === "openai-codex" ? { maxCostUsd: null } : {}) };
  const input = parseInput({ version: 1,
    mode: offline ? "controlled" : "native",
    target: value.target, limits, models,
    effective: { thinking }, overrides: differences,
    scenarios: value.scenarios.map(s => {
      requireValue(object(s) && Object.keys(s).every(k => ["id", "variant", "assets"].includes(k)), "SCENARIO", "Scenario config belongs in a named override");
      const scoped = scopedConfigs.get(`${s.id}${s.variant ? `/${s.variant}` : ""}`);
      let selectedConfig = scoped ? mergeConfig(config, scoped) : config;
      if (s.id === "m4" && differences.some(o => o.requirement === "stable-memory-bounded-window")) {
        // Explicit observation control, derived once from native model metadata.
        // Same threshold in both variants; never calibrates the selected q.
        const h = 24000;
        requireValue(resolvedModels[0]!.contextWindow > h, "CONFIG", "Bounded m4 window requires contextWindow > 24000");
        selectedConfig = mergeConfig(selectedConfig, { compaction: { enabled: true, reserveTokens: resolvedModels[0]!.contextWindow - h, keepRecentTokens: 1 } });
        differences.push({ requirement: "resolved-stable-memory-window", reason: "Explicit 24000-token native threshold for the bounded m4 workload", scenario: `${s.id}/${s.variant}`, thresholdTokens: h, to: selectedConfig });
      }
      if (scoped) differences.push({ requirement: "resolved-scenario-config", reason: "Scenario config applied after shared overrides", scenario: `${s.id}${s.variant ? `/${s.variant}` : ""}`, from: config, to: selectedConfig });
      return { ...s, config: selectedConfig, ...(s.assets ? { assets: s.assets } : {}) };
    }),
    observations,
    ...(value.comparison ? { comparison: value.comparison } : {}),
    ...(value.assets ? { assets: value.assets } : {}),
  });
  input.effective = { source: env.PI_MODEL ? "invoking-runtime" : "standalone-defaults", provider, model: id, thinking, transport: settings.getTransport(), compaction: settings.getCompactionSettings(), settings: {
    compaction: settings.getCompactionSettings(), thinkingBudgets: settings.getThinkingBudgets(), transport: settings.getTransport(),
    retry: { ...settings.getRetrySettings(), provider: settings.getProviderRetrySettings() },
    steeringMode: settings.getSteeringMode(), followUpMode: settings.getFollowUpMode(), images: { autoResize: settings.getImageAutoResize(), blockImages: settings.getBlockImages() },
    httpIdleTimeoutMs: settings.getHttpIdleTimeoutMs(), websocketConnectTimeoutMs: settings.getWebSocketConnectTimeoutMs(),
  } };
  differences.push({ requirement: "bounded-observation", reason: "Finite HTTP effects and observer-only file-task inputs", transport: { from: settings.getTransport(), to: "sse" }, retries: { from: settings.getRetrySettings(), to: { enabled: false, maxRetries: 0 } }, tools: "read,write,edit", resources: "explicit observer/product extensions; no ambient context files" });
  input.resolvedModels = resolvedModels;
  input.overrides = differences;
  return input;
}
