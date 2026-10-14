import {memoryArchiveContent} from './memory-archive.js';

// A read-only adapter for the verified BB-Memory saved format. It intentionally
// does not import that extension: its getSettings() normalizes live settings.
const collections=['timeline','milestones','npc','items','memories'];
const finiteVector=value=>Array.isArray(value)&&value.length>0&&value.length<=65536&&value.every(number=>typeof number==='number'&&Number.isFinite(number));
const bounded=(value,fallback,min,max)=>Number.isFinite(Number(value))?Math.max(min,Math.min(max,Number(value))):fallback;
const limit=(value,fallback,max=100)=>Math.floor(bounded(value,fallback,0,max));
const normalize=value=>String(value??'').normalize('NFKC').toLowerCase().trim();
const tagNames=entry=>(Array.isArray(entry.tags)?entry.tags:[]).map(tag=>normalize(typeof tag==='string'?tag:tag?.name));
const archived=entry=>!entry||typeof entry!=='object'||entry.allowInjection===false||entry.archived===true||['archived','deleted'].includes(entry.status)||entry.memoryTier==='archived';
const resident=entry=>entry.keepPermanent===true||entry.pinned===true||entry.resident===true||entry.status==='resident'||entry.priority==='resident'||['core','eternal'].includes(entry.memoryTier);
// Verified memory-tags.js: only the exact 日常 tag denotes a daily memory.
const daily=entry=>tagNames(entry).includes('日常');
const unique=rows=>{const found=new Map();for(const row of rows)if(row?.id!==undefined&&row.id!==null&&String(row.id).trim()&&!found.has(String(row.id)))found.set(String(row.id),row);return [...found.values()];};
const fnvHash=text=>{let hash=2166136261;for(let i=0;i<text.length;i++){hash^=text.charCodeAt(i);hash=Math.imul(hash,16777619);}return (hash>>>0).toString(36);};

export function memoryVectorBankKey(scope){
    const text=String(scope??'').trim();if(!text)throw Error('向量库作用域为空');
    return 'bb_vec_bank_'+fnvHash(text);
}

export function memoryEmbeddingText(entry={}){
    const tags=(Array.isArray(entry.tags)?entry.tags:[]).map(tag=>typeof tag==='string'?tag:tag?.name).filter(Boolean).join(' ');
    const threadEntries=Array.isArray(entry.entries)?entry.entries.map(row=>[row?.period||row?.storyTime||row?.time,row?.event||row?.title||row?.summary||row?.note,row?.status].filter(Boolean).join(' ')).join('\n'):'';
    const relations=Array.isArray(entry.relationships)?entry.relationships.map(row=>[row?.name||row?.n,row?.type||row?.r,row?.attitude||row?.a].filter(Boolean).join(' ')).join('\n'):'';
    const edges=Array.isArray(entry.edges)?entry.edges.map(row=>[row?.toName||row?.toId||row?.to,row?.distance,row?.pathType||row?.type,row?.difficulty].filter(Boolean).join(' ')).join('\n'):'';
    return [entry.title,entry.name,entry.summary,entry.content,entry.description,entry.event,entry.significance,entry.role,entry.personality,entry.location,entry.region,entry.subject,entry.target,threadEntries,relations,edges,tags].filter(Boolean).join('\n').slice(0,1200);
}

export function memoryEmbeddingHash(entry){return fnvHash(memoryEmbeddingText(entry));}

export function decodeMemoryVector(record){
    if(!record||!Number.isInteger(record.dims)||record.dims<=0||record.dims>65536)return null;
    if(Array.isArray(record.embedding))return finiteVector(record.embedding)&&record.embedding.length===record.dims?[...record.embedding]:null;
    if(record.encoding!=='f16-base64'||typeof record.vector!=='string'||record.vector.length>180000||!record.vector||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.vector))return null;
    let binary;try{binary=atob(record.vector);}catch{return null;}
    if(binary.length!==record.dims*2)return null;
    const result=[];
    for(let index=0;index<binary.length;index+=2){
        const half=binary.charCodeAt(index)|(binary.charCodeAt(index+1)<<8),sign=half&0x8000?-1:1,exp=(half>>10)&31,mant=half&1023;
        if(exp===31)return null;
        result.push(sign*(exp===0?mant*2**-24:(1+mant/1024)*2**(exp-15)));
    }
    return finiteVector(result)?result:null;
}

export function hydrateMemoryVectors(data,bank,queryModel){
    const result=structuredClone(data),model=String(queryModel??'').trim();
    const records=new Map(Array.isArray(bank?.records)?bank.records.filter(record=>record?.id!==undefined&&record?.id!==null).map(record=>[String(record.id),record]):Object.entries(bank?.records??{}));
    for(const key of collections)for(const entry of Array.isArray(result?.[key])?result[key]:[]){
        if(!entry||typeof entry!=='object')continue;
        const inline=entry.embedding;delete entry.embedding;
        if(!model)continue;
        const ref=entry.embeddingRef,record=ref?.id!==undefined&&ref?.id!==null?records.get(String(ref.id)):null;
        // Old BB-Memory slots stored inline arrays with no model marker. The
        // host reports this compatibility limit; a present model must match.
        if(finiteVector(inline)&&(!entry.embeddingModel||entry.embeddingModel===model)&&(!ref?.model||ref.model===model)&&(!ref?.dims||ref.dims===inline.length)&&(!ref?.textHash||ref.textHash===memoryEmbeddingHash(entry))){entry.embedding=[...inline];continue;}
        if(!model||!ref||!record||String(record.id)!==String(ref.id)||ref.model!==model||record.model!==model||!Number.isInteger(ref.dims)||ref.dims!==record.dims||!ref.textHash||ref.textHash!==record.textHash||ref.textHash!==memoryEmbeddingHash(entry))continue;
        const vector=decodeMemoryVector(record);if(vector&&vector.length===ref.dims)entry.embedding=vector;
    }
    return result;
}

export function memoryCosineSimilarity(left,right){
    if(!finiteVector(left)||!finiteVector(right)||left.length!==right.length)return 0;
    // Scaling protects finite but very large imported components from overflow.
    let aScale=0,bScale=0;for(let i=0;i<left.length;i++){aScale=Math.max(aScale,Math.abs(left[i]));bScale=Math.max(bScale,Math.abs(right[i]));}if(!aScale||!bScale)return 0;
    let dot=0,aSquared=0,bSquared=0;for(let i=0;i<left.length;i++){const a=left[i]/aScale,b=right[i]/bScale;dot+=a*b;aSquared+=a*a;bSquared+=b*b;}
    return Math.max(-1,Math.min(1,dot/Math.sqrt(aSquared*bSquared)));
}

function tokens(query){
    const result=new Set();
    for(const word of normalize(query).match(/[a-z0-9_]{2,}|[\p{Script=Han}]{2,}/gu)??[]){
        if(/^[a-z0-9_]+$/.test(word))result.add(word);
        else {if(word.length<=8)result.add(word);for(let i=0;i<word.length-1&&result.size<512;i++)result.add(word.slice(i,i+2));}
        if(result.size>=512)break;
    }
    return [...result];
}

function matching(entry,query,queryTokens,embedding,threshold=.62){
    if(!query)return {hit:false,keyword:0,similarity:0};
    const names=[entry.name,entry.title,entry.subject,entry.target,...(Array.isArray(entry.aliases)?entry.aliases:[])].map(normalize).filter(text=>text.length>=2);
    const direct=names.some(name=>query.includes(name));
    const text=normalize([entry.name,entry.title,entry.content,entry.summary,entry.description,entry.event,entry.significance,entry.role,entry.personality,entry.appearance,entry.location,entry.owner,entry.subject,entry.target,entry.impact,entry.storyTime,...tagNames(entry),...(Array.isArray(entry.keywords)?entry.keywords:[])].filter(value=>typeof value==='string').join(' '));
    const matches=queryTokens.filter(token=>text.includes(token)).length;
    const keyword=direct?1:queryTokens.length?matches/queryTokens.length:0;
    const similarity=memoryCosineSimilarity(embedding,entry.embedding);
    return {hit:direct||matches>0||(similarity>0&&similarity>=threshold),keyword,similarity};
}

function projection(entry,kind,mode){
    if(mode==='full')return memoryArchiveContent(entry);
    const keys=kind==='npc'?['id','name','npcTier','role','status','location']:
        kind==='items'?['id','name','itemTier','owner','status','location','quantity']:
        kind==='timeline'?['id','name','title','summary','status','priority']:
        kind==='milestones'?['id','title','summary','event','storyTime','status','timelineName']:
        ['id','title','summary','type','memoryTier','subject','target','storyTime'];
    const result=Object.fromEntries(keys.filter(key=>Object.hasOwn(entry,key)).map(key=>[key,typeof entry[key]==='string'?entry[key].slice(0,key==='summary'||key==='event'?400:160):entry[key]]));
    if(kind==='memories'&&!result.summary&&typeof entry.content==='string')result.summary=entry.content.slice(0,400);
    return memoryArchiveContent(result);
}

function hit(entry,kind,mode,score=0){return {id:entry.id,mode,score,material:projection(entry,kind,mode)};}
function tierRank(entry,key){return ({core:0,important:1,minor:2,background:3,key:0,equipped:1,clue:2,consumable:3})[entry[key]]??2;}

export function retrieveMemory(data,query,settings={},queryEmbedding=null){
    for(const key of collections)if(!Array.isArray(data?.[key]))throw Error(`BB-Memory 存档缺少 ${key} 数据，未进行记忆检索`);
    const activeCategories=settings.enabledCategories??{},categoryEnabled=Object.values(activeCategories).some(value=>value===true);
    const eligible=entry=>!archived(entry)&&(!categoryEnabled||!entry.category||activeCategories[entry.category]===true);
    const lists=Object.fromEntries(collections.map(key=>[key,unique(data[key]).filter(eligible)]));
    const text=normalize(query),queryTokens=tokens(query),embedding=finiteVector(queryEmbedding)?queryEmbedding:null;
    const evidence=(entry,threshold)=>matching(entry,text,queryTokens,embedding,threshold);
    const quality=entry=>(Number(entry.updatedAt)||0);
    const result={hits:[],npcHits:[],itemHits:[],timelineHits:[],milestoneHits:{foreshadow:[],ongoing:[],ended:[]},notes:[],queryMode:embedding?'vector':'keyword'};

    const npc=lists.npc.map(entry=>({entry,e:evidence(entry)})).filter(({entry,e})=>e.hit||resident(entry)||['core','important'].includes(entry.npcTier));
    npc.sort((a,b)=>Number(b.e.hit)-Number(a.e.hit)||tierRank(a.entry,'npcTier')-tierRank(b.entry,'npcTier')||quality(b.entry)-quality(a.entry));
    result.npcHits=npc.slice(0,limit(settings.npcInjectionMax,8)).map(({entry,e})=>hit(entry,'npc',e.hit?'full':'index',e.similarity||e.keyword));

    const frequentThreshold=limit(settings.itemResidentHitCountThreshold,5,100000),fallbackProbability=limit(settings.itemFallbackInjectionProbability,5),fallbackMax=limit(settings.itemFallbackInjectionMax,2,50);
    const itemGroups={matched:[],frequent:[],fallback:[]};
    for(const entry of lists.items){
        const e=evidence(entry),dusty=entry.memoryTier==='transient'||entry.status==='dusty';
        if(e.hit&&!dusty)itemGroups.matched.push({entry,e,mode:'full'});
        else if(resident(entry)||(Number(entry.hitCount)||0)>=frequentThreshold)itemGroups.frequent.push({entry,e,mode:'index'});
        else if(!dusty&&fallbackProbability>0){
            const roll=parseInt(memoryVectorBankKey(`${entry.id||entry.name}|${text}`).slice('bb_vec_bank_'.length),36)%100;
            if(roll<fallbackProbability)itemGroups.fallback.push({entry,e,mode:'index'});
        }
    }
    const itemSort=(a,b)=>tierRank(a.entry,'itemTier')-tierRank(b.entry,'itemTier')||(Number(b.entry.hitCount)||0)-(Number(a.entry.hitCount)||0)||quality(b.entry)-quality(a.entry);
    for(const group of Object.values(itemGroups))group.sort(itemSort);
    result.itemHits=[...itemGroups.matched,...itemGroups.frequent,...itemGroups.fallback.slice(0,fallbackMax)].slice(0,limit(settings.itemInjectionMax,5)).map(({entry,e,mode})=>hit(entry,'items',mode,e.similarity||e.keyword));

    const milestoneResident=entry=>resident(entry)||!['stable','transient'].includes(entry.memoryTier)&&entry.status!=='dusty'&&entry.injectionMode!=='vector';
    const milestoneRows=lists.milestones.map(entry=>({entry,e:evidence(entry)}));
    const milestoneMatches=milestoneRows.filter(({entry,e})=>!milestoneResident(entry)&&e.hit).sort((a,b)=>(Number(b.entry.storyTimeSort)||quality(b.entry))-(Number(a.entry.storyTimeSort)||quality(a.entry))).slice(0,limit(settings.milestoneVectorMax??settings.timelineEndedMax,3));
    for(const {entry,e} of [...milestoneRows.filter(({entry})=>milestoneResident(entry)),...milestoneMatches]){
        const group=entry.status==='foreshadow'||tagNames(entry).some(tag=>/伏笔|待兑现|待揭示/.test(tag))?'foreshadow':entry.status==='ongoing'||entry.isActive?'ongoing':'ended';
        result.milestoneHits[group].push(hit(entry,'milestones',e.hit?'full':'summary',e.similarity||e.keyword));
    }

    if(settings.timelineSummaryEnabled!==false){
        const priority={resident:0,high:1,medium:2,low:3},rows=[...lists.timeline].sort((a,b)=>(priority[a.priority??'medium']??2)-(priority[b.priority??'medium']??2)||quality(b)-quality(a));
        const selected=[...rows.filter(resident),...rows.filter(entry=>!resident(entry)).slice(0,limit(settings.maxActiveTimeline??settings.maxActiveThreads,5))];
        result.timelineHits=selected.map(entry=>{const e=evidence(entry);return hit(entry,'timeline',e.hit?'full':'summary',e.similarity||e.keyword);});
    }

    const memoryRows=[],memoryResidents=[],minScore=bounded(settings.minScoreThreshold,.05,0,1),eternalThreshold=bounded(settings.eternalMatchThreshold,.62,0,1),now=Date.now();
    for(const entry of lists.memories){
        const isDaily=daily(entry),e=evidence(entry,entry.memoryTier==='eternal'?eternalThreshold:.62);
        const isEternal=entry.memoryTier==='eternal'&&!isDaily;
        const eternalRule=settings.eternalInjectionMode==='all'?'always':settings.eternalInjectionMode==='priority'?(['always','summary','matched'].includes(entry.eternalInjectionPriority)?entry.eternalInjectionPriority:'matched'):settings.eternalUnmatchedMode==='summary'?'summary':'matched';
        if(isEternal&&!e.hit){
            if(eternalRule==='always')memoryResidents.push(hit(entry,'memories','full',1));
            else if(eternalRule==='summary')memoryRows.push(hit(entry,'memories','summary',0));
            continue;
        }
        if(!isDaily&&(!isEternal&&resident(entry)||isEternal&&eternalRule==='always')){
            memoryResidents.push(hit(entry,'memories',e.hit||isEternal?'full':'summary',1));continue;
        }
        if(!e.hit)continue;
        const created=Number(entry.lastHitAt??entry.createdAt)||now,age=Math.max(0,now-created),window=7*24*60*60*1000;
        const recency=age>=window?Math.max(.1,1-Math.log10(age/window+1)*.5):1-age/window*.5;
        const tier={eternal:1,core:.8,stable:.5,transient:.3}[entry.memoryTier]??.3;
        const multiplier=isDaily?bounded(settings.dailyMemoryScoreMultiplier,.35,0,1):1;
        const tierMultiplier={eternal:1.15,core:1.05,stable:1,transient:.9}[entry.memoryTier]??1;
        const score=Math.max(0,Math.min(1,(e.keyword*.35+Math.max(0,e.similarity)*.25+recency*.1+tier*.3)*multiplier*tierMultiplier));
        if(!isEternal&&score<minScore)continue;
        const mode=isDaily?(e.similarity>0&&e.similarity>=bounded(settings.dailyMemoryFullSimilarity,.95,0,1)?'full':'summary'):isEternal?'full':entry.memoryTier==='transient'?'summary':score>=.55?'full':score>=.3?'summary':'index';
        memoryRows.push(hit(entry,'memories',mode,score));
    }
    memoryRows.sort((a,b)=>b.score-a.score);
    result.hits=[...memoryResidents,...memoryRows.slice(0,limit(settings.maxResults,10))];
    result.notes.push('只读当前已保存槽，按本次任务与聊天上下文检索；参考 BB-Memory 的向量、关键词、分类与常驻规则，未更新记忆或命中计数');
    if(embedding&&collections.some(key=>lists[key].some(entry=>finiteVector(entry.embedding)&&!entry.embeddingRef?.model&&!entry.embeddingModel)))result.notes.push('部分旧存档向量没有模型标识，仅按维数兼容读取；请在 BB-Memory 完成向量升级后再验证语义命中质量');
    if(!embedding)result.notes.push('本次没有可用查询向量，按关键词与常驻规则选择；没有展开未命中的人物、物品或普通记忆正文');
    if([...result.npcHits,...result.itemHits,...result.timelineHits,...Object.values(result.milestoneHits).flat(),...result.hits].some(row=>row.mode!=='full'))result.notes.push('未命中的常驻资料仅提供索引或摘要；详细正文只在命中或明确设置常驻全文时提供');
    return result;
}
