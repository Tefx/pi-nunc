// purpose: Share the default-build protocol boundary across benchmark suites.
// usage: Import assertNuncBuild(nunc); receipt generation verifies compiler parity.
// effects: Read-only source/runtime validation; no builds or service calls.
// requires: Current tracked runtime and locked compiler.
import assert from 'node:assert/strict';
import { buildReceipt } from '../../dist/src/live/build.js';
export { buildReceipt };
export function assertNuncBuild(nunc) {
 assert.deepEqual(Object.keys(nunc).sort(), ['buildReceipt', 'compiledSource', 'configuration']);
 assert.equal(nunc.configuration, 'defaults');
 assert.deepEqual(nunc.buildReceipt, buildReceipt(nunc.compiledSource));
}
