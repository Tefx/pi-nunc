// purpose: Stock CLI lifecycle, repeated overlap, classification and explicit failure observations.
// usage: node scripts/observe-lifecycle.mjs
// effects: Controlled loopback calls, new isolated native sessions and evidence; fixture cleanup.
// requires: Built local Pi/Nunc and stock-driver.mjs.
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { StockFixture, records, text } from './stock-driver.mjs';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { checkRollover } from '../dist/src/live/scenarios.js';
const f = await new StockFixture().setup({ compaction: { enabled: false } });
let outcome = { status: 'FAIL' };
const count = type => f.log.filter(e => e.type === type).length;
try {
  let p = f.start(); await p.command('get_state');
  for (let n = 0; n < 4; n++) await p.prompt(`History ${n}:` + 'x'.repeat(5000));
  const state = await p.command('get_state'), originalFile = state.sessionFile;
  let previous;
  for (let n = 0; n < 3; n++) {
    const before = (await p.command('get_entries')).entries;
    await p.command('compact');
    const after = (await p.command('get_entries')).entries, saved = after.at(-1);
    assert.equal(saved.type, 'compaction'); assert(saved.details.nunc.slots.length);
    const checks = checkRollover(before, after, SessionManager.open(originalFile), f.log.filter(e => e.type === 'maintenance').at(-1).data.result, { action: 'rollover', afterTurn: 'fixture' }, {});
    assert(checks.every(c => c.status === 'PROVEN'), JSON.stringify(checks));
    if (previous) assert(before.findIndex(e => e.id === saved.firstKeptEntryId) < before.findIndex(e => e.id === previous.id), 'keep legal overlap before older checkpoint');
    const source = records(f.requests.filter(r => r.kind === 'maintenance').at(-1).payload);
    assert(source.filter(r => r.source === 'F/M').length === 1);
    assert(source.filter(r => r.region).every(r => before.find(e => e.id === r.entryId)?.type !== 'compaction'));
    if (previous) assert(!JSON.stringify(source.filter(r => r.region)).includes(previous.summary));
    const expectedK = source.filter(r => r.region === 'K').flatMap(r => r.messages);
    await p.prompt(`After checkpoint ${n}`);
    const wire = f.requests.filter(r => r.kind === 'main').at(-1).payload;
    assert.equal(wire.messages.map(text).join('\n').split(saved.summary).length - 1, 1, 'latest memory once');
    if (previous) assert(!wire.messages.map(text).join('\n').includes(previous.summary), 'superseded summary never re-enters main');
    for (const m of expectedK.filter(m => m.role === 'user')) assert(wire.messages.some(v => text(v) === text(m)), 'K user text unchanged');
    previous = saved;
  }
  const beforeRestart = (await p.command('get_entries')).entries;
  await p.quit(); p = f.start('rpc', originalFile);
  assert.equal((await p.command('get_state')).sessionId, state.sessionId);
  assert.deepEqual((await p.command('get_entries')).entries, beforeRestart);
  await p.prompt('After real process restart');
  const beforeReload = count('admission'); await p.send('/fixture-reload'); await p.prompt('After reload');
  const added = f.log.filter(e => e.type === 'admission').slice(beforeReload);
  assert.equal(added.filter(e => !e.data.payload).length, 1, 'no layered stale wrapper on reload');
  assert.equal(added.filter(e => e.data.payload).length, 1, 'composed onPayload observed once');
  assert(f.requests.at(-1).payload.messages.map(text).join('\n').includes(previous.summary));
  await p.command('set_model', { provider: 'groq', modelId: 'nunc-small' }); await p.prompt('After model selection');
  assert.equal(f.requests.at(-1).payload.model, 'nunc-small');
  const requests = f.requests.length; await p.send('/fixture-unknown');
  await f.wait(() => count('unknown_result') === 1, 'independent raw call delegated');
  assert.equal(f.requests.length, requests + 1); assert.equal(f.log.find(e => e.type === 'unknown_result').data.stopReason, 'stop');
  // Native clone/fork/new/tree each choose their own public selected path.
  await p.command('clone'); const cloned = await p.command('get_state'); assert.notEqual(cloned.sessionId, state.sessionId);
  await p.prompt('Cloned continuation'); assert(f.requests.at(-1).payload.messages.map(text).join('\n').includes(previous.summary));
  await p.command('switch_session', { sessionPath: originalFile });
  const user = beforeRestart.find(e => e.type === 'message' && e.message.role === 'user');
  await p.send('/fixture-tree ' + user.id); await p.prompt('Earlier tree path'); assert(!f.requests.at(-1).payload.messages.map(text).join('\n').includes(previous.summary));
  await p.command('fork', { entryId: user.id }); await p.prompt('Forked new path'); assert(!f.requests.at(-1).payload.messages.map(text).join('\n').includes(previous.summary));
  await p.command('new_session'); await p.prompt('Fresh session'); assert.equal((await p.command('get_entries')).entries.filter(e => e.type === 'compaction').length, 0);
  // Public provider composition replacement and observation hooks.
  await p.send('/fixture-native-reset'); await p.prompt('After public native provider reset');
  const beforeLegacy = f.requests.length; await p.send('/fixture-legacy-stream'); await p.prompt('Unsupported legacy stream');
  assert.equal(f.requests.length, beforeLegacy); assert.equal(f.log.filter(e => e.type === 'admission').at(-1).data.code, 'CONFIG');
  await p.send('/fixture-native-reset'); await p.prompt('After removing legacy stream');
  const beforeContext = f.requests.length; await p.send('/fixture-context-rewrite on'); await p.prompt('Unknown late request mutation');
  assert.ok(f.requests.length > beforeContext); assert.equal(f.log.filter(e => e.type === 'admission').at(-1).data.outcome, 'delegate');
  assert(text(f.requests.at(-1).payload.messages.at(-1)).includes('Unowned late context mutation'));
  await p.send('/fixture-context-rewrite off');
  const beforePayload = f.requests.length; await p.send('/fixture-payload-rewrite on'); await p.prompt('Payload must not change');
  assert.equal(f.requests.length, beforePayload); await p.send('/fixture-payload-rewrite off'); await p.prompt('Observer-only payload hook restored');
  const modelFile = f.state + '/agent/models.json', models = JSON.parse(await readFile(modelFile, 'utf8'));
  const groqNative = list => list.find(m => m.provider === 'groq' && m.id === 'nunc-native');
  const hasSampling = m => Boolean(m?.samplingParams && Object.keys(m.samplingParams).length);
  const waitCatalog = async (pred, label) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { models: catalog } = await p.command('get_available_models');
      const current = groqNative(catalog);
      if (current && pred(current)) return current;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(label);
  };
  const applyGroq = async (pred, label) => {
    await writeFile(modelFile, JSON.stringify(models));
    await p.send('/fixture-reload');
    // ctx.reload does not await ModelRuntime.refresh; set_model reads the last snapshot.
    await waitCatalog(pred, label);
    await p.command('set_model', { provider: 'groq', modelId: 'nunc-native' });
  };
  models.providers.groq.models[0].samplingParams = { max_completion_tokens: 999 };
  await applyGroq(hasSampling, 'models.json sampling overlay never reached the catalog');
  const beforeSampling = f.requests.length; await p.prompt('Raw sampling override unsupported'); assert.equal(f.requests.length, beforeSampling);
  delete models.providers.groq.models[0].samplingParams;
  models.providers.groq.models[0].api = 'fixture-unsupported-api';
  await applyGroq(m => m.api === 'fixture-unsupported-api' && !hasSampling(m), 'models.json unknown-api overlay never replaced the sampled catalog model');
  const beforeApi = f.requests.length, beforeAdmissions = f.log.filter(e => e.type === 'admission').length;
  await p.prompt('Captured native provider still owns an unknown API label');
  const apiAdmissions = f.log.filter(e => e.type === 'admission').slice(beforeAdmissions);
  assert(!apiAdmissions.some(e => e.data?.code === 'CONFIG'), 'API-name membership must not reject captured native dispatch');
  if (apiAdmissions.some(e => e.data?.outcome === 'delegate')) assert.ok(f.requests.length >= beforeApi);
  models.providers.groq.models[0].api = 'openai-completions'; await writeFile(modelFile, JSON.stringify(models)); await p.send('/fixture-reload'); await p.command('set_model', { provider: 'groq', modelId: 'nunc-native' }); await p.prompt('Native model defaults restored');
  // Real threshold: service usage crosses H after a delivered history response.
  await p.prompt('Threshold seed ' + 'y'.repeat(6000));
  f.response = row => row.kind === 'main' ? { text: 'threshold response', input: 25000 } : undefined;
  await p.command('set_auto_compaction', { enabled: true });
  const threshold = count('compact'); await p.prompt('Threshold recent ' + 'z'.repeat(4000));
  await f.wait(() => count('compact') > threshold, 'native threshold');
  assert.equal(f.log.filter(e => e.type === 'compact').at(-1).data.reason, 'threshold'); f.response = undefined;
  // Disabled automatic compaction never enables itself on local capacity failure.
  await p.command('new_session'); await p.command('set_auto_compaction', { enabled: false });
  await p.prompt('Old ' + 'a'.repeat(26500));
  const disabled = count('compact'), beforeReject = f.requests.length;
  await p.prompt('Large delivered ' + 'b'.repeat(13000));
  assert.equal(f.requests.length, beforeReject); assert.equal(count('compact'), disabled);
  // Extraction failure returns cancel:true; native default summary is never run.
  f.response = row => row.kind === 'maintenance' ? { text: '{"add":[],"remove":[],"priority":[]}', finish: 'length' } : undefined;
  const old = (await p.command('get_entries')).entries.filter(e => e.type === 'compaction');
  await assert.rejects(p.command('compact')); assert.deepEqual((await p.command('get_entries')).entries.filter(e => e.type === 'compaction'), old);
  f.response = undefined;
  // Genuine cancellation while the real maintenance HTTP request is pending.
  f.hold('maintenance'); const beforeMaintenance = f.requests.length;
  const compact = p.command('compact'); const rejectedCompact = assert.rejects(compact);
  await f.wait(() => f.requests.length > beforeMaintenance, 'maintenance HTTP pending');
  await p.command('abort'); await rejectedCompact; f.release('maintenance');
  assert.deepEqual((await p.command('get_entries')).entries.filter(e => e.type === 'compaction'), old);
  // No legal retiring prefix / indivisible input are bounded native failures.
  await p.command('new_session'); await p.command('set_auto_compaction', { enabled: true });
  const irreducible = f.requests.length; await p.prompt('Indivisible ' + 'I'.repeat(60000));
  assert.equal(f.requests.length, irreducible); assert.equal((await p.command('get_entries')).entries.filter(e => e.type === 'compaction').length, 0);
  await p.quit();
  outcome = { status: 'PROVEN_CONTROLLED', checkpoints: 3, overlappingOlderCheckpoint: true, actualRestartReload: true, modelCloneForkNewTree: true, threshold: true, disabledAuto: true, irreducibleInput: true, extractionFailureAndCancellation: true, independentRawDelegated: true, providerReplacementAndComposition: true, payloadMutationAndSamplingRejected: true, requests: f.requests.length, memoryQuality: 'UNPROVEN: controlled protocol responses' };
} catch (e) { outcome.error = { message: e.message, stack: e.stack }; console.error(e); process.exitCode = 1; }
finally { await f.close(outcome); console.log(JSON.stringify({ ...outcome, evidence: f.dir })); }
