// purpose: Join captured frozen source, saved M and actual subsequent wire payload without semantic scoring.
// usage: evidence(request, checkpoint, subsequentPayload, optionalMaterialStrings)
// effects: None; caller writes reports. Material matches are observations, never a completeness judgment.
// requires: Current tracked build and original capture/checkpoint records; no answer or gold enters model context.
import assert from 'node:assert/strict';
import { readSourceRecords } from '../../dist/src/engine/request.js';
const memoryPrefix='Nunc working memory (session-local, reference only):\n';
/** Only model-input user text carriers count, never metadata/tool/assistant substrings.
 * The carrier text contains JSON slots, itself escaped by the outer native payload. */
function inputMessages(next){
 const payload=typeof next==='string'?JSON.parse(next):next;
 assert(payload&&typeof payload==='object'&&!Array.isArray(payload),'Missing native payload');
 const messages=payload.messages??payload.input;assert(Array.isArray(messages),'Missing native input messages');
 return messages;
}
function textContent(message){
 if(!message)return [];
 return typeof message.content==='string'?[message.content]:Array.isArray(message.content)?message.content.filter(b=>b&&['text','input_text'].includes(b.type)&&typeof b.text==='string').map(b=>b.text):[];
}
export function decodeWireMemory(next){
 const carriers=[];
 for(const message of inputMessages(next)){
  if(!message||message.role!=='user')continue;
  const texts=textContent(message);
  for(const text of texts)if(text.startsWith(memoryPrefix))carriers.push(text.slice(memoryPrefix.length));
 }
 assert(carriers.length<=1,'Multiple native memory carriers');
 if(!carriers.length)return null;
 const slots=JSON.parse(carriers[0]);assert(Array.isArray(slots),'Invalid native memory slots');
 const ids=new Set();
 for(const slot of slots){
  assert(slot&&typeof slot==='object'&&!Array.isArray(slot)&&Object.keys(slot).length===2&&typeof slot.id==='string'&&slot.id.length&&typeof slot.text==='string','Invalid native memory slot');
  assert(!ids.has(slot.id),'Duplicate native memory slot');ids.add(slot.id);
 }
 return slots;
}
export function evidence(request,checkpoint,next,materials=[]){
 const a=checkpoint.accounting;assert(a,'Missing resolved accounting');
 const actual=request.options.maxTokens;assert.equal(actual,a.outputCapTokens);assert.equal(actual,a.outputReserveTokens);
 const sourceText=request.context.messages.flatMap(m=>typeof m.content==='string'?[m.content]:m.content.filter(b=>b.type==='text').map(b=>b.text)).join('\n');
 const source=readSourceRecords(sourceText).filter(r=>r.region),memory=checkpoint.memory.slots;
 assert(source.length,'Missing B/K source');assert(Array.isArray(memory));
 const decoded=decodeWireMemory(next);
 assert(decoded!==null||memory.length===0,'Saved M absent from actual subsequent payload');
 assert.deepEqual(decoded??[],memory,'Native memory slot identity/content/order differs from saved M');
 const mText=memory.map(s=>s.text).join('\n');
 const nextInputText=[...inputMessages(next).flatMap(textContent),...(decoded??[]).map(s=>s.text)].join('\n');
 const slots=memory.map(s=>({id:s.id,text:s.text,inNextPayload:true}));
 return {sourceEntries:source.map(r=>({entryId:r.entryId,region:r.region,sourceRole:r.sourceRole})),memory:slots,actualCap:actual,desiredCap:a.outputDesiredTokens??null,limitingReason:a.outputLimitedBy??null,headroom:a.extractionInputLimit-a.extractionTokens,memoryTarget:a.memoryLimit,memoryTokens:a.memoryTokens,keepTarget:a.keepTarget,keptTokens:a.keptTokens,fullInput:a.fullExtractionTokens,selectedInput:a.extractionTokens,relations:materials.map(text=>({text,inSource:sourceText.includes(text),inMemory:mText.includes(text),inNextPayload:nextInputText.includes(text)})),semanticCompleteness:'unjudged'};
}
