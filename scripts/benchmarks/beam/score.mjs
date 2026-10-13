// purpose: Use BEAM's published criterion judge prompt and mean score on blinded original probes.
// usage: node helpers/score.mjs <suite-root>
// effects: Suite-owned score/usage receipts; bounded OpenRouter judge calls via native auth owner.
// requires: Complete frozen answers; official upstream rubric and fixed protocol. No alternative metric.
import assert from 'node:assert/strict';
import {readFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {readJSON,writeJSON,record,installGuard,reconcile} from './guard.mjs';
import {assertBeamProtocol,assertBeamInputs} from '../remaining-selection.mjs';
import {recoveryScope,loadRecovery,assertRecoveryTarget} from './query-recovery.mjs';
export function parseJudge(text){let value=text.trim();if(value.startsWith('```')){const m=value.match(/```(?:json)?\s*(\[.*\]|\{.*\})\s*```/s);if(m)value=m[1].trim();}let result;try{result=JSON.parse(value);}catch{const m=value.match(/(\{.*?\}|\[.*?\])/s);assert(m,'No valid judge JSON');result=JSON.parse(m[1]);}assert(result&&typeof result==='object'&&[0,.5,1].includes(Number(result.score)),'Invalid rubric score');assert.equal(typeof result.reason,'string');return {...result,score:Number(result.score)};}
export function criterionMean(scores){assert(scores.length);return scores.reduce((n,x)=>n+x.score,0)/scores.length;}
export function judgePrompt(template,rubric,answer){return template.replaceAll('<rubric_item>',rubric).replaceAll('<llm_response>',answer);}
export function recoveryCoverage(scores,native){const categories=['instruction_following','knowledge_update','contradiction_resolution'];return {models:['Luna','Sol'].map(label=>{const available=scores.filter(s=>s.label===label&&s.status!=='missing_answer'),observed=available.filter(s=>s.status==='scored'),criteria=available.reduce((n,s)=>n+(s.criteriaScored??0),0);return {label,fullRequiredAnswers:12,fullRequiredCriteria:24,availableAnswers:available.length,scoredAnswers:observed.length,scoredCriteria:criteria,missingAnswers:12-available.length,missingCriteria:24-criteria};}),SolCase1:categories.map(category=>{const observed=scores.filter(s=>s.label==='Sol'&&s.case===1&&s.category===category&&s.status==='scored'),reference=native.filter(s=>s.label==='Sol'&&s.arm==='native'&&s.case===1&&s.category===category);return {category,requiredAnswers:2,observedAnswers:observed.length,currentMean:observed.length?criterionMean(observed.map(s=>({score:s.llm_judge_score}))):null,nativeMean:reference.length?criterionMean(reference.map(s=>({score:s.llm_judge_score}))):null};})};}
if(process.argv[1]&&resolve(process.argv[1])===resolve(new URL(import.meta.url).pathname)){
 assert(process.argv.length===3||process.argv.length===4&&process.argv[3]==='preflight','No judge resume/retry controls');
 const root=resolve(process.argv[2]),p=readJSON(join(root,'protocol.json')),recovery=p.scope===recoveryScope;let queryRoot=root;if(recovery){assertRecoveryTarget(root,loadRecovery(p.recoverySource));queryRoot=p.canonicalRoot;}else assertBeamProtocol(p);const queries=assertBeamInputs(queryRoot,p),dir=join(root,'judge');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'started.json'),'{}\n',{flag:'wx'});
 const budgetFile=join(dir,'budget.json'),model=p.models.Luna;if(recovery){const carry=readJSON(budgetFile);assert.equal(carry.allowanceUsd,1);assert.equal(carry.maxCalls,12);assert.deepEqual(carry.carried,{spentUsd:0,heldUnknownUsd:0,admissions:0});assert.deepEqual(carry.pending,{});}else writeJSON(budgetFile,{allowanceUsd:p.allocations_usd.judge,spentUsd:0,heldUnknownUsd:0,pending:{},admissions:0,receipts:0,unknownCalls:0,errors:[],maxReservedTotalUsd:0,model,maxCalls:p.limits.judge_calls,maxInflight:1});
 const runtime=await ModelRuntime.create();assert(runtime.hasConfiguredAuth('openrouter'));assert(!runtime.isUsingSubscription('openrouter'));assert(!runtime.isUsingOAuth('openrouter'));assert.deepEqual(runtime.getModel('openrouter',model.id).cost,model.cost);installGuard(runtime,budgetFile,join(dir,'capture.jsonl'),model.id,p.effective_context);
 if(process.argv[3]==='preflight'){writeJSON(join(dir,'status.json'),{state:'preflight_pass',admissions:0});}
 else{
 const template=readJSON(join(queryRoot,p.judge.prompt_file)),scores=[];
 try{
 for(const label of ['Luna','Sol'])for(const q of queries){
  const rubric=readJSON(join(queryRoot,`inputs/${q.case}/probing_questions.json`))[q.category][Number(q.id.split(':')[2])].rubric,answerFile=join(root,`run/${label}-nunc/case-${q.case}/answer-${q.id.replaceAll(':','-')}.json`);
  if((recovery&&(label!=='Sol'||q.case!==1))||!existsSync(answerFile)){scores.push({label,arm:'nunc',id:q.id,status:'missing_answer',criteriaExpected:rubric.length});continue;}
  const a=readJSON(answerFile);assert(!a.fixture,'Controlled edge answers cannot enter paid judge');assert.equal(a.status,'complete');assert.equal(a.label,label);assert.equal(a.arm,'nunc');assert.deepEqual(a.query,q);const judgments=[],failures=[];
  for(let index=0;index<rubric.length;index++){
   const file=join(dir,`${label}-nunc-${q.id.replaceAll(':','-')}-${index}.json`),prompt=judgePrompt(template,rubric[index],a.answer),start=Date.now(),controller=new AbortController();let response;
   const timer=setTimeout(()=>controller.abort(),p.limits.operation_ms);
   try{response=await runtime.complete({...model,contextWindow:p.effective_context},{messages:[{role:'user',content:prompt,timestamp:Date.now()}]},{maxTokens:p.judge.maxTokens,reasoningEffort:'medium',maxRetries:0,transport:'sse',cacheRetention:'none',signal:controller.signal});assert.equal(response.stopReason,'stop',response.errorMessage);const text=response.content.filter(b=>b.type==='text').map(b=>b.text).join('\n'),judgment=parseJudge(text);writeJSON(file,{status:'scored',judgment,prompt,response,elapsedMs:Date.now()-start,blinded:true});judgments.push(judgment);}
   catch(error){failures.push({index,error:String(error)});writeJSON(file,{status:'failed',prompt,response,error:String(error),elapsedMs:Date.now()-start,blinded:true});}
   finally{clearTimeout(timer);reconcile(budgetFile);}
  }
  scores.push({label,arm:'nunc',id:q.id,case:q.case,category:q.category,status:failures.length?'incomplete_judgment':'scored',criteriaExpected:rubric.length,criteriaScored:judgments.length,llm_judge_score:failures.length?null:criterionMean(judgments),llm_judge_responses:judgments,failures});writeJSON(join(root,'scores.json'),scores);
 }
 writeJSON(join(root,'scores.json'),scores);if(recovery)writeJSON(join(root,'coverage.json'),recoveryCoverage(scores,readJSON(join(p.canonicalRoot,'scores.json'))));writeJSON(join(dir,'status.json'),{state:scores.every(s=>s.status==='scored')?'complete':'partial_or_failed',budget:readJSON(budgetFile)});if(scores.some(s=>s.status!=='scored'))process.exitCode=1;
 }finally{reconcile(budgetFile);}
 }
}
/* Retained parser/prompt/mean above are unchanged. New paid entrypoint never resumes or grades native answers. */
