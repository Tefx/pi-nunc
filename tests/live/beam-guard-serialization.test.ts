import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {InMemoryCredentialStore,type Model} from '@earendil-works/pi-ai';
import {repository} from './fixtures.js';

const context={messages:[{role:'user' as const,content:'Original closed-book question',timestamp:1700000000000}]};
function object(value:unknown):Record<string,unknown>{assert(value!==null&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;}
function outputCap(payload:Record<string,unknown>){return payload.max_completion_tokens??payload.max_tokens;}
async function setup(t:{after(fn:()=>Promise<void>):void}){
 await mkdir(join(repository,'.scratch'),{recursive:true});const dir=await mkdtemp(join(repository,'.scratch/beam-guard-serialization-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 // Public native runtime/provider/serializer, isolated credential store and no model-network refresh.
 const runtime=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),refreshOnCreate:false,allowModelNetwork:false});assert(!runtime.getError());const physical=runtime.getModel('openrouter','openai/gpt-6.1-sol');assert(physical);assert.equal(physical.api,'openai-completions');assert.equal(physical.maxTokens,128000);
 const model:Model<'openai-completions'>={...physical,api:'openai-completions',contextWindow:98304,baseUrl:'https://offline.invalid/v1'};
 const guard=await import(join(repository,'scripts/benchmarks/beam/guard.mjs')),file=join(dir,'budget.json'),capture=join(dir,'capture.jsonl');
 guard.writeJSON(file,{allowanceUsd:10,spentUsd:0,heldUnknownUsd:0,pending:{},admissions:0,receipts:0,unknownCalls:0,errors:[],maxReservedTotalUsd:0,model,maxInflight:1,maxCalls:80});guard.installGuard(runtime,file,capture,model.id,model.contextWindow);
 const fetched:Array<Record<string,unknown>>=[];
 // Only the HTTP edge is controlled. No loopback server, real auth, provider registration or inference.
 const fetch:typeof globalThis.fetch=async(input,init)=>{
  const url=input instanceof Request?input.url:String(input);assert(url.startsWith('https://offline.invalid/v1/'));const body=init?.body;assert(typeof body==='string');fetched.push(object(JSON.parse(body)));
  const chunks=[{id:'offline',object:'chat.completion.chunk',model:model.id,choices:[{index:0,delta:{role:'assistant',content:'Controlled response'},finish_reason:null}]},{id:'offline',object:'chat.completion.chunk',model:model.id,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20}}];
  return new Response(chunks.map(c=>`data: ${JSON.stringify(c)}\n\n`).join('')+'data: [DONE]\n\n',{status:200,headers:{'content-type':'text/event-stream'}});
 };
 const options={apiKey:'offline-fixture-only',env:{},fetch,transport:'sse' as const,maxRetries:0,cacheRetention:'none' as const};
 const records=async()=>{try{return (await readFile(capture,'utf8')).trim().split('\n').filter(Boolean).map(s=>object(JSON.parse(s)));}catch(error){if(object(error).code==='ENOENT')return [];throw error;}};
 return {runtime,model,guard,file,capture,fetched,options,records};
}

test('BEAM guard permits actual Pi1.1 native omitted-cap serialization/context clamp and MEDIUM without injection',async t=>{
 const x=await setup(t);let originalCap:unknown;
 const response=await x.runtime.streamSimple(x.model,context,{...x.options,reasoning:'medium',onPayload:payload=>{originalCap=outputCap(object(payload));}}).result();
 assert.equal(response.stopReason,'stop',response.errorMessage??'Expected native stream completion');assert.equal(x.fetched.length,1);const wire=x.fetched[0]!;assert.equal(outputCap(wire),originalCap);assert(Number.isInteger(originalCap)&&Number(originalCap)>0&&Number(originalCap)<=94208);assert(Number(originalCap)<128000);assert.equal(object(wire.reasoning).effort,'medium');
 const records=await x.records(),request=records.find(r=>r.type==='request');assert(request);assert.equal(object(request.options).maxTokens,null);assert.equal(object(request.options).reasoning,'medium');const observed=records.find(r=>r.type==='wire');assert(observed);assert.equal(observed.kind,'native-stream');assert.deepEqual(observed.payload,wire);
 const state=x.guard.readJSON(x.file);assert.equal(state.admissions,1);assert.equal(state.receipts,1);assert.equal(state.heldUnknownUsd,0);assert.deepEqual(state.pending,{});assert(state.spentUsd>0);assert.equal(state.maxReservedTotalUsd,(98304*5+128000*15)/1e6);
});

test('native malformed or over-reservation caps are captured then rejected before HTTP; conservative holds remain',async t=>{
 for(const cap of [undefined,0,-1,1.5,'8192',128001]){
  const x=await setup(t);const response=await x.runtime.streamSimple(x.model,context,{...x.options,reasoning:'medium',onPayload:payload=>{const p={...object(payload)};delete p.max_completion_tokens;delete p.max_tokens;if(cap!==undefined)p.max_tokens=cap;return p;}}).result();
  assert.equal(response.stopReason,'error');assert.match(response.errorMessage??'',/Actual serialized output bound/);assert.equal(x.fetched.length,0);const records=await x.records(),wire=records.find(r=>r.type==='wire');assert(wire,'Rejected payload must remain observable');assert.equal(outputCap(object(wire.payload)),cap);assert.equal(wire.kind,'native-stream');const state=x.guard.readJSON(x.file);assert.equal(state.receipts,0);assert.equal(state.spentUsd,0);assert.equal(state.unknownCalls,1);assert.equal(state.heldUnknownUsd,state.maxReservedTotalUsd);assert.deepEqual(state.pending,{});
 }
});

test('actual native raw maintenance/judge serializer preserves exact resolved equality and MEDIUM, rejects mismatch',async t=>{
 for(const cap of [4096,12065]){
  const x=await setup(t);const response=await x.runtime.complete(x.model,context,{...x.options,maxTokens:cap,reasoningEffort:'medium'});assert.equal(response.stopReason,'stop',response.errorMessage??'Expected raw completion');assert.equal(x.fetched.length,1);assert.equal(outputCap(x.fetched[0]!),cap);assert.equal(object(x.fetched[0]!.reasoning).effort,'medium');assert.equal(x.guard.readJSON(x.file).receipts,1);
 }
 const x=await setup(t);const response=await x.runtime.complete(x.model,context,{...x.options,maxTokens:12065,reasoningEffort:'medium',onPayload:payload=>{const p={...object(payload)};delete p.max_completion_tokens;delete p.max_tokens;return {...p,max_tokens:8192};}});assert.equal(response.stopReason,'error');assert.match(response.errorMessage??'',/Actual serialized output bound/);assert.equal(x.fetched.length,0);const wire=(await x.records()).find(r=>r.type==='wire');assert(wire);assert.equal(wire.kind,'raw-complete');assert.equal(outputCap(object(wire.payload)),8192);assert(x.guard.readJSON(x.file).heldUnknownUsd>0);assert.deepEqual(x.guard.readJSON(x.file).pending,{});
 await assert.rejects(()=>x.runtime.complete(x.model,context,{...x.options,maxTokens:4096,reasoningEffort:'medium',maxRetries:1}),/Retries disabled/);assert.equal(x.guard.readJSON(x.file).admissions,1);
});
