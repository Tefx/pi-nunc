// purpose: Exercise stock loader before_provider_request metadata, last-user append, and overcap/illegal/rewrite zero-send.
// usage: node scripts/observe-payload.mjs
// effects: Isolated stock RPC and bounded loopback SSE only; no live models or daily credentials.
// requires: Locked build, stock-driver.mjs and compiled stock-extension.
import assert from 'node:assert/strict';
import { StockFixture } from './stock-driver.mjs';

const f = await new StockFixture().setup({ timeoutMs: 90000, compaction: { enabled: false } });
let outcome = { status: 'FAIL' };
try {
  const p = f.start(); await p.command('get_state');
  await p.prompt('Observer-only payload hook');
  assert.equal(f.requests.length, 1);
  await p.send('/fixture-payload-mode identity');
  await p.prompt('Identity return of the same payload object');
  assert.equal(f.requests.length, 2);
  await p.send('/fixture-payload-mode inplace-meta');
  await p.prompt('In-place metadata');
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests.at(-1).payload.temperature, 0);
  await p.send('/fixture-payload-mode replace-meta');
  await p.prompt('Replacement metadata');
  assert.equal(f.requests.length, 4);
  assert.equal(f.requests.at(-1).payload.temperature, 0);
  await p.send('/fixture-payload-mode append');
  await p.prompt('Last-user text append must send');
  assert.equal(f.requests.length, 5);
  const appended = f.requests.at(-1).payload;
  const conversation = appended.messages ?? appended.input;
  const lastUser = [...conversation].reverse().find(m => m.role === 'user');
  assert(Array.isArray(lastUser.content));
  assert.equal(lastUser.content.at(-1).type, Array.isArray(appended.input) ? 'input_text' : 'text');
  assert.equal(lastUser.content.at(-1).text, 'nunc-synthetic-last-user-append');
  assert.match(typeof lastUser.content[0] === 'string' ? lastUser.content[0] : lastUser.content[0].text, /Last-user text append must send/);
  assert(!JSON.stringify(f.log).includes('nunc-synthetic-last-user-append'));
  const beforeOvercap = f.requests.length;
  await p.send('/fixture-payload-mode overcap');
  await p.prompt('Output overcap must not send');
  assert.equal(f.requests.length, beforeOvercap);
  const beforeStream = f.requests.length;
  await p.send('/fixture-payload-mode nostream');
  await p.prompt('Non-stream payload must not send');
  assert.equal(f.requests.length, beforeStream);
  const beforeGrow = f.requests.length;
  await p.send('/fixture-payload-mode grow');
  await p.prompt('Payload input growth must not send');
  assert.equal(f.requests.length, beforeGrow);
  const beforeModel = f.requests.length;
  await p.send('/fixture-payload-mode illegal-model');
  await p.prompt('Illegal model rewrite must not send');
  assert.equal(f.requests.length, beforeModel);
  const beforeRewrite = f.requests.length;
  await p.send('/fixture-payload-mode rewrite-user');
  await p.prompt('Last-user text replacement must not send');
  assert.equal(f.requests.length, beforeRewrite);
  const beforeAppendOverflow = f.requests.length;
  await p.send('/fixture-payload-mode append-overflow');
  await p.prompt('Last-user append overflow must not send');
  assert.equal(f.requests.length, beforeAppendOverflow);
  assert(f.log.some(e => e.type === 'admission' && e.data.outcome === 'reject' && e.data.payload));
  assert(f.log.some(e => e.type === 'admission' && e.data.outcome === 'reject' && e.data.payload?.transform === 'last-user-text-append' && e.data.code === 'CAPACITY'));
  assert(!JSON.stringify(f.log.filter(e => e.type === 'admission')).includes('outside-selection'));
  assert(!JSON.stringify(f.log).includes('nunc-synthetic-last-user-append'));
  await p.send('/fixture-payload-mode identity');
  await p.prompt('Seed for maintenance ' + 'a'.repeat(12000));
  await p.prompt('Kept for maintenance ' + 'b'.repeat(3000));
  const beforeCompact = f.requests.length;
  await p.command('compact');
  assert(f.requests.length > beforeCompact);
  assert(f.requests.some(r => r.kind === 'maintenance'));
  const beforeBadCompact = f.requests.length;
  await p.send('/fixture-payload-mode overcap');
  await assert.rejects(p.command('compact'));
  assert.equal(f.requests.length, beforeBadCompact);
  await p.quit();
  outcome = {
    status: 'PROVEN_CONTROLLED',
    safeSends: 5,
    zeroSend: ['overcap', 'nostream', 'grow', 'illegal-model', 'rewrite-user', 'append-overflow'],
    maintenanceIdentity: true,
    maintenanceOvercapZeroSend: true,
    memoryQuality: 'UNPROVEN: controlled service',
  };
} catch (error) { outcome.error = { message: error.message, stack: error.stack }; console.error(error); process.exitCode = 1; }
finally { await f.close(outcome); console.log(JSON.stringify({ ...outcome, evidence: f.dir })); }
