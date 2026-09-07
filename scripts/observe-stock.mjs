// purpose: Tracked actual stock RPC/TUI native-admission, maintenance and queue assertions.
// usage: node scripts/observe-stock.mjs rpc|tui
// effects: Controlled loopback calls and isolated PTY/CLI state; saves evidence, cleans fixtures.
// requires: Built tracked local Pi/Nunc, stock-driver.mjs, Python3 for TUI; no live service.
import assert from 'node:assert/strict';
import { StockFixture, text, records } from './stock-driver.mjs';
const mode = process.argv[2]; assert(['rpc', 'tui'].includes(mode), 'Select rpc or tui');
const IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBMsAAAAASUVORK5CYII=';
// Threshold runs after A's response, so retain the complete recent turn rather than only its assistant suffix.
const f = await new StockFixture().setup({ config: { rolling: { keepRecentFraction: 0.9 }, budget: { imageTokens: 1000 } }, ...(process.argv[3] ? { artifactParent: process.argv[3] } : {}) });
let outcome = { status: 'FAIL', mode };
const OLD = 'Old delivered work:' + 'a'.repeat(92000), A = 'Delivered steering A:' + 'b'.repeat(68000);
const B = 'Follow-up B: preserve order', C = 'Queued extension evidence C', D = 'Late correction D: changed after freeze';
try {
  f.hold('main'); f.hold('maintenance');
  const p = f.start(mode);
  await f.wait(() => f.log.some(e => e.type === 'start' && e.data.mode === mode), 'real stock loader');
  if (mode === 'tui') await new Promise(resolve => setTimeout(resolve, 500));
  await p.send(OLD); await f.wait(() => f.requests.length === 1, 'first native request');
  if (mode === 'rpc') await p.command('steer', { message: A }); else await p.send(A);
  if (mode === 'rpc') await p.command('prompt', { message: B, streamingBehavior: 'followUp', images: [{ type: 'image', data: IMAGE, mimeType: 'image/png' }] }); else await p.send(B, true);
  await p.send('/fixture-message ' + C);
  await f.wait(() => f.log.some(e => e.type === 'custom_queued'), 'custom queue');
  f.release('main');
  await f.wait(() => f.requests.some(r => r.kind === 'maintenance'), 'real engine extraction');
  const extraction = f.requests.find(r => r.kind === 'maintenance');
  const source = records(extraction.payload);
  assert(source.some(r => r.region === 'B' && r.messages.some(m => text(m) === OLD)));
  assert(source.some(r => r.region === 'K' && r.messages.some(m => text(m) === A)));
  for (const value of [B, C, D, IMAGE]) assert(!JSON.stringify(extraction.payload).includes(value), 'future D must not enter frozen extraction');
  const rejected = f.log.filter(e => e.type === 'admission' && e.data.outcome === 'reject');
  assert.equal(rejected.length, 0, 'normal planning pressure does not generate a local overflow');
  assert.equal(f.requests.filter(r => r.kind === 'main').length, 2, 'both delivered inputs sent before native threshold maintenance');
  if (mode === 'rpc') await p.command('steer', { message: D }); else await p.send(D);
  f.release('maintenance');
  await f.wait(() => f.log.filter(e => e.type === 'snapshot').length >= 2, 'native recovery and queued continuation snapshot');
  const compacts = f.log.filter(e => e.type === 'compact'); assert.equal(compacts.length, 1); assert.equal(compacts[0].data.reason, 'threshold');
  const after = f.log.filter(e => e.type === 'snapshot').at(-1).data;
  assert.equal(after.editor, '', 'automatic recovery never withdraws input to editor'); assert.equal(after.pending, false);
  const entries = after.entries;
  for (const value of [OLD, A, B, D]) assert.equal(entries.filter(e => e.type === 'message' && e.message.role === 'user' && text(e.message) === value).length, 1, 'each original input persisted once');
  assert.equal(entries.filter(e => e.type === 'custom_message' && e.content === C).length, 1);
  const delivery = f.log.filter(e => e.type === 'message' && ['user', 'custom'].includes(e.data.role)).map(e => text(e.data));
  assert.deepEqual(delivery, [OLD, A, C, D, B]);
  if (mode === 'rpc') {
    assert.equal(entries.find(e => e.type === 'message' && text(e.message) === B).message.content.filter(b => b.type === 'image' && b.data === IMAGE).length, 1);
    assert(JSON.stringify(f.requests.filter(r => r.kind === 'main').at(-1).payload).includes('data:image/png;base64,' + IMAGE), 'future image delivered to native transport unchanged');
  }
  const retry = f.requests.filter(r => r.kind === 'main')[2];
  assert(!JSON.stringify(retry.payload).includes(OLD)); assert(JSON.stringify(retry.payload).includes(A));
  assert(JSON.stringify(retry.payload).includes(C)); assert(!JSON.stringify(retry.payload).includes(B));
  const snapshot = entries.find(e => e.type === 'compaction'); assert(snapshot?.details.nunc.slots.length);
  // Actual user stop while requests/queues are active. The TUI alone owns withdrawal.
  const beforeCancel = f.requests.length, beforeCompacts = compacts.length;
  f.hold('main'); await p.send('Cancellation foreground'); await f.wait(() => f.requests.length > beforeCancel, 'cancellable HTTP');
  if (mode === 'rpc') await p.command('steer', { message: 'Cancel queued steering' }); else await p.send('Cancel queued steering');
  await p.send('Cancel queued follow-up', true); await p.send('/fixture-message Cancel queued extension');
  const settled = f.log.filter(e => e.type === 'snapshot').length;
  if (mode === 'rpc') { await p.command('clear_queue'); await p.command('abort'); } else p.keys('\x1b');
  await f.wait(() => f.log.filter(e => e.type === 'snapshot').length > settled, 'user cancellation settles');
  assert.equal(f.log.filter(e => e.type === 'compact').length, beforeCompacts);
  assert.equal(f.requests.length, beforeCancel + 1, 'cancellation must not restart');
  if (mode === 'tui') {
    const n = f.log.filter(e => e.type === 'snapshot').length; p.keys('\x1b[17~');
    await f.wait(() => f.log.filter(e => e.type === 'snapshot').length > n, 'actual editor read via public shortcut');
    const cancelled = f.log.filter(e => e.type === 'snapshot').at(-1).data;
    assert(cancelled.editor.includes('Cancel queued steering')); assert(cancelled.editor.includes('Cancel queued follow-up'));
    assert(!cancelled.entries.some(e => e.type === 'custom_message' && e.content === 'Cancel queued extension'));
    p.keys('\x03'); // Clear restored editor only after its observation.
  }
  f.release('main');
  const started = f.log.filter(e => e.type === 'start').length;
  if (mode === 'rpc') await p.command('new_session'); else await p.send('/new');
  await f.wait(() => f.log.filter(e => e.type === 'start').length > started, 'new isolated session');
  await p.prompt(OLD); f.hold('maintenance');
  const beforeStopMaintenance = f.requests.length, savedBeforeStop = f.log.filter(e => e.type === 'compact').length;
  await p.send(A); await f.wait(() => f.requests.slice(beforeStopMaintenance).some(r => r.kind === 'maintenance'), 'cancellable native extraction');
  assert.equal(f.requests.at(-1).kind, 'maintenance');
  if (mode === 'rpc') await p.command('steer', { message: 'Queued during cancelled maintenance' }); else await p.send('Queued during cancelled maintenance');
  const beforeSettled = f.log.filter(e => e.type === 'settled').length;
  if (mode === 'rpc') { await p.command('clear_queue'); await p.command('abort'); } else p.keys('\x1b');
  await f.wait(() => f.log.filter(e => e.type === 'settled').length > beforeSettled, 'cancelled maintenance settles');
  f.release('maintenance');
  assert.equal(f.log.filter(e => e.type === 'compact').length, savedBeforeStop, 'cancelled extraction never commits');
  assert.equal(f.requests.length, beforeStopMaintenance + 2, 'one ordinary main then cancelled extraction; no resumed main');
  if (mode === 'tui') p.keys('\x03');
  await p.quit();
  outcome = { status: 'PROVEN_CONTROLLED', mode, requirements: ['real stock loader and native transport', 'engine maintenance with one native CompactionEntry', 'native threshold maintenance without local soft-budget errors', 'delivered B/K and future D separation', 'steering/follow-up/custom delivery exactly once in order', 'empty editor after recovery', 'real user cancellation without restart'], requests: f.requests.length, compactions: 1, memoryQuality: 'UNPROVEN: controlled service responses' };
} catch (error) { outcome.error = { message: error.message, stack: error.stack }; console.error(error); process.exitCode = 1; }
finally { await f.close(outcome); console.log(JSON.stringify({ ...outcome, evidence: f.dir })); }
