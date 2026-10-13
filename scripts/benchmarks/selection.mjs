// purpose: Freeze the bounded defaults benchmark scope and exclusive reservations, independent of scores.
// usage: Import validators; CLI: node scripts/benchmarks/selection.mjs <retained-mab> <retained-arena> <new-root> <compiled-extension> <commit>
// effects: CLI writes only a fresh owned protocol/allocation tree; no auth reads, inference or service calls.
// requires: Retained original samples/protocols/catalog; current tracked build; downstream effect authorization remains separate.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export const ordinarySelection=Object.freeze({group:4,modelName:'Luna',modelId:'openai/gpt-6-luna',reason:'First retained complete new group; eight linked travelers exercise ordinary automatic rolling and material relations. Luna shares the retained native MEDIUM/272K/16K-trigger protocol. Selection uses protocol relevance, never scores.'});
export function assertFactProtocol(p){
 assert.equal(p.arm,'nunc');assert(['luna-nunc','sol-nunc'].includes(p.condition));assert.equal(p.readerThinking,'medium');assert.equal(p.model.api,'openai-completions');assert.equal(p.model.contextWindow,272000);
 assert.deepEqual(p.cases.map(c=>c.caseId),['factconsolidation_sh_64k','factconsolidation_mh_64k']);
 for(const c of p.cases){assert.equal(c.chunks.length,17);assert.equal(c.questions.length,20);assert.deepEqual(c.checkpointAfterChunks,[8,17]);}
 assert.equal(p.nunc.configuration,'defaults');assert(p.nunc.compiledSource);assert(p.allowanceUsd>0&&p.allowanceUsd<=20);
}
export function assertArenaProtocol(p){
 assert.equal(p.arm,'nunc');assert.deepEqual(p.groups,[ordinarySelection.group]);assert.deepEqual(p.order,[[ordinarySelection.group,'nunc']]);
 assert.equal(p.model.id,ordinarySelection.modelId);assert.equal(p.thinking,'medium');assert.equal(p.compaction.effectiveContext,272000);assert.equal(p.compaction.reserveTokens,255616);assert.equal(p.compaction.keepRecentTokens,8000);
 assert.equal(p.nunc.configuration,'defaults');assert(p.nunc.compiledSource);assert.equal(p.flightCsvBytes,304807007);assert.equal(p.catalogAllowanceUsd,3);
}
export function allocation(){return {newCapUsd:20,exclusive:{'luna-nunc':3,'sol-nunc':14,'arena-luna-nunc':3},priorKnownUsd:30.784718350,priorHeldUsd:20.30112,priorChargedUsd:51.085838350,unknownReleaseAuthorized:false,maxConcurrentRequests:1};}
export function assertAllocation(a){assert.equal(a.newCapUsd,20);assert.equal(a.priorKnownUsd,30.784718350);assert.equal(a.priorHeldUsd,20.30112);assert.equal(a.unknownReleaseAuthorized,false);assert(Object.values(a.exclusive).every(v=>Number.isFinite(v)&&v>0));assert(Object.values(a.exclusive).reduce((n,v)=>n+v,0)<=20);assert.equal(a.maxConcurrentRequests,1);}
export function freezeSelection(mab,arena,root,compiledSource,commit){
 assert(!existsSync(root),'Selection target already exists');assert(existsSync(compiledSource),'Missing current compiled extension');
 const read=p=>JSON.parse(readFileSync(p,'utf8')),old=read(join(mab,'protocol.json')),a=allocation();assertAllocation(a);
 const cases=old.cases.filter(c=>c.caseId.startsWith('factconsolidation_'));
 const common={...old,cases,conditions:[],productCommit:commit,budgetUsd:20,nunc:{configuration:'defaults',compiledSource},frozenAt:new Date().toISOString(),boundedDefaults:true,plannedCalls:118,eventDecision:'No Event',comparators:'Retained unchanged native Fact40; no native rerun',allocation:a};
 mkdirSync(root,{recursive:true});const write=(p,o)=>writeFileSync(p,JSON.stringify(o,null,2)+'\n');
 for(const name of ['Luna','Sol']){
  const condition=name.toLowerCase()+'-nunc',model={...old.models[name],contextWindow:272000},allowanceUsd=a.exclusive[condition];
  const p={...common,condition,model,modelName:name,arm:'nunc',allowanceUsd};assertFactProtocol(p);const dir=join(root,condition);mkdirSync(dir);
  write(join(dir,'protocol.json'),p);write(join(dir,'admission.json'),{allowanceUsd,spentUsd:0,heldUnknownUsd:0,pending:{},admissions:0,receipts:0,maxReservedTotalUsd:0,modelId:model.id,cost:model.cost,contextWindow:272000,maxTokens:model.maxTokens,condition,arm:'nunc',stopped:false});
  common.conditions.push({key:condition,modelName:name,arm:'nunc',allowanceUsd});
 }
 write(join(root,'protocol.json'),common);write(join(root,'allocation.json'),a);
 const native=read(join(arena,'luna-native/protocol.json'));
 const ordinary={...native,productCommit:commit,arm:'nunc',groups:[4],order:[[4,'nunc']],catalogAllowanceUsd:3,maxConcurrentRequests:1,flightCsvBytes:304807007,nunc:{configuration:'defaults',compiledSource},selection:ordinarySelection,retainedNative:join(arena,'luna-native/run'),retry:{...native.retry,boundedRecoveryPerTraveler:0}};assertArenaProtocol(ordinary);
 const dir=join(root,'arena-luna-nunc');mkdirSync(dir);write(join(dir,'protocol.json'),ordinary);write(join(dir,'catalog-admission.json'),{allowanceUsd:3,spentUsd:0,heldUnknownUsd:0,pending:{},admissions:0,receipts:0,maxReservedTotalUsd:0,stopped:false});
 return {root,selection:ordinarySelection,allocation:a};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){assert.equal(process.argv.length,7);console.log(JSON.stringify(freezeSelection(...process.argv.slice(2))));}
