# purpose: Execute retained original MAB scorer on current unique answers; preserve official scores and separate punctuation caveat.
# usage: python3 helpers/score.py <suite-root> [test]
# effects: Offline suite score/summary files; no model calls or gold feedback.
# requires: Original AST functions and selected gold, current answer records.
import ast,json,re,string,sys
from pathlib import Path
root=Path(sys.argv[1]).resolve()
names={'normalize_answer','substring_exact_match_score','drqa_metric_max_over_ground_truths','parse_output'}
source=ast.parse((root/'inputs/official-scorer.py').read_text())
functions=[n for n in source.body if isinstance(n,ast.FunctionDef) and n.name in names]
assert {n.name for n in functions}==names
scope={'re':re,'string':string}
exec(compile(ast.Module(body=functions,type_ignores=[]),'official-scorer','exec'),scope)
metric=scope['substring_exact_match_score']
assert metric('THE red-bag.','redbag') and not metric('bluebag','redbag')
assert scope['parse_output']('Reasoning.\nAnswer: redbag\n')=='redbag'
assert scope['drqa_metric_max_over_ground_truths'](metric,'alias two',['alias one','alias two'])==1
assert metric("Fisher's", "Fisher's") and not metric('Fisher’s',"Fisher's")
if len(sys.argv)>2 and sys.argv[2]=='test':
 print(json.dumps({'officialParserMetricAliasAndPunctuationChecks':'passed'}));sys.exit(0)
def read(p):return json.loads(p.read_text())
def lines(p):return [json.loads(s) for s in p.read_text().split('\n') if s.strip()] if p.exists() else []
protocol=read(root/'protocol.json');scores=[];groups=[];costs=[];checkpoints=[];runtime=[];punctuation=[]
gold={}
original_cases=protocol['cases']
replacement_path=root/'event-replacement-protocol.json'
all_cases=original_cases+([read(replacement_path)['case']] if replacement_path.exists() else [])
for c in all_cases:
 for q in read(root/'inputs/cases'/c['caseId']/'gold.json'):gold[(c['caseId'],q['id'])]=q['answers']
for condition in protocol['conditions']:
 key=condition['key'];cwd=root/key;answers=lines(cwd/'answers.jsonl');state=read(cwd/'status.json');admission=read(cwd/'admission.json')
 seen=set();expected={(c['caseId'],q['id']) for c in all_cases for q in c['questions']}
 for a in answers:
  identity=(a['caseId'],a['id']);assert identity in expected and identity not in seen;seen.add(identity)
  assert a['response']['stopReason']=='stop'
  users=[e for e in a['queryEntries'] if e['type']=='message' and e['message']['role']=='user'];assert len(users)==1
  assert not any(e['type']=='compaction' for e in a['queryEntries'])
  assert a['querySessionFile']!=a['frozenSessionFile'];assert a['querySessionHeader']['parentSession']==a['frozenSessionFile']
  parsed=scope['parse_output'](a['answer']) or '';expected_gold=gold[identity]
  correct=bool(scope['drqa_metric_max_over_ground_truths'](metric,parsed,expected_gold))
  item={'condition':key,'modelName':condition['modelName'],'arm':condition['arm'],'caseId':a['caseId'],'id':a['id'],'index':a['index'],'correct':correct,'parsed':parsed,'gold':expected_gold}
  scores.append(item)
  alternate=parsed.translate(str.maketrans({'’':"'",'‘':"'",'“':'"','”':'"'}))
  if not correct and scope['drqa_metric_max_over_ground_truths'](metric,alternate,expected_gold):punctuation.append(item)
 if state['state']=='completed':assert seen==expected
 for c in all_cases:
  items=[s for s in scores if s['condition']==key and s['caseId']==c['caseId']]
  groups.append({'condition':key,'caseId':c['caseId'],'correct':sum(s['correct'] for s in items) if items else None,'answered':len(items),'required':20,'complete':len(items)==20,'accuracy':sum(s['correct'] for s in items)/len(items) if items else None,'missing':20-len(items)})
 cost={'condition':key,**admission,'state':state['state'],'pendingUsd':sum(p['usd'] for p in admission['pending'].values())};costs.append(cost)
 events=lines(cwd/'events.jsonl');checkpoints.extend({'condition':key,**e} for e in events if e['type']=='checkpoint')
 records=[]
 for h in ['factconsolidation_sh_64k','eventqa_65536']+([read(replacement_path)['case']['caseId']] if replacement_path.exists() else []):
  records+=lines(cwd/f"{condition['arm']}-{h}"/'extraction.jsonl')
 main=[e for e in records if e['type']=='serialized_session'];req=[e for e in records if e['type']=='request'];wire=[e for e in records if e['type']=='serialized_maintenance']
 for e in main+wire:assert e['payload']['reasoning']['effort']=='medium'
 for e in req:
  assert e['options']['reasoningEffort']=='medium' and not e['taskLocalEffortAdapter']
  messages=e['context']['messages']
  body='\n'.join(m['content'] if isinstance(m['content'],str) else '\n'.join(b['text'] for b in m['content'] if b['type']=='text') for m in messages)
  assert not any(q['prompt'] in body for c in all_cases for q in c['questions'])
 receipt_usage=[e['response']['usage'] for e in records if e['type'] in ['main_response','response']]+[e['usage'] for e in events if e['type']=='usage' and condition['arm']=='native' and ':maintenance:' in e['label']]
 runtime.append({'authoritativeReceiptUsageIncludingFailures':{k:sum(u.get(k,0) or 0 for u in receipt_usage) for k in ['input','cacheRead','cacheWrite','output','reasoning']},'receiptCountIncludingFailures':len(receipt_usage),'zeroUsageErrorsDoNotProveNoBilling':True,'condition':key,'state':state['state'],'mainSerializedCount':len(main),'nuncMaintenanceRequests':len(req),'nuncSerializedCount':len(wire),'successfulCheckpoints':sum(e['type']=='checkpoint' for e in events),'completedHistories':state['completed'],'observedUsageRecordsIncludingFailed':len([e for e in events if e['type']=='usage']),'usageTotals':{k:sum(e['usage'].get(k,0) or 0 for e in events if e['type']=='usage') for k in ['input','cacheRead','cacheWrite','output','reasoning']},'qaMeanMs':sum(a['elapsedMs'] for a in answers)/len(answers) if answers else None})
status='completed' if all(g['complete'] for g in groups) and all(c['state']=='completed' for c in costs) else 'partial_or_blocked'
original_groups=[g for g in groups if g['caseId'] in {c['caseId'] for c in original_cases}]
replacement_groups=[g for g in groups if g not in original_groups]
missing=[{'condition':c['key'],'caseId':case['caseId'],'id':q['id']} for c in protocol['conditions'] for case in all_cases for q in case['questions'] if not any(s['condition']==c['key'] and s['caseId']==case['caseId'] and s['id']==q['id'] for s in scores)]
report={'status':status,'groups':groups,'originalGroups':original_groups,'replacementGroups':replacement_groups,'originalRequired':sum(len(c['questions']) for c in original_cases)*len(protocol['conditions']),'originalAnswered':sum(g['answered'] for g in original_groups),'replacementRequired':80 if replacement_groups else 0,'replacementAnswered':sum(g['answered'] for g in replacement_groups),'missingAnswers':missing,'cost':{'catalogReportedUsd':sum(c['spentUsd'] for c in costs),'heldUnknownUsd':sum(c['heldUnknownUsd'] for c in costs),'pendingUsd':sum(c['pendingUsd'] for c in costs),'exclusiveCapUsd':protocol['budgetUsd'],'actualBillUnknown':True,'conditions':costs},'runtime':runtime,'punctuationSensitivity':punctuation,'knownGoldCaveats':['SH no18 gold Tom Clancy conflicts with latest fact1219 Torquato Tasso.','MH no5 gold London conflicts with later3498 Washington,D.C. along inspected chain.','MH no6 gold South America conflicts with later4004 Asia along inspected chain.','MH no19 country question has a person-name gold; interpretation ambiguous.'],'interpretation':['Single frozen first20 SH/MH subsets, one Fact formation shared per condition; no Event or native rerun.','Manual compaction after chunks8/17 and effective272K pressure; not default1.05M behavior.','Actual retained K and M unequal; scores are official gold compatibility, no retrospective adjustments.','Main and maintenance MEDIUM paired; observer forwards no reasoning effort. Native unchanged installed flow plus MEDIUM state is bounded proof, native wire not directly intercepted.']}
(root/'scores.json').write_text(json.dumps({'groups':groups,'scores':scores},ensure_ascii=False,indent=2)+'\n')
(root/'summary.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
(root/'checkpoints.json').write_text(json.dumps(checkpoints,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'status':status,'groups':groups,'cost':{k:v for k,v in report['cost'].items() if k!='conditions'}},indent=2))
