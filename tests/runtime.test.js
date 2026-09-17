import test from 'node:test';
import assert from 'node:assert/strict';
import {BBPresetsApp} from '../runtime/app.js';
import {copy,hash,record} from '../core/model.js';
import {aiView,parseChanges,maintenanceMaterial} from '../runtime/prompts.js';
const tick=()=>new Promise(r=>setImmediate(r));
async function until(fn){for(let n=0;n<200;n++){if(await fn())return;await tick();}throw Error('condition not reached');}
async function fixture() {
    const files=new Map(),ctx={chatMetadata:{},saveMetadata:async()=>{},saveChat:async()=>{}},events=new Map();
    const h={foreground:false,rawPending:false,rows:[{id:'u0',role:'user',text:'开场'},{id:'a0',role:'assistant',text:'一个村庄'}],sent:[],identity:()=>({chatKey:'chat-one',character:'char:a',chat:'one'}),ctx:()=>ctx,on:(n,fn)=>events.set(n,fn),inject:t=>h.injection=t,createRecovery:async()=>({put:async()=>{},remove:async()=>{},list:async()=>({})}),transport:()=>({read:async f=>copy(files.get(f)??null),write:async(f,v)=>files.set(f,copy(v))}),seed:async()=>'',memorySnapshot:async()=>null,destroy:()=>{},request:async prompt=>{h.sent.push(prompt);return h.answer??'{"changes":[]}';}};
    h.capture=async()=>{const rows=await Promise.all(h.rows.map(async(r,floor)=>({...r,name:r.role,hash:await hash(r.text),floor})));const sources=rows.map(r=>({id:r.id,hash:r.hash,floor:r.floor,chatKey:'chat-one'}));const pairs=[];for(let i=0;i<rows.length;i+=2){if(rows[i+1]?.role==='assistant'){const pair=rows.slice(i,i+2),s=sources.slice(i,i+2);pairs.push({rows:pair,sources:s,key:await hash(s.map(x=>x.id+x.hash).join('|'))});}}return {...h.identity(),rows,sources,pairs};};
    const errors=[],app=new BBPresetsApp(h,{visible:()=>true,notify:e=>errors.push(e)});await app.init();await app.createStory('test');await app.saveSettings({...app.settings,mode:'auto',connection:'custom',reflectionEnabled:false});
    return {app,h,errors,events};
}
test('background generation returns before maintenance; the current injection stays frozen',async()=>{
    const {app,h}=await fixture();let finish;
    const pending=new Promise(r=>finish=r);h.request=async()=>{h.sent.push('call');return pending;};
    h.rows.push({id:'u1',role:'user',text:'求援'},{id:'a1',role:'assistant',text:'村长筹粮'},{id:'u2',role:'user',text:'继续'});
    await app.beforeGenerate();const frozen=h.injection;
    await until(()=>h.sent.length===1);
    const change=aiView(record({id:'new-world',title:'筹粮',body:'村长寻求其他援助'}));finish(JSON.stringify({changes:[{op:'put',record:change}]}));
    await until(()=>!app.running);
    assert.equal(app.story.data.records.length,1);assert.equal(h.injection,frozen);assert.equal(app.stats.success,1);
});
test('semi-auto queues important changes, auto applies them without approval',async()=>{
    const {app,h}=await fixture();h.answer=JSON.stringify({changes:[{op:'put',record:aiView(record({id:'important',importance:'major',body:'world'}))}]});
    await app.saveSettings({...app.settings,mode:'semi'});await app.manual();
    assert.equal(app.story.data.records.length,0);assert.equal(app.story.data.proposals.length,1);
    await app.reviewProposal(app.story.data.proposals[0].id,true);assert.equal(app.story.data.records.length,1);
});
test('edited source during a request prevents a late result from being committed',async()=>{
    const {app,h}=await fixture();let finish;h.request=()=>new Promise(r=>finish=r);
    const request=app.manual();await until(()=>!!finish);h.rows[1].text='改写之后';
    finish(JSON.stringify({changes:[{op:'put',record:aiView(record({id:'obsolete',body:'stale'}))}]}));await request;
    assert.equal(app.story.data.records.length,0);assert.equal(app.story.data.jobs[0].state,'failed');
});
test('collection is not sent until explicitly submitted, and withdrawn feedback stops influencing injection',async()=>{
    const {app,h}=await fixture();await app.addFeedback({quote:'原文',note:'喜欢节奏'});assert.equal(h.sent.length,0);
    h.answer=JSON.stringify({changes:[{op:'put',record:aiView(record({id:'learned',kind:'guide',body:'重视节奏'}))}]});
    const id=app.story.data.feedback[0].id;await app.sendFeedback([id]);
    assert.equal(app.story.data.feedback[0].status,'processed');assert.equal(app.story.data.records.length,1);
    await app.withdrawFeedback(id);assert.ok(app.story.data.excluded.includes('learned'));assert.equal(app.story.data.feedback[0].quote,'原文');
});
test('temporary request survives before-generation maintenance, JSON errors reveal no author data',async()=>{
    const {app,h}=await fixture();await app.saveSettings({...app.settings,timing:'before'});app.temporary='本轮慢写';
    await app.beforeGenerate();assert.match(h.injection,/本轮慢写/);assert.equal(app.temporary,'');
    assert.throws(()=>parseChanges('secret plot invalid json'),e=>!e.message.includes('secret'));
});
test('main connection stays queued while the normal reply is generating',async()=>{
    const {app,h}=await fixture();await app.saveSettings({...app.settings,connection:'main'});h.foreground=true;
    await app.queueJob('world');await app.drain();assert.equal(h.sent.length,0);
    h.foreground=false;await app.drain();assert.equal(h.sent.length,1);
});

test('overlapping feedback submissions do not consume the same quote twice; rejected feedback can be resubmitted',async()=>{
    const {app,h}=await fixture();await app.saveSettings({...app.settings,mode:'semi'});
    h.answer=JSON.stringify({changes:[{op:'put',record:aiView(record({id:'guide',kind:'guide',body:'less repetition'}))}]});
    const id=await app.addFeedback({quote:'quote',note:'note'});assert.ok(id);
    const results=await Promise.allSettled([app.sendFeedback([id]),app.sendFeedback([id])]);
    assert.equal(results[1].status,'rejected');assert.equal(h.sent.length,1);
    await app.reviewProposal(app.story.data.proposals[0].id,false);
    await app.sendFeedback([id]);assert.equal(h.sent.length,2);assert.equal(app.story.data.proposals.length,1);
});

test('enabled follow pauses on missing mapping; standalone use resumes when follow is disabled',async()=>{
    const {app,h}=await fixture();await app.saveSettings({...app.settings,memoryFollow:true});
    await assert.rejects(app.beforeGenerate(),/联动已暂停/);assert.equal(h.injection,'');
    await app.saveSettings({...app.settings,memoryFollow:false});await app.beforeGenerate();assert.match(h.injection,/BBPresets/);
});

test('stale manual editor cannot overwrite a newer change',async()=>{
    const {app}=await fixture();const r=record({id:'edit',body:'old'});await app.saveRecord(app.story.data.id,r,null);
    const later=copy(r);later.blocks[0].text='later';await app.saveRecord(app.story.data.id,later,r);
    const stale=copy(r);stale.blocks[0].text='stale';await assert.rejects(app.saveRecord(app.story.data.id,stale,r),/条目已变化/);
    assert.equal(app.story.data.records[0].blocks[0].text,'later');
});

test('initialization keeps explicit answers when the character seed is oversized',async()=>{
    const {app,h}=await fixture();await app.saveSettings({...app.settings,maxInputChars:2000});h.seed=async()=>'长'.repeat(10000);
    await app.manual('initialization','USER-ANSWER-FIRST');assert.match(h.sent[0],/USER-ANSWER-FIRST/);
});

test('frequency batches completed rounds into one request instead of delaying several calls',async()=>{
    const {app,h}=await fixture();await app.saveSettings({...app.settings,frequency:2});
    h.rows.push({id:'u1',role:'user',text:'one'},{id:'a1',role:'assistant',text:'one'});
    await app.beforeGenerate();await app.edits;await tick();assert.equal(h.sent.length,0);
    h.rows.push({id:'u2',role:'user',text:'two'},{id:'a2',role:'assistant',text:'two'},{id:'u3',role:'user',text:'next'});
    await app.beforeGenerate();await until(()=>app.stats.success===1);assert.equal(h.sent.length,1);
    await app.beforeGenerate();await tick();assert.equal(h.sent.length,1);
});

test('background work uses the send-time completed turns even if a new response appears during preparation',async()=>{
    const {app,h}=await fixture();h.rows.push({id:'u1',role:'user',text:'question'},{id:'a1',role:'assistant',text:'completed'},{id:'u2',role:'user',text:'next'});
    const original=app.reconcile.bind(app);let appended=false;app.reconcile=async()=>{if(!appended){appended=true;h.rows.push({id:'a2',role:'assistant',text:'INCOMPLETE-NOW'});}return original();};
    await app.beforeGenerate();await until(()=>app.stats.success===1);assert.equal(h.sent[0].includes('INCOMPLETE-NOW'),false);
});

test('material budget stays bounded and omitted records cannot be overwritten by a model guess',async()=>{
    const {app,h}=await fixture();await app.saveSettings({...app.settings,maxInputChars:2000});
    const big=record({id:'omitted',body:'x'.repeat(4000)});await app.saveRecord(app.story.data.id,big,null);
    const material=maintenanceMaterial({kind:'world',sources:[],input:'recent',feedback:[]},app.story.data,app.profile.data);assert.ok(JSON.stringify(material).length<=2000);assert.equal(material.omitted,1);
    h.answer=JSON.stringify({changes:[{op:'remove',id:'omitted'}]});await app.manual();assert.equal(app.story.data.records.length,1);assert.equal(app.story.data.jobs[0].state,'failed');
});
