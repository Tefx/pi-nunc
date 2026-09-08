// purpose: Verify required-capacity cancellation across stock RPC manual, threshold, and overflow paths.
// usage: node scripts/observe-required-capacity.mjs
// effects: Isolated stock RPC, fictional native authentication and controlled loopback SSE; saves evidence and cleans up.
// requires: Locked local build and stock-driver.mjs; no live model/credentials.
import assert from 'node:assert/strict';
import { StockFixture } from './stock-driver.mjs';

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
      config: { memory: { maxTokens: 100 }, extraction: { outputTokens: 8192 } },
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
