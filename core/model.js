import {sha256} from './digest.js';
export const SCHEMA = 1;
export const KINDS = ['world', 'guide', 'focus', 'experience'];
export const DEFAULTS = Object.freeze({ enabled: true, mode: 'semi', timing: 'background', connection: 'main', frequency: 1, reflectionFrequency: 8, reflectionEnabled: true, contextRounds: 6, maxInputChars: 40000, injectionChars: 9000, timeoutSeconds: 90, endpoint: '', model: '', memoryRead: false, memoryFollow: false });
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
    keys(r,['id','kind','title','blocks','locked','truth','status','importance','origin','sources']);
    assert(text(r.title, 300) && typeof r.locked === 'boolean', '条目标题或保护设置无效');
    assert(['plan', 'intent', 'event', 'guidance'].includes(r.truth), '事实状态无效');
    assert(['active', 'archived'].includes(r.status), '条目状态无效');
    assert(['minor', 'major'].includes(r.importance), '重要程度无效');
    assert(['manual', 'world', 'feedback', 'reflection', 'initialization'].includes(r.origin), '条目来源类别无效');
    assert(Array.isArray(r.sources) && r.sources.length <= 5000 && r.sources.every(s => text(s.chatKey, 500) && validId(s.id) && text(s.hash, 100)), '来源无效');
    assert(Array.isArray(r.blocks) && r.blocks.length > 0 && r.blocks.length <= 100, '文字段落数量无效');
    const ids = new Set();
    for (const b of r.blocks) { keys(b,['id','text','locked']); assert(validId(b.id) && !ids.has(b.id) && text(b.text) && typeof b.locked === 'boolean', '文字段落无效'); ids.add(b.id); }
    return r;
}
export function validateDocument(doc) {
    assert(doc && doc.schema === SCHEMA && ['profile', 'story'].includes(doc.type) && validId(doc.id), '不是支持的 BBPresets 文档');
    keys(doc,['schema','type','id','title','records','history','feedback','proposals','processed','conflicts','excluded','jobs','settings','bindings','memoryBinding','parent']);
    assert(text(doc.title, 300) && Array.isArray(doc.records) && doc.records.length <= 3000, '文档内容无效');
    const ids = new Set();
    for (const r of doc.records) { validateRecord(r); assert(!ids.has(r.id), '重复条目 ID'); ids.add(r.id); }
    for (const key of ['history', 'feedback', 'proposals', 'processed', 'conflicts', 'excluded', 'jobs']) assert(Array.isArray(doc[key]), `缺少 ${key}`);
    assert(doc.feedback.length <= 5000 && doc.jobs.length <= 5000 && doc.proposals.length <= 1000, '资料数量超过单档上限，请导出归档');
    for (const f of doc.feedback) assert(validId(f.id) && text(f.quote, 50000) && text(f.note) && ['saved', 'queued', 'processed', 'withdrawn'].includes(f.status), '点评数据无效');
    const source=s=>s&&text(s.chatKey,500)&&validId(s.id)&&text(s.hash,100);
    for(const f of doc.feedback)assert(!f.source||source(f.source),'点评来源无效');
    assert(doc.processed.every(x=>text(x,300))&&doc.excluded.every(validId),'处理记录或排除列表无效');
    for(const h of doc.history){
        assert(h&&validId(h.id)&&text(h.key,300)&&['user','ai','system'].includes(h.actor)&&Array.isArray(h.sources)&&h.sources.every(source)&&Array.isArray(h.changes),'历史变更格式无效');
        assert(!h.anchor||source(h.anchor),'历史锚点无效');
        assert(!h.feedbackIds||Array.isArray(h.feedbackIds)&&h.feedbackIds.every(validId),'历史点评依据无效');
        for(const c of h.changes){assert(c&&validId(c.id),'历史条目身份无效');for(const r of [c.before,c.after])if(r){validateRecord(r);assert(r.id===c.id,'历史条目归属不符');}}
    }
    for(const j of [...doc.jobs,...doc.proposals])assert(j&&validId(j.id)&&text(j.key,300)&&['world','feedback','reflection','initialization'].includes(j.kind)&&text(j.chatKey,500)&&text(j.input,150000)&&Array.isArray(j.sources)&&j.sources.every(source)&&Array.isArray(j.feedback)&&j.feedback.every(f=>text(f.note)),'维护任务格式无效');
    if (doc.type === 'profile') validateSettings(doc.settings);
    assert(JSON.stringify(doc).length <= 4_000_000, '单档超过 400 万字符，请先导出并建立新档');
    return doc;
}
export function validateSettings(s) {
    assert(s && ['auto','semi','manual'].includes(s.mode) && ['background','before'].includes(s.timing) && ['main','custom'].includes(s.connection), '维护设置无效');
    keys(s,Object.keys(DEFAULTS));
    for (const [k, min, max] of [['frequency',1,100],['reflectionFrequency',1,500],['contextRounds',1,30],['maxInputChars',2000,150000],['injectionChars',500,40000],['timeoutSeconds',10,300]]) assert(Number.isInteger(s[k]) && s[k] >= min && s[k] <= max, `${k} 超出范围 ${min}—${max}`);
    for (const k of ['enabled','reflectionEnabled','memoryRead','memoryFollow']) assert(typeof s[k] === 'boolean', `${k} 必须为开关`);
    assert(text(s.endpoint,2000) && text(s.model,300), '连接设置无效');
    if(s.endpoint){let url;try{url=new URL(s.endpoint);}catch{throw Error('API 地址无效');}assert(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash,'不要将密钥或查询参数放入 API 地址');}
    return s;
}
export function newDocument(type = 'story', title = '新故事', id = uid()) {
    return { schema: SCHEMA, type, id, title, records: [], history: [], feedback: [], proposals: [], processed: [], conflicts: [], excluded: [], jobs: [], ...(type === 'profile' ? { settings: {...DEFAULTS} } : { bindings: [], memoryBinding: null, parent: null }) };
}
export function record({id = uid(), kind = 'world', title = '', body = '', ...rest} = {}) {
    return validateRecord({ id, kind, title, blocks: [{id:uid(),text:body,locked:false}], locked:false, truth:kind === 'world' ? 'intent' : 'guidance', status:'active', importance:'minor', origin:'manual', sources:[], ...rest });
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
                assert(after.locked === undefined && after.origin === undefined && after.sources === undefined && after.blocks?.every(b => b.locked === undefined), '模型不能提供保护、来源或权限字段');
                after.locked = before?.locked ?? false;
                after.blocks = after.blocks.map(b => ({...b, locked:before?.blocks.find(x=>x.id === b.id)?.locked ?? false}));
                after.origin = origin;
                after.sources = [...new Map([...(before?.sources ?? []),...sources].map(s => [`${s.chatKey}:${s.id}:${s.hash}`,s])).values()];
                if (origin === 'reflection') assert(after.kind === 'experience'&&(!before||before.kind==='experience'), '自我总结只能修改作者经验');
                if (origin === 'world') assert(['world','focus'].includes(after.kind)&&(!before||['world','focus'].includes(before.kind)), '世界维护不能冒充用户偏好');
                if (origin === 'feedback') assert(['guide','focus','experience'].includes(after.kind)&&(!before||['guide','focus','experience'].includes(before.kind)), '点评不能改写世界事实');
            } else after.origin='manual';
            validateRecord(after);
        } else {
            assert(before, '不能删除不存在的条目');
            if (actor !== 'user' && origin === 'reflection') assert(before.kind === 'experience', '自总结只能删除作者经验');
            if (actor !== 'user' && origin === 'world') assert(['world','focus'].includes(before.kind), '世界维护不能删除用户指南');
            if (actor !== 'user' && origin === 'feedback') assert(['guide','focus','experience'].includes(before.kind), '点评不能删除世界事实');
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
    for(const {h,c} of latest.values())if(!c.after&&h.actor==='ai'&&h.origin==='world'&&invalid(h)&&!next.records.some(r=>r.id===c.id)&&c.before&&!invalid(c.before)){
        next.records.push(copy(c.before));next.history.push({id:uid(),key:uid(),actor:'system',origin:'invalidation',sources:[],anchor:null,at:Date.now(),changes:[{id:c.id,before:null,after:copy(c.before)}]});
    }
    for (const r of [...next.records]) {
        // Feedback and deliberate author experience survive a changed source passage.
        if (!['world','focus'].includes(r.kind) || !invalid(r)) continue;
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
    return validateDocument(next);
}
