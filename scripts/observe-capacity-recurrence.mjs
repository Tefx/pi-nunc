// purpose: Stock Pi regression for soft-planning overruns versus binding main input limits.
// usage: node scripts/observe-capacity-recurrence.mjs
// effects: Isolated CLI/RPC, fictional OAuth, loopback SSE and saved evidence; fixture cleanup.
// requires: Current dist, locked supported stable Pi1.x; no live credentials or service.
import assert from 'node:assert/strict';
import { StockFixture, text } from './stock-driver.mjs';
import { estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate';

for (const test of [
  { name: 'short-history-auto', enabled: true },
  { name: 'short-history-manual', enabled: false },
  { name: 'payload-crosses-plan', enabled: true, append: true },
  { name: 'fresh-crosses-plan', enabled: false, fresh: true },
  { name: 'explicit-limit-binds', enabled: false, inputLimit: 254595, reject: true },
  { name: 'model-window-binds', enabled: false, receipt: 272000, reject: true },
]) {
  const f = await new StockFixture().setup({
    api: 'openai-codex-responses',
    config: { extraction: {}, budget: test.inputLimit ? { inputLimit: test.inputLimit } : {} },
    compaction: { enabled: test.enabled, reserveTokens: 16384, keepRecentTokens: 20000 },
  });
  let outcome = { status: 'FAIL', case: test.name, usage: 'Controlled boundary receipts, not live tokenizer evidence' };
  f.response = row => ({ text: 'Controlled ordinary response.', ...(row.number === 2 ? { input: test.receipt ?? (test.append ? 254489 : 254497), outputTokens: 50 } : {}) });
  try {
    const p = f.start(); await p.command('get_state');
    if (test.fresh) {
      const scale = 1000 / estimateTextTokens('x'.repeat(4000));
      await p.prompt('Fresh evidence: ' + 'x'.repeat(Math.floor(1018500 * scale)));
      assert.equal(f.requests.length, 1);
    } else {
      await p.prompt('First evidence'); await p.prompt('Recent evidence');
      if (test.append) await p.send('/fixture-payload-mode append');
      await p.prompt('next');
      assert.equal(f.requests.length, test.reject ? 2 : 3, 'binding rejection sends zero HTTP; soft overrun sends once');
    }
    const observations = f.log.filter(e => e.type === 'admission' && e.data.kind === 'main').map(e => e.data);
    const observation = observations.at(-1);
    assert(observation);
    const errors = f.log.filter(e => e.type === 'message' && e.data.role === 'assistant' && e.data.stopReason === 'error');
    if (test.reject) {
      assert.equal(observation.outcome, 'reject'); assert.equal(observation.code, 'CAPACITY');
      assert.equal(observation.inputLimit, test.inputLimit ?? 271999);
      assert.equal(errors.length, 1);
    } else {
      assert.equal(errors.length, 0);
      assert(!observations.some(o => o.outcome === 'reject'));
      assert.equal(observation.outcome, 'delegate');
      assert.equal(observation.inputLimit, 271999);
      assert.equal(observation.plannedInputLimit, 254592);
      assert.equal(observation.inputExceededPlan, true);
      assert.equal(observation.estimator, test.fresh ? 'pi-heuristic' : 'pi-usage-backed');
      // Receipt254497 + prior output50 + one user-message frame/content.
      const trailing = 32 + estimateTextTokens('user') + 16 + estimateTextTokens('next') + estimateTextTokens('{}');
      if (!test.fresh && !test.append) assert.equal(observation.inputTokens, 254497 + 50 + trailing);
      if (test.append) {
        assert.equal(observations.filter(o => !o.payload).at(-1).inputTokens, 254489 + 50 + trailing);
        assert(observation.inputTokens > observation.plannedInputLimit);
        assert.equal(observation.payload.transform, 'last-user-text-append');
      }
      await p.prompt('Continue once');
      const entries = (await p.command('get_entries')).entries;
      assert.equal(entries.at(-1).message.stopReason, 'stop');
      for (const value of test.fresh ? ['Continue once'] : ['First evidence', 'Recent evidence', 'next', 'Continue once']) {
        assert.equal(entries.filter(e => e.type === 'message' && e.message.role === 'user' && text(e.message) === value).length, 1);
      }
    }
    assert.equal(f.log.filter(e => e.type === 'maintenance').length, 0, 'soft planning pressure never fabricates maintenance');
    assert.equal(f.log.filter(e => e.type === 'compact').length, 0);
    assert(f.requests.every(r => r.payload.max_output_tokens === undefined));
    await p.quit();
    outcome = { ...outcome, status: 'PROVEN_CONTROLLED', observation, requests: f.requests.length, compactions: 0 };
  } catch (error) {
    outcome.error = { message: error.message, stack: error.stack }; process.exitCode = 1;
  } finally {
    await f.close(outcome); console.log(JSON.stringify({ ...outcome, evidence: f.dir }));
  }
  if (process.exitCode) break;
}
