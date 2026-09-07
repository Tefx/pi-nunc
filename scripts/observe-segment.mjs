// purpose: Exercise downstream continuation controls through real stock RPC with a loopback fixture.
// usage: node scripts/observe-segment.mjs c1|c2|c3|outside|codex|codex-timeout|c4-full|c4-capacity|late-d|late-d-cancel|late-d-race
// effects: New isolated target; native tools/session/HTTP; bounded cleanup; retained mechanics evidence.
// requires: Locked build and stock-driver.mjs. Scripted outputs cannot establish memory quality.
import assert from 'node:assert/strict';
import { cp, readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { StockFixture, root, records } from './stock-driver.mjs';
import { runSegment } from '../dist/src/live/worker.js';
import { expandGeneratedText, loadScenario } from '../dist/src/live/scenarios.js';
import { SessionManager, truncateHead } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { readLedger, ledgerSummary } from '../dist/src/live/budget.js';
const which = process.argv[2] ?? 'c1', nativeDefaults = which === 'codex-defaults', timeout = which === 'codex-timeout';
const late = which === 'late-d' || which === 'late-d-cancel' || which === 'late-d-race', cancelLate = which === 'late-d-cancel', raceLate = which === 'late-d-race', full = which === 'c4-full', capacity = which === 'c4-capacity';
const codex = which === 'codex' || nativeDefaults || timeout, id = timeout ? 'c1' : codex ? 'c2' : which === 'outside' ? 'c1' : late ? 'c1' : full || capacity ? 'c4' : which;
assert(['c1', 'c2', 'c3', 'c4'].includes(id));
const f = await new StockFixture().setup(codex ? { api: 'openai-codex-responses' } : {}), target = join(f.dir, 'nunc-live-controlled'); await mkdir(target);
const input = JSON.parse(await readFile(join(root, codex ? 'tests/live/preflight-codex-input.json' : 'tests/live/preflight-input.json'), 'utf8'));
input.target.repository = root; input.target.stateRoot = target;
input.scenarios[0].id = id;
if (full) input.scenarios[0].variant = 'full';
if (capacity) input.scenarios[0].variant = 'capacity';
if (late) input.scenarios[0].variant = 'late-d';
const runtime = capacity ? await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), refreshOnCreate: false, allowModelNetwork: false }) : undefined;
const gemini = capacity ? runtime.getModel('openrouter', 'google/gemini-3.8-flash') : undefined;
if (capacity) assert(gemini && gemini.contextWindow === 1048576 && gemini.maxTokens === 65536);
if (!codex) input.scenarios[0].config = capacity ? { nunc: { memory: { fraction: 0.1 }, rolling: { keepRecentFraction: 0.2 }, extraction: { toolResults: 'full', outputTokens: 4096 }, budget: { safetyTokens: 1024, growthTokens: 128, inputLimit: 29000 } }, compaction: { enabled: false, reserveTokens: gemini.contextWindow - 10000, keepRecentTokens: 1 } } : { nunc: { memory: { fraction: 0.1 }, rolling: { keepRecentFraction: 0.2 }, extraction: { toolResults: 'full', outputTokens: 2048 }, budget: { safetyTokens: 512, growthTokens: 128 } }, compaction: { enabled: false, reserveTokens: full ? 100000 : 50000, keepRecentTokens: 1 }, retentionCalibration: which === 'outside' ? { minFraction: 0.8, maxFraction: 0.9 } : { minFraction: 0.0001, maxFraction: 0.95 } };
const model = codex ? { ...openaiCodexProvider().getModels().find(m => m.id === 'gpt-6-astra'), baseUrl: f.endpoint } : { id: 'nunc-native', name: 'nunc-native', provider: 'groq', api: 'openai-completions', baseUrl: f.endpoint, reasoning: false, input: ['text', 'image'], contextWindow: capacity ? gemini.contextWindow : 60000, maxTokens: capacity ? gemini.maxTokens : 20000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
if (full || capacity) {
  if (full) model.contextWindow = 200000;
  if (capacity) { input.limits.maxOutputTokens = gemini.maxTokens; input.limits.maxCostUsd = null; }
  const catalog = JSON.parse(await readFile(join(f.state, 'agent/models.json'), 'utf8'));
  catalog.providers.groq.models[0].contextWindow = model.contextWindow;
  catalog.providers.groq.models[0].maxTokens = model.maxTokens;
  await writeFile(join(f.state, 'agent/models.json'), JSON.stringify(catalog));
}
const overrides = { models: [model], ...(nativeDefaults ? {} : { controlledModels: JSON.parse(await readFile(join(f.state, 'agent/models.json'), 'utf8')) }) };
if (nativeDefaults) {
  process.env.PI_CODING_AGENT_DIR = join(f.state, 'agent');
  process.env.HOME = join(f.state, 'home');
  input.effective = { source: 'invoking-runtime', provider: model.provider, model: model.id, thinking: 'high', transport: 'sse', compaction: input.scenarios[0].config.compaction, settings: {} };
}
if (codex && !nativeDefaults) {
  await mkdir(join(target, 'host'));
  await writeFile(join(target, 'host/auth.json'), JSON.stringify({ 'openai-codex': f.oauth }), { mode: 0o600 });
}
const write = (path, content) => [{ tool: { name: 'write', input: { path, content: JSON.stringify(content) } } }, 'Saved.'];
const read = path => [{ tool: { name: 'read', input: { path } } }, 'Read.'];
const loaded = full || capacity ? await loadScenario(root, input.scenarios[0]) : undefined;
const fullOffset = full || capacity ? truncateHead(expandGeneratedText(loaded.input.generatedFiles[0])).outputLines + 1 : 0;
const giantRead = [{ tool: { name: 'read', input: { path: 'inspection.txt' } } }, { tool: { name: 'read', input: { path: 'inspection.txt', offset: fullOffset } } }, 'Read complete.'];
const steps = full ? [...giantRead, ...write('disposition.json', { batch: 'Q7', disposition: 'quarantine', reason: 'Controlled fixture reason.' })] : capacity ? giantRead : late ? ['Pending.', ...write('scratch.json', { status: 'pending' }), ...write('decision.json', { route: null, reason: 'Controlled fixture reason.' })] : id === 'c1' ? ['Pending.', ...read('probe.json'), ...write('decision.json', { route: 'direct', reason: 'Controlled fixture reason.' })] : id === 'c2' ? ['Pending.', ...write('sum.json', { sum: 46 }), ...write('product.json', { product: 104 }), ...write('difference.json', { difference: 63 }), ...write('retry.json', { supportedNodeMajors: [18], retryLimit: 2, retryBeforeCommit: true, retryAfterSuccessfulCommit: false })] : [read('routes.json')[0], read('records.json')[0], 'Read.', ...write('note.txt', 'Chlorophyll absorbs other wavelengths. Reflected green light reaches the eye.'), 'Cannot establish the requested continuation from controlled empty memory.'];
f.response = (row, source) => source ? JSON.stringify({ add: [], remove: [], priority: source.M.map(s => s.id) }) : (() => { assert(steps.length, 'scripted native service inventory exceeded'); return steps.shift(); })();
let outcome = { status: 'FAIL', case: which };
try {
  if (timeout) f.hold('main');
  const cancel = new AbortController();
  if (late) overrides.signal = cancel.signal;
  if (late && !raceLate) {
    f.hold('maintenance');
    void f.wait(() => f.requests.some(r => r.kind === 'maintenance'), 'maintenance').then(async () => {
      if (cancelLate) cancel.abort();
      await new Promise(resolve => setTimeout(resolve, 800));
      f.release('maintenance');
    }).catch(() => f.release('maintenance'));
  }
  const job = { input, scenarioIndex: 0, deadline: Date.now() + (timeout ? 5000 : full || late || capacity ? 70000 : 45000), resume: false };
  const report = await runSegment(job, overrides);
  assert.equal(report.status, which === 'outside' || timeout || cancelLate || raceLate || capacity ? 'UNPROVEN' : id === 'c3' ? 'PAUSED' : 'OBSERVED', JSON.stringify({ status: report.status, reason: report.reason, diagnostic: report.diagnostic, prerequisites: report.prerequisites, commands: report.commands, preparationFailure: report.preparationFailure }));
  if (timeout) {
    assert.equal(f.requests.length, 1); assert(f.requests[0].closed);
    const ledger = readLedger(join(target, 'calls.jsonl')), usage = ledgerSummary(ledger);
    assert.equal(usage.calls, 1); assert.equal(usage.reservedTokens, 400000); assert.equal(usage.reservedCostUsd, null);
    assert(report.pid > 0); assert.throws(() => process.kill(report.pid, 0), { code: 'ESRCH' });
    await writeFile(join(f.dir, 'ledger.json'), JSON.stringify(ledger));
  } else if (which === 'outside') { assert.equal(report.reason, 'CALIBRATION'); assert.equal(report.maintenance.length, 0); assert.equal(f.requests.length, 3); }
  else if (capacity) {
    const result = report.maintenance.at(-1);
    assert.equal(result?.ok, false);
    assert.equal(result.code, 'CAPACITY', JSON.stringify({ reason: report.reason, result }));
    assert.equal(result.observations.requests, 0);
    const accounting = result.observations.accounting;
    assert(accounting && accounting.fullExtractionTokens > accounting.extractionInputLimit, JSON.stringify(accounting));
    assert(accounting.normalExtractionAtTrigger <= accounting.extractionInputLimit, 'fixture isolates actual extraction overshoot while trigger-headroom advice remains sufficient');
    assert.equal(accounting.extraInputTokens ?? input.scenarios[0].config.nunc.budget.extraExtractionInputTokens ?? 0, 0);
    assert.equal(accounting.extractionInputLimit, 27976);
    assert.equal(accounting.effectiveTrigger, 10000);
    assert.equal(model.contextWindow, 1048576); assert.equal(model.maxTokens, 65536);
    assert.equal(input.scenarios[0].config.nunc.budget.inputLimit, 29000);
    assert.equal(f.requests.filter(r => r.kind === 'maintenance').length, 0);
    assert(report.prerequisites.some(p => p.check.includes('full extraction demonstrably exceeds') && p.status === 'PROVEN'));
    assert(report.prerequisites.some(p => p.check.includes('preserved prior saved memory') && p.status === 'PROVEN'));
    const saved = SessionManager.open(report.sessionFile);
    assert.equal(saved.getBranch().filter(e => e.type === 'compaction').length, 0);
  }
  else if (cancelLate || raceLate) {
    const cmds = report.commands ?? [];
    assert.equal(cmds.filter(c => c.type === 'clear_queue').length, 0);
    assert.equal(cmds.filter(c => c.type === 'prompt' && typeof c.message === 'string' && c.message.includes('the cache route is incompatible')).length, 0);
    assert(!report.prerequisites.some(p => p.check.includes('delivered verbatim once') && p.status === 'PROVEN'));
    if (raceLate) assert(report.prerequisites.some(p => p.check.includes('overlapped one accepted steer') && p.status === 'UNPROVEN') || report.reason === 'MAINTENANCE' || report.reason === 'PREREQUISITE');
    const after = f.requests.length;
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(f.requests.length, after, 'cancelled or raced maintenance must not continue later effects');
    const extraction = f.requests.find(r => r.kind === 'maintenance');
    if (extraction) assert(!JSON.stringify(extraction.payload).includes('the cache route is incompatible'));
  }
  else {
    const expected = id === 'c2' ? 3 : 1;
    assert.equal(report.calibrations.length, expected); assert.equal(report.maintenance.length, expected);
    assert(report.prerequisites.every(p => p.status === 'PROVEN'), JSON.stringify(report.prerequisites));
    const saved = SessionManager.open(report.sessionFile), branch = saved.getBranch(), checkpoints = branch.filter(e => e.type === 'compaction');
    assert.equal(checkpoints.length, expected);
    for (let n = 0; n < checkpoints.length; n++) assert.equal(checkpoints[n].firstKeptEntryId, report.calibrations[n].firstKeptEntryId);
    assert(f.requests.some(r => (r.payload.messages ?? r.payload.input).some(m => m.role === 'tool' || m.type === 'function_call_output')), 'genuine stock tool result delivered');
    if (full) {
      const extraction = f.requests.find(r => r.kind === 'maintenance');
      assert(JSON.stringify(extraction.payload).includes('verified exception: batch Q7'));
      assert.equal(report.prerequisites.filter(p => p.check.includes('native truncation hid') || p.check.includes('c4/full source exceeds')).every(p => p.status === 'PROVEN'), true);
    }
    if (late) {
      const dText = 'Correction: the cache route is incompatible with account isolation. Do not use it.';
      const cmds = report.commands ?? [];
      const steers = cmds.filter(c => c.type === 'steer');
      assert.equal(steers.length, 1, JSON.stringify(cmds));
      assert.equal(steers[0].message, dText);
      assert.equal(cmds.filter(c => c.type === 'clear_queue').length, 0, 'native queue must not be cleared');
      assert.equal(cmds.filter(c => c.type === 'prompt' && c.message === dText).length, 0, 'D must not be reissued as an ordinary prompt');
      assert.equal(cmds.filter(c => c.type === 'prompt' && typeof c.message === 'string' && c.message.includes('Write decision.json')).length, 1);
      const extraction = f.requests.find(r => r.kind === 'maintenance');
      assert(!JSON.stringify(extraction.payload).includes('the cache route is incompatible'));
      const afterMaint = f.requests.findIndex(r => r.kind === 'maintenance');
      const firstMain = f.requests.slice(afterMaint + 1).find(r => r.kind === 'main');
      assert(firstMain, 'missing first post-freeze main request');
      const firstBody = JSON.stringify(firstMain.payload);
      assert(firstBody.includes('the cache route is incompatible'), 'first post-freeze native request must include D');
      assert(firstBody.includes('Write decision.json'), 'first post-freeze native request must include the later ordinary turn');
      assert.equal(branch.filter(e => e.type === 'message' && e.message.role === 'user' && JSON.stringify(e.message).includes('the cache route is incompatible')).length, 1);
    }
    if (codex) {
      const ledger = readLedger(join(target, 'calls.jsonl')), usage = ledgerSummary(ledger);
      assert(report.maintenance.every(r => r.observations.usage.cost === null), 'subscription placeholders never claim observed billing');
      assert.equal(usage.calls, 12); assert.equal(usage.reservedTokens, 4800000); assert.equal(usage.reservedCostUsd, null); assert.equal(usage.costUsd, null);
      assert.deepEqual(usage.unreconciledCallIds, []);
      assert(ledger.filter(r => r.kind === 'reserve').every(r => r.outputCeiling === 128000 && r.catalogReservationUsd > 0));
      assert(f.requests.every(r => r.payload.max_output_tokens === undefined));
      if (nativeDefaults) {
        assert(f.requests.filter(r => !r.source).some(r => r.payload.reasoning?.effort === 'high'), 'native current thinking survives invocation');
        await assert.rejects(readFile(join(target, 'host/auth.json')), { code: 'ENOENT' });
        assert((await readFile(join(f.state, 'agent/auth.json'), 'utf8')).length > 0, 'fictional pre-existing native owner remains in place');
      }
      await writeFile(join(f.dir, 'ledger.json'), JSON.stringify(ledger));
    }
    await writeFile(join(f.dir, 'native-session.jsonl'), await readFile(report.sessionFile));
    if (id === 'c3') {
      const before = saved.buildContextEntries(), resumed = await runSegment({ ...job, resume: true }, overrides);
      assert.notEqual(resumed.pid, report.pid); assert.equal(resumed.sessionFile, report.sessionFile);
      assert(resumed.prerequisites.some(p => p.check.startsWith('new process resumed') && p.status === 'PROVEN'));
      assert.equal(resumed.status, 'UNPROVEN', 'missing artifact cannot claim quality success');
      await writeFile(join(f.dir, 'resumed.json'), JSON.stringify(resumed));
    }
  }
  await writeFile(join(f.dir, 'segment.json'), JSON.stringify(report));
  outcome = { status: 'PROVEN_CONTROLLED', case: which, nativePid: report.pid, requests: f.requests.length, calibrations: report.calibrations.length, memoryQuality: 'UNPROVEN: scripted service responses test plumbing only' };
} catch (e) { outcome.error = { message: e.message, stack: e.stack }; console.error(e); process.exitCode = 1; }
finally {
  if (full || late || capacity) {
    const dest = join(root, '.scratch/observation-support-handoff', which);
    await mkdir(dest, { recursive: true });
    const caseRoot = join(target, `${id}${late ? '-late-d' : full ? '-full' : capacity ? '-capacity' : ''}`);
    try {
      for (const name of await readdir(caseRoot)) {
        if (name === 'task') continue;
        await cp(join(caseRoot, name), join(dest, name), { recursive: true }).catch(() => {});
      }
    } catch { /* Target may already be gone. */ }
    await writeFile(join(dest, 'segment-outcome.json'), JSON.stringify({ ...outcome, commands: undefined }, null, 2)).catch(() => {});
  }
  await rm(target, { recursive: true, force: true }); await f.close(outcome);
  if (full || late || capacity) {
    const dest = join(root, '.scratch/observation-support-handoff', which);
    await mkdir(dest, { recursive: true });
    await cp(f.dir, join(dest, 'stock'), { recursive: true }).catch(() => {});
  }
  console.log(JSON.stringify({ ...outcome, evidence: f.dir, handoff: (full || late || capacity) ? join(root, '.scratch/observation-support-handoff', which) : undefined }));
}
