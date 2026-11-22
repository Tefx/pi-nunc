import { spawn, execFileSync, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync, chmodSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import { isSupportedPiVersion } from "../pi/compat.js";
import { isDeepStrictEqual } from "node:util";
import { projectedNativeCut } from "./preparation.js";
import { isSystemMessage } from "../engine/accounting.js";
import { getCurrentSystemPrompt, getCurrentTools, type Api, type Context, type Model } from "@earendil-works/pi-ai";
import { SessionManager, sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { object, requireValue, within, RunnerError, type RunConfig, type RunInput, type Selection } from "./contract.js";
export function liveExtensionFlags(repository: string, input: RunInput): string[] {
  const flags = ["-e", join(repository, "dist/src/live/observer.js")];
  const larva = input.overrides?.find(o => o.requirement === "stable-memory-larva");
  if (larva) {
    requireValue(typeof larva.extension === "string" && existsSync(larva.extension), "EXTENSION", "Explicit Larva extension is unavailable");
    flags.push("-e", larva.extension, "--larva-agent-persona-switch", "manual");
  }
  return flags;
}
import type { Control, ToolTrigger } from "./scenarios.js";

export interface NativeRpcDiagnostic {
  command: string;
  stage: "native-prehook" | "native-rpc";
  reason: "no-retirable-prefix" | "already-compacted" | "compaction-cancelled" | "unknown";
}
export class NativeRpcError extends RunnerError {
  constructor(readonly diagnostic: NativeRpcDiagnostic) {
    super("RPC", `Native ${diagnostic.command} failed: ${diagnostic.reason}`);
  }
}
/** Exact stock errors only; never retain exception bodies, even for unknown auth/RPC failures. */
export function nativeRpcError(command: string, error: unknown): NativeRpcError {
  const reason = command !== "compact" ? "unknown" : error === "Nothing to compact (session too small)" ? "no-retirable-prefix"
    : error === "Already compacted" ? "already-compacted" : error === "Compaction cancelled" ? "compaction-cancelled" : "unknown";
  return new NativeRpcError({ command, reason, stage: reason === "no-retirable-prefix" || reason === "already-compacted" ? "native-prehook" : "native-rpc" });
}
/** Public cut arithmetic corroborates the captured stock no-work response. */
export function noRetirablePrefix(branch: SessionEntry[], settings: RunConfig["compaction"]): boolean {
  if (branch.at(-1)?.type === "compaction") return true;
  const previous = branch.findLast(e => e.type === "compaction");
  const start = previous?.type === "compaction" ? branch.findIndex(e => e.id === previous.firstKeptEntryId) : 0;
  if (start < 0) return false;
  const cut = projectedNativeCut(branch, settings.keepRecentTokens);
  return !branch.slice(start, cut?.firstKeptEntryIndex ?? start).some(e => e.type !== "compaction" && !(e.type === "message" && isSystemMessage(e.message)) && sessionEntryToContextMessages(e).filter(m => m.role !== "system").length > 0);
}
/** A captured no-work response alone is insufficient: reconcile source, native cut and effects. */
export function ordinaryNoWork(error: unknown, facts: {
  defaults: boolean; before: SessionEntry[]; after: SessionEntry[]; settings: RunConfig["compaction"];
  newPreparations: number; newMaintenance: number; newRequests: number; unresolved: number;
  isCompacting: boolean; pendingMessageCount: number;
}): boolean {
  return error instanceof NativeRpcError && ["no-retirable-prefix", "already-compacted"].includes(error.diagnostic.reason) &&
    facts.defaults && isDeepStrictEqual(facts.before, facts.after) &&
    facts.newPreparations === 0 && facts.newMaintenance === 0 && facts.newRequests === 0 && facts.unresolved === 0 &&
    !facts.isCompacting && facts.pendingMessageCount === 0 && noRetirablePrefix(facts.after, facts.settings);
}
export interface HostOptions {
  repository: string; input: RunInput; selection: Selection; caseRoot: string; modelTargets: Model<Api>[];
  deadline: number; signal: AbortSignal; sessionFile?: string | undefined;
  group?: "native" | "current" | "candidate" | undefined;
  mode?: "defaults" | "matched" | undefined;
  targetRepos?: { native?: string | undefined; current?: string | undefined; candidate?: string | undefined } | undefined;
  /** Test-only native models.json overlay; it replaces the service endpoint, never the host or Provider. */
  controlledModels?: unknown;
  /** Test-only child replacement. Production always uses the locked stock Pi CLI. */
  testCommand?: { command: string; args: string[] } | undefined;
  /** Test-only extra `-e` paths after the production composition. */
  testExtensions?: string[] | undefined;
  onMaintenance?: ((event: unknown) => void) | undefined;
  onMaintenanceResponse?: ((event: unknown) => void) | undefined;
  onContext?: ((model: Model<Api>, context: Context, kind: string) => void) | undefined;
  onAction?: ((event: unknown) => void) | undefined;
  boundaries?: Array<{ control: Control; requestText: string; fixtureContent: string }> | undefined;
  verification?: { script: string; artifact: string } | undefined;
  taskFiles?: Record<string, string> | undefined;
  guidanceControls?: Array<{ action: "revision_conflict" | "unconfirmed_save"; requestText: string; turn?: string | undefined; trigger?: ToolTrigger | undefined }> | undefined;
  boundaryCompleted?: boolean | undefined;
  priorLedgers?: string[] | undefined;
  onBoundary?: ((data: any) => Promise<void>) | undefined;
  onBoundaryRestore?: (() => Promise<void>) | undefined;
  onObservation?: ((type: string, data: any) => void) | undefined;
}
export function childEnvironment(state: string): NodeJS.ProcessEnv {
  return { HOME: join(state, "home"), PI_CODING_AGENT_DIR: join(state, "host"), TMPDIR: join(state, "tmp"),
    XDG_CONFIG_HOME: join(state, "xdg/config"), XDG_CACHE_HOME: join(state, "xdg/cache"), XDG_DATA_HOME: join(state, "xdg/data"),
    PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin`, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", NO_COLOR: "1" };
}
/** Native owner configuration/auth stays inherited, only task scratch is redirected. */
export function nativeEnvironment(state: string): NodeJS.ProcessEnv {
  const { NODE_OPTIONS: _node, PI_SESSION_ID: _session, PI_SESSION_FILE: _file, ...env } = process.env;
  // A new task must not inherit a parent's active Larva persona/session/model
  // route or child controls. Native Pi model/auth settings remain inherited.
  for (const key of Object.keys(env)) if (key.startsWith("LARVA_")) delete env[key];
  return { ...env, TMPDIR: join(state, "tmp"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", NO_COLOR: "1" };
}
/** Darwin can deny group signals even though owned descendants remain signalable. */
function signalPid(pid: number, signal: NodeJS.Signals | 0): boolean {
  try { process.kill(pid, signal); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM" && process.platform === "darwin") return signal === 0;
    throw error;
  }
}
function processFamily(pid: number, group: boolean): number[] {
  const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid="], { encoding: "utf8" }).trim().split("\n")
    .map(row => row.trim().split(/\s+/).map(Number));
  const family = new Set([pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [id, parent, pgid] of rows) if (id && id !== process.pid && !family.has(id) && (family.has(parent!) || group && pgid === pid)) {
      family.add(id); changed = true;
    }
  }
  return [...family].reverse();
}
export function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals | 0): boolean {
  if (!pid) return false;
  try { process.kill(-pid, signal); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && !(code === "EPERM" && process.platform === "darwin")) throw error;
    return processFamily(pid, true).map(id => signalPid(id, signal)).some(Boolean);
  }
}
/** Settle the owned group even after its leader exits with all stdio closed. */
export async function settleProcessGroup(pid: number | undefined): Promise<void> {
  if (!pid || !signalProcessGroup(pid, "SIGTERM")) return;
  const deadline = Date.now() + 100;
  while (signalProcessGroup(pid, 0)) {
    if (Date.now() >= deadline) { signalProcessGroup(pid, "SIGKILL"); return; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
/** Shared worker/stock ownership: settle descendants on exit, not just pipe close. */
export function superviseProcess(command: string, args: string[], options: SpawnOptions, deadline: number, signal: AbortSignal,
  started: (child: ChildProcess) => void): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean }> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, detached: true });
    let timedOut = false, hard: NodeJS.Timeout | undefined, cleanup: Promise<void> | undefined;
    const stop = () => {
      if (hard) return;
      timedOut = true;
      hard = setTimeout(() => signalProcessGroup(child.pid, "SIGKILL"), 2000);
      signalProcessGroup(child.pid, "SIGTERM");
    };
    const timer = setTimeout(stop, Math.max(1, deadline - Date.now()));
    signal.addEventListener("abort", stop, { once: true });
    const settle = () => {
      clearTimeout(timer); if (hard) clearTimeout(hard); signal.removeEventListener("abort", stop);
      return cleanup ??= settleProcessGroup(child.pid);
    };
    child.once("exit", () => { void settle().catch(reject); });
    child.once("error", error => { void settle().then(() => reject(error), reject); });
    child.once("close", (exitCode, exitSignal) => { void settle().then(() => resolve({ exitCode, signal: exitSignal, timedOut }), reject); });
    try { started(child); } catch (error) { stop(); void settle().then(() => reject(error), reject); }
    if (signal.aborted) stop();
  });
}
/** A protocol client and read-only native session view. Stock Pi owns every write/run/retry. */
export class NativeHost {
  readonly session = this;
  readonly sessionManager = {
    getBranch: (): SessionEntry[] => this.saved()?.getBranch() ?? [],
    buildContextEntries: (): SessionEntry[] => this.saved()?.buildContextEntries() ?? [],
    getSessionId: (): string => this.sessionId,
    getLeafId: (): string | null => this.saved()?.getLeafId() ?? null,
  };
  readonly fixed: { systemPrompt: string; tools: NonNullable<Context["tools"]> } = { systemPrompt: "", tools: [] };
  model: Model<Api> | undefined;
  sessionFile: string | undefined;
  sessionId = "";
  pid: number | undefined;
  private child!: ChildProcessWithoutNullStreams;
  private readonly changed = new EventEmitter();
  private readonly pending = new Map<string, { command: string; resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly events: Array<Record<string, unknown>> = [];
  private cursor = 0;
  private output = "";
  private bytes = 0;
  private exited = false;
  private closed: Promise<void> = Promise.resolve();
  private serial = 0;
  private killTimer: NodeJS.Timeout | undefined;
  private watch: NodeJS.Timeout | undefined;
  private failure: { code: string; message: string } | undefined;
  readonly commands: Array<{ type: string; message?: string }> = [];
  // IPC workers already own a detached group. Keep the native host inside it so
  // supervisor cleanup still reaches it if the worker dies without finally.
  private readonly detached = typeof process.send !== "function";
  private kill(signal: NodeJS.Signals): void {
    if (!this.pid) return;
    if (this.detached) signalProcessGroup(this.pid, signal);
    else for (const pid of processFamily(this.pid, false)) signalPid(pid, signal);
  }
  private readonly abort = () => {
    if (this.killTimer) return;
    this.killTimer = setTimeout(() => this.kill("SIGKILL"), 1000);
    this.kill("SIGTERM");
  };
  private fail(code: string, message: string): void { this.failure ??= { code, message }; this.abort(); }
  private hostError(code = "HOST_EXIT", message = "Native host exited"): RunnerError { return new RunnerError(this.failure?.code ?? code, this.failure?.message ?? message); }
  constructor(readonly options: HostOptions) {}
  private saved(): SessionManager | undefined { return this.sessionFile && existsSync(this.sessionFile) ? SessionManager.open(this.sessionFile) : undefined; }
  get messages() { return this.saved()?.buildSessionContext().messages ?? []; }
  async start(): Promise<this> {
    const o = this.options, state = o.input.target.stateRoot, cwd = join(o.caseRoot, "task"), host = join(state, "host");
    for (const path of [join(state, "tmp"), join(o.caseRoot, "sessions")]) await mkdir(path, { recursive: true });
    if (o.controlledModels) for (const path of [host, join(state, "home")]) await mkdir(path, { recursive: true });
    const config = join(o.caseRoot, "nunc-config.json"), binding = join(o.caseRoot, "observer-binding.json");
    if (o.group !== "native") await writeFile(config, JSON.stringify(o.selection.config.nunc), { mode: 0o600 });
    const memoryToolsOverride = o.input.overrides?.find(ov => ov.requirement === "memory-tools-off" || ov.requirement === "memory-tools-on" || ov.memoryTools !== undefined);
    const memoryToolsExplicitOff = memoryToolsOverride?.requirement === "memory-tools-off" || memoryToolsOverride?.memoryTools === false;
    const memoryToolsEnabled = (o.selection.id.startsWith("g") || o.selection.id.startsWith("m")) && !memoryToolsExplicitOff;
    const taskSettings = { ...o.input.effective?.settings, nunc: { memoryTools: memoryToolsEnabled && o.group !== "native",
      ...(o.selection.id === "m5" ? { toolResultCleanup: o.selection.variant === "cleanup-on" } : {}) }, compaction: o.selection.config.compaction, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } }, transport: "sse", packages: [], extensions: [], skills: [], prompts: [], themes: [], enableSkillCommands: false };
    if (o.controlledModels) await writeFile(join(host, "settings.json"), JSON.stringify(taskSettings), { mode: 0o600 });
    else if (!o.sessionFile) {
      // Only this newly created task's narrow nonsecret settings overlay. Native
      // global settings/auth are neither copied nor rewritten.
      await mkdir(join(cwd, ".pi"), { mode: 0o700 });
      await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify(taskSettings), { mode: 0o600, flag: "wx" });
    }
    if (o.controlledModels) await writeFile(join(host, "models.json"), JSON.stringify(o.controlledModels), { mode: 0o600 });
    const larva = o.input.overrides?.find(row => row.requirement === "stable-memory-larva");
    let larvaCompaction: { owner: "nunc"; configFile: string } | undefined;
    if (larva?.compactionOwner === "nunc") {
      requireValue(o.group !== "native" && o.group !== "current" && o.selection.id.startsWith("m"), "EXTENSION", "Task-local Larva compaction setup requires the selected Nunc candidate");
      const configFile = join(o.caseRoot, "larva-compaction.json");
      await writeFile(configFile, JSON.stringify({ enabled: false }), { mode: 0o600, flag: "wx" });
      larvaCompaction = { owner: "nunc", configFile };
    }
    const events = join(o.caseRoot, `events-${process.pid}-${Date.now()}.jsonl`);
    await writeFile(events, "", { mode: 0o600, flag: "wx" });
    const caseKey = o.input.comparison
      ? `${o.mode ?? "defaults"}:${o.group ?? "candidate"}:${o.selection.id}${o.selection.variant ? `-${o.selection.variant}` : ""}`
      : `${o.selection.id}${o.selection.variant ? `-${o.selection.variant}` : ""}`;
    const boundaries = o.boundaries ?? [];
    const productRepository = o.group === "current" ? o.targetRepos?.current ?? o.input.comparison?.targets.current.repository ?? o.repository
      : o.targetRepos?.candidate ?? o.input.comparison?.targets.candidate.repository ?? o.repository;
    const productExtension = o.group === "native" ? undefined : join(productRepository, "dist/src/index.js");
    await writeFile(binding, JSON.stringify({ productExtension, input: o.input, models: o.modelTargets, deadline: o.deadline, events, ledger: join(state, "calls.jsonl"), cwd, caseKey, selection: o.selection, taskFiles: o.taskFiles, larvaCompaction, boundaries, boundaryCompleted: o.boundaryCompleted, verification: o.verification, guidanceControls: o.guidanceControls, memoryLayout: o.selection.id === "m1" && o.selection.variant === "moving" ? "moving" : "stable", priorLedgers: o.priorLedgers ?? [] }), { mode: 0o600 });
    this.eventsFile = events;
    const model = o.modelTargets[0]; requireValue(model, "MODEL", "No authorized model");
    const hostRepo = o.group === "current" ? (o.targetRepos?.current ?? o.input.comparison?.targets?.current?.repository ?? o.repository) : (o.group === "native" ? (o.targetRepos?.native ?? o.input.comparison?.targets?.native?.repository ?? o.repository) : o.repository);
    const packageDir = join(hostRepo, "node_modules/@earendil-works/pi-coding-agent");
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { bin: { pi: string } };
    const cli = join(packageDir, manifest.bin.pi);
    let groupHasMemoryTools = false;
    if (memoryToolsEnabled) {
      if (o.group === "candidate" || o.group === undefined) {
        groupHasMemoryTools = true;
      } else if (o.group === "current") {
        const curRepo = o.targetRepos?.current ?? o.input.comparison?.targets?.current?.repository ?? o.repository;
        try {
          // The supported pre-change .86 target exposes this flag; the historical .85 fixture does not.
          const pkg = JSON.parse(readFileSync(join(curRepo, "package-lock.json"), "utf8"));
          const version = pkg.packages?.["node_modules/@earendil-works/pi-coding-agent"]?.version;
          groupHasMemoryTools = version === "0.86.1" || isSupportedPiVersion(version);
        } catch {
          groupHasMemoryTools = false;
        }
      }
    }

    const tools = groupHasMemoryTools ? "read,write,edit,bash,nunc_memory_read,nunc_memory_patch" : "read,write,edit,bash";
    const memoryToolsFlags = groupHasMemoryTools ? ["--nunc-memory-tools"] : [];
    const args = o.testCommand?.args ?? [cli, "--offline", "--approve", "--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--provider", model.provider, "--model", model.id, "--thinking", o.input.effective?.thinking ?? "off", "--tools", tools, "--system-prompt", "Carry out the user's tasks using the available file tools. Work only in the current task directory. Preserve unfinished work when the topic changes. If evidence is insufficient, state uncertainty.", ...memoryToolsFlags, ...liveExtensionFlags(o.repository, o.input), ...(o.testExtensions ?? []).flatMap(path => ["-e", path]), ...(o.group === "native" ? [] : ["--nunc-config", config]), "--session-dir", join(o.caseRoot, "sessions"), ...(o.sessionFile ? ["--session", o.sessionFile] : [])];
    this.child = spawn(o.testCommand?.command ?? process.execPath, args, { cwd, env: { ...(o.controlledModels ? childEnvironment(state) : nativeEnvironment(state)), ...(larvaCompaction ? { LARVA_PI_COMPACTION_CONFIG_FILE: larvaCompaction.configFile } : {}), NUNC_LIVE_OBSERVER: binding }, detached: this.detached, stdio: ["pipe", "pipe", "pipe"] });
    this.pid = this.child.pid;
    this.child.stdin.on("error", () => this.abort());
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (buffer: string) => {
      this.bytes += Buffer.byteLength(buffer);
      if (this.bytes > 32_000_000) { this.fail("OUTPUT", "Native host output exceeded the bound"); return; }
      this.output += buffer.toString(); let end: number;
      while ((end = this.output.indexOf("\n")) >= 0) {
        const line = this.output.slice(0, end); this.output = this.output.slice(end + 1);
        try {
          const e: unknown = JSON.parse(line); if (!object(e)) continue;
          if (e.type === "response" && typeof e.id === "string") {
            const pending = this.pending.get(e.id); this.pending.delete(e.id);
            if (e.success === false && pending) pending.reject(nativeRpcError(pending.command, e.error)); else pending?.resolve(e.data);
          } else this.events.push(e);
          this.changed.emit("event");
        } catch { this.fail("HOST_RPC", "Native host RPC output was not valid JSON"); }
      }
    });
    // Never retain auth/provider error bodies. The bounded provider reports codes/usage separately.
    this.child.stderr.on("data", (buffer: Buffer) => { this.bytes += buffer.length; if (this.bytes > 32_000_000) this.fail("OUTPUT", "Native host output exceeded the bound"); });
    this.closed = new Promise<void>(resolve => {
      const end = () => {
        this.exited = true; for (const p of this.pending.values()) p.reject(this.hostError());
        this.pending.clear(); this.changed.emit("event"); resolve();
      };
      this.child.once("error", end); this.child.once("close", end);
    });
    o.signal.addEventListener("abort", this.abort, { once: true }); if (o.signal.aborted) this.abort();
    this.watch = setInterval(() => {
      try { this.drain(); this.changed.emit("event"); }
      catch (error) {
        if (error instanceof RunnerError) this.fail(error.code, error.message);
        else this.fail("OBSERVER", "Observer evidence drain failed");
      }
    }, 25);
    await this.restoreAuthorizedStartupModel(); await this.refresh(); return this;
  }
  private async restoreAuthorizedStartupModel(): Promise<void> {
    const authorized = this.options.modelTargets[0];
    requireValue(authorized, "MODEL", "No authorized model");
    const state = await this.command("get_state");
    requireValue(object(state) && typeof state.sessionId === "string", "RPC", "Invalid native session state");
    const selected = object(state.model) ? state.model : undefined;
    if (!selected || !this.options.modelTargets.some(m => m.provider === selected.provider && m.id === selected.id)) {
      await this.command("set_model", { provider: authorized.provider, modelId: authorized.id });
    }
    const desiredThinking = this.options.input.effective?.thinking;
    if (desiredThinking && desiredThinking !== "off" && (state as any).thinkingLevel !== desiredThinking) {
      try {
        await this.command("set_thinking_level", { level: desiredThinking });
      } catch {}
    }
  }
  private eventsFile = "";
  private drain(): void {
    const data = readFileSync(this.eventsFile, "utf8");
    requireValue(data.length <= 64_000_000, "OUTPUT", "Observer evidence limit reached");
    const rows = data.slice(this.cursor).split("\n"); rows.pop();
    for (const row of rows) {
      this.cursor += row.length + 1;
      const e: unknown = JSON.parse(row); requireValue(object(e), "OBSERVER", "Invalid observer record");
      this.options.onObservation?.(String(e.type), e.data);
      if (e.type === "tool-boundary") void this.options.onBoundary?.(e.data).catch(() => this.fail("PREPARATION", "Boundary coordination failed"));
      if (e.type === "boundary-restore") void this.options.onBoundaryRestore?.().catch(() => this.fail("PREPARATION", "Boundary configuration restoration failed"));
      if (e.type === "maintenance") this.options.onMaintenance?.(e.data);
      if (e.type === "maintenance_response") this.options.onMaintenanceResponse?.(e.data);
      if (e.type === "action") this.options.onAction?.(e.data);
      if (e.type === "lifecycle" || e.type === "memory_state") {
        requireValue(object(e.data), "OBSERVER", "Invalid lifecycle/memory observation");
        this.options.onAction?.({ ...e.data, type: e.type });
      }
      if (e.type === "context") {
        requireValue(object(e.data) && object(e.data.model) && object(e.data.context) && Array.isArray(e.data.context.messages), "OBSERVER", "Invalid observed context");
        const observedModel = e.data.model;
        const model = this.options.modelTargets.find(m => m.provider === observedModel.provider && m.id === observedModel.id);
        requireValue(model, "MODEL", "Observed model outside authorization");
        const context = e.data.context as unknown as Context;
        if (e.data.kind === "main") {
          const prompt = ("systemPrompt" in context && typeof context.systemPrompt === "string") ? context.systemPrompt : getCurrentSystemPrompt(context.messages);
          const tools = ("tools" in context && Array.isArray(context.tools)) ? context.tools : getCurrentTools(context.messages);
          this.fixed.systemPrompt = prompt;
          this.fixed.tools = tools;
        }
        this.options.onContext?.(model, context, String(e.data.kind));
      }
    }
  }
  async command(type: string, values: Record<string, unknown> = {}): Promise<unknown> {
    this.options.signal.throwIfAborted(); requireValue(!this.exited, this.failure?.code ?? "HOST_EXIT", this.failure?.message ?? "Native host unavailable");
    if (["prompt", "steer", "compact", "clear_queue", "abort"].includes(type)) this.commands.push({ type, ...(typeof values.message === "string" ? { message: values.message } : {}) });
    const id = String(++this.serial);
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { command: type, resolve, reject }));
    this.child.stdin.write(JSON.stringify({ id, type, ...values }) + "\n");
    return result;
  }
  async refresh(): Promise<void> {
    const state = await this.command("get_state");
    requireValue(object(state) && typeof state.sessionId === "string", "RPC", "Invalid native session state");
    this.sessionId = state.sessionId;
    if (typeof state.sessionFile === "string") { requireValue(within(state.sessionFile, join(this.options.caseRoot, "sessions")), "PERSISTENCE", "Native session escaped isolated target"); this.sessionFile = state.sessionFile; }
    if (object(state.model)) { const selected = state.model; this.model = this.options.modelTargets.find(m => m.provider === selected.provider && m.id === selected.id); }
    requireValue(this.model, "MODEL", "Native fallback or saved model outside authorization"); this.drain();
  }
  async prompt(message: string): Promise<void> {
    const start = this.events.length;
    await this.command("prompt", { message });
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (this.exited) { this.changed.off("event", check); reject(this.hostError("HOST_EXIT", "Native host stopped during prompt")); }
        else if (this.events.slice(start).some(e => e.type === "agent_settled")) { this.changed.off("event", check); resolve(); }
      };
      this.changed.on("event", check); check();
    });
    await this.refresh();
  }
  async reconfigure(config: Selection["config"]): Promise<void> {
    const settingsPath = this.options.controlledModels ? join(this.options.input.target.stateRoot, "host/settings.json") : join(this.options.caseRoot, "task/.pi/settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    await writeFile(settingsPath, JSON.stringify({ ...settings, compaction: config.compaction }), { mode: 0o600 });
    if (this.options.group !== "native") await writeFile(join(this.options.caseRoot, "nunc-config.json"), JSON.stringify(config.nunc), { mode: 0o600 });
    await this.command("prompt", { message: "/nunc-observer-reload" });
    await this.refresh();
  }
  async releaseBoundary(decision: { firstKeptEntryId?: string; stop?: string; restored?: boolean; deferred?: boolean }): Promise<void> {
    await this.command("prompt", { message: `/nunc-observer-release ${JSON.stringify(decision)}` });
  }
  async compact(during?: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const stop = new AbortController();
    let doneSettled = false;
    const done = this.command("compact").finally(() => { doneSettled = true; stop.abort(); });
    try {
      if (during) {
        const work = Promise.resolve().then(() => during(AbortSignal.any([stop.signal, this.options.signal]))).catch(error => {
          if (!doneSettled) throw error;
        });
        const results = await Promise.allSettled([done, work]);
        if (results[1].status === "rejected") throw results[1].reason;
      }
      await done;
    } catch (error) {
      // Refresh is observational and must not replace the primary RPC/work error.
      await this.refresh().catch(() => {});
      throw error;
    }
    await this.refresh();
  }
  async steer(message: string): Promise<void> { await this.command("steer", { message }); }
  async abortRun(): Promise<void> { await this.command("abort"); }
  async getState(): Promise<{ isCompacting: boolean; pendingMessageCount: number }> {
    const state = await this.command("get_state");
    requireValue(object(state), "RPC", "Invalid native session state");
    return { isCompacting: state.isCompacting === true, pendingMessageCount: Number(state.pendingMessageCount) || 0 };
  }
  async setModel(model: Model<Api>): Promise<void> { await this.command("set_model", { provider: model.provider, modelId: model.id }); await this.refresh(); }
  async close(): Promise<void> {
    if (this.sessionFile && existsSync(this.sessionFile)) {
      try { chmodSync(this.sessionFile, 0o600); } catch { /* ignore */ }
    }
    this.options.signal.removeEventListener("abort", this.abort);
    if (this.watch) clearInterval(this.watch);
    let grace: NodeJS.Timeout | undefined;
    if (!this.exited && this.child) { this.child.stdin.write(JSON.stringify({ type: "prompt", message: "/nunc-observer-quit" }) + "\n"); grace = setTimeout(this.abort, 1000); }
    await this.closed;
    if (grace) clearTimeout(grace);
    if (this.killTimer) clearTimeout(this.killTimer);
    if (this.detached) await settleProcessGroup(this.pid);
    else this.kill("SIGKILL");
    if (this.eventsFile) this.drain();
  }
}
export async function openHost(options: HostOptions): Promise<NativeHost> { const host = new NativeHost(options); try { return await host.start(); } catch (error) { await host.close(); throw error; } }
