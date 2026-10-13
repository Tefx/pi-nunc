// purpose: Fresh Sol case1 query-only native recovery; preflight executes same host path with controlled zero-paid HTTP edge.
// usage: node recover-queries.mjs RETAINED_BEAM NEW_TARGET COMPILED_EXTENSION COMMIT prepare|preflight|run
// effects: prepare writes fresh selected protocols/carry; other modes consume only a fresh target; run needs separate effect authority.
// requires: Canonical reconstruction inputs and accepted support; never forms, retries, or calls Luna/case2.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {ModelRuntime,SessionManager} from '@earendil-works/pi-coding-agent';
import {InMemoryCredentialStore} from '@earendil-works/pi-ai';
import {readJSON,writeJSON,record,reconcile} from './guard.mjs';
import {loadRecovery,freezeRecovery,restore,openRecovered,assertQueryContext,assertRecoveryTarget} from './query-recovery.mjs';
assert.equal(process.argv.length,7);const [source,root,compiled,commit,mode]=process.argv.slice(2).map((s,i)=>i<3?resolve(s):s);assert(['prepare','preflight','run'].includes(mode));
if(mode==='prepare'){freezeRecovery(source,root,compiled,commit);}
else{
 const input=loadRecovery(source),p=assertRecoveryTarget(root,input),dir=join(root,'run/Sol-nunc');writeFileSync(join(dir,'started.json'),JSON.stringify({mode,pid:process.pid})+'\n',{flag:'wx'});mkdirSync(join(dir,'case-1'),{recursive:true});const manager=SessionManager.create(input.oldCwd,join(dir,'sessions')),provenance=restore(input,manager);writeJSON(join(dir,'restoration.json'),provenance);let session,errors=[],current;let controlledFetches=0;
 function status(state){writeJSON(join(dir,'status.json'),{state,mode,pid:process.pid,current,errors,controlledFetches,selection:input.selected.map(q=>q.id),fullRequiredAnswers:12,fullRequiredCriteria:24,budget:readJSON(join(dir,'budget.json'))});}
 try{
 for(const query of input.selected){try{
  current=query.id;manager.branch(provenance.frozenLeaf);const credentials=new InMemoryCredentialStore();if(mode==='preflight')await credentials.modify('openrouter',async()=>({type:'api_key',key:'offline-fixture-only'}));const runtime=mode==='preflight'?await ModelRuntime.create({credentials,refreshOnCreate:false,allowModelNetwork:false}):await ModelRuntime.create();
  if(mode==='preflight'){
   await runtime.setRuntimeApiKey('openrouter','offline-fixture-only');
   const original=runtime.streamSimple.bind(runtime);runtime.streamSimple=(model,context,options)=>original(model,context,{...options,apiKey:'offline-fixture-only',fetch:async(_url,request)=>{controlledFetches++;const body=JSON.parse(request.body);assert.equal(body.reasoning.effort,'medium');assert(Number.isInteger(body.max_tokens??body.max_completion_tokens));const data=[{id:'offline',choices:[{index:0,delta:{role:'assistant',content:'Controlled query-only response'},finish_reason:null}]},{id:'offline',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20}}];return new Response(data.map(d=>`data: ${JSON.stringify(d)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});}});
  }else{assert(runtime.hasConfiguredAuth('openrouter'));assert(!runtime.isUsingSubscription('openrouter'));assert(!runtime.isUsingOAuth('openrouter'));}
  session=await openRecovered(input,manager,root,runtime,context=>{assertQueryContext(input,query,context);record(join(dir,'restored-context.jsonl'),{query:query.id,context,fidelity:true});});status('running');let timer;const work=session.prompt(query.question);try{await Promise.race([work,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('Query deadline')),p.limits.operation_ms))]);}catch(error){await session.abort();await Promise.allSettled([work]);throw error;}finally{clearTimeout(timer);}
  const response=session.messages.filter(m=>m.role==='assistant').at(-1);assert.equal(response.stopReason,'stop',response.errorMessage);const answer=session.getLastAssistantText();assert(answer);writeJSON(join(dir,'case-1',`answer-${query.id.replaceAll(':','-')}.json`),{status:'complete',label:'Sol',arm:'nunc',case:1,query,answer,response,frozenLeaf:provenance.frozenLeaf,sessionFile:manager.getSessionFile(),fixture:mode==='preflight'});
 }catch(error){errors.push({query:query.id,error:String(error)});record(join(dir,'events.jsonl'),{type:'query_error',query:query.id,error:String(error)});}finally{if(session){session.abortCompaction();await session.abort();session.dispose();session=null;}reconcile(join(dir,'budget.json'));}}
 status(errors.length?'partial_or_failed':'complete');if(errors.length)process.exitCode=1;
 }finally{if(session){await session.abort();session.dispose();}reconcile(join(dir,'budget.json'));}
}
