// purpose: Adapt existing serial OpenRouter admission/capture to exclusive MAB condition allocations.
// usage: Pi extension --bench-capture-file <file> --bench-budget-file <condition admission>
// effects: Public session-local model copy; capture/reserve/debit own files; native auth owner delegates all requests.
// requires: Frozen catalog/prices; one process per admission file; native compaction <=2 subcalls; retries disabled.
import assert from 'node:assert/strict';
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
export function assertCatalogBinding(s,model){
 assert.equal(model.maxTokens,s.maxTokens);assert.deepEqual(model.cost,s.cost,'Current native rates differ from frozen reservation rates; rebind before paid work');
}
export function reserveState(s,kind,output,calls=1){
 assert(!s.stopped,'Admission stopped');assert.equal(Object.keys(s.pending).length,0,'Unreconciled request');
 assert(Number.isInteger(output)&&output>0&&output<=s.maxTokens,'Invalid actual output bound');
 assert(s.admissions<210,'Finite call-envelope ceiling');
 const rates=[s.cost,...(s.cost.tiers??[])];
 const input=Math.max(...rates.flatMap(r=>[r.input,r.cacheRead,r.cacheWrite]));
 const out=Math.max(...rates.map(r=>r.output));
 const usd=calls*(s.contextWindow*input+output*out)/1e6;
 assert(s.spentUsd+s.heldUnknownUsd+usd<s.allowanceUsd,'Exclusive condition allowance exhausted');
 s.pending[kind]={usd,calls,output};s.admissions++;s.maxReservedTotalUsd=Math.max(s.maxReservedTotalUsd,s.spentUsd+s.heldUnknownUsd+usd);return usd;
}
export function settleState(s,kind,u){
 const p=s.pending[kind];assert(p,'Missing reservation');assert(u&&['input','output','cacheRead','cacheWrite'].every(k=>Number.isFinite(u[k])&&u[k]>=0),'Missing usage');
 assert(Number.isFinite(u.cost?.total)&&u.cost.total>=0,'Missing catalog USD');
 // Native aggregate usage contains exact per-subcall catalog USD already calculated by installed Pi.
 const usd=u.cost.total;assert(usd<=p.usd+1e-8,'Receipt exceeds reservation');
 s.spentUsd+=usd;delete s.pending[kind];s.receipts++;assert(s.spentUsd+s.heldUnknownUsd<s.allowanceUsd);return usd;
}
export function reconcileStoppedState(s,history){
 const reservations=s.pending;const usd=Object.values(reservations).reduce((n,p)=>n+p.usd,0);
 if(usd){s.heldUnknownUsd+=usd;s.unknownReservations??=[];s.unknownReservations.push({history,cause:'Failed or incomplete request; no billing proof',reservations,usd,processStopped:true});s.pending={};}
 s.stopped=false;return s;
}
export default function(pi){
 pi.registerFlag('bench-capture-file',{type:'string',description:'Owned wire/context captures'});
 pi.registerFlag('bench-budget-file',{type:'string',description:'Exclusive serial condition allocation'});
 const path=()=>pi.getFlag('bench-capture-file'),bp=()=>pi.getFlag('bench-budget-file');
 const record=d=>appendFileSync(path(),JSON.stringify({at:new Date().toISOString(),...d})+'\n');
 const load=()=>JSON.parse(readFileSync(bp(),'utf8')),save=s=>writeFileSync(bp(),JSON.stringify(s,null,2)+'\n');
 const meta=m=>({provider:m.provider,id:m.id,api:m.api,contextWindow:m.contextWindow,maxTokens:m.maxTokens,cost:m.cost});
 let sequence=0;const wrapped=new WeakSet();
 const selected=m=>m?.provider==='openrouter'&&m.id===load().modelId&&m.api==='openai-completions';
 function fail(ctx,error){const s=load();s.stopped=true;s.error=String(error);save(s);record({type:'admission_stopped',error:String(error)});ctx.abort();throw error;}
 function reserve(ctx,kind,output,calls=1){try{const s=load(),usd=reserveState(s,kind,output,calls);save(s);record({type:'catalog_reserved',kind,usd,calls,output,spentUsd:s.spentUsd});}catch(e){fail(ctx,e);}}
 function settle(ctx,kind,u){try{const s=load(),usd=settleState(s,kind,u);save(s);record({type:'catalog_settled',kind,computedCatalogUsd:usd,usage:u,spentUsd:s.spentUsd});}catch(e){fail(ctx,e);}}
 pi.on('session_start',async(_event,ctx)=>{
  try{
   assert(selected(ctx.model),'Unexpected route');const s=load();assert(!s.stopped,'Admission stopped');assert.equal(Object.keys(s.pending).length,0);
   const physical=ctx.modelRegistry.find('openrouter',s.modelId);assert(physical);assert.equal(physical.contextWindow,1050000);assertCatalogBinding(s,physical);
   assert(await pi.setModel({...physical,contextWindow:s.contextWindow}),'Public copied model selection failed');pi.setThinkingLevel('medium');assert.equal(ctx.model.contextWindow,s.contextWindow);assert.equal(ctx.thinkingLevel,'medium');
   const registry=ctx.modelRegistry;
   if(!wrapped.has(registry)){
    wrapped.add(registry);const original=registry.complete;
    registry.complete=async function(model,context,options){
     assert(selected(model),'Unexpected maintenance route');assert.equal(options?.reasoningEffort,'medium','Actual Nunc product must forward MEDIUM');
     const id=++sequence;record({type:'request',id,model:meta(model),context,options:{maxTokens:options?.maxTokens,maxRetries:options?.maxRetries,reasoningEffort:options?.reasoningEffort},taskLocalEffortAdapter:false});
     reserve(ctx,'nunc-maintenance',options.maxTokens);
     const onPayload=async(payload,chosen)=>{const replacement=await options?.onPayload?.(payload,chosen);const outbound=replacement===undefined?payload:replacement;assert.equal(outbound.reasoning?.effort,'medium');assert.equal(outbound.max_completion_tokens??outbound.max_tokens,options.maxTokens,'Serialized cap differs from actual resolved reserve');record({type:'serialized_maintenance',id,model:meta(chosen),payload:outbound});return replacement;};
     try{const response=await original.call(this,model,context,{...options,onPayload});record({type:'response',id,response});if(!['error','aborted'].includes(response.stopReason))settle(ctx,'nunc-maintenance',response.usage);return response;}catch(e){record({type:'error',id,error:String(e)});fail(ctx,e);}
    };
   }
   const auth=registry.getProviderAuthStatus('openrouter');assert(auth.configured);record({type:'capture_ready',pid:process.pid,model:meta(ctx.model),catalogModel:meta(physical),thinking:ctx.thinkingLevel,authConfigured:auth.configured,oauth:registry.isUsingOAuth(ctx.model),subscription:false,effectiveContextAdapter:true});
  }catch(e){fail(ctx,e);}
 });
 pi.on('before_provider_request',(event,ctx)=>{
  try{assert(selected(ctx.model));assert.equal(event.payload.reasoning?.effort,'medium');reserve(ctx,'main',event.payload.max_completion_tokens??event.payload.max_tokens);record({type:'serialized_session',model:meta(ctx.model),thinking:ctx.thinkingLevel,payload:event.payload});}catch(e){fail(ctx,e);}
 });
 pi.on('message_end',(event,ctx)=>{if(event.message.role!=='assistant')return;const m=event.message;record({type:'main_response',response:m});if(['error','aborted'].includes(m.stopReason))fail(ctx,new Error(m.errorMessage??m.stopReason));settle(ctx,'main',m.usage);});
 pi.on('session_before_compact',(_event,ctx)=>{if(load().arm!=='native')return;try{reserve(ctx,'native-maintenance',ctx.model.maxTokens,2);}catch(e){return {cancel:true};}});
 pi.on('session_compact',(event,ctx)=>{if(!event.fromExtension)settle(ctx,'native-maintenance',event.compactionEntry.usage);});
 pi.on('session_compact_failed',(event,ctx)=>fail(ctx,new Error(event.errorMessage??'Maintenance failed')));
}
