import {assert} from './model.js';

// Content only: never send vectors, floor lists, extraction metadata or the whole slot.
const fields=['id','title','name','description','personality','appearance','relations','relationships','relation','attitude','role','notes','note','period','owner','significance','verbatim','subject','target','biography','aliases','indexCard','content','event','summary','storyTime','status','truthStatus','cognitiveType','memoryTier','hiddenNotes','participants','startTime','endTime','currentState','goal','priority','location','quantity','type','events','nodes','entries','text','date','time','stage','parentThreadId','subEntries','impact','tags','category','isActive','archived'];
function content(value){
    if(value===null||['string','number','boolean'].includes(typeof value))return value;
    if(Array.isArray(value))return value.map(content);
    if(!value||typeof value!=='object')return undefined;
    return Object.fromEntries(fields.filter(k=>Object.hasOwn(value,k)).map(k=>[k,content(k==='hiddenNotes'&&Array.isArray(value[k])?value[k].filter(note=>note?.allowInjection!==false):value[k])]));
}
export function memoryMaterial(snapshot,retrieval=null){
    const data=snapshot.data;
    for(const key of ['timeline','milestones','memories'])assert(Array.isArray(data?.[key]),`BB-Memory 存档缺少 ${key} 数据，未发送初始化；请先在 BB-Memory 保存当前存档后重试`);
    const permanent=m=>m.memoryTier==='eternal'||m.keepPermanent===true||m.pinned===true;
    const material={signature:snapshot.signature,timeline:data.timeline.map(content),milestones:data.milestones.map(content),permanentMemories:data.memories.filter(permanent).map(content),retrieved:[]};
    // Reuse the normal retrieval's hits; this does not run another embedding request.
    if(retrieval)for(const [key,hits] of [['memories',retrieval.hits],['npc',retrieval.npcHits],['items',retrieval.itemHits]]){
        const ids=new Set((Array.isArray(hits)?hits:[]).map(h=>String(h.id)));
        for(const item of Array.isArray(data[key])?data[key]:[])if(ids.has(String(item.id))&&!(key==='memories'&&permanent(item)))material.retrieved.push({kind:key,...content(item)});
    }
    return material;
}

export function initializationMaterial({answers,world,memory,notes=[]},budget){
    const material={version:2,answers,world:{materials:[],notes:world.notes??[],omitted:world.omitted??0},memory,notes};
    const optional=memory?.retrieved??[];
    if(memory)material.memory={...memory,retrieved:[]};
    const size=()=>JSON.stringify(material).length;
    assert(size()<=budget,`时间线、里程碑、永久记忆与回答需要 ${size()} 字符，超过初始化材料预算 ${budget}；未发送请求，请提高“策划材料字符预算”后重试`);
    for(const section of world.materials??[]){
        const row={label:section.label,text:section.text};material.world.materials.push(row);
        if(size()>budget){
            const original=String(row.text);let low=0,high=original.length;
            while(low<high){const mid=Math.ceil((low+high)/2);row.text=original.slice(0,mid)+'（此来源按预算节选）';if(size()<=budget)low=mid;else high=mid-1;}
            row.text=original.slice(0,low)+'（此来源按预算节选）';material.world.omitted++;
            if(!low||size()>budget)material.world.materials.pop();
        }
    }
    for(const item of optional){material.memory.retrieved.push(item);if(size()>budget){material.memory.retrieved.pop();break;}}
    assert(size()<=budget,'初始化资料超过预算，请提高策划材料字符预算后重试');
    return material;
}
