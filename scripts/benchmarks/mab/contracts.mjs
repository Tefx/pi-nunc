// purpose: Validate JSONL framing, hidden formation inputs and independent query deltas for MAB adapter.
// usage: Import from run-condition/tests.
// effects: None.
// requires: Original frozen protocol and native entry records.
import assert from 'node:assert/strict';
export const parseJsonl=text=>text.split('\n').filter(s=>s.trim()).map(JSON.parse);
export function assertHidden(body,cases){assert(!cases.some(c=>c.questions.some(q=>body.includes(q.prompt))),'Concrete QA leaked into formation');}
export function assertQueryDelta(entries,expected){const users=entries.filter(e=>e.type==='message'&&e.message.role==='user');assert.equal(users.length,1);assert.equal(entries.filter(e=>e.type==='compaction').length,0);const content=users[0].message.content;const text=typeof content==='string'?content:content.filter(b=>b.type==='text').map(b=>b.text).join('\n');assert.equal(text,expected,'Query clone contains another question');}
