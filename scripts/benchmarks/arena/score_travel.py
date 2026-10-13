# purpose: Run upstream Travel slot metrics plus exact entity/completeness and explicitly declared selected-query constraint checks.
# usage: python helpers/score_travel.py <absolute-task-root> preflight|score [scoring-source-directory]
# effects: Task-local JSON evidence only; preflight checks hidden gold offline before any candidate run, never exposes it to Pi.
# requires: Python3 stdlib, pinned upstream eval.py, selected input/gold, official CSV; selected_constraints.py.
import ast,csv,difflib,json,math,re,sys,unicodedata
from pathlib import Path
from selected_constraints import RULES
ROOT=Path(sys.argv[1]).resolve(); UP=Path(sys.argv[3]).resolve() if len(sys.argv)>3 else ROOT/'runtime/MemoryArena/env/env_systems/travel_planner_env'
if not (UP/'eval.py').exists():UP=ROOT/'score-inputs'
SLOTS=['breakfast','lunch','dinner','accommodation','transportation','attraction']; ALL=['current_city']+SLOTS
names={'similarity','get_day','find_constraint_slots','check_slot_pass','check_person_full_pass'}
tree=ast.parse((UP/'eval.py').read_text());scope={'difflib':difflib,'SIM_TH':.7,'SLOTS':SLOTS}
funcs=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names];assert len(funcs)==len(names)
exec(compile(ast.Module(body=funcs,type_ignores=[]),'upstream-travel-eval','exec'),scope)
def load(p):return json.loads(p.read_text())
def norm(s):return ' '.join(unicodedata.normalize('NFKC',str(s)).replace('’',"'").strip().casefold().split())
def city_norm(s):return norm(str(s).split('(',1)[0])  # Official annotation helper removes state qualifiers.
def tokens(s):return {norm(x) for x in re.split(r'[,;&]',str(s)) if norm(x)}
def rows(path):
 with path.open(newline='') as f:return list(csv.DictReader(f))
rest=rows(UP/'database/restaurants/clean_restaurant_2022.csv');hotels=rows(UP/'database/accommodations/clean_accommodations_2022.csv')
CAT=[]
for x in rest:
 try:CAT.append({'kind':'restaurant','name':x['Name'],'city':x['City'],'price':float(x['Average Cost']),'rating':float(x['Aggregate Rating']),'cuisines':tokens(x['Cuisines'])})
 except (ValueError,KeyError):pass
for x in hotels:
 try:CAT.append({'kind':'accommodation','name':x['NAME'],'city':x['city'],'price':float(x['price']),'rating':float(x['review rate number']),'room_type':norm(x['room type']),'rules':tokens(x['house_rules']),'occupancy':float(x['maximum occupancy'])})
 except (ValueError,KeyError):pass
for a in CAT:a['identity']=(a['kind'],norm(a['name']),norm(a['city']))
ATTRACTIONS={(norm(x['Name']),city_norm(x['City'])) for x in rows(UP/'database/attractions/attractions.csv')}
FLIGHT_IDS={x['Flight Number'] for x in load(ROOT/'flight-inventory.json')['rows']}
def invariant_catalog(base_day,actual_day):
 checks=[]
 for slot in ['transportation','attraction','current_city']:
  b=base_day.get(slot,'-');a=actual_day.get(slot,'')
  # New queries request no changes in these fields. Validate source entities and inherited identity separately.
  source_valid=True
  if slot=='transportation' and 'Flight Number:' in b:source_valid=all(i in FLIGHT_IDS for i in re.findall(r'Flight Number: (F\d+)',b))
  if slot=='attraction' and b!='-':
   entities=[x.strip() for x in b.split(';') if x.strip()]
   source_valid=all((norm(x.rsplit(',',1)[0]),city_norm(x.rsplit(',',1)[-1])) in ATTRACTIONS for x in entities)
  checks.append({'day':base_day.get('day') or base_day.get('days'),'slot':slot,'sourceCatalogValid':source_valid,'preservedUnchangedField':norm(a)==norm(b),'valid':source_valid and norm(a)==norm(b)})
 return checks
def entity(text,kind,city=None):
 parts=str(text).rsplit(',',1); supplied_name=parts[0];supplied_city=parts[1] if len(parts)==2 else None
 matches=[a for a in CAT if a['kind']==kind and (city is None or city_norm(a['city'])==city_norm(city)) and norm(supplied_name)==norm(a['name']) and (supplied_city is None or city_norm(supplied_city)==city_norm(a['city']))]
 unique={a['identity']:a for a in matches}
 return next(iter(unique.values())) if len(unique)==1 else None

def day(plan,d):return next((p for p in plan if (p.get('day') or p.get('days'))==d),{})
def check_rule(rule,name,plans,base):
 slot=rule['slot'];d=rule['day'];kind='accommodation' if slot=='accommodation' else 'restaurant'
 base_text=day(base,d).get(slot,'');expected_city=base_text.rsplit(',',1)[-1].strip() if ',' in base_text else None
 actual=entity(day(plans.get(name,[]),d).get(slot,''),kind,expected_city)
 checks={'exact_catalog_entity_in_trip_city':actual is not None}
 ref=rule.get('reference') or rule.get('same');other=None
 if ref:
  other=entity(day(plans.get(ref[0],[]),ref[1]).get(ref[2],''),'accommodation' if ref[2]=='accommodation' else 'restaurant')
  checks['reference_entity_available']=other is not None
 if actual is None or (ref and other is None):return checks
 eps=1e-8
 if 'same' in rule:checks['same_entity']=actual['identity']==other['identity']
 for k,v in rule.items():
  if k in {'day','slot','reference','same'}:continue
  if k in {'price','rating'}:ok=v[0]-eps<=actual[k]<=v[1]+eps
  elif k=='cuisines':ok={norm(t) for t in v}<=actual.get('cuisines',set())
  elif k=='rules':ok={norm(t) for t in v}<=actual.get('rules',set())
  elif k=='room_type':ok=actual.get(k)==norm(v)
  elif k=='occupancy_min':ok=actual.get('occupancy',0)>=v
  elif k=='shared_rules':ok={norm(t) for t in v}<=actual.get('rules',set()) and {norm(t) for t in v}<=other.get('rules',set())
  elif k=='shared_any_rule':ok=bool(actual.get('rules',set())&other.get('rules',set()))
  elif k=='shared_any_cuisine':ok=bool(actual.get('cuisines',set())&other.get('cuisines',set()))
  elif k=='all_reference_cuisines':ok=other.get('cuisines',set())<=actual.get('cuisines',set())
  elif k=='room_relation':ok=(actual['room_type']==other['room_type'])==(v=='same')
  elif k in {'price_relation','rating_relation'}:
   field=k.split('_')[0];a,b=actual[field],other[field];ok={'gt':a>b+eps,'lt':a<b-eps,'ge':a+eps>=b}[v]
  elif k=='rating_within':ok=abs(actual['rating']-other['rating'])<=v+eps
  elif k=='price_within_absolute':ok=abs(actual['price']-other['price'])<=v+eps
  elif k=='price_within_ratio':ok=abs(actual['price']-other['price'])<=v*other['price']+eps
  elif k=='price_min_ratio':ok=actual['price']+eps>=v*other['price']
  elif k=='price_max_ratio':ok=actual['price']<=v*other['price']+eps
  elif k=='price_min_delta':ok=actual['price']+eps>=other['price']+v
  elif k=='price_max_delta':ok=actual['price']<=other['price']+v+eps
  else:raise AssertionError('Unhandled constraint '+k)
  checks[k]=ok
 return checks

def parse_plans(text):
 # Same named-plan/day boundaries as upstream; keep last declaration per traveler.
 out={};parts=re.split(r"===\s*([^=]+?)'s Plan\s*===",text)
 for i in range(1,len(parts),2):
  ds=[]
  for m in re.finditer(r'Day\s*(\d+):(.*?)(?=Day\s*\d+:|$)',parts[i+1],re.S):
   item={'day':int(m[1])}
   for line in m[2].strip().splitlines():
    if ':' in line:k,v=line.split(':',1);item[k.strip().lower().replace(' ','_')]=v.strip()
   ds.append(item)
  out[parts[i].strip()]=ds
 return out

def evaluate_group(g,plans,answered_names=None):
 inp=load(ROOT/f'cases/{g}/input.json');gold=load(ROOT/f'cases/{g}/gold.json');base=inp['base_person'];full={base['name']:base['daily_plans'],**plans}
 gt={(g,a['round_idx']):a['daily_plans'] for a in gold['answers']};base_plans={g:base['daily_plans']}
 people=[]
 for q in inp['questions']:
  n=q['name']
  if answered_names is not None and n not in answered_names:continue
  p=plans.get(n,[]);expected=gt[(g,q['round_idx'])]
  exact_days=sorted(x.get('day') or x.get('days') for x in p)==sorted(x.get('day') or x.get('days') for x in expected)
  complete=exact_days and all(all(k in day(p,d.get('day') or d.get('days')) for k in ALL) for d in expected)
  fuzzy=scope['check_person_full_pass'](expected,p)
  changed=scope['find_constraint_slots'](gt,base_plans,g,q['round_idx'])
  constraint_rate=sum(scope['check_slot_pass'](expected,p,d,s) for d,s in changed)/len(changed) if changed else None
  strict=sum(norm(day(p,d.get('day') or d.get('days')).get(s,''))==norm(d.get(s,'-')) for d in expected for s in SLOTS)
  catalog=[];invariants=[]
  for bd in base['daily_plans']:
   d=bd.get('day') or bd.get('days')
   invariants.extend(invariant_catalog(bd,day(p,d)))
   for slot in ['breakfast','lunch','dinner','accommodation']:
    text=day(p,d).get(slot,'');bt=bd.get(slot,'-');city=bt.rsplit(',',1)[-1].strip() if ',' in bt else None
    ok=norm(text)=='-' if norm(bt)=='-' else entity(text,'accommodation' if slot=='accommodation' else 'restaurant',city) is not None
    catalog.append({'day':d,'slot':slot,'valid':ok})
  rules=[{'rule':r,'checks':check_rule(r,n,full,base['daily_plans'])} for r in RULES[(g,n)]]
  people.append({'name':n,'round':q['round_idx'],'complete':complete,'catalogSlots':catalog,'invariantInventory':invariants,'officialPersonPass':bool(fuzzy),'officialConstraintRate':constraint_rate,'strictGoldSlots':strict,'goldSlots':len(expected)*len(SLOTS),'explicitRules':rules,'explicitPass':complete and all(x['valid'] for x in catalog+invariants) and all(all(x['checks'].values()) for x in rules)})
 complete_observation=answered_names is None or len(people)==len(inp['questions'])
 return {'group':g,'people':people,'officialGroupPass':all(p['officialPersonPass'] for p in people) if complete_observation else None,'expectedPeople':len(inp['questions']),'missingPeople':[q['name'] for q in inp['questions'] if answered_names is not None and q['name'] not in answered_names]}

def aggregate(groups):
 people=[p for g in groups for p in g['people']];rules=[r for p in people for r in p['explicitRules']]
 sps=[sum(v)/len(v) for g in groups if (v:=[p['officialConstraintRate'] for p in g['people'] if p['officialConstraintRate'] is not None])]
 observed_groups=[g for g in groups if g['officialGroupPass'] is not None]
 return {'expectedPeople':sum(g.get('expectedPeople',len(g['people'])) for g in groups),'evaluatedPeople':len(people),'completePeople':sum(p['complete'] for p in people),'PS':100*sum(p['officialPersonPass'] for p in people)/len(people) if people else None,'SPS':100*sum(sps)/len(sps) if sps else None,'SR':100*sum(g['officialGroupPass'] for g in observed_groups)/len(observed_groups) if observed_groups else None,'strictGoldSlots':sum(p['strictGoldSlots'] for p in people),'goldSlots':sum(p['goldSlots'] for p in people),'validMealAccommodationSlots':sum(x['valid'] for p in people for x in p['catalogSlots']),'mealAccommodationSlots':sum(len(p['catalogSlots']) for p in people),'validInvariantSlots':sum(x['valid'] for p in people for x in p['invariantInventory']),'invariantSlots':sum(len(p['invariantInventory']) for p in people),'explicitPassingRules':sum(all(r['checks'].values()) for r in rules),'explicitRules':len(rules),'explicitPassingPeople':sum(p['explicitPass'] for p in people)}

assert scope['similarity']('Hotel A','Hotel B')>=.7 and norm('Hotel A')!=norm('Hotel B')
assert not evaluate_group(load(ROOT/'protocol.json')['groups'][0],{})['people'][0]['complete']
mode=sys.argv[2]
if mode=='preflight':
 groups=[]
 for g in load(ROOT/'protocol.json')['groups']:
  inp=load(ROOT/f'cases/{g}/input.json');gold=load(ROOT/f'cases/{g}/gold.json')
  assert all((g,q['name']) in RULES for q in inp['questions'])
  groups.append(evaluate_group(g,{q['name']:a['daily_plans'] for q,a in zip(inp['questions'],gold['answers'])}))
 # Meaningful negative check: an existing in-city restaurant with the wrong price must fail the actual explicit price predicate.
 selected=load(ROOT/'protocol.json')['groups']
 g,n,rule=next((g,q['name'],r) for g in selected for q in load(ROOT/f'cases/{g}/input.json')['questions'] for r in RULES[(g,q['name'])] if 'price' in r and r['slot']!='accommodation')
 first=load(ROOT/f'cases/{g}/input.json');gold1=load(ROOT/f'cases/{g}/gold.json');bad={q['name']:json.loads(json.dumps(a['daily_plans'])) for q,a in zip(first['questions'],gold1['answers'])}
 city=day(first['base_person']['daily_plans'],rule['day'])[rule['slot']].rsplit(',',1)[-1].strip()
 wrong=next(a for a in CAT if a['kind']=='restaurant' and a['city']==city and not rule['price'][0]<=a['price']<=rule['price'][1])
 day(bad[n],rule['day'])[rule['slot']]=wrong['name']+', '+wrong['city']
 negative=check_rule(rule,n,bad,first['base_person']['daily_plans']);assert negative['exact_catalog_entity_in_trip_city'] and negative['price'] is False
 report={'mode':'hidden-gold preflight, no candidate call','mechanicalChecks':{'officialFuzzyAcceptsDifferentEntity':True,'missingPersonRejected':True,'realCatalogWrongPriceRejected':negative['price'] is False},'aggregate':aggregate(groups),'groups':groups}
 (ROOT/'gold-preflight.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
 print(json.dumps({'aggregate':report['aggregate'],'failedRules':[{'group':g['group'],'name':p['name'],**r} for g in groups for p in g['people'] for r in p['explicitRules'] if not all(r['checks'].values())]},ensure_ascii=False))
elif mode=='score':
 records=[json.loads(l) for l in (ROOT/'run/answers.jsonl').read_text().splitlines()] if (ROOT/'run/answers.jsonl').exists() else []
 remaining=load(ROOT/'protocol.json').get('scope')=='remaining-defaults-v1'
 report={}
 for arm in [load(ROOT/'protocol.json')['arm']]:
  groups=[]
  for g in load(ROOT/'protocol.json')['groups']:
   answers=[a for a in records if a['arm']==arm and a['group']==g];expected=load(ROOT/f'cases/{g}/input.json')['questions']
   if remaining:
    observed=[(a['round'],a['name']) for a in answers];allowed=[(q['round_idx'],q['name']) for q in expected]
    assert len(set(observed))==len(observed) and all(x in allowed for x in observed),'Duplicate or unselected answer'
   else:assert len(answers)==len(expected) and [a['round'] for a in answers]==[q['round_idx'] for q in expected], 'Missing/duplicate executed round'
   plans=parse_plans('\n\n'.join(a['answer'] for a in answers));groups.append(evaluate_group(g,plans,{a['name'] for a in answers} if remaining else None))
  report[arm]={'aggregate':aggregate(groups),'groups':groups}
 (ROOT/'scores.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps({a:r['aggregate'] for a,r in report.items()}))
else:raise AssertionError(mode)
