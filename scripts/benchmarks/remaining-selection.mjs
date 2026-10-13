// purpose: Freeze only the newly authorized remaining default measurements and disjoint inclusive suite partitions.
// usage: node remaining-selection.mjs RETAINED_ROOT NEW_ROOT COMPILED_EXTENSION COMMIT
// effects: Fresh protocol/ledger trees only; no auth/model/tool calls. Old selection remains intact.
// requires: Retained canonical arena/beam/mab protocols and unchanged original inputs.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export const scope='remaining-defaults-v1';
export const revision='7ea066982b140a19337e17e60d45d4076e042faf';
export function allocation(){return {scope,newCapUsd:30,exclusive:{arena:10,beam:10,event:10},conditions:{arena:{Luna:1,Sol:9},beam:{Luna:1,Sol:8,judge:1},event:{Luna:1,Sol:9}},priorKnownUsd:37.157149720,priorHeldUsd:20.30112,priorChargedUsd:57.458269720,unknownReleaseAuthorized:false};}
export function assertAllocation(a){assert.deepEqual(a,allocation(),'Frozen new allocation; old20 is closed');}
function defaults(p){assert.equal(p.scope,scope);assert.deepEqual(Object.keys(p.nunc).sort(),['compiledSource','configuration']);assert.equal(p.nunc.configuration,'defaults');assert(p.nunc.compiledSource);assert.equal(p.arm,'nunc');assert.equal(p.maxConcurrentRequests,1);}
export function assertArenaProtocol(p){
 defaults(p);assert(['Luna','Sol'].includes(p.modelName));assert.equal(p.model.id,p.modelName==='Luna'?'openai/gpt-6-luna':'openai/gpt-6.1-sol');assert.equal(p.model.provider,'openrouter');assert.equal(p.model.api,'openai-completions');
 const groups=p.modelName==='Luna'?[5,6]:[4,5,6];assert.deepEqual(p.groups,groups);assert.deepEqual(p.order,groups.map(g=>[g,'nunc']));assert.equal(p.thinking,'medium');assert.deepEqual(p.compaction,{reserveTokens:255616,keepRecentTokens:8000,effectiveContext:272000,earlyTriggerTokens:16384});assert.equal(p.flightCsvBytes,304807007);assert.equal(p.catalogAllowanceUsd,allocation().conditions.arena[p.modelName]);assert.deepEqual(p.retry,{provider:0,agent:0,boundedRecoveryPerTraveler:0});
}
export function assertEventProtocol(p){
 defaults(p);assert(['luna-nunc','sol-nunc'].includes(p.condition));assert.equal(p.modelName,p.condition==='luna-nunc'?'Luna':'Sol');assert.equal(p.readerThinking,'medium');assert.equal(p.model.contextWindow,272000);assert.equal(p.model.provider,'openrouter');assert.equal(p.model.id,p.condition==='luna-nunc'?'openai/gpt-6-luna':'openai/gpt-6.1-sol');assert.equal(p.model.api,'openai-completions');assert.equal(p.datasetRevision,revision);assert.equal(p.replacementRow,8);assert.equal(p.cases.length,1);const c=p.cases[0];assert.equal(c.caseId,'eventqa_65536_replacement_row8');assert.equal(c.chunks.length,17);assert.equal(c.questions.length,20);assert.deepEqual(c.checkpointAfterChunks,[8,17]);assert.equal(p.allowanceUsd,allocation().conditions.event[p.modelName]);
}
export function assertBeamProtocol(p){
 defaults(p);assert.deepEqual(p.conditions,['Luna/nunc','Sol/nunc']);assert.equal(p.thinking,'medium');assert.equal(p.effective_context,98304);assert.equal(p.nunc_split_batches,true);assert.deepEqual(p.samples.map(s=>s.id),[1,2]);assert.deepEqual(p.allocations_usd,{'Luna-nunc':1,'Sol-nunc':8,judge:1});assert.equal(p.limits.judge_calls,48);assert.equal(p.limits.max_inflight_model_requests,1);assert.equal(p.settings.retry.enabled,false);assert.equal(p.settings.retry.provider.maxRetries,0);assert.deepEqual(p.settings.nunc,{memoryTools:false});assert.equal(p.settings.compaction.reserveTokens,32768);assert.equal(p.settings.compaction.keepRecentTokens,30000);assert.equal(p.judge.maxTokens,4096);assert.equal(p.judge.model,'openai/gpt-6-luna');assert.equal(p.judge.thinking,'medium');assert.equal(p.judge.provider,'openrouter');
 for(const key of ['recovery','resume','schemaRetry','schema_retries'])assert(!(key in p),'Recovery/resume controls forbidden');
 for(const label of ['Luna','Sol']){assert.equal(p.models[label].provider,'openrouter');assert.equal(p.models[label].api,'openai-completions');assert.equal(p.models[label].contextWindow,1050000);assert.equal(p.models[label].maxTokens,128000);assert.equal(p.models[label].id,label==='Luna'?'openai/gpt-6-luna':'openai/gpt-6.1-sol');}
}
export function assertBeamInputs(root,p){
 assert(p.canonicalRoot,'Missing canonical BEAM root');
 const read=path=>JSON.parse(readFileSync(path,'utf8'));const original=read(join(p.canonicalRoot,'protocol.json'));assert.deepEqual(p.models,original.models,'Frozen native models/catalog');assert.deepEqual(p.settings,original.settings,'Frozen host pressure/settings');assert.deepEqual(p.judge,original.judge,'Original judge configuration');
 const queries=read(join(root,'queries.json'));assert.deepEqual(queries,read(join(p.canonicalRoot,'queries.json')),'Original probes unchanged');assert.equal(queries.length,12);
 for(const id of [1,2])for(const file of ['formation.json','probing_questions.json'])assert.deepEqual(read(join(root,`inputs/${id}/${file}`)),read(join(p.canonicalRoot,`inputs/${id}/${file}`)),'Original history/rubric unchanged');
 assert.equal(new Set(queries.map(q=>q.id)).size,12);assert(queries.every(q=>[1,2].includes(q.case)&&typeof q.question==='string'&&q.question.length));
 for(const category of ['instruction_following','knowledge_update','contradiction_resolution'])assert.equal(queries.filter(q=>q.category===category).length,4);
 const criteria=queries.reduce((n,q)=>n+read(join(root,`inputs/${q.case}/probing_questions.json`))[q.category][Number(q.id.split(':')[2])].rubric.length,0);assert.equal(criteria,24,'Original selected criterion denominator');
 const prompt=read(join(root,p.judge.prompt_file));assert.deepEqual(prompt,read(join(p.canonicalRoot,p.judge.prompt_file)));return queries;
}
export function freezeSelection(retained,root,compiledSource,commit){
 assert(!existsSync(root),'Selection target exists');assert(existsSync(compiledSource));const read=p=>JSON.parse(readFileSync(p,'utf8')),write=(p,x)=>writeFileSync(p,JSON.stringify(x,null,2)+'\n'),a=allocation();assertAllocation(a);mkdirSync(root);write(join(root,'allocation.json'),a);
 for(const suite of ['arena','beam','event'])mkdirSync(join(root,suite));
 const mab=read(join(retained,'mab/protocol.json')),replacement=read(join(retained,'mab/event-replacement-protocol.json'));assert.equal(replacement.datasetRevision,revision);assert.equal(replacement.replacementRow,8);
 const common={scope,productCommit:commit,arm:'nunc',maxConcurrentRequests:1,nunc:{configuration:'defaults',compiledSource}};
 const event={...mab,...common,cases:[replacement.case],conditions:[],budgetUsd:10,framing:{...mab.framing,event:replacement.framing},datasetRevision:revision,replacementRow:8,canonicalReplacement:join(retained,'mab/event-replacement-protocol.json')};
 for(const label of ['Luna','Sol']){
  const key=label.toLowerCase()+'-nunc',model={...mab.models[label],contextWindow:272000},allowanceUsd=a.conditions.event[label];const p={...event,condition:key,model,modelName:label,allowanceUsd};assertEventProtocol(p);const dir=join(root,'event',key);mkdirSync(dir);write(join(dir,'protocol.json'),p);write(join(dir,'admission.json'),{allowanceUsd,spentUsd:0,heldUnknownUsd:0,pending:{},admissions:0,receipts:0,maxReservedTotalUsd:0,modelId:model.id,cost:model.cost,contextWindow:272000,maxTokens:model.maxTokens,condition:key,arm:'nunc',stopped:false});event.conditions.push({key,modelName:label,arm:'nunc',allowanceUsd});
  const native=read(join(retained,`arena/${label.toLowerCase()}-native/protocol.json`)),groups=label==='Luna'?[5,6]:[4,5,6];const arena={...native,...common,modelName:label,groups,order:groups.map(g=>[g,'nunc']),catalogAllowanceUsd:a.conditions.arena[label],retry:{provider:0,agent:0,boundedRecoveryPerTraveler:0},flightCsvBytes:304807007};assertArenaProtocol(arena);const ar=join(root,'arena',key);mkdirSync(ar);write(join(ar,'protocol.json'),arena);write(join(ar,'catalog-admission.json'),{allowanceUsd:arena.catalogAllowanceUsd,spentUsd:0,heldUnknownUsd:0,pending:{},admissions:0,receipts:0,maxReservedTotalUsd:0,stopped:false});
 }
 write(join(root,'event/protocol.json'),event);
 const old=read(join(retained,'beam/protocol.json'));const beam={...old,...common,conditions:['Luna/nunc','Sol/nunc'],canonicalRoot:join(retained,'beam'),allocations_usd:{'Luna-nunc':1,'Sol-nunc':8,judge:1},exclusive_new_cap_usd:10,limits:{...old.limits,max_inflight_model_requests:1,judge_calls:48},adaption:'Original native3 versus Nunc5 per history; batches2/3 split at original natural mid-batch user boundary. Current omitted auto/full. No retries, schema repair or execution resume.'};assertBeamProtocol(beam);write(join(root,'beam/protocol.json'),beam);
 return {root,allocation:a};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){assert.equal(process.argv.length,6);console.log(JSON.stringify(freezeSelection(...process.argv.slice(2))));}
