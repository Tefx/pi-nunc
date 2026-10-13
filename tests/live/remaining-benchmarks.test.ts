import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {repository} from './fixtures.js';
const scripts=join(repository,'scripts/benchmarks');
async function workspace(t: {after(fn:()=>Promise<void>):void}) {await mkdir(join(repository,'.scratch'),{recursive:true});const root=await mkdtemp(join(repository,'.scratch/remaining-test-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}

test('remaining selection preserves exactly authorized scopes and disjoint30; old20 remains separate',async t=>{
 const mod=await import(join(scripts,'remaining-selection.mjs')),old=await import(join(scripts,'selection.mjs')),r=await workspace(t),ret=join(r,'retained');
 const model=(id:string)=>({id,api:'openai-completions',provider:'openrouter',contextWindow:1050000,maxTokens:128000,cost:{input:1,output:1,cacheRead:1,cacheWrite:1}});
 const models={Luna:model('openai/gpt-6-luna'),Sol:model('openai/gpt-6.1-sol')};
 const put=async(p:string,v:unknown)=>{await mkdir(join(p,'..'),{recursive:true});await writeFile(p,JSON.stringify(v));};
 await put(join(ret,'mab/protocol.json'),{models,readerThinking:'medium',framing:{fact:'old'},limits:{}});
 await put(join(ret,'mab/event-replacement-protocol.json'),{datasetRevision:mod.revision,replacementRow:8,framing:'original event framing',case:{caseId:'eventqa_65536_replacement_row8',chunks:Array(17).fill('original material'),questions:Array.from({length:20},(_,i)=>({id:i,prompt:`hidden${i}`})),checkpointAfterChunks:[8,17]}});
 for(const label of ['Luna','Sol'])await put(join(ret,`arena/${label.toLowerCase()}-native/protocol.json`),{thinking:'medium',compaction:{reserveTokens:255616,keepRecentTokens:8000,effectiveContext:272000,earlyTriggerTokens:16384},model:models[label as keyof typeof models]});
 await put(join(ret,'beam/protocol.json'),{models,thinking:'medium',effective_context:98304,nunc_split_batches:true,samples:[{id:1},{id:2}],settings:{compaction:{reserveTokens:32768,keepRecentTokens:30000},retry:{enabled:false,provider:{maxRetries:0}},nunc:{memoryTools:false}},judge:{maxTokens:4096,model:models.Luna.id,provider:'openrouter',thinking:'medium'},limits:{}});
 const built=join(r,'extension.js');await writeFile(built,'export default ()=>{}');const target=join(r,'new');mod.freezeSelection(ret,target,built,'candidate');assert.throws(()=>mod.freezeSelection(ret,target,built,'candidate'));
 assert.equal(mod.allocation().newCapUsd,30);assert.equal(old.allocation().newCapUsd,20);assert.throws(()=>mod.assertAllocation(old.allocation()));
 const read=async(p:string)=>JSON.parse(await readFile(join(target,p),'utf8'));
 const luna=await read('arena/luna-nunc/protocol.json');assert.deepEqual(luna.groups,[5,6]);assert.throws(()=>mod.assertArenaProtocol({...luna,groups:[4,5,6]}));assert.throws(()=>mod.assertArenaProtocol({...luna,retry:{...luna.retry,boundedRecoveryPerTraveler:1}}));
 const sol=await read('arena/sol-nunc/protocol.json');assert.deepEqual(sol.groups,[4,5,6]);assert.throws(()=>mod.assertArenaProtocol({...sol,arm:'native'}));
 const event=await read('event/luna-nunc/protocol.json');assert.equal(event.cases.length,1);assert.equal(event.cases[0].questions.length,20);assert.equal(event.framing.event,'original event framing');assert.throws(()=>mod.assertEventProtocol({...event,replacementRow:7}));assert.throws(()=>mod.assertEventProtocol({...event,nunc:{...event.nunc,extraction:{maxOutputTokens:8192}}}));assert.throws(()=>mod.assertEventProtocol({...event,cases:[{...event.cases[0],caseId:'factconsolidation_sh_64k'}]}));
 const beam=await read('beam/protocol.json');assert.deepEqual(beam.conditions,['Luna/nunc','Sol/nunc']);assert.throws(()=>mod.assertBeamProtocol({...beam,resume:true}));assert.throws(()=>mod.assertBeamProtocol({...beam,conditions:['Luna/native']}));assert.throws(()=>mod.assertBeamProtocol({...beam,settings:{...beam.settings,retry:{enabled:true,provider:{maxRetries:1}}}}));
});

test('canonical BEAM probe/rubric/history binding rejects changed questions',async t=>{
 const {assertBeamInputs}=await import(join(scripts,'remaining-selection.mjs')),r=await workspace(t),origin=join(r,'origin'),target=join(r,'target');
 const categories=['instruction_following','knowledge_update','contradiction_resolution'];const queries=[1,2].flatMap(c=>categories.flatMap(category=>[0,1].map(i=>({id:`${c}:${category}:${i}`,case:c,category,question:`hidden ${c} ${category} ${i}`}))));
 for(const root of [origin,target]){await mkdir(join(root,'upstream'),{recursive:true});await writeFile(join(root,'queries.json'),JSON.stringify(queries));await writeFile(join(root,'upstream/prompt.json'),JSON.stringify('published <rubric_item> <llm_response>'));for(const c of [1,2]){await mkdir(join(root,`inputs/${c}`),{recursive:true});await writeFile(join(root,`inputs/${c}/formation.json`),JSON.stringify([{messages:[{role:'user',content:'original'}]}]));await writeFile(join(root,`inputs/${c}/probing_questions.json`),JSON.stringify(Object.fromEntries(categories.map(k=>[k,[{rubric:['A','B']},{rubric:['C','D']}]]))));}}
 const p={canonicalRoot:origin,models:{},settings:{},judge:{prompt_file:'upstream/prompt.json'}};await writeFile(join(origin,'protocol.json'),JSON.stringify(p));assert.equal(assertBeamInputs(target,p).length,12);const changed=structuredClone(queries);changed[0]!.question='rewritten question';await writeFile(join(target,'queries.json'),JSON.stringify(changed));assert.throws(()=>assertBeamInputs(target,p),/Original probes unchanged/);
});

test('BEAM exact natural splitting keeps original roles/content/order and five checkpoints',async()=>{
 const {splitBatch}=await import(join(scripts,'beam/contracts.mjs'));const original=Array.from({length:10},(_,i)=>({role:i%2?'assistant':'user',content:`original${i}`,source_id:i}));
 assert.equal(splitBatch(original,0).length,1);assert.equal(splitBatch(original,1).length,2);assert.equal(splitBatch(original,2).length,2);assert.deepEqual(splitBatch(original,1).flat(),original);assert.equal(splitBatch(original,1)[1][0].role,'user');assert.throws(()=>splitBatch(original,3));
 const {assertHidden}=await import(join(scripts,'mab/contracts.mjs'));assertHidden('original text',[{questions:[{prompt:'hidden probe'}]}]);assert.throws(()=>assertHidden('hidden probe',[{questions:[{prompt:'hidden probe'}]}]));
});

test('guard reserves actual cap, serial subcalls and judge; unknown zero usage remains charged',async t=>{
 const {reserveState,settleState,reconcileStoppedState}=await import(join(scripts,'mab/capture.mjs'));const s={stopped:false,pending:{},spentUsd:0,heldUnknownUsd:0,admissions:0,receipts:0,maxReservedTotalUsd:0,allowanceUsd:1,maxTokens:128000,contextWindow:98304,cost:{input:1,output:1,cacheRead:1,cacheWrite:1}};
 const bound=reserveState(s,'maintenance',12065,2);assert(bound>0);assert.throws(()=>reserveState(s,'overlap',4096));assert.throws(()=>settleState(s,'maintenance',{input:0,output:0,cacheRead:0,cacheWrite:0,cost:{total:0}}));reconcileStoppedState(s,'failure');assert.equal(s.heldUnknownUsd,bound);
 const guard=await import(join(scripts,'beam/guard.mjs')),dir=await workspace(t),file=join(dir,'budget.json'),capture=join(dir,'capture.jsonl');const model={provider:'openrouter',api:'openai-completions',id:'judge',contextWindow:98304,maxTokens:128000,cost:s.cost};guard.writeJSON(file,{allowanceUsd:1,spentUsd:0,heldUnknownUsd:0,pending:{},admissions:0,receipts:0,unknownCalls:0,errors:[],maxReservedTotalUsd:0,model,maxInflight:1});
 const id=guard.reserve(file,model,4096,98304);assert.throws(()=>guard.reserve(file,model,4096,98304));const result=guard.settle(file,id,{usage:{input:0,output:0,cacheRead:0,cacheWrite:0}});assert(result.unknown);assert(guard.readJSON(file).heldUnknownUsd>0);
 let outbound=8192;
 const runtime={streamSimple(){throw new Error('unused');},async complete(_m:unknown,_c:unknown,o:{onPayload?:(p:unknown,m:unknown)=>Promise<void>,maxTokens?:number,reasoningEffort?:string,maxRetries?:number}){assert(o.onPayload);await o.onPayload({reasoning:{effort:'medium'},max_tokens:outbound},model);return {usage:{input:1,output:1,cacheRead:0,cacheWrite:0}};}};
 guard.installGuard(runtime,file,capture,'judge',98304);await assert.rejects(()=>runtime.complete(model,{}, {maxTokens:12065,reasoningEffort:'medium',maxRetries:0}),/serialized output bound/);assert.equal(Object.keys(guard.readJSON(file).pending).length,0);assert(guard.readJSON(file).unknownCalls>=2);
 outbound=12065;await runtime.complete(model,{}, {maxTokens:12065,reasoningEffort:'medium',maxRetries:0});assert.equal(guard.readJSON(file).receipts,1);assert.equal(Object.keys(guard.readJSON(file).pending).length,0);assert(guard.readJSON(file).heldUnknownUsd>0);
 await assert.rejects(()=>runtime.complete(model,{}, {maxTokens:12065,reasoningEffort:'medium',maxRetries:1}),/Retries disabled/);
});

test('BEAM published blind prompt and criterion-mean parser unchanged, no label/history leakage',async()=>{
 const {judgePrompt,parseJudge,criterionMean}=await import(join(scripts,'beam/score.mjs'));assert.equal(judgePrompt('Criterion:<rubric_item> Answer:<llm_response>','original rubric','new answer'),'Criterion:original rubric Answer:new answer');assert.equal(criterionMean([parseJudge('{"score":1,"reason":"full"}'),parseJudge('```json\n{"score":0.5,"reason":"partial"}\n```')]),.75);assert.throws(()=>parseJudge('{"score":2,"reason":"wrong"}'));assert.throws(()=>parseJudge('unparseable'));
});
