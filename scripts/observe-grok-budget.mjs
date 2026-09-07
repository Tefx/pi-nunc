// purpose: Exercise equal context/output Grok metadata through stock Pi and native Responses serialization.
// usage: node scripts/observe-grok-budget.mjs
// effects: Isolated RPC/JSONL and bounded loopback SSE only; no xAI service or daily credentials.
// requires: Locked build, native xAI catalog and stock-driver.mjs.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';
import { StockFixture } from './stock-driver.mjs';
const model = xaiProvider().getModels().find(m => m.id === 'grok-4.6');
assert(model && model.contextWindow === 500000 && model.maxTokens === 500000);
const f = await new StockFixture().setup({ api: model.api, compaction: { enabled: false, reserveTokens: 16384 } });
let outcome = { status: 'FAIL' };
try {
  f.provider = model.provider; f.modelId = model.id;
  f.reservation = model.contextWindow + model.maxTokens;
  f.limits = { ...f.limits, maxCalls: 8, maxTotalTokens: f.reservation * 8, maxOutputTokens: model.maxTokens };
  await writeFile(join(f.state, 'agent/models.json'), JSON.stringify({ providers: { xai: { baseUrl: f.endpoint, apiKey: 'isolated-nunc-fixture' } } }));
  const p = f.start(); await p.command('get_state');
  await p.send('/fixture-payload-mode append');
  await p.prompt('First task ' + 'a'.repeat(80000));
  assert.equal(f.requests.length, 1, 'equal catalog ceilings must not reject a normal 80k input plus last-user append');
  const firstCap = f.requests[0].payload.max_output_tokens;
  assert(firstCap > 400000 && firstCap < model.maxTokens, 'native Pi clamps its large default; Nunc must not replace it with a small fixed cap');
  const firstUser = [...(f.requests[0].payload.input ?? f.requests[0].payload.messages)].reverse().find(m => m.role === 'user');
  assert(Array.isArray(firstUser.content));
  assert.equal(firstUser.content.at(-1).text, 'nunc-synthetic-last-user-append');
  assert.match(typeof firstUser.content[0] === 'string' ? firstUser.content[0] : firstUser.content[0].text, /First task/);
  assert(!JSON.stringify(f.log).includes('nunc-synthetic-last-user-append'));
  await p.send('/fixture-payload-mode append-overflow');
  const beforeOverflow = f.requests.length;
  await p.prompt('Overlarge last-user append');
  assert.equal(f.requests.length, beforeOverflow, 'append that consumes native clamp remaining must not send');
  assert(f.log.some(e => e.type === 'admission' && e.data.outcome === 'reject' && e.data.code === 'CAPACITY' && e.data.payload?.transform === 'last-user-text-append'));
  await p.send('/fixture-payload-mode identity');
  await p.prompt('Second task ' + 'b'.repeat(30000));
  assert.equal(f.requests.length, 2);
  const before = (await p.command('get_entries')).entries;
  await p.command('compact');
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[2].kind, 'maintenance');
  assert.equal(f.requests[2].payload.max_output_tokens, 1024, 'raw extraction retains its explicit ceiling');
  const after = (await p.command('get_entries')).entries;
  assert.equal(after.filter(e => e.type === 'compaction').length, 1);
  assert(after.length > before.length);
  await p.prompt('Continue from the saved checkpoint');
  assert.equal(f.requests.length, 4);
  assert.equal((await p.command('get_entries')).entries.at(-1).message.stopReason, 'stop');
  const sent = f.requests.length;
  await p.prompt('Actually oversized ' + 'z'.repeat(500000));
  assert.equal(f.requests.length, sent, 'actual oversized input still rejects without HTTP or disabled-auto recovery');
  assert(f.log.some(e => e.type === 'admission' && e.data.code === 'CAPACITY'));
  await p.quit();
  outcome = { status: 'PROVEN_CONTROLLED', model: `${model.provider}/${model.id}`, firstSerializedOutputCap: firstCap, requests: sent, compactions: 1, oversizedZeroSend: true, memoryQuality: 'UNPROVEN: controlled service' };
} catch (error) { outcome.error = { message: error.message, stack: error.stack }; console.error(error); process.exitCode = 1; }
finally { await f.close(outcome); console.log(JSON.stringify({ ...outcome, evidence: f.dir })); }
