import {assert,copy,same,uid,hash,newDocument,applyChanges,invalidateSources,forkAt,restoreDocument,validateDocument,validateSettings,record,migrateAuthor,OUTLINE_KINDS,AUTHOR_KINDS} from '../core/model.js';
import {Repository} from '../core/repository.js';
import {injection,maintenancePrompt,maintenanceMaterial,parseChanges,parseQuestions} from './prompts.js';
import {newDraft,questionSet,draftAnswers,validateDraft} from '../core/initialization.js';
import {retryRequest,transient} from './network.js';
import {promptText,exportPrompts,importPrompts} from '../core/prompt-templates.js';
import {responseText} from '../core/json.js';
import {parseControl,stripControl} from '../core/outline.js';
import {sourcePrefixes} from '../core/source-prefix.js';

const outlineHash=doc=>hash(JSON.stringify(doc.records.filter(r=>OUTLINE_KINDS.includes(r.kind))));

export class BBPresetsApp {
    constructor(host,{notify=()=>{},visible=()=>!globalThis.document?.hidden}={}) {
        this.host=host;this.notify=notify;this.visible=visible;this.epoch=0;this.story=null;this.profile=null;this.listeners=new Set();this.edits=Promise.resolve();this.running=null;this.controller=null;this.error='';this.status='loading';this.lastInjection={text:'',omitted:0};this.stats={calls:0,success:0,failed:0,usage:null};this.ready=false;
        this.drafts=new Map();this.localWrites=Promise.resolve();this.resultCache=new Map();this.requestState='';this.generation=null;this.controlTask=Promise.resolve();this.controlStatus='';this.waitingOutline=false;
    }
    changed(){for(const fn of this.listeners)fn();}
    report(error){this.error=error.message??String(error);this.notify(this.error,'error');this.changed();}
    get settings(){return this.profile?.data.settings;}
    get author(){return this.authorProfile??this.profile;}
    get scopes(){return [this.story,this.author].filter(Boolean);}
    documentFor(id){return [this.profile,this.story,this.authorProfile].find(w=>w?.data.id===id);}
    get jobs(){return this.scopes.flatMap(w=>w.data.jobs.map(job=>({job,target:w.data.id})));}
    get proposals(){return this.scopes.flatMap(w=>w.data.proposals.map(job=>({job,target:w.data.id})));}
    authorMaterial(){return {...copy(this.author.data),settings:copy(this.settings)};}
    async init() {
        await this.host.prepare?.();
        this.recovery=await this.host.createRecovery();
        this.repo=new Repository(this.host.transport(),{recovery:this.recovery,onStatus:(status,error)=>{this.status=status;if(error)this.error=error.message;else if(status==='saved')this.error='';this.changed();}});
        this.host.on('CHAT_CHANGED',()=>{this.host.foreground=false;this.suspend();this.refresh().catch(e=>this.report(e));});
        this.host.on('GENERATION_STARTED',(type,_options,dryRun)=>{if(!dryRun&&type!=='quiet')this.host.foreground=true;});
        // GENERATION_ENDED receives chat.length, not the generation type.
        const ended=()=>{this.host.foreground=false;setTimeout(()=>this.resumeQueue(),0);};
        this.host.on('GENERATION_ENDED',ended);
        this.host.on('GENERATION_STOPPED',()=>{this.sendCancelled=true;this.generation=null;this.controller?.abort();this.auxController?.abort();this.waitResolve?.('cancel');ended();});
        this.host.on('MESSAGE_RECEIVED',(floor,type)=>{if(type==='quiet'||type==='first_message')return;const generation=this.generation;this.controlTask=this.controlTask.then(()=>this.receiveControl(floor,generation)).catch(e=>{this.controlStatus=e.message;this.changed();});});
        for(const event of ['MESSAGE_SWIPED','MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_DELETED'])this.host.on(event,()=>{this.reconcile().catch(e=>this.report(e));});
        for(const event of ['MAIN_API_CHANGED','OAI_PRESET_CHANGED_AFTER','CHATCOMPLETION_MODEL_CHANGED','CONNECTION_PROFILE_LOADED'])this.host.on(event,()=>{this.controller?.abort();this.auxController?.abort();});
        await this.refresh();
        this.ready=true;this.changed();
        // An aborted/offline request may never emit ENDED. Consult the host's live flag.
        this.queueTimer=setInterval(()=>this.resumeQueue(),1000);this.queueTimer.unref?.();
    }
    get foreground(){return this.host.isForeground?.()??this.host.foreground;}
    async resumeQueue(){
        if(!this.visible()||this.foreground||this.resumeTask||this.preparing||this.buildingInitialization)return;
        try{
            await this.controlTask;
            // A send can begin while a separate question/API test owns the queue.
            // Once it releases, resume the waiting revision without another user click.
            if(this.waitingOutline){await this.drain({before:true,outlineOnly:true});if(!this.auxiliary&&this.story&&![...this.story.data.jobs,...this.story.data.proposals].some(j=>j.kind==='outline'))this.waitResolve?.('done');return;}
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
        this.resumeTask=(async()=>{await this.refresh();this.needsRefresh=false;const entry=this.draftEntry();if(entry?.dirty)await this.flushDraft();for(const scope of this.scopes)if(scope.data.jobs.some(j=>j.state==='failed'&&j.retryable))await this.edit(scope.data.id,d=>{for(const j of d.jobs)if(j.retryable){j.state='queued';delete j.retryable;}return d;});})();
        try{await this.resumeTask;}finally{this.resumeTask=null;}
        await this.drain();
    }
    suspend(){this.epoch++;this.ready=false;this.generation=null;this.waitResolve?.('cancel');clearTimeout(this.draftTimer);this.controller?.abort();this.auxController?.abort();this.host.inject('');this.lastInjection={text:'',omitted:0};}
    async upgrade(wrapper,epoch=this.epoch){if(!wrapper)return wrapper;const next=migrateAuthor(wrapper.data);return same(next,wrapper.data)?wrapper:this.repo.save(next,wrapper.revision,()=>this.epoch===epoch);}
    async refresh() {
        this.suspend();const epoch=this.epoch;await this.edits;await this.repo.refresh();
        let profile=await this.repo.load('profile');
        if(!profile)profile=await this.repo.save(newDocument('profile','用户写作指南','profile'),0,()=>this.epoch===epoch);
        if(epoch!==this.epoch)return;
        profile=await this.upgrade(profile,epoch);
        const authorId=profile.data.activeAuthorId;let authorProfile=null,story=null;
        if(authorId&&authorId!=='profile'){authorProfile=await this.repo.load(authorId);assert(authorProfile?.data.type==='author','选定作者不存在，请恢复作者存档');}
        if(epoch!==this.epoch)return;
        const chatKey=this.host.identity().chatKey, binding=this.host.ctx().chatMetadata?.bbpresetsBinding;
        if(binding?.chatKey===chatKey && this.repo.index.documents[binding.storyId])story=await this.upgrade(await this.repo.load(binding.storyId),epoch);
        if(epoch!==this.epoch)return;
        this.profile=profile;this.story=story;this.authorProfile=authorProfile;this.selectedKey=chatKey;
        this.branchCandidate=binding&&binding.chatKey!==chatKey?copy(binding):null;
        this.host.controlFilter?.(this.settings.enabled);
        await this.loadDraft();if(epoch!==this.epoch)return;
        this.ready=true;this.error='';this.status='saved';
        if(this.story)await this.reconcile();
        this.changed();
    }
    edit(target,transform,{guard=()=>true}={}) {
        const epoch=this.epoch;
        const work=this.edits.then(async()=>{
            assert(epoch===this.epoch&&guard(),'操作期间故事已变化');
            const wrapper=this.documentFor(target);
            assert(wrapper&&wrapper.data.id===target,'资料归属不符');
            const next=await transform(copy(wrapper.data));
            if(same(next,wrapper.data))return wrapper;
            const saved=await this.repo.save(next,wrapper.revision,()=>epoch===this.epoch&&guard());
            if(target==='profile')this.profile=saved;else if(target===this.authorProfile?.data.id)this.authorProfile=saved;else this.story=saved;
            this.changed();return saved;
        });
        this.edits=work.catch(()=>{});return work;
    }
    async createStory(title,{from=null}={}) {
        assert(this.ready,'正在读取当前聊天资料，请稍后再新建存档');
        const epoch=this.epoch;
        assert(title?.trim(),'请填写存档名称');const context=await this.host.capture();
        let data;
        if(from){const source=await this.repo.load(from);assert(source,'分支来源不存在');const oldChatKey=this.branchCandidate?.storyId===from?this.branchCandidate.chatKey:context.chatKey;data=forkAt(source.data,{title,chatKey:oldChatKey,destinationChatKey:context.chatKey,sources:context.sources.map(s=>({...s,chatKey:oldChatKey}))});}
        else data=newDocument('story',title);
        await this.edits;
        await this.repo.save(data,0,()=>epoch===this.epoch&&context.chatKey===this.host.identity().chatKey);
        assert(epoch===this.epoch&&context.chatKey===this.host.identity().chatKey,'新建期间聊天已变化，副本已保存但未绑定');
        await this.selectStory(data.id);
    }
    async createAuthor(title,{from=null}={}){
        assert(this.ready&&title?.trim(),'请填写作者名称并等待资料加载完成');
        const epoch=this.epoch,data=newDocument('author',title.trim());
        if(from){const source=await this.repo.load(from);assert(source,'来源资料不存在');const ids=new Set(source.data.records.filter(r=>AUTHOR_KINDS.includes(r.kind)).map(r=>r.id));data.records=copy(source.data.records.filter(r=>ids.has(r.id)));data.feedback=copy(source.data.feedback);data.history=copy(source.data.history.map(h=>({...h,changes:h.changes.filter(c=>ids.has(c.id))})).filter(h=>h.changes.length));data.excluded=source.data.excluded.filter(id=>ids.has(id));data.conflicts=copy(source.data.conflicts.filter(c=>ids.has(c.recordId)||c.feedbackId));}
        await this.edits;await this.repo.save(data,0,()=>epoch===this.epoch);assert(epoch===this.epoch,'资料已切换，作者副本已保存');await this.selectAuthor(data.id);
    }
    async selectAuthor(id){
        this.suspend();const epoch=this.epoch;await this.edits;await this.repo.refresh();
        try{const selected=await this.repo.load(id);assert(selected&&(id==='profile'||selected.data.type==='author'),'请选择作者档案');
            const profile=await this.repo.load('profile');assert(epoch===this.epoch,'切换作者期间资料已变化');this.profile=profile;
            await this.edit('profile',d=>{d.activeAuthorId=id;return d;});assert(epoch===this.epoch,'切换作者期间资料已变化');this.authorProfile=id==='profile'?null:selected;
        }finally{if(epoch===this.epoch){this.ready=true;this.changed();}}
    }
    async selectStory(id) {
        this.suspend();const epoch=this.epoch,identity=this.host.identity();await this.edits;await this.repo.refresh();
        const selected=await this.repo.load(id);assert(selected?.data.type==='story','请选择故事存档');
        assert(epoch===this.epoch&&identity.chatKey===this.host.identity().chatKey,'选择期间聊天已变化');assert(identity.chatKey,'请先打开聊天');
        this.story=await this.upgrade(selected,epoch);
        this.selectedKey=identity.chatKey;
        this.host.ctx().chatMetadata.bbpresetsBinding={storyId:id,chatKey:identity.chatKey};
        await this.host.ctx().saveMetadata();
        assert(epoch===this.epoch&&this.host.identity().chatKey===identity.chatKey,'保存绑定期间聊天变化');
        await this.loadDraft();assert(epoch===this.epoch,'读取草稿期间故事已切换');
        this.ready=true;this.changed();
        await this.reconcile();
    }
    async reconcile() {
        if(!this.ready||!this.visible()||!this.host.identity().chatKey)return;
        const context=await this.host.capture(),storyId=this.story?.data.id;
        this.currentSources=context.sources;
        const hashes=new Map(context.sources.map(s=>[s.id,s.hash]));
        if(this.activeJob?.sources.some(s=>s.chatKey===context.chatKey&&hashes.get(s.id)!==s.hash))this.controller?.abort();
        if(storyId)await this.edit(storyId,d=>invalidateSources(d,context.chatKey,context.sources));
        if(this.author)await this.edit(this.author.data.id,d=>{for(const f of d.feedback)if(f.source?.chatKey===context.chatKey)f.sourceChanged=hashes.get(f.source.id)!==f.source.hash;return d;});
    }
    async beforeGenerate(type='normal') {
        if(['quiet','impersonate'].includes(type))return;
        this.sendCancelled=false;
        this.host.foreground=true;
        if(!this.ready||!this.settings?.enabled||!this.author||!this.visible()||this.selectedKey!==this.host.identity().chatKey){this.host.inject('');return;}
        await this.followMemory();
        const epoch=this.epoch;
        if(!this.ready)return;
        await this.controlTask;
        await this.reconcile();
        let frozenStory=copy(this.story?.data??newDocument('story','未选择大纲','unbound'));
        if(this.story&&this.settings.waitOutline!==false&&[...this.story.data.jobs,...this.story.data.proposals].some(j=>j.kind==='outline')){
            this.waitingOutline=true;this.waitMessage='正在修订大纲，完成后继续正文';this.changed();
            this.host.maintenanceBefore=true;
            try{
                const choice=new Promise(resolve=>{this.waitResolve=resolve;});
                const work=this.drain({before:true,outlineOnly:true}).then(()=>this.story?.data.jobs.some(j=>j.kind==='outline')||this.story?.data.proposals.some(p=>p.kind==='outline')?'pending':'done');
                let result=await Promise.race([choice,work]);
                if(result==='pending'){this.waitMessage='修订未应用，请查看任务原因或提案；可以沿用旧大纲继续';this.changed();result=await choice;}
                assert(result!=='cancel'&&epoch===this.epoch,'已取消等待大纲，本次正文未发送');
                if(result==='done')frozenStory=copy(this.story.data);
                else if(this.host.rawPending){this.waitMessage='已选择沿用旧大纲，等待酒馆主连接释放';this.changed();await this.host.waitRaw?.();assert(!this.host.rawPending,'主连接仍被占用，请等当前请求结束后重试正文');}
            }finally{this.waitResolve=null;this.waitingOutline=false;this.host.maintenanceBefore=false;this.host.foreground=true;this.changed();}
        }
        // Also serialize a user choosing not to wait for a revision with an already-running main call.
        if(this.host.rawPending){this.requestState='等待酒馆主连接释放';this.changed();try{await this.host.waitRaw?.();assert(!this.host.rawPending,'酒馆主连接尚未释放，请稍后重发正文');}finally{this.requestState='';}}
        assert(epoch===this.epoch&&!this.sendCancelled,'故事已切换或生成已停止，本次正文未发送');
        const atSend=await this.host.capture();
        const validStory=invalidateSources(frozenStory,atSend.chatKey,atSend.sources);
        const token=uid(),frozen=injection(copy(this.author.data),validStory,this.settings,atSend,token);
        this.generation=frozen.visibleIds.length?{token,epoch,storyId:this.story.data.id,chatKey:atSend.chatKey,sources:atSend.sources,baseHash:await outlineHash(validStory),visibleIds:frozen.visibleIds}:null;
        this.lastInjection=frozen;this.host.inject(frozen.text);this.changed();
    }
    continueOldOutline(){assert(this.waitResolve,'当前没有等待中的正文');this.waitResolve('skip');return '本次正文将沿用等待前的大纲';}
    async receiveControl(floor,generation=this.generation){
        if(!generation||generation.epoch!==this.epoch||generation.storyId!==this.story?.data.id||!this.settings.enabled)return;
        const context=await this.host.capture(),row=context.rows.find(r=>r.floor===Number(floor));
        if(!row||row.role!=='assistant'||context.chatKey!==generation.chatKey)return;
        const source=context.sources.find(s=>s.id===row.id),key='control:'+row.id+':'+row.hash;
        this.currentSources=context.sources;
        if(this.story.data.controls?.some(c=>c.source.id===source.id&&c.source.hash===source.hash))return;
        const now=new Map(context.sources.map(s=>[s.id,s.hash]));
        assert(generation.sources.every(s=>s.id===row.id||now.get(s.id)===s.hash),'正文生成期间来源变化，控制信息未应用');
        const control=parseControl(row.text,generation.token,new Set(generation.visibleIds));
        const sources=context.sources.filter(s=>s.floor<=row.floor);
        const receipt={id:uid(),token:control.token,chatKey:context.chatKey,source,sources:[source],prefixHash:sourcePrefixes(sources).get(source.id),chapter:control.chapter,nextIds:control.nextIds,at:Date.now()};
        if(control.chapter)assert(control.chapter.lineIds.every(id=>this.story.data.records.some(r=>r.id===id&&r.kind==='line')),'章节引用必须是故事线');
        // Prepare once before the atomic receipt + task commit; a failed preparation is retryable.
        let job=null;
        if(control.revise){const input=await this.initializationInput(context,'');job={id:uid(),kind:'outline',key,chatKey:context.chatKey,input,signal:control.revise,sources,anchor:source,feedback:[],at:Date.now(),attempts:0,state:this.settings.mode==='manual'?'held':'queued'};}
        const latest=await this.host.capture(),latestHashes=new Map(latest.sources.map(s=>[s.id,s.hash]));
        assert(latest.chatKey===context.chatKey&&sources.every(s=>latestHashes.get(s.id)===s.hash),'读取资料期间来源已变化，控制信息未应用');
        await this.edit(this.story.data.id,async d=>{
            assert(generation.epoch===this.epoch&&await outlineHash(d)===generation.baseHash,'正文期间大纲已变化，控制信息未应用；可重新规划');
            d.controls??=[];if(d.controls.some(c=>c.source.id===source.id&&c.source.hash===source.hash))return d;
            d.controls.push(receipt);if(job){assert(d.jobs.length<60,'任务队列已满，控制信息未应用');d.jobs.push(job);}return d;
        });
        this.controlStatus=job?(job.state==='held'?'收到改纲意图，手动模式下等待运行':'已收到改纲意图，等待主连接修订'):'本轮章节与选条已保存，无额外模型请求';this.changed();
    }
    taskSettings(kind){return {...copy(this.settings),connection:['questions','initialization','outline'].includes(kind)?'main':this.settings.connection};}
    async queueJob(kind,{context,pairs,key=uid(),feedback=[],note='',signal=null}={}) {
        const owner=kind==='feedback'?this.author:this.story;assert(owner,'请先选择资料存档');const epoch=this.epoch,storyId=owner.data.id;context??=kind==='feedback'?{chatKey:this.host.identity().chatKey,sources:[],pairs:[]}:await this.host.capture();
        const selected=pairs??context.pairs.slice(-this.settings.contextRounds);
        const rows=selected.flatMap(p=>p.rows);
        let input=rows.map(r=>`${r.role} ${r.name}:\n${stripControl(r.text)}`).join('\n\n');
        if(['initialization','outline'].includes(kind))input=await this.initializationInput(context,note||feedback[0]?.note||'');
        else if(kind!=='feedback'&&this.settings.memoryRead){const memory=await this.confirmedMemory();if(memory)input+='\nBB-Memory 同故事只读资料：'+JSON.stringify(memory).slice(0,10000);}
        if(['initialization','outline'].includes(kind))assert(input.length<=this.settings.maxInputChars,'大纲材料超过当前维护材料预算；输入已保留，请在设置中提高预算后重试');
        else input=input.slice(-this.settings.maxInputChars);
        const sources=['initialization','outline'].includes(kind)?context.sources:selected.flatMap(p=>p.sources),anchor=sources.at(-1)??null;
        const job={id:uid(),kind,key,chatKey:context.chatKey,input,sources,anchor,signal,feedback:copy(feedback),at:Date.now(),attempts:0,state:'queued',...(kind==='world'?{pairKeys:selected.map(p=>'world:'+p.key)}:{})};
        assert(epoch===this.epoch&&context.chatKey===this.host.identity().chatKey,'准备维护期间聊天已变化');
        await this.edit(storyId,d=>{assert(d.jobs.length<60,'维护待办已达 60 条，请先处理或导出');if(!d.processed.includes(key)&&!d.jobs.some(j=>j.key===key)&&!d.proposals.some(j=>j.key===key))d.jobs.push(job);return d;});
        return job;
    }
    drain({before=false,outlineOnly=false}={}) {
        if(this.auxiliary||this.preparing||this.resumeTask)return Promise.resolve();
        if(this.running)return this.running;
        const run=async()=>{
            while(this.ready&&this.visible()&&this.settings.enabled){
                const entry=this.jobs.find(({job})=>job.state==='queued'&&(!outlineOnly||job.kind==='outline'));if(!entry)return;const {job,target}=entry;
                if(this.taskSettings(job.kind).connection==='main' && (this.host.rawPending||this.foreground&&!before))return;
                await this.runJob(copy(job),target);
            }
        };
        this.running=run().finally(()=>{this.running=null;this.changed();});return this.running;
    }
    async runJob(job,ownerId=this.story?.data.id) {
        const owner=this.documentFor(ownerId),authorTask=owner.data.type!=='story'&&job.kind==='feedback';
        const epoch=this.epoch,storyId=ownerId,settings=this.taskSettings(job.kind),baseHash=await hash(JSON.stringify(owner.data.records));
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
                if(job.kind==='initialization')for(const c of changes)assert(OUTLINE_KINDS.includes(c.op==='put'?c.record?.kind:d.records.find(r=>r.id===c.id)?.kind),'初始化只修改大纲；写作偏好请在个性化作者中维护');
                const candidate=applyChanges(d,changes,options); // Validate protection even in review mode.
                if(job.kind==='initialization')assert(candidate.records.some(r=>r.kind==='core'&&r.status==='active')&&candidate.records.some(r=>r.kind==='line'&&r.status==='active'),'初始大纲需要故事核心和至少一条故事线，请检查提示词后重试');
                const resultCopy={baseHash,promptHash,chatKey:job.chatKey,result};this.resultCache.set(cacheKey,resultCopy);await this.writeLocal(cacheKey,resultCopy);
                const important=changes.some(c=>c.op==='remove'||c.record?.importance==='major'||d.records.find(r=>r.id===(c.id??c.record?.id))?.importance==='major') || job.kind==='feedback'||job.kind==='initialization';
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
    async reviewProposal(id,accept,target=this.story?.data.id) {
        const context=this.host.identity().chatKey?await this.host.capture():{chatKey:'',sources:[]},now=new Map(context.sources.map(s=>[s.id,s.hash]));
        await this.edit(target,async d=>{
            const p=d.proposals.find(p=>p.id===id);assert(p,'提案不存在');let next=d;
            if(accept){assert(d.type!=='story'||p.chatKey===context.chatKey,'请回到提案所属聊天审阅，或拒绝后在此聊天重新维护');assert(await hash(JSON.stringify(d.records))===p.baseHash,'资料已变化，请拒绝旧提案并重新维护');assert(d.type!=='story'||p.sources.every(s=>s.chatKey!==context.chatKey||now.get(s.id)===s.hash),'提案来源已变化');next=applyChanges(d,p.changes,{origin:p.kind,sources:p.sources,key:p.key,anchor:p.anchor,feedbackIds:p.feedback.map(f=>f.id).filter(Boolean)});for(const f of next.feedback)if(p.feedback.some(x=>x.id===f.id))f.status='processed';}
            else {next.processed.push(p.key);for(const f of next.feedback)if(p.feedback.some(x=>x.id===f.id))f.status='saved';}
            next.processed=[...new Set([...next.processed,...p.pairKeys??[]])];next.proposals=next.proposals.filter(x=>x.id!==id);return next;
        });
        if(this.waitingOutline&&![...this.story.data.jobs,...this.story.data.proposals].some(j=>j.kind==='outline'))this.waitResolve?.(accept?'done':'skip');
    }
    async manual(kind='outline',note='') {
        assert(this.settings?.enabled,'请先在设置中启用 BBPresets');
        assert(!this.auxiliary,'正在准备问题或测试连接，请稍后重试');
        assert(!this.foreground,'请等当前正文完成后再手动维护');
        await this.queueJob(kind,{note});
        await this.drain();
        return this.story?.data.jobs.some(j=>j.kind===kind&&j.state==='failed')?'维护未完成，输入已保留；请在维护页检查原因并重试':this.story?.data.jobs.some(j=>j.kind===kind)?'任务已排队，等待连接空闲':this.story?.data.proposals.some(p=>p.kind===kind)?'维护已完成，有提案待审阅':'维护已完成';
    }
    async initializationInput(context,note='') {
        assert(note.length+1000<this.settings.maxInputChars,'初始化回答超过当前维护材料预算；全文已保留，请提高设置中的预算后重试');
        const budget=Math.max(500,Math.floor((this.settings.maxInputChars-note.length-1000)*.6)),seed=await this.host.seed(Math.floor(budget*.5));
        const recent=context.rows.slice(-this.settings.contextRounds*2-1).map(r=>`${r.role} #${r.floor}: ${stripControl(r.text)}`).join('\n');
        let memory='未启用同故事记忆读取';
        if(this.settings.memoryRead)memory=JSON.stringify(await this.confirmedMemory()??'未确认对应存档，本次未读取记忆');
        const excerpt=(text,n)=>text.length<=n?text:text.slice(0,n)+'\n[该来源超出预算，本次仅提供节选]';
        return JSON.stringify({answers:note,world:excerpt(seed,Math.floor(budget*.5)),recent:excerpt(recent,Math.floor(budget*.3)),memory:excerpt(memory,Math.floor(budget*.2))});
    }
    async auxiliaryRequest(prompt,settings=this.settings,options={},validate=result=>result) {
        assert(!this.running&&!this.auxiliary,'已有维护或连接请求，请完成后重试');
        if(settings.connection==='main')assert(!this.foreground&&!this.host.rawPending,'酒馆主连接正在生成，请完成后重试');
        const controller=new AbortController(),epoch=this.epoch;
        this.auxController=controller;this.auxiliary=true;this.changed();
        try{const raw=await this.request(prompt,copy(settings),controller.signal,options);assert(!controller.signal.aborted&&epoch===this.epoch,'聊天或设置已变化，请重新操作');const result=validate(raw);this.stats.success++;return result;}
        catch(e){this.stats.failed++;throw e;}
        finally{this.auxiliary=false;this.requestState='';if(this.auxController===controller)this.auxController=null;this.changed();}
    }
    async request(prompt,settings,signal,options={}) {
        return retryRequest(async child=>{
            // A timed-out generateRaw can still own ST's main connection. Never overlap it.
            if(settings.connection==='main')assert(!this.host.rawPending&&!this.foreground,'酒馆主连接仍在处理请求；任务已保留，完成后可重试');
            this.stats.calls++;this.changed();return this.host.request(prompt,settings,child,options);
        },{signal,timeoutSeconds:settings.timeoutSeconds,onState:state=>{this.requestState=state;this.changed();},...(this.retryOptions??{})});
    }
    async prepareInitialization(mode='replace') {
        assert(this.story&&this.ready,'请先选择当前故事');
        assert(this.settings?.enabled,'请先启用 BBPresets');
        assert(!this.foreground,'请等当前正文完成后再准备初始化问题');
        assert(!this.preparing,'正在生成问题，请稍后');this.preparing=true;
        const epoch=this.epoch,storyId=this.story.data.id;
        try{
            const context=await this.host.capture();
            this.ensureDraft();this.updateInitialization(d=>{d.request={mode,state:'pending'};});await this.flushDraft();
            const input=await this.initializationInput(context,draftAnswers(this.initialization));
            assert(epoch===this.epoch,'故事已切换，请重新生成问题');
            const questions=await this.auxiliaryRequest(promptText(this.settings,'questions',{mode:promptText(this.settings,mode==='append'?'appendQuestions':'replaceQuestions'),material:input}),this.taskSettings('questions'),{},parseQuestions);
            const current=await this.host.capture(),hashes=new Map(current.sources.map(s=>[s.id,s.hash]));
            assert(epoch===this.epoch&&current.chatKey===context.chatKey&&context.sources.every(s=>hashes.get(s.id)===s.hash),'提问期间聊天内容已变化，已有回答仍保留，请重新生成问题');
            this.updateInitialization(d=>questionSet(d,questions,mode));await this.flushDraft();this.changed();return questions;
        }catch(error){if(epoch===this.epoch&&storyId===this.story?.data.id){this.updateInitialization(d=>{d.request={mode,state:'failed'};});void this.flushDraft().catch(()=>{});}throw error;}
        finally{this.preparing=false;this.changed();}
    }
    async completeInitialization(answer) {
        assert(!this.buildingInitialization,'初始化正在建立，请稍后');
        this.buildingInitialization=true;
        try{
        const draft=this.initialization;
        assert(draft&&draft.chatKey===this.host.identity().chatKey,'请先为当前故事准备初始化资料');
        if(answer!==undefined)this.updateInitialization(d=>{d.notes=answer;});
        await this.flushDraft();
        assert(![...this.story.data.jobs,...this.story.data.proposals].some(j=>j.kind==='initialization'),'已有初始化任务或提案，请先处理；回答仍保留');
        await this.manual('initialization',draftAnswers(this.initialization));
        }finally{this.buildingInitialization=false;this.changed();}
    }
    draftKey(){return this.story?`draft:${this.story.data.id}:${this.host.identity().chatKey}`:null;}
    draftEntry(){return this.drafts.get(this.draftKey());}
    get initialization(){return this.draftEntry()?.value??null;}
    async readLocal(key){return this.host.local?await this.host.local.getItem(this.host.prefix+key):null;}
    writeLocal(key,value){
        const snapshot=copy(value),write=this.localWrites.then(()=>this.host.local?.setItem(this.host.prefix+key,snapshot));
        this.localWrites=write.catch(()=>{});return write;
    }
    async loadDraft(){
        const key=this.draftKey();if(!key)return;
        const remote=this.story.data.initializationDrafts?.find(d=>d.chatKey===this.host.identity().chatKey)??null;
        const cached=this.drafts.get(key)??await this.readLocal(key);
        if(key!==this.draftKey())return;
        if(cached?.dirty){validateDraft(cached.value);this.drafts.set(key,cached);}
        else if(remote){if(!same(cached?.value,remote))this.draftLoadVersion=(this.draftLoadVersion??0)+1;this.drafts.set(key,{value:copy(remote),base:copy(remote),dirty:false});}
        else this.drafts.delete(key);
    }
    ensureDraft(){
        assert(this.story&&this.ready,'请先选择当前故事');
        if(!this.draftEntry()){const remote=this.story.data.initializationDrafts?.find(d=>d.chatKey===this.host.identity().chatKey)??null;this.drafts.set(this.draftKey(),{value:copy(remote)??newDraft(this.host.identity().chatKey),base:copy(remote),dirty:false});}
        return this.initialization;
    }
    updateInitialization(change){
        this.ensureDraft();const key=this.draftKey(),entry=this.draftEntry(),draft=copy(entry.value);
        entry.value=change(draft)??draft;entry.value.updatedAt=Math.max(Date.now(),entry.value.updatedAt+1);entry.dirty=true;
        void this.writeLocal(key,{value:entry.value,base:entry.base,dirty:entry.dirty}).catch(()=>{this.draftError='本设备草稿写入失败，请保持页面打开并保存到服务器';this.changed();});
        clearTimeout(this.draftTimer);this.draftTimer=setTimeout(()=>this.flushDraft().catch(e=>{this.draftError=e.message;this.changed();}),650);this.draftTimer.unref?.();
        this.draftError='';this.changed();
    }
    async flushDraft(){
        clearTimeout(this.draftTimer);
        const key=this.draftKey(),entry=this.draftEntry();if(!entry?.dirty)return;
        if(entry.saving){await entry.saving;if(entry.dirty&&key===this.draftKey())return this.flushDraft();return;}
        const value=copy(entry.value),base=copy(entry.base),storyId=this.story.data.id;
        const work=this.edit(storyId,d=>{
            d.initializationDrafts??=[];const index=d.initializationDrafts.findIndex(x=>x.chatKey===value.chatKey),current=d.initializationDrafts[index]??null;
            assert(same(current,base)||same(current,value),'服务器已有不同的初始化草稿；本设备输入仍保留，请先检查服务器版本或导出草稿，避免覆盖');
            if(index<0)d.initializationDrafts.push(value);else d.initializationDrafts[index]=value;return d;
        });
        // Never put a Promise in persisted draft data.
        entry.saving=work;
        try{await work;entry.base=value;entry.dirty=!same(value,entry.value);this.draftError='';}
        finally{delete entry.saving;await this.writeLocal(key,{value:entry.value,base:entry.base,dirty:entry.dirty});this.changed();}
        if(entry.dirty&&key===this.draftKey())return this.flushDraft();
    }
    async saveCurrent(){
        assert(this.ready&&this.story,'请先选择当前存档');
        const epoch=this.epoch,id=this.story.data.id;
        await this.flushDraft();await this.edits;
        assert(epoch===this.epoch&&id===this.story?.data.id,'故事已切换，请在当前故事重新保存');
        await this.edit(id,d=>{d.manualSavedAt=Math.max(Date.now(),(d.manualSavedAt??0)+1);return d;});
        return '当前存档已保存到酒馆服务器；可在“恢复 / 导出”查看版本';
    }
    get progress(){
        const d=this.story?.data;if(!d)return {floor:null,reflectionAt:null};
        const chatKey=this.host.identity().chatKey,now=new Map((this.currentSources??[]).map(s=>[s.id,s]));
        const events=[...d.history.map(h=>({...h,kind:h.origin})),...d.proposals.map(p=>({...p,at:p.completedAt??p.at,review:true}))].reverse().sort((a,b)=>b.at-a.at);
        const world=events.find(h=>h.kind==='world'&&h.sources?.length&&h.sources.every(s=>s.chatKey===chatKey&&now.get(s.id)?.hash===s.hash));
        const reflection=events.find(h=>h.kind==='reflection');
        return {floor:world?Math.max(...world.sources.map(s=>now.get(s.id).floor)):null,worldReview:world?.review,reflectionAt:reflection?.at??null,reflectionReview:reflection?.review};
    }
    async testConnection(settings=this.settings,key=this.host.key) {
        validateSettings(settings);
        const start=Date.now();await this.auxiliaryRequest(promptText(settings,'connectionTest'),settings,{key},result=>{
            const text=typeof result==='string'?result:result?.text;
            assert(typeof text==='string'&&text.trim(),'API 请求成功但没有返回文本，请检查模型名称及接口协议');return result;
        });
        return `连接成功 · ${settings.model||'酒馆当前模型'} · ${((Date.now()-start)/1000).toFixed(1)} 秒 · 已收到文本响应`;
    }
    async saveRecord(target,r,expected=undefined) {
        const context=this.host.identity().chatKey?await this.host.capture():{sources:[]};
        assert(this.documentFor(target)?.data.type==='story'||AUTHOR_KINDS.includes(r.kind),'个性化作者只能保存写作建议与经验');
        await this.edit(target,d=>{if(expected!==undefined)assert(same(d.records.find(x=>x.id===r.id)??null,expected),'条目已变化，输入仍保留；请重新打开最新条目后合并');return applyChanges(d,[{op:'put',record:r}],{actor:'user',anchor:context.sources.at(-1)??null});});
    }
    async addFeedback({quote,note='',polarity='neutral',source=null,status='saved'}) {
        assert(this.author,'请先选择存档');assert(quote.length>0&&quote.length<=50000,'请选择不超过 5 万字符的文字');
        const id=uid();await this.edit(this.author.data.id,d=>{d.feedback.push({id,quote,note,polarity,source,status,at:Date.now()});return d;});if(status==='queued')void this.maybeSummarizeFeedback().catch(e=>this.report(e));return id;
    }
    async maybeSummarizeFeedback(){
        if(this.feedbackChecking||!this.ready||!this.author||!this.settings.enabled||this.settings.mode==='manual')return;
        const reserved=new Set([...this.author.data.jobs,...this.author.data.proposals].flatMap(j=>j.feedback.map(f=>f.id)));
        const items=this.author.data.feedback.filter(f=>f.status==='queued'&&!reserved.has(f.id));
        if(items.length<(this.settings.feedbackThreshold??5))return;
        this.feedbackChecking=true;try{await this.sendFeedback(items.map(f=>f.id));}finally{this.feedbackChecking=false;}
    }
    async sendFeedback(ids) {
        const ownerId=this.author.data.id,epoch=this.epoch;
        const pending=(this.feedbackSubmissions??Promise.resolve()).then(()=>{assert(epoch===this.epoch&&this.author.data.id===ownerId,'作者或聊天已切换，点评未提交到新作者');return this.submitFeedback(ids);});
        this.feedbackSubmissions=pending.catch(()=>{});return pending;
    }
    async submitFeedback(ids) {
        const ownerId=this.author.data.id,epoch=this.epoch;
        const reserved=new Set([...this.author.data.jobs,...this.author.data.proposals].flatMap(j=>j.feedback.map(f=>f.id)));
        const items=this.author.data.feedback.filter(f=>ids.includes(f.id)&&!reserved.has(f.id)&&['saved','queued'].includes(f.status));assert(items.length,'没有待发送点评，或选中点评已在维护/审阅队列中');
        const key='feedback:'+uid();
        await this.queueJob('feedback',{key,feedback:items});
        assert(epoch===this.epoch&&this.author.data.id===ownerId,'作者已切换，点评任务保留在原作者');
        await this.edit(ownerId,d=>{for(const f of d.feedback)if(items.some(x=>x.id===f.id))f.status='queued';return d;});
        await this.drain();
    }
    async withdrawFeedback(id){this.controller?.abort();await this.edit(this.author.data.id,d=>{const f=d.feedback.find(f=>f.id===id);assert(f,'点评不存在');f.status='withdrawn';d.jobs=d.jobs.filter(j=>!j.feedback.some(x=>x.id===id));d.proposals=d.proposals.filter(j=>!j.feedback.some(x=>x.id===id));const affected=d.history.filter(h=>h.feedbackIds?.includes(id)).flatMap(h=>h.changes.map(c=>c.id));d.excluded=[...new Set([...d.excluded,...affected])];d.conflicts.push({id:uid(),reason:'feedback-withdrawn',feedbackId:id,at:Date.now()});return d;});}
    async saveSettings(settings,expected){validateSettings(settings);await this.edit('profile',d=>{if(expected)assert(same(d.settings,expected),'已保存的设置发生了变化，当前输入仍保留；请载入已保存设置后重新调整');d.settings=settings;return d;});this.controller?.abort();this.auxController?.abort();this.generation=null;this.host.controlFilter?.(settings.enabled);if(!settings.enabled){this.waitResolve?.('cancel');this.host.inject('');}}
    async retryJobs(id=null,target=null){
        assert(!this.running&&!this.auxiliary,'当前请求尚未结束，请稍后重试');
        if(!id&&!this.jobs.length&&this.initialization?.request?.state==='failed')return this.prepareInitialization(this.initialization.request.mode);
        const selected=this.jobs.filter(x=>(!id||x.job.id===id)&&(!target||x.target===target));assert(selected.length,'没有可重试的任务；已生成的提案请查看并应用');
        for(const scope of new Set(selected.map(x=>x.target)))await this.edit(scope,d=>{for(const j of d.jobs)if(selected.some(x=>x.target===scope&&x.job.id===j.id)){j.state='queued';delete j.error;delete j.retryable;}return d;});
        await this.drain();if(this.waitingOutline&&![...this.jobs,...this.proposals].some(x=>x.job.kind==='outline'))this.waitResolve?.('done');
        return this.jobs.some(x=>x.job.state==='failed')?'仍有失败任务，请查看任务原因和原始响应':this.jobs.length?'任务已排队，正在等待连接空闲':this.proposals.length?'结果已生成，等待应用提案':'任务已完成并应用';
    }
    exportPromptSet(){return exportPrompts(this.settings);}
    async importPromptSet(data){await this.saveSettings({...this.settings,prompts:importPrompts(data)},copy(this.settings));return '提示词已导入并保存到服务器';}
    async diagnostic(id,target=this.story?.data.id){return await this.readLocal(`diagnostic:${target}:${id}`);}
    cancelRequests(){this.controller?.abort();this.auxController?.abort();return '已停止当前请求；问答与未完成任务保留';}
    async bindMemory(){const m=await this.host.memorySnapshot();assert(m?.available,m?.reason??'未检测到可验证的 BB-Memory 当前存档');await this.edit(this.story.data.id,d=>{d.memoryBinding={signature:m.signature,character:m.character,slotName:m.slotName,stamp:m.stamp};return d;});}
    async confirmedMemory(){const m=await this.host.memorySnapshot();return m?.available&&m.signature===this.story?.data.memoryBinding?.signature?m.data:null;}
    async followMemory(){
        if(!this.settings.memoryFollow)return;
        const m=await this.host.memorySnapshot();if(!m?.available){this.host.inject('');throw Error('无法确认 BB-Memory 当前槽，联动已暂停；关闭跟随后可独立使用 BBPresets');}
        if(this.story?.data.memoryBinding?.signature===m.signature)return;
        let target=null;
        for(const [id,entry] of Object.entries(this.repo.index.documents)){if(entry.type!=='story')continue;const story=await this.repo.load(id);if(story.data.memoryBinding?.signature===m.signature){assert(!target,'同一个 BB-Memory 槽映射了多个故事，请关闭联动并重新确认映射');target=id;}}
        if(target)await this.selectStory(target);else {this.host.inject('');this.error='当前 BB-Memory 槽没有已确认映射；未自动猜测或复制，请在工作台选择故事并确认对应';this.changed();throw Error(this.error);}
    }
    async restore(id,entry){const historical=await this.repo.loadVersion(id,entry);await this.edit(id,d=>{const next=restoreDocument(d,historical.data);if(d.type==='profile')next.activeAuthorId=d.activeAuthorId??'profile';return next;});}
    async exportAll(){const documents=[];for(const id of Object.keys(this.repo.index.documents))documents.push((await this.repo.load(id)).data);return {format:'bbpresets-export',schema:1,at:Date.now(),documents};}
    async exportScope(id){const document=(await this.repo.load(id))?.data;assert(document,'资料不存在');const data=copy(document);if(data.type==='profile'){data.type='author';delete data.settings;delete data.activeAuthorId;data.records=data.records.filter(r=>AUTHOR_KINDS.includes(r.kind));}return {format:'bbpresets-export',schema:1,at:Date.now(),documents:[data]};}
    async importArchive(archive){
        assert(archive?.format==='bbpresets-export'&&archive.schema===1&&Array.isArray(archive.documents)&&archive.documents.length<200,'不是支持的导入文件');
        // Import independent copies, preserving story/author ownership. Never change the active author.
        archive.documents.forEach(validateDocument);
        const epoch=this.epoch;
        await this.edits;
        for(const raw of archive.documents){const d=copy(raw);d.id=uid();d.title=('导入 · '+d.title).slice(0,300);d.type=raw.type==='story'?'story':'author';delete d.settings;delete d.activeAuthorId;if(d.type==='author')d.records=d.records.filter(r=>AUTHOR_KINDS.includes(r.kind));d.bindings=[];d.memoryBinding=null;d.jobs=[];d.proposals=[];d.parent=null;await this.repo.save(d,0,()=>this.epoch===epoch);}
        this.changed();
    }
    destroy(){clearInterval(this.queueTimer);this.suspend();this.host.destroy();}
}
