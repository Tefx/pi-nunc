// purpose: Record native checkpoint settings and Nunc extraction usage from existing public events, without changing memory.
// usage: external Pi -e <this-file> --bench-observer-file <owned-jsonl-file>
// effects: Append task-local observations; stop optional idle cache warming; no model calls, prompt edits or checkpoint writes.
// requires: Pi1.1 public ExtensionAPI; Nunc's existing nunc:maintenance event for Nunc usage.
import { appendFileSync } from 'node:fs';
export default function maintenance(pi) {
  pi.registerFlag('bench-observer-file', { type: 'string', description: 'Task-local benchmark observations (not model context)' });
  const record = (data) => {
    const path = pi.getFlag('bench-observer-file');
    if (typeof path !== 'string' || !path) throw new Error('Missing benchmark observation path');
    appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...data }) + '\n');
  };
  pi.on('session_start', (_event, ctx) => record({ type: 'session_start', pid: process.pid, ppid: process.ppid, cwd: ctx.cwd, sessionFile: ctx.sessionManager.getSessionFile(), model: ctx.model && { provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api, contextWindow: ctx.model.contextWindow, maxTokens: ctx.model.maxTokens }, tools: pi.getActiveTools() }));
  pi.on('session_before_compact', (event) => { record({ type: 'native_preparation', reason: event.reason, settings: event.preparation.settings, tokensBefore: event.preparation.tokensBefore }); });
  pi.events.on('nunc:maintenance', (event) => record({ type: 'nunc_maintenance', reason: event.reason, ok: event.result.ok, code: event.result.code, message: event.result.message, observations: event.result.observations }));
  pi.on('session_compact_failed', (event) => { record({ type: 'compaction_failed', ...event }); });
  pi.on('cache_warming_decision', () => ({ action: 'stop' }));
}

/** Share event/command composition while each benchmark retains its own capture policy. */
export function composeObserver(capture) {
  return pi => {
    capture(pi);
    maintenance(pi);
    pi.registerCommand('bench-compact', {
      description: 'Start native compaction; caller awaits compaction_end',
      handler: (_args, ctx) => { ctx.compact(); },
    });
  };
}
