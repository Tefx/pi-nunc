import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxProvider, fauxAssistantMessage, InMemoryCredentialStore, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, createEventBus, SessionManager, SettingsManager, ModelRegistry, ModelRuntime, type CreateAgentSessionRuntimeFactory, type ToolDefinition, type InlineExtension } from "@earendil-works/pi-coding-agent";
import nunc from "pi-nunc";
import { bindHostSettings, type MaintenanceEvent, type NuncConfig } from "pi-nunc/pi";
import { sourceRecords, answer } from "../engine/fixtures.js";

const root = fileURLToPath(new URL("../../../", import.meta.url)); // emitted dist/tests/pi -> worktree
export const extensionPath = resolve(root, "dist/src/index.js");
export async function fixture(options: { config?: NuncConfig; enabled?: boolean; tools?: ToolDefinition[]; extras?: InlineExtension[]; ephemeral?: boolean; diskSettings?: boolean; publicFactory?: boolean } = {}) {
  const scratch = resolve(root, ".scratch"); await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, "pi-"));
  const cwd = join(dir, "work"), agentDir = join(dir, "agent"), sessionDir = join(dir, "sessions");
  await Promise.all([cwd, agentDir, sessionDir].map(path => mkdir(path)));
  const configFile = join(dir, "nunc.json");
  const config: NuncConfig = { rolling: { keepRecentFraction: 0.25 }, ...options.config };
  await writeFile(configFile, JSON.stringify(config));
  const settings = SettingsManager.inMemory({ compaction: { enabled: options.enabled ?? false, reserveTokens: 36000, keepRecentTokens: 1 }, retry: { enabled: false, provider: { maxRetries: 0 } } });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  if (options.diskSettings) {
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: settings.getCompactionSettings() }));
    process.env.PI_CODING_AGENT_DIR = agentDir; // Process-local isolated CLI settings selection.
  }
  const faux = fauxProvider({ api: "openai-completions", provider: "nunc-pi-fixture", models: [{ id: "large", reasoning: true, input: ["text", "image"], contextWindow: 60000, maxTokens: 8192 }, { id: "small", contextWindow: 45000, maxTokens: 8192 }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  new ModelRegistry(modelRuntime).registerProvider(faux.provider);
  const calls: Parameters<FauxResponseFactory>[0][] = [];
  const events: MaintenanceEvent[] = [];
  const errors: string[] = [];
  let responder: FauxResponseFactory = context => {
    const sources = sourceRecords(context);
    return fauxAssistantMessage(sources.length ? JSON.stringify({ add: [{ key: "fact", text: "Preserved test constraint." }], remove: [], priority: ["fact"], required: ["fact"] }) : "Task response.");
  };
  faux.setResponses(Array.from({ length: 80 }, () => (context, opts, state, model) => { calls.push(structuredClone({ ...context, ...(context.tools ? { tools: context.tools.map(({ name, description, parameters }) => ({ name, description, parameters })) } : {}) })); return responder(context, opts, state, model); }));
  const factory: CreateAgentSessionRuntimeFactory = async target => {
    const bus = createEventBus();
    bus.on("nunc:maintenance", data => events.push(data as MaintenanceEvent));
    const services = await createAgentSessionServices({ ...target, settingsManager: settings, modelRuntime, extensionFlagValues: new Map([["nunc-config", configFile]]), resourceLoaderOptions: {
      eventBus: bus, additionalExtensionPaths: options.publicFactory ? [] : [extensionPath], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: "Perform the current task.", extensionFactories: [...(options.publicFactory ? [{ name: "nunc-public", factory: nunc }] : []), ...(options.extras ?? [])],
    } });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    if (!options.publicFactory) assert.equal(services.resourceLoader.getExtensions().extensions.filter(e => e.path === extensionPath).length, 1);
    const created = await createAgentSessionFromServices({ services, sessionManager: target.sessionManager, ...(target.sessionStartEvent ? { sessionStartEvent: target.sessionStartEvent } : {}), model: faux.getModel(), thinkingLevel: "off", tools: (options.tools ?? []).map(t => t.name), ...(options.tools ? { customTools: options.tools } : {}) });
    if (!options.diskSettings) bindHostSettings(bus, settings);
    await created.session.bindExtensions({ mode: "json", onError: error => errors.push(error.error) });
    return { ...created, services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager: options.ephemeral ? SessionManager.inMemory(cwd) : SessionManager.create(cwd, sessionDir) });
  return { dir, cwd, agentDir, sessionDir, configFile, config, settings, faux, runtime, modelRuntime, events, calls, errors,
    respond(fn: FauxResponseFactory) { responder = fn; },
    seed(label = "old") {
      const manager = runtime.session.sessionManager;
      const first = manager.appendMessage({ role: "user", content: label + ":" + "a".repeat(48000), timestamp: 0 });
      manager.appendMessage(answer({}, faux.getModel()));
      const kept = manager.appendMessage({ role: "user", content: "Recent work " + label + ":" + "b".repeat(8800), timestamp: 1 });
      const last = manager.appendMessage({ ...answer({}, faux.getModel()), timestamp: 1 });
      runtime.session.agent.state.messages = manager.buildSessionContext().messages;
      return { first, kept, last };
    },
    async close() {
      try { await runtime.dispose(); assert.deepEqual(errors, []); }
      finally {
        if (options.diskSettings) {
          if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
          else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        }
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
export function memoryPatch(context: Parameters<FauxResponseFactory>[0]) {
  const text = "Preserved test constraint.";
  const records = context.messages.flatMap(m => typeof m.content === "string" ? [] : m.content.flatMap(b => {
    if (b.type !== "text") return [];
    try { return [JSON.parse(b.text) as Record<string, unknown>]; } catch { return []; }
  }));
  const source = records.find(r => r.M);
  const slots = (source?.M ?? []) as { id: string; text: string }[];
  return fauxAssistantMessage(JSON.stringify(slots.length ? { add: [], remove: [], priority: slots.map(s => s.id), required: [] } : { add: [{ key: "fact", text }], remove: [], priority: ["fact"], required: ["fact"] }));
}
