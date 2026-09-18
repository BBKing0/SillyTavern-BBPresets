import {assert,copy,record,uid} from '../core/model.js';
import {loadStyle,clampPosition} from './surface.js';
import {recordText,simplifyRecord,protectSelection} from './editor.js';

// All imported/model/user text is rendered as text, never markup.
const el=(tag,text='',className='')=>{const n=document.createElement(tag);n.textContent=text;if(className)n.className=className;return n;};
const field=(label,input)=>{const n=el('label','', 'bbp-field');n.append(el('span',label),input);return n;};
const input=(value='',type='text')=>{const n=el('input');n.type=type;n.value=value;return n;};
const area=(value='')=>{const n=el('textarea');n.value=value;n.rows=4;return n;};
const select=(items,value)=>{const n=el('select');for(const [id,label] of items){const o=el('option',label);o.value=id;n.append(o);}n.value=value??items[0]?.[0]??'';return n;};
const check=(value=false)=>{const n=input('','checkbox');n.checked=value;return n;};
const kinds=[['world','世界与节奏'],['guide','写作指南'],['focus','叙事关注'],['experience','作者自我总结']];
const truths=[['plan','构思 / 待验证'],['intent','行动意图'],['event','已发生'],['guidance','写作指导']];
const when=n=>new Date(n).toLocaleString();
const body=r=>r?recordText(r):'（不存在）';
const pages=[['overview','概览 / 存档'],['setup','初始化'],['records','作者资料'],['feedback','收藏 / 点评'],['review','维护 / 提案'],['settings','设置'],['versions','恢复 / 导出']];
const UI_KEY='bbpresets_ui_v1'; // Device layout only: no story data or credentials.
export function download(value,name='BBPresets-export.json'){
    const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
    const a=el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export class Workbench {
    constructor(app){
        this.app=app;this.tab='overview';this.revealed=false;this.selection=null;this.selectedFeedback=new Set();this.storyId=null;this.editor=null;
        this.ui={showBall:true};try{const saved=JSON.parse(localStorage.getItem(UI_KEY));if(saved){this.ui.showBall=saved.showBall!==false;if(Number.isFinite(saved.left)&&Number.isFinite(saved.top)){this.ui.left=saved.left;this.ui.top=saved.top;}}}catch{/* Storage restrictions must not prevent opening the workspace. */}
        this.surface=el('div');this.surface.id='bbpresets-surface';
        // A zero-size host never intercepts the chat. Only the panel and ball receive pointers.
        this.surface.style.cssText='position:fixed;inset:0 auto auto 0;width:0;height:0;z-index:100001;pointer-events:none;visibility:hidden';
        this.shadow=this.surface.attachShadow({mode:'open'});document.body.append(this.surface);
        loadStyle(this.shadow).ready.then(()=>{if(!this.destroyed){this.surface.style.visibility='visible';this.onResize();}}).catch(e=>this.app.report(e));
        this.dialog=el('section','','bbp-dialog bbp-embedded');this.dialog.id='bbpresets-workbench';this.dialog.setAttribute('aria-label','BBPresets 扩展工作台');
        const header=el('header');header.append(el('strong','世界与写作'),this.button('保存当前存档',()=>app.saveCurrent()));
        this.status=el('div','','bbp-status');this.status.setAttribute('role','status');
        this.message=el('div','','bbp-message');this.message.setAttribute('role','status');
        this.nav=el('nav');this.nav.setAttribute('aria-label','工作台页面');
        for(const [id,label] of pages){
            const b=this.button(label,()=>this.open(id));b.dataset.tab=id;this.nav.append(b);
        }
        this.content=el('main');this.dialog.append(header,this.status,this.message,this.nav,this.content);
        this.pageCache=new Map();
        this.onChange=()=>{const id=(this.app.story?.data.id??'')+':'+this.app.host.identity().chatKey,loaded=!this.hadProfile&&this.app.profile,draftLoaded=this.app.ready&&this.draftLoadVersion!==this.app.draftLoadVersion;if(this.app.ready)this.draftLoadVersion=this.app.draftLoadVersion;this.hadProfile=Boolean(this.app.profile);let switched=false;if(id!==this.storyId){this.storyId=id;this.revealed=false;this.editor=null;this.pageCache.clear();this.selectedFeedback.clear();switched=true;}if(switched||loaded||((draftLoaded||this.waitingForStory&&this.app.ready)&&this.tab==='setup'))this.render();this.updateStatus();};
        app.listeners.add(this.onChange);
        this.onSelection=()=>{const s=globalThis.getSelection?.();if(!s||s.isCollapsed||!s.rangeCount)return;const range=s.getRangeAt(0),node=range.commonAncestorContainer;const parent=node.nodeType===1?node:node.parentElement;const message=parent?.closest('.mes');if(!message||!parent.closest('.mes_text'))return;const floor=Number(message.getAttribute('mesid')),m=app.host.ctx().chat?.[floor];if(m&&!m.is_user)this.selection={quote:s.toString(),floor,chatKey:app.host.identity().chatKey};};
        document.addEventListener('pointerup',this.onSelection);
        this.entry=el('div','','bbp-entry inline-drawer');this.entry.id='bbpresets-entry';
        const summary=el('div','','inline-drawer-toggle inline-drawer-header bbp-entry-toggle');summary.setAttribute('role','button');summary.tabIndex=0;this.summary=summary;
        summary.append(el('b','BBPresets v0.4.0'),el('div','','inline-drawer-icon fa-solid fa-circle-chevron-down down'));
        this.entryContent=el('div','','inline-drawer-content bbp-entry-content');this.entryContent.id='bbpresets-entry-content';this.entryContent.hidden=true;
        summary.setAttribute('aria-expanded','false');summary.setAttribute('aria-controls',this.entryContent.id);
        // Own this click so ST's delegated slideToggle cannot toggle a second time.
        summary.addEventListener('click',e=>{e.stopPropagation();this.setExpanded(this.entryContent.hidden);});
        summary.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();summary.click();}});
        this.entryEnabled=check(false);this.entryEnabled.addEventListener('change',async()=>{this.entryEnabled.disabled=true;try{await app.saveSettings({...app.settings,enabled:this.entryEnabled.checked});app.notify(this.entryEnabled.checked?'BBPresets 已启用':'BBPresets 已停用','success');}catch(e){app.report(e);}finally{this.updateStatus();}});
        this.entryStatus=el('p','','bbp-hint');this.entryStatus.setAttribute('role','status');
        this.entryBall=check(this.ui.showBall);this.entryBall.addEventListener('change',()=>this.setBallVisible(this.entryBall.checked));
        const pane=el('div','','bbp-pane');this.paneShadow=pane.attachShadow({mode:'open'});loadStyle(this.paneShadow).ready.catch(e=>app.report(e));
        this.paneShadow.append(this.dialog);
        const enabledLabel=field('启用 BBPresets',this.entryEnabled);enabledLabel.className='checkbox_label';
        this.entryContent.append(enabledLabel,pane);
        this.entry.append(summary,this.entryContent);
        this.quick=el('aside','','bbp-dialog bbp-quick');this.quick.hidden=true;this.quick.id='bbpresets-quick';this.quick.setAttribute('aria-label','BBPresets 快捷操作');
        const quickHeader=el('header');quickHeader.append(el('strong','BBPresets'),this.button('收起快捷菜单',()=>this.close()));
        this.quickStatus=el('div','','bbp-status');this.quickMessage=el('div','','bbp-message');this.quickMessage.setAttribute('role','status');this.quickContent=el('main');
        this.quick.append(quickHeader,this.quickStatus,this.quickMessage,this.quickContent);this.shadow.append(this.quick);this.quickActions();
        this.ball=el('button','✦','bbp-ball');this.ball.type='button';this.ball.setAttribute('aria-label','打开 BBPresets 快捷操作');this.ball.setAttribute('aria-controls',this.quick.id);this.ball.setAttribute('aria-expanded','false');this.ball.title='BBPresets · 点击展开，可拖动';
        const toggle=()=>{this.quick.hidden=!this.quick.hidden;this.ball.setAttribute('aria-expanded',String(!this.quick.hidden));this.layout();};
        this.ball.addEventListener('click',e=>{if(e.detail!==0&&(this.dragged||this.pointerActivated)){this.dragged=false;this.pointerActivated=false;return;}toggle();});this.shadow.append(this.ball);
        this.ball.addEventListener('pointerdown',e=>{if(e.button!==0)return;const r=this.ball.getBoundingClientRect();this.drag={x:e.clientX,y:e.clientY,left:r.left,top:r.top};this.dragged=false;this.pointerActivated=false;this.ball.setPointerCapture(e.pointerId);});
        this.ball.addEventListener('pointermove',e=>{if(!this.drag)return;const dx=e.clientX-this.drag.x,dy=e.clientY-this.drag.y;if(Math.abs(dx)+Math.abs(dy)>6)this.dragged=true;if(!this.dragged)return;this.placeBall({left:this.drag.left+dx,top:this.drag.top+dy});});
        const release=e=>{if(this.drag&&this.dragged){const r=this.ball.getBoundingClientRect();this.ui.left=r.left;this.ui.top=r.top;this.saveUI();}else if(this.drag&&e.type==='pointerup'&&e.pointerType==='touch'){/* Some mobile browsers omit click after pointer capture in a shadow tree. */this.pointerActivated=true;toggle();}this.drag=null;};this.ball.addEventListener('pointerup',release);this.ball.addEventListener('pointercancel',release);this.ball.addEventListener('lostpointercapture',release);
        this.onResize=()=>this.layout();
        this.onKey=e=>{if(e.key==='Escape'&&!this.quick.hidden)this.close();};document.addEventListener('keydown',this.onKey);globalThis.addEventListener('resize',this.onResize);
        this.resizeObserver=new ResizeObserver(this.onResize);this.resizeObserver.observe(document.body);const form=document.querySelector('#send_form');if(form)this.resizeObserver.observe(form);this.onResize();
        globalThis.visualViewport?.addEventListener('resize',this.onResize);globalThis.visualViewport?.addEventListener('scroll',this.onResize);
        this.mount();this.observer=new MutationObserver(()=>this.mount());this.observer.observe(document.body,{childList:true,subtree:true});
        this.onChange();
    }
    setExpanded(expanded){this.entryContent.hidden=!expanded;this.summary.setAttribute('aria-expanded',String(expanded));this.summary.lastChild.className='inline-drawer-icon fa-solid '+(expanded?'fa-circle-chevron-up up':'fa-circle-chevron-down down');if(expanded&&!this.content.children.length)this.render();}
    quickActions(){
        const a=this.app,c=this.quickContent;
        this.quickStop=this.button('停止当前请求',()=>a.cancelRequests());
        c.append(this.button('快速保存',()=>a.saveCurrent()),this.button('手动提取',()=>a.manual('world')),this.button('作者自我总结',()=>a.manual('reflection')),this.button('重试失败任务',()=>a.retryJobs()),this.quickStop);
        const tempSection=el('details'),feedbackSection=el('details');tempSection.append(el('summary','本轮要求'));feedbackSection.append(el('summary','收藏 / 点评'));
        const temp=area(a.temporary);temp.rows=2;tempSection.append(field('本轮要求',temp),this.button('用于下一次回复',()=>{a.temporary=temp.value;return '已设置，仅作用于下一次回复';}));
        const note=area();note.rows=2;const intent=select([['save','只收藏，不发送'],['batch','加入待发送批次'],['send','收藏并立即发送']],'save');
        feedbackSection.append(field('点评最新回复 / 已选文字（可留空）',note),field('发送方式',intent),this.button('保存收藏 / 点评',async()=>{
            const context=await a.host.capture(),selection=this.selection?.chatKey===context.chatKey?this.selection:null,row=selection?context.rows.find(r=>r.floor===selection.floor):context.rows.findLast(r=>r.role==='assistant');assert(row,'当前没有可收藏的回复');
            const id=await a.addFeedback({quote:selection?.quote??row.text,note:note.value,source:context.sources.find(s=>s.id===row.id),status:intent.value==='batch'?'queued':'saved'});if(intent.value==='send')await a.sendFeedback([id]);note.value='';return intent.value==='save'?'已收藏，未发送给 AI':intent.value==='batch'?'已加入待发送批次':'已提交点评';
        }));c.append(tempSection,feedbackSection);
        for(const section of [tempSection,feedbackSection])section.addEventListener('toggle',()=>{if(section.open){const other=section===tempSection?feedbackSection:tempSection;other.open=false;}this.layout();});
    }
    saveUI(){try{localStorage.setItem(UI_KEY,JSON.stringify(this.ui));}catch{this.app.notify('界面已调整，但浏览器禁止保存本设备偏好；刷新后会恢复默认。','warning');}}
    setBallVisible(show){this.ui.showBall=show;this.ball.hidden=!show;if(!show)this.close();this.entryBall.checked=show;this.saveUI();this.layout();}
    resetBall(){delete this.ui.left;delete this.ui.top;this.setBallVisible(true);return '悬浮球已显示并回到默认位置';}
    bounds(){const v=globalThis.visualViewport,left=v?.offsetLeft??0,top=v?.offsetTop??0;return {left:left+8,top:top+8,right:left+(v?.width??innerWidth)-8,bottom:top+(v?.height??innerHeight)-8};}
    placeBall(position){const r=this.ball.getBoundingClientRect(),b=this.bounds(),form=document.querySelector('#send_form')?.getBoundingClientRect();if(form?.height&&form.top>b.top+64&&form.top<b.bottom)b.bottom=form.top-8;const p=clampPosition(position,b,{width:r.width||48,height:r.height||48});this.ball.style.left=p.left+'px';this.ball.style.top=p.top+'px';}
    layout(){
        const b=this.bounds(),form=document.querySelector('#send_form')?.getBoundingClientRect(),topbar=document.querySelector('#top-settings-holder')?.getBoundingClientRect();
        const top=Math.max(b.top,topbar?.bottom??b.top+40);let bottom=b.bottom;
        if(form?.height&&form.top>top+120&&form.top<bottom)bottom=form.top-8;
        this.placeBall({left:this.ui.left??b.right-48,top:this.ui.top??Math.max(b.top+48,(b.bottom-b.top)*.4+b.top)});
        const width=Math.min(320,b.right-b.left),height=Math.max(80,bottom-top),ball=this.ball.getBoundingClientRect();
        Object.assign(this.quick.style,{width:width+'px',maxHeight:height+'px'});
        const position=clampPosition({left:ball.left-width-8,top:ball.top},{...b,top,bottom},{width,height:this.quick.getBoundingClientRect().height});
        Object.assign(this.quick.style,{left:position.left+'px',top:position.top+'px'});
    }
    mount(){if(this.entry.isConnected)return;const target=document.querySelector('#extensions_settings2')??document.querySelector('#extensions_settings');if(target)target.append(this.entry);}
    button(label,fn){const b=el('button',label,'menu_button');b.type='button';b.addEventListener('click',async()=>{if(b.disabled)return;b.disabled=true;const show=text=>{if(this.message)this.message.textContent=text;if(this.quickMessage)this.quickMessage.textContent=text;if(this.ball)this.layout();};show('正在处理…');try{const result=await fn();show(typeof result==='string'?result:'操作完成');}catch(e){show(e.message);this.app.report(e);}finally{b.disabled=false;}});return b;}
    updateStatus(){
        const a=this.app,s=a.story?.data;const names={loading:'读取服务器中',saving:'正在保存',saved:'已保存到酒馆服务器',error:'保存未完成，请查看恢复区'};
        const activity=a.auxiliary?'准备问题 / 测试连接中':a.activeJob?'正在提取 '+floorLabel(a.activeJob.sources):s?.jobs.some(j=>j.state==='queued')?(a.foreground?'正文完成后继续维护':'维护已排队'):!s?'请选择故事以开始维护':!a.settings?.enabled?'插件已停用':a.settings.mode==='manual'?'手动模式':'等待下一条用户消息，提取上一完整轮';
        const progress=a.progress,landmarks=`最新提取楼层：${progress.floor===null?'尚未提取':`第 ${progress.floor} 楼${progress.worldReview?'（待审阅）':''}`} · 最近自我总结：${progress.reflectionAt?when(progress.reflectionAt)+(progress.reflectionReview?'（待审阅）':''):'尚未总结'}`;
        const draftState=a.draftError?' · '+a.draftError:a.draftEntry()?.dirty?' · 初始化草稿待同步':'';
        this.status.textContent=`${s?.title??'尚未选择故事'} · ${names[a.status]??a.status}${draftState} · ${landmarks} · 待办 ${s?.jobs.length??0} / 提案 ${s?.proposals.length??0} · ${a.requestState||activity}${a.lastInjection.omitted?' · 注入预算省略 '+a.lastInjection.omitted+' 条':''}${a.error?' · '+a.error:''}`;
        if(this.quickStatus)this.quickStatus.textContent=`${s?.title??'请在扩展栏选择存档'} · ${names[a.status]??a.status}${draftState}\n${landmarks}\n${a.requestState||activity}${a.error?' · '+a.error:''}`;
        if(this.quickStop)this.quickStop.hidden=!a.running&&!a.auxiliary&&!a.preparing;
        if(this.entryStatus)this.entryStatus.textContent=activity+(a.error?' · '+a.error:'');
        if(this.entryEnabled){this.entryEnabled.checked=Boolean(a.settings?.enabled);this.entryEnabled.disabled=!a.settings;}
        if(this.ball){this.ball.hidden=!this.ui.showBall;this.ball.dataset.busy=String(Boolean(a.running||a.auxiliary));this.ball.dataset.error=String(Boolean(a.error));this.ball.title='BBPresets · '+activity;}
        if(this.ball&&!this.quick.hidden)this.layout();
    }
    open(tab=this.tab){
        if(tab!==this.tab){if(['settings','feedback','overview'].includes(this.tab))this.pageCache.set(this.tab,[...this.content.childNodes]);this.tab=tab;const cached=this.pageCache.get(tab);if(cached)this.content.replaceChildren(...cached);else this.render();}
        else if(!this.content.children.length)this.render();
        this.setExpanded(true);for(const b of this.nav.children)b.setAttribute('aria-current',String(b.dataset.tab===this.tab));this.updateStatus();
    }
    close(){this.quick.hidden=true;this.ball.setAttribute('aria-expanded','false');}
    render(){
        this.pageCache.delete(this.tab);
        this.content.replaceChildren();this.updateStatus();for(const b of this.nav.children)b.setAttribute('aria-current',String(b.dataset.tab===this.tab));
        const fn={overview:'overview',setup:'setup',records:'records',feedback:'feedback',review:'review',settings:'settings',versions:'versions'}[this.tab];
        if(!this.app.profile&&this.tab!=='versions'){this.content.append(el('p','正在连接酒馆资料存储；失败时可到“恢复 / 导出”刷新或恢复索引。'));return;}
        if(!['overview','settings','versions'].includes(this.tab)&&!this.app.story){this.content.append(el('p','请先在“概览 / 存档”新建或选择独立故事。'));return;}
        this[fn]();
    }
    authorGate(){if(this.revealed)return true;this.content.append(el('p','此页包含世界幕后、行动意图和作者构思，可能透露剧情。'),this.button('查看作者资料',()=>{this.revealed=true;this.render();}));return false;}
    overview(){
        const a=this.app,s=a.story?.data;this.content.append(el('h2','故事存档'),el('p','资料修改后持续保存；也可以手动保存一个当前版本。'));
        if(s)this.content.append(this.button('保存存档',()=>a.saveCurrent()),el('p',s.manualSavedAt?'最近手动保存：'+when(s.manualSavedAt):'尚未手动保存；已提交的资料会自动保存。','bbp-hint'));
        const choices=Object.entries(a.repo.index?.documents??{}).filter(([,d])=>d.type==='story').map(([id,d])=>[id,d.title]);
        const picker=select([['','请选择故事'],...choices],s?.id??'');this.content.append(field('当前聊天使用的 BBPresets 存档',picker),this.button('选择此存档',async()=>{assert(picker.value,'请选择存档');await a.selectStory(picker.value);this.render();}));
        const title=input('');title.placeholder='例如：江南 · 初访';this.content.append(field('新存档名称',title));
        const actions=el('div','','bbp-actions');actions.append(this.button('新建空白故事',async()=>{await a.createStory(title.value);this.render();}));
        const source=a.branchCandidate?.storyId??s?.id;
        if(source)actions.append(this.button(a.branchCandidate?'从原聊天复制 if 分支':'从当前档建立独立分支',async()=>{await a.createStory(title.value,{from:source});this.render();}));
        this.content.append(actions,el('p','换楼续写可选择原档；if 分支复制当前聊天仍有效的历史，各自保存。与 BB-Memory 的选择相互独立，联动在设置中开启。','bbp-hint'));
        if(s){const card=el('section','','bbp-card');card.append(el('h3','无剧透概览'),el('p',`世界条目 ${s.records.filter(r=>r.kind==='world').length} · 指南与关注 ${s.records.filter(r=>['guide','focus'].includes(r.kind)).length} · 作者经验 ${s.records.filter(r=>r.kind==='experience').length}`),el('p',`受保护条目 ${s.records.filter(r=>r.locked||r.blocks.some(b=>b.locked)).length} · 冲突 ${s.conflicts.length} · 暂停注入 ${s.excluded.length}`),this.button('查看作者资料',()=>{this.revealed=true;this.tab='records';this.render();}));this.content.append(card);
            const temp=area(a.temporary);this.content.append(field('仅下一次回复的作者要求',temp),this.button('设为本轮要求',()=>{a.temporary=temp.value;}),el('p','本轮要求不会自动写成永久偏好。','bbp-hint'));
        }
        this.content.append(this.button('从服务器刷新',async()=>{await a.refresh();this.render();}));
    }
    setup(){
        const a=this.app;if(!a.ready){this.waitingForStory=true;this.content.append(el('p','正在读取当前故事，请稍后。'));return;}this.waitingForStory=false;const d=a.ensureDraft();this.content.append(el('h2','为这个世界准备一个起点'),el('p','根据世界书、人设与近期对话逐题沟通。可以跳过、长答，或随时记录新想法。'));
        const generate=mode=>async()=>{await a.prepareInitialization(mode);if(this.tab==='setup')this.render();return mode==='append'?'补充问题已准备好，已有回答保留':'问题已准备好，已有回答保留';};
        const controls=el('div','','bbp-actions');controls.append(this.button(d.questions.length?'重新生成问题（保留已答）':'读取资料，生成问题',generate('replace')));
        if(d.questions.length)controls.append(this.button('根据回答补充问题',generate('append')));
        controls.append(this.button('停止当前请求',()=>a.cancelRequests()));
        if(!d.questions.length)this.content.append(controls);
        if(d.request&&!a.preparing)this.content.append(el('p','上次提问尚未完成。已有问题与回答均保留，可重新生成或补充问题继续。','bbp-hint'));
        if(d.questions.length){
            const index=Math.max(0,Math.min(d.cursor,d.questions.length-1)),q=d.questions[index],card=el('section','','bbp-card bbp-question');
            card.append(el('small',`第 ${index+1} / ${d.questions.length} 题`),el('h3',q.question),el('p','参考示例：'+q.example,'bbp-hint'));
            const answer=area(q.answer);answer.rows=6;answer.placeholder='写下你的回答，想到更多也可以继续写。';answer.addEventListener('input',()=>a.updateInitialization(d=>{const item=d.questions.find(x=>x.id===q.id);if(item)item.answer=answer.value;}));
            card.append(field('你的回答',answer));
            const navigation=el('div','','bbp-actions'),go=cursor=>()=>{a.updateInitialization(d=>{d.cursor=cursor;});this.render();};
            if(index>0)navigation.append(this.button('上一题',go(index-1)));
            if(index<d.questions.length-1)navigation.append(this.button('下一题',go(index+1)));else navigation.append(el('span','已到最后一题，可以补充想法或继续追问。','bbp-hint'));
            card.append(navigation);this.content.append(card);
        }
        if(d.questions.length)this.content.append(controls);
        const notes=area(d.notes);notes.rows=4;notes.placeholder='问题之外的新想法、背景设定或写作要求，都可以继续写在这里。';notes.addEventListener('input',()=>a.updateInitialization(d=>{d.notes=notes.value;}));
        this.content.append(field('自由补充 / 新想法',notes));
        if(d.previous.length){const previous=el('details');previous.append(el('summary',`已保留的往轮回答（${d.previous.length}）`));for(const q of d.previous){const answer=area(q.answer);answer.addEventListener('input',()=>a.updateInitialization(d=>{const item=d.previous.find(x=>x.id===q.id);if(item)item.answer=answer.value;}));previous.append(field(q.question,answer));}this.content.append(previous);}
        this.content.append(this.button('保存问答草稿',async()=>{await a.flushDraft();return '问答草稿已保存到酒馆服务器';}),this.button('导出问答草稿',()=>download(a.initialization,'BBPresets-initialization-draft.json')),this.button('建立初始资料',async()=>{await a.completeInitialization();this.tab='review';this.render();return a.story.data.jobs.some(j=>j.kind==='initialization'&&j.state==='failed')?'初始化未完成，请查看失败原因并重试':a.story.data.proposals.some(p=>p.kind==='initialization')?'初始资料已生成，请到提案中查看并应用':'初始资料已建立';}));
        const info=a.host.seedInfo;if(info)this.content.append(el('p',`已参考：${info.sections.join('、')}。${info.omitted?`有 ${info.omitted} 份资料按预算节选。`:''}${info.notes.join('；')}`,'bbp-hint'));
        this.content.append(el('p','草稿会自动保存，收起侧栏不会清空。示例不会当作你的偏好；半自动模式下初始资料先生成提案。','bbp-hint'));
    }
    records(){
        if(!this.authorGate())return;
        if(this.editor){this.recordEditor();return;}
        this.content.append(el('h2','作者资料'),el('p','世界板以需求、资源、约束、行动条件和可接触迹象组织。将构思、意图与已发生事件分开。'));
        const scope=select([['story','本故事'],['profile','用户默认指南']],this.recordScope??'story');scope.addEventListener('change',()=>{this.recordScope=scope.value;this.render();});this.content.append(field('资料作用域',scope));
        const doc=scope.value==='profile'?this.app.profile.data:this.app.story.data;
        this.content.append(this.button('新增条目',()=>{this.editor={target:doc.id,draft:record({kind:scope.value==='profile'?'guide':'world'}),expected:null};this.render();}));
        if(!doc.records.length)this.content.append(el('p','还没有条目。可以手写，也可以运行初始化。'));
        for(const r of doc.records){const card=el('section','','bbp-card');card.append(el('h3',r.title||'未命名条目'),el('p',`${kinds.find(x=>x[0]===r.kind)?.[1]} · ${truths.find(x=>x[0]===r.truth)?.[1]} · ${r.locked?'整条保留':r.blocks.some(b=>b.locked)?'部分文字保留':'可维护'} · ${r.status==='archived'?'已归档':'使用中'}${doc.excluded.includes(r.id)?' · 来源冲突，暂停注入':''}`),el('p',body(r),'bbp-prose'),el('small',`来源：${r.origin} · ${r.sources.length} 条消息依据`),this.button('编辑 / 设置保留',()=>{this.editor={target:doc.id,draft:copy(r),expected:copy(r)};this.render();}));if(scope.value==='story'&&r.kind==='guide')card.append(this.button('复制为用户默认指南',async()=>{const promoted={...copy(r),id:uid(),sources:[],origin:'manual'};await this.app.saveRecord('profile',promoted,null);}));this.content.append(card);}
    }
    recordEditor(){
        const e=this.editor,r=simplifyRecord(e.draft);this.content.append(el('h2',e.expected?'编辑条目':'新增条目'));
        const title=input(r.title),kind=select(kinds,r.kind),truth=select(truths,r.truth),importance=select([['minor','普通更新'],['major','重要改变']],r.importance),status=select([['active','使用中'],['archived','归档，不注入']],r.status),locked=check(r.locked);
        for(const [key,node] of Object.entries({title,kind,truth,importance,status,locked}))node.addEventListener(node.type==='text'?'input':'change',()=>{r[key]=node.type==='checkbox'?node.checked:node.value;});
        title.maxLength=300;this.content.append(field('标题',title),field('保护整个条目（AI 不得编辑）',locked));
        const advanced=el('details');advanced.append(el('summary','条目属性'),field('类别',kind),field('事实状态',truth),field('重要程度',importance),field('使用状态',status));this.content.append(advanced);
        const segmented=r.blocks.some(b=>b.locked),blocks=el('div','','bbp-blocks');
        for(const [index,b] of r.blocks.entries()){
            const wrap=el('section','','bbp-text-section'),text=area(b.text);text.rows=segmented?4:8;
            text.addEventListener('input',()=>{b.text=text.value;});wrap.append(field(segmented?(b.locked?'保护段':'可编辑正文')+' '+(index+1):'正文',text));
            if(b.locked){wrap.classList.add('bbp-protected');wrap.append(this.button('取消此段保护',()=>{b.locked=false;this.render();}));}
            else wrap.append(this.button('保护选中文字',()=>{protectSelection(r,b.id,text.selectionStart,text.selectionEnd);this.render();}));
            blocks.append(wrap);
        }
        this.content.append(blocks,this.button('增加保护段',()=>{r.blocks.push({id:uid(),text:'',locked:true});this.render();}));
        this.content.append(this.button('保存条目',async()=>{await this.app.saveRecord(e.target,r,e.expected);this.editor=null;this.render();return '条目已保存';}),this.button('返回列表',()=>{this.editor=null;this.render();}),el('p','普通条目直接编辑整篇正文。只有局部需要保留时，才选择文字设为保护段，或新增保护段；整条保护优先。','bbp-hint'));
    }
    feedback(){
        this.content.append(el('h2','收藏与点评'),el('p','选中的回复可以只收藏、积攒点评或立即发送。没有点评不会被解释为认可。'));
        const quote=area(),note=area(),polarity=select([['positive','喜欢'],['negative','不喜欢'],['neutral','中性 / 收藏']],'neutral');let source=null;
        const use=async selection=>{const c=await this.app.host.capture();assert(!selection||selection.chatKey===c.chatKey,'选段来自另一个聊天，请重新选择');const row=selection?c.rows.find(r=>r.floor===selection.floor):[...c.rows].reverse().find(r=>r.role==='assistant');assert(row,'没有可收藏的回复');quote.value=selection?.quote??row.text;source=c.sources.find(s=>s.id===row.id);};
        this.content.append(this.button('载入聊天中选中的段落',()=>{assert(this.selection,'请先在回复中划选文字，或使用“载入最新回复”');return use(this.selection);}),this.button('载入最新回复（手机可删减选段）',()=>use(null)),field('原文',quote),field('态度',polarity),field('点评（可留空）',note));
        const save=async mode=>{const id=await this.app.addFeedback({quote:quote.value,note:note.value,polarity:polarity.value,source,status:mode==='batch'?'queued':'saved'});if(mode==='send')await this.app.sendFeedback([id]);this.render();};
        const buttons=el('div','','bbp-actions');buttons.append(this.button('只收藏，不发送',()=>save('save')),this.button('加入待发送批次',()=>save('batch')),this.button('收藏并立即发送',()=>save('send')));this.content.append(buttons);
        const labels={saved:'仅保存',queued:'待处理',processed:'已处理',withdrawn:'已撤回'};
        this.content.append(this.button('发送勾选的点评',async()=>{await this.app.sendFeedback([...this.selectedFeedback]);this.selectedFeedback.clear();this.render();}),this.button('发送所有待发送批次',async()=>{await this.app.sendFeedback(this.app.story.data.feedback.filter(f=>f.status==='queued').map(f=>f.id));this.render();}));
        for(const f of [...this.app.story.data.feedback].reverse()){const c=el('section','','bbp-card'),pick=check(this.selectedFeedback.has(f.id));pick.disabled=['processed','withdrawn'].includes(f.status);pick.addEventListener('change',()=>pick.checked?this.selectedFeedback.add(f.id):this.selectedFeedback.delete(f.id));c.append(field(`${labels[f.status]} · ${when(f.at)}${f.sourceChanged?' · 来源已变化，收藏原文保留':''}`,pick),el('blockquote',f.quote),el('p',f.note));if(f.status!=='withdrawn')c.append(this.button('撤回此点评',async()=>{await this.app.withdrawFeedback(f.id);this.render();}));this.content.append(c);}
    }
    review(){
        this.content.append(el('h2','维护与提案'),this.button('手动维护世界',()=>this.app.manual('world')),this.button('作者自我总结',()=>this.app.manual('reflection')),this.button('重试失败维护 / 继续队列',()=>this.app.retryJobs()),this.button('刷新本页状态',()=>this.render()));
        const d=this.app.story.data;for(const j of d.jobs)this.content.append(el('p',`${j.kind} · ${floorLabel(j.sources)} · ${j.state==='failed'?'失败，可重试':'等待维护'} · 尝试 ${j.attempts} 次${j.error?' · '+j.error:''}`));
        this.content.append(el('p',`待审阅 ${d.proposals.length} 项 · 历史变更 ${d.history.length} 次 · 冲突 ${d.conflicts.length} 项`));
        if(!this.authorGate())return;
        for(const p of d.proposals){const card=el('section','','bbp-card');card.append(el('h3',`${p.kind} 提案 · ${when(p.at)}`));for(const c of p.changes){const before=d.records.find(r=>r.id===(c.id??c.record?.id));card.append(el('h4',c.record?.title??before?.title??c.id),el('pre','当前：\n'+body(before)),el('pre','建议：\n'+body(c.op==='put'?c.record:null)));}card.append(this.button('应用此提案',async()=>{await this.app.reviewProposal(p.id,true);this.render();}),this.button('拒绝此提案',async()=>{await this.app.reviewProposal(p.id,false);this.render();}));this.content.append(card);}
        for(const c of d.conflicts)this.content.append(el('p',`冲突：${c.reason} · ${c.recordId??c.feedbackId??''}。请检查对应条目；保留文字未改动。`));
        for(const h of [...d.history].reverse().slice(0,30)){const details=el('details');details.append(el('summary',`${when(h.at)} · ${h.origin} · ${h.changes.length} 个变更`));for(const c of h.changes)details.append(el('pre',`${c.after?.title??c.before?.title??c.id}\n之前：${body(c.before)}\n之后：${body(c.after)}`));this.content.append(details);}
    }
    settings(){
        const a=this.app,s=copy(a.settings),fields={};this.content.append(el('h2','维护设置'));
        const showBall=check(this.ui.showBall);showBall.addEventListener('change',()=>this.setBallVisible(showBall.checked));
        this.content.append(field('显示悬浮球（本设备，立即生效）',showBall),this.button('重置悬浮球位置',()=>{showBall.checked=true;return this.resetBall();}));
        const toggles=[['enabled','启用 BBPresets'],['reflectionEnabled','自动作者自我总结'],['memoryRead','允许读取已确认同故事的 BB-Memory'],['memoryFollow','跟随已映射的 BB-Memory 槽（默认关闭）']];
        for(const [key,label] of toggles){fields[key]=check(s[key]);this.content.append(field(label,fields[key]));}
        for(const [key,label,options] of [['mode','编辑权限',[['semi','半自动：小改直接记录，重要变更提案'],['auto','全自动：自动修改全部未保护资料'],['manual','全手动：只按按钮维护，变更先审阅']]],['timing','维护时机',[['background','发送时后台整理上一完整轮'],['before','先维护，再生成正文']]],['connection','模型连接',[['main','复用酒馆主连接（正文完成后排队）'],['custom','独立 OpenAI 兼容连接']]]]){fields[key]=select(options,s[key]);this.content.append(field(label,fields[key]));}
        for(const [key,label,min,max] of [['frequency','每多少完整轮维护世界',1,100],['reflectionFrequency','每多少完整轮作者自我总结',1,500],['contextRounds','维护参考最近轮数',1,30],['maxInputChars','维护材料字符预算（不含固定指令）',2000,150000],['injectionChars','正文注入字符预算',500,40000],['timeoutSeconds','维护超时（秒）',10,300]]){fields[key]=input(s[key],'number');fields[key].min=min;fields[key].max=max;this.content.append(field(label,fields[key]));}
        fields.endpoint=input(s.endpoint);fields.model=input(s.model);const key=input('','password');key.autocomplete='off';key.placeholder=a.host.key?'已保存在本设备；留空保留':'仅保存在本设备，不随导出同步';this.content.append(field('独立 API 地址（支持 /v1 或完整 /chat/completions）',fields.endpoint),field('独立模型名称',fields.model),field('独立 API Key',key));
        const values=()=>({...s,...Object.fromEntries(Object.entries(fields).map(([k,n])=>[k,n.type==='checkbox'?n.checked:n.type==='number'?Number(n.value):n.value]))});
        this.content.append(this.button('测试 API 连接',()=>a.testConnection(values(),key.value||a.host.key)),el('p','测试使用当前表单中的连接与 Key，发送一条简短请求；不会提交故事资料。测试成功后请保存设置。','bbp-hint'));
        this.content.append(this.button('保存设置',async()=>{await a.saveSettings(values(),s);Object.assign(s,copy(a.settings));if(key.value)await a.host.setKey(key.value);key.value='';}),this.button('载入已保存设置',()=>this.render()),this.button('清除本设备 API Key',async()=>{await a.host.setKey('');key.value='';}),el('p','独立连接需要服务端允许浏览器跨域访问；浏览器维护密钥不跨设备同步。主连接沿用酒馆当前配置。短暂网络故障最多自动重试两次；输入与任务会保留。','bbp-hint'));
        if(a.story)this.content.append(el('h3','可选 BB-Memory 对应关系'),el('p',a.story.data.memoryBinding?`已确认槽：${a.story.data.memoryBinding.slotName}`:'尚无映射；不会读取其他故事'),this.button('确认当前两个存档属于同一故事',async()=>{await a.bindMemory();this.render();}),this.button('解除此档映射',async()=>{await a.edit(a.story.data.id,d=>{d.memoryBinding=null;return d;});this.render();}));
    }
    versions(){
        const a=this.app;this.content.append(el('h2','服务器版本与恢复'),el('p','电脑显示“已保存到酒馆服务器”后，手机打开同一账户会读取这份记录。返回旧页面时先刷新服务器版本。'));
        this.content.append(this.button('重新读取服务器',async()=>{await a.refresh();this.render();}),this.button('主索引损坏时恢复备份',async()=>{await a.repo.recoverIndex();await a.refresh();this.render();}));
        if(a.profile)this.content.append(this.button('导出全部资料',async()=>download(await a.exportAll())));
        const file=input('','file');file.accept='.json,application/json';this.content.append(field('导入资料（创建副本，保留现有存档）',file),this.button('导入为新存档',async()=>{const f=file.files[0];assert(f&&f.size<12_000_000,'请选择小于 12 MB 的 BBPresets JSON');let data;try{data=JSON.parse(await f.text());}catch{throw Error('导入文件不是有效 JSON');}await a.importArchive(data);this.render();}));
        if(a.profile){const scopes=[['profile','用户默认指南与设置'],...(a.story?[[a.story.data.id,'当前故事']]:[])],target=select(scopes,this.versionTarget??a.story?.data.id??'profile');if(!target.value)target.value='profile';target.addEventListener('change',()=>{this.versionTarget=target.value;this.render();});const id=target.value,versions=a.repo.index.documents[id]?.history??[],picker=select(versions.map((v,i)=>[String(i),`版本 ${v.revision} · ${when(v.at)}`]));this.content.append(field('恢复作用域',target),field('历史版本',picker),this.button('查看所选版本的作者资料',async()=>{assert(versions.length,'尚无历史版本');const epoch=a.epoch,version=await a.repo.loadVersion(id,versions[Number(picker.value)]);assert(epoch===a.epoch,'故事已切换，请重新查看版本');const card=el('section','','bbp-card');card.append(el('h3',`版本 ${version.revision} · 作者资料`));for(const r of version.data.records)card.append(el('h4',r.title),el('pre',body(r)));this.content.append(card);}),this.button('恢复所选版本',async()=>{assert(versions.length,'尚无历史版本');await a.restore(id,versions[Number(picker.value)]);this.render();}),el('p','恢复会新建版本，保留已有历史和点评；当前保留文字若与旧版本冲突，恢复将停止。','bbp-hint'));}
        this.content.append(this.button('检查本设备未完成保存',async()=>{const rows=await a.recovery.list();const list=el('section','','bbp-card');list.append(el('h3',`待恢复副本 ${Object.keys(rows).length} 份`));for(const [id,p] of Object.entries(rows)){const archive={format:'bbpresets-export',schema:1,documents:[p.data]};list.append(el('p',`${p.data.title} · ${when(p.at)}`),this.button('导出此恢复副本',()=>download(archive,`BBPresets-recovery-${id}.json`)),this.button('恢复为独立副本',async()=>{await a.importArchive(archive);this.render();}));}this.content.append(list);}));
    }
    destroy(){this.destroyed=true;this.observer.disconnect();this.resizeObserver.disconnect();globalThis.removeEventListener('resize',this.onResize);globalThis.visualViewport?.removeEventListener('resize',this.onResize);globalThis.visualViewport?.removeEventListener('scroll',this.onResize);document.removeEventListener('keydown',this.onKey);document.removeEventListener('pointerup',this.onSelection);this.app.listeners.delete(this.onChange);this.surface.remove();this.entry.remove();}
}
function floorLabel(sources){const floors=sources.map(s=>s.floor).filter(Number.isInteger);return floors.length?'第 '+[...new Set(floors)].join('、')+' 楼':'无聊天楼层';}
