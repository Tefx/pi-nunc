# purpose: Execute the exact published BEAM parser/scorer against deterministic judge receipts without LIGHT dependencies.
# usage: python3 helpers/check-official-scoring.py
# effects: None beyond stdout; no provider calls, download, or repository edits.
# requires: Pinned upstream/compute_metrics.py and JSON/re standard library.
import ast,json,re,sys
from pathlib import Path
r=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else Path(__file__).resolve().parents[1]
tree=ast.parse((r/'upstream/compute_metrics.py').read_text())
names={'parse_json_response','evaluate_instruction_following','evaluate_knowledge_update','evaluate_contradiction_resolution'}
subset=ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names],type_ignores=[])
ns={'json':json,'re':re,'unified_llm_judge_base_prompt':json.loads((r/'upstream/judge-prompt.json').read_text())}
exec(compile(subset,'pinned-official-scorer','exec'),ns)
class Judge:
 def __init__(self):self.calls=[];self.scores=iter([1,.5,0])
 def invoke(self,prompt):
  self.calls.append(prompt)
  class Response:pass
  response=Response();response.content=json.dumps({'score':next(self.scores),'reason':'deterministic receipt'});return response
for name in names-{'parse_json_response'}:
 judge=Judge();rubric=['criterion A','criterion B','criterion C'];result=ns[name](rubric,'candidate answer','unused official question',judge)
 assert result['llm_judge_score']==.5
 assert len(judge.calls)==3 and len(result['llm_judge_responses'])==3
 assert judge.calls==[ns['unified_llm_judge_base_prompt'].replace('<rubric_item>',item).replace('<llm_response>','candidate answer') for item in rubric]
assert ns['parse_json_response']('```json\n{"score":0.5,"reason":"partial"}\n```')['score']==.5
print('Exact upstream parser and all three required criterion-mean scorers executed; 3x3 deterministic judge receipts, mean 0.5; no model calls.')
