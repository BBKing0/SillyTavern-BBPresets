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
    assert(only(data,['version','token','chapter','nextIds','revise'])&&data.version===1&&data.token===token,'控制信息版本或本轮标识不符');
    const ids=(values,max)=>Array.isArray(values)&&values.length<=max&&new Set(values).size===values.length&&values.every(id=>validId(id)&&visibleIds.has(id));
    assert(ids(data.nextIds,12),'下轮大纲条目不在本轮目录内');
    if(data.chapter!==null){const c=data.chapter;assert(only(c,['title','progress','lineIds'])&&typeof c.title==='string'&&c.title.trim()&&c.title.length<=160&&typeof c.progress==='string'&&c.progress.length<=500&&ids(c.lineIds,12),'章节控制格式无效');}
    if(data.revise!==null){const r=data.revise;assert(only(r,['ids','reason','instruction'])&&ids(r.ids,12)&&r.ids.length>0&&typeof r.reason==='string'&&r.reason.trim()&&r.reason.length<=1000&&typeof r.instruction==='string'&&r.instruction.trim()&&r.instruction.length<=4000,'改纲信号格式无效');}
    return data;
}
export function validControls(story,context) {
    const hashes=new Map(context.sources.map(s=>[s.id,s.hash])),prefixes=sourcePrefixes(context.sources);
    return (story.controls??[]).filter(c=>c.chatKey===context.chatKey&&c.sources.every(s=>s.chatKey===context.chatKey&&hashes.get(s.id)===s.hash)&&(!c.prefixHash||prefixes.get(c.source.id)===c.prefixHash));
}
export function outlineState(story,context) {
    const controls=validControls(story,context);
    return {chapter:controls.findLast(c=>c.chapter)?.chapter??null,nextIds:controls.at(-1)?.nextIds??[],at:controls.at(-1)?.at??null};
}
export function chooseOutline(story,context) {
    const active=story.records.filter(r=>OUTLINE_KINDS.includes(r.kind)&&r.status==='active'&&!story.excluded.includes(r.id));
    const state=outlineState(story,context),next=new Set([...state.nextIds,...(state.chapter?.lineIds??[])]);
    const user=context.rows.findLast(r=>r.role==='user')?.text.toLocaleLowerCase()??'';
    const ranked=active.map(r=>({r,score:(r.kind==='core'?100:0)+(next.has(r.id)?40:0)+(r.kind==='chapter'?20:0)+((r.keywords??[]).some(k=>user.includes(k.toLocaleLowerCase()))?30:0)}));
    const selected=ranked.filter(x=>x.score>0);if(!selected.some(x=>x.r.kind==='line'))selected.push(...ranked.filter(x=>x.r.kind==='line').slice(0,2));
    const linked=new Set(selected.flatMap(x=>x.r.links??[]));for(const item of ranked)if(linked.has(item.r.id)&&!selected.includes(item))selected.push({...item,score:10});
    return {state,active,records:selected.sort((a,b)=>b.score-a.score).map(x=>x.r)};
}
