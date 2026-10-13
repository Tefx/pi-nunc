// purpose: Bounded actual external-Pi MemoryArena Travel comparison, one persistent session per complete linked group.
// usage: node helpers/run_comparison.mjs <absolute-task-root> preflight|run
// effects: Owned local profiles/sessions/receipts and (run only) approved Sol model/quota usage. Never writes checkpoints, source, global settings or credentials.
// requires: Pi1.1 public RpcClient, official tool bridge, protocol/selected cases, unchanged copied Nunc runtime and prior public observers.
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync,appendFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
import {assertArenaProtocol} from '../selection.mjs';
import {reconcileStoppedState} from '../mab/capture.mjs';
import {RpcClient} from '@earendil-works/pi-coding-agent';
const root=resolve(process.argv[2]),mode=process.argv[3],runRoot=join(root,mode==='run'?'run':'preflight');
assert(['run','preflight'].includes(mode));mkdirSync(runRoot,{recursive:true});
const proto=JSON.parse(readFileSync(join(root,'protocol.json'),'utf8'));assertArenaProtocol(proto);
const templates=JSON.parse(readFileSync(join(root,'runtime/prompts.json'),'utf8'));
const toolDefs=JSON.parse(readFileSync(join(root,'runtime/tools.json'),'utf8'));
const toolNames=toolDefs.map(x=>x.function.name);
const bridge=JSON.parse(readFileSync(join(root,'runtime/tool-service.json'),'utf8'));
const helpers=dirname(fileURLToPath(import.meta.url));
const eventsFile=join(runRoot,'events.jsonl');assert(!existsSync(eventsFile),'Refuse replay into previous results');
const started=Date.now(),completed=[];let current={phase:'start'},active;
const budget={successfulOperations:0,contextInput:0,output:0,toolCalls:0,catalogEquivalentUsd:0,unknownUsageAttempts:0};
const lines=p=>existsSync(p)?readFileSync(p,'utf8').split('\n').filter(Boolean).map(JSON.parse):[];
function status(state='running'){writeFileSync(join(runRoot,'status.json'),JSON.stringify({state,startedAt:new Date(started).toISOString(),elapsedSeconds:(Date.now()-started)/1000,current,budget,completed},null,2)+'\n');}
function log(e){appendFileSync(eventsFile,JSON.stringify({at:new Date().toISOString(),...e})+'\n');status();}
function limits(){const admission=JSON.parse(readFileSync(join(root,'catalog-admission.json'),'utf8'));assert(!admission.stopped,admission.error??'Catalog admission stopped');assert(admission.spentUsd<=proto.catalogAllowanceUsd,'Catalog allowance');assert(Date.now()-started<proto.limits.runSeconds*1000,'Overall time limit');for(const k of ['successfulOperations','contextInput','output','toolCalls'])assert(budget[k]<=proto.limits[k],`Observed ${k} ceiling`);}
function receipt(u,phase,extra={}){assert(u&&[u.input,u.cacheRead,u.cacheWrite,u.output].every(Number.isFinite),'Missing complete usage');budget.successfulOperations++;budget.contextInput+=u.input+u.cacheRead+u.cacheWrite;budget.output+=u.output;budget.catalogEquivalentUsd+=u.cost?.total??0;log({type:'usage',...current,phase,...extra,usage:u});limits();}
async function bounded(fn){limits();let timer;try{return await Promise.race([fn(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Operation/run deadline')),Math.min(proto.limits.operationSeconds*1000,proto.limits.runSeconds*1000-(Date.now()-started)));})]);}catch(e){void active?.abort().catch(()=>{});throw e;}finally{clearTimeout(timer);}}
import {buildPrompt} from './travel-prompts.mjs';
async function runOne(group,arm){
 current={group,arm,phase:'launch'};status();const input=JSON.parse(readFileSync(join(root,`cases/${group}/input.json`),'utf8'));
 const cwd=join(runRoot,`${arm}-${group}`);assert(!existsSync(cwd),'No profile replay');mkdirSync(join(cwd,'.pi'),{recursive:true});mkdirSync(join(cwd,'sessions'));
 const obs=join(cwd,'observations.jsonl'),capture=join(cwd,'extraction.jsonl'),toolsLog=join(cwd,'tools.jsonl');for(const p of [obs,capture,toolsLog])writeFileSync(p,'');
 writeFileSync(join(cwd,'travel-config.json'),JSON.stringify({url:bridge.url,toolsFile:join(root,'runtime/tools.json'),logFile:toolsLog})+'\n');
 const settings={compaction:{enabled:true,reserveTokens:proto.compaction.reserveTokens,keepRecentTokens:proto.compaction.keepRecentTokens,modelOverrides:{[`${proto.model.provider}/${proto.model.id}`]:{reserveTokens:proto.compaction.reserveTokens,keepRecentTokens:proto.compaction.keepRecentTokens}}},retry:{enabled:false,provider:{maxRetries:0,timeoutMs:proto.limits.operationSeconds*1000}},transport:'sse',defaultTools:toolNames,nunc:{memoryTools:false}};
 writeFileSync(join(cwd,'.pi/settings.json'),JSON.stringify(settings)+'\n');
 const client=new RpcClient({cliPath:fileURLToPath(new URL('cli.js',import.meta.resolve('@earendil-works/pi-coding-agent'))),cwd,provider:proto.model.provider,model:proto.model.id,env:{PI_SESSION_ID:'',PI_SESSION_FILE:'',PI_PROVIDER:'',PI_MODEL:'',PI_REASONING_LEVEL:'',PI_OFFLINE:'1',PI_TELEMETRY:'0',PI_SKIP_VERSION_CHECK:'1'},args:[
  '--offline','--approve','--no-extensions','--no-mcp','--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--tools',toolNames.join(','),'--thinking',proto.thinking,'--session-dir',join(cwd,'sessions'),'--system-prompt',templates.AGENT_SYSTEM_PROMPT,
  ...(arm==='nunc'?['-e',proto.nunc.compiledSource]:[]),
  '-e',join(helpers,'sol-observer-medium.mjs'),'--bench-observer-file',obs,'--bench-capture-file',capture,'--bench-budget-file',join(root,'catalog-admission.json'),
  '-e',join(helpers,'pi-travel-tools.mjs'),'--travel-config',join(cwd,'travel-config.json'),
   ]});active=client;let fatal,unsubscribe,stepCount=0,cpCount=0,seenCaptures=0;const checkpointTimes=[];
 try{
  await bounded(()=>client.start());const initial=await client.getState();assert.equal(initial.model.provider,proto.model.provider);assert.equal(initial.model.id,proto.model.id);assert.equal(initial.model.api,proto.model.api);assert.equal(initial.model.contextWindow,272000);assert.equal(initial.thinkingLevel,'medium');assert.equal(initial.autoCompactionEnabled,true);
  assert.equal((await client.getCommands()).some(c=>c.name==='nunc'),arm==='nunc');const start=lines(obs).find(e=>e.type==='session_start');assert(start&&start.pid!==process.pid);assert.deepEqual([...start.tools].sort(),[...toolNames].sort());assert(lines(capture).some(e=>e.type==='capture_ready'&&e.authConfigured===true&&e.oauth===false&&e.subscription===false&&e.thinking==='medium'&&e.model.contextWindow===272000&&e.catalogContextWindow>=272000));
  log({type:'client_started',...current,pid:start.pid,sessionFile:initial.sessionFile,model:initial.model,thinking:initial.thinkingLevel,tools:start.tools});
  if(mode==='preflight'){
   assert.equal(await client.prompt('/bench-travel-probe'),'handled');
   // Pi may report a command as handled even after its handler failed. Require
   // the actual official read-only response rather than the disposition alone.
   const probes=lines(toolsLog);assert.equal(probes.length,1,'Official CitySearch probe did not complete');
   assert.equal(probes[0].name,'CitySearch');assert.deepEqual(probes[0].args,{state:'Illinois'});assert(probes[0].result.includes('Rockford'));
   const saved=await client.getEntries();assert.equal(saved.entries.filter(e=>e.type==='message').length,0);completed.push({group,arm,zeroModelCalls:true,tools:start.tools});log({type:'preflight_complete',group,arm});return;
  }
  unsubscribe=client.onEvent(e=>{
   try{
    if(e.type==='message_end'&&e.message.role==='assistant'){
     const m=e.message;stepCount++;assert.equal(m.provider,proto.model.provider);assert.equal(m.model,proto.model.id);
     if(['error','aborted'].includes(m.stopReason)){budget.unknownUsageAttempts++;log({type:'failed_assistant',...current,message:m});throw new Error(m.errorMessage??m.stopReason);}
     receipt(m.usage,'assistant',{stopReason:m.stopReason,step:stepCount});assert(stepCount<=proto.limits.assistantRoundsPerTraveler,'Per-traveler assistant step limit');
    }else if(e.type==='tool_execution_end'){
     budget.toolCalls++;log({type:'tool_finished',...current,toolName:e.toolName,isError:e.isError});limits();
    }else if(e.type==='compaction_start'){
     checkpointTimes.push(Date.now());log({type:'maintenance_start',...current,reason:e.reason});
    }else if(e.type==='compaction_end'){
     if(e.aborted||e.errorMessage||!e.result){budget.unknownUsageAttempts++;log({type:'maintenance_failed',...current,event:e});throw new Error(e.errorMessage??'Compaction aborted or missing terminal result');}
     cpCount++;assert(cpCount<=proto.limits.maintenancePerSession,'Maintenance recurrence limit');
     let observation=null;
     if(arm==='nunc'){
      const records=lines(capture),responses=records.filter(x=>x.type==='response');const fresh=responses.slice(seenCaptures);seenCaptures=responses.length;assert.equal(fresh.length,1,'One Nunc model response per successful maintenance');assert.equal(fresh[0].response.stopReason,'stop');assert.equal(records.filter(x=>x.type==='serialized_maintenance').at(-1)?.payload?.reasoning?.effort,'medium');receipt(fresh[0].response.usage,'maintenance');observation=lines(obs).filter(x=>x.type==='nunc_maintenance').at(-1);assert.equal(observation?.ok,true,observation?.message);
     }else receipt(e.result.usage,'maintenance');
     log({type:'maintenance_complete',...current,index:cpCount,reason:e.reason,elapsedMs:Date.now()-(checkpointTimes.shift()??Date.now()),result:e.result,accounting:observation?.observations?.accounting??null,required:observation?.observations?.required??null});
    }
   }catch(error){fatal??=error;void client.abort().catch(()=>{});}
  });
  for(const q of input.questions){
   current={group,arm,phase:'traveler',round:q.round_idx,name:q.name};status();stepCount=0;limits();if(fatal)throw fatal;
   const prompt=buildPrompt(templates,input,q);const begin=Date.now();let terminalListener;const messages=[];
   try{
    const terminal=new Promise(resolve=>{terminalListener=client.onEvent(e=>{if(e.type==='message_end'&&e.message.role==='assistant')messages.push(e.message);if(e.type==='agent_settled')resolve(e);});});
    const [,done]=await bounded(()=>Promise.all([client.prompt(prompt).then(d=>assert.equal(d,'started')),terminal]));if(fatal)throw fatal;assert.equal(done.aborted,false);const response=messages.at(-1);assert(response);assert.equal(response.stopReason,'stop',response.errorMessage);
    const answer=response.content.filter(b=>b.type==='text').map(b=>b.text).join('\n');const saved=await client.getEntries();
    const checkpoints=saved.entries.filter(x=>x.type==='compaction').map(cp=>{const cut=saved.entries.findIndex(x=>x.id===cp.firstKeptEntryId),end=saved.entries.findIndex(x=>x.id===cp.id);assert(cut>=0&&cut<end);return{id:cp.id,firstKeptEntryId:cp.firstKeptEntryId,tokensBefore:cp.tokensBefore,keptEntries:saved.entries.slice(cut,end).map(x=>({id:x.id,type:x.type,role:x.message?.role})),memory:cp.details?.nunc??null};});
    appendFileSync(join(runRoot,'answers.jsonl'),JSON.stringify({group,arm,round:q.round_idx,name:q.name,prompt,answer,response,assistantSteps:messages.length,elapsedMs:Date.now()-begin,sessionFile:initial.sessionFile,leafId:saved.leafId,checkpointCount:checkpoints.length})+'\n');
    writeFileSync(join(cwd,'checkpoints.json'),JSON.stringify(checkpoints,null,2)+'\n');log({type:'traveler_complete',...current,elapsedMs:Date.now()-begin,assistantSteps:messages.length,checkpointCount:checkpoints.length});
   }finally{terminalListener?.();}
  }
  const final=await client.getState();completed.push({group,arm,travelers:input.questions.length,sessionFile:final.sessionFile,maintenances:cpCount});log({type:'group_complete',...completed.at(-1)});
 }finally{await client.stop();unsubscribe?.();writeFileSync(join(cwd,'stderr.log'),client.getStderr());active=undefined;const path=join(root,'catalog-admission.json'),state=JSON.parse(readFileSync(path,'utf8'));reconcileStoppedState(state,`arena-${group}`);writeFileSync(path,JSON.stringify(state,null,2)+'\n');}
}
try{
 const health=await (await fetch(bridge.url+'/health',{signal:AbortSignal.timeout(30000)})).json();assert.deepEqual(health.tools,[...toolNames].sort());assert.equal(health.flightCsvBytes,304807007,'Full official CSV required; no scorer subset liveDB');
 if(mode==='preflight'){for(const arm of [proto.arm])await runOne(proto.groups[0],arm);assert.equal(budget.successfulOperations,0);}
 else for(const [group,arm] of proto.order)await runOne(group,arm);
 current={phase:'finished'};status('completed');
}catch(error){current={...current,error:String(error)};status('failed');console.error(error);process.exitCode=1;}
