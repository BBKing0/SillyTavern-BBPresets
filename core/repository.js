import { assert, copy, hash, same, uid, validId, validateDocument } from './model.js';

export const INDEX = 'bbpresets-index-v1.json';
export const BACKUP = 'bbpresets-index-backup-v1.json';
const empty = () => ({schema:1,revision:0,commitId:'initial',documents:{}});
const allowedFile = file => typeof file === 'string' && /^bbpresets-[a-zA-Z0-9_-]+\.json$/.test(file);
function validateIndex(index) {
    assert(index?.schema === 1 && Number.isInteger(index.revision) && index.documents && typeof index.commitId === 'string', '服务器索引格式无效，请从备份恢复');
    for (const [id, d] of Object.entries(index.documents)) {
        assert(validId(id) && allowedFile(d.file) && Number.isInteger(d.revision) && Array.isArray(d.history), '服务器文档索引无效');
        for (const h of d.history) assert(allowedFile(h.file) && Number.isInteger(h.revision), '历史版本路径无效');
    }
    return index;
}
export class Repository {
    constructor(transport, {recovery = {put:async()=>{},remove:async()=>{}}, onStatus = ()=>{}} = {}) {
        this.transport=transport; this.recovery=recovery; this.onStatus=onStatus; this.index=null; this.queue=Promise.resolve();
    }
    async refresh() {
        await this.queue;
        const index = await this.transport.read(INDEX);
        if (!index) {
            const backup = await this.transport.read(BACKUP);
            assert(!backup, '主索引缺失但备份存在；请恢复索引，不能建立空资料覆盖');
        }
        this.index=validateIndex(index ?? empty());
        return copy(this.index);
    }
    async load(id) {
        if (!this.index) await this.refresh();
        const entry=this.index.documents[id]; if (!entry) return null;
        return this.loadVersion(id,entry);
    }
    async loadVersion(id,entry) {
        assert(allowedFile(entry.file), '版本路径无效');
        const value=await this.transport.read(entry.file);
        assert(value?.id === id && value.revision === entry.revision, '版本缺失或身份不符');
        assert(await hash(JSON.stringify(value.data)) === value.digest, '版本内容校验失败');
        validateDocument(value.data);
        assert(value.data.id === id, '文档身份不符');
        return {data:copy(value.data),revision:value.revision};
    }
    save(data, expectedRevision, guard = ()=>true) {
        const work = this.queue.then(()=>this.commit(data,expectedRevision,guard));
        this.queue=work.catch(()=>{}); return work;
    }
    async writeVerified(file,value) {
        // An upload can succeed even when the acknowledgement is lost on a network switch.
        // Resolve that uncertainty by reading the exact value; never blindly republish an index.
        try{await this.transport.write(file,value);}
        catch(error){if(!same(await this.transport.read(file).catch(()=>null),value))throw error;}
        assert(same(await this.transport.read(file),value),'服务器回读不一致；本次内容保留在恢复区');
    }
    async commit(data,expectedRevision,guard) {
        validateDocument(data);
        const pendingId=uid();
        await this.recovery.put(pendingId,{data:copy(data),expectedRevision,at:Date.now()});
        this.onStatus('saving');
        try {
            assert(guard(), '页面、故事或任务已变化，停止旧任务保存');
            const remote=validateIndex(await this.transport.read(INDEX) ?? empty());
            if (this.index) assert(remote.commitId === this.index.commitId, '服务器已有更新，请刷新后重试；本次修改已保留在本机恢复区');
            assert((remote.documents[data.id]?.revision ?? 0) === expectedRevision, '资料版本已变化，不能覆盖');
            const revision=expectedRevision+1, file=`bbpresets-doc-${data.id}-${uid()}.json`;
            const snapshot={schema:1,id:data.id,revision,data:copy(data),digest:await hash(JSON.stringify(data)),at:Date.now()};
            await this.writeVerified(file,snapshot);
            assert(guard(), '保存期间页面或故事已变化，版本保留但不发布');
            // Best-effort stale-client detection. This is NOT a server compare-and-swap.
            const latest=validateIndex(await this.transport.read(INDEX) ?? empty());
            assert(latest.commitId === remote.commitId, '发布前发现服务器已更新，本次版本保留待恢复');
            if (remote.revision > 0) {
                await this.writeVerified(BACKUP,remote);
            }
            assert(guard(), '发布前任务已失效');
            const next=copy(remote), old=remote.documents[data.id];
            next.revision++; next.commitId=uid();
            next.documents[data.id]={file,revision,title:data.title,type:data.type,at:snapshot.at,history:[...(old?.history ?? []),...(old ? [{file:old.file,revision:old.revision,at:old.at}] : [])]};
            await this.writeVerified(INDEX,next);
            this.index=next;
            await this.recovery.remove(pendingId);
            this.onStatus('saved');
            return {data:copy(data),revision};
        } catch(error) { this.onStatus('error',error); throw error; }
    }
    async recoverIndex() {
        await this.queue;
        const existing=await this.transport.read(INDEX);
        if (existing) { try { validateIndex(existing); throw new Error('当前索引有效，请使用条目的历史版本恢复'); } catch(e) { if(e.message.startsWith('当前索引')) throw e; } }
        const backup=validateIndex(await this.transport.read(BACKUP));
        for (const [id,entry] of Object.entries(backup.documents)) await this.loadVersion(id,entry);
        await this.transport.write(INDEX,backup);
        assert(same(await this.transport.read(INDEX),backup),'恢复索引回读失败');
        this.index=backup; return copy(backup);
    }
}
