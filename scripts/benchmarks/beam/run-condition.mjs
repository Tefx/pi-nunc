// purpose: Existing BEAM native SDK adapter, fresh Nunc-only formation and independent frozen-state probes, no execution recovery.
// usage: node run-condition.mjs SUITE_ROOT Luna|Sol preflight|run
// effects: Owned sessions/ledgers/captures; run only invokes approved model requests. No answer/history regeneration.
// requires: Frozen remaining selector, canonical histories/probes, compiled product, native auth handoff.
import assert from 'node:assert/strict';
import {mkdirSync,existsSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager,ModelRuntime} from '@earendil-works/pi-coding-agent';
import {readJSON,writeJSON,record,installGuard,reconcile} from './guard.mjs';
import {assertBeamProtocol,assertBeamInputs} from '../remaining-selection.mjs';
import {splitBatch} from './contracts.mjs';
assert.equal(process.argv.length,5,'No recovery/resume arguments');
const root=resolve(process.argv[2]),label=process.argv[3],mode=process.argv[4];assert(['Luna','Sol'].includes(label));assert(['preflight','run'].includes(mode));
const p=readJSON(join(root,'protocol.json'));assertBeamProtocol(p);const queries=assertBeamInputs(root,p),model=p.models[label],arm='nunc',dir=join(root,mode,`${label}-${arm}`);
mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'started.json'),JSON.stringify({mode,label})+'\n',{flag:'wx'});
const budgetFile=join(dir,'budget.json'),capture=join(dir,'capture.jsonl'),events=join(dir,'events.jsonl');writeJSON(budgetFile,{allowanceUsd:p.allocations_usd[`${label}-nunc`],spentUsd:0,heldUnknownUsd:0,pending:{},admissions:0,receipts:0,unknownCalls:0,errors:[],maxReservedTotalUsd:0,model,maxInflight:1,maxCalls:p.limits.max_calls_per_condition});
const product=(await import(pathToFileURL(p.nunc.compiledSource))).default;let active,current={phase:'preparing'},errors=[];const began=Date.now();
function status(state){writeJSON(join(dir,'status.json'),{state,pid:process.pid,label,arm,mode,current,elapsedMs:Date.now()-began,errors,budget:readJSON(budgetFile)});}
async function close(){if(active){active.abortCompaction();await active.abort();active.dispose();active=null;}reconcile(budgetFile);}
async function bounded(fn){assert(Date.now()-began<p.limits.overall_ms);let timer;const work=fn();try{return await Promise.race([work,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('Operation deadline')),p.limits.operation_ms))]);}catch(error){if(active){active.abortCompaction();await active.abort();}await Promise.allSettled([work]);throw error;}finally{clearTimeout(timer);}}
async function open(manager,cwd){
 const runtime=await ModelRuntime.create();assert(runtime.hasConfiguredAuth('openrouter'));assert(!runtime.isUsingSubscription('openrouter'));assert(!runtime.isUsingOAuth('openrouter'));assert.deepEqual(runtime.getModel('openrouter',model.id).cost,model.cost);installGuard(runtime,budgetFile,capture,model.id,p.effective_context);
 const settings=structuredClone(p.settings);settings.compaction.modelOverrides=Object.fromEntries(Object.values(p.models).map(m=>[`${m.provider}/${m.id}`,{reserveTokens:p.settings.compaction.reserveTokens,keepRecentTokens:p.settings.compaction.keepRecentTokens}]));mkdirSync(join(cwd,'.pi'),{recursive:true});writeJSON(join(cwd,'.pi/settings.json'),settings);const sm=SettingsManager.inMemory(settings);let ready=false;
 const observer=pi=>{
  pi.events.on('nunc:maintenance',e=>record(events,{type:'nunc_maintenance',case:current.case,batch:current.batch,...e}));
  pi.on('session_start',async(_e,ctx)=>{assert.equal(ctx.model.id,model.id);assert(await pi.setModel({...model,contextWindow:p.effective_context}));pi.setThinkingLevel('medium');assert.equal(ctx.model.contextWindow,p.effective_context);assert.equal(ctx.thinkingLevel,'medium');assert.equal(pi.getActiveTools().length,0);ready=true;record(events,{type:'session_ready',sessionId:manager.getSessionId(),sessionFile:manager.getSessionFile(),model:ctx.model,physical:model,thinking:ctx.thinkingLevel,nuncLoaded:true,auth:{supportedNative:true}});});
  pi.on('session_before_compact',e=>record(events,{type:'maintenance_preparation',case:current.case,batch:current.batch,reason:e.reason,tokensBefore:e.preparation.tokensBefore,firstKeptEntryId:e.preparation.firstKeptEntryId,settings:e.preparation.settings,sourceEntryIds:e.branchEntries.map(x=>x.id)}));
  pi.on('session_compact',e=>record(events,{type:'maintenance_committed',case:current.case,batch:current.batch,...e}));
 };
 const loader=new DefaultResourceLoader({cwd,agentDir:join(dir,'agent'),settingsManager:sm,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,systemPrompt:'You are a helpful assistant.',extensionFactories:[product,observer]});await loader.reload();assert.equal(loader.getExtensions().errors.length,0);
 const {session}=await createAgentSession({cwd,agentDir:join(dir,'agent'),modelRuntime:runtime,model,thinkingLevel:'medium',settingsManager:sm,sessionManager:manager,resourceLoader:loader,tools:[],noTools:'all'});active=session;await session.bindExtensions({mode:'json',onError:e=>errors.push(e),abortHandler:()=>session.abort()});assert(ready);assert.equal(session.thinkingLevel,'medium');assert.equal(session.model.contextWindow,98304);assert.equal(session.getActiveToolNames().length,0);assert(session.extensionRunner.getRegisteredCommands().some(x=>x.name==='nunc'));return session;
}
function append(manager,m,ordinal){const common={role:m.role,timestamp:1700000000000+ordinal};assert(['user','assistant'].includes(m.role));return manager.appendMessage(m.role==='user'?{...common,content:m.content}:{...common,content:[{type:'text',text:m.content}],api:model.api,provider:model.provider,model:'BEAM-original-assistant',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop'});}
try{
 status('running');
 if(mode==='preflight'){
  const cwd=join(dir,'zero-call');mkdirSync(cwd);const manager=SessionManager.create(cwd,join(cwd,'sessions')),original=readJSON(join(root,'inputs/1/formation.json'))[0].messages.slice(0,2);original.forEach((m,i)=>append(manager,m,i));await open(manager,cwd);assert.equal(active.messages.filter(m=>m.role==='user').length,original.filter(m=>m.role==='user').length);await close();assert.equal(readJSON(budgetFile).admissions,0);assert.equal(errors.length,0);status('preflight_pass');
 }else{
  for(const caseId of [1,2]){try{
   const cwd=join(dir,`case-${caseId}`);mkdirSync(cwd);const manager=SessionManager.create(cwd,join(cwd,'sessions')),formation=readJSON(join(root,`inputs/${caseId}/formation.json`));assert.equal(formation.length,3);let checkpoints=0;
   for(let batch=0;batch<3;batch++)for(const [segment,messages] of splitBatch(formation[batch].messages,batch).entries()){
    current={phase:'formation',case:caseId,batch:`${batch+1}.${segment+1}`};status('running');assert(!Object.keys(readJSON(budgetFile).pending).length);const sourceMap=messages.map((m,i)=>({upstreamMessageId:m.source_id,entryId:append(manager,m,batch*1000+segment*500+i)}));writeJSON(join(cwd,`batch-${current.batch}-source-map.json`),sourceMap);
    const session=await open(manager,cwd),result=await bounded(()=>session.compact());assert(result.summary?.length);const cp=manager.getBranch().filter(e=>e.type==='compaction').at(-1);assert(cp?.details?.nunc);checkpoints++;writeJSON(join(cwd,`batch-${current.batch}-maintenance.json`),{sourceMap,compaction:cp,result,nextProjectedMessages:manager.buildSessionContext().messages});await close();
   }
   assert.equal(checkpoints,5);const frozenLeaf=manager.getLeafId();writeJSON(join(cwd,'frozen.json'),{sessionFile:manager.getSessionFile(),frozenLeaf,checkpoints});
   for(const q of queries.filter(q=>q.case===caseId)){try{
    current={phase:'query',case:caseId,query:q.id};status('running');manager.branch(frozenLeaf);const beforeIds=manager.getBranch().map(e=>e.id);assert(!manager.getBranch().some(e=>e.type==='message'&&queries.some(x=>x.question===e.message.content)),'Frozen probe isolation');const session=await open(manager,cwd),start=Date.now();await bounded(()=>session.prompt(q.question));const response=session.messages.filter(m=>m.role==='assistant').at(-1);assert(response&&response.model===model.id);assert.equal(response.stopReason,'stop',response.errorMessage);const answer=session.getLastAssistantText();assert(answer);writeJSON(join(cwd,`answer-${q.id.replaceAll(':','-')}.json`),{status:'complete',label,arm,case:caseId,query:q,answer,response,elapsedMs:Date.now()-start,frozenLeaf,beforeIds,sessionFile:manager.getSessionFile(),leaf:manager.getLeafId()});await close();
   }catch(error){errors.push(String(error));record(events,{type:'query_error',current,error:String(error)});await close();}}
  }catch(error){errors.push(String(error));record(events,{type:'case_error',current,error:String(error)});await close();}}
  status(errors.length?'partial_or_blocked':'complete');if(errors.length)process.exitCode=1;
 }
}catch(error){errors.push(String(error));record(events,{type:'error',current,error:String(error)});await close();status('blocked');console.error(error);process.exitCode=1;}finally{await close();}
