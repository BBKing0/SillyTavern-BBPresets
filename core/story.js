import {assert,copy,record,uid,validId} from './model.js';
import {sourcePrefixes} from './source-prefix.js';

export const storyText=r=>r.blocks.map(b=>b.text).join(r.joiner??'\n\n');
const plain=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>keys.includes(k));
const short=(value,max)=>typeof value==='string'&&value.trim()&&value.length<=max;
const ids=(values,max,visible)=>Array.isArray(values)&&values.length<=max&&new Set(values).size===values.length&&values.every(id=>validId(id)&&visible.has(id));

export function validateStoryControl(data,{lineIds=new Set(),inspirationIds=new Set(),visibleIds=new Set()}={}){
    assert(plain(data,['version','token','nodes','inspiration','revise']),'故事控制包含不支持的字段');
    assert(Array.isArray(data.nodes)&&data.nodes.length<=20&&new Set(data.nodes.map(n=>n?.id)).size===data.nodes.length,'下一个节点更新数量或 ID 无效');
    for(const n of data.nodes)assert(plain(n,['id','nextNode'])&&lineIds.has(n.id)&&typeof n.nextNode==='string'&&n.nextNode.length<=500,'只能更新本轮已注入故事线的下一个节点');
    const inspiration=data.inspiration;
    assert(plain(inspiration,['add','update','usedIds'])&&Array.isArray(inspiration.add)&&inspiration.add.length<=1&&Array.isArray(inspiration.update)&&inspiration.update.length<=3,'灵感格式无效；每轮最多新增一条、修订三条');
    for(const item of inspiration.add)assert(plain(item,['text'])&&short(item.text,1000),'新增灵感须为 1—1000 字符的文字');
    for(const item of inspiration.update)assert(plain(item,['id','text'])&&inspirationIds.has(item.id)&&short(item.text,1000),'只能修订本轮注入的灵感');
    assert(new Set(inspiration.update.map(x=>x.id)).size===inspiration.update.length&&ids(inspiration.usedIds,20,inspirationIds)&&!inspiration.update.some(x=>inspiration.usedIds.includes(x.id)),'灵感操作 ID 重复或不在本轮注入范围');
    if(data.revise!==null){const r=data.revise;assert(plain(r,['ids','reason','instruction'])&&ids(r.ids,12,visibleIds)&&r.ids.length&&short(r.reason,1000)&&short(r.instruction,4000),'故事核修订信号无效');}
    return data;
}

export function inspirationRoom(story,settings,context){
    const pending=story.records.filter(r=>r.kind==='inspiration'&&r.status==='active').length;
    const hashes=new Map((context.sources??[]).map(s=>[s.id,s.hash])),prefixes=sourcePrefixes(context.sources??[]);
    const latest=(story.controls??[]).findLast(c=>c.chatKey===context.chatKey&&c.addedInspirationIds?.length&&hashes.get(c.source.id)===c.source.hash&&(!c.prefixHash||prefixes.get(c.source.id)===c.prefixHash));
    const since=latest?(context.rows??[]).filter(r=>r.role==='assistant'&&r.floor>latest.source.floor).length:3;
    return {pending,capacity:settings.inspirationCapacity??20,canAdd:settings.inspirationAiEnabled!==false&&pending<(settings.inspirationCapacity??20)&&since>=2};
}

// Produce ordinary audited record changes so swipe, deletion and branches can undo them.
export function storyControlChanges(story,control,settings,context){
    assert(settings.injectStory!==false||!control.nodes.length&&!control.revise,'故事注入已关闭，拒绝故事更新');
    assert(settings.injectInspiration!==false||!control.inspiration.add.length&&!control.inspiration.update.length&&!control.inspiration.usedIds.length,'灵感注入已关闭，拒绝灵感更新');
    const changes=[],addedInspirationIds=[],usedInspirationIds=[],updatedNodeIds=[],skipped=[];
    const view=r=>{const next=copy(r);for(const key of ['locked','origin','sources','joiner','creator'])delete next[key];for(const b of next.blocks)delete b.locked;return next;};
    const find=(id,kind)=>{const r=story.records.find(r=>r.id===id&&r.kind===kind&&r.status==='active'&&!story.excluded.includes(id));assert(r,'本轮条目已变化，请重新生成');return r;};
    for(const n of control.nodes){const r=find(n.id,'storyline');if(r.nextNode===n.nextNode)continue;const next=view(r);next.nextNode=n.nextNode;changes.push({op:'put',record:next});updatedNodeIds.push(n.id);}
    const enabled=settings.inspirationAiEnabled!==false;
    if(!enabled&&(control.inspiration.add.length||control.inspiration.update.length))skipped.push('AI 灵感新增和修订已关闭');
    if(enabled)for(const item of control.inspiration.update){const r=find(item.id,'inspiration');assert(!r.blocks.some(b=>b.locked),'AI 不得改写含保护文字的灵感');if(storyText(r)===item.text.trim())continue;const next=view(r);next.blocks=[{id:r.blocks[0].id,text:item.text.trim()}];changes.push({op:'put',record:next});}
    for(const id of control.inspiration.usedIds){const next=view(find(id,'inspiration'));next.status='archived';changes.push({op:'put',record:next});usedInspirationIds.push(id);}
    if(enabled&&control.inspiration.add.length){
        const room=inspirationRoom(story,settings,context),text=control.inspiration.add[0].text.trim();
        if(!room.canAdd)skipped.push(room.pending>=room.capacity?'待用灵感已达上限':'灵感新增间隔不足三轮');
        else if(story.records.some(r=>r.kind==='inspiration'&&storyText(r).trim()===text))skipped.push('重复灵感已跳过');
        else{const r=view(record({id:uid(),kind:'inspiration',title:text.slice(0,40),body:text}));changes.push({op:'put',record:r});addedInspirationIds.push(r.id);}
    }
    return {changes,addedInspirationIds,usedInspirationIds,updatedNodeIds,skipped};
}
