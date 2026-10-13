// purpose: Format only current official query and first-round public base plan for the actual runner.
// usage: buildPrompt(templates,input,currentQuestion)
// effects: None; future queries and gold are excluded.
// requires: Official frozen templates and input object.
export function formatPlan(name,plans){return `=== ${name}'s Plan ===\n`+plans.map(d=>`Day ${d.day??d.days}:\n`+[['Current City','current_city'],['Transportation','transportation'],['Breakfast','breakfast'],['Attraction','attraction'],['Lunch','lunch'],['Dinner','dinner'],['Accommodation','accommodation']].map(([label,key])=>`${label}: ${d[key]??'-'}`).join('\n')).join('\n\n');}
export function format(t,values){return t.replace(/\{(\w+)\}/g,(all,key)=>key in values?values[key]:all);}
export function buildPrompt(templates,input,q){
 const prefix=q.round_idx===1?format(templates.BASE_PERSON_TEMPLATE,{base_name:input.base_person.name,base_query:input.base_person.query,base_plan:formatPlan(input.base_person.name,input.base_person.daily_plans)})+'\n\n':'';
 return prefix+format(templates.AGENT_USER_PROMPT_TEMPLATE,{name:q.name,query:q.query});
}
