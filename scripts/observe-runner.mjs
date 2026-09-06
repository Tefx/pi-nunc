// purpose: Exercise the public default-input supervisor/worker/stock Codex path end to end.
// usage: node scripts/observe-runner.mjs [--system-temp]
// effects: Fictional native profile, loopback service, isolated sessions/artifacts and bounded cleanup.
// requires: Committed locked build and stock-driver.mjs; scripted replies do not prove memory quality.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, rm, lstat, mkdtemp, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StockFixture, root } from './stock-driver.mjs';
const f = await new StockFixture().setup({ api: 'openai-codex-responses', compaction: { enabled: false, reserveTokens: 200000 } });
const systemTemp = process.argv[2] === '--system-temp';
const originalTemp = await realpath(tmpdir());
const targetParent = systemTemp ? await mkdtemp(join(originalTemp, 'nunc-runner-test-')) : f.dir;
const stateRoot = join(targetParent, 'nunc-live-runner');
if (systemTemp) assert(!stateRoot.startsWith(join(root, '.scratch') + '/')); 
const settings = { ...f.settings, defaultProvider: 'openai-codex', defaultModel: 'gpt-6-astra' };
await writeFile(join(f.state, 'agent/settings.json'), JSON.stringify(settings));
const selection = { target: { repository: root, stateRoot, cleanup: 'retain' }, limits: { maxCalls: 20, maxTotalTokens: 8000000, maxCostUsd: null, maxDurationMs: 60000, maxOutputTokens: 128000 }, scenarios: [{ id: 'c2' }], overrides: [{ requirement: 'c2-retiring-constraints', reason: 'Establish each observer-only legal rollover placement', config: { retentionCalibration: { minFraction: 0.0001, maxFraction: 0.95 } } }] };
const write = (path, content) => [{ tool: { name: 'write', input: { path, content: JSON.stringify(content) } } }, 'Saved.'];
const steps = ['Pending.', ...write('sum.json', { sum: 46 }), ...write('product.json', { product: 104 }), ...write('difference.json', { difference: 63 }), ...write('retry.json', { supportedNodeMajors: [18], retryLimit: 2, retryBeforeCommit: true, retryAfterSuccessfulCommit: false })];
f.response = (_row, source) => source ? JSON.stringify({ add: [], remove: [], priority: source.M.map(s => s.id) }) : (() => { assert(steps.length); return steps.shift(); })();
const env = { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: join(f.state, 'home'), PI_CODING_AGENT_DIR: join(f.state, 'agent'), TMPDIR: systemTemp ? originalTemp : join(f.state, 'tmp'), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' };
async function run(flags = []) {
  const child = spawn(process.execPath, [join(root, 'scripts/verify-live.mjs'), ...flags], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; if (stdout.length > 16000000) child.kill('SIGTERM'); }); child.stderr.on('data', b => { stderr += b; });
  child.stdin.end(JSON.stringify(selection));
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { code, stdout, stderr };
}
let result = { status: 'FAIL' };
try {
  const preflight = await run(['--preflight']); assert.equal(preflight.code, 0, preflight.stderr);
  assert.equal(f.requests.length, 0); await assert.rejects(lstat(stateRoot), { code: 'ENOENT' });
  const defaults = JSON.parse(preflight.stdout); assert.equal(defaults.models[0].baseUrl, f.endpoint); assert.equal(defaults.effective.thinking, 'medium');
  const execution = await run();
  await writeFile(join(f.dir, 'runner-report.json'), execution.stdout);
  assert.equal(execution.code, 0, execution.stdout.slice(0, 4000) + execution.stderr);
  const report = JSON.parse(execution.stdout); assert.equal(report.status, 'OBSERVED'); assert.equal(report.usage.calls, 12); assert.equal(report.usage.costUsd, null); assert.equal(report.segments[0].calibrations.length, 3);
  assert(report.children.every(c => c.exitCode === 0 && !c.signal));
  assert(f.requests.some(r => r.payload.reasoning?.effort === 'medium'));
  await assert.rejects(lstat(join(stateRoot, 'host/auth.json')), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(join(f.state, 'agent/settings.json'), 'utf8')), settings);
  const again = await run(); assert.notEqual(again.code, 0); assert.equal(f.requests.length, 12, 'single-use refusal makes no extra call');
  await writeFile(join(f.dir, 'runner-report.json'), execution.stdout);
  result = { status: 'PROVEN_CONTROLLED', calls: report.usage.calls, nativeWorkers: report.children.length, targetClass: systemTemp ? 'system-temp' : 'checkout-scratch', memoryQuality: 'UNPROVEN: scripted service', evidence: f.dir };
} catch (error) { result.error = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally { await rm(stateRoot, { recursive: true, force: true }); if (systemTemp) { await rm(targetParent, { recursive: true }); await assert.rejects(lstat(targetParent), { code: 'ENOENT' }); } await f.close(result); console.log(JSON.stringify(result)); }
