// purpose: Run one frozen Nunc Fact40 formation and independent queries with actual defaults.
// usage: node scripts/benchmarks/mab/run-condition.mjs <suite-root> luna-nunc|sol-nunc [preflight]
// effects: New owned sessions, captures, reservations; paid calls only without preflight and with downstream authorization.
// requires: Frozen protocol/admission, tracked build, native Pi authentication; never replays a previous target.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RpcClient } from '@earendil-works/pi-coding-agent';
import { parseJsonl, assertHidden, assertQueryDelta } from './contracts.mjs';
import { reconcileStoppedState } from './capture.mjs';
import { assertFactProtocol } from '../selection.mjs';
const base=resolve(process.argv[2]),root=join(base,process.argv[3]),preflight=process.argv[4]==='preflight';
assert(process.argv.length===4||preflight&&process.argv.length===5);
const protocol=JSON.parse(readFileSync(join(root,'protocol.json'),'utf8'));assertFactProtocol(protocol);
const helpers=dirname(fileURLToPath(import.meta.url));
const records=path=>parseJsonl(readFileSync(path,'utf8'));
const events=join(root,'events.jsonl');assert(!existsSync(events),'Refuse replay');
const started=Date.now(),budget={calls:0,contextInput:0,output:0},completed=[];
let current={phase:'starting'},active;
const status=state=>writeFileSync(join(root,'status.json'),JSON.stringify({state,startedAt:new Date(started).toISOString(),elapsedSeconds:(Date.now()-started)/1000,budget,current,completed},null,2)+'\n');
const log=data=>{appendFileSync(events,JSON.stringify({at:new Date().toISOString(),...data})+'\n');status('running');};
const check=()=>{assert(Date.now()-started<protocol.limits.runSeconds*1000);assert(budget.calls<=protocol.limits.calls&&budget.contextInput<=protocol.limits.contextInput&&budget.output<=protocol.limits.output);};
function usage(u,label){assert(u&&['input','output','cacheRead','cacheWrite'].every(k=>Number.isFinite(u[k])),'Missing usage');budget.calls++;budget.contextInput+=u.input+u.cacheRead+u.cacheWrite;budget.output+=u.output;log({type:'usage',label,usage:u});check();}
async function bounded(fn){check();let timer;try{return await Promise.race([fn(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Operation deadline')),Math.min(protocol.limits.operationSeconds*1000,protocol.limits.runSeconds*1000-(Date.now()-started)));})]);}catch(error){await active?.abort().catch(()=>{});throw error;}finally{clearTimeout(timer);}}
async function prompt(client,message,label){const begin=Date.now(),ev=await bounded(()=>client.promptAndWait(message,undefined,protocol.limits.operationSeconds*1000));const messages=ev.filter(e=>e.type==='message_end'&&e.message.role==='assistant').map(e=>e.message);assert.equal(messages.length,1);const response=messages[0];usage(response.usage,label);assert.equal(response.stopReason,'stop',response.errorMessage);assert(ev.some(e=>e.type==='agent_settled'&&!e.aborted));assert.equal(response.model,protocol.model.id);assert.equal(response.provider,protocol.model.provider);return {response,elapsedMs:Date.now()-begin};}
async function compact(client){let off;const terminal=new Promise((res,rej)=>{off=client.onEvent(e=>{if(e.type==='compaction_end')e.result&&!e.aborted&&!e.errorMessage?res(e.result):rej(new Error(e.errorMessage??'Maintenance failed'));});});try{const [,result]=await Promise.all([client.prompt('/bench-compact').then(d=>assert.equal(d,'handled')),terminal]);return result;}finally{off?.();}}
const [sh,mh]=protocol.cases,label=`nunc-${sh.caseId}`,cwd=join(root,label);assert(!existsSync(cwd));mkdirSync(join(cwd,'.pi'),{recursive:true});mkdirSync(join(cwd,'sessions'));
const obs=join(cwd,'observations.jsonl'),capture=join(cwd,'extraction.jsonl');writeFileSync(obs,'');writeFileSync(capture,'');
writeFileSync(join(cwd,'.pi/settings.json'),JSON.stringify({compaction:{enabled:false,reserveTokens:239232,keepRecentTokens:20000,modelOverrides:{[`${protocol.model.provider}/${protocol.model.id}`]:{reserveTokens:239232,keepRecentTokens:20000}}},retry:{enabled:false,provider:{maxRetries:0,timeoutMs:protocol.limits.operationSeconds*1000}},transport:'sse',defaultTools:[],nunc:{memoryTools:false}})+'\n');
const client=new RpcClient({cliPath:fileURLToPath(new URL('cli.js',import.meta.resolve('@earendil-works/pi-coding-agent'))),cwd,provider:protocol.model.provider,model:protocol.model.id,env:{PI_SESSION_ID:'',PI_SESSION_FILE:'',PI_PROVIDER:'',PI_MODEL:'',PI_REASONING_LEVEL:'',PI_OFFLINE:'1',PI_TELEMETRY:'0',PI_SKIP_VERSION_CHECK:'1'},args:['--offline','--approve','--no-extensions','--no-mcp','--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--no-tools','--thinking',protocol.readerThinking,'--session-dir',join(cwd,'sessions'),'--system-prompt',sh.systemPrompt,'-e',protocol.nunc.compiledSource,'-e',join(helpers,'observer.mjs'),'--bench-observer-file',obs,'--bench-capture-file',capture,'--bench-budget-file',join(root,'admission.json')]});
active=client;
try{
 await bounded(()=>client.start());const initial=await client.getState();assert.equal(initial.model.id,protocol.model.id);assert.equal(initial.model.contextWindow,272000);assert.equal(initial.thinkingLevel,'medium');assert.equal(initial.autoCompactionEnabled,false);assert((await client.getCommands()).some(c=>c.name==='nunc'));assert(records(capture).some(e=>e.type==='capture_ready'));
 log({type:'client_started',arm:'nunc',history:sh.caseId,model:initial.model,thinking:initial.thinkingLevel,sessionFile:initial.sessionFile});
 if(preflight){assert.equal(JSON.parse(readFileSync(join(root,'admission.json'),'utf8')).admissions,0);status('preflight_complete');}
 else{
 const delivered=[];
 for(let i=0;i<sh.chunks.length;i++){
  current={arm:'nunc',history:sh.caseId,phase:'ingestion',chunk:i+1};const chunk=(i===0?protocol.framing.fact+'\n\n':'')+sh.chunks[i];assertHidden(chunk,protocol.cases);delivered.push(chunk);
  const ingestion=await prompt(client,chunk,`${label}:ingest:${i+1}`);log({type:'ingestion',...current,elapsedMs:ingestion.elapsedMs});
  if(!sh.checkpointAfterChunks.includes(i+1))continue;
  current={arm:'nunc',history:sh.caseId,phase:'compaction',afterChunk:i+1};const begin=Date.now(),before=records(obs).length,beforeCapture=records(capture).length;
  const result=await bounded(()=>compact(client)),newCapture=records(capture).slice(beforeCapture),requests=newCapture.filter(e=>e.type==='request'),responses=newCapture.filter(e=>e.type==='response');assert.equal(requests.length,1);assert.equal(responses.length,1);assert.equal(requests[0].id,responses[0].id);usage(responses[0].response.usage,`${label}:maintenance:${i+1}`);
  const observation=records(obs).slice(before).find(e=>e.type==='nunc_maintenance');assert.equal(observation?.ok,true,observation?.message);assert.equal(observation.observations.omissions.length,0,'Actual default full must expose all source');assert.equal(requests[0].options.maxTokens,observation.observations.accounting.outputCapTokens);
  const saved=await client.getEntries(),cps=saved.entries.filter(e=>e.type==='compaction'),cp=cps.at(-1);assert.equal(cp.summary,result.summary);const end=saved.entries.findIndex(e=>e.id===cp.id),cut=saved.entries.findIndex(e=>e.id===cp.firstKeptEntryId);assert(cut>=0&&cut<end);
  const keptChunks=saved.entries.slice(cut,end).filter(e=>e.type==='message'&&e.message.role==='user').map(e=>{const content=e.message.content,t=typeof content==='string'?content:content.filter(b=>b.type==='text').map(b=>b.text).join('\n');const n=delivered.indexOf(t);assert(n>=0);return n+1;});
  log({type:'checkpoint',...current,count:cps.length,id:cp.id,firstKeptEntryId:cp.firstKeptEntryId,keptChunks,summary:cp.summary,memory:result.details.nunc,accounting:observation.observations.accounting,required:observation.observations.required,elapsedMs:Date.now()-begin,extractionResponse:responses[0].response.content.filter(b=>b.type==='text').map(b=>b.text).join('')});
 }
 const frozen=await client.getState(),saved=await client.getEntries();assert.equal(saved.entries.filter(e=>e.type==='compaction').length,2);const frozenMessages=await client.getMessages();
 log({type:'frozen',arm:'nunc',history:sh.caseId,sessionFile:frozen.sessionFile,leafId:saved.leafId});
 for(const group of [sh,mh])for(const q of group.questions){current={arm:'nunc',history:sh.caseId,phase:'QA',caseId:group.caseId,id:q.id};assert.equal((await client.switchSession(frozen.sessionFile)).cancelled,false);assert.equal((await client.clone()).cancelled,false);const query=await client.getState();assert.notEqual(query.sessionFile,frozen.sessionFile);assert.deepEqual(await client.getMessages(),frozenMessages);const result=await prompt(client,q.prompt,`nunc:${group.caseId}:QA:${q.id}`),delta=await client.getEntries(saved.leafId);assertQueryDelta(delta.entries,q.prompt);const answer=result.response.content.filter(b=>b.type==='text').map(b=>b.text).join('\n');appendFileSync(join(root,'answers.jsonl'),JSON.stringify({arm:'nunc',caseId:group.caseId,id:q.id,index:q.index,answer,response:result.response,elapsedMs:result.elapsedMs,frozenSessionFile:frozen.sessionFile,frozenLeafId:saved.leafId,querySessionFile:query.sessionFile,querySessionHeader:records(query.sessionFile)[0],queryEntries:delta.entries})+'\n');log({type:'answer',...current,answer,elapsedMs:result.elapsedMs});}
 completed.push({arm:'nunc',history:sh.caseId,answered:40,frozenSessionFile:frozen.sessionFile});status('completed');
 }
}catch(error){current={...current,error:String(error)};status('failed');console.error(error);process.exitCode=1;}
finally{await client.stop();writeFileSync(join(cwd,'stderr.log'),client.getStderr());active=undefined;const path=join(root,'admission.json'),state=JSON.parse(readFileSync(path,'utf8'));reconcileStoppedState(state,sh.caseId);writeFileSync(path,JSON.stringify(state,null,2)+'\n');}
