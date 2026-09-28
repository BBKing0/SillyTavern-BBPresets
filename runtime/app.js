import {assert,copy,same,uid,hash,newDocument,applyChanges,invalidateSources,restoreDocument,validateDocument,validateSettings,migrateAuthor,AUTHOR_KINDS} from '../core/model.js';
import {Repository} from '../core/repository.js';
import {injection,maintenancePrompt,maintenanceMaterial,parseChanges} from './prompts.js';
import {retryRequest,transient} from './network.js';
import {promptText,exportPrompts,importPrompts} from '../core/prompt-templates.js';
import {responseText} from '../core/json.js';
import {parseControl} from '../core/outline.js';
import {sourcePrefixes} from '../core/source-prefix.js';
import {inspirationFrom,retireTasks} from '../core/inspiration.js';
import {storyControlChanges} from '../core/story.js';

const inspirationHash=doc=>hash(JSON.stringify({records:doc.records,excluded:doc.excluded}));

export class BBPresetsApp {
    constructor(host,{notify=()=>{},visible=()=>!globalThis.document?.hidden}={}) {
        this.host=host;this.notify=notify;this.visible=visible;this.epoch=0;this.story=null;this.inspiration=null;this.profile=null;this.listeners=new Set();this.edits=Promise.resolve();this.running=null;this.controller=null;this.error='';this.status='loading';this.lastInjection={text:'',omitted:0};this.stats={calls:0,success:0,failed:0,usage:null};this.ready=false;
        this.drafts=new Map();this.localWrites=Promise.resolve();this.resultCache=new Map();this.requestState='';this.generation=null;this.controlTask=Promise.resolve();this.controlStatus='';this.waitingOutline=false;
    }
    changed(){for(const fn of this.listeners)fn();}
    report(error){this.error=error.message??String(error);this.notify(this.error,'error');this.changed();}
    get settings(){return this.profile?.data.settings;}
    get author(){return this.authorProfile??this.profile;}
    get scopes(){return [this.inspiration,this.author].filter(Boolean);}
    documentFor(id){return [this.profile,this.inspiration,this.authorProfile].find(w=>w?.data.id===id);}
    get jobs(){return this.scopes.flatMap(w=>w.data.jobs.map(job=>({job,target:w.data.id})));}
    get proposals(){return this.scopes.flatMap(w=>w.data.proposals.map(job=>({job,target:w.data.id})));}
    authorMaterial(){return {...copy(this.author.data),settings:copy(this.settings)};}
    async init() {
        await this.host.prepare?.();
        this.recovery=await this.host.createRecovery();
        this.repo=new Repository(this.host.transport(),{recovery:this.recovery,onStatus:(status,error)=>{this.status=status;if(error)this.error=error.message;else if(status==='saved')this.error='';this.changed();}});
        this.host.on('CHAT_CHANGED',()=>{this.host.foreground=false;this.chatRefresh=this.refresh().catch(e=>this.report(e));return this.chatRefresh;});
        this.host.on('GENERATION_STARTED',(type,_options,dryRun)=>{if(!dryRun&&type!=='quiet')this.host.foreground=true;});
        // Start independently; returning the promise here would serialize other extensions again.
        this.host.on('GENERATION_AFTER_COMMANDS',(type,_options,dryRun)=>{if(!dryRun&&!['quiet','impersonate'].includes(type))this.startGenerationPreparation();});
        // GENERATION_ENDED receives chat.length, not the generation type.
        const ended=()=>{this.host.foreground=false;this.preparedGeneration=null;setTimeout(()=>this.resumeQueue(),0);};
        this.host.on('GENERATION_ENDED',ended);
        this.host.on('GENERATION_STOPPED',()=>{this.sendCancelled=true;this.generation=null;if(this.preparedGeneration)this.preparedGeneration.cancelled=true;this.controller?.abort();this.auxController?.abort();this.waitResolve?.('cancel');this.host.foreground=false;});
        this.host.on('MESSAGE_RECEIVED',(floor,type)=>{if(type==='quiet'||type==='first_message')return;const generation=this.generation;this.controlTask=this.controlTask.then(()=>this.receiveControl(floor,generation)).catch(e=>{this.controlStatus=e.message;this.changed();});});
        for(const event of ['MESSAGE_SWIPED','MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_DELETED'])this.host.on(event,()=>{this.reconcile().catch(e=>this.report(e));});
        for(const event of ['MAIN_API_CHANGED','OAI_PRESET_CHANGED_AFTER','CHATCOMPLETION_MODEL_CHANGED','CONNECTION_PROFILE_LOADED'])this.host.on(event,()=>{this.controller?.abort();this.auxController?.abort();});
        await this.refresh();
        this.changed();
        // An aborted/offline request may never emit ENDED. Consult the host's live flag.
        this.queueTimer=setInterval(()=>this.resumeQueue(),1000);this.queueTimer.unref?.();
    }
    get foreground(){return this.host.isForeground?.()??this.host.foreground;}
    async resumeQueue(){
        if(!this.visible()||this.foreground||this.resumeTask||this.preparing||this.buildingInitialization)return;
        try{
            await this.controlTask;
            if(this.needsRefresh&&!this.running&&!this.auxiliary){await this.resume();return;}
            if(!this.ready)return;
            await this.host.flushSourceIds?.();await this.maybeSummarizeFeedback();if(this.jobs.some(({job})=>job.state==='queued'))await this.drain();
        }catch(e){this.report(e);}
    }
    background(){this.needsRefresh=true;this.changed();}
    async resume(){
        if(!this.repo||!this.visible())return;
        this.needsRefresh=true;
        if(this.running||this.auxiliary||this.preparing||this.buildingInitialization||this.resumeTask)return this.resumeTask;
        this.resumeTask=(async()=>{await this.refresh();this.needsRefresh=false;for(const scope of this.scopes)if(scope.data.jobs.some(j=>j.state==='failed'&&j.retryable))await this.edit(scope.data.id,d=>{for(const j of d.jobs)if(j.retryable){j.state='queued';delete j.retryable;}return d;});})();
        try{await this.resumeTask;}finally{this.resumeTask=null;}
        await this.drain();
    }
    suspend(){this.initializationInfo=null;this.questionResponse=null;this.host.seedInfo=null;this.epoch++;this.ready=false;this.generation=null;if(this.preparedGeneration)this.preparedGeneration.cancelled=true;this.controlStatus='';this.waitResolve?.('cancel');clearTimeout(this.draftTimer);this.controller?.abort();this.auxController?.abort();this.host.inject('');this.lastInjection={text:'',omitted:0};}
    async upgrade(wrapper,epoch=this.epoch){if(!wrapper)return wrapper;const next=retireTasks(migrateAuthor(wrapper.data));return same(next,wrapper.data)?wrapper:this.repo.save(next,wrapper.revision,()=>this.epoch===epoch);}
    async migrateInspirations(epoch) {
        const guard=()=>epoch===this.epoch;
        for(const [id,entry] of Object.entries(this.repo.index.documents)) {
            if(entry.type!=='story')continue;
            const target='ideas-'+(await hash(id)).slice(0,40);
            if(this.repo.index.documents[target]){assert(this.repo.index.documents[target].type==='inspiration','灵感迁移目标冲突，原资料保留');continue;}
            // Include archives whose only inspiration was removed by an earlier source rollback.
            const source=(await this.repo.load(id)).data;
            assert(guard(),'迁移期间页面已变化，已复制的灵感将在下次继续读取');
            if(!source.records.some(r=>r.kind==='inspiration')&&!source.history.some(h=>h.changes.some(c=>c.before?.kind==='inspiration'||c.after?.kind==='inspiration')))continue;
            const data=inspirationFrom(source,{id:target,title:(source.title+' · 灵感').slice(0,300)});
            await this.repo.save(data,0,guard);
        }
    }
    async refresh() {
        this.suspend();const epoch=this.epoch,identity=this.host.identity();
        this.story=null;this.inspiration=null;this.selectedKey=null;this.currentSources=[];this.changed();await this.edits;await this.repo.refresh();
        let profile=await this.repo.load('profile');
        if(!profile)profile=await this.repo.save(newDocument('profile','默认作者','profile'),0,()=>this.epoch===epoch);
        if(epoch!==this.epoch)return;
        profile=await this.upgrade(profile,epoch);
        await this.migrateInspirations(epoch);if(epoch!==this.epoch)return;
        let inspirationId=profile.data.activeInspirationId;
        if(!inspirationId){
            const binding=profile.data.chatBindings?.find(b=>b.chatKey===identity.chatKey)??this.host.ctx().chatMetadata?.bbpresetsBinding;
            const oldId=binding?.chatKey===identity.chatKey&&binding?.storyId?'ideas-'+(await hash(binding.storyId)).slice(0,40):null;
            inspirationId=oldId&&this.repo.index.documents[oldId]?oldId:'inspiration-default';
            if(!this.repo.index.documents[inspirationId])await this.repo.save(newDocument('inspiration','默认灵感',inspirationId),0,()=>epoch===this.epoch);
            const next=copy(profile.data);next.activeInspirationId=inspirationId;
            profile=await this.repo.save(next,profile.revision,()=>epoch===this.epoch);
        }
        const inspiration=await this.upgrade(await this.repo.load(inspirationId),epoch);assert(inspiration?.data.type==='inspiration','选定灵感档不存在，请从版本恢复检查存档');
        const authorId=profile.data.activeAuthorId;let authorProfile=null;
        if(authorId&&authorId!=='profile'){authorProfile=await this.upgrade(await this.repo.load(authorId),epoch);assert(authorProfile?.data.type==='author','选定作者不存在，请恢复作者存档');}
        if(epoch!==this.epoch)return;
        this.profile=profile;this.authorProfile=authorProfile;this.inspiration=inspiration;this.selectedKey=identity.chatKey;
        this.host.controlFilter?.(this.settings.enabled);this.ready=true;this.error='';this.status='saved';
        await this.reconcile();this.changed();
    }
    edit(target,transform,{guard=()=>true}={}) {
        const epoch=this.epoch;
        const work=this.edits.then(async()=>{
            assert(epoch===this.epoch&&guard(),'操作期间资料已变化');
            const wrapper=this.documentFor(target);
            assert(wrapper&&wrapper.data.id===target&&wrapper.data.type!=='story','资料归属不符；旧故事是只读废案');
            const next=await transform(copy(wrapper.data));
            if(same(next,wrapper.data))return wrapper;
            const saved=await this.repo.save(next,wrapper.revision,()=>epoch===this.epoch&&guard());
            assert(epoch===this.epoch&&guard(),'保存完成时资料已变化，请在原存档查看结果');
            if(target==='profile')this.profile=saved;else if(target===this.authorProfile?.data.id)this.authorProfile=saved;else this.inspiration=saved;
            this.changed();return saved;
        });
        this.edits=work.catch(()=>{});return work;
    }
    async createStory(){throw Error('故事核 / 大纲已废弃，请新建灵感存档');}
    async createInspiration(title,{from=null,select=true}={}) {
        assert(this.ready&&title?.trim(),'请填写灵感档名称并等待资料加载完成');
        const epoch=this.epoch;await this.edits;
        const source=from?(await this.repo.load(from))?.data:null;
        assert(!from||source&&['story','inspiration'].includes(source.type),'灵感复制来源不存在');
        const data=source?inspirationFrom(source,{title:title.trim()}):newDocument('inspiration',title.trim());
        if(source)data.manualSavedAt=Date.now();
        await this.repo.save(data,0,()=>epoch===this.epoch);assert(epoch===this.epoch,'资料已切换，灵感副本已保存');
        if(select)await this.selectInspiration(data.id);else this.changed();
        return select?'已新建并选用灵感档；作者选择保持不变':'已另存灵感副本；当前选择保持不变';
    }
    async selectInspiration(id){return this.selectArchive('inspiration',id);}
    async selectArchive(type,id){
        this.suspend();const epoch=this.epoch,chatKey=this.host.identity().chatKey,guard=()=>epoch===this.epoch&&chatKey===this.host.identity().chatKey;
        try{
            await this.edits;await this.repo.refresh();
            const profile=await this.upgrade(await this.repo.load('profile'),epoch);assert(guard(),'切换存档期间资料已变化');
            const authorId=type==='author'?id:(profile.data.activeAuthorId??'profile'),inspirationId=type==='inspiration'?id:profile.data.activeInspirationId;
            const author=authorId==='profile'?profile:await this.upgrade(await this.repo.load(authorId),epoch);
            assert(author&&(authorId==='profile'||author.data.type==='author'),'请选择作者档案');
            const inspiration=await this.upgrade(await this.repo.load(inspirationId),epoch);assert(inspiration?.data.type==='inspiration','请选择灵感档案');
            assert(guard(),'读取存档期间资料已变化');
            const next=copy(profile.data);next.activeAuthorId=authorId;next.activeInspirationId=inspirationId;
            const saved=same(next,profile.data)?profile:await this.repo.save(next,profile.revision,guard);
            assert(guard(),'保存选择期间资料已变化');
            this.profile=saved;this.authorProfile=authorId==='profile'?null:author;this.inspiration=inspiration;this.selectedKey=chatKey;
        }finally{if(epoch===this.epoch){this.ready=Boolean(this.profile&&this.inspiration&&this.selectedKey===chatKey);this.changed();}}
        await this.reconcile();
    }
    async createAuthor(title,{from=null}={}){
        assert(this.ready&&title?.trim(),'请填写作者名称并等待资料加载完成');
        const epoch=this.epoch,data=newDocument('author',title.trim());
        if(from){const source=await this.repo.load(from);assert(source,'来源资料不存在');const ids=new Set(source.data.records.filter(r=>AUTHOR_KINDS.includes(r.kind)).map(r=>r.id));data.records=copy(source.data.records.filter(r=>ids.has(r.id)));data.feedback=copy(source.data.feedback);data.history=copy(source.data.history.map(h=>({...h,changes:h.changes.filter(c=>ids.has(c.id))})).filter(h=>h.changes.length));data.excluded=source.data.excluded.filter(id=>ids.has(id));data.conflicts=copy(source.data.conflicts.filter(c=>ids.has(c.recordId)||c.feedbackId));for(const f of data.feedback)if(f.status==='queued')f.status='saved';}
        await this.edits;await this.repo.save(data,0,()=>epoch===this.epoch);assert(epoch===this.epoch,'资料已切换，作者副本已保存');await this.selectAuthor(data.id);
    }
    async selectAuthor(id){return this.selectArchive('author',id);}
    async selectStory(){throw Error('故事核 / 大纲已废弃，旧资料只读保留');}
    async reconcile() {
        if(!this.ready||!this.visible()||!this.host.identity().chatKey)return;
        const epoch=this.epoch,storyId=this.inspiration?.data.id,context=await this.host.capture();
        if(epoch!==this.epoch||storyId!==this.inspiration?.data.id||context.chatKey!==this.host.identity().chatKey)return;
        this.currentSources=context.sources;
        const hashes=new Map(context.sources.map(s=>[s.id,s.hash]));
        if(this.activeJob?.sources.some(s=>s.chatKey===context.chatKey&&hashes.get(s.id)!==s.hash))this.controller?.abort();
        const guard=()=>epoch===this.epoch&&context.chatKey===this.host.identity().chatKey;
        if(storyId)await this.edit(storyId,d=>invalidateSources(d,context.chatKey,context.sources),{guard});
        if(!guard())return;
        if(this.author)await this.edit(this.author.data.id,d=>{for(const f of d.feedback)if(f.source?.chatKey===context.chatKey)f.sourceChanged=hashes.get(f.source.id)!==f.source.hash;return d;},{guard});
    }
    startGenerationPreparation(){
        const chatKey=this.host.identity().chatKey;
        if(this.preparedGeneration?.chatKey===chatKey&&!this.preparedGeneration.cancelled)return this.preparedGeneration;
        this.sendCancelled=false;
        const prepared={chatKey,epoch:this.epoch};
        prepared.promise=this.prepareGeneration(prepared).then(value=>({value}),error=>({error}));
        this.preparedGeneration=prepared;return prepared;
    }
    async prepareGeneration(prepared){
        await this.chatRefresh;
        assert(!prepared.cancelled&&prepared.chatKey===this.host.identity().chatKey,'聊天已切换，本次准备已取消');
        this.host.foreground=true;
        if(!this.ready||!this.settings?.enabled||!this.author||!this.visible()||this.selectedKey!==this.host.identity().chatKey)return null;
        const epoch=this.epoch;
        await this.controlTask;assert(epoch===this.epoch&&!prepared.cancelled,'资料已切换，本次准备已取消');
        await this.reconcile();assert(epoch===this.epoch&&!prepared.cancelled,'资料已切换，本次准备已取消');
        const frozenInspiration=copy(this.inspiration?.data??newDocument('inspiration','未选择灵感','unbound'));
        // An in-flight author request must release the shared main connection first.
        if(this.host.rawPending){this.requestState='等待酒馆主连接释放';this.changed();try{await this.host.waitRaw?.();assert(!this.host.rawPending,'酒馆主连接尚未释放，请稍后重发正文');}finally{this.requestState='';}}
        assert(epoch===this.epoch&&!this.sendCancelled,'资料已切换或生成已停止，本次正文未发送');
        return {epoch,frozenInspiration};
    }
    async beforeGenerate(type='normal') {
        if(['quiet','impersonate'].includes(type))return;
        const prepared=this.preparedGeneration??this.startGenerationPreparation();
        let value;
        try{const result=await prepared.promise;if(result.error)throw result.error;value=result.value;}
        finally{if(this.preparedGeneration===prepared)this.preparedGeneration=null;}
        if(!value){this.host.inject('');return;}
        const {epoch,frozenInspiration}=value;
        assert(epoch===this.epoch&&!prepared.cancelled&&!this.sendCancelled&&prepared.chatKey===this.host.identity().chatKey,'资料已切换或生成已停止，本次正文未发送');
        const atSend=await this.host.capture();
        assert(epoch===this.epoch&&!this.sendCancelled,'读取正文材料期间聊天已变化');
        const validInspiration=invalidateSources(frozenInspiration,atSend.chatKey,atSend.sources);
        const token=uid(),frozen=injection(copy(this.author.data),validInspiration,this.settings,atSend,token);
        const baseHash=await inspirationHash(validInspiration);
        assert(epoch===this.epoch&&!this.sendCancelled,'准备注入期间聊天已变化');
        this.currentSources=atSend.sources;
        this.generation=this.inspiration?{token,epoch,storyId:this.inspiration.data.id,chatKey:atSend.chatKey,sources:atSend.sources,baseHash,visibleIds:frozen.visibleIds,lineIds:frozen.lineIds,inspirationIds:frozen.inspirationIds,counts:frozen.counts,features:frozen.features,controlEnabled:frozen.controlEnabled}:null;
        this.host.inject(frozen.text);this.lastInjection=frozen;this.controlStatus=frozen.controlEnabled?`已注入灵感协议；本轮灵感 ${frozen.counts.inspiration??0} 条，等待回复`:'本轮按注入开关提供资料，未要求灵感维护';this.changed();
    }
    async receiveControl(floor,generation=this.generation){
        if(!generation||generation!==this.generation||this.sendCancelled||generation.epoch!==this.epoch||generation.storyId!==this.inspiration?.data.id||!this.settings.enabled)return;
        const context=await this.host.capture(),row=context.rows.find(r=>r.floor===Number(floor));
        if(!row||row.role!=='assistant'||context.chatKey!==generation.chatKey||generation.epoch!==this.epoch||generation.storyId!==this.inspiration?.data.id)return;
        const source=context.sources.find(s=>s.id===row.id),key='control:'+row.id+':'+row.hash;
        this.currentSources=context.sources;
        if(this.inspiration.data.controls?.some(c=>c.source.id===source.id&&c.source.hash===source.hash))return;

        const activity={id:generation.token,chatKey:context.chatKey,source,prefixHash:sourcePrefixes(context.sources.filter(s=>s.floor<=row.floor)).get(source.id),at:Date.now(),...(generation.counts??{outline:0,writing:0,directory:0}),status:generation.controlEnabled===false?'not-requested':'missing',titleChanged:false,chapterChanged:false,revisionRequested:false};
        const saveActivity=d=>{d.activity=[...(d.activity??[]).filter(a=>a.source.id!==source.id),activity].slice(-20);return d;};
        const guard=()=>generation===this.generation&&!this.sendCancelled&&this.settings.enabled&&generation.epoch===this.epoch&&generation.storyId===this.inspiration?.data.id&&context.chatKey===this.host.identity().chatKey;
        if(generation.controlEnabled===false||!row.text.includes('[BBP_CONTROL]')){await this.edit(generation.storyId,saveActivity,{guard});this.controlStatus=generation.controlEnabled?'本轮未返回控制块，灵感未更新；可在工具→注入预览检查指令，或在提示词页恢复灵感控制信息默认值':'本轮未启用灵感维护，未要求控制块';this.changed();return;}
        try{
        const now=new Map(context.sources.map(s=>[s.id,s.hash]));
        assert(generation.sources.every(s=>s.id===row.id||now.get(s.id)===s.hash),'正文生成期间来源变化，控制信息未应用');
        const control=parseControl(row.text,generation.token,new Set(generation.visibleIds),{lineIds:new Set(generation.lineIds??[]),inspirationIds:new Set(generation.inspirationIds??[])});
        assert(control.version===4,'故事控制协议已废弃，请使用灵感 version:4 协议');
        activity.status='applied';activity.controlVersion=control.version;activity.chapterChanged=false;activity.revisionRequested=Boolean(control.revise);
        const sources=context.sources.filter(s=>s.floor<=row.floor);
        const local=control.version===4?storyControlChanges(this.inspiration.data,control,this.settings,{...context,rows:context.rows.filter(r=>r.floor<row.floor)}):null;
        if(local)activity.chapterChanged=local.updatedNodeIds.length>0;
        const receipt={id:uid(),version:control.version,token:control.token,chatKey:context.chatKey,source,sources:[source],prefixHash:sourcePrefixes(sources).get(source.id),chapter:control.chapter??null,nextIds:control.nextIds??[],...(local?{addedInspirationIds:local.addedInspirationIds,usedInspirationIds:local.usedInspirationIds,updatedNodeIds:local.updatedNodeIds}:{}),at:Date.now()};
        const latest=await this.host.capture(),latestHashes=new Map(latest.sources.map(s=>[s.id,s.hash]));
        assert(latest.chatKey===context.chatKey&&sources.every(s=>latestHashes.get(s.id)===s.hash),'读取资料期间来源已变化，控制信息未应用');
        await this.edit(this.inspiration.data.id,async d=>{
            assert(!generation.features||same(generation.features,{author:this.settings.injectAuthor!==false,story:false,inspiration:this.settings.injectInspiration!==false}),'正文期间注入开关已变化，旧控制信息未应用');
            assert(generation.epoch===this.epoch&&await inspirationHash(d)===generation.baseHash,'正文期间灵感已变化，控制信息未应用；可重新规划');
            d.controls??=[];if(d.controls.some(c=>c.source.id===source.id&&c.source.hash===source.hash))return d;
            if(local?.changes.length)d=applyChanges(d,local.changes,{origin:'storycontrol',sources,key,anchor:source});
            d.controls.push(receipt);return saveActivity(d);
        },{guard});
        this.controlStatus=`灵感新增 ${local.addedInspirationIds.length} 条；实际使用归档 ${local.usedInspirationIds.length} 条${local.skipped.length?'；'+local.skipped.join('；'):''}。无额外模型请求`;this.changed();
        }catch(error){
            if(guard()){activity.status='invalid';activity.titleChanged=false;activity.chapterChanged=false;activity.revisionRequested=false;await this.edit(generation.storyId,saveActivity,{guard}).catch(()=>{});}
            throw error;
        }
    }
    get recentStatus(){
        const sources=this.currentSources??[],chatKey=this.host.identity().chatKey,hashes=new Map(sources.map(s=>[s.id,s.hash])),prefixes=sourcePrefixes(sources);
        const recent=(this.inspiration?.data.activity??[]).filter(a=>a.chatKey===chatKey&&hashes.get(a.source.id)===a.source.hash&&prefixes.get(a.source.id)===a.prefixHash).slice(-5);
        const counts=this.lastInjection.counts??recent.at(-1);
        const lines=[counts?`最近正文注入：灵感 ${counts.inspiration??0} 条 · 写作 ${counts.writing} 条`:'尚无正文调用记录'];
        for(const a of [...recent].reverse())lines.push(`#${sources.find(s=>s.id===a.source.id)?.floor??'?'} 楼 · ${{'not-requested':'未要求灵感维护',missing:'未返回控制块',invalid:'控制未通过校验',applied:'灵感已处理'}[a.status]}`);
        lines.push(`本次打开：API 请求 ${this.stats.calls} 次 · 任务成功 ${this.stats.success} / 失败 ${this.stats.failed}`);return lines;
    }
    taskSettings(kind,job=null){return {...copy(this.settings),connection:job?.connection??this.settings.connection};}
    async queueJob(kind,{key=uid(),feedback=[],connection}={}) {
        assert(kind==='feedback','故事核 / 大纲及初始化维护已废弃');
        const epoch=this.epoch,owner=this.author;assert(owner,'请先选择作者');const storyId=owner.data.id;
        const job={id:uid(),kind,key,connection:connection??this.settings.connection,chatKey:this.host.identity().chatKey??'',input:'',sources:[],anchor:null,signal:null,feedback:copy(feedback),at:Date.now(),attempts:0,state:'queued'};
        await this.edit(storyId,d=>{
            assert(d.jobs.length<60,'维护待办已达 60 条，请先处理或导出');
            if(d.processed.includes(key)||d.jobs.some(j=>j.key===key)||d.proposals.some(j=>j.key===key))return d;
            for(const f of feedback)if(f.id){const current=d.feedback.find(x=>x.id===f.id);assert(current&&['saved','queued'].includes(current.status),'准备材料期间点评已撤回或处理，未发送');current.status='queued';}
            d.jobs.push(job);return d;
        });
        return job;
    }
    drain({before=false}={}) {
        if(this.auxiliary||this.preparing||this.resumeTask)return Promise.resolve();
        if(this.running)return this.running;
        const run=async()=>{
            while(this.ready&&this.visible()&&this.settings.enabled){
                const entry=this.jobs.find(({job})=>job.state==='queued'&&job.kind==='feedback');if(!entry)return;const {job,target}=entry;
                if(this.taskSettings(job.kind,job).connection==='main' && (this.host.rawPending||this.foreground&&!before))return;
                await this.runJob(copy(job),target);
            }
        };
        this.running=run().finally(()=>{this.running=null;this.changed();});return this.running;
    }
    async runJob(job,ownerId=this.author?.data.id) {
        assert(job.kind==='feedback','旧故事任务已废弃，不再运行');
        const owner=this.documentFor(ownerId),authorTask=owner.data.type!=='story'&&job.kind==='feedback';
        const epoch=this.epoch,storyId=ownerId,settings=this.taskSettings(job.kind,job),baseHash=await hash(JSON.stringify(owner.data.records));
        this.controller=new AbortController();const controller=this.controller;
        this.activeJob={...job,ownerId};
        try{
            this.requestState='准备材料';this.changed();
            const material=maintenanceMaterial(job,this.documentFor(ownerId).data,this.authorMaterial()),prompt=maintenancePrompt(job,this.documentFor(ownerId).data,this.authorMaterial(),material);
            const promptHash=await hash(JSON.stringify([promptText(settings,'system'),prompt,settings.connection,settings.model,settings.endpoint]));
            this.stats.materialOmitted=material.omitted;
            await this.edit(storyId,d=>{const j=d.jobs.find(j=>j.id===job.id);assert(j,'任务已失效');j.attempts++;return d;});
            this.changed();
            const beforeContext=authorTask?{chatKey:job.chatKey,sources:[]}:await this.host.capture(),hashes=new Map(beforeContext.sources.map(s=>[s.id,s.hash]));
            if(!authorTask)this.currentSources=beforeContext.sources;
            assert(authorTask||beforeContext.chatKey===job.chatKey&&job.sources.every(s=>s.chatKey!==job.chatKey||hashes.get(s.id)===s.hash),'任务来源已变化，请重新维护');
            assert(epoch===this.epoch&&!controller.signal.aborted,'任务已取消');
            const cacheKey=`result:${storyId}:${job.id}`,cached=this.resultCache.get(cacheKey)??await this.readLocal(cacheKey);
            const result=cached?.baseHash===baseHash&&cached?.promptHash===promptHash&&cached?.chatKey===job.chatKey?cached.result:await this.request(prompt,settings,controller.signal);
            this.requestState='解析与校验';this.changed();
            await this.writeLocal(`diagnostic:${storyId}:${job.id}`,{text:responseText(result).slice(0,200000),at:Date.now(),kind:job.kind});
            assert(!controller.signal.aborted&&epoch===this.epoch,'维护结果已过期');
            const context=authorTask?{chatKey:job.chatKey,sources:[]}:await this.host.capture();
            assert(authorTask||context.chatKey===job.chatKey,'任务所属聊天已切换');
            const current=new Map(context.sources.map(s=>[s.id,s.hash]));
            assert(authorTask||job.sources.every(s=>s.chatKey!==context.chatKey||current.get(s.id)===s.hash),'来源已被编辑或删除，结果不应用');
            const changes=parseChanges(result);
            const visibleIds=new Set(material.current.map(r=>r.id));
            for(const c of changes){const id=c.id??c.record?.id;assert(!this.documentFor(ownerId).data.records.some(r=>r.id===id)||visibleIds.has(id),'模型试图修改本次预算未提供的条目，结果未应用');}
            await this.edit(storyId,async d=>{
                assert(await hash(JSON.stringify(d.records))===baseHash,'资料已被修改，请重试维护以合并最新资料');
                const options={origin:job.kind,sources:job.sources,key:job.key,anchor:job.anchor,feedbackIds:job.feedback.map(f=>f.id).filter(Boolean)};
                const candidate=applyChanges(d,changes,options); // Validate protection even in review mode.
                const resultCopy={baseHash,promptHash,chatKey:job.chatKey,result};this.resultCache.set(cacheKey,resultCopy);await this.writeLocal(cacheKey,resultCopy);
                const important=changes.some(c=>c.op==='remove'||c.record?.importance==='major'||d.records.find(r=>r.id===(c.id??c.record?.id))?.importance==='major') || job.kind==='feedback';
                let next;this.requestState='应用与保存';
                if(changes.length && settings.mode!=='auto' && (settings.mode==='manual'||important)) {
                    next=d;next.proposals.push({...job,changes,baseHash,state:'review',completedAt:Date.now()});
                } else next=candidate;
                next.jobs=next.jobs.filter(j=>j.id!==job.id);
                if(!next.proposals.some(p=>p.id===job.id)){next.processed=[...new Set([...next.processed,...job.pairKeys??[]])];for(const f of next.feedback)if(job.feedback.some(x=>x.id===f.id))f.status='processed';}
                return next;
            },{guard:()=>epoch===this.epoch&&!controller.signal.aborted&&(authorTask||this.host.identity().chatKey===job.chatKey)});
            this.resultCache.delete(cacheKey);await this.writeLocal(cacheKey,null).catch(()=>{});
            this.stats.success++;this.stats.usage=result?.usage??null;
        }catch(error){
            this.stats.failed++;
            if(epoch===this.epoch&&this.documentFor(ownerId)?.data.id===storyId){
                await this.edit(storyId,d=>{const j=d.jobs.find(j=>j.id===job.id);if(j){j.state='failed';j.retryable=transient(error);j.error=String(error.message).slice(0,300);}return d;}).catch(()=>{});
                this.report(error);
            }
        }finally{if(this.controller===controller){this.controller=null;this.activeJob=null;}this.requestState='';this.changed();}
    }
    async reviewProposal(id,accept,target=this.author?.data.id) {
        const context=this.host.identity().chatKey?await this.host.capture():{chatKey:'',sources:[]},now=new Map(context.sources.map(s=>[s.id,s.hash]));
        await this.edit(target,async d=>{
            const p=d.proposals.find(p=>p.id===id);assert(p&&p.kind==='feedback','提案不存在或已废弃');let next=d;
            if(accept){assert(d.type!=='story'||p.chatKey===context.chatKey,'请回到提案所属聊天审阅，或拒绝后在此聊天重新维护');assert(await hash(JSON.stringify(d.records))===p.baseHash,'资料已变化，请拒绝旧提案并重新维护');assert(d.type!=='story'||p.sources.every(s=>s.chatKey!==context.chatKey||now.get(s.id)===s.hash),'提案来源已变化');next=applyChanges(d,p.changes,{origin:p.kind,sources:p.sources,key:p.key,anchor:p.anchor,feedbackIds:p.feedback.map(f=>f.id).filter(Boolean)});for(const f of next.feedback)if(p.feedback.some(x=>x.id===f.id))f.status='processed';}
            else {next.processed.push(p.key);for(const f of next.feedback)if(p.feedback.some(x=>x.id===f.id))f.status='saved';}
            next.processed=[...new Set([...next.processed,...p.pairKeys??[]])];next.proposals=next.proposals.filter(x=>x.id!==id);return next;
        });
    }
    async manual(){throw Error('故事核 / 大纲及初始化维护已废弃');}
    async auxiliaryRequest(prompt,settings=this.settings,options={},validate=result=>result) {
        assert(!this.running&&!this.auxiliary,'已有维护或连接请求，请完成后重试');
        if(settings.connection==='main')assert(!this.foreground&&!this.host.rawPending,this.host.mainBusyReason?.()||'酒馆主连接正在生成，请完成后重试');
        const controller=new AbortController(),epoch=this.epoch;
        this.auxController=controller;this.auxiliary=true;this.changed();
        try{const raw=await this.request(prompt,copy(settings),controller.signal,options);assert(!controller.signal.aborted&&epoch===this.epoch,'聊天或设置已变化，请重新操作');const result=validate(raw);this.stats.success++;return result;}
        catch(e){this.stats.failed++;throw e;}
        finally{this.auxiliary=false;this.requestState='';if(this.auxController===controller)this.auxController=null;this.changed();}
    }
    async request(prompt,settings,signal,options={}) {
        return retryRequest(async child=>{
            // Cancelling our wait can leave generateRaw running. Never overlap it.
            if(settings.connection==='main')assert(!this.host.rawPending&&!this.foreground,this.host.mainBusyReason?.()||'酒馆主连接仍在处理请求；任务已保留，完成后可重试');
            this.stats.calls++;this.changed();return this.host.request(prompt,settings,child,options);
        },{signal,timeoutSeconds:settings.timeoutSeconds,onState:state=>{this.requestState=state;this.changed();},...(this.retryOptions??{}),abortOnTimeout:settings.connection!=='main'});
    }
    async prepareInitialization(){throw Error('故事核初始化已废弃');}
    async completeInitialization(){throw Error('故事核初始化已废弃');}
    draftEntry(){return null;}
    get initialization(){return null;}
    async readLocal(key){return this.host.local?await this.host.local.getItem(this.host.prefix+key):null;}
    writeLocal(key,value){
        const snapshot=copy(value),write=this.localWrites.then(()=>this.host.local?.setItem(this.host.prefix+key,snapshot));
        this.localWrites=write.catch(()=>{});return write;
    }
    async saveCurrent(target=this.inspiration?.data.id){
        assert(this.ready&&this.documentFor(target),'请先选择存档');
        await this.edit(target,d=>{d.manualSavedAt=Math.max(Date.now(),(d.manualSavedAt??0)+1);return d;});
        return '已保存到酒馆服务器并建立手动保存点';
    }
    async loadSavedInspiration(id){
        await this.selectInspiration(id);const epoch=this.epoch,revision=this.inspiration.revision;
        const entry=this.repo.index.documents[id]?.saved;assert(entry,'此档没有手动保存点');
        const historical=await this.repo.loadVersion(id,entry);
        await this.edit(id,d=>{const next=restoreDocument(d,historical.data);next.manualSavedAt=d.manualSavedAt;return next;},{guard:()=>epoch===this.epoch&&this.inspiration?.data.id===id&&this.inspiration.revision===revision});
        await this.reconcile();return '已读取手动保存点；加载前版本保留在版本恢复中';
    }
    async testConnection(settings=this.settings,key=this.host.key) {
        validateSettings(settings);
        const start=Date.now();await this.auxiliaryRequest(promptText(settings,'connectionTest'),settings,{key},result=>{
            const text=typeof result==='string'?result:result?.text;
            assert(typeof text==='string'&&text.trim(),'API 请求成功但没有返回文本，请检查模型名称及接口协议');return result;
        });
        return `连接成功 · ${settings.connection==='main'?'酒馆当前主模型':settings.model} · ${((Date.now()-start)/1000).toFixed(1)} 秒 · 已收到文本响应`;
    }
    async saveRecord(target,r,expected=undefined) {
        const epoch=this.epoch;
        const context=this.host.identity().chatKey?await this.host.capture():{sources:[]};
        assert(epoch===this.epoch,'准备保存条目期间资料已变化，输入保留');
        const owner=this.documentFor(target);assert(owner&&(owner.data.type==='inspiration'?r.kind==='inspiration':AUTHOR_KINDS.includes(r.kind)),'条目类别不属于当前存档；故事核 / 大纲已废弃');
        await this.edit(target,d=>{const before=d.records.find(x=>x.id===r.id)??null;if(expected!==undefined)assert(same(before,expected),'条目已变化，输入仍保留；请重新打开最新条目后合并');if(r.kind==='inspiration'&&r.status==='active'&&before?.status!=='active')assert(d.records.filter(x=>x.kind==='inspiration'&&x.status==='active').length<(this.settings.inspirationCapacity??20),'待用灵感已达上限，请先归档或提高上限');return applyChanges(d,[{op:'put',record:r}],{actor:'user',anchor:context.sources.at(-1)??null});});
    }
    feedbackConnection(category='writing'){return category==='plot'?(this.settings.plotConnection??'main'):this.settings.connection;}
    async addFeedback({quote,note='',polarity='neutral',source=null,status='saved',category='writing',connection}) {
        assert(['writing','plot'].includes(category),'请选择剧情或写作分类');
        const owner=this.author,chatKey=this.host.identity().chatKey;
        assert(owner,'请先选择作者');
        assert(quote.length>0&&quote.length<=50000,'请选择不超过 5 万字符的文字');
        assert(['positive','negative','neutral'].includes(polarity)&&['saved','queued'].includes(status),'点评选项无效');
        if(category==='plot')assert((!source||source.chatKey===chatKey),'剧情选段不属于当前聊天，请重新载入');
        connection??=this.feedbackConnection(category);assert(['main','custom'].includes(connection),'点评连接无效');
        const id=uid();await this.edit(owner.data.id,d=>{d.feedback.push({id,quote,note,polarity,source,status,category,connection,...(category==='plot'?{chatKey:chatKey??''}:{}),at:Date.now()});return d;});
        if(status==='queued')void this.maybeSummarizeFeedback().catch(e=>this.report(e));return id;
    }
    feedbackGroups(owner,ids=null){
        const reserved=new Set([...owner.jobs,...owner.proposals].flatMap(j=>j.feedback.map(f=>f.id))),groups=new Map();
        for(const f of owner.feedback){
            if(reserved.has(f.id)||!['saved','queued'].includes(f.status)||ids&&!ids.includes(f.id)||!ids&&f.status!=='queued')continue;
            if(owner.type==='story'&&(f.category!=='plot'||f.chatKey!==this.host.identity().chatKey))continue;
            const connection=f.connection??this.feedbackConnection(f.category),key=(f.category??'writing')+':'+connection;
            if(!groups.has(key))groups.set(key,{category:f.category??'writing',connection,items:[]});groups.get(key).items.push(f);
        }
        return [...groups.values()];
    }
    async maybeSummarizeFeedback(){
        if(this.feedbackChecking||!this.ready||!this.author||!this.settings.enabled||this.settings.mode==='manual')return;
        this.feedbackChecking=true;
        try{const owner=this.author;for(const group of this.feedbackGroups(owner.data))if(group.items.length>=(this.settings.feedbackThreshold??5))await this.sendFeedback(group.items.map(f=>f.id),owner.data.id);}
        finally{this.feedbackChecking=false;}
    }
    async sendFeedback(ids,target=this.author.data.id) {
        const epoch=this.epoch;
        const pending=(this.feedbackSubmissions??Promise.resolve()).then(()=>{assert(epoch===this.epoch&&this.documentFor(target),'作者或聊天已切换，点评未提交到新存档');return this.submitFeedback(ids,target);});
        this.feedbackSubmissions=pending.catch(()=>{});return pending;
    }
    async submitFeedback(ids,target) {
        assert(target===this.author?.data.id,'作者已切换，请在原作者档案中提交点评');
        const owner=this.author,epoch=this.epoch,groups=this.feedbackGroups(owner.data,ids);
        assert(groups.length,'没有待发送点评，或选中点评已在任务队列中；请在所属作者档案中发送');
        for(const {category,connection,items} of groups){
            assert(epoch===this.epoch,'资料已切换，已排队的点评保留在原存档');
            await this.queueJob('feedback',{key:'feedback:'+uid(),feedback:items,connection});
        }
        await this.drain();
    }
    async withdrawFeedback(id,target=this.author.data.id){
        if(this.activeJob?.ownerId===target&&this.activeJob.feedback.some(f=>f.id===id))this.controller?.abort();
        await this.edit(target,d=>{const f=d.feedback.find(f=>f.id===id);assert(f,'点评不存在');f.status='withdrawn';
            const cancelled=[...d.jobs,...d.proposals].filter(j=>j.feedback.some(x=>x.id===id));
            const release=new Set(cancelled.flatMap(j=>j.feedback.map(x=>x.id)));
            for(const other of d.feedback)if(other.id!==id&&release.has(other.id)&&other.status==='queued')other.status='saved';
            d.jobs=d.jobs.filter(j=>!j.feedback.some(x=>x.id===id));d.proposals=d.proposals.filter(j=>!j.feedback.some(x=>x.id===id));
            const affected=d.history.filter(h=>h.feedbackIds?.includes(id)).flatMap(h=>h.changes.map(c=>c.id));d.excluded=[...new Set([...d.excluded,...affected])];d.conflicts.push({id:uid(),reason:'feedback-withdrawn',feedbackId:id,at:Date.now()});return d;
        });
    }
    async saveSettings(settings,expected){validateSettings(settings);await this.edit('profile',d=>{if(expected)assert(same(d.settings,expected),'已保存的设置发生了变化，当前输入仍保留；请载入已保存设置后重新调整');d.settings=settings;return d;});this.controller?.abort();this.auxController?.abort();this.generation=null;this.host.controlFilter?.(settings.enabled);this.host.inject('');this.lastInjection={text:'',omitted:0};if(!settings.enabled){this.waitResolve?.('cancel');this.host.inject('');}}
    async retryJobs(id=null,target=null){
        assert(!this.running&&!this.auxiliary,'当前请求尚未结束，请稍后重试');
        const selected=this.jobs.filter(x=>(!id||x.job.id===id)&&(!target||x.target===target)&&x.job.kind==='feedback');assert(selected.length,'没有可重试的点评任务');
        for(const scope of new Set(selected.map(x=>x.target)))await this.edit(scope,d=>{for(const j of d.jobs)if(selected.some(x=>x.target===scope&&x.job.id===j.id)){j.state='queued';delete j.error;delete j.retryable;}return d;});
        await this.drain();
        return this.jobs.some(x=>x.job.state==='failed')?'仍有失败任务，请查看任务原因和原始响应':this.jobs.length?'任务已排队，正在等待连接空闲':this.proposals.length?'结果已生成，等待应用提案':'任务已完成并应用';
    }
    exportPromptSet(){return exportPrompts(this.settings);}
    async importPromptSet(data){await this.saveSettings({...this.settings,prompts:importPrompts(data)},copy(this.settings));return '提示词已导入并保存到服务器';}
    async diagnostic(id,target=this.author?.data.id){return await this.readLocal(`diagnostic:${target}:${id}`);}
    cancelRequests(){this.controller?.abort();this.auxController?.abort();return '已停止当前请求；未完成点评任务保留';}
    async bindMemory(){throw Error('旧故事联动已废弃，灵感与作者均独立选择');}
    async followMemory(){return;}
    async restore(id,entry){const epoch=this.epoch,revision=this.documentFor(id)?.revision;assert(revision,'请先选择要恢复的档案');const historical=await this.repo.loadVersion(id,entry);assert(epoch===this.epoch&&this.documentFor(id)?.revision===revision,'读取恢复版本期间资料已变化');await this.edit(id,d=>{const next=retireTasks(restoreDocument(d,historical.data));if(d.type==='profile'){next.activeInspirationId=d.activeInspirationId;next.activeAuthorId=d.activeAuthorId??'profile';if(d.chatBindings)next.chatBindings=copy(d.chatBindings);}return next;},{guard:()=>epoch===this.epoch&&this.documentFor(id)?.revision===revision});await this.reconcile();}
    async exportAll(){const documents=[];for(const id of Object.keys(this.repo.index.documents))documents.push((await this.repo.load(id)).data);return {format:'bbpresets-export',schema:1,at:Date.now(),documents};}
    async exportScope(id){const document=(await this.repo.load(id))?.data;assert(document,'资料不存在');const data=copy(document);if(data.type==='profile'){data.type='author';delete data.settings;delete data.activeAuthorId;delete data.chatBindings;delete data.activeInspirationId;data.records=data.records.filter(r=>AUTHOR_KINDS.includes(r.kind));}return {format:'bbpresets-export',schema:1,at:Date.now(),documents:[data]};}
    async importArchive(archive){
        assert(archive?.format==='bbpresets-export'&&archive.schema===1&&Array.isArray(archive.documents)&&archive.documents.length<200,'不是支持的导入文件');
        // Import independent copies, preserving story/author ownership. Never change the active author.
        archive.documents.forEach(validateDocument);
        const epoch=this.epoch;
        await this.edits;
        for(const raw of archive.documents){const d=copy(raw);d.id=uid();d.title=('导入 · '+d.title).slice(0,300);d.type=['story','inspiration'].includes(raw.type)?raw.type:'author';delete d.settings;delete d.activeAuthorId;delete d.chatBindings;delete d.activeInspirationId;if(d.type==='author')d.records=d.records.filter(r=>AUTHOR_KINDS.includes(r.kind));d.bindings=[];d.memoryBinding=null;if(d.jobs.length||d.proposals.length)d.retiredTasks=[...(d.retiredTasks??[]),...d.jobs,...d.proposals].map(j=>({...j,state:'retired'}));d.jobs=[];d.proposals=[];for(const f of d.feedback)if(f.status==='queued')f.status='saved';d.parent=null;await this.repo.save(d,0,()=>this.epoch===epoch);}
        await this.migrateInspirations(epoch);this.changed();
    }
    destroy(){clearInterval(this.queueTimer);this.suspend();this.host.destroy();}
}
