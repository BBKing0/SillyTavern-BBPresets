import {assert,copy,same,uid,hash,newDocument,applyChanges,invalidateSources,forkAt,restoreDocument,validateDocument,validateSettings,record} from '../core/model.js';
import {Repository} from '../core/repository.js';
import {injection,maintenancePrompt,maintenanceMaterial,parseChanges,INITIALIZATION_TEMPLATE,parseQuestions} from './prompts.js';

export class BBPresetsApp {
    constructor(host,{notify=()=>{},visible=()=>!globalThis.document?.hidden}={}) {
        this.host=host;this.notify=notify;this.visible=visible;this.epoch=0;this.story=null;this.profile=null;this.listeners=new Set();this.edits=Promise.resolve();this.running=null;this.controller=null;this.temporary='';this.error='';this.status='loading';this.lastInjection={text:'',omitted:0};this.stats={calls:0,success:0,failed:0,usage:null};this.ready=false;
    }
    changed(){for(const fn of this.listeners)fn();}
    report(error){this.error=error.message??String(error);this.notify(this.error,'error');this.changed();}
    get settings(){return this.profile?.data.settings;}
    async init() {
        await this.host.prepare?.();
        this.recovery=await this.host.createRecovery();
        this.repo=new Repository(this.host.transport(),{recovery:this.recovery,onStatus:(status,error)=>{this.status=status;if(error)this.error=error.message;else if(status==='saved')this.error='';this.changed();}});
        this.host.on('CHAT_CHANGED',()=>{this.host.foreground=false;this.suspend();this.refresh().catch(e=>this.report(e));});
        this.host.on('GENERATION_STARTED',(type,_options,dryRun)=>{if(!dryRun&&type!=='quiet')this.host.foreground=true;});
        // GENERATION_ENDED receives chat.length, not the generation type.
        const ended=()=>{this.host.foreground=false;setTimeout(()=>this.resumeQueue(),0);};
        this.host.on('GENERATION_ENDED',ended);
        this.host.on('GENERATION_STOPPED',ended);
        for(const event of ['MESSAGE_SWIPED','MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_DELETED'])this.host.on(event,()=>{this.reconcile().catch(e=>this.report(e));});
        for(const event of ['MAIN_API_CHANGED','OAI_PRESET_CHANGED_AFTER','CHATCOMPLETION_MODEL_CHANGED','CONNECTION_PROFILE_LOADED'])this.host.on(event,()=>{this.controller?.abort();this.auxController?.abort();});
        await this.refresh();
        this.ready=true;this.changed();
        // An aborted/offline request may never emit ENDED. Consult the host's live flag.
        this.queueTimer=setInterval(()=>this.resumeQueue(),1000);this.queueTimer.unref?.();
    }
    get foreground(){return this.host.isForeground?.()??this.host.foreground;}
    async resumeQueue(){if(!this.ready||!this.visible()||this.foreground)return;try{await this.host.flushSourceIds?.();if(this.story?.data.jobs.some(j=>j.state==='queued'))await this.drain();}catch(e){this.report(e);}}
    suspend(){this.epoch++;this.ready=false;this.controller?.abort();this.auxController?.abort();this.initialization=null;this.host.inject('');this.lastInjection={text:'',omitted:0};}
    async refresh() {
        this.suspend();const epoch=this.epoch;await this.edits;await this.repo.refresh();
        let profile=await this.repo.load('profile');
        if(!profile)profile=await this.repo.save(newDocument('profile','用户写作指南','profile'),0,()=>this.epoch===epoch);
        if(epoch!==this.epoch)return;
        this.profile=profile;this.story=null;
        const chatKey=this.host.identity().chatKey, binding=this.host.ctx().chatMetadata?.bbpresetsBinding;
        this.selectedKey=chatKey;
        this.branchCandidate=binding&&binding.chatKey!==chatKey?copy(binding):null;
        if(binding?.chatKey===chatKey && this.repo.index.documents[binding.storyId])this.story=await this.repo.load(binding.storyId);
        if(epoch!==this.epoch)return;
        this.ready=true;this.error='';this.status='saved';
        if(this.story)await this.reconcile();
        this.changed();
    }
    edit(target,transform,{guard=()=>true}={}) {
        const epoch=this.epoch;
        const work=this.edits.then(async()=>{
            assert(epoch===this.epoch&&guard(),'操作期间故事已变化');
            const wrapper=target==='profile'?this.profile:this.story;
            assert(wrapper&&wrapper.data.id===target,'资料归属不符');
            const next=await transform(copy(wrapper.data));
            if(same(next,wrapper.data))return wrapper;
            const saved=await this.repo.save(next,wrapper.revision,()=>epoch===this.epoch&&guard());
            if(target==='profile')this.profile=saved;else this.story=saved;
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
    async selectStory(id) {
        this.suspend();const epoch=this.epoch,identity=this.host.identity();await this.edits;await this.repo.refresh();
        const selected=await this.repo.load(id);assert(selected?.data.type==='story','请选择故事存档');
        assert(epoch===this.epoch&&identity.chatKey===this.host.identity().chatKey,'选择期间聊天已变化');assert(identity.chatKey,'请先打开聊天');
        this.story=selected;
        this.selectedKey=identity.chatKey;
        this.host.ctx().chatMetadata.bbpresetsBinding={storyId:id,chatKey:identity.chatKey};
        await this.host.ctx().saveMetadata();
        assert(epoch===this.epoch&&this.host.identity().chatKey===identity.chatKey,'保存绑定期间聊天变化');
        this.ready=true;this.changed();
        await this.reconcile();
    }
    async reconcile() {
        if(!this.story||!this.ready||!this.visible())return;
        const context=await this.host.capture(),storyId=this.story.data.id;
        const hashes=new Map(context.sources.map(s=>[s.id,s.hash]));
        if(this.activeJob?.sources.some(s=>s.chatKey===context.chatKey&&hashes.get(s.id)!==s.hash))this.controller?.abort();
        await this.edit(storyId,d=>invalidateSources(d,context.chatKey,context.sources));
    }
    async beforeGenerate(type='normal') {
        if(['quiet','impersonate'].includes(type))return;
        this.host.foreground=true;
        if(!this.ready||!this.settings?.enabled||!this.story||!this.visible()||this.selectedKey!==this.host.identity().chatKey){this.host.inject('');return;}
        // Freeze before launching this send's maintenance. Never await a model in background mode.
        await this.followMemory();
        const epoch=this.epoch;
        if(!this.story||!this.ready)return;
        const atSend=await this.host.capture();
        const validStory=invalidateSources(copy(this.story.data),atSend.chatKey,atSend.sources);
        const temporary=this.temporary;
        const frozen=injection(copy(this.profile.data),validStory,this.settings,temporary);
        this.temporary='';this.lastInjection=frozen;this.host.inject(frozen.text);this.changed();
        const prepare=async()=>{
            if(epoch!==this.epoch)return;
            await this.reconcile();
            if(['swipe','regenerate','continue'].includes(type)||this.settings.mode==='manual')return;
            const context=atSend;
            if(epoch!==this.epoch)return;
            // Only a subsequent USER turn releases a completed exchange for extraction.
            const lastUser=context.rows.findLast(r=>r.role==='user');
            const eligible=context.pairs.filter(p=>p.rows.at(-1).floor<lastUser?.floor);
            const done=new Set([...this.story.data.processed,...this.story.data.jobs.flatMap(j=>j.pairKeys??[j.key]),...this.story.data.proposals.flatMap(j=>j.pairKeys??[j.key])]);
            const pending=eligible.filter(p=>!done.has('world:'+p.key));
            if(pending.length>=this.settings.frequency) {
                await this.queueJob('world',{context,pairs:pending,key:'world:'+pending.at(-1).key});
            }
            if(this.settings.reflectionEnabled && eligible.length && eligible.length%this.settings.reflectionFrequency===0) {
                const key='reflection:'+eligible.at(-1).key;
                if(!done.has(key))await this.queueJob('reflection',{context,pairs:eligible.slice(-this.settings.contextRounds),key});
            }
        };
        if(this.settings.timing==='before'){
            await prepare();if(epoch!==this.epoch)return;
            // At the extension interceptor the normal network request has not started yet.
            this.host.foreground=false;
            this.host.maintenanceBefore=true;
            try{await this.drain({before:true});}catch(e){this.report(e);}finally{this.host.maintenanceBefore=false;this.host.foreground=true;}
            if(epoch===this.epoch){this.lastInjection=injection(this.profile.data,this.story.data,this.settings,temporary);this.host.inject(this.lastInjection.text);}
        } else prepare().then(()=>this.drain()).catch(e=>this.report(e));
    }
    async queueJob(kind,{context,pairs,key=uid(),feedback=[]}={}) {
        assert(this.story,'请先选择 BBPresets 存档');const epoch=this.epoch,storyId=this.story.data.id;context??=await this.host.capture();
        const selected=pairs??context.pairs.slice(-this.settings.contextRounds);
        const rows=selected.flatMap(p=>p.rows);
        let input=rows.map(r=>`${r.role} ${r.name}:\n${r.text}`).join('\n\n');
        if(kind==='initialization')input=await this.initializationInput(context,feedback[0]?.note??'');
        else if(this.settings.memoryRead){const memory=await this.confirmedMemory();if(memory)input+='\nBB-Memory 同故事只读资料：'+JSON.stringify(memory).slice(0,10000);}
        input=kind==='initialization'?input.slice(0,this.settings.maxInputChars):input.slice(-this.settings.maxInputChars);
        const sources=kind==='initialization'?context.sources:selected.flatMap(p=>p.sources),anchor=sources.at(-1)??null;
        const job={id:uid(),kind,key,chatKey:context.chatKey,input,sources,anchor,feedback:copy(feedback),at:Date.now(),attempts:0,state:'queued',...(kind==='world'?{pairKeys:selected.map(p=>'world:'+p.key)}:{})};
        assert(epoch===this.epoch&&context.chatKey===this.host.identity().chatKey,'准备维护期间聊天已变化');
        await this.edit(storyId,d=>{assert(d.jobs.length<60,'维护待办已达 60 条，请先处理或导出');if(!d.processed.includes(key)&&!d.jobs.some(j=>j.key===key)&&!d.proposals.some(j=>j.key===key))d.jobs.push(job);return d;});
        return job;
    }
    drain({before=false}={}) {
        if(this.auxiliary)return Promise.resolve();
        if(this.running)return this.running;
        const run=async()=>{
            while(this.story&&this.ready&&this.visible()&&this.settings.enabled){
                if(this.settings.connection==='main' && (this.host.rawPending||this.foreground&&!before))return;
                const job=this.story.data.jobs.find(j=>j.state==='queued');if(!job)return;
                await this.runJob(copy(job));
            }
        };
        this.running=run().finally(()=>{this.running=null;this.changed();});return this.running;
    }
    async runJob(job) {
        const epoch=this.epoch,storyId=this.story.data.id,settings=copy(this.settings),baseHash=await hash(JSON.stringify(this.story.data.records));
        this.controller=new AbortController();const controller=this.controller,timer=setTimeout(()=>controller.abort(),settings.timeoutSeconds*1000);
        this.activeJob=job;
        try{
            const material=maintenanceMaterial(job,this.story.data,this.profile.data),prompt=maintenancePrompt(job,this.story.data,this.profile.data,material);
            this.stats.materialOmitted=material.omitted;
            await this.edit(storyId,d=>{const j=d.jobs.find(j=>j.id===job.id);assert(j,'任务已失效');j.attempts++;return d;});
            this.changed();
            const beforeContext=await this.host.capture(),hashes=new Map(beforeContext.sources.map(s=>[s.id,s.hash]));
            assert(beforeContext.chatKey===job.chatKey&&job.sources.every(s=>s.chatKey!==job.chatKey||hashes.get(s.id)===s.hash),'任务来源已变化，请重新维护');
            assert(epoch===this.epoch&&!controller.signal.aborted,'任务已取消');
            this.stats.calls++;this.changed();
            const result=await this.host.request(prompt,settings,controller.signal);
            assert(!controller.signal.aborted&&epoch===this.epoch&&this.visible(),'维护结果已过期');
            const context=await this.host.capture();
            assert(context.chatKey===job.chatKey,'任务所属聊天已切换');
            const current=new Map(context.sources.map(s=>[s.id,s.hash]));
            assert(job.sources.every(s=>s.chatKey!==context.chatKey||current.get(s.id)===s.hash),'来源已被编辑或删除，结果不应用');
            const changes=parseChanges(result);
            const visibleIds=new Set(material.current.map(r=>r.id));
            for(const c of changes){const id=c.id??c.record?.id;assert(!this.story.data.records.some(r=>r.id===id)||visibleIds.has(id),'模型试图修改本次预算未提供的条目，结果未应用');}
            await this.edit(storyId,async d=>{
                assert(await hash(JSON.stringify(d.records))===baseHash,'资料已被修改，请重试维护以合并最新资料');
                const options={origin:job.kind,sources:job.sources,key:job.key,anchor:job.anchor,feedbackIds:job.feedback.map(f=>f.id).filter(Boolean)};
                const candidate=applyChanges(d,changes,options); // Validate protection even in review mode.
                const important=changes.some(c=>c.op==='remove'||c.record?.importance==='major'||d.records.find(r=>r.id===(c.id??c.record?.id))?.importance==='major') || job.kind==='feedback'||job.kind==='initialization';
                let next;
                if(changes.length && settings.mode!=='auto' && (settings.mode==='manual'||important)) {
                    next=d;next.proposals.push({...job,changes,baseHash,state:'review'});
                } else next=candidate;
                next.jobs=next.jobs.filter(j=>j.id!==job.id);
                if(!next.proposals.some(p=>p.id===job.id)){next.processed=[...new Set([...next.processed,...job.pairKeys??[]])];for(const f of next.feedback)if(job.feedback.some(x=>x.id===f.id))f.status='processed';}
                return next;
            },{guard:()=>epoch===this.epoch&&this.visible()&&!controller.signal.aborted&&this.host.identity().chatKey===job.chatKey});
            this.stats.success++;this.stats.usage=result?.usage??null;
        }catch(error){
            this.stats.failed++;
            if(epoch===this.epoch&&this.story?.data.id===storyId){
                await this.edit(storyId,d=>{const j=d.jobs.find(j=>j.id===job.id);if(j){j.state='failed';j.error=String(error.message).slice(0,300);}return d;}).catch(()=>{});
                this.report(error);
            }
        }finally{clearTimeout(timer);if(this.controller===controller){this.controller=null;this.activeJob=null;}this.changed();}
    }
    async reviewProposal(id,accept) {
        const context=await this.host.capture(),now=new Map(context.sources.map(s=>[s.id,s.hash]));
        await this.edit(this.story.data.id,async d=>{
            const p=d.proposals.find(p=>p.id===id);assert(p,'提案不存在');let next=d;
            if(accept){assert(p.chatKey===context.chatKey,'请回到提案所属聊天审阅，或拒绝后在此聊天重新维护');assert(await hash(JSON.stringify(d.records))===p.baseHash,'资料已变化，请拒绝旧提案并重新维护');assert(p.sources.every(s=>s.chatKey!==context.chatKey||now.get(s.id)===s.hash),'提案来源已变化');next=applyChanges(d,p.changes,{origin:p.kind,sources:p.sources,key:p.key,anchor:p.anchor,feedbackIds:p.feedback.map(f=>f.id).filter(Boolean)});for(const f of next.feedback)if(p.feedback.some(x=>x.id===f.id))f.status='processed';}
            else {next.processed.push(p.key);for(const f of next.feedback)if(p.feedback.some(x=>x.id===f.id))f.status='saved';}
            next.processed=[...new Set([...next.processed,...p.pairKeys??[]])];next.proposals=next.proposals.filter(x=>x.id!==id);return next;
        });
    }
    async manual(kind='world',note='') {
        assert(this.settings?.enabled,'请先在设置中启用 BBPresets');
        assert(!this.auxiliary,'正在准备问题或测试连接，请稍后重试');
        assert(!this.foreground,'请等当前正文完成后再手动维护');
        if(kind==='initialization')await this.queueJob(kind,{feedback:[{note}]});else await this.queueJob(kind);
        await this.drain();
    }
    async initializationInput(context,note='') {
        const budget=Math.floor(this.settings.maxInputChars*.55),seed=await this.host.seed(Math.floor(budget*.5));
        const recent=context.rows.slice(-this.settings.contextRounds*2-1).map(r=>`${r.role} #${r.floor}: ${r.text}`).join('\n');
        let memory='未启用同故事记忆读取';
        if(this.settings.memoryRead)memory=JSON.stringify(await this.confirmedMemory()??'未确认对应存档，本次未读取记忆');
        return `用户回答（示例不代表用户偏好）：${note}\n人设与世界书：${seed.slice(0,Math.floor(budget*.5))}\n近期对话：${recent.slice(-Math.floor(budget*.3))}\n同故事只读记忆：${memory.slice(0,Math.floor(budget*.2))}`;
    }
    async auxiliaryRequest(prompt,settings=this.settings,options={},validate=result=>result) {
        assert(!this.running&&!this.auxiliary,'已有维护或连接请求，请完成后重试');
        if(settings.connection==='main')assert(!this.foreground&&!this.host.rawPending,'酒馆主连接正在生成，请完成后重试');
        const controller=new AbortController(),epoch=this.epoch;
        this.auxController=controller;this.auxiliary=true;this.stats.calls++;this.changed();
        const timer=setTimeout(()=>controller.abort(),settings.timeoutSeconds*1000);
        try{const raw=await this.host.request(prompt,copy(settings),controller.signal,options);assert(!controller.signal.aborted&&epoch===this.epoch,'聊天或设置已变化，请重新操作');const result=validate(raw);this.stats.success++;return result;}
        catch(e){this.stats.failed++;throw e;}
        finally{clearTimeout(timer);this.auxiliary=false;if(this.auxController===controller)this.auxController=null;this.changed();}
    }
    async prepareInitialization() {
        assert(this.story&&this.ready,'请先选择当前故事');
        assert(!this.foreground,'请等当前正文完成后再准备初始化问题');
        const epoch=this.epoch,storyId=this.story.data.id,context=await this.host.capture();
        const input=await this.initializationInput(context);
        assert(epoch===this.epoch,'故事已切换，请重新生成问题');
        const questions=await this.auxiliaryRequest(INITIALIZATION_TEMPLATE+'\n只读资料：\n'+input,this.settings,{},parseQuestions);
        const current=await this.host.capture(),hashes=new Map(current.sources.map(s=>[s.id,s.hash]));
        assert(epoch===this.epoch&&current.chatKey===context.chatKey&&context.sources.every(s=>hashes.get(s.id)===s.hash),'提问期间聊天内容已变化，请重新生成问题');
        this.initialization={storyId,chatKey:context.chatKey,questions};this.changed();return questions;
    }
    async completeInitialization(answer='') {
        assert([...answer].length<=200,'初始化回答请控制在 200 字以内');
        const draft=this.initialization;
        assert(draft&&draft.storyId===this.story?.data.id&&draft.chatKey===this.host.identity().chatKey,'请先为当前故事生成简短问题');
        await this.manual('initialization',draft.questions.map((q,i)=>`${i+1}. ${q.question}`).join('\n')+'\n用户回答：'+answer);
    }
    async testConnection(settings=this.settings,key=this.host.key) {
        validateSettings(settings);
        const start=Date.now();await this.auxiliaryRequest('连接测试。不要读取或总结故事，只返回 {"ok":true}。',settings,{key},result=>{
            const text=typeof result==='string'?result:result?.text;
            assert(typeof text==='string'&&text.trim(),'API 请求成功但没有返回文本，请检查模型名称及接口协议');return result;
        });
        return `连接成功 · ${settings.model||'酒馆当前模型'} · ${((Date.now()-start)/1000).toFixed(1)} 秒 · 已收到文本响应`;
    }
    async saveRecord(target,r,expected=undefined) {
        const context=await this.host.capture();
        await this.edit(target,d=>{if(expected!==undefined)assert(same(d.records.find(x=>x.id===r.id)??null,expected),'条目已变化，输入仍保留；请重新打开最新条目后合并');return applyChanges(d,[{op:'put',record:r}],{actor:'user',anchor:context.sources.at(-1)??null});});
    }
    async addFeedback({quote,note='',polarity='neutral',source=null,status='saved'}) {
        assert(this.story,'请先选择存档');assert(quote.length>0&&quote.length<=50000,'请选择不超过 5 万字符的文字');
        const id=uid();await this.edit(this.story.data.id,d=>{d.feedback.push({id,quote,note,polarity,source,status,at:Date.now()});return d;});return id;
    }
    async sendFeedback(ids) {
        const pending=(this.feedbackSubmissions??Promise.resolve()).then(()=>this.submitFeedback(ids));
        this.feedbackSubmissions=pending.catch(()=>{});return pending;
    }
    async submitFeedback(ids) {
        const reserved=new Set([...this.story.data.jobs,...this.story.data.proposals].flatMap(j=>j.feedback.map(f=>f.id)));
        const items=this.story.data.feedback.filter(f=>ids.includes(f.id)&&!reserved.has(f.id)&&['saved','queued'].includes(f.status));assert(items.length,'没有待发送点评，或选中点评已在维护/审阅队列中');
        const key='feedback:'+uid();
        await this.queueJob('feedback',{key,feedback:items});
        await this.edit(this.story.data.id,d=>{for(const f of d.feedback)if(items.some(x=>x.id===f.id))f.status='queued';return d;});
        await this.drain();
    }
    async withdrawFeedback(id){this.controller?.abort();await this.edit(this.story.data.id,d=>{const f=d.feedback.find(f=>f.id===id);assert(f,'点评不存在');f.status='withdrawn';d.jobs=d.jobs.filter(j=>!j.feedback.some(x=>x.id===id));d.proposals=d.proposals.filter(j=>!j.feedback.some(x=>x.id===id));const affected=d.history.filter(h=>h.feedbackIds?.includes(id)).flatMap(h=>h.changes.map(c=>c.id));d.excluded=[...new Set([...d.excluded,...affected])];d.conflicts.push({id:uid(),reason:'feedback-withdrawn',feedbackId:id,at:Date.now()});return d;});}
    async saveSettings(settings){validateSettings(settings);await this.edit('profile',d=>{d.settings=settings;return d;});this.controller?.abort();this.auxController?.abort();if(!settings.enabled)this.host.inject('');}
    async retryJobs(){await this.edit(this.story.data.id,d=>{d.jobs.forEach(j=>{j.state='queued';delete j.error;});return d;});await this.drain();}
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
    async restore(id,entry){const historical=await this.repo.loadVersion(id,entry);await this.edit(id,d=>restoreDocument(d,historical.data));}
    async exportAll(){const documents=[];for(const id of Object.keys(this.repo.index.documents))documents.push((await this.repo.load(id)).data);return {format:'bbpresets-export',schema:1,at:Date.now(),documents};}
    async importArchive(archive){
        assert(archive?.format==='bbpresets-export'&&archive.schema===1&&Array.isArray(archive.documents)&&archive.documents.length<200,'不是支持的导入文件');
        // Import copies stories, never overwrites existing slots. Global guidelines are imported as a reviewable story.
        archive.documents.forEach(validateDocument);
        const epoch=this.epoch;
        await this.edits;
        for(const raw of archive.documents){const d=copy(raw);d.id=uid();d.title=('导入 · '+d.title).slice(0,300);d.type='story';delete d.settings;d.bindings=[];d.memoryBinding=null;d.jobs=[];d.proposals=[];d.parent=null;await this.repo.save(d,0,()=>this.epoch===epoch);}
        this.changed();
    }
    destroy(){clearInterval(this.queueTimer);this.suspend();this.host.destroy();}
}
