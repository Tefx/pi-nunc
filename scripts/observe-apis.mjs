// purpose: Prove admission/delegation and native recovery through each supported stock API adapter.
// usage: node scripts/observe-apis.mjs openai-responses|anthropic-messages
// effects: Isolated stock RPC/native HTTP/JSONL against bounded loopback SSE; cleanup and retained evidence.
// requires: Locked build and stock-driver.mjs; no live models or credential reads.
import assert from 'node:assert/strict';
import { StockFixture, records, text } from './stock-driver.mjs';
const api = process.argv[2]; assert(['openai-responses', 'anthropic-messages', 'openai-codex-responses'].includes(api));
// Codex's old fixture used synthetic main overhead solely to force a local soft-limit error.
// Use a native threshold between the two delivered payload sizes instead.
// Threshold maintenance includes a completed assistant after recent; select K to retain that full recent turn.
const f = await new StockFixture().setup({ api, config: { rolling: { keepRecentFraction: 0.9 }, ...(api === 'openai-codex-responses' ? { budget: {} } : {}) }, ...(api === 'openai-codex-responses' ? { compaction: { reserveTokens: 240000 } } : {}) }); let outcome = { status: 'FAIL', api };
try {
  const p = f.start(); await p.command('get_state');
  const old = 'Prior work:' + 'a'.repeat(f.codex ? 106000 : 92000), recent = 'Delivered recent:' + 'b'.repeat(f.codex ? 52000 : 68000);
  await p.prompt(old); assert.equal(f.requests.length, 1);
  await p.prompt(recent);
  assert.equal(f.requests.length, 3, 'two ordinary mains followed by native threshold maintenance');
  assert.equal(f.log.filter(e => e.type === 'admission' && e.data.code === 'CAPACITY').length, 0);
  assert.equal(f.log.filter(e => e.type === 'compact').at(-1).data.reason, 'threshold');
  assert.equal(f.log.filter(e => e.type === 'compact').length, 1);
  const source = records(f.requests.find(r => r.kind === 'maintenance').payload);
  assert(source.some(r => r.region === 'B' && r.messages.some(m => text(m) === old)));
  assert(source.some(r => r.region === 'K' && r.messages.some(m => text(m) === recent)));
  await p.prompt('Continue after native threshold');
  assert.equal(f.requests.length, 4);
  assert(!JSON.stringify(f.requests.at(-1).payload).includes(old)); assert(JSON.stringify(f.requests.at(-1).payload).includes(recent));
  if (api === 'openai-codex-responses') {
    assert(f.requests.every(r => r.payload.model === 'gpt-6-astra' && r.payload.max_output_tokens === undefined));
    assert(f.requests.some(r => r.encoding === 'zstd'), 'native Codex compression stayed intact');
  }
  const entries = (await p.command('get_entries')).entries;
  assert.equal(entries.filter(e => e.type === 'compaction').length, 1); assert.equal(entries.at(-1).message.stopReason, 'stop');
  await p.quit(); outcome = { status: 'PROVEN_CONTROLLED', api, requests: f.requests.length, compactions: 1, memoryQuality: 'UNPROVEN: controlled service' };
} catch (e) { outcome.error = { message: e.message, stack: e.stack }; console.error(e); process.exitCode = 1; }
finally { await f.close(outcome); console.log(JSON.stringify({ ...outcome, evidence: f.dir })); }
