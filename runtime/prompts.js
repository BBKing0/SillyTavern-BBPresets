import {assert,copy} from '../core/model.js';
import {parseModelJSON} from '../core/json.js';
import {PROMPTS,promptText} from '../core/prompt-templates.js';
import {chooseOutline} from '../core/outline.js';

export const INITIALIZATION_TEMPLATE=PROMPTS.questions.text;
export function parseQuestions(raw) {
    const data=parseModelJSON(raw,'初始化提问');
    assert(data&&Array.isArray(data.questions)&&data.questions.length>=2&&data.questions.length<=3,'初始化应返回 2—3 个问题，请重试');
    for(const q of data.questions)assert(q&&typeof q.question==='string'&&q.question.trim()&&q.question.length<=160&&typeof q.example==='string'&&q.example.trim()&&q.example.length<=160,'初始化问题或示例过长/缺失，请重试');
    return data.questions.map(q=>({question:q.question.trim(),example:q.example.trim()}));
}
export function parseChanges(raw) {
    const result=parseModelJSON(raw,'维护响应');
    assert(result&&Array.isArray(result.changes)&&result.changes.length<=100,'响应必须包含 changes 数组');
    for(const c of result.changes)assert(c&&['put','remove'].includes(c.op)&&Object.keys(c).every(k=>['op','record','id'].includes(k)),'变更操作格式错误');
    return result.changes;
}
export function maintenanceMaterial(job,story,profile) {
    const budget=profile.settings.maxInputChars;
    const data={current:[],globalGuidelines:[],feedback:job.feedback??[],input:job.input??'',signal:job.signal??null,omitted:0};
    assert(JSON.stringify(data).length<=budget-100,'本次输入超过材料预算；全文已保留，请提高预算或减小批次后重试');
    const targets=new Set(job.signal?.ids??[]),related=new Set(story.records.filter(r=>targets.has(r.id)).flatMap(r=>r.links??[]));
    const current=story.records.filter(r=>r.status==='active'&&!story.excluded.includes(r.id)).map((r,i)=>({r,i,score:(targets.has(r.id)?100:0)+(r.kind==='core'?80:0)+(related.has(r.id)?60:0)+(r.locked?2:0)})).sort((a,b)=>b.score-a.score||b.i-a.i).map(x=>x.r);
    const view=r=>{const v=copy(r);delete v.sources;return v;};
    for(const [target,records] of [[data.current,current],[data.globalGuidelines,profile.records.filter(r=>r.status==='active'&&!profile.excluded.includes(r.id))]])for(const r of records){target.push(view(r));if(JSON.stringify(data).length>budget-40){target.pop();data.omitted++;}}
    assert([...targets].every(id=>data.current.some(r=>r.id===id)),'待修改大纲未能完整放入预算，任务保留；请提高材料预算后重试');
    return data;
}
export function maintenancePrompt(job,story,profile,material=maintenanceMaterial(job,story,profile)) {
    const key={world:'legacyWorld',reflection:'legacyReflection',feedback:'feedback',initialization:'initialization',outline:'outline'}[job.kind];
    return promptText(profile.settings,key,{contract:promptText(profile.settings,'changeContract'),material:JSON.stringify(material)});
}
export function injection(profile,story,settings,temporary='',context={sources:[],rows:[],chatKey:''},token='') {
    const active=doc=>doc.records.filter(r=>r.status==='active'&&!doc.excluded.includes(r.id));
    const selection=chooseOutline(story,context),selected=[],directory=[],used=[];
    const data={temporary,chapter:selection.state.chapter,core:[],outlines:[],guidelines:[],globalGuidelines:[],directory,reference:[]};
    const header=promptText(settings,'injection',{material:''}),control=token&&selection.active.length?promptText(settings,'control',{token}):'';
    const budget=settings.injectionChars-header.length-control.length-80;
    assert(JSON.stringify(data).length<=budget,'正文注入预算不足以包含当前要求和控制协议，请提高预算后重试');
    let omitted=0;
    const add=(target,value,required=false)=>{target.push(value);if(JSON.stringify(data).length>budget){target.pop();if(required)throw Error('故事核心超出正文注入预算，请提高预算后重试');omitted++;return false;}return true;};
    const view=r=>({id:r.id,title:r.title,truth:r.truth,text:r.blocks.map(b=>b.text).join(r.joiner??'\n\n')});
    for(const r of selection.records.filter(r=>r.kind==='core')){add(data.core,view(r),true);used.push(r.id);}
    const directoryBudget=Math.max(200,Math.floor(budget*.25));let dirChars=0;
    const directoryOrder=[...selection.records,...selection.active.filter(r=>!selection.records.includes(r))];
    for(const r of directoryOrder){const entry={id:r.id,kind:r.kind,title:r.title,summary:r.summary??'',keywords:r.keywords??[]};const size=JSON.stringify(entry).length;if(dirChars+size>directoryBudget){omitted++;continue;}if(add(directory,entry)){dirChars+=size;selected.push(r.id);}}
    for(const r of active(story).filter(r=>['guide','focus'].includes(r.kind)))if(add(data.guidelines,view(r)))used.push(r.id);
    for(const r of active(profile))add(data.globalGuidelines,view(r));
    for(const r of selection.records.filter(r=>r.kind!=='core'))if(add(data.outlines,view(r)))used.push(r.id);
    for(const r of active(story).filter(r=>r.kind==='world'))add(data.reference,view(r));
    const visibleIds=[...new Set([...selected,...used.filter(id=>selection.active.some(r=>r.id===id))])];
    return {text:promptText(settings,'injection',{material:JSON.stringify(data)})+(control?'\n'+control:''),omitted,visibleIds,recordIds:used,state:selection.state};
}
export function aiView(record){const r=copy(record);delete r.locked;delete r.joiner;delete r.origin;delete r.sources;r.blocks.forEach(b=>delete b.locked);return r;}
