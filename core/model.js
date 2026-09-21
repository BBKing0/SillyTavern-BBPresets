import {sha256} from './digest.js';
import {validateDraft} from './initialization.js';
import {validatePrompts} from './prompt-templates.js';
import {sourcePrefixes} from './source-prefix.js';
export const SCHEMA = 1;
export const OUTLINE_KINDS = ['core','line','chapter','clue'];
export const AUTHOR_KINDS = ['guide','focus','experience'];
export const KINDS = [...OUTLINE_KINDS, 'world', 'guide', 'focus', 'experience'];
export const DEFAULTS = Object.freeze({ enabled: true, mode: 'semi', timing: 'background', connection: 'custom', plotConnection:'main', frequency: 1, reflectionFrequency: 8, reflectionEnabled: false, contextRounds: 6, maxInputChars: 40000, injectionChars: 12000, timeoutSeconds: 90, endpoint: '', model: '', memoryRead: false, memoryFollow: false, feedbackThreshold:5, waitOutline:true, prompts:{} });
export function recordCounts(doc) {
    const counts={outline:0,writing:0,reference:0,archived:0,total:doc.records.length};
    for(const r of doc.records){if(r.status==='archived')counts.archived++;counts[OUTLINE_KINDS.includes(r.kind)?'outline':AUTHOR_KINDS.includes(r.kind)?'writing':'reference']++;}
    return counts;
}
export const copy = value => structuredClone(value);
export const uid = () => {if(globalThis.crypto?.randomUUID)return crypto.randomUUID();const b=crypto.getRandomValues(new Uint8Array(16));return [...b].map(n=>n.toString(16).padStart(2,'0')).join('');};
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function assert(condition, message) { if (!condition) throw new Error(message); }
export async function hash(text) {const bytes=new TextEncoder().encode(text);return globalThis.crypto?.subtle?[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join(''):sha256(bytes);}
const text = (value, max = 16000) => typeof value === 'string' && value.length <= max;
export function validId(id) { return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id) && !['__proto__','prototype','constructor'].includes(id); }
function keys(value, allowed) { assert(Object.keys(value).every(k=>allowed.includes(k)), '包含不支持的字段'); }
export function validateRecord(r) {
    assert(r && validId(r.id) && KINDS.includes(r.kind), '条目身份或类别无效');
    keys(r,['id','kind','title','blocks','locked','truth','status','importance','origin','sources','joiner','keywords','summary','links']);
    assert(r.summary===undefined||text(r.summary,500),'条目摘要过长');
    assert(r.keywords===undefined||(Array.isArray(r.keywords)&&r.keywords.length<=30&&r.keywords.every(k=>text(k,100)&&k.trim())),'关键词格式无效');
    assert(r.links===undefined||(Array.isArray(r.links)&&r.links.length<=50&&r.links.every(validId)),'关联条目格式无效');
    assert(r.joiner===undefined||['','\n\n'].includes(r.joiner),'文字连接方式无效');
    assert(text(r.title, 300) && typeof r.locked === 'boolean', '条目标题或保护设置无效');
    assert(['plan', 'intent', 'event', 'guidance'].includes(r.truth), '事实状态无效');
    assert(['active', 'archived'].includes(r.status), '条目状态无效');
    assert(['minor', 'major'].includes(r.importance), '重要程度无效');
    assert(['manual', 'world', 'feedback', 'reflection', 'initialization','outline'].includes(r.origin), '条目来源类别无效');
    assert(Array.isArray(r.sources) && r.sources.length <= 5000 && r.sources.every(s => text(s.chatKey, 500) && validId(s.id) && text(s.hash, 100)), '来源无效');
    assert(Array.isArray(r.blocks) && r.blocks.length > 0 && r.blocks.length <= 100, '文字段落数量无效');
    const ids = new Set();
    for (const b of r.blocks) { keys(b,['id','text','locked']); assert(validId(b.id) && !ids.has(b.id) && text(b.text,150000) && typeof b.locked === 'boolean', '文字段落无效'); ids.add(b.id); }
    return r;
}
export function validateDocument(doc) {
    assert(doc && doc.schema === SCHEMA && ['profile', 'story','author'].includes(doc.type) && validId(doc.id), '不是支持的 BBPresets 文档');
    keys(doc,['schema','type','id','title','records','history','feedback','proposals','processed','conflicts','excluded','jobs','settings','bindings','memoryBinding','parent','initializationDrafts','manualSavedAt','authorVersion','controls','retiredTasks','activeAuthorId']);
    assert(doc.activeAuthorId===undefined||doc.type==='profile'&&validId(doc.activeAuthorId),'当前作者身份无效');
    if(doc.type==='author')assert(doc.records.every(r=>AUTHOR_KINDS.includes(r.kind)),'作者只能保存写作偏好与经验');
    assert(doc.authorVersion===undefined||doc.authorVersion===5,'作者资料版本不支持');
    if(doc.retiredTasks!==undefined)assert(Array.isArray(doc.retiredTasks)&&doc.retiredTasks.length<=6000,'旧任务记录无效');
    if(doc.initializationDrafts!==undefined){assert(Array.isArray(doc.initializationDrafts),'初始化草稿列表无效');const chats=new Set();for(const draft of doc.initializationDrafts){validateDraft(draft);assert(!chats.has(draft.chatKey),'初始化草稿聊天重复');chats.add(draft.chatKey);}}
    if(doc.manualSavedAt!==undefined)assert(Number.isFinite(doc.manualSavedAt),'手动存档时间无效');
    assert(text(doc.title, 300) && Array.isArray(doc.records) && doc.records.length <= 3000, '文档内容无效');
    const ids = new Set();
    for (const r of doc.records) { validateRecord(r); assert(!ids.has(r.id), '重复条目 ID'); ids.add(r.id); }
    for (const key of ['history', 'feedback', 'proposals', 'processed', 'conflicts', 'excluded', 'jobs']) assert(Array.isArray(doc[key]), `缺少 ${key}`);
    assert(doc.feedback.length <= 5000 && doc.jobs.length <= 5000 && doc.proposals.length <= 1000, '资料数量超过单档上限，请导出归档');
    for (const f of doc.feedback) assert(validId(f.id) && text(f.quote, 50000) && text(f.note) && ['saved', 'queued', 'processed', 'withdrawn'].includes(f.status), '点评数据无效');
    for (const f of doc.feedback) {
        assert(f.category===undefined||['plot','writing'].includes(f.category),'点评分类无效');
        assert(f.connection===undefined||['main','custom'].includes(f.connection),'点评连接无效');
        assert(f.category!=='plot'||doc.type==='story'&&text(f.chatKey,500),'剧情点评必须属于故事和聊天');
    }
    const source=s=>s&&text(s.chatKey,500)&&validId(s.id)&&text(s.hash,100);
    for(const c of doc.controls??[])assert(c?.prefixHash===undefined||typeof c.prefixHash==='string'&&/^[a-f0-9]{64}$/.test(c.prefixHash),'控制记录来源摘要无效');
    if(doc.controls!==undefined){assert(Array.isArray(doc.controls)&&doc.controls.length<=5000,'控制记录超过上限，请建立新分支或存档');for(const c of doc.controls){assert(c&&validId(c.id)&&source(c.source)&&Array.isArray(c.sources)&&c.sources.every(source)&&text(c.chatKey,500)&&text(c.token,100)&&Number.isFinite(c.at)&&Array.isArray(c.nextIds)&&c.nextIds.length<=12&&c.nextIds.every(validId),'控制记录格式无效');if(c.chapter)assert(text(c.chapter.title,160)&&text(c.chapter.progress,500)&&Array.isArray(c.chapter.lineIds)&&c.chapter.lineIds.every(validId),'章节状态无效');}}
    for(const f of doc.feedback)assert(!f.source||source(f.source),'点评来源无效');
    assert(doc.processed.every(x=>text(x,300))&&doc.excluded.every(validId),'处理记录或排除列表无效');
    for(const h of doc.history){
        assert(h&&validId(h.id)&&text(h.key,300)&&['user','ai','system'].includes(h.actor)&&Array.isArray(h.sources)&&h.sources.every(source)&&Array.isArray(h.changes),'历史变更格式无效');
        assert(!h.anchor||source(h.anchor),'历史锚点无效');
        assert(!h.feedbackIds||Array.isArray(h.feedbackIds)&&h.feedbackIds.every(validId),'历史点评依据无效');
        for(const c of h.changes){assert(c&&validId(c.id),'历史条目身份无效');for(const r of [c.before,c.after])if(r){validateRecord(r);assert(r.id===c.id,'历史条目归属不符');}}
    }
    for(const j of [...doc.jobs,...doc.proposals])assert(j&&validId(j.id)&&text(j.key,300)&&['world','feedback','reflection','initialization','outline'].includes(j.kind)&&text(j.chatKey,500)&&text(j.input,150000)&&Array.isArray(j.sources)&&j.sources.every(source)&&Array.isArray(j.feedback)&&j.feedback.every(f=>text(f.note)),'维护任务格式无效');
    for(const j of [...doc.jobs,...doc.proposals])assert(j.connection===undefined||['main','custom'].includes(j.connection),'任务连接无效');
    if (doc.type === 'profile') validateSettings(doc.settings);
    assert(JSON.stringify(doc).length <= 4_000_000, '单档超过 400 万字符，请先导出并建立新档');
    return doc;
}
export function validateSettings(s) {
    assert(s && ['auto','semi','manual'].includes(s.mode) && ['background','before'].includes(s.timing) && ['main','custom'].includes(s.connection), '维护设置无效');
    keys(s,Object.keys(DEFAULTS));
    validatePrompts(s.prompts);
    assert(s.plotConnection===undefined||['main','custom'].includes(s.plotConnection),'剧情点评连接无效');
    assert(s.feedbackThreshold===undefined||Number.isInteger(s.feedbackThreshold)&&s.feedbackThreshold>=1&&s.feedbackThreshold<=100,'点评总结阈值须为 1—100');
    assert(s.waitOutline===undefined||typeof s.waitOutline==='boolean','等待修订设置无效');
    for (const [k, min, max] of [['frequency',1,100],['reflectionFrequency',1,500],['contextRounds',1,30],['maxInputChars',2000,150000],['injectionChars',500,40000],['timeoutSeconds',10,300]]) assert(Number.isInteger(s[k]) && s[k] >= min && s[k] <= max, `${k} 超出范围 ${min}—${max}`);
    for (const k of ['enabled','reflectionEnabled','memoryRead','memoryFollow']) assert(typeof s[k] === 'boolean', `${k} 必须为开关`);
    assert(text(s.endpoint,2000) && text(s.model,300), '连接设置无效');
    if(s.endpoint){let url;try{url=new URL(s.endpoint);}catch{throw Error('API 地址无效');}assert(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash,'不要将密钥或查询参数放入 API 地址');}
    return s;
}
export function newDocument(type = 'story', title = '新故事', id = uid()) {
    return { schema: SCHEMA, authorVersion:5, type, id, title, records: [], history: [], feedback: [], proposals: [], processed: [], conflicts: [], excluded: [], jobs: [], ...(type === 'profile' ? { settings: copy(DEFAULTS) } : { bindings: [], memoryBinding: null, parent: null, controls:[] }) };
}
export function migrateAuthor(doc) {
    const next=copy(doc);
    if(next.type==='profile')next.settings={...copy(DEFAULTS),...next.settings};
    if(next.authorVersion===5)return validateDocument(next);
    next.authorVersion=5;
    if(next.type==='story'){
        next.controls??=[];
        const obsolete=j=>['world','reflection'].includes(j.kind);
        next.retiredTasks=[...(next.retiredTasks??[]),...next.jobs.filter(obsolete),...next.proposals.filter(obsolete)].map(j=>({...j,state:'retired'}));
        next.jobs=next.jobs.filter(j=>!obsolete(j));next.proposals=next.proposals.filter(j=>!obsolete(j));
    }
    return validateDocument(next);
}
export function record({id = uid(), kind = 'world', title = '', body = '', ...rest} = {}) {
    return validateRecord({ id, kind, title, blocks: [{id:uid(),text:body,locked:false}], locked:false, truth:OUTLINE_KINDS.includes(kind)?'plan':kind === 'world' ? 'intent' : 'guidance', status:'active', importance:'minor', origin:'manual', sources:[], ...rest });
}
function canChange(before, after, actor) {
    if (!before || actor === 'user') return;
    assert(!before.locked || same(before, after), 'AI 不得编辑或删除保留条目');
    for (const b of before.blocks.filter(b => b.locked)) {
        const target = after?.blocks.find(x => x.id === b.id);
        assert(target && target.text === b.text && target.locked, 'AI 不得改写、移除或解除保留文字');
    }
    if (before.blocks.some(b => b.locked)) assert(after?.kind === before.kind && after?.title === before.title && after?.status === before.status, '含保留文字的条目不能被 AI 改名、改类或归档');
}
export function applyChanges(doc, changes, { actor = 'ai', origin = 'world', sources = [], key = uid(), anchor = null, feedbackIds = [] } = {}) {
    validateDocument(doc);
    assert(Array.isArray(changes) && changes.length <= 100, '一次最多 100 个变更');
    if (doc.processed.includes(key)) return copy(doc);
    const next = copy(doc), diffs = [], seen = new Set();
    for (const change of changes) {
        assert(change && ['put','remove'].includes(change.op), '不支持的操作');
        const id = change.op === 'put' ? change.record?.id : change.id;
        assert(validId(id) && !seen.has(id), '无效或重复操作 ID'); seen.add(id);
        const index = next.records.findIndex(r => r.id === id), before = index < 0 ? null : copy(next.records[index]);
        let after = null;
        if (change.op === 'put') {
            after = copy(change.record);
            if (actor !== 'user') {
                // Models never own protection or provenance. Do not accept permission flags in model output.
                assert(after.locked === undefined && after.origin === undefined && after.sources === undefined && after.joiner === undefined && after.blocks?.every(b => b.locked === undefined), '模型不能提供保护、来源或权限字段');
                if(before?.joiner!==undefined)after.joiner=before.joiner;
                after.locked = before?.locked ?? false;
                after.blocks = after.blocks.map(b => ({...b, locked:before?.blocks.find(x=>x.id === b.id)?.locked ?? false}));
                after.origin = origin;
                after.sources = [...new Map([...(before?.sources ?? []),...sources].map(s => [`${s.chatKey}:${s.id}:${s.hash}`,s])).values()];
                if (origin === 'reflection') assert(after.kind === 'experience'&&(!before||before.kind==='experience'), '自我总结只能修改作者经验');
                if (origin === 'world') assert(['world','focus'].includes(after.kind)&&(!before||['world','focus'].includes(before.kind)), '世界维护不能冒充用户偏好');
                if (origin === 'feedback') assert(['guide','focus','experience'].includes(after.kind)&&(!before||['guide','focus','experience'].includes(before.kind)), '点评不能改写世界事实');
                if (origin === 'outline') assert(OUTLINE_KINDS.includes(after.kind)&&(!before||OUTLINE_KINDS.includes(before.kind)), '改纲只能修改大纲条目');
            } else after.origin='manual';
            validateRecord(after);
        } else {
            assert(before, '不能删除不存在的条目');
            if (actor !== 'user' && origin === 'reflection') assert(before.kind === 'experience', '自总结只能删除作者经验');
            if (actor !== 'user' && origin === 'world') assert(['world','focus'].includes(before.kind), '世界维护不能删除用户指南');
            if (actor !== 'user' && origin === 'feedback') assert(['guide','focus','experience'].includes(before.kind), '点评不能删除世界事实');
            if (actor !== 'user' && origin === 'outline') assert(OUTLINE_KINDS.includes(before.kind), '改纲不能删除写作偏好');
        }
        canChange(before, after, actor);
        if (after && index < 0) next.records.push(after);
        else if (after) next.records[index] = after;
        else next.records.splice(index,1);
        next.excluded = next.excluded.filter(x => x !== id);
        diffs.push({id,before,after});
    }
    next.history.push({id:uid(),key,actor,origin,sources:copy(sources),anchor,feedbackIds:copy(feedbackIds),at:Date.now(),changes:diffs});
    next.processed.push(key);
    return validateDocument(next);
}
export function invalidateSources(doc, chatKey, currentSources) {
    const next = copy(doc), hashes = new Map(currentSources.map(x=>[x.id,x.hash]));
    const invalid = r => r?.sources?.some(s=>s.chatKey === chatKey && hashes.get(s.id) !== s.hash);
    // A source-invalid deletion has no current record to visit. Restore its before-image
    // only when it is still the last change for that ID (never undo a later user edit).
    const latest=new Map();for(const h of next.history)for(const c of h.changes)latest.set(c.id,{h,c});
    for(const {h,c} of latest.values())if(!c.after&&h.actor==='ai'&&['world','outline','initialization'].includes(h.origin)&&invalid(h)&&!next.records.some(r=>r.id===c.id)&&c.before&&!invalid(c.before)){
        next.records.push(copy(c.before));next.history.push({id:uid(),key:uid(),actor:'system',origin:'invalidation',sources:[],anchor:null,at:Date.now(),changes:[{id:c.id,before:null,after:copy(c.before)}]});
    }
    for (const r of [...next.records]) {
        // Feedback and deliberate author experience survive a changed source passage.
        if (!['world','focus',...OUTLINE_KINDS].includes(r.kind) || !invalid(r)) continue;
        const hasProtection = r.locked || r.blocks.some(b=>b.locked);
        if (hasProtection || r.origin === 'manual') {
            if (!next.excluded.includes(r.id)) next.excluded.push(r.id);
            if (!next.conflicts.some(c=>c.recordId === r.id && c.reason === 'source')) next.conflicts.push({id:uid(),recordId:r.id,reason:'source',at:Date.now()});
            continue;
        }
        let previous = null;
        for (const h of [...next.history].reverse()) {
            const c = h.changes.find(c=>c.id === r.id);
            if (c?.before && !invalid(c.before)) { previous = copy(c.before); break; }
        }
        const idx = next.records.findIndex(x=>x.id === r.id);
        if (previous) next.records[idx] = previous; else next.records.splice(idx,1);
        next.history.push({id:uid(),key:uid(),actor:'system',origin:'invalidation',sources:[],anchor:null,at:Date.now(),changes:[{id:r.id,before:r,after:previous}]});
    }
    for (const f of next.feedback) if (f.source?.chatKey === chatKey) f.sourceChanged = hashes.get(f.source.id) !== f.source.hash;
    next.jobs = next.jobs.filter(j=> !(j.sources ?? []).some(s=>s.chatKey === chatKey && hashes.get(s.id) !== s.hash));
    next.proposals = next.proposals.filter(j=> !(j.sources ?? []).some(s=>s.chatKey === chatKey && hashes.get(s.id) !== s.hash));
    return validateDocument(next);
}
export function forkAt(doc, {title, chatKey, sources, anchorIds, destinationChatKey=chatKey}) {
    const next = newDocument('story',title), allowed = new Set(anchorIds ?? sources.map(s=>s.id)), hashes = new Map(sources.map(s=>[s.id,s.hash]));
    next.parent = {storyId:doc.id,chatKey,sourceIds:[...allowed],at:Date.now()};
    for (const event of doc.history) {
        if (event.actor === 'user' && event.anchor?.chatKey === chatKey && (!allowed.has(event.anchor.id)||hashes.get(event.anchor.id)!==event.anchor.hash)) continue;
        if (event.sources.some(s=>s.chatKey === chatKey && hashes.get(s.id) !== s.hash)) continue;
        if (event.origin === 'invalidation') continue;
        for (const c of event.changes) {
            const idx = next.records.findIndex(r=>r.id === c.id);
            if (c.after && idx < 0) next.records.push(copy(c.after));
            else if (c.after) next.records[idx] = copy(c.after);
            else if (idx >= 0) next.records.splice(idx,1);
        }
        next.history.push(copy(event)); next.processed.push(event.key);
    }
    const remap=s=>s?.chatKey===chatKey?{...s,chatKey:destinationChatKey}:s;
    for(const r of next.records)r.sources=r.sources.map(remap);
    for(const h of next.history){h.sources=h.sources.map(remap);h.anchor=remap(h.anchor);for(const c of h.changes)for(const r of [c.before,c.after])if(r)r.sources=r.sources.map(remap);}
    const prefixes=sourcePrefixes(sources);
    next.controls=copy((doc.controls??[]).filter(c=>c.sources.every(s=>s.chatKey===chatKey&&allowed.has(s.id)&&hashes.get(s.id)===s.hash)&&(!c.prefixHash||prefixes.get(c.source.id)===c.prefixHash)));
    for(const c of next.controls){c.chatKey=destinationChatKey;c.source=remap(c.source);c.sources=c.sources.map(remap);}
    // Inherit only feedback whose original passage belongs to the shared branch prefix.
    next.feedback=copy(doc.feedback.filter(f=>f.category==='plot'&&f.chatKey===chatKey&&f.source&&allowed.has(f.source.id)&&hashes.get(f.source.id)===f.source.hash));
    for(const f of next.feedback){f.chatKey=destinationChatKey;f.source=remap(f.source);if(f.status==='queued')f.status='saved';}
    next.excluded=doc.excluded.filter(id=>next.records.some(r=>r.id===id));
    next.conflicts=copy(doc.conflicts.filter(c=>next.excluded.includes(c.recordId)));
    return validateDocument(next);
}
export function restoreDocument(current, historical) {
    validateDocument(historical);
    assert(current.id === historical.id && current.type === historical.type, '恢复文档归属不符');
    const next = copy(historical);
    for (const r of current.records) {
        const restored = next.records.find(x=>x.id === r.id);
        canChange(r, restored ?? null, 'restore');
    }
    // Recovery is a new version, retaining the complete audit trail and current feedback.
    next.history = [...current.history,{id:uid(),key:uid(),actor:'user',origin:'restore',sources:[],anchor:null,at:Date.now(),changes:current.records.map(r=>({id:r.id,before:copy(r),after:next.records.find(x=>x.id===r.id) ?? null})).concat(next.records.filter(r=>!current.records.some(x=>x.id===r.id)).map(r=>({id:r.id,before:null,after:copy(r)})))}];
    next.feedback = copy(current.feedback); next.jobs = []; next.proposals = [];
    if(current.initializationDrafts)next.initializationDrafts=copy(current.initializationDrafts);
    return validateDocument(next);
}
