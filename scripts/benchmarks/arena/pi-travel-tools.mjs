// purpose: Expose the six unchanged official MemoryArena CSV tool schemas/results through public Pi ExtensionAPI.
// usage: externalPi -e pi-travel-tools.mjs --travel-config <ownedJSON{url,toolsFile,logFile}> --tools <six names>
// effects: Read-only loopback tool requests, task-local observations; no source/default/credential/model manipulation.
// requires: Pi1.1 public registerTool/flags/commands; running task-local official ToolExecutor bridge.
import {readFileSync,appendFileSync} from 'node:fs';
export default function(pi) {
 pi.registerFlag('travel-config',{type:'string',description:'Task-local official Travel tool bridge configuration'});
 const path=pi.getFlag('travel-config');if(typeof path!=='string')throw new Error('Missing travel-config');
 const definitions=JSON.parse(readFileSync(JSON.parse(readFileSync(path,'utf8')).toolsFile,'utf8'));
 let cfg;
 function config(){if(!cfg){const path=pi.getFlag('travel-config');if(typeof path!=='string')throw new Error('Missing travel-config');cfg=JSON.parse(readFileSync(path,'utf8'));}return cfg;}
 async function invoke(name,args,signal) {
  const cfg=config(),begin=Date.now();
  const response=await fetch(cfg.url+'/tool',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,args}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`Travel bridge HTTP${response.status}`);
  const data=await response.json();if(data.name!==name||typeof data.result!=='string')throw new Error('Unexpected tool bridge response');
  appendFileSync(cfg.logFile,JSON.stringify({type:'tool',at:new Date().toISOString(),name,args,elapsedMs:Date.now()-begin,result:data.result})+'\n');
  return {content:[{type:'text',text:data.result}],details:{source:'MemoryArena official ToolExecutor',name}};
 }
 for(const {function:f} of definitions)pi.registerTool({name:f.name,label:f.name,description:f.description,parameters:f.parameters,executionMode:'sequential',execute:async(_id,args,signal)=>invoke(f.name,args,signal)});
 pi.registerCommand('bench-travel-probe',{description:'Non-model preflight of actual public tool bridge',handler:async()=>{
  const r=await invoke('CitySearch',{state:'Illinois'});if(!r.content[0].text.includes('Rockford'))throw new Error('Official CitySearch preflight failed');
 }});
}
