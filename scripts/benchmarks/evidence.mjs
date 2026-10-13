// purpose: Join captured frozen source, saved M and actual subsequent wire payload without semantic scoring.
// usage: evidence(request, checkpoint, subsequentPayload, optionalMaterialStrings)
// effects: None; caller writes reports. Material matches are observations, never a completeness judgment.
// requires: Current tracked build and original capture/checkpoint records; no answer or gold enters model context.
import assert from 'node:assert/strict';
import { readSourceRecords } from '../../dist/src/engine/request.js';
export function evidence(request,checkpoint,next,materials=[]){
 const a=checkpoint.accounting;assert(a,'Missing resolved accounting');
 const actual=request.options.maxTokens;assert.equal(actual,a.outputCapTokens);assert.equal(actual,a.outputReserveTokens);
 const sourceText=request.context.messages.flatMap(m=>typeof m.content==='string'?[m.content]:m.content.filter(b=>b.type==='text').map(b=>b.text)).join('\n');
 const source=readSourceRecords(sourceText).filter(r=>r.region),memory=checkpoint.memory.slots;
 assert(source.length,'Missing B/K source');assert(Array.isArray(memory));
 const payloadText=JSON.stringify(next),mText=memory.map(s=>s.text).join('\n');
 const slots=memory.map(s=>({id:s.id,text:s.text,inNextPayload:payloadText.includes(s.text)||payloadText.includes(JSON.stringify(s.text).slice(1,-1))}));
 assert(slots.every(s=>s.inNextPayload),'Saved M absent from actual subsequent payload');
 return {sourceEntries:source.map(r=>({entryId:r.entryId,region:r.region,sourceRole:r.sourceRole})),memory:slots,actualCap:actual,desiredCap:a.outputDesiredTokens??null,limitingReason:a.outputLimitedBy??null,headroom:a.extractionInputLimit-a.extractionTokens,memoryTarget:a.memoryLimit,memoryTokens:a.memoryTokens,keepTarget:a.keepTarget,keptTokens:a.keptTokens,fullInput:a.fullExtractionTokens,selectedInput:a.extractionTokens,relations:materials.map(text=>({text,inSource:sourceText.includes(text),inMemory:mText.includes(text),inNextPayload:payloadText.includes(text)})),semanticCompleteness:'unjudged'};
}
