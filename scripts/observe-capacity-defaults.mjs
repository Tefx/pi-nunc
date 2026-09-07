// purpose: Exercise unmodified Codex/Pi budget defaults through the real stock loader, transport and persistence.
// usage: node scripts/observe-capacity-defaults.mjs
// effects: Isolated stock RPC, fictional native authentication and controlled loopback SSE; saves evidence and cleans up.
// requires: Locked local build and stock-driver.mjs; no live model/credentials.
import assert from 'node:assert/strict';
import { StockFixture, records, text } from './stock-driver.mjs';
const f = await new StockFixture().setup({ api: 'openai-codex-responses', config: { extraction: {}, budget: {} }, compaction: { reserveTokens: 16384, keepRecentTokens: 20000 } });
let outcome = { status: 'FAIL' };
f.response = (_row, source) => source ? { text: '{"add":[],"remove":[],"priority":[]}', outputTokens: 12000 } : 'Controlled ordinary response.';
try {
  const p = f.start();
  const old = 'Original task evidence: ' + 'a'.repeat(200000);
  const recent = 'Recent task evidence: ' + 'b'.repeat(80000);
  await p.prompt(old); await p.prompt(recent);
  assert.equal(f.requests.length, 2, 'ordinary input above the old byte budget remains usable');
  assert(!f.log.some(e => e.type === 'admission' && e.data.outcome === 'reject'));
  const mains = f.log.filter(e => e.type === 'admission' && e.data.kind === 'main');
  assert(mains.every(e => e.data.inputLimit === 271999 && e.data.plannedInputLimit === 254592));
  assert(mains.some(e => e.data.estimator === 'pi-usage-backed'));
  await p.command('compact');
  const maintenance = f.log.find(e => e.type === 'maintenance').data.result;
  assert(maintenance.ok, maintenance.message);
  assert.equal(maintenance.observations.requests, 1);
  assert.equal(maintenance.observations.accounting.outputReserveTokens, 8192);
  assert.equal(maintenance.observations.accounting.outputCapTokens, null);
  assert.equal(maintenance.observations.accounting.extractionInputLimit, 262784);
  assert.equal(maintenance.observations.accounting.outputExceededPlan, true);
  assert.equal(maintenance.observations.usage.output, 12000);
  const extraction = f.requests.find(r => r.kind === 'maintenance');
  const source = records(extraction.payload);
  for (const body of [old, recent]) assert(source.some(r => r.messages?.some(m => text(m) === body)));
  assert(f.requests.every(r => r.payload.max_output_tokens === undefined), 'uncapped transport never invents an enforceable cap');
  const saved = (await p.command('get_entries')).entries;
  assert.equal(saved.filter(e => e.type === 'compaction').length, 1);
  assert.equal(saved.filter(e => e.type === 'message' && e.message.role === 'user' && text(e.message) === old).length, 1);
  await p.prompt('Continue using retained work.');
  assert.equal(f.requests.at(-1).kind, 'main');
  await p.quit();
  outcome = { status: 'PROVEN_CONTROLLED', mainInputLimit: 271999, plannedMainInputLimit: 254592, extractionInputLimit: 262784, outputReserve: 8192, outputCap: null, observedExtractionOutput: 12000, persistedCompactions: 1, memoryQuality: 'UNPROVEN: controlled response' };
} catch (error) { outcome.error = { message: error.message, stack: error.stack }; console.error(error); process.exitCode = 1; }
finally { await f.close(outcome); console.log(JSON.stringify({ ...outcome, evidence: f.dir })); }
