import {assert,MEMORY_COLLECTIONS} from './model.js';

// Verified content fields in BB-Memory memory-store.js / memory-slots.js.
// Never forward embedding packs, extraction floors, source hashes or rollback state.
const fields=new Set(['id','title','name','description','personality','appearance','relations','relationships','relation','attitude','role','notes','note','period','owner','significance','verbatim','subject','target','biography','aliases','indexCard','content','event','summary','storyTime','storyTimeSort','status','truthStatus','cognitiveType','memoryTier','npcTier','itemTier','hiddenNotes','participants','startTime','endTime','currentState','goal','priority','location','quantity','type','events','nodes','entries','text','date','time','stage','parentThreadId','timelineId','timelineName','subEntries','impact','tags','category','isActive','archived','keepPermanent','pinned','relatedMemoryIds','isTimelineSummary']);
const collections=MEMORY_COLLECTIONS;
export function memoryInjectionModes({mode='vector',categories={}}={}){
    assert(['vector','full','mixed'].includes(mode),'世界任务记忆注入方式无效');
    return Object.fromEntries(collections.map(key=>{const value=mode==='mixed'?(categories?.[key]??'vector'):mode;assert(['vector','full'].includes(value),'世界任务分类记忆注入方式无效');return [key,value];}));
}

export function memoryArchiveContent(value){
    if(value===null||['string','number','boolean'].includes(typeof value))return value;
    if(Array.isArray(value))return value.filter(item=>item?.allowInjection!==false).map(memoryArchiveContent);
    if(!value||typeof value!=='object')return undefined;
    return Object.fromEntries(Object.keys(value).filter(key=>fields.has(key)).map(key=>[key,memoryArchiveContent(value[key])]));
}

export function worldTaskMemory(snapshot,options={mode:'full'}){
    assert(snapshot?.available,snapshot?.reason||'BB-Memory 当前存档尚未保存或缺少可验证身份，请先保存后重试');
    for(const key of collections)assert(Array.isArray(snapshot.data?.[key]),`BB-Memory 存档缺少 ${key} 数据，未发送世界任务请求；请先在 BB-Memory 保存当前存档后重试`);
    const modes=memoryInjectionModes(options),retrieval=options.retrieval;
    if(collections.some(key=>modes[key]==='vector'&&snapshot.data[key].length))assert(retrieval,'无法取得本次记忆命中，请重试或改为全量注入');
    const hits={timeline:retrieval?.timelineHits,milestones:retrieval?.milestoneHits,npc:retrieval?.npcHits,items:retrieval?.itemHits,memories:retrieval?.hits};
    return {signature:snapshot.identitySignature??snapshot.signature,modes,...Object.fromEntries(collections.map(key=>{
        if(modes[key]==='full')return [key,memoryArchiveContent(snapshot.data[key])];
        const rows=Array.isArray(hits[key])?hits[key]:Object.values(hits[key]??{}).flat();
        const ids=new Set(rows.filter(Boolean).map(hit=>String(typeof hit==='object'?hit.id:hit)));
        const byId=new Map(rows.filter(hit=>hit&&typeof hit==='object').map(hit=>[String(hit.id),hit]));
        return [key,memoryArchiveContent(snapshot.data[key].filter(row=>ids.has(String(row.id))).map(row=>byId.get(String(row.id))?.material??row))];
    }))};
}

export function worldTaskMaterial(snapshot,world,budget=20000,options={mode:'full'}){
    assert(Number.isFinite(budget)&&budget>=1000,'世界任务材料预算至少需要 1000 字符');
    const memory=snapshot?worldTaskMemory(snapshot,options):null;
    const material={version:2,world:{materials:[],notes:world?.notes??[],omitted:world?.omitted??0},memory,notes:snapshot?[Object.values(memory.modes).every(mode=>mode==='full')?'只读 BB-Memory 已保存的当前槽全文；未进行新的向量检索':'只读 BB-Memory 已保存槽；按本次任务与近期上下文检索，参考正文的向量、关键词、分类及常驻规则；未写入记忆库',...(options.notes??[])]:['当前未启用 BB-Memory，使用角色、世界书与聊天上下文独立安排世界任务']};
    const size=()=>JSON.stringify(material).length;
    assert(size()<=budget,`BB-Memory 所选记忆资料需要 ${size()} 字符，超过世界任务材料预算 ${budget}；未发送请求，请调整注入方式或提高“策划材料字符预算”后重试`);
    for(const section of world?.materials??[]){
        const row={label:String(section.label??''),text:String(section.text??'')};material.world.materials.push(row);
        if(size()<=budget)continue;
        const original=row.text,marker='（此来源按预算节选）';let low=0,high=original.length;
        while(low<high){const mid=Math.ceil((low+high)/2);row.text=original.slice(0,mid)+marker;if(size()<=budget)low=mid;else high=mid-1;}
        row.text=original.slice(0,low)+marker;material.world.omitted++;
        // Account for the omitted counter changing from one to two digits.
        while(low>0&&size()>budget){low--;row.text=original.slice(0,low)+marker;}
        if(!low||size()>budget)material.world.materials.pop();
    }
    assert(size()<=budget,'世界任务资料超过预算，请提高策划材料字符预算后重试');
    return material;
}

export function memoryArchiveRevision(snapshot){
    const data=snapshot.data;
    return {identity:snapshot.identitySignature,updatedAt:data?._slotUpdatedAt??data?.updatedAt??null,...Object.fromEntries(collections.filter(key=>Array.isArray(data?.[key])).map(key=>[key,memoryArchiveContent(data[key])]))};
}

