// purpose: Preserve the accepted BEAM three original batches to five Nunc checkpoints at natural user boundaries.
// usage: splitBatch(originalMessages, zeroBasedBatch)
// effects: None; returns slices without changing roles/content/source IDs.
// requires: Canonical original ordered user/assistant messages.
import assert from 'node:assert/strict';
export function splitBatch(messages,batch){assert(Number.isInteger(batch)&&batch>=0&&batch<3);assert(messages.length);if(batch===0)return [messages];const middle=Math.floor(messages.length/2),cut=messages.findIndex((m,i)=>i>=middle&&m.role==='user');assert(cut>0);return [messages.slice(0,cut),messages.slice(cut)];}
