import {assert,applyChanges,copy,uid,validId,validateDocument} from './model.js';
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

const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const taskFields=['id','kind','title','summary','blocks','truth','status','importance','nextNode','keywords','links'];
const permissionFields=['locked','origin','sources','joiner','creator'];
const draftBody=record=>Array.isArray(record.blocks)?record.blocks.map(block=>typeof block==='string'?block:typeof block?.text==='string'?block.text:'').join('\n\n'):typeof record.blocks==='string'?record.blocks:typeof record.text==='string'?record.text:typeof record.body==='string'?record.body:'';

function taskDraft(record,{op='put',blockedIssues=[]}={}) {
    return {id:typeof record.id==='string'?record.id:'',title:typeof record.title==='string'?record.title:'',summary:typeof record.summary==='string'?record.summary:'',text:draftBody(record),nextNode:typeof record.nextNode==='string'?record.nextNode:'',status:record.status??'active',record:copy(record),op,blockedIssues:copy(blockedIssues)};
}

function recordIssues(record,path) {
    const issues=[],missing=(key,label)=>issues.push(`${path}.${key}：缺少${label}，确认补全时可自动补结构`);
    for(const key of Object.keys(record))if(permissionFields.includes(key))issues.push(`${path}.${key}：模型不能提供保护、来源或权限字段`);else if(![...taskFields,'text','body'].includes(key))issues.push(`${path}.${key}：不支持的字段`);
    for(const [key,label,valid] of [['id','任务 ID',validId],['kind','类别',value=>value==='worldTask'],['truth','创作计划标记',value=>value==='plan'],['status','状态',value=>['active','archived'].includes(value)],['importance','重要程度',value=>['minor','major'].includes(value)]]){
        if(record[key]===undefined)missing(key,label);else if(!valid(record[key]))issues.push(`${path}.${key}：${label}无效`);
    }
    for(const [key,label,max] of [['title','任务名',300],['summary','一句话简介',500],['nextNode','下一阶段方向',500]]){
        const value=record[key],required=key!=='nextNode'||record.status!=='archived';
        if(value===undefined||typeof value==='string'&&!value.trim()&&required)issues.push(`${path}.${key}：缺少非空${label}`);
        else if(typeof value!=='string'||value.length>max)issues.push(`${path}.${key}：${label}须为不超过 ${max} 字符的文字`);
    }
    if(!Array.isArray(record.blocks)){
        if(object(record.blocks))for(const key of Object.keys(record.blocks))if(permissionFields.includes(key))issues.push(`${path}.blocks.${key}：模型不能提供保护、来源或权限字段`);
        if(draftBody(record).trim())issues.push(`${path}.blocks：正文已保留，确认补全时可转换为段落结构`);
        else issues.push(`${path}.blocks：缺少非空任务主体`);
    }else{
        if(!record.blocks.length||record.blocks.length>100)issues.push(`${path}.blocks：段落数须为 1—100`);
        const ids=new Set();
        record.blocks.forEach((block,index)=>{
            const at=`${path}.blocks[${index}]`;
            if(typeof block==='string'){issues.push(`${at}：文字已保留，确认补全时可转换为段落结构`);return;}
            if(!object(block)){issues.push(`${at}：须为包含 text 的段落对象`);return;}
            for(const key of Object.keys(block))if(key==='locked')issues.push(`${at}.${key}：模型不能提供保护、来源或权限字段`);else if(!['id','text'].includes(key))issues.push(`${at}.${key}：不支持的字段`);
            if(block.id===undefined)issues.push(`${at}.id：缺少段落 ID，确认补全时可自动补结构`);
            else if(!validId(block.id)||ids.has(block.id))issues.push(`${at}.id：段落 ID 无效或重复`);
            ids.add(block.id);
            if(typeof block.text!=='string')issues.push(`${at}.text：缺少文字或文字类型无效`);
        });
        if(!draftBody(record).trim())issues.push(`${path}.blocks：缺少非空任务主体`);
    }
    const bodyLength=Array.isArray(record.blocks)?record.blocks.reduce((sum,block)=>sum+(typeof block==='string'?block.length:typeof block?.text==='string'?block.text.length:0),0):draftBody(record).length;
    if(bodyLength>12000)issues.push(`${path}.blocks：任务主体超过 12000 字符`);
    return issues;
}

// Inspection never commits, removes permissions, or guesses missing creative text.
// The original record is kept so a repaired draft still passes the model's full safety checks.
export function inspectWorldTaskResult(raw,doc,options={}) {
    let changes,error;
    try{changes=parseWorldTaskResult(raw,doc,options);}catch(cause){error=cause.message;}
    let result;
    try{result=parseModelJSON(raw,'世界任务响应');}catch(cause){
        const draft=taskDraft({text:responseText(raw)}),issues=[`$：${cause.message}`,...recordIssues(draft.record,'$')];
        return {valid:false,issues:[...new Set(issues)],draft,drafts:[draft]};
    }
    const issues=[],drafts=[];
    const add=(record,path,op='put',blockedIssues=[])=>{
        if(!object(record)){issues.push(`${path}：缺少世界任务对象`);return;}
        drafts.push(taskDraft(record,{op,blockedIssues}));issues.push(...recordIssues(record,path));
    };
    if(object(result)&&Object.hasOwn(result,'changes')){
        const rootIssues=Object.keys(result).filter(key=>key!=='changes').map(key=>`$.${key}：不支持的响应字段`);issues.push(...rootIssues);
        if(!Array.isArray(result.changes))issues.push('$.changes：须为变更数组');
        else{
            if(result.changes.length>50)issues.push('$.changes：一次最多 50 个变更');
            const batchIssues=result.changes.length!==1?['$.changes：原响应包含多项变更，须修正完整 JSON，不能只保存单条草稿']:[];
            result.changes.forEach((change,index)=>{
                const path=`$.changes[${index}]`;
                if(!object(change)){issues.push(`${path}：须为变更对象`);return;}
                const blockers=[...rootIssues,...batchIssues];
                if(!['put','remove'].includes(change.op))blockers.push(`${path}.op：不支持的操作`);
                const keys=change.op==='remove'?['op','id']:['op','record'];
                for(const key of Object.keys(change))if(!keys.includes(key))blockers.push(`${path}.${key}：不支持的变更字段`);
                issues.push(...blockers);
                if(change.op!=='remove'||change.record!==undefined)add(change.record,`${path}.record`,change.op,blockers);
            });
        }
    }else if(object(result)&&Object.hasOwn(result,'record')){
        const blockers=Object.keys(result).filter(key=>!['op','record'].includes(key)).map(key=>`$.${key}：不支持的响应字段`);
        if(result.op!==undefined&&result.op!=='put')blockers.push('$.op：不支持的操作');
        issues.push('$：缺少 changes 变更数组',...blockers);add(result.record,'$.record',result.op??'put',blockers);
    }else if(object(result)){issues.push('$：缺少 changes 变更数组');add(result,'$');}
    else issues.push('$：须返回世界任务对象或 changes 变更数组');
    if(error)issues.push(`$：${error}`);
    return {valid:!error,...(!error?{changes}:{}),issues:!error?[]:[...new Set(issues)],draft:drafts[0]??null,drafts};
}

// Only missing structure receives defaults. Existing invalid values and permission fields survive
// into parseWorldTaskResult and are rejected there, including protected text and advance scope.
export function worldTaskDraftResult(draft,doc,options={}) {
    assert(object(draft),'世界任务补全草稿无效');
    assert((draft.op??'put')==='put'&&!(draft.blockedIssues??[]).length,'草稿包含不支持的操作或响应字段，请修正原始 JSON');
    const record=object(draft.record)?copy(draft.record):{};
    for(const key of ['title','summary','nextNode'])record[key]=draft[key];
    if(draft.id)record.id=draft.id;
    assert(typeof draft.text==='string','任务主体须为文字');
    const originalBody=draftBody(record),originalBlocks=record.blocks;
    assert(originalBlocks===undefined||typeof originalBlocks==='string'||Array.isArray(originalBlocks),'原 blocks 格式无效，请修正原始 JSON');
    if(Array.isArray(originalBlocks)&&draft.text===originalBody)record.blocks=originalBlocks.map(block=>typeof block==='string'?{id:uid(),text:block}:object(block)?{...block,...(block.id===undefined?{id:uid()}:{})}:block);
    else if(Array.isArray(originalBlocks)&&originalBlocks.length===1&&object(originalBlocks[0]))record.blocks=[{...originalBlocks[0],...(originalBlocks[0].id===undefined?{id:uid()}:{}),text:draft.text}];
    else {
        // Do not let collapsing a malformed multi-block reply discard forbidden permission fields.
        assert(!Array.isArray(originalBlocks)||originalBlocks.every(block=>object(block)&&Object.keys(block).every(key=>['id','text'].includes(key))),'原段落含权限或不支持的字段，请修正原始 JSON');
        record.blocks=[{id:uid(),text:draft.text}];
    }
    delete record.text;delete record.body;
    for(const [key,value] of [['id',uid()],['kind','worldTask'],['truth','plan'],['status','active'],['importance','minor']])if(record[key]===undefined)record[key]=value;
    return parseWorldTaskResult(JSON.stringify({changes:[{op:'put',record}]}),doc,options);
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
