// purpose: Verify explicit-hard-limit cancellation and default elastic required-memory continuation on stock RPC overflow.
// usage: node scripts/observe-required-capacity.mjs
// effects: Isolated stock RPC, fictional native authentication and controlled loopback SSE; saves evidence and cleans up.
// requires: Locked local build and stock-driver.mjs; no live model/credentials.
import assert from 'node:assert/strict';
import { buildContextEntries } from '@earendil-works/pi-coding-agent';
import { StockFixture, records } from './stock-driver.mjs';
import { memoryTokens } from '../dist/src/engine/accounting.js';
import { project } from '../dist/src/pi/projection.js';

const patch = JSON.stringify({
  add: [{ key: 'oversizedReq', text: 'Mandatory shipment constraint '.repeat(400) }],
  remove: [],
  priority: ['oversizedReq'],
  required: ['oversizedReq'],
});

const results = [];
let overallStatus = 'FAIL';

try {
  for (const mode of ['manual', 'threshold', 'overflow']) {
    const f = await new StockFixture().setup({
      config: { memory: { maxTokens: 100, hardMaxTokens: 100 }, extraction: { outputTokens: 8192 } },
      compaction: { enabled: false },
      timeoutMs: 45000,
    });
    let stage = 'seed';
    let mainCalls = 0;
    let summary;

    f.response = row => {
      if (row.kind === 'maintenance') return { text: patch, input: 1000, outputTokens: 3500 };
      mainCalls++;
      if (stage === 'overflow') return { status: 400, message: 'maximum context length exceeded' };
      return { text: 'Controlled response', input: stage === 'seed' && mode === 'threshold' ? 24500 : 20000, outputTokens: 50 };
    };

    try {
      const p = f.start('rpc');
      await f.wait(() => f.log.some(e => e.type === 'start'), 'start');
      await p.prompt('old:' + 'a'.repeat(48000));
      await p.prompt('recent:' + 'b'.repeat(8800));
      const beforeMain = mainCalls;
      stage = mode;

      if (mode === 'manual') {
        try { await p.command('compact'); }
        catch (e) { if (!String(e).includes('cancel')) throw e; }
      } else {
        await p.command('set_auto_compaction', { enabled: true });
        await p.prompt('BOUND-' + mode);
      }

      stage = 'recovery';
      await p.prompt('RECOVER-' + mode);
      await p.send('/fixture-inspect');
      await f.wait(() => f.log.at(-1)?.type === 'snapshot', 'snapshot');

      const snapshot = f.log.filter(e => e.type === 'snapshot').at(-1).data;
      const compactions = snapshot.entries.filter(e => e.type === 'compaction').length;
      assert.equal(compactions, 0, `${mode}: required-capacity failure must not commit any compaction`);

      // Capture full failure + recovery sequence through terminal
      const maintenanceEvents = f.log
        .filter(e => e.type === 'maintenance')
        .map(e => ({
          reason: e.data.reason,
          code: e.data.result.code,
          required: e.data.result.observations.required,
        }));

      const expectedEvents = 1;
      const expectedMainDelta = mode === 'manual' ? 1 : 2;
      assert.equal(maintenanceEvents.length, expectedEvents, `${mode}: expected exactly ${expectedEvents} maintenance event across full sequence`);
      assert.equal(maintenanceEvents[0].reason, mode, `${mode}: maintenance reason must be ${mode}`);
      assert.equal(maintenanceEvents[0].code, 'CAPACITY', `${mode}: maintenance must fail with CAPACITY`);
      assert.equal(maintenanceEvents[0].required?.failed, true, `${mode}: required items must fail`);
      assert.deepEqual(maintenanceEvents[0].required?.declared, ['oversizedReq'], `${mode}: declared required items must match`);

      const actualMainDelta = mainCalls - beforeMain;
      assert.equal(actualMainDelta, expectedMainDelta, `${mode}: expected ${expectedMainDelta} main calls from bound through recovery`);

      // Verify each user prompt was delivered once without duplication
      const userEntries = snapshot.entries.filter(e => e.type === 'message' && e.message.role === 'user');
      const expectedPrompts = mode === 'manual'
        ? ['old:', 'recent:', 'RECOVER-manual']
        : ['old:', 'recent:', 'BOUND-' + mode, 'RECOVER-' + mode];
      assert.equal(userEntries.length, expectedPrompts.length, `${mode}: expected ${expectedPrompts.length} delivered user prompts`);
      for (const [idx, prefix] of expectedPrompts.entries()) {
        const text = typeof userEntries[idx].message.content === 'string'
          ? userEntries[idx].message.content
          : JSON.stringify(userEntries[idx].message.content);
        assert(text.includes(prefix), `${mode}: prompt ${idx} must contain ${prefix}`);
      }

      await p.quit();
      summary = {
        mode,
        events: maintenanceEvents.length,
        compactions,
        mainDelta: actualMainDelta,
        exit: p.exit,
      };
      results.push(summary);
    } finally {
      await f.close(summary ?? { mode, error: 'probe incomplete' });
    }
  }
  // Default elastic behavior: an incremental required set grows beyond8192
  // during actual native provider-overflow recovery, without another extraction.
  const f = await new StockFixture().setup({ config: { extraction: { outputTokens: 8192 } }, compaction: { enabled: false }, timeoutMs: 45000 });
  const oldText = 'seed:'.repeat(5600), delta = 'stillactive:'.repeat(650);
  let phase = 'seed', overflows = 0, summary;
  f.response = row => {
    if (row.kind === 'maintenance') {
      const m = records(row.payload).find(r => r.source === 'F/M').M;
      const candidate = phase === 'seed'
        ? { add: [{ key: 'seed', text: oldText }], remove: [], priority: ['seed'], required: ['seed'] }
        : { add: [{ key: 'delta', text: delta }, { key: 'optional', text: 'Completed process detail' }], remove: [], priority: ['optional', ...m.map(s => s.id), 'delta'], required: [...m.map(s => s.id), 'delta'] };
      return { text: JSON.stringify(candidate), input: 15000, outputTokens: phase === 'seed' ? 7300 : 2100 };
    }
    if (phase === 'overflow' && overflows++ === 0) return { status: 400, message: 'maximum context length exceeded' };
    return { text: 'Controlled continuation', input: 1500, outputTokens: 50 };
  };
  try {
    const p = f.start('rpc');
    await f.wait(() => f.log.some(e => e.type === 'start'), 'start');
    await p.prompt('OLD-SEED:' + 'a'.repeat(16000));
    await p.prompt('RECENT-SEED:' + 'b'.repeat(4000));
    await p.command('compact');
    const first = f.log.filter(e => e.type === 'maintenance').at(-1).data.result;
    assert(first.ok);
    assert.equal(first.candidate.memory.slots[0].text, oldText);
    assert(memoryTokens(first.candidate.memory.slots) < 8192);
    const before = f.requests.length, eventCount = f.log.filter(e => e.type === 'maintenance').length;
    phase = 'overflow';
    await p.command('set_auto_compaction', { enabled: true });
    await p.prompt('ELASTIC-OVERFLOW-CONTINUE');
    await p.send('/fixture-inspect');
    await f.wait(() => f.log.at(-1)?.type === 'snapshot', 'elastic snapshot');
    const events = f.log.filter(e => e.type === 'maintenance').slice(eventCount);
    assert.equal(events.length, 1);
    assert.equal(events[0].data.reason, 'overflow');
    const result = events[0].data.result;
    assert(result.ok, result.message);
    assert.equal(result.observations.requests, 1);
    assert.equal(result.observations.accounting.memoryHardLimit, null);
    assert.equal(result.observations.accounting.memoryTargetExceeded, true);
    assert.deepEqual(result.candidate.memory.slots.map(s => s.text), [oldText, delta]);
    assert(memoryTokens(result.candidate.memory.slots) > 8192);
    const snapshot = f.log.filter(e => e.type === 'snapshot').at(-1).data;
    assert.equal(snapshot.entries.filter(e => e.type === 'compaction').length, 2);
    assert.deepEqual(project(buildContextEntries(snapshot.entries)).memory, result.candidate.memory, 'native persisted checkpoint round trip');
    const users = snapshot.entries.filter(e => e.type === 'message' && e.message.role === 'user');
    assert.equal(users.filter(e => JSON.stringify(e.message.content).includes('ELASTIC-OVERFLOW-CONTINUE')).length, 1);
    const calls = f.requests.slice(before);
    assert.deepEqual(calls.map(r => r.kind), ['main', 'maintenance', 'main']);
    assert(JSON.stringify(calls.at(-1).payload).includes(oldText));
    assert(JSON.stringify(calls.at(-1).payload).includes(delta));
    assert.equal(snapshot.entries.at(-1).message?.stopReason, 'stop');
    await p.quit();
    summary = { mode: 'elastic-overflow', events: 1, additionalCompactions: 1, savedTokens: memoryTokens(result.candidate.memory.slots), mainDelta: 2, exit: p.exit };
    results.push(summary);
  } finally { await f.close(summary ?? { mode: 'elastic-overflow', error: 'probe incomplete' }); }
  overallStatus = 'PROVEN_CONTROLLED';
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  console.log(JSON.stringify({
    status: overallStatus,
    modes: results,
    memoryQuality: 'UNPROVEN: controlled protocol responses',
  }));
}
