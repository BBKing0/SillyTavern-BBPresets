import {assert,copy,hash,same,uid,newDocument,applyChanges,restoreDocument} from '../core/model.js';
import {storyControlChanges,inspirationRoom} from '../core/story.js';
import {sourcePrefixes} from '../core/source-prefix.js';
import {parseWorldTaskControl,parseWorldTaskResult,parseInspirationPlanResult,inspectWorldTaskResult,worldTaskDraftResult} from '../core/world-task.js';
import {selectWorldTaskContext} from '../core/world-task-context.js';
import {promptText} from '../core/prompt-templates.js';
import {responseText} from '../core/json.js';

const stateHash=d=>hash(JSON.stringify({records:d.records,excluded:d.excluded}));
const clean=r=>{const v=copy(r);delete v.sources;return v;};
const active=d=>d.records.filter(r=>r.status==='active'&&!d.excluded.includes(r.id));
const needsApproval=job=>job.kind==='worldTask'&&job.key.startsWith('world-idea:')&&job.approval!=='approved';
// Detailed work is persistent; the normal reply carries only small triggers.
export class WorldTaskRuntime {
    constructor(app){this.app=app;this.memoryChecking=false;}
    async memory(){return await this.app.host.memorySnapshot?.()??null;}
    signature(s){return s?.identitySignature??(s?.available?s.signature:null);}
    async bindMemory({inspiration=true,worldTask=true}={}){
        const a=this.app,epoch=a.epoch,s=await this.memory(),signature=this.signature(s);
        assert(a.ready&&epoch===a.epoch&&signature,'无法确认 BB-Memory 当前已保存槽；请先保存记忆存档后重试');
        assert(inspiration||worldTask,'请选择要绑定的灵感或世界任务档');
        await a.edit('profile',d=>{const row={signature,name:s.slotName??s.slot??'当前记忆槽',at:Date.now(),...(inspiration?{inspirationId:a.inspiration.data.id}:{}),...(worldTask?{worldTaskId:a.worldTask.data.id}:{})};d.memoryArchiveBindings=[...(d.memoryArchiveBindings??[]).filter(b=>b.signature!==signature),row];return d;});
        this.lastMemorySignature=signature;a.changed();return '已绑定当前 BB-Memory 槽；以后切到此槽会选用指定存档';
    }
    async unbindMemory(signature){await this.app.edit('profile',d=>{d.memoryArchiveBindings=(d.memoryArchiveBindings??[]).filter(b=>b.signature!==signature);return d;});return '已解除绑定，当前存档选择保留';}
    async followMemory(){
        const a=this.app;if(this.memoryChecking||!a.ready||!a.host.memorySnapshot)return;
        if(!a.host.identity().chatKey)return;
        const selectionToken=a.host.memorySelectionToken?.();if(selectionToken!==undefined&&selectionToken===this.lastSelectionToken)return;
        this.memoryChecking=true;
        try{
            const epoch=a.epoch,s=await this.memory();if(epoch!==a.epoch||!a.ready)return;
            const signature=this.signature(s),info={signature,title:s?.slotName??s?.slot??'未确认记忆槽',confirmed:Boolean(signature)};
            if(!same(info,a.memoryArchiveInfo)){a.memoryArchiveInfo=info;a.changed();}
            this.lastSelectionToken=selectionToken;
            if(signature===this.lastMemorySignature)return;this.lastMemorySignature=signature;
            const b=a.profile.data.memoryArchiveBindings?.find(b=>b.signature===signature);if(!b)return;
            const inspirationId=b.inspirationId??a.inspiration.data.id,worldTaskId=b.worldTaskId??a.worldTask.data.id;
            if(inspirationId===a.inspiration.data.id&&worldTaskId===a.worldTask.data.id)return;
            await a.edits;await a.repo.refresh();
            const inspiration=await a.upgrade(await a.repo.load(inspirationId),epoch),worldTask=await a.upgrade(await a.repo.load(worldTaskId),epoch);
            assert(inspiration?.data.type==='inspiration'&&worldTask?.data.type==='worldTask','绑定的 BBPresets 存档已删除或缺失，请重新绑定');
            const guard=()=>epoch===a.epoch&&a.ready&&(selectionToken===undefined||a.host.memorySelectionToken()===selectionToken);
            const current=await this.memory();assert(guard()&&this.signature(current)===signature,'读取绑定期间 BB-Memory 已切槽，下次重新读取');
            a.suspend();const nextEpoch=a.epoch;await a.edits;
            const profile=await a.repo.load('profile'),next=copy(profile.data);next.activeInspirationId=inspirationId;next.activeWorldTaskId=worldTaskId;
            a.profile=await a.repo.save(next,profile.revision,()=>nextEpoch===a.epoch&&(selectionToken===undefined||a.host.memorySelectionToken()===selectionToken));
            assert(nextEpoch===a.epoch&&(selectionToken===undefined||a.host.memorySelectionToken()===selectionToken),'发布绑定选择期间记忆槽已变化，下次重新读取');
            a.inspiration=inspiration;a.worldTask=worldTask;a.selectedKey=a.host.identity().chatKey;a.ready=true;
            a.controlStatus='已随 BB-Memory 切换绑定的灵感 / 世界任务档';await a.reconcile();a.changed();return {switched:true};
        }catch(e){this.lastMemorySignature=null;this.lastSelectionToken=undefined;if(!a.ready&&a.profile&&a.inspiration&&a.worldTask){a.selectedKey=a.host.identity().chatKey;a.ready=true;}throw e;}
        finally{this.memoryChecking=false;}
    }
    async createArchive(title,{from=null,select=true}={}){
        const a=this.app;assert(a.ready&&title?.trim(),'请填写世界任务存档名');const epoch=a.epoch;await a.edits;
        const source=from?(await a.repo.load(from))?.data:null;assert(!from||source?.type==='worldTask','世界任务复制来源不存在');
        const d=source?copy(source):newDocument('worldTask',title.trim());d.id=uid();d.title=title.trim();d.jobs=[];d.proposals=[];d.memoryBinding=null;d.bindings=[];d.parent=null;
        if(from)d.manualSavedAt=Date.now();await a.repo.save(d,0,()=>epoch===a.epoch);
        if(select)await a.selectWorldTask(d.id);else a.changed();return select?'已新建并选用世界任务存档':'已另存世界任务副本';
    }
    async loadSaved(id){
        const a=this.app;await a.selectWorldTask(id);const epoch=a.epoch,revision=a.worldTask.revision,entry=a.repo.index.documents[id]?.saved;
        assert(entry,'此档没有手动保存点');const historical=await a.repo.loadVersion(id,entry);
        await a.edit(id,d=>{const next=restoreDocument(d,historical.data);next.manualSavedAt=d.manualSavedAt;return next;},{guard:()=>epoch===a.epoch&&a.worldTask?.data.id===id&&a.worldTask.revision===revision});
        await a.reconcile();return '已读取世界任务手动保存点';
    }
    async deleteArchive(type,id){
        const a=this.app;assert(a.ready,'请等待存档就绪');const entry=a.repo.index.documents[id];assert(entry&&!entry.deleted&&(entry.type===type||type==='author'&&id==='profile'),'删除目标不存在或类型不符');
        if(id==='profile'){
            if(a.activeJob?.ownerId==='profile')a.controller?.abort();
            await a.edit('profile',d=>{d.records=[];d.history=[];d.feedback=[];d.jobs=[];d.proposals=[];d.processed=[];d.excluded=[];d.conflicts=[];return d;});
            return '已清空默认作者资料，原版本保留在版本恢复中';
        }
        if(a.documentFor(id)){
            if(type==='inspiration')await a.createInspiration('默认灵感');
            else if(type==='worldTask')await this.createArchive('默认世界任务');
            else await a.selectAuthor('profile');
        }
        const epoch=a.epoch;await a.edits;await a.repo.refresh();
        await a.edit('profile',d=>{d.memoryArchiveBindings=(d.memoryArchiveBindings??[]).map(b=>{if(b.inspirationId===id)delete b.inspirationId;if(b.worldTaskId===id)delete b.worldTaskId;return b;}).filter(b=>b.inspirationId||b.worldTaskId);return d;});
        await a.repo.delete(id,entry.revision,()=>epoch===a.epoch);a.changed();return '存档已删除；历史版本可从版本恢复中找回';
    }
    async queue(ownerId,{mode='create',idea='',signals=[],source=null,sources=[],immediate=false,key=uid(),prefixHash=null,expectedHash=null}={}){
        const a=this.app,w=a.documentFor(ownerId);assert(w,'任务存档已切换');
        const job={id:uid(),kind:w.data.type==='worldTask'?'worldTask':'inspirationPlan',key,connection:w.data.type==='worldTask'?(a.settings.worldTaskConnection??'main'):(a.settings.inspirationConnection??'main'),chatKey:a.host.identity().chatKey??'',input:JSON.stringify({mode,idea,signals}),signal:{mode,ids:signals.map(x=>x.id)},sources:copy(sources).map(s=>s.id===source?.id&&prefixHash?{...s,prefixHash}:s),anchor:source,source,immediate,prefixHash,expectedHash,feedback:[],at:Date.now(),attempts:0,state:'queued'};
        if(needsApproval(job))job.approval='pending';
        await a.edit(ownerId,d=>{if(d.processed.includes(key)||d.jobs.some(j=>j.key===key))return d;assert(d.jobs.length<60,'任务队列已达上限');d.jobs.push(job);return d;});return job;
    }
    async generate(theme,{connection,formatOnly=false}={}){
        const a=this.app;assert(a.ready&&a.settings.enabled&&theme?.trim(),'请输入任务主题或想体验的情节并启用插件');
        assert(theme.length<=(formatOnly?30000:4000),formatOnly?'已有文字最多 30000 字符':'主题最多 4000 字符');assert(a.worldTask.data.records.filter(r=>r.status==='active').length<(a.settings.worldTaskCapacity??5),'世界任务已达上限，请先归档');
        if(connection)assert(['main','custom'].includes(connection),'连接选择无效');
        const epoch=a.epoch,context=formatOnly?{sources:[]}:await a.host.capture();assert(epoch===a.epoch,'读取主题期间存档已切换');
        const job=await this.queue(a.worldTask.data.id,{idea:theme.trim(),sources:context.sources,source:context.sources.at(-1)??null,prefixHash:sourcePrefixes(context.sources).get(context.sources.at(-1)?.id)??null,immediate:true});
        if(connection||formatOnly)await a.edit(a.worldTask.data.id,d=>{const j=d.jobs.find(j=>j.id===job.id);if(connection)j.connection=connection;if(formatOnly)j.input=JSON.stringify({...JSON.parse(j.input),formatOnly:true});return d;});await a.drain();
        if(epoch!==a.epoch)return '请求期间已切换资料；旧结果不会写入当前档，请回原档查看任务';
        const saved=a.worldTask?.data.jobs.find(j=>j.id===job.id);return saved?.repair?'返回内容待补全，已有文字已保留；请在任务页补齐，无需重新请求':saved?.state==='failed'?'生成失败，主题已保留；请在任务页重试':saved?'已排队，等待模型连接空闲':'世界任务已生成并保存';
    }
    async advance(id){
        const a=this.app;assert(active(a.worldTask.data).some(r=>r.id===id),'任务不存在或已归档');const context=await a.host.capture();
        await this.queue(a.worldTask.data.id,{mode:'advance',signals:[{id,status:'adjust',reason:'用户要求重新规划下一阶段'}],sources:context.sources,source:context.sources.at(-1)??null,prefixHash:sourcePrefixes(context.sources).get(context.sources.at(-1)?.id)??null,immediate:true});await a.drain();return '世界任务推进已处理；请查看任务状态';
    }
    async nextJob(){
        const a=this.app;if(!a.host.identity().chatKey)return null;
        const queued=a.jobs.filter(({job})=>job.state==='queued'&&!needsApproval(job)&&['worldTask','inspirationPlan'].includes(job.kind)&&(job.kind==='worldTask'?job.immediate||a.settings.injectWorldTask!==false&&(job.signal?.mode==='advance'||a.settings.worldTaskAiEnabled):a.settings.injectInspiration!==false&&a.settings.inspirationAiEnabled!==false));if(!queued.length)return null;
        const immediate=queued.find(({job})=>job.immediate&&job.chatKey===a.host.identity().chatKey);if(immediate)return immediate;
        const context=await a.host.capture(),latest=context.rows.findLast(r=>r.role==='assistant');
        return queued.find(({job})=>job.chatKey===context.chatKey&&(job.immediate||job.source&&latest&&latest.floor>job.source.floor))??null;
    }
    get pendingIdeas(){const a=this.app;return a.jobs.filter(({job})=>needsApproval(job)&&['queued','failed'].includes(job.state)&&job.chatKey===a.host.identity().chatKey);}
    async readyIdea(){
        const a=this.app;if(!a.ready||!a.visible()||!a.settings.enabled||a.settings.injectWorldTask===false||!a.settings.worldTaskAiEnabled||!this.pendingIdeas.length)return null;
        const epoch=a.epoch,cancellation=a.controlCancellation,context=await a.host.capture(),latest=context.rows.findLast(r=>r.role==='assistant'),prefixes=sourcePrefixes(context.sources);
        if(epoch!==a.epoch||cancellation!==a.controlCancellation||!a.ready||!a.visible()||!a.settings.enabled||a.settings.injectWorldTask===false||!a.settings.worldTaskAiEnabled||context.chatKey!==a.host.identity().chatKey)return null;
        return this.pendingIdeas.find(({job})=>latest&&job.source&&latest.floor>job.source.floor&&prefixes.get(job.source.id)===job.prefixHash)??null;
    }
    async decideIdea(id,accept,{idea,connection}={}){
        const a=this.app,entry=this.pendingIdeas.find(({job})=>job.id===id);assert(entry,'提议已处理或存档已切换');
        if(accept){assert(a.settings.enabled&&a.settings.injectWorldTask!==false&&a.settings.worldTaskAiEnabled,'请先启用 AI 世界任务提议');assert(idea?.trim()&&idea.length<=4000,'请填写最多 4000 字符的任务想法');assert(['main','custom'].includes(connection),'连接选择无效');const context=await a.host.capture();assert(context.chatKey===entry.job.chatKey&&sourcePrefixes(context.sources).get(entry.job.source.id)===entry.job.prefixHash,'提议来源已变化，请拒绝旧提议后重新创建');}
        await a.edit(entry.target,d=>{const j=d.jobs.find(j=>j.id===id);assert(j&&needsApproval(j),'提议已处理');if(accept){j.input=JSON.stringify({...JSON.parse(j.input),idea:idea.trim()});j.connection=connection;j.approval='approved';j.immediate=true;j.state='queued';delete j.error;}else{d.jobs=d.jobs.filter(j=>j.id!==id);d.processed=[...new Set([...d.processed,j.key])];}return d;});
        if(accept)await a.drain();return accept?'提议已批准，请查看世界任务与队列':'已拒绝此想法，不会调用生成 API';
    }
    async receiveControl(row,g,context){
        const a=this.app,source=context.sources.find(s=>s.id===row.id),sources=context.sources.filter(s=>s.floor<=row.floor),prefixHash=sourcePrefixes(sources).get(source.id);
        const guard=()=>g.controlCancellation===a.controlCancellation&&!a.sendCancelled&&g.epoch===a.epoch&&a.settings.enabled&&g.storyId===a.inspiration?.data.id&&g.worldTaskId===a.worldTask?.data.id;
        assert(guard(),'本轮存档已变化');const latestHashes=new Map(context.sources.map(s=>[s.id,s.hash]));assert(g.sources.every(s=>s.id===row.id||latestHashes.get(s.id)===s.hash),'正文生成期间来源变化，控制未应用');
        const control=parseWorldTaskControl(row.text,g.token,{inspirationIds:new Set(g.inspirationIds),worldTaskIds:new Set(g.worldTaskIds)});
        const features={author:a.settings.injectAuthor!==false,story:false,inspiration:a.settings.injectInspiration!==false,worldTask:a.settings.injectWorldTask!==false};assert(same(g.features,features),'正文期间注入开关已变化');
        assert(features.inspiration||!control.inspiration.idea&&!control.inspiration.update.length&&!control.inspiration.usedIds.length,'灵感注入已关闭');
        assert(features.worldTask||!control.worldTask.idea&&!control.worldTask.signals.length,'世界任务注入已关闭');
        const received=a.inspiration.data.controls?.some(c=>c.source.id===source.id&&c.source.hash===source.hash);
        if(!received&&control.worldTask.signals.length)assert(await stateHash(a.worldTask.data)===g.worldTaskHash,'正文期间世界任务已变化，推进信号未应用');
        if(!received){
            const activity={id:g.token,chatKey:context.chatKey,source,prefixHash,at:Date.now(),...g.counts,status:'applied',controlVersion:5,titleChanged:false,chapterChanged:false,revisionRequested:control.worldTask.signals.length>0};
            await a.edit(g.storyId,async d=>{
                const fresh=await a.host.capture();assert(sourcePrefixes(fresh.sources).get(source.id)===prefixHash,'接收控制期间来源变化');assert(guard(),'本轮存档已变化');
                let usedIds=control.inspiration.usedIds;
                if(await stateHash(d)!==g.baseHash){
                    // Earlier background receipts may finish after this reply started.
                    // Rebase only unchanged targets; independent short ideas stay valid.
                    const baseline=new Map((g.inspirationRecords??[]).map(r=>[r.id,r]));
                    const unchanged=id=>baseline.has(id)&&!d.excluded.includes(id)&&same(d.records.find(r=>r.id===id),baseline.get(id));
                    if(a.settings.inspirationAiEnabled!==false)for(const item of control.inspiration.update)assert(unchanged(item.id),'正文期间目标灵感已变化，更新未应用');
                    usedIds=usedIds.filter(id=>{const current=d.records.find(r=>r.id===id);if(baseline.has(id)&&current?.kind==='inspiration'&&current.status==='archived')return false;assert(unchanged(id),'正文期间目标灵感已变化，使用回报未应用');return true;});
                }
                const local=storyControlChanges(d,{nodes:[],revise:null,inspiration:{add:[],update:control.inspiration.update,usedIds}},a.settings,fresh);
                const deferred={inspirationIdea:control.inspiration.idea&&a.settings.inspirationAiEnabled!==false&&inspirationRoom(d,a.settings,fresh).canAdd?control.inspiration.idea:null,worldTaskIdea:control.worldTask.idea&&a.settings.worldTaskAiEnabled===true&&a.worldTask.data.records.filter(r=>r.status==='active').length<(a.settings.worldTaskCapacity??5)?control.worldTask.idea:null,worldTaskSignals:control.worldTask.signals};
                const receipt={id:uid(),version:5,token:g.token,chatKey:context.chatKey,source,sources,prefixHash,chapter:null,nextIds:[],addedInspirationIds:[],usedInspirationIds:local.usedInspirationIds,updatedNodeIds:[],deferred,worldTaskId:g.worldTaskId,worldTaskHash:g.worldTaskHash,recognition:a.settings.worldTaskRecognition,at:Date.now()};
                if(local.changes.length)d=applyChanges(d,local.changes,{origin:'storycontrol',sources:sources.map(s=>s.id===source.id?{...s,prefixHash}:s),key:'control:'+source.id+':'+source.hash,anchor:source});d.controls??=[];d.controls.push(receipt);d.activity=[...(d.activity??[]).filter(x=>x.source.id!==source.id),activity].slice(-20);return d;
            },{guard});
        }
        // The receipt is a durable outbox. A queue-save failure can be repaired after reload.
        await this.flushOutbox(context);
        a.controlStatus=`灵感使用归档 ${control.inspiration.usedIds.length} 条；创作触发已保存，隔一条完整回复后展开灵感，世界任务新想法先提醒确认`;a.changed();
    }
    async flushOutbox(context=null){
        const a=this.app;if(!a.ready||!a.settings.enabled||!a.host.identity().chatKey)return;context??=await a.host.capture();
        const epoch=a.epoch,prefixes=sourcePrefixes(context.sources);
        for(const c of a.inspiration.data.controls??[]){
            if(c.version!==5||!c.deferred||c.chatKey!==context.chatKey||prefixes.get(c.source.id)!==c.prefixHash)continue;
            assert(epoch===a.epoch,'恢复触发期间存档已切换');
            const data={source:c.source,sources:c.sources,prefixHash:c.prefixHash};
            if(c.deferred.inspirationIdea&&!a.inspiration.data.processed.includes('idea:'+c.source.id+':'+c.source.hash)&&!a.inspiration.data.jobs.some(j=>j.key==='idea:'+c.source.id+':'+c.source.hash)&&a.settings.injectInspiration!==false&&a.settings.inspirationAiEnabled!==false)await this.queue(a.inspiration.data.id,{...data,idea:c.deferred.inspirationIdea,key:'idea:'+c.source.id+':'+c.source.hash});
            if(c.worldTaskId!==a.worldTask.data.id||a.settings.injectWorldTask===false)continue;
            if(c.deferred.worldTaskIdea&&!a.worldTask.data.processed.includes('world-idea:'+c.source.id+':'+c.source.hash)&&!a.worldTask.data.jobs.some(j=>j.key==='world-idea:'+c.source.id+':'+c.source.hash)&&a.settings.worldTaskAiEnabled===true)await this.queue(c.worldTaskId,{...data,idea:c.deferred.worldTaskIdea,key:'world-idea:'+c.source.id+':'+c.source.hash});
            if(c.deferred.worldTaskSignals.length){const key='world-progress:'+c.source.id+':'+c.source.hash;if(a.worldTask.data.processed.includes(key)||a.worldTask.data.jobs.some(j=>j.key===key))continue;if(await stateHash(a.worldTask.data)!==c.worldTaskHash)continue;await this.queue(c.worldTaskId,{...data,mode:'advance',signals:c.deferred.worldTaskSignals,expectedHash:c.worldTaskHash,immediate:c.recognition==='immediate',key});}
        }
    }
    async seed(budget,options={mode:'full'}){
        const a=this.app;if(a.host.worldTaskSeed)return a.host.worldTaskSeed(budget,options);
        const world=await a.host.seed?.(budget)??'';return {world:typeof world==='string'?world:JSON.stringify(world),memory:null,memorySnapshot:null};
    }
    options(job){return {mode:JSON.parse(job.input).mode,ids:job.signal?.ids??[],capacity:this.app.settings.worldTaskCapacity??5};}
    async repairJob(id,ownerId){const j=this.app.documentFor(ownerId)?.data.jobs.find(j=>j.id===id);assert(j?.kind==='worldTask'&&j.repair,'此任务没有可补全的响应');return copy(j.repair);}
    async validateSources(job){
        const a=this.app;assert(a.host.identity().chatKey===job.chatKey,'请回到任务所属聊天处理');
        if(!job.sources.length&&!job.prefixHash)return;
        const context=await a.host.capture(),hashes=new Map(context.sources.map(s=>[s.id,s.hash]));
        assert(context.chatKey===job.chatKey&&job.sources.every(s=>hashes.get(s.id)===s.hash)&&(!job.prefixHash||sourcePrefixes(context.sources).get(job.source.id)===job.prefixHash),'任务来源已被重抽、编辑、删除或重新排序，请重新生成');
    }
    async saveRepair(id,ownerId,value,{json=false}={}){
        const a=this.app;assert(a.ready&&!a.running&&!a.auxiliary,'请等待当前请求结束后补全');const epoch=a.epoch;
        await a.edit(ownerId,async d=>{const j=d.jobs.find(j=>j.id===id);assert(j?.kind==='worldTask'&&j.repair,'补全目标已变化');
            await this.validateSources(j);if(j.repair.checkMemory){const memory=await this.memory();assert(this.signature(memory)===j.repair.memoryIdentity&&(memory?.revisionSignature??null)===j.repair.memoryRevision,'原响应使用的记忆已变化，请重新生成');}
            assert(await stateHash(d)===j.repair.baseHash,'响应返回后资料已修改，请重新生成以保留后写内容');
            const changes=json?parseWorldTaskResult(value,d,this.options(j)):worldTaskDraftResult(value,d,this.options(j));
            assert(epoch===a.epoch&&a.settings.enabled,'补全期间存档已切换或插件已停用');const next=applyChanges(d,changes,{origin:'worldTask',sources:j.sources,key:j.key,anchor:j.anchor});next.jobs=next.jobs.filter(x=>x.id!==id);return next;
        });a.stats.success++;return '补全内容已通过校验并保存，未调用 API';
    }
    async formatRepair(id,ownerId,text,{connection}={}){
        const a=this.app;assert(a.ready&&!a.running&&!a.auxiliary,'请等待当前请求结束');assert(text?.trim()&&text.length<=30000,'待整理文字不能为空，最多 30000 字符');if(connection)assert(['main','custom'].includes(connection),'连接选择无效');
        await a.edit(ownerId,async d=>{const j=d.jobs.find(j=>j.id===id);assert(j?.kind==='worldTask'&&j.repair,'补全目标已变化');assert(await stateHash(d)===j.repair.baseHash,'响应返回后资料已修改，请重新生成');await this.validateSources(j);j.expectedHash=j.repair.baseHash;j.input=JSON.stringify({...JSON.parse(j.input),idea:text,formatOnly:true});j.state='queued';j.immediate=true;if(connection)j.connection=connection;delete j.error;return d;});await a.drain();return '格式整理已处理，请查看世界任务与队列';
    }
    async runJob(job,ownerId){
        const a=this.app,epoch=a.epoch,w=a.documentFor(ownerId),controller=new AbortController();a.controller=controller;a.activeJob={...job,ownerId};
        let selectionToken;const guard=()=>epoch===a.epoch&&!controller.signal.aborted&&a.documentFor(ownerId)&&a.settings.enabled&&(selectionToken===undefined||a.host.memorySelectionToken?.()===selectionToken);
        try{
            assert(!needsApproval(job),'AI 世界任务提议尚未获得用户批准');
            const input=JSON.parse(job.input),formatOnly=job.kind==='worldTask'&&input.formatOnly===true,context=formatOnly?{chatKey:a.host.identity().chatKey,sources:[],rows:[]}:await a.host.capture();assert(context.chatKey===job.chatKey,'任务所属聊天已切换');
            const hashes=new Map(context.sources.map(s=>[s.id,s.hash]));if(formatOnly)await this.validateSources(job);else assert(job.sources.every(s=>hashes.get(s.id)===s.hash),'触发来源已被重抽、编辑或删除，请重新生成');
            if(job.kind==='inspirationPlan')assert(inspirationRoom(w.data,a.settings,context).canAdd,'灵感新增间隔不足或待用库已满，已保留想法；间隔两轮后可重试');
            if(!formatOnly&&job.prefixHash)assert(sourcePrefixes(context.sources).get(job.source.id)===job.prefixHash,'触发之前的上下文已变化，请重新生成');
            if(job.kind==='worldTask'&&input.mode==='create')assert(w.data.records.filter(r=>r.status==='active').length<(a.settings.worldTaskCapacity??5),'世界任务已达上限；未请求模型，请先归档');const baseHash=await stateHash(w.data);assert(!job.expectedHash||job.expectedHash===baseHash,'世界任务阶段已变化，旧进展信号不能继续推进；请让正文重新识别当前方向');const settings=a.taskSettings(job.kind,job),budget=settings.maxInputChars;
            const current=job.kind==='worldTask'?input.mode==='advance'?w.data.records.filter(r=>job.signal.ids.includes(r.id)).map(clean):active(w.data).map(clean):active(w.data).map(clean);
            assert(input.mode!=='advance'||current.length===job.signal.ids.length,'待推进任务已删除或不再可用');
            const cutoff=job.immediate?Infinity:job.source.floor;
            const rows=formatOnly?[]:job.kind==='worldTask'?selectWorldTaskContext(context,settings,{cutoff}):context.rows.filter(r=>r.floor<=cutoff).slice(-(settings.contextRounds??6)*2).map(r=>({role:r.role,text:r.text.replace(/\[BBP_CONTROL\][\s\S]*?\[\/BBP_CONTROL\]/g,'')}));
            const base=formatOnly?{text:input.idea,mode:input.mode,ids:job.signal.ids}:{input,current,context:rows,author:active(a.author.data).map(clean)};const available=budget-JSON.stringify(base).length-1000;assert(available>=2000,'任务主体与上下文超过材料预算，请提高预算或减少上下文轮数');
            const memoryOptions={...(job.kind==='worldTask'?{mode:settings.worldTaskMemoryMode??'vector',categories:settings.worldTaskMemoryModes,query:[input.idea,...input.signals.map(s=>s.reason??''),...current.map(r=>[r.title,r.summary,r.nextNode].filter(Boolean).join('\n')),...rows.map(r=>r.text)].filter(Boolean).join('\n\n')}:{mode:'full'}),signal:controller.signal};
            const seed=formatOnly?{}:await this.seed(available,memoryOptions);if(!formatOnly)selectionToken=a.host.memorySelectionToken?.();const material=formatOnly?base:{...base,world:seed.world,memory:seed.memory,notes:seed.notes??[]};assert(JSON.stringify(material).length<=budget,'世界任务完整材料超过预算，未发送；请提高预算');assert(guard(),'准备材料期间存档已切换');
            await a.edit(ownerId,d=>{const j=d.jobs.find(j=>j.id===job.id);assert(j,'任务已失效');j.attempts++;if(job.kind==='worldTask')j.contextFloors=rows.map(r=>r.floor);return d;},{guard});
            const key=formatOnly?'worldTaskFormat':job.kind==='inspirationPlan'?'inspirationPlan':input.mode==='advance'?'worldTaskAdvance':'worldTaskCreate';
            const prompt=promptText(settings,key,{contract:promptText(settings,job.kind==='inspirationPlan'?'inspirationPlanContract':'worldTaskContract'),material:JSON.stringify(material)});
            const promptHash=await hash(JSON.stringify([prompt,settings.connection,settings.model,settings.endpoint])),cacheKey=`result:${ownerId}:${job.id}`,cached=a.resultCache.get(cacheKey)??await a.readLocal(cacheKey);
            const result=cached?.baseHash===baseHash&&cached?.promptHash===promptHash?cached.result:await a.request(prompt,settings,controller.signal);
            await a.writeLocal(`diagnostic:${ownerId}:${job.id}`,{text:responseText(result).slice(0,200000),at:Date.now(),kind:job.kind});assert(guard(),'任务已取消，晚到结果未应用');
            await this.validateSources(job);
            const snapshot=seed.memorySnapshot,memory=formatOnly?null:await this.memory();if(!formatOnly)assert(this.signature(memory)===this.signature(snapshot)&&(memory?.revisionSignature??null)===(snapshot?.revisionSignature??null),'请求期间 BB-Memory 存档或记忆内容变化，结果未应用');
            if(job.kind==='worldTask'){
                const inspection=inspectWorldTaskResult(result,w.data,{mode:input.mode,ids:job.signal.ids,capacity:settings.worldTaskCapacity??5});
                if(!inspection.valid){await a.edit(ownerId,async d=>{await this.validateSources(job);assert(guard()&&await stateHash(d)===baseHash,'响应返回时资料已变化，不能保存旧修复草稿');const j=d.jobs.find(j=>j.id===job.id);assert(j,'任务已移除');j.repair={baseHash,issues:inspection.issues,draft:inspection.draft,drafts:inspection.drafts,raw:responseText(result).slice(0,200000),checkMemory:!formatOnly,memoryIdentity:this.signature(snapshot)??null,memoryRevision:snapshot?.revisionSignature??null};j.state='failed';j.retryable=false;j.error='返回内容待补全：'+inspection.issues.join('；').slice(0,250);return d;},{guard});a.stats.failed++;a.notify('世界任务返回内容已保留，请到任务页查看缺项并补全','warning');return;}
            }
            const changes=job.kind==='worldTask'?parseWorldTaskResult(result,w.data,{mode:input.mode,ids:job.signal.ids,capacity:settings.worldTaskCapacity??5}):parseInspirationPlanResult(result,w.data,{capacity:settings.inspirationCapacity??20});
            const cachedResult={baseHash,promptHash,result};a.resultCache.set(cacheKey,cachedResult);await a.writeLocal(cacheKey,cachedResult);
            await a.edit(ownerId,async d=>{assert(d.jobs.some(j=>j.id===job.id),'任务已移除，旧结果不应用');if(!formatOnly){const memory=await this.memory();assert(this.signature(memory)===this.signature(seed.memorySnapshot)&&(memory?.revisionSignature??null)===(seed.memorySnapshot?.revisionSignature??null),'提交期间记忆存档或内容变化');}await this.validateSources(job);const fresh=job.kind==='inspirationPlan'?await a.host.capture():null;assert(guard()&&await stateHash(d)===baseHash,'任务期间资料已修改，请重试以合并最新资料');if(job.kind==='inspirationPlan')assert(inspirationRoom(d,a.settings,fresh).canAdd,'新增期间灵感间隔已变化，请稍后重试');let next=applyChanges(d,changes,{origin:job.kind,sources:job.sources,key:job.key,anchor:job.anchor});next.jobs=next.jobs.filter(j=>j.id!==job.id);if(job.kind==='inspirationPlan'&&changes.length){const latestAssistant=fresh.rows.findLast(r=>r.role==='assistant'),c=next.controls?.find(c=>c.source.id===latestAssistant?.id&&c.source.hash===latestAssistant?.hash);if(c)c.addedInspirationIds=changes.filter(c=>c.op==='put').map(c=>c.record.id);}return next;},{guard});
            a.resultCache.delete(cacheKey);await a.writeLocal(cacheKey,null).catch(()=>{});a.stats.success++;a.stats.usage=result?.usage??null;
        }catch(e){a.stats.failed++;if(epoch===a.epoch&&a.documentFor(ownerId)){await a.edit(ownerId,d=>{const j=d.jobs.find(j=>j.id===job.id);if(j){j.state='failed';j.error=controller.signal.aborted?'用户已停止；可在任务页手动重试':String(e.message).slice(0,300);j.retryable=false;}return d;}).catch(()=>{});a.report(e);}}
        finally{if(a.controller===controller){a.controller=null;a.activeJob=null;}a.requestState='';a.changed();}
    }
}
