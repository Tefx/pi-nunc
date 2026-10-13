// purpose: Adapt existing serial catalog reservation guard to exclusive BEAM conditions and actual catalog maxima.
// usage: installGuard(runtime, budgetFile, captureFile, modelId, effectiveContext)
// effects: Owned state/captures; delegates public native ModelRuntime calls, never accesses credentials.
// requires: One process per exclusive condition/judge budget, serial requests, retries disabled.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
export const readJSON=p=>JSON.parse(readFileSync(p,'utf8'));
export const writeJSON=(p,x)=>writeFileSync(p,JSON.stringify(x,null,2)+'\n');
export const record=(p,x)=>appendFileSync(p,JSON.stringify({at:new Date().toISOString(),...x})+'\n');
export function reserve(file,model,output,contextLimit){
 const s=readJSON(file); assert(!s.stopped,'Budget stopped');assert(s.admissions<(s.maxCalls??80),'Finite model-call limit');assert.equal(model.provider,'openrouter');assert(Number.isInteger(output)&&output>0&&output<=model.maxTokens);assert.equal(model.contextWindow,contextLimit);
 const prices=[model.cost,...(model.cost.tiers??[])];const inputRate=Math.max(...prices.flatMap(p=>[p.input,p.cacheRead??0,p.cacheWrite??0]));const outputRate=Math.max(...prices.map(p=>p.output));
 const usd=(contextLimit*inputRate+output*outputRate)/1e6;const pending=Object.values(s.pending).reduce((n,p)=>n+p.usd,0);assert(Object.keys(s.pending).length<(s.maxInflight??1),'Serial condition/judge inflight limit');assert(s.spentUsd+s.heldUnknownUsd+pending+usd<s.allowanceUsd,'Exclusive cap exceeded');
 const id=String(++s.admissions);s.pending[id]={usd,output,contextLimit,inputRate,outputRate};s.maxReservedTotalUsd=Math.max(s.maxReservedTotalUsd,s.spentUsd+s.heldUnknownUsd+pending+usd);writeJSON(file,s);return id;
}
export function settle(file,id,response){
 const s=readJSON(file),p=s.pending[id];assert(p,'Missing reservation');const u=response?.usage;const valid=u&&[u.input,u.cacheRead,u.cacheWrite,u.output].every(n=>Number.isFinite(n)&&n>=0)&&u.input+u.cacheRead+u.cacheWrite+u.output>0;
 if(!valid){s.heldUnknownUsd+=p.usd;delete s.pending[id];s.unknownCalls++;writeJSON(file,s);return {unknown:true,heldUsd:p.usd};}
 const input=u.input+u.cacheRead+u.cacheWrite;assert(input<=p.contextLimit,'Observed input exceeds effective context reservation');assert(u.output<=p.output,'Observed output exceeds outbound authorization');
 const model=s.model;const tiers=[{inputTokensAbove:-1,...model.cost},...(model.cost.tiers??[])];const rate=tiers.filter(t=>input>t.inputTokensAbove).at(-1);const usd=(u.input*rate.input+u.cacheRead*(rate.cacheRead??rate.input)+u.cacheWrite*(rate.cacheWrite??rate.input)+u.output*rate.output)/1e6;assert(usd<=p.usd+1e-8,'Receipt exceeds reservation');s.spentUsd+=usd;delete s.pending[id];s.receipts++;writeJSON(file,s);return {computedCatalogUsd:usd,sdkCatalogUsd:u.cost?.total??null,usage:u};
}
export function hold(file,id,error){const s=readJSON(file),p=s.pending[id];if(p){s.heldUnknownUsd+=p.usd;delete s.pending[id];s.unknownCalls++;}s.errors.push(String(error));writeJSON(file,s);}
export function reconcile(file){const s=readJSON(file);for(const id of Object.keys(s.pending))hold(file,id,'Stopped operation without complete receipt');return readJSON(file);}
export function installGuard(runtime,file,capture,modelId,contextLimit){
 const originalStream=runtime.streamSimple.bind(runtime),originalComplete=runtime.complete.bind(runtime);
 function admit(model,context,options,kind){assert.equal(model.id,modelId);assert.equal(model.api,'openai-completions');assert(options?.maxRetries===undefined||options.maxRetries===0,'Retries disabled');assert.deepEqual(model.cost,readJSON(file).model.cost,'Native prices differ from frozen allocation');const output=options?.maxTokens??model.maxTokens;if(kind==='raw-complete')assert(output<=32768,'Maintenance/judge ceiling');const id=reserve(file,model,output,contextLimit);record(capture,{type:'request',id,kind,model,context,options:{maxTokens:options?.maxTokens??null,reasoning:options?.reasoning??null,reasoningEffort:options?.reasoningEffort??null,maxRetries:options?.maxRetries??null}});return id;}
 function observed(options,id){return {...options,onPayload:async(payload,model)=>{const replacement=await options?.onPayload?.(payload,model);const wire=replacement??payload;const s=readJSON(file);assert(wire.reasoning?.effort==='medium','Actual wire must use medium; observer does not inject effort');const cap=wire.max_completion_tokens??wire.max_tokens;assert(Number.isInteger(cap)&&cap>0&&cap===s.pending[id].output,'Actual serialized output bound');record(capture,{type:'wire',id,model,payload:wire});return replacement;}};}
 runtime.streamSimple=function(model,context,options){const id=admit(model,context,options,'native-stream');let stream;try{stream=originalStream(model,context,observed(options,id));}catch(e){hold(file,id,e);throw e;}const result=stream.result.bind(stream);let promise;stream.result=()=>promise??=(async()=>{try{const response=await result();const receipt=settle(file,id,response);record(capture,{type:'response',id,response,receipt});return response;}catch(e){hold(file,id,e);throw e;}})();return stream;};
 runtime.complete=async function(model,context,options){const id=admit(model,context,options,'raw-complete');try{assert.equal(options?.reasoningEffort,'medium','Product forwards effort without observer injection');const response=await originalComplete(model,context,observed(options,id));const receipt=settle(file,id,response);record(capture,{type:'response',id,response,receipt});return response;}catch(e){hold(file,id,e);throw e;}};
}
