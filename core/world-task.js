import {assert,applyChanges,copy,validId,validateDocument} from './model.js';
import {parseModelJSON,responseText} from './json.js';

const only=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>keys.includes(k));
const short=(value,max)=>typeof value==='string'&&value.trim()&&value.length<=max;
const idea=value=>value===null||short(value,300);
const visible=(values,max,allowed)=>Array.isArray(values)&&values.length<=max&&new Set(values).size===values.length&&values.every(id=>validId(id)&&allowed.has(id));

// A receipt can only refer to material supplied to this exact generation.
export function parseWorldTaskControl(raw,token,{inspirationIds=new Set(),worldTaskIds=new Set()}={}) {
    const text=responseText(raw),parts=[...text.matchAll(/\[BBP_CONTROL\]([\s\S]*?)\[\/BBP_CONTROL\]/g)];
    const matching=parts.filter(part=>{try{return parseModelJSON(part[1]).token===token;}catch{return false;}});
    assert(matching.length===1,'本轮未返回完整且唯一的控制信息，资料保持不变');
    const match=matching[0];assert(!text.slice(match.index+match[0].length).trim(),'控制信息必须位于正文末尾');
    const data=parseModelJSON(match[1],'正文控制信息');
    assert(only(data,['version','token','inspiration','worldTask'])&&data.version===5&&data.token===token,'控制信息版本、字段或本轮标识不符');
    const i=data.inspiration,w=data.worldTask,allowedIdeas=new Set(inspirationIds),allowedTasks=new Set(worldTaskIds);
    assert(only(i,['idea','update','usedIds'])&&idea(i.idea)&&Array.isArray(i.update)&&i.update.length<=3,'灵感触发或更新格式无效');
    for(const item of i.update)assert(only(item,['id','text'])&&allowedIdeas.has(item.id)&&short(item.text,1000),'只能修订本轮注入的灵感，最多 1000 字符');
    assert(new Set(i.update.map(item=>item.id)).size===i.update.length&&visible(i.usedIds,20,allowedIdeas)&&!i.update.some(item=>i.usedIds.includes(item.id)),'灵感操作重复或超出本轮注入范围');
    assert(only(w,['idea','signals'])&&idea(w.idea)&&Array.isArray(w.signals)&&w.signals.length<=50,'世界任务触发或进展格式无效');
    const seen=new Set();
    for(const signal of w.signals){
        assert(only(signal,['id','status','reason'])&&validId(signal.id)&&allowedTasks.has(signal.id)&&!seen.has(signal.id)&&['achieved','deviated','adjust'].includes(signal.status)&&short(signal.reason,300),'世界任务进展信号无效或超出本轮注入范围');
        seen.add(signal.id);
    }
    return data;
}

function changesResult(raw,label) {
    const result=parseModelJSON(raw,label);
    assert(only(result,['changes'])&&Array.isArray(result.changes)&&result.changes.length<=50,'模型修改格式无效');
    for(const change of result.changes)assert(only(change,change?.op==='put'?['op','record']:['op','id'])&&['put','remove'].includes(change.op),'模型包含不支持的操作或字段');
    return result.changes;
}

// Validate the entire batch before any data is committed, including every protection flag.
export function parseWorldTaskResult(raw,doc,{mode='create',ids=[],capacity=5}={}) {
    validateDocument(doc);assert(doc.type==='worldTask','世界任务响应须属于当前世界任务档');
    assert(['create','advance'].includes(mode)&&Number.isInteger(capacity)&&capacity>=1&&capacity<=50,'世界任务生成参数无效');
    const changes=changesResult(raw,'世界任务响应'),selected=new Set(ids);
    if(mode==='create')assert(changes.length===1&&changes[0].op==='put'&&!doc.records.some(r=>r.id===changes[0].record?.id)&&changes[0].record?.status==='active','新建世界任务须返回一个新的待进行任务，不能修改现有任务');
    else {
        assert(selected.size&&[...selected].every(id=>validId(id)&&doc.records.some(r=>r.id===id&&r.kind==='worldTask')),'待推进世界任务身份无效');
        assert(changes.every(c=>selected.has(c.op==='put'?c.record?.id:c.id)),'推进只能修改本次指定的世界任务');
    }
    assert(changes.every(c=>c.op!=='put'||c.record?.kind==='worldTask'),'世界任务响应不能修改其他类别');
    for(const change of changes)if(change.op==='put'){
        const r=change.record;assert(short(r.title,300)&&short(r.summary,500),'模型世界任务须包含非空任务名与一句话简介');
        assert(r.status!=='active'||short(r.nextNode,500),'使用中的模型世界任务须包含非空的下一阶段方向');
    }
    const preview=applyChanges(doc,changes,{origin:'worldTask'});
    assert(preview.records.filter(r=>r.status==='active').length<=Math.max(capacity,doc.records.filter(r=>r.status==='active').length),'世界任务数量超过当前存档上限');
    return copy(changes);
}

export function parseInspirationPlanResult(raw,doc,{capacity=20}={}) {
    validateDocument(doc);assert(doc.type==='inspiration','灵感展开须属于当前灵感档');
    assert(Number.isInteger(capacity)&&capacity>=1&&capacity<=200,'灵感上限无效');
    const changes=changesResult(raw,'灵感展开响应');
    assert(changes.length===1&&changes[0].op==='put'&&changes[0].record?.kind==='inspiration'&&changes[0].record.status==='active'&&!doc.records.some(r=>r.id===changes[0].record.id),'灵感展开须仅新增一条待用灵感');
    const preview=applyChanges(doc,changes,{origin:'inspirationPlan'});
    assert(preview.records.filter(r=>r.status==='active').length<=capacity,'待用灵感已达上限');
    const added=preview.records.at(-1),body=r=>r.blocks.map(b=>b.text).join(r.joiner??'\n\n').trim();
    assert(!doc.records.some(r=>body(r)===body(added)),'重复灵感已跳过');
    return copy(changes);
}
