// purpose: Shared bounded stock CLI/RPC and actual PTY/TUI observation mechanics.
// usage: import { StockFixture } from './stock-driver.mjs'; fixture.close() in finally.
// effects: Isolated local state, native CLI children and controlled loopback HTTP only.
// requires: Tracked local Pi 0.85.1 build, Node 26.7.0; Python3 stdlib for TUI.
import assert from 'node:assert/strict';
import { zstdDecompressSync } from 'node:zlib';
import { oauthFixture } from '../dist/tests/pi/oauth-fixture.js';
import { readSourceRecords } from '../dist/src/engine/request.js';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { watch, readFileSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const text = m => typeof m.content === 'string' ? m.content : (m.content ?? []).filter(b => ['text', 'input_text', 'output_text'].includes(b.type)).map(b => b.text).join('\n');
export const records = payload => (payload.messages ?? payload.input ?? []).flatMap(m => readSourceRecords(text(m)));
export class StockFixture {
  changes = new EventEmitter(); processes = []; requests = []; log = []; timeline = []; error; holds = new Map(); maintenanceCount = 0;
  async setup({ config = {}, compaction = {}, timeoutMs = 90000, artifactParent = join(root, '.scratch/stock'), api = 'openai-completions' } = {}) {
    this.api = api; this.codex = api === 'openai-codex-responses';
    this.provider = this.codex ? 'openai-codex' : 'groq'; this.modelId = this.codex ? 'gpt-6-astra' : 'nunc-native';
    this.oauth = this.codex ? oauthFixture() : undefined;
    this.reservation = this.codex ? 400000 : 80000;
    this.limits = process.env.NUNC_STOCK_LIMITS ? JSON.parse(process.env.NUNC_STOCK_LIMITS) : { maxCalls: 60, maxTotalTokens: this.reservation * 60, maxOutputTokens: this.codex ? 128000 : 20000, maxDurationMs: timeoutMs };
    assert(this.limits.maxOutputTokens >= (this.codex ? 128000 : 20000), 'authorize stock fixture default total output ceiling');
    timeoutMs = Math.min(timeoutMs, this.limits.maxDurationMs);
    await mkdir(artifactParent, { recursive: true });
    this.dir = await mkdtemp(join(artifactParent, 'run-'));
    this.state = join(this.dir, 'isolated');
    for (const d of ['home', 'agent', 'sessions', 'work', 'tmp', 'xdg']) await mkdir(join(this.state, d), { recursive: true });
    this.logFile = join(this.dir, 'events.jsonl'); await writeFile(this.logFile, '');
    this.watcher = watch(this.logFile, () => { const lines = readFileSync(this.logFile, 'utf8').split('\n'); lines.pop(); this.log = lines.map(s => JSON.parse(s)); this.changes.emit('change'); });
    this.env = { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: join(this.state, 'home'), PI_CODING_AGENT_DIR: join(this.state, 'agent'), TMPDIR: join(this.state, 'tmp'), XDG_CONFIG_HOME: join(this.state, 'xdg'), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', DO_NOT_TRACK: '1', JITI_FS_CACHE: 'false', TERM: 'xterm-256color', NUNC_OBSERVATION_LOG: this.logFile };
    this.server = createServer((req, res) => {
      const chunks = []; let bytes = 0; req.setTimeout(15000, () => req.destroy());
      req.on('data', part => { chunks.push(part); bytes += part.length; if (bytes > 2000000) req.destroy(); });
      req.on('end', () => { void (async () => {
        const raw = Buffer.concat(chunks), decoded = req.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(raw, { maxOutputLength: 2000000 }) : raw;
        await this.respond(req, res, decoded.toString('utf8'));
      })().catch(e => { this.error = e; res.destroy(); this.changes.emit('change'); }); });
      req.on('error', () => {});
    });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    this.endpoint = `http://127.0.0.1:${this.server.address().port}${this.codex ? '/backend-api' : api === 'anthropic-messages' ? '' : '/v1'}`;
    this.settings = { compaction: { enabled: true, reserveTokens: this.codex ? 140000 : 36000, keepRecentTokens: 1, ...compaction }, retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 10000 } }, steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time', transport: 'sse', defaultProjectTrust: 'never', enableInstallTelemetry: false, enableAnalytics: false, quietStartup: true };
    await writeFile(join(this.state, 'agent/settings.json'), JSON.stringify(this.settings));
    await writeFile(join(this.state, 'agent/models.json'), JSON.stringify({ providers: { groq: { baseUrl: this.endpoint, apiKey: 'isolated-nunc-fixture', models: [{ id: 'nunc-native', api, reasoning: false, input: ['text', 'image'], contextWindow: 60000, maxTokens: 20000 }, { id: 'nunc-small', api, reasoning: false, input: ['text'], contextWindow: 52000, maxTokens: 12000 }] } } }));
    if (this.codex) {
      const model = openaiCodexProvider().getModels().find(m => m.id === this.modelId); assert(model);
      await writeFile(join(this.state, 'agent/models.json'), JSON.stringify({ providers: { [this.provider]: { baseUrl: this.endpoint } } }));
      await writeFile(join(this.state, 'agent/auth.json'), JSON.stringify({ [this.provider]: this.oauth }), { mode: 0o600 });
    }
    this.configFile = join(this.state, 'nunc.json');
    await writeFile(this.configFile, JSON.stringify({ extraction: { outputTokens: this.codex ? 128000 : 1024 }, ...(this.codex ? { budget: { extraMainInputTokens: 103500 } } : {}), ...config }));
    this.timer = setTimeout(() => { this.error = new Error('whole observation deadline'); this.changes.emit('change'); for (const p of this.processes) p.child.kill('SIGTERM'); this.server.closeAllConnections(); }, timeoutMs);
    return this;
  }
  hold(kind) { this.holds.set(kind, Promise.withResolvers()); }
  release(kind) { this.holds.get(kind)?.resolve(); this.holds.delete(kind); }
  async respond(req, res, body) {
    assert.equal(req.method, 'POST');
    assert.equal(req.url.split('?')[0], this.codex ? '/backend-api/codex/responses' : this.api === 'anthropic-messages' ? '/v1/messages' : this.api === 'openai-responses' ? '/v1/responses' : '/v1/chat/completions');
    assert(this.codex ? req.headers.authorization === `Bearer ${this.oauth.access}` : req.headers.authorization === 'Bearer isolated-nunc-fixture' || req.headers['x-api-key'] === 'isolated-nunc-fixture');
    const payload = JSON.parse(body), source = records(payload).find(r => r.source === 'F/M');
    const kind = source ? 'maintenance' : 'main';
    const messages = payload.messages ?? payload.input ?? [];
    const independent = kind === 'main' && messages.length === 1 && text(messages[0]) === 'Unclassified nested request';
    if (kind === 'main' && this.processes.length && !independent) assert.equal(req.headers['x-nunc-fixture'], 'preserved', 'public header composition preserved');
    assert((this.limits.maxCalls == null || this.requests.length < this.limits.maxCalls) && (this.limits.maxTotalTokens == null || (this.requests.length + 1) * this.reservation <= this.limits.maxTotalTokens), 'bounded native HTTP/token inventory');
    const row = { kind, payload, encoding: req.headers['content-encoding'] ?? 'identity', closed: false, number: this.requests.length + 1 }; this.requests.push(row);
    res.on('close', () => { row.closed = true; this.changes.emit('change'); });
    this.changes.emit('change');
    const held = this.holds.get(kind);
    if (held) await Promise.race([held.promise, new Promise(resolve => res.once('close', resolve))]);
    if (res.destroyed) return;
    const reply = this.response?.(row, source) ?? (source ? JSON.stringify({ add: [{ key: `addition${++this.maintenanceCount}`, text: `Controlled protocol slot ${this.maintenanceCount}; no memory-quality assertion.` }], remove: source.M.map(s => s.id), priority: [`addition${this.maintenanceCount}`], required: [`addition${this.maintenanceCount}`] }) : 'Controlled ordinary response.');
    if (reply.status) { res.writeHead(reply.status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: reply.message } })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    // Controlled usage follows the delivered payload's scale, so usage-backed
    // admission tests cannot hide growing history behind a constant 100 tokens.
    const observedInput = reply.input ?? Math.ceil(JSON.stringify(payload).length / 4);
    const observedOutput = reply.outputTokens ?? 50;
    const frame = x => res.write(`data: ${JSON.stringify(x)}\n\n`);
    if (this.api === 'anthropic-messages') {
      const content = typeof reply === 'string' ? reply : reply.text;
      const events = [
        { type: 'message_start', message: { id: `response-${row.number}`, type: 'message', role: 'assistant', model: payload.model, content: [], stop_reason: null, usage: { input_tokens: observedInput, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } },
        { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: observedOutput } }, { type: 'message_stop' },
      ];
      for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); res.end(); return;
    }
    if (this.api === 'openai-responses' || this.codex) {
      const content = typeof reply === 'string' ? reply : reply.text;
      const item = reply.tool ? { type: 'function_call', id: `fc-${row.number}`, call_id: `call-${row.number}`, name: reply.tool.name, arguments: JSON.stringify(reply.tool.input), status: 'completed' } : { type: 'message', id: `msg-${row.number}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: content, annotations: [] }] };
      frame({ type: 'response.created', response: { id: `response-${row.number}`, model: payload.model, status: 'in_progress', output: [] } });
      frame({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', ...(reply.tool ? { arguments: '' } : { content: [] }) } });
      if (reply.tool) frame({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments });
      else {
        frame({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        frame({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: content });
      }
      frame({ type: 'response.output_item.done', output_index: 0, item });
      frame({ type: 'response.completed', response: { id: `response-${row.number}`, model: payload.model, status: 'completed', output: [item], usage: { input_tokens: observedInput, output_tokens: observedOutput, total_tokens: observedInput + observedOutput, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
      res.end(); return;
    }
    const chunk = (delta, finish_reason = null) => frame({ id: `response-${row.number}`, object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [{ index: 0, delta, finish_reason }] });
    chunk({ role: 'assistant', content: '' });
    const tools = reply.tools ?? (reply.tool ? [reply.tool] : []);
    chunk(tools.length ? { tool_calls: tools.map((tool, index) => ({ index, id: tools.length === 1 ? `tool-${row.number}` : `tool-${row.number}-${index}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.input) } })) } : { content: typeof reply === 'string' ? reply : reply.text });
    chunk({}, reply.finish ?? (tools.length ? 'tool_calls' : 'stop'));
    frame({ id: `response-${row.number}`, object: 'chat.completion.chunk', model: payload.model, choices: [], usage: { prompt_tokens: observedInput, completion_tokens: observedOutput, total_tokens: observedInput + observedOutput } });
    res.end('data: [DONE]\n\n');
  }
  wait(predicate, label, ms = 15000) {
    return new Promise((resolve, reject) => {
      const finish = (err, value) => { clearTimeout(timer); clearInterval(poll); this.changes.off('change', check); err ? reject(err) : resolve(value); };
      const check = () => { try { if (this.error) throw this.error; const v = predicate(); if (v) finish(null, v); } catch (e) { finish(e); } };
      const timer = setTimeout(() => finish(new Error(`deadline: ${label}; last=${JSON.stringify(this.log.at(-1))?.slice(0, 500)}`)), ms);
      // fs.watch can coalesce consecutive appends before the final JSONL row.
      const poll = setInterval(() => { const lines = readFileSync(this.logFile, 'utf8').split('\n'); lines.pop(); this.log = lines.map(s => JSON.parse(s)); check(); }, 25);
      this.changes.on('change', check); check();
    });
  }
  start(mode = 'rpc', sessionFile) {
    const host = join(root, 'node_modules/@earendil-works/pi-coding-agent');
    const manifest = JSON.parse(readFileSync(join(host, 'package.json'), 'utf8'));
    assert.equal(manifest.version, '0.85.1');
    const cli = join(host, manifest.bin.pi);
    const args = [cli, ...(mode === 'rpc' ? ['--mode', 'rpc'] : []), '--no-approve', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-tools', '-e', join(root, 'dist/src/index.js'), '-e', join(root, 'dist/tests/pi/stock-extension.js'), '--nunc-config', this.configFile, '--provider', this.provider, '--model', this.modelId, '--thinking', 'off', '--system-prompt', 'Perform the current task.', '--session-dir', join(this.state, 'sessions'), ...(sessionFile ? ['--session', sessionFile] : [])];
    const command = mode === 'tui' ? ['/usr/bin/python3', join(root, 'scripts/pty-driver.py'), process.execPath, ...args] : [process.execPath, ...args];
    const child = spawn(command[0], command.slice(1), { cwd: join(this.state, 'work'), env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const p = { child, mode, events: [], stdout: '', stderr: '', serial: 0, exit: undefined };
    this.processes.push(p); this.timeline.push({ command, mode, pid: child.pid });
    let buffer = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', part => {
      p.stdout += part;
      if (p.stdout.length > 15000000) { this.error = new Error('stdout limit'); child.kill('SIGTERM'); }
      if (mode === 'rpc') {
        buffer += part; let n;
        while ((n = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, n); buffer = buffer.slice(n + 1);
          if (line.trim()) { try { p.events.push(JSON.parse(line)); } catch { this.error = new Error('Invalid RPC framing'); } }
        }
      }
      this.changes.emit('change');
    });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', s => { p.stderr += s; });
    child.on('error', e => { this.error = e; this.changes.emit('change'); });
    child.on('exit', (code, signal) => { p.exit = { code, signal }; this.changes.emit('change'); });
    p.command = async (type, fields = {}) => {
      assert.equal(mode, 'rpc'); assert(!p.exit, p.stderr);
      const id = String(++p.serial); child.stdin.write(JSON.stringify({ id, type, ...fields }) + '\n');
      const result = await this.wait(() => p.events.find(e => e.id === id) || (p.exit && (() => { throw new Error(`CLI exited ${JSON.stringify(p.exit)} ${p.stderr}`); })()), `RPC ${type}`);
      assert(result.success, JSON.stringify(result)); return result.data;
    };
    p.keys = value => { assert(!p.exit, p.stderr); child.stdin.write(value); };
    p.send = async (message, follow = false) => {
      if (mode === 'rpc') return p.command('prompt', { message, ...(follow ? { streamingBehavior: 'followUp' } : {}) });
      p.keys(`\x1b[200~${message}\x1b[201~`);
      // Distinct frames avoid combining Alt-Enter with bracketed paste.
      await new Promise(resolve => setTimeout(resolve, 100)); p.keys(follow ? '\x1b\r' : '\r');
      await new Promise(resolve => setTimeout(resolve, 100));
    };
    p.prompt = async message => { const n = this.log.filter(e => e.type === 'settled').length; await p.send(message); await this.wait(() => this.log.filter(e => e.type === 'settled').length > n, 'settled'); };
    p.quit = async () => { if (p.exit) return; await p.send('/fixture-quit'); await this.wait(() => p.exit, 'graceful stock exit'); assert.equal(p.exit.code, 0); };
    return p;
  }
  async close(outcome = {}) {
    clearTimeout(this.timer); for (const k of this.holds.keys()) this.release(k);
    for (const p of this.processes) if (!p.exit) {
      p.child.kill('SIGTERM'); const timer = setTimeout(() => p.child.kill('SIGKILL'), 2000);
      await new Promise(resolve => { if (p.exit) resolve(); else p.child.once('exit', resolve); }); clearTimeout(timer);
    }
    this.server.closeAllConnections(); await new Promise(resolve => this.server.close(resolve)); this.watcher.close();
    // Preserve observations and durable native state before fixture cleanup.
    const files = this.log.filter(e => e.type === 'snapshot').map(e => e.data.file).filter(Boolean);
    for (const [i, file] of [...new Set(files)].entries()) if (existsSync(file)) await writeFile(join(this.dir, `session-${i}.jsonl`), await readFile(file));
    await writeFile(join(this.dir, 'wire.json'), JSON.stringify(this.requests, null, 2));
    await writeFile(join(this.dir, 'processes.json'), JSON.stringify(this.processes.map(({ child, command, ...p }) => ({ pid: child.pid, ...p })), null, 2));
    await writeFile(join(this.dir, 'timeline.json'), JSON.stringify(this.timeline, null, 2));
    await rm(this.state, { recursive: true, force: true });
    await writeFile(join(this.dir, 'result.json'), JSON.stringify({ ...outcome, cleanup: { childrenExited: this.processes.every(p => p.exit), serverClosed: !this.server.listening, isolatedStateRemoved: true } }, null, 2));
  }
}
