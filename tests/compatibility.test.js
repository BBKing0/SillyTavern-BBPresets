import test from 'node:test';
import assert from 'node:assert/strict';
import {TavernHost} from '../runtime/host.js';
import {BBPresetsApp} from '../runtime/app.js';
import {copy} from '../core/model.js';
import {parseQuestions} from '../runtime/prompts.js';

const tick=()=>new Promise(r=>setImmediate(r));
async function until(fn){for(let i=0;i<300;i++){if(fn())return;await tick();}throw Error('condition not reached');}
const message=(mes,is_user=false)=>({mes,is_user,extra:{}});
async function fixture(t){
    const events=new Map(),files=new Map(),local=new Map();let generating=false,saves=0;
    const ctx={characters:[{avatar:'example.png',data:{name:'测试角色',description:'科幻群像，研究员与医生同行',extensions:{world:'科技规则'}}}],characterId:0,chatId:'one',chatMetadata:{},chat:[message('0 开场白')],powerUserSettings:{persona_description:'用户人设：飞船工程师'},
        eventTypes:Object.fromEntries(['GENERATION_STARTED','GENERATION_ENDED','GENERATION_STOPPED','CHAT_CHANGED','MESSAGE_SWIPED','MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_DELETED'].map(x=>[x,x])),eventSource:{on:(e,fn)=>events.set(e,fn),removeListener:e=>events.delete(e)},setExtensionPrompt:()=>{},saveChat:async()=>saves++,saveMetadata:async()=>{},loadWorldInfo:async()=>({entries:{one:{comment:'科技树',content:'只允许星系内航行；没有超光速引擎。'}}})};
    const host=new TavernHost(()=>ctx);host.generationState=()=>generating;
    host.transport=()=>({read:async k=>copy(files.get(k)??null),write:async(k,v)=>files.set(k,copy(v))});
    host.createRecovery=async()=>({put:async(k,v)=>local.set(k,v),remove:async k=>local.delete(k),list:async()=>Object.fromEntries(local)});
    const sent=[];host.request=async prompt=>{sent.push(prompt);return '{"changes":[]}';};
    const app=new BBPresetsApp(host,{visible:()=>true});await app.init();await app.createStory('初始故事');await app.saveSettings({...app.settings,connection:'custom',mode:'auto',reflectionEnabled:false});t.after(()=>app.destroy());
    return {app,host,ctx,events,sent,setGenerating:v=>generating=v,saves:()=>saves};
}

test('real host floor 0 is seed only; complete exchanges are 1/2 and 3/4, never greeting or unfinished input',async t=>{
    const {host,ctx}=await fixture(t);ctx.chat.push(message('1 用户',true),message('2 回复'),message('3 用户',true),message('4 回复'),message('5 正在输入',true));
    const captured=await host.capture();assert.deepEqual(captured.pairs.map(p=>p.rows.map(r=>r.floor)),[[1,2],[3,4]]);
    ctx.chat.push(message(''));assert.equal((await host.capture()).pairs.length,2);
    ctx.chat.splice(3,0,{mes:'系统通知',is_system:true});assert.deepEqual((await host.capture()).pairs[1].rows.map(r=>r.floor),[4,5]);
});

test('dry-run token counting does not poison initialization or main connection state',async t=>{
    const {app,host,events,sent}=await fixture(t);host.generationState=undefined;
    events.get('GENERATION_STARTED')('normal',{},true);assert.equal(host.foreground,false);
    await app.saveSettings({...app.settings,connection:'main'});await app.manual('initialization','希望先关注医生');
    assert.equal(sent.length,1);assert.equal(app.stats.success,1);
});

test('0 to 5 floor sequence extracts 1/2 on send 3 and 3/4 on send 5; rerolls and continue never extract',async t=>{
    const {app,ctx,sent}=await fixture(t);
    assert.equal(app.story.data.processed.length,0);
    ctx.chat.push(message('用户1',true));await app.beforeGenerate();await tick();assert.equal(sent.length,0);
    ctx.chat.push(message('回复2'));await app.beforeGenerate('swipe');await tick();assert.equal(sent.length,0);
    ctx.chat[2].mes='回复2最终版';ctx.chat.push(message('用户3',true));await app.beforeGenerate();await until(()=>app.stats.success===1);
    assert.match(sent[0],/回复2最终版/);assert.doesNotMatch(sent[0],/用户3/);
    ctx.chat.push(message('回复4待重抽'));await app.beforeGenerate('swipe');await app.beforeGenerate('regenerate');await app.beforeGenerate('continue');await tick();assert.equal(sent.length,1);
    ctx.chat[4].mes='回复4最终版';ctx.chat.push(message('用户5',true));await app.beforeGenerate();await until(()=>app.stats.success===2);
    assert.match(sent[1],/回复4最终版/);assert.doesNotMatch(sent[1],/回复4待重抽|回复2最终版|用户5/);
    await app.beforeGenerate();await tick();assert.equal(sent.length,2);
});

test('numeric ENDED payload releases main queue; missing ENDED recovers from live generation flag',async t=>{
    const {app,ctx,events,sent,setGenerating}=await fixture(t);await app.saveSettings({...app.settings,connection:'main'});
    ctx.chat.push(message('1',true),message('2'),message('3',true));setGenerating(true);events.get('GENERATION_STARTED')('normal',{},false);await app.beforeGenerate();
    await until(()=>app.story.data.jobs.length===1);assert.equal(sent.length,0);ctx.chat.push(message('4 新正文不在来源内'));
    setGenerating(false);events.get('GENERATION_ENDED')(5);await until(()=>app.stats.success===1);assert.doesNotMatch(sent[0],/新正文/);
    ctx.chat.push(message('5',true));setGenerating(true);await app.beforeGenerate();await until(()=>app.story.data.jobs.length===1);setGenerating(false);await app.resumeQueue();assert.equal(sent.length,2);
});

test('reflection follows eligible exchanges, ignores greeting and remains idempotent across swipe',async t=>{
    const {app,ctx,sent}=await fixture(t);await app.saveSettings({...app.settings,reflectionEnabled:true,reflectionFrequency:2});
    ctx.chat.push(message('u1',true),message('a2'),message('u3',true));await app.beforeGenerate();await until(()=>app.stats.success===1);assert.equal(sent.filter(x=>x.startsWith('复盘')).length,0);
    ctx.chat.push(message('a4'),message('u5',true));await app.beforeGenerate();await until(()=>app.stats.success===3);assert.equal(sent.filter(x=>x.startsWith('复盘')).length,1);
    await app.beforeGenerate('swipe');await tick();assert.equal(sent.length,3);
});

test('question generation reads worldbook, persona, context and confirmed memory; examples are not submitted as answers',async t=>{
    const {app,host,ctx,sent}=await fixture(t);host.worldModule={selected_world_info:['全局书'],world_info:{}};
    ctx.chat.push(message('上下文：医生正在值班'));await app.saveSettings({...app.settings,memoryRead:true});app.confirmedMemory=async()=>({memory:'研究员此前修复了飞船'});
    host.request=async prompt=>{sent.push(prompt);return prompt.includes('最简短的作者沟通')?JSON.stringify({questions:[{question:'科幻开局最想关注哪位角色？',example:'示例医生优先'},{question:'还有什么基本要求？',example:'示例慢节奏'}]}):'{"changes":[]}';};
    await app.prepareInitialization();assert.match(sent[0],/没有超光速引擎/);assert.match(sent[0],/飞船工程师/);assert.match(sent[0],/医生正在值班/);assert.match(sent[0],/修复了飞船/);
    await app.completeInitialization('先看研究员，只用短对话。');assert.match(sent[1],/先看研究员/);assert.doesNotMatch(sent[1],/示例医生优先|示例慢节奏/);
    await assert.rejects(app.completeInitialization('字'.repeat(201)),/200/);
    assert.throws(()=>parseQuestions('{"questions":[]}'),/2—3/);
});

test('late questions and seed preparation cannot migrate into a newly selected chat',async t=>{
    const {app,host,ctx}=await fixture(t);let finish;host.request=()=>new Promise(r=>finish=r);
    const pending=app.prepareInitialization();await until(()=>Boolean(finish));ctx.chatId='two';ctx.chatMetadata={};ctx.chat=[message('另一个开场白')];await app.refresh();
    finish(JSON.stringify({questions:[{question:'旧问题一',example:'示例一'},{question:'旧问题二',example:'示例二'}]}));await assert.rejects(pending,/聊天或设置已变化/);assert.equal(app.initialization,null);assert.equal(app.story,null);
    await app.createStory('第二个故事');let seedFinish;host.seed=()=>new Promise(r=>seedFinish=r);const queued=app.queueJob('initialization');await until(()=>Boolean(seedFinish));app.suspend();seedFinish('旧种子');await assert.rejects(queued,/聊天已变化/);assert.equal(app.story.data.jobs.length,0);
});

test('API test uses draft connection without sending story or persisting credentials',async t=>{
    const {app,host}=await fixture(t);let received;
    host.request=async(prompt,settings,_signal,options)=>{received={prompt,settings,options};return {text:'{"ok":true}'};};
    const before=copy(app.profile),story=copy(app.story);const result=await app.testConnection({...app.settings,endpoint:'https://api.example.test/v1',model:'draft-model'},'draft-key');
    assert.match(result,/连接成功/);assert.equal(received.settings.model,'draft-model');assert.equal(received.options.key,'draft-key');assert.doesNotMatch(received.prompt,/开场白|角色|医生|科技/);assert.deepEqual(app.story,story);assert.deepEqual(app.profile,before);
    host.request=async()=>({text:''});await assert.rejects(app.testConnection(),/没有返回文本/);
});

test('main mode still defers real foreground work while independent initialization can run after stale flag clears',async t=>{
    const {app,setGenerating,host}=await fixture(t);setGenerating(true);await assert.rejects(app.manual('initialization','answer'),/正文完成/);
    setGenerating(false);host.foreground=true;await app.manual('initialization','answer');assert.equal(app.stats.success,1);
});

test('before-generation maintenance can use main connection before the real foreground request starts',async t=>{
    const {app,host,ctx,setGenerating}=await fixture(t);await app.saveSettings({...app.settings,connection:'main',timing:'before'});
    ctx.chat.push(message('用户1',true),message('AI2'),message('用户3',true));setGenerating(true);let calls=0;
    // Use the actual host request guard with the live flag true at the interceptor.
    host.request=TavernHost.prototype.request.bind(host);ctx.generateRaw=async()=>{calls++;return '{"changes":[]}';};
    await app.beforeGenerate();assert.equal(calls,1);assert.equal(app.stats.success,1);assert.equal(host.maintenanceBefore,false);assert.equal(host.isForeground(),true);
});
