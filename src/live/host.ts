import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { object, payloadAppendBEnabled, payloadAppendEnabled, providerWrapEnabled, requireValue, within, RunnerError, type RunInput, type Selection } from "./contract.js";
export { toolPath } from "./tool-path.js";
export function liveExtensionFlags(repository: string, input: RunInput, group?: "native" | "current" | "candidate", targetRepos?: { current?: string | undefined; candidate?: string | undefined } | undefined): string[] {
  const flags = ["-e", join(repository, "dist/src/live/observer.js")];
  if (payloadAppendEnabled(input)) flags.push("-e", join(repository, "dist/src/live/append.js"));
  if (payloadAppendBEnabled(input)) flags.push("-e", join(repository, "dist/src/live/append-b.js"));
  if (providerWrapEnabled(input)) flags.push("-e", join(repository, "dist/src/live/wrap.js"));
  if (group === "native") return flags;
  if (group === "current") {
    const curRepo = targetRepos?.current ?? input.comparison?.targets.current.repository ?? repository;
    flags.push("-e", join(curRepo, "dist/src/index.js"));
    return flags;
  }
  const candRepo = targetRepos?.candidate ?? input.comparison?.targets.candidate.repository ?? repository;
  flags.push("-e", join(candRepo, "dist/src/index.js"));
  return flags;
}
export interface HostOptions {
  repository: string; input: RunInput; selection: Selection; caseRoot: string; modelTargets: Model<Api>[];
  deadline: number; signal: AbortSignal; sessionFile?: string | undefined;
  group?: "native" | "current" | "candidate" | undefined;
  targetRepos?: { current?: string | undefined; candidate?: string | undefined } | undefined;
  /** Test-only native models.json overlay; it replaces the service endpoint, never the host or Provider. */
  controlledModels?: unknown;
  /** Test-only child replacement. Production always uses the locked stock Pi CLI. */
  testCommand?: { command: string; args: string[] } | undefined;
  onMaintenance?: ((event: unknown) => void) | undefined;
  onContext?: ((model: Model<Api>, context: Context, kind: string) => void) | undefined;
  onAction?: ((event: unknown) => void) | undefined;
}
export function childEnvironment(state: string): NodeJS.ProcessEnv {
  return { HOME: join(state, "home"), PI_CODING_AGENT_DIR: join(state, "host"), TMPDIR: join(state, "tmp"),
    XDG_CONFIG_HOME: join(state, "xdg/config"), XDG_CACHE_HOME: join(state, "xdg/cache"), XDG_DATA_HOME: join(state, "xdg/data"),
    PATH: "/opt/homebrew/bin:/usr/bin:/bin", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", NO_COLOR: "1" };
}
/** Native owner configuration/auth stays inherited, only task scratch is redirected. */
export function nativeEnvironment(state: string): NodeJS.ProcessEnv {
  const { NODE_OPTIONS: _node, PI_SESSION_ID: _session, PI_SESSION_FILE: _file, ...env } = process.env;
  return { ...env, TMPDIR: join(state, "tmp"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", NO_COLOR: "1" };
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
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
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
  private readonly abort = () => { this.child?.kill("SIGTERM"); this.killTimer ??= setTimeout(() => this.child?.kill("SIGKILL"), 1000); };
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
    const taskSettings = { ...o.input.effective?.settings, compaction: o.selection.config.compaction, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } }, transport: "sse", packages: [], extensions: [], skills: [], prompts: [], themes: [], enableSkillCommands: false };
    if (o.controlledModels) await writeFile(join(host, "settings.json"), JSON.stringify(taskSettings), { mode: 0o600 });
    else if (!o.sessionFile) {
      // Only this newly created task's narrow nonsecret settings overlay. Native
      // global settings/auth are neither copied nor rewritten.
      await mkdir(join(cwd, ".pi"), { mode: 0o700 });
      await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify(taskSettings), { mode: 0o600, flag: "wx" });
    }
    if (o.controlledModels) await writeFile(join(host, "models.json"), JSON.stringify(o.controlledModels), { mode: 0o600 });
    const events = join(o.caseRoot, `events-${process.pid}-${Date.now()}.jsonl`);
    await writeFile(events, "", { mode: 0o600, flag: "wx" });
    await writeFile(binding, JSON.stringify({ input: o.input, models: o.modelTargets, deadline: o.deadline, events, ledger: join(state, "calls.jsonl"), cwd, caseKey: `${o.selection.id}${o.selection.variant ? `-${o.selection.variant}` : ""}` }), { mode: 0o600 });
    this.eventsFile = events;
    const model = o.modelTargets[0]; requireValue(model, "MODEL", "No authorized model");
    const packageDir = join(o.repository, "node_modules/@earendil-works/pi-coding-agent");
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { bin: { pi: string } };
    const cli = join(packageDir, manifest.bin.pi);
    const args = o.testCommand?.args ?? [cli, "--offline", "--approve", "--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--provider", model.provider, "--model", model.id, "--thinking", o.input.effective?.thinking ?? "off", "--tools", "read,write,edit", "--system-prompt", "Carry out the user's tasks using the available file tools. Work only in the current task directory. Preserve unfinished work when the topic changes. If evidence is insufficient, state uncertainty.", ...liveExtensionFlags(o.repository, o.input, o.group, o.targetRepos), ...(o.group === "native" ? [] : ["--nunc-config", config]), "--session-dir", join(o.caseRoot, "sessions"), ...(o.sessionFile ? ["--session", o.sessionFile] : [])];
    this.child = spawn(o.testCommand?.command ?? process.execPath, args, { cwd, env: { ...(o.controlledModels ? childEnvironment(state) : nativeEnvironment(state)), NUNC_LIVE_OBSERVER: binding }, stdio: ["pipe", "pipe", "pipe"] });
    this.pid = this.child.pid;
    this.child.stdin.on("error", () => this.abort());
    this.child.stdout.on("data", (buffer: Buffer) => {
      this.bytes += buffer.length;
      if (this.bytes > 32_000_000) { this.fail("OUTPUT", "Native host output exceeded the bound"); return; }
      this.output += buffer.toString(); let end: number;
      while ((end = this.output.indexOf("\n")) >= 0) {
        const line = this.output.slice(0, end); this.output = this.output.slice(end + 1);
        try {
          const e: unknown = JSON.parse(line); if (!object(e)) continue;
          if (e.type === "response" && typeof e.id === "string") {
            const pending = this.pending.get(e.id); this.pending.delete(e.id);
            if (e.success === false) pending?.reject(new RunnerError("RPC", "Native RPC command failed")); else pending?.resolve(e.data);
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
    await this.refresh(); return this;
  }
  private eventsFile = "";
  private drain(): void {
    const data = readFileSync(this.eventsFile, "utf8");
    requireValue(data.length <= 64_000_000, "OUTPUT", "Observer evidence limit reached");
    const rows = data.slice(this.cursor).split("\n"); rows.pop();
    for (const row of rows) {
      this.cursor += row.length + 1;
      const e: unknown = JSON.parse(row); requireValue(object(e), "OBSERVER", "Invalid observer record");
      if (e.type === "maintenance") this.options.onMaintenance?.(e.data);
      if (e.type === "action" || e.type === "lifecycle") this.options.onAction?.(e.data);
      if (e.type === "context") {
        requireValue(object(e.data) && object(e.data.model) && object(e.data.context) && Array.isArray(e.data.context.messages), "OBSERVER", "Invalid observed context");
        const observedModel = e.data.model;
        const model = this.options.modelTargets.find(m => m.provider === observedModel.provider && m.id === observedModel.id);
        requireValue(model, "MODEL", "Observed model outside authorization");
        const context = e.data.context as unknown as Context;
        if (e.data.kind === "main") { this.fixed.systemPrompt = context.systemPrompt ?? ""; this.fixed.tools = context.tools ?? []; }
        this.options.onContext?.(model, context, String(e.data.kind));
      }
    }
  }
  async command(type: string, values: Record<string, unknown> = {}): Promise<unknown> {
    this.options.signal.throwIfAborted(); requireValue(!this.exited, this.failure?.code ?? "HOST_EXIT", this.failure?.message ?? "Native host unavailable");
    if (["prompt", "steer", "compact", "clear_queue", "abort"].includes(type)) this.commands.push({ type, ...(typeof values.message === "string" ? { message: values.message } : {}) });
    const id = String(++this.serial);
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
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
  async prompt(message: string, _options?: unknown): Promise<void> {
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
  async compact(during?: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const stop = new AbortController();
    const done = this.command("compact").finally(() => stop.abort());
    try {
      if (during) {
        const work = during(AbortSignal.any([stop.signal, this.options.signal]));
        const results = await Promise.allSettled([done, work]);
        if (results[1].status === "rejected" && !stop.signal.aborted) throw results[1].reason;
      }
      await done;
    } finally { await this.refresh(); }
  }
  async steer(message: string): Promise<void> { await this.command("steer", { message }); }
  async abortRun(): Promise<void> { await this.command("abort"); }
  async getState(): Promise<{ isCompacting: boolean; pendingMessageCount: number }> {
    const state = await this.command("get_state");
    requireValue(object(state), "RPC", "Invalid native session state");
    return { isCompacting: state.isCompacting === true, pendingMessageCount: Number(state.pendingMessageCount) || 0 };
  }
  async setModel(model: Model<Api>, _options?: unknown): Promise<void> { await this.command("set_model", { provider: model.provider, modelId: model.id }); await this.refresh(); }
  async close(): Promise<void> {
    this.options.signal.removeEventListener("abort", this.abort);
    if (this.watch) clearInterval(this.watch);
    let grace: NodeJS.Timeout | undefined;
    if (!this.exited && this.child) { this.child.stdin.write(JSON.stringify({ type: "prompt", message: "/nunc-observer-quit" }) + "\n"); grace = setTimeout(this.abort, 1000); }
    await this.closed; if (grace) clearTimeout(grace); if (this.killTimer) clearTimeout(this.killTimer); if (this.eventsFile) this.drain();
  }
}
export async function openHost(options: HostOptions): Promise<NativeHost> { const host = new NativeHost(options); try { return await host.start(); } catch (error) { await host.close(); throw error; } }
export async function closeHost(host: NativeHost): Promise<void> { await host.close(); }
