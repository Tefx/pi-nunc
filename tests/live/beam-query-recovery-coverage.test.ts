import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {repository} from './fixtures.js';
test('query-only coverage retains12/24 full denominators, partial judgments and matching original case1 means',async()=>{
 const {recoveryCoverage}=await import(join(repository,'scripts/benchmarks/beam/score.mjs'));const scores=[{label:'Sol',case:1,category:'instruction_following',status:'scored',criteriaScored:2,llm_judge_score:.5},{label:'Sol',case:1,category:'instruction_following',status:'incomplete_judgment',criteriaScored:1,llm_judge_score:null},{label:'Luna',status:'missing_answer',criteriaExpected:2}];const native=[{label:'Sol',arm:'native',case:1,category:'instruction_following',llm_judge_score:1},{label:'Sol',arm:'native',case:2,category:'instruction_following',llm_judge_score:0}];const report=recoveryCoverage(scores,native);assert.deepEqual(report.models[1],{label:'Sol',fullRequiredAnswers:12,fullRequiredCriteria:24,availableAnswers:2,scoredAnswers:1,scoredCriteria:3,missingAnswers:10,missingCriteria:21});assert.equal(report.models[0].missingAnswers,12);assert.equal(report.models[0].missingCriteria,24);assert.equal(report.SolCase1[0].currentMean,.5);assert.equal(report.SolCase1[0].nativeMean,1);assert.equal(report.SolCase1[1].currentMean,null);
});
