// purpose: Expose the six unchanged official MemoryArena CSV tool schemas/results through public Pi ExtensionAPI.
// usage: externalPi -e pi-travel-tools.mjs --travel-config <ownedJSON{url,toolsFile,logFile}> --tools <six names>
// effects: Read-only loopback tool requests, task-local observations; no source/default/credential/model manipulation.
// requires: Pi1.1 public registerTool/flags/commands; running task-local official ToolExecutor bridge.
import {readFileSync,appendFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import assert from 'node:assert/strict';
// Pinned MemoryArena6cd9de14 official declarations are available at registration,
// before the stock CLI parses extension flags. Runtime inputs must match them.
const definitions=JSON.parse(readFileSync(new URL('./tools.json',import.meta.url),'utf8'));
export default function(pi) {
 pi.registerFlag('travel-config',{type:'string',description:'Task-local official Travel tool bridge configuration'});
 let cfg,configPath;
 pi.on('session_start',()=>{
  cfg=undefined;configPath=undefined;
  const path=pi.getFlag('travel-config');assert(typeof path==='string'&&path.length,'Missing travel-config');
  const selected=resolve(path),input=JSON.parse(readFileSync(selected,'utf8'));
  for(const key of ['url','toolsFile','logFile'])assert(typeof input[key]==='string'&&input[key].length,`Invalid travel config ${key}`);
  const toolsFile=resolve(dirname(selected),input.toolsFile),logFile=resolve(dirname(selected),input.logFile);
  assert.deepEqual(JSON.parse(readFileSync(toolsFile,'utf8')),definitions,'Runtime tools differ from pinned official declarations');
  configPath=selected;cfg={url:input.url,toolsFile,logFile};
 });
 function config(){
  assert(cfg,'Travel configuration not bound at session_start');
  const flag=pi.getFlag('travel-config');assert(typeof flag==='string'&&resolve(flag)===configPath,'Travel configuration path changed');
  return cfg;
 }
 async function invoke(name,args,signal) {
  const cfg=config(),begin=Date.now();
  const response=await fetch(cfg.url+'/tool',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,args}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`Travel bridge HTTP${response.status}`);
  const data=await response.json();if(data.name!==name||typeof data.result!=='string')throw new Error('Unexpected tool bridge response');
  appendFileSync(cfg.logFile,JSON.stringify({type:'tool',at:new Date().toISOString(),name,args,elapsedMs:Date.now()-begin,result:data.result})+'\n');
  return {content:[{type:'text',text:data.result}],details:{source:'MemoryArena official ToolExecutor',name}};
 }
 for(const {function:f} of definitions)pi.registerTool({name:f.name,label:f.name,description:f.description,parameters:structuredClone(f.parameters),executionMode:'sequential',execute:async(_id,args,signal)=>invoke(f.name,args,signal)});
 pi.registerCommand('bench-travel-probe',{description:'Non-model preflight of actual public tool bridge',handler:async()=>{
  const r=await invoke('CitySearch',{state:'Illinois'});if(!r.content[0].text.includes('Rockford'))throw new Error('Official CitySearch preflight failed');
 }});
}
