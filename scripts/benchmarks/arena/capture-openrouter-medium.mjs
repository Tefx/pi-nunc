// purpose: Observe real product thinking on accepted OpenRouter/effective272K sessions and $5 task-local catalog admission.
// usage: Existing Pi observer with --bench-capture-file and --bench-budget-file owned paths.
// effects: Session-local public setModel; native request delegation; owned captures/catalog reservations. No credentials/global/source changes.
// requires: Pi1.1 public model/session/events; serial sessions; native compaction at most two subcalls with retries disabled.
import assert from 'node:assert/strict';
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
export default function(pi){
 pi.registerFlag('bench-capture-file',{type:'string',description:'Owned original request/response observations'});
 pi.registerFlag('bench-budget-file',{type:'string',description:'Owned serial-session catalog admission state'});
 const path=()=>pi.getFlag('bench-capture-file'),bp=()=>pi.getFlag('bench-budget-file');
 const record=data=>appendFileSync(path(),JSON.stringify({at:new Date().toISOString(),...data})+'\n');
 const load=()=>JSON.parse(readFileSync(bp(),'utf8')),save=s=>writeFileSync(bp(),JSON.stringify(s,null,2)+'\n');
 const meta=m=>({provider:m.provider,id:m.id,api:m.api,contextWindow:m.contextWindow,maxTokens:m.maxTokens});
 const selected=m=>m?.provider==='openrouter'&&['openai/gpt-6.1-sol','openai/gpt-6-luna'].includes(m.id)&&m.api==='openai-completions';
 let rates,rateTable;
 const worstInput=()=>Math.max(...rateTable.flatMap(r=>[r.input,r.cacheRead,r.cacheWrite]));
 const worstOutput=()=>Math.max(...rateTable.map(r=>r.output));
 let native=false,sequence=0;
 function fail(ctx,error){const s=load();s.stopped=true;s.error=String(error);save(s);record({type:'admission_stopped',error:String(error)});ctx.abort();throw error;}
 function reserve(ctx,kind,output=128000,calls=1){
  try{const s=load();assert(!s.stopped,'Catalog admission already stopped');assert(!Object.keys(s.pending).length,'Previous request not reconciled');assert(Number.isInteger(output)&&output>0&&output<=128000,'Invalid outbound output ceiling');
   // Worst catalog input/cache-write rate within effective272K; native split compaction may issue two requests.
   const usd=calls*(272000*worstInput()+output*worstOutput())/1e6;assert(s.spentUsd+(s.heldUnknownUsd??0)+usd<s.allowanceUsd,`Cumulative OpenRouter admission >=${s.allowanceUsd}: ${s.spentUsd} + held ${s.heldUnknownUsd??0} + ${usd}`);
   s.pending[kind]={usd,calls,output};s.admissions++;s.maxReservedTotalUsd=Math.max(s.maxReservedTotalUsd,s.spentUsd+(s.heldUnknownUsd??0)+usd);save(s);record({type:'catalog_reserved',kind,usd,calls,output,spentUsd:s.spentUsd});
  }catch(e){fail(ctx,e);}
 }
 function settle(ctx,kind,u){
  try{const s=load(),p=s.pending[kind];assert(p,`Missing ${kind} reservation`);assert(u&&[u.input,u.output,u.cacheRead,u.cacheWrite].every(n=>Number.isFinite(n)&&n>=0)&&u.input+u.output+u.cacheRead+u.cacheWrite>0,'Missing or zero usage; reservation remains unknown');
   const used=u.input+u.cacheRead+u.cacheWrite;
   const actualRates=[...rateTable].reverse().find(r=>used>(r.inputTokensAbove??-1))??rates;
   const usd=(u.input*actualRates.input+u.output*actualRates.output+u.cacheRead*actualRates.cacheRead+u.cacheWrite*actualRates.cacheWrite)/1e6;assert(usd<=p.usd+1e-8,'Observed cost exceeds reservation');s.spentUsd+=usd;assert(s.spentUsd+(s.heldUnknownUsd??0)<s.allowanceUsd);delete s.pending[kind];s.receipts++;save(s);record({type:'catalog_settled',kind,computedCatalogUsd:usd,sdkCatalogUsd:u.cost?.total??null,spentUsd:s.spentUsd});
  }catch(e){fail(ctx,e);}
 }
 pi.on('session_start',async(_event,ctx)=>{
  try{assert(selected(ctx.model),'Unexpected route');const catalog=ctx.model;assert(catalog.contextWindow>=272000);assert.equal(catalog.maxTokens,128000);
   rates=catalog.cost;rateTable=[rates,...(rates?.tiers??[])];assert(rates&&rateTable.every(r=>[r.input,r.output,r.cacheRead,r.cacheWrite].every(Number.isFinite)));
   record({type:'catalog',model:{...meta(catalog),cost:catalog.cost},authConfigured:ctx.modelRegistry.getProviderAuthStatus('openrouter').configured});
   assert(await pi.setModel({...catalog,contextWindow:272000}),'Public session-local model selection failed');pi.setThinkingLevel('medium');assert.equal(ctx.model.contextWindow,272000);assert.equal(ctx.thinkingLevel,'medium');
   // Nunc tools are disabled; extension presence is instead supplied by the profile name.
   native=!ctx.cwd.split('/').at(-1).startsWith('nunc-');
   const registry=ctx.modelRegistry,original=registry.complete;assert.equal(typeof original,'function');
   registry.complete=async function(model,context,options){
    assert(selected(model),'Unexpected raw maintenance route');const id=++sequence;
    if(options?.reasoningEffort!==undefined&&options.reasoningEffort!=='medium')fail(ctx,new Error('Conflicting explicit maintenance effort'));
    if(options?.reasoning!==undefined&&options.reasoning!=='medium')fail(ctx,new Error('Conflicting explicit maintenance reasoning'));
    assert.equal(options?.reasoningEffort,'medium','Product must forward protocol MEDIUM; observer supplies no effort');
    const adapted=options;
    record({type:'request',id,model:meta(model),context,options:{maxTokens:adapted.maxTokens,maxRetries:adapted.maxRetries,cacheRetention:adapted.cacheRetention,transport:adapted.transport,reasoningEffort:adapted.reasoningEffort},taskLocalEffortAdapter:false,productForwardedReasoningEffort:options?.reasoningEffort??null});
    reserve(ctx,'nunc-maintenance',adapted.maxTokens);
    const onPayload=async(payload,chosen)=>{const replacement=await options?.onPayload?.(payload,chosen);const outbound=replacement===undefined?payload:replacement;assert.equal(outbound.reasoning?.effort,'medium');assert.equal(outbound.max_completion_tokens??outbound.max_tokens,adapted.maxTokens,'Serialized cap differs from actual resolved reserve');record({type:'serialized_maintenance',id,model:meta(chosen),payload:outbound});return replacement;};
    try{const response=await original.call(this,model,context,{...adapted,onPayload});record({type:'response',id,response});assert.equal(response.stopReason,'stop',response.errorMessage??'Maintenance error');settle(ctx,'nunc-maintenance',response.usage);return response;}
    catch(e){record({type:'error',id,error:String(e)});fail(ctx,e);}
   };
   const auth=registry.getProviderAuthStatus('openrouter');record({type:'capture_ready',pid:process.pid,model:meta(ctx.model),catalogContextWindow:catalog.contextWindow,thinking:ctx.thinkingLevel,oauth:registry.isUsingOAuth(ctx.model),subscription:false,authConfigured:auth.configured,effectiveContextAdapter:true});
  }catch(e){fail(ctx,e);}
 });
 pi.on('before_provider_request',(event,ctx)=>{
  try{assert(selected(ctx.model));assert.equal(event.payload.reasoning?.effort,'medium');reserve(ctx,'main',event.payload.max_completion_tokens??event.payload.max_tokens);record({type:'serialized_session',model:meta(ctx.model),thinking:ctx.thinkingLevel,payload:event.payload});}
  catch(e){fail(ctx,e);}
 });
 pi.on('message_end',(event,ctx)=>{if(event.message.role!=='assistant')return;const m=event.message;if(['error','aborted'].includes(m.stopReason))fail(ctx,new Error(m.errorMessage??m.stopReason));settle(ctx,'main',m.usage);});
 pi.on('session_before_compact',(_event,ctx)=>{
  if(!native)return;try{reserve(ctx,'native-maintenance',128000,2);}catch(e){return {cancel:true};}
 });
 pi.on('session_compact',(event,ctx)=>{if(!event.fromExtension)settle(ctx,'native-maintenance',event.compactionEntry.usage);});
 pi.on('session_compact_failed',(event,ctx)=>fail(ctx,new Error(event.errorMessage??'Maintenance failed or aborted')));
}
