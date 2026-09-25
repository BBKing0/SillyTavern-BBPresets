import {assert,validId,OUTLINE_KINDS} from './model.js';
import {parseModelJSON} from './json.js';
import {sourcePrefixes} from './source-prefix.js';

export const CONTROL_OPEN='[BBP_CONTROL]';
export const CONTROL_CLOSE='[/BBP_CONTROL]';
// Ephemeral rendering/prompt filtering only: original chat content remains intact.
export const CONTROL_FILTER='/\\[BBP_CONTROL\\][\\s\\S]*?(?:\\[\\/BBP_CONTROL\\]|$)/g';
export function stripControl(text){return String(text??'').replace(/\[BBP_CONTROL\][\s\S]*?(?:\[\/BBP_CONTROL\]|$)/g,'').trimEnd();}
export function parseControl(text,token,visibleIds) {
    const parts=[...String(text).matchAll(/\[BBP_CONTROL\]([\s\S]*?)\[\/BBP_CONTROL\]/g)];
    // Continue appends to the stored message: older, already-consumed blocks may precede this one.
    const matching=parts.filter(part=>{try{return parseModelJSON(part[1]).token===token;}catch{return false;}});
    assert(matching.length===1,'本轮未返回完整且唯一的控制信息，大纲保持不变');
    const match=matching[0];assert(!text.slice(match.index+match[0].length).trim(),'控制信息必须位于正文末尾');
    const data=parseModelJSON(match[1],'正文控制信息');
    const only=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>keys.includes(k));
    assert(only(data,['version','token','chapter','nextIds','revise'])&&[1,2].includes(data.version)&&data.token===token,'控制信息版本或本轮标识不符');
    const ids=(values,max)=>Array.isArray(values)&&values.length<=max&&new Set(values).size===values.length&&values.every(id=>validId(id)&&visibleIds.has(id));
    assert(ids(data.nextIds,12),'下轮大纲条目不在本轮目录内');
    if(data.chapter!==null){const c=data.chapter;assert(only(c,data.version===1?['title','progress','lineIds']:['progress','lineIds'])&&typeof c.progress==='string'&&(data.version===1||c.progress.trim())&&c.progress.length<=500&&ids(c.lineIds,12),'剧情目标格式无效');if(data.version===1)assert(typeof c.title==='string'&&c.title.length<=160,'旧版章节格式无效');}
    if(data.revise!==null){const r=data.revise;assert(only(r,['ids','reason','instruction'])&&ids(r.ids,12)&&r.ids.length>0&&typeof r.reason==='string'&&r.reason.trim()&&r.reason.length<=1000&&typeof r.instruction==='string'&&r.instruction.trim()&&r.instruction.length<=4000,'改纲信号格式无效');}
    return data;
}
export function validControls(story,context) {
    const hashes=new Map(context.sources.map(s=>[s.id,s.hash])),prefixes=sourcePrefixes(context.sources);
    return (story.controls??[]).filter(c=>c.chatKey===context.chatKey&&c.sources.every(s=>s.chatKey===context.chatKey&&hashes.get(s.id)===s.hash)&&(!c.prefixHash||prefixes.get(c.source.id)===c.prefixHash));
}
export function outlineState(story,context) {
    const controls=validControls(story,context),last=controls.at(-1);
    // v1 progress was a retrospective summary, never promote it into a future goal.
    const chapter=controls.findLast(c=>c.version===2&&c.chapter)?.chapter??null;
    const latest=context.rows?.findLast(r=>r.role==='assistant');
    const fresh=last?.version===2&&(!latest||latest.id===last.source.id&&latest.hash===last.source.hash)&&!(story.activity??[]).some(a=>a.chatKey===context.chatKey&&a.source.floor>last.source.floor&&context.sources.some(s=>s.id===a.source.id&&s.hash===a.source.hash));
    return {chapter,nextIds:fresh?last.nextIds:[],at:last?.at??null};
}
export function chooseOutline(story,context,settings={}) {
    const active=story.records.filter(r=>OUTLINE_KINDS.includes(r.kind)&&r.status==='active'&&!story.excluded.includes(r.id));
    const state=outlineState(story,context),byId=new Map(active.map(r=>[r.id,r]));
    if(state.chapter)state.chapter={progress:state.chapter.progress,lineIds:state.chapter.lineIds.filter(id=>byId.get(id)?.kind==='line')};
    const requested=state.nextIds.map(id=>byId.get(id)).filter(Boolean);
    state.nextIds=requested.map(r=>r.id);
    const records=settings.outlineInjection==='full'?active:requested.slice(0,settings.outlineMaxEntries??3);
    // Keywords, current lines and links help discover a compact directory only; none load bodies.
    const query=[context.rows?.findLast(r=>r.role==='user')?.text??'',state.chapter?.progress??''].join('\n').toLocaleLowerCase();
    const related=new Set([...(state.chapter?.lineIds??[]),...requested.flatMap(r=>r.links??[])]);
    const directory=active.map(r=>({r,score:(requested.includes(r)?100:0)+(related.has(r.id)?50:0)+((r.keywords??[]).some(k=>query.includes(k.toLocaleLowerCase()))?30:0)+(r.kind==='core'?10:0)})).sort((a,b)=>b.score-a.score).map(x=>x.r);
    return {state,active,records,directory,limited:Math.max(0,requested.length-records.length)};
}
