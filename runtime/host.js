import {assert,copy,hash,uid,validId} from '../core/model.js';
import {networkError,retryRequest} from './network.js';
import {promptText} from '../core/prompt-templates.js';
import {CONTROL_FILTER,stripControl} from '../core/outline.js';

export class TavernHost {
    constructor(context = ()=>globalThis.SillyTavern?.getContext()) { this.context=context;this.foreground=false;this.rawPending=false;this.disposers=[];this.key=''; }
    ctx() { const c=this.context();assert(c,'SillyTavern 尚未就绪');return c; }
    async prepare() {
        // Resolve verified host modules relative to the extension's installation URL.
        const url=new URL(import.meta.url),marker='/scripts/extensions/',index=url.pathname.indexOf(marker);
        if(index<0)return;
        const root=new URL(url);root.pathname=url.pathname.slice(0,index+1);root.search='';root.hash='';
        const results=await Promise.allSettled([import(new URL('script.js',root).href),import(new URL('scripts/world-info.js',root).href)]);
        if(results[0].status==='fulfilled'){
            const script=results[0].value;
            this.generationState=typeof script.isGenerating==='function'?script.isGenerating:typeof script.is_send_press==='boolean'?()=>script.is_send_press:undefined;
        }
        if(results[1].status==='fulfilled')this.worldModule=results[1].value;
    }
    isForeground() {
        if(this.maintenanceBefore)return false;
        if(typeof this.generationState==='function')return Boolean(this.generationState());
        return this.foreground || Boolean(this.ctx().streamingProcessor && !this.ctx().streamingProcessor.isFinished);
    }
    mainBusyReason(){
        if(this.rawPending)return `上一条 BBPresets 主 API 请求仍在等待酒馆返回${this.rawStartedAt?`（已等待 ${Math.max(0,Math.floor((Date.now()-this.rawStartedAt)/1000))} 秒）`:''}；结束后可重试。停止等待不会中止酒馆底层请求。`;
        return this.isForeground()?'酒馆正文正在生成，请等正文结束后再初始化或维护':'';
    }
    identity() {
        const c=this.ctx(), character=c.groupId != null && c.groupId !== '' ? `group:${c.groupId}` : c.characters?.[c.characterId]?.avatar ? `char:${c.characters[c.characterId].avatar}` : '';
        const chat=String(c.getCurrentChatId?.() ?? c.chatId ?? '');
        return {character,chat,chatKey:character && chat ? JSON.stringify([character,chat]) : ''};
    }
    on(name,fn) {
        const c=this.ctx(),event=(c.eventTypes ?? c.event_types)?.[name];if(!event)return;
        c.eventSource.on(event,fn);this.disposers.push(()=>c.eventSource.removeListener(event,fn));
    }
    inject(content) { this.ctx().setExtensionPrompt?.('bbpresets_author',content,1,1,false,0); }
    controlFilter(enabled){
        const settings=this.ctx().extensionSettings;if(!settings)return;
        const id='bbpresets-control-v1',others=(settings.regex??[]).filter(r=>r.id!==id);
        // Both flags true means display + outgoing prompt only; never rewrite the stored response.
        settings.regex=enabled?[{id,scriptName:'BBPresets · 控制信息隐藏',findRegex:CONTROL_FILTER,replaceString:'',trimStrings:[],placement:[2],disabled:false,markdownOnly:true,promptOnly:true,runOnEdit:true,substituteRegex:0,minDepth:null,maxDepth:null},...others]:others;
        this.controlWarning=enabled&&settings.disabledExtensions?.includes('regex')?'酒馆内置正则已停用，控制信息可能显示在正文中；请启用正则':'';
    }
    filterPrompt(chat){
        // The official interceptor receives prompt copies. Never mutate the host's original chat.
        if(chat===this.ctx().chat)return;
        for(const message of chat??[])if(!message.is_user&&typeof message.mes==='string')message.mes=stripControl(message.mes);
    }
    async capture() {
        const c=this.ctx(),identity=this.identity();assert(identity.chatKey,'请先打开角色聊天');
        const chat=c.chat, seen=new Set(), rows=[];let dirty=false;
        for(let floor=0;floor<chat.length;floor++) {
            const m=chat[floor];if(m.is_system || typeof m.mes!=='string')continue;
            m.extra ??= {};
            let id=m.extra.bbpresetsSourceId;
            if(!validId(id)||seen.has(id)){id=uid();m.extra.bbpresetsSourceId=id;dirty=true;}
            seen.add(id);
            rows.push({id,floor,role:m.is_user?'user':'assistant',name:String(m.name??''),text:m.mes,hash:await hash(m.mes)});
        }
        assert(this.identity().chatKey===identity.chatKey && c.chat===chat,'读取期间聊天已变化');
        if(dirty)this.dirtySources=identity.chatKey;
        if(dirty && !this.isForeground())await this.flushSourceIds();
        const sources=rows.map(({id,hash,floor})=>({id,hash,floor,chatKey:identity.chatKey}));
        const pairs=[];let group=[];
        const finish=async()=>{if(group[0]?.role==='user'&&group.some(r=>r.role==='assistant'&&r.text.trim()))pairs.push({rows:copy(group),sources:group.map(r=>sources.find(s=>s.id===r.id)),key:await hash(group.map(r=>r.id+':'+r.hash).join('|'))});};
        for(const row of rows){if(row.role==='user'){await finish();group=[];}if(row.role==='user'||group.length)group.push(row);}await finish();
        return {...identity,rows,sources,pairs};
    }
    async flushSourceIds() {
        if(!this.dirtySources||this.isForeground())return;
        const key=this.dirtySources;this.dirtySources=null;
        if(key!==this.identity().chatKey)return;
        try{await this.ctx().saveChat?.();}catch(e){this.dirtySources=key;throw e;}
    }
    async seed(budget=20000) {
        const c=this.ctx(),identity=this.identity(),char=c.characters?.[c.characterId],data=char?.data??char??{},power=c.powerUserSettings??{};
        const group=c.groups?.find(g=>String(g.id)===String(c.groupId));
        const cards=group?c.characters.filter(x=>group.members?.includes(x.avatar)):[char].filter(Boolean);
        const sections=[],notes=[];
        const add=(label,value)=>{if(value)sections.push({label,text:typeof value==='string'?value:JSON.stringify(value)});};
        for(const card of cards){const d=card.data??card;add('角色人设',{name:d.name,description:d.description,personality:d.personality,scenario:d.scenario});add('卡内世界书',d.character_book);}
        add('用户人设',{name:c.name1,description:power.persona_description});
        const wi=this.worldModule,names=new Set([c.chatMetadata?.world_info,power.persona_description_lorebook,...(wi?.selected_world_info??[])]);
        for(const card of cards){names.add(card.data?.extensions?.world);const filename=card.avatar?.replace(/\.[^.]+$/,'');for(const name of wi?.world_info?.charLore?.find(x=>x.name===filename)?.extraBooks??[])names.add(name);}
        names.delete(undefined);names.delete('');names.delete(null);
        const loader=c.loadWorldInfo??wi?.loadWorldInfo;
        if(!wi)notes.push('宿主未提供全局/附加世界书发现能力，仅读取可确认的绑定资料');
        for(const name of [...names].slice(0,32)){
            if(typeof name!=='string')continue;
            if(!loader){notes.push('当前版本缺少世界书读取能力');break;}
            try{const book=await loader(name);if(!book){notes.push(`世界书读取失败：${name}`);continue;}add('世界书：'+name,Object.values(book.entries??{}).filter(e=>!e.disable&&e.enabled!==false).map(e=>({title:e.comment,keys:e.key,content:e.content})));}
            catch{notes.push(`世界书读取失败：${name}`);}
        }
        if(names.size>32)notes.push('世界书超过 32 本，本次只读取前 32 本');
        assert(identity.chatKey===this.identity().chatKey,'读取初始化资料期间聊天已切换');
        const limit=Math.max(100,Math.floor((budget-500)/Math.max(1,sections.length)));
        const omitted=sections.filter(s=>s.text.length>limit).length;
        this.seedInfo={sections:sections.map(s=>s.label),notes,omitted};
        return JSON.stringify({materials:sections.map(s=>({...s,text:s.text.slice(0,limit)})),notes,omitted});
    }
    async createRecovery() {
        const c=this.ctx(),lf=c.libs?.localforage ?? globalThis.SillyTavern?.libs?.localforage;
        assert(c.accountStorage && lf,'当前酒馆缺少账户存储或 localforage，请更新酒馆');
        let scope=c.accountStorage.getItem('bbpresets_local_scope');
        if(!validId(scope)){scope=uid();c.accountStorage.setItem('bbpresets_local_scope',scope);}
        this.local=lf;this.prefix=`bbpresets_${scope}_`;
        this.key=await lf.getItem(this.prefix+'api_key')??'';
        const mapKey=this.prefix+'pending';
        return {
            put:async(id,value)=>{const all=await lf.getItem(mapKey)??{};all[id]=value;await lf.setItem(mapKey,all);},
            remove:async id=>{const all=await lf.getItem(mapKey)??{};delete all[id];await lf.setItem(mapKey,all);},
            list:async()=>await lf.getItem(mapKey)??{},
        };
    }
    async setKey(value){this.key=value;await this.local.setItem(this.prefix+'api_key',value);}
    transport() {
        const check=n=>assert(/^bbpresets-[a-zA-Z0-9_-]+\.json$/.test(n),'文件名越界');
        return {
            read:async name=>{check(name);return retryRequest(async signal=>{const response=await fetch(`/user/files/${name}`,{cache:'no-store',credentials:'same-origin',signal});if(response.status===404)return null;if(!response.ok)throw networkError(`读取服务器失败 HTTP ${response.status}`,[408,429,500,502,503,504].includes(response.status));const body=await response.text();assert(body.length<12_000_000,'服务器资料过大');return JSON.parse(body);},{timeoutSeconds:30});},
            write:async(name,value)=>{check(name);const bytes=new TextEncoder().encode(JSON.stringify(value));assert(bytes.length<10_000_000,'保存资料超过 10 MB，请拆分存档');let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));const response=await fetch('/api/files/upload',{method:'POST',headers:this.ctx().getRequestHeaders(),credentials:'same-origin',body:JSON.stringify({name,data:btoa(binary)}),signal:AbortSignal.timeout(30000)});assert(response.ok,`保存服务器失败 HTTP ${response.status}`);const result=await response.json();assert(result.path===`/user/files/${name}`,'服务器返回了意外的文件路径');},
        };
    }
    async request(prompt,settings,signal,{key=this.key}={}) {
        const systemPrompt=promptText(settings,'system');
        if(settings.connection==='main') {
            assert(!this.isForeground()&&!this.rawPending,this.mainBusyReason());
            assert(typeof this.ctx().generateRaw==='function','当前酒馆没有 generateRaw');
            assert(!signal.aborted,'请求已取消');this.rawPending=true;this.rawStartedAt=Date.now();
            const pending=Promise.resolve().then(()=>this.ctx().generateRaw({systemPrompt,prompt}));
            this.rawCompletion=pending.catch(()=>{});
            pending.finally(()=>{this.rawPending=false;this.rawStartedAt=null;}).catch(()=>{});
            // Do not call stopGeneration: it can stop the user's RP. Late results are ignored.
            try{return await abortable(pending,signal);}catch(error){if(!signal.aborted&&/abort|fetch|network|load failed/i.test(error.message))throw networkError('酒馆主连接暂时中断，正在保留任务以便重试');throw error;}
        }
        let endpoint;try{endpoint=new URL(settings.endpoint);}catch{throw Error('请配置完整的独立 API 地址');}
        assert(['https:','http:'].includes(endpoint.protocol)&&!endpoint.username&&!endpoint.password&&!endpoint.search&&!endpoint.hash,'API 地址必须是无凭据、无查询参数的 HTTP(S) URL');
        if(!endpoint.pathname.endsWith('/chat/completions'))endpoint.pathname=endpoint.pathname.replace(/\/$/,'')+(endpoint.pathname.endsWith('/v1')?'/chat/completions':'/v1/chat/completions');
        assert(settings.model?.trim(),'请填写独立模型名称');
        let response;
        try{response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(key?{Authorization:`Bearer ${key}`}:{})},body:JSON.stringify({model:settings.model,messages:[{role:'system',content:systemPrompt},{role:'user',content:prompt}],temperature:0.4,stream:false}),signal});}
        catch{throw networkError(signal.aborted?'API 请求已取消或超时，请稍后重试':'无法连接独立 API，请检查地址、网络和服务端跨域设置；HTTPS 酒馆请使用 HTTPS API',!signal.aborted);}
        if(!response.ok)throw networkError(`模型请求失败 HTTP ${response.status}`,[408,429,500,502,503,504].includes(response.status));
        let data;try{data=await response.json();}catch(error){if(error instanceof SyntaxError)throw Error('API 返回的内容不是有效 JSON，请检查接口协议');throw networkError('接收模型响应时网络中断');}
        const content=data.choices?.[0]?.message?.content;
        const text=Array.isArray(content)?content.filter(p=>p?.type==='text').map(p=>p.text).join('\n'):content??'';
        return {text,usage:data.usage??null,finishReason:data.choices?.[0]?.finish_reason??null};
    }
    async waitRaw(){if(!this.rawPending)return;let timer;try{await Promise.race([this.rawCompletion,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('主连接仍未释放，请稍后重发正文；大纲和输入保留')),30000);})]);}finally{clearTimeout(timer);}}
    async memorySnapshot() {
        const c=this.ctx(),{character,chat}=this.identity(),binding=c.extensionSettings?.bb_memory?.chatSlotBindings?.entries?.[character]?.[chat];
        if(!binding?.slotName)return null;
        const lf=c.libs?.localforage??globalThis.SillyTavern?.libs?.localforage;if(!lf)return null;
        // Only these version-observed storage keys; no mutation or guessed last-used slot.
        const slot=await lf.getItem(`bb_memory_slot_${character}_${binding.slotName}`);
        if(!slot)return null;
        const stamp=slot._slotCreatedAt;
        if(!stamp)return {available:false,reason:'当前 BB-Memory 存档缺少可验证的创建标识，暂不联动'};
        return {available:true,character,slotName:binding.slotName,stamp:String(stamp),signature:JSON.stringify([character,binding.slotName,String(stamp)]),data:slot};
    }
    destroy(){this.disposers.forEach(fn=>fn());this.controlFilter(false);this.inject('');}
}
function abortable(promise,signal){return new Promise((resolve,reject)=>{const abort=()=>{cleanup();reject(Error('维护已取消或超时，晚到结果不会应用'));};const cleanup=()=>signal.removeEventListener('abort',abort);if(signal.aborted)return abort();signal.addEventListener('abort',abort,{once:true});promise.then(x=>{cleanup();resolve(x);},e=>{cleanup();reject(e);});});}
