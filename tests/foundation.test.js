import test from 'node:test';
import assert from 'node:assert/strict';
import {newDocument,record,applyChanges,invalidateSources,forkAt,restoreDocument,copy,validateDocument} from '../core/model.js';
import {Repository,INDEX} from '../core/repository.js';
const source={chatKey:'char:a/chat',id:'message-a',hash:'original'};
function aiRecord(r) { const n=copy(r); delete n.locked; delete n.origin; delete n.sources; n.blocks.forEach(b=>delete b.locked); return n; }
test('full-auto cannot delete or rewrite protected text, and batch failure is atomic',()=>{
    const d=newDocument(),r=record({body:'不可改'}); r.blocks[0].locked=true; d.records.push(r);
    const changed=aiRecord(r);changed.blocks[0].text='改了';
    assert.throws(()=>applyChanges(d,[{op:'put',record:aiRecord(record({body:'new'}))},{op:'put',record:changed}]),/保留文字/);
    assert.equal(d.records.length,1); assert.equal(d.records[0].blocks[0].text,'不可改');
    assert.throws(()=>applyChanges(d,[{op:'remove',id:r.id}]),/保留文字/);
});
test('full-auto may change unprotected major records, self-reflection cannot impersonate preferences',()=>{
    const d=newDocument(),r=record({kind:'world',importance:'major'});
    assert.equal(applyChanges(d,[{op:'put',record:aiRecord(r)}]).records.length,1);
    assert.throws(()=>applyChanges(d,[{op:'put',record:aiRecord(record({kind:'guide'}))}],{origin:'reflection'}),/作者经验/);
});
test('repeated response key is idempotent; edited source reverts world but preserves feedback',()=>{
    const d=newDocument(),r=record({body:'before'});
    const base=applyChanges(d,[{op:'put',record:r}],{actor:'user',key:'manual'});
    const change=aiRecord(r);change.blocks[0].text='after';
    const done=applyChanges(base,[{op:'put',record:change}],{sources:[source],key:'job'});
    assert.deepEqual(applyChanges(done,[{op:'put',record:change}],{sources:[source],key:'job'}),done);
    done.feedback.push({id:'feedback',quote:'原文',note:'喜欢',status:'processed',source});
    const reverted=invalidateSources(done,source.chatKey,[{...source,hash:'edited'}]);
    assert.equal(reverted.records[0].blocks[0].text,'before'); assert.equal(reverted.feedback[0].status,'processed');assert.equal(reverted.feedback[0].sourceChanged,true);
});
test('early branch excludes future facts; source conflict does not alter locked content',()=>{
    const d=newDocument(),r=record({body:'future'});
    const done=applyChanges(d,[{op:'put',record:aiRecord(r)}],{sources:[source],anchor:source});
    assert.equal(forkAt(done,{title:'if',chatKey:source.chatKey,sources:[]}).records.length,0);
    done.records[0].locked=true;
    const reverted=invalidateSources(done,source.chatKey,[]);
    assert.equal(reverted.records[0].blocks[0].text,'future');assert.equal(reverted.excluded.length,1);
    assert.throws(()=>restoreDocument(done,d),/保留条目/);
});
function transport() { const files=new Map();return {files,read:async f=>copy(files.get(f)??null),write:async(f,d)=>files.set(f,copy(d))}; }

test('an invalidated AI deletion restores the previous record without undoing later user changes',()=>{
    const r=record({id:'deleted',body:'still needed'});
    const base=applyChanges(newDocument(),[{op:'put',record:r}],{actor:'user'});
    const removed=applyChanges(base,[{op:'remove',id:r.id}],{sources:[source],origin:'world'});
    assert.equal(invalidateSources(removed,source.chatKey,[]).records[0].blocks[0].text,'still needed');
    const later=applyChanges(removed,[{op:'put',record:{...r,title:'user decision'}}],{actor:'user'});
    assert.equal(invalidateSources(later,source.chatKey,[]).records[0].title,'user decision');
});

test('malformed imported history and unexpected root fields fail validation',()=>{
    const d=newDocument();d.history.push({id:'bad',key:'x',actor:'ai',sources:[],changes:[{id:'record',after:{id:'other'}}]});
    assert.throws(()=>validateDocument(d));
    assert.throws(()=>validateDocument({...newDocument(),apiKey:'must not be accepted'}),/不支持的字段/);
});

test('branch source references follow the new chat and child edits leave parent intact',()=>{
    const d=applyChanges(newDocument(),[{op:'put',record:aiRecord(record({id:'inherited',body:'fact'}))}],{sources:[source]});
    const child=forkAt(d,{title:'if',chatKey:source.chatKey,destinationChatKey:'child-chat',sources:[source]});
    assert.equal(child.records[0].sources[0].chatKey,'child-chat');assert.equal(invalidateSources(child,'child-chat',[]).records.length,0);assert.equal(d.records.length,1);
});

test('manual revision of an AI record survives source invalidation and is flagged for review',()=>{
    const d=applyChanges(newDocument(),[{op:'put',record:aiRecord(record({id:'edited',body:'AI version'}))}],{sources:[source]});
    const edited=copy(d.records[0]);edited.blocks[0].text='user version';
    const manual=applyChanges(d,[{op:'put',record:edited}],{actor:'user'}),result=invalidateSources(manual,source.chatKey,[]);
    assert.equal(result.records[0].blocks[0].text,'user version');assert.ok(result.excluded.includes('edited'));
});

test('maintenance origin cannot retag an existing record to cross its authority boundary',()=>{
    const d=newDocument(),r=record({id:'guide',kind:'guide'});d.records.push(r);
    assert.throws(()=>applyChanges(d,[{op:'put',record:aiRecord({...r,kind:'focus'})}],{origin:'world'}));
    assert.throws(()=>applyChanges(d,[{op:'put',record:aiRecord({...r,kind:'experience'})}],{origin:'reflection'}));
    const w=record({id:'world'});d.records.push(w);assert.throws(()=>applyChanges(d,[{op:'put',record:aiRecord({...w,kind:'guide'})}],{origin:'feedback'}));
});
test('new device sees published version; stale client cannot overwrite it',async()=>{
    const t=transport(),a=new Repository(t),b=new Repository(t);await a.refresh();await b.refresh();
    const d=newDocument();await a.save(d,0);
    await assert.rejects(b.save({...d,title:'stale'},0),/服务器已有更新/);
    await b.refresh();assert.equal((await b.load(d.id)).data.title,d.title);
    await b.save({...d,title:'phone'},1);await a.refresh();assert.equal((await a.load(d.id)).data.title,'phone');
});
test('index upload failure does not publish incomplete version; pending recovery survives',async()=>{
    const t=transport(),pending=new Map(),repo=new Repository(t,{recovery:{put:async(k,v)=>pending.set(k,v),remove:async k=>pending.delete(k)}});
    await repo.refresh();const d=newDocument();await repo.save(d,0);const head=copy(t.files.get(INDEX));
    const write=t.write;t.write=async(f,v)=>{if(f===INDEX)throw Error('offline');return write(f,v);};
    await assert.rejects(repo.save({...d,title:'unsaved'},1),/offline/);
    assert.deepEqual(t.files.get(INDEX),head);assert.equal(pending.size,1);
    assert.equal((await repo.load(d.id)).data.title,d.title);
});
test('guard invalidation during upload leaves immutable file but does not publish',async()=>{
    const t=transport(),repo=new Repository(t);await repo.refresh();let active=true;const write=t.write;
    t.write=async(f,v)=>{await write(f,v);active=false;};
    await assert.rejects(repo.save(newDocument(),0,()=>active),/页面或故事已变化/);
    assert.equal(t.files.has(INDEX),false);
});
