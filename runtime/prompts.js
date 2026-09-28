import {assert,copy} from '../core/model.js';
import {parseModelJSON} from '../core/json.js';
import {PROMPTS,promptText} from '../core/prompt-templates.js';
import {inspirationRoom,storyText} from '../core/story.js';

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
    if(['initialization','outline'].includes(job.kind))try{const input=JSON.parse(data.input);if(input.version===2)data.input=input;}catch{/* Preserve legacy text inputs. */}
    assert(JSON.stringify(data).length<=budget-100,'本次输入超过材料预算；全文已保留，请提高预算或减小批次后重试');
    const targets=new Set(job.signal?.ids??[]),related=new Set(story.records.filter(r=>targets.has(r.id)).flatMap(r=>r.links??[]));
    const current=story.records.filter(r=>(job.kind!=='feedback'||['guide','focus','experience'].includes(r.kind))&&r.status==='active'&&!story.excluded.includes(r.id)).map((r,i)=>({r,i,score:(targets.has(r.id)?100:0)+(r.kind==='core'?80:0)+(related.has(r.id)?60:0)+(r.locked?2:0)})).sort((a,b)=>b.score-a.score||b.i-a.i).map(x=>x.r);
    const view=r=>{const v=copy(r);delete v.sources;return v;};
    for(const [target,records] of [[data.current,current],[data.globalGuidelines,job.kind==='feedback'?[]:profile.records.filter(r=>r.status==='active'&&!profile.excluded.includes(r.id))]])for(const r of records){target.push(view(r));if(JSON.stringify(data).length>budget-40){target.pop();data.omitted++;}}
    assert([...targets].every(id=>data.current.some(r=>r.id===id)),'待修改大纲未能完整放入预算，任务保留；请提高材料预算后重试');
    return data;
}
export function maintenancePrompt(job,story,profile,material=maintenanceMaterial(job,story,profile)) {
    const key=job.kind==='feedback'&&job.feedback?.some(f=>f.category==='plot')?'plotAuthorFeedback':job.kind==='outline'&&job.feedback?.some(f=>f.category==='plot')?'plotFeedback':{world:'legacyWorld',reflection:'legacyReflection',feedback:'feedback',initialization:'initialization',outline:'outline'}[job.kind];
    return promptText(profile.settings,key,{contract:promptText(profile.settings,job.kind==='feedback'?'authorContract':'changeContract'),material:JSON.stringify(material)});
}
export function injection(profile,inspiration,settings,context={sources:[],rows:[],chatKey:''},token='') {
    const features={author:settings.injectAuthor!==false,story:false,inspiration:settings.injectInspiration!==false};
    const active=doc=>doc.records.filter(r=>r.status==='active'&&!doc.excluded.includes(r.id));
    // Only an independently selected inspiration archive can participate in generation.
    const doc=inspiration?.type==='inspiration'?inspiration:{records:[],excluded:[],controls:[]};
    const guidelines=[],items=[],used=[],room=inspirationRoom(doc,settings,context);
    const control=token&&inspiration?.type==='inspiration'&&features.inspiration?promptText(settings,'inspirationControl',{token}):'';
    const json=value=>JSON.stringify(value).replaceAll('<','\\u003c').replaceAll('>','\\u003e');
    const render=()=>{
        const chunks=[];
        if(features.author)chunks.push(`<BBPresets_WritingGuidelines>\n${json({author:profile.title,guidelines})}\n</BBPresets_WritingGuidelines>`);
        if(features.inspiration)chunks.push(`<BBPresets_Inspiration>\n${json({items,canAdd:room.canAdd,aiMaintenance:settings.inspirationAiEnabled!==false,pending:room.pending,capacity:room.capacity})}\n</BBPresets_Inspiration>`);
        return chunks.length?promptText(settings,'inspirationInjection',{material:chunks.join('\n')})+(control?`\n<BBPresets_ControlInstructions>\n${control}\n</BBPresets_ControlInstructions>`:''):'';
    };
    assert(render().length<=settings.injectionChars,'正文注入预算不足以包含说明和灵感协议，请提高预算');
    let omitted=0;
    const add=(list,item)=>{list.push(item);if(render().length>settings.injectionChars){list.pop();omitted++;return false;}used.push(item.id);return true;};
    if(features.author)for(const r of active(profile).filter(r=>['guide','focus'].includes(r.kind)))add(guidelines,{id:r.id,title:r.title,truth:r.truth,text:storyText(r)});
    if(features.inspiration)for(const r of active(doc).sort((a,b)=>Number(b.creator==='user')-Number(a.creator==='user'))){if(items.length>=(settings.inspirationInjectCount??3))break;add(items,{id:r.id,text:storyText(r),creator:r.creator,locked:r.locked||r.blocks.some(b=>b.locked)});}
    return {text:render(),features,omitted,visibleIds:[],lineIds:[],inspirationIds:items.map(r=>r.id),recordIds:used,counts:{outline:0,writing:guidelines.length,directory:0,inspiration:items.length},controlEnabled:Boolean(control)};
}
export function aiView(record){const r=copy(record);delete r.locked;delete r.joiner;delete r.origin;delete r.sources;delete r.creator;r.blocks.forEach(b=>delete b.locked);return r;}
