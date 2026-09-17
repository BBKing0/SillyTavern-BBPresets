import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {TavernHost} from '../runtime/host.js';
import {sha256} from '../core/digest.js';

test('HTTP fallback digest matches SHA-256 across Unicode and padding boundaries',()=>{
    for(const text of ['', 'abc', '汉字🌧️'.repeat(1000),...Array.from({length:70},(_,n)=>'x'.repeat(n))])assert.equal(sha256(new TextEncoder().encode(text)),createHash('sha256').update(text).digest('hex'));
});

test('host captures stable full-content sources, handles duplicate IDs and excludes unfinished user turns',async()=>{
    let saves=0;const ctx={characters:[{avatar:'a.png'}],characterId:0,chatId:'test',chat:[{is_user:true,mes:'问题',extra:{}},{is_user:false,mes:'回答',extra:{}},{is_user:true,mes:'继续',extra:{}}],saveChat:async()=>saves++};
    const host=new TavernHost(()=>ctx),first=await host.capture();assert.equal(first.pairs.length,1);assert.equal(saves,1);
    const ids=first.sources.map(s=>s.id);ctx.chat[1].mes='改答';const changed=await host.capture();assert.deepEqual(changed.sources.map(s=>s.id),ids);assert.notEqual(changed.sources[1].hash,first.sources[1].hash);
    ctx.chat[2].extra.bbpresetsSourceId=ids[0];assert.notEqual((await host.capture()).sources[2].id,ids[0]);
    assert.deepEqual(Object.keys(ctx.chat[0].extra),['bbpresetsSourceId']);
});

test('main request timeout does not cancel the foreground host and waits for underlying completion before reuse',async()=>{
    let finish;const ctx={generateRaw:()=>new Promise(r=>finish=r)};const host=new TavernHost(()=>ctx),controller=new AbortController();
    const request=host.request('prompt',{connection:'main'},controller.signal);await Promise.resolve();controller.abort();await assert.rejects(request,/取消或超时/);assert.equal(host.rawPending,true);finish('late result');await new Promise(r=>setImmediate(r));assert.equal(host.rawPending,false);
});

test('account scope is server-safe while API credentials stay in device storage',async()=>{
    const account=new Map(),local=new Map(),ctx={accountStorage:{getItem:k=>account.get(k),setItem:(k,v)=>account.set(k,v)},libs:{localforage:{getItem:async k=>local.get(k),setItem:async(k,v)=>local.set(k,v)}}};
    const host=new TavernHost(()=>ctx);await host.createRecovery();await host.setKey('test-only-key');assert.equal(account.size,1);assert.equal([...account.values()].includes('test-only-key'),false);assert.equal(local.get(host.prefix+'api_key'),'test-only-key');
});

test('custom API test normalizes URLs, uses temporary credentials and reports transport failures without leaking them',async t=>{
    const host=new TavernHost(()=>({})),requests=[];host.key='saved-device-key';
    t.mock.method(globalThis,'fetch',async(url,options)=>{requests.push({url:String(url),options});return Response.json({choices:[{message:{content:'{"ok":true}'}}]});});
    const settings={connection:'custom',model:'test-model',endpoint:'https://example.test/v1'};
    await host.request('连接测试',settings,new AbortController().signal,{key:'temporary-test-key'});
    assert.equal(requests[0].url,'https://example.test/v1/chat/completions');assert.equal(requests[0].options.headers.Authorization,'Bearer temporary-test-key');assert.equal(host.key,'saved-device-key');
    await host.request('连接测试',{...settings,endpoint:'https://example.test/custom/chat/completions'},new AbortController().signal);
    assert.equal(requests[1].url,'https://example.test/custom/chat/completions');
    globalThis.fetch.mock.mockImplementation(async()=>{throw Error('network failed');});
    await assert.rejects(host.request('test',settings,new AbortController().signal),e=>/跨域/.test(e.message)&&!e.message.includes('key'));
});
