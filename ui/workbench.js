import {assert,copy,record,uid,AUTHOR_KINDS,recordCounts} from '../core/model.js';
import {loadStyle,clampPosition} from './surface.js';
import {recordText,simplifyRecord,protectSelection} from './editor.js';
import {PROMPTS,validatePrompts} from '../core/prompt-templates.js';
import {outlineState,chooseOutline,stripControl} from '../core/outline.js';

// All imported/model/user text is rendered as text, never markup.
const el=(tag,text='',className='')=>{const n=document.createElement(tag);n.textContent=text;if(className)n.className=className;return n;};
const field=(label,input)=>{const n=el('label','', 'bbp-field');input.setAttribute('aria-label',label);n.append(el('span',label),input);return n;};
const input=(value='',type='text')=>{const n=el('input');n.type=type;n.value=value;return n;};
const area=(value='')=>{const n=el('textarea');n.value=value;n.rows=4;return n;};
const select=(items,value)=>{const n=el('select');for(const [id,label] of items){const o=el('option',label);o.value=id;n.append(o);}n.value=value??items[0]?.[0]??'';return n;};
const check=(value=false)=>{const n=input('','checkbox');n.checked=value;return n;};
const kinds=[['core','故事核心'],['line','故事线'],['chapter','当前章节'],['clue','伏笔 / 支线'],['guide','写作建议'],['world','历史世界参考'],['focus','历史叙事关注'],['experience','历史作者经验']];
const truths=[['plan','构思 / 待验证'],['intent','行动意图'],['event','已发生'],['guidance','写作指导']];
const when=n=>new Date(n).toLocaleString();
const body=r=>r?recordText(r):'（不存在）';
const pages=[['overview','概览'],['archives','存档'],['setup','初始化'],['records','大纲条目'],['authors','个性化作者'],['feedback','划线评'],['review','任务队列'],['injection','注入预览'],['prompts','提示词'],['settings','设置'],['versions','版本恢复']];
const groups=[['overview','概览',['overview']],['archives','存档',['archives']],['story','故事',['setup','records']],['author','作者',['authors','feedback']],['tasks','任务',['review']],['tools','工具',['settings','prompts','injection','versions']]];
const UI_KEY='bbpresets_ui_v1'; // Device layout and selection preferences only: no story text or credentials.
const jobLabel=(app,job)=>{const name=job.kind==='outline'&&job.feedback?.some(f=>f.category==='plot')?'剧情点评改纲':({initialization:'建纲',outline:'改纲',feedback:'写作点评总结'}[job.kind]??'历史任务');return name+' · '+(app.taskSettings(job.kind,job).connection==='main'?'主 API':'副 API');};
export function download(value,name='BBPresets-export.json'){
    const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
    const a=el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export class Workbench {
    constructor(app){
        this.app=app;this.tab='overview';this.revealed=false;this.selection=null;this.selectedFeedback=new Set();this.storyId=null;this.editor=null;this.expandedRecords=new Set();this.recordDrafts=new Map();this.promptDrafts={};this.feedbackDrafts=new Map();
        this.ui={showBall:true,feedbackOpen:true,polarity:'positive',intent:'save',category:'writing'};try{const saved=JSON.parse(localStorage.getItem(UI_KEY));if(saved){this.ui.showBall=saved.showBall!==false;this.ui.feedbackOpen=saved.feedbackOpen!==false;for(const [key,allowed] of Object.entries({polarity:['positive','negative','neutral'],intent:['save','batch','send'],category:['writing','plot']}))if(allowed.includes(saved[key]))this.ui[key]=saved[key];if(Number.isFinite(saved.left)&&Number.isFinite(saved.top)){this.ui.left=saved.left;this.ui.top=saved.top;}}}catch{/* Storage restrictions must not prevent opening the workspace. */}
        this.surface=el('div');this.surface.id='bbpresets-surface';
        // A zero-size host never intercepts the chat. Only the panel and ball receive pointers.
        this.surface.style.cssText='position:fixed;inset:0 auto auto 0;width:0;height:0;z-index:100001;pointer-events:none;visibility:hidden';
        this.shadow=this.surface.attachShadow({mode:'open'});document.body.append(this.surface);
        loadStyle(this.shadow).ready.then(()=>{if(!this.destroyed){this.surface.style.visibility='visible';this.onResize();}}).catch(e=>this.app.report(e));
        this.dialog=el('section','','bbp-dialog bbp-embedded');this.dialog.id='bbpresets-workbench';this.dialog.setAttribute('aria-label','BBPresets 扩展工作台');
        const header=el('header');header.append(el('strong','个性化作者 · 多线大纲'));
        this.waitPanel=el('div','','bbp-card');this.waitLabel=el('p');this.waitPanel.append(this.waitLabel,this.button('沿用旧大纲继续',()=>app.continueOldOutline()),this.button('查看修订任务',()=>this.open('review')));this.waitPanel.hidden=true;
        this.status=el('div','','bbp-status');this.status.setAttribute('role','status');
        this.statusMain=el('div','','bbp-status-main');const statusDetails=el('details','','bbp-status-details');this.statusMore=el('div');statusDetails.append(el('summary','运行详情'),this.statusMore);this.recent=el('details','','bbp-recent');this.recentSummary=el('summary','最近状况');this.recentBody=el('div');this.recent.append(this.recentSummary,this.recentBody);this.status.append(this.statusMain,this.recent,statusDetails);
        this.message=el('div','','bbp-message');this.message.setAttribute('role','status');
        this.groupTabs={};this.groupNav=el('nav','','bbp-groups');this.groupNav.setAttribute('aria-label','功能分类');
        for(const [id,label,tabs] of groups){const b=this.button(label,()=>this.open(this.groupTabs[id]??tabs[0]));b.dataset.group=id;this.groupNav.append(b);}
        this.nav=el('nav','','bbp-subnav');this.nav.setAttribute('aria-label','分类内页面');
        for(const [id,label] of pages){
            const b=this.button(label,()=>this.open(id));b.dataset.tab=id;this.nav.append(b);
        }
        this.content=el('main');this.dialog.append(header,this.status,this.message,this.waitPanel,this.groupNav,this.nav,this.content);
        this.pageCache=new Map();
        this.onChange=()=>{const id=(this.app.story?.data.id??'')+':'+this.app.host.identity().chatKey+':'+(this.app.author?.data.id??''),loaded=!this.hadProfile&&this.app.profile,draftLoaded=this.app.ready&&this.draftLoadVersion!==this.app.draftLoadVersion;if(this.app.ready)this.draftLoadVersion=this.app.draftLoadVersion;this.hadProfile=Boolean(this.app.profile);let switched=false;if(id!==this.storyId){this.storyId=id;this.revealed=false;if(this.editor)this.recordDrafts.set(this.editor.target+':'+this.editor.draft.id,this.editor);this.editor=null;this.pageCache.clear();this.selectedFeedback.clear();switched=true;}if(switched||loaded)this.quickActions();if(switched||loaded||((draftLoaded||this.waitingForStory&&this.app.ready)&&this.tab==='setup'))this.render();this.updateStatus();};
        app.listeners.add(this.onChange);
        this.onSelection=()=>{const s=globalThis.getSelection?.();if(!s||s.isCollapsed||!s.rangeCount)return;const range=s.getRangeAt(0),node=range.commonAncestorContainer;const parent=node.nodeType===1?node:node.parentElement;const message=parent?.closest('.mes');if(!message||!parent.closest('.mes_text'))return;const floor=Number(message.getAttribute('mesid')),m=app.host.ctx().chat?.[floor];if(m&&!m.is_user)this.selection={quote:s.toString(),raw:m.mes,floor,chatKey:app.host.identity().chatKey};};
        document.addEventListener('pointerup',this.onSelection);
        this.entry=el('div','','bbp-entry inline-drawer');this.entry.id='bbpresets-entry';
        const summary=el('div','','inline-drawer-toggle inline-drawer-header bbp-entry-toggle');summary.setAttribute('role','button');summary.tabIndex=0;this.summary=summary;
        summary.append(el('b','BBPresets v0.5.5'),el('div','','inline-drawer-icon fa-solid fa-circle-chevron-down down'));
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
        this.quickRecent=el('details','','bbp-recent');this.quickRecentSummary=el('summary','最近状况');this.quickRecentBody=el('div');this.quickRecent.append(this.quickRecentSummary,this.quickRecentBody);this.quickRecent.addEventListener('toggle',()=>this.layout());
        this.quick.append(quickHeader,this.quickMessage,this.quickContent);this.shadow.append(this.quick);this.quickActions();
        this.ball=el('button','✦','bbp-ball');this.ball.type='button';this.ball.setAttribute('aria-label','打开 BBPresets 快捷操作');this.ball.setAttribute('aria-controls',this.quick.id);this.ball.setAttribute('aria-expanded','false');this.ball.title='BBPresets · 点击展开，可拖动';
        const toggle=()=>{if(this.quick.hidden)this.quickActions();this.quick.hidden=!this.quick.hidden;this.ball.setAttribute('aria-expanded',String(!this.quick.hidden));this.layout();};
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
        const a=this.app,c=this.quickContent;c.replaceChildren();
        const section=el('details','','bbp-quick-feedback');section.open=this.ui.feedbackOpen;section.append(el('summary','划线评'));
        if(a.author)section.append(this.feedbackComposer(true));else section.append(el('p','正在读取作者资料…'));
        section.addEventListener('toggle',()=>{if(!section.isConnected)return;this.ui.feedbackOpen=section.open;this.saveUI();this.layout();});
        c.append(section,this.button('快速保存',()=>a.saveCurrent()),this.button('查看大纲',()=>{this.open('records');this.close();}),this.quickStatus,this.quickRecent);
    }
    feedbackComposer(quick=false){
        const a=this.app,key=a.author.data.id+':'+(a.story?.data.id??'')+':'+a.host.identity().chatKey;
        if(!this.feedbackDrafts.has(key))this.feedbackDrafts.set(key,{quote:'',note:'',source:null});
        const draft=this.feedbackDrafts.get(key),box=el('div','','bbp-feedback-composer');
        const quote=area(draft.quote),note=area(draft.note),polarity=select([['positive','喜欢'],['negative','不喜欢'],['neutral','中性 / 收藏']],this.ui.polarity);
        const category=select([['writing','写作 · 行文 / 用词'],['plot','剧情 · 情节 / 大纲']],this.ui.category),connection=select([['main','主 API'],['custom','副 API']],a.feedbackConnection(this.ui.category));
        quote.rows=quick?2:5;note.rows=quick?2:4;
        quote.placeholder='粘贴原文，或用按钮载入选段';note.placeholder='写下你的评价与修改建议';
        quote.addEventListener('input',()=>{draft.quote=quote.value;});quote.addEventListener('paste',()=>{draft.source=null;});note.addEventListener('input',()=>{draft.note=note.value;});
        polarity.addEventListener('change',()=>{this.ui.polarity=polarity.value;this.saveUI();});
        const destination=el('p','','bbp-hint'),showDestination=()=>{destination.textContent=category.value==='plot'?'保存到故事：'+(a.story?.data.title??'请先绑定大纲'):'保存到作者：'+a.author.data.title;};showDestination();
        category.addEventListener('change',()=>{this.ui.category=category.value;connection.value=a.feedbackConnection(category.value);showDestination();this.saveUI();});
        const use=async selected=>{const selection=selected?this.selection:null;assert(!selected||selection,'请先在聊天正文中划选，或直接粘贴原文');const c=await a.host.capture();assert(!selection||selection.chatKey===c.chatKey,'选段来自其他聊天，请重新选择');const row=selection?c.rows.find(r=>r.floor===selection.floor):c.rows.findLast(r=>r.role==='assistant');assert(row,'没有可载入的回复');assert(!selection||selection.raw===row.text,'选段所在回复已变化，请重新划选');quote.value=selection?.quote??stripControl(row.text);draft.quote=quote.value;draft.source=c.sources.find(s=>s.id===row.id);return '原文已载入，请在点评框填写意见';};
        const tools=el('div','','bbp-actions bbp-small-actions');tools.append(this.button('载入选中段落',()=>use(true)),this.button('载入最新回复',()=>use(false)),this.button('手动粘贴原文',()=>{quote.focus();return '请在原文框粘贴，点评写在下方';}));
        const options=el('div','','bbp-feedback-options');options.append(field('分类',category),field('态度',polarity),field('处理 API',connection));
        box.append(tools,field('原文（可粘贴）',quote),options,destination,field('点评',note));
        const save=async mode=>{
            assert(a.author.data.id+':'+(a.story?.data.id??'')+':'+a.host.identity().chatKey===key,'作者、故事或聊天已切换，请重新提交');
            const target=category.value==='plot'?a.story?.data.id:a.author.data.id;
            const id=await a.addFeedback({quote:quote.value,note:note.value,polarity:polarity.value,category:category.value,connection:connection.value,source:draft.source,status:mode==='batch'?'queued':'saved'});
            draft.quote='';draft.note='';draft.source=null;quote.value='';note.value='';
            if(mode==='send')await a.sendFeedback([id],target);this.pageCache.delete('feedback');if(!quick)this.render();
            return mode==='save'?(category.value==='plot'?'已保存到当前故事，未发送给 AI':'已保存到当前作者，未发送给 AI'):mode==='batch'?'已加入待发送批次（按分类与 API 分别累计）':'点评已提交，请查看任务队列';
        };
        if(quick){const intent=select([['save','不发送 · 只保存'],['batch','发送 · 积累成批'],['send','发送 · 立即处理']],this.ui.intent);intent.addEventListener('change',()=>{this.ui.intent=intent.value;this.saveUI();});box.append(field('发送方式',intent),this.button('保存收藏 / 点评',()=>save(intent.value)));}
        else box.append(this.button('只保存',()=>save('save')),this.button('加入待发送批次',()=>save('batch')),this.button('立即发送点评',()=>save('send')));
        return box;
    }
    saveUI(){try{localStorage.setItem(UI_KEY,JSON.stringify(this.ui));}catch{this.app.notify('界面已调整，但浏览器禁止保存本设备偏好；刷新后会恢复默认。','warning');}}
    setBallVisible(show){this.ui.showBall=show;this.ball.hidden=!show;if(!show)this.close();this.entryBall.checked=show;this.saveUI();this.layout();}
    resetBall(){delete this.ui.left;delete this.ui.top;this.setBallVisible(true);return '悬浮球已显示并回到默认位置';}
    bounds(){const v=globalThis.visualViewport,left=v?.offsetLeft??0,top=v?.offsetTop??0;return {left:left+8,top:top+8,right:left+(v?.width??innerWidth)-8,bottom:top+(v?.height??innerHeight)-8};}
    placeBall(position){const r=this.ball.getBoundingClientRect(),b=this.bounds(),form=document.querySelector('#send_form')?.getBoundingClientRect();if(form?.height&&form.top>b.top+64&&form.top<b.bottom)b.bottom=form.top-8;const p=clampPosition(position,b,{width:r.width||48,height:r.height||48});this.ball.style.left=p.left+'px';this.ball.style.top=p.top+'px';}
    layout(){
        const b=this.bounds(),form=document.querySelector('#send_form')?.getBoundingClientRect(),topbar=document.querySelector('#top-settings-holder')?.getBoundingClientRect();
        this.dialog.style.setProperty('--bbp-input-clearance',Math.ceil(form?.height??0)+'px');
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
        const activity=a.waitingOutline?a.waitMessage:a.auxiliary?'准备问题 / 测试连接中':a.activeJob?'正在处理 '+jobLabel(a,a.activeJob):a.jobs.some(x=>x.job.state==='queued')?(a.foreground?'正文结束后处理任务':'任务已排队'):!s?'请选择故事以开始':!a.settings?.enabled?'插件已停用':'按需更新，无逐楼层提取';
        const chapter=s?outlineState(s,{chatKey:a.host.identity().chatKey,sources:a.currentSources??[]}).chapter:null;
        const landmarks=`剧情目标：${chapter?'已建立，详见大纲页':'尚未建立'} · 待总结点评 ${a.author?.data.feedback.filter(f=>f.status==='queued').length??0} / ${a.settings?.feedbackThreshold??5}`;
        if(this.waitPanel){this.waitPanel.hidden=!a.waitingOutline;this.waitLabel.textContent=a.waitMessage??'';}

        const draftState=a.draftError?' · '+a.draftError:a.draftEntry()?.dirty?' · 初始化草稿待同步':'';
        const live=a.requestState||(a.host.rawPending&&!a.running&&!a.auxiliary?a.host.mainBusyReason?.():null)||activity;
        if(this.setupRequestStatus?.isConnected){this.setupRequestStatus.textContent=a.requestState||(a.host.rawPending?a.host.mainBusyReason?.():'')||(a.preparing?'正在读取资料、准备提问':a.buildingInitialization?'正在建立大纲':'');this.setupRequestStatus.hidden=!this.setupRequestStatus.textContent;}
        if(this.setupBuild?.isConnected)this.setupBuild.disabled=Boolean(a.preparing||a.auxiliary||a.buildingInitialization||a.running);
        this.statusMain.textContent=`大纲：${s?.title??'未绑定'}\n作者：${a.author?.data.title??'尚未加载'}\n${names[a.status]??a.status} · ${live}${a.error?'\n'+a.error:''}`;
        this.statusMore.textContent=`${landmarks} · 待办 ${a.jobs.length} / 提案 ${a.proposals.length}${draftState}${a.lastInjection.omitted?' · 注入预算省略 '+a.lastInjection.omitted+' 条':''}${a.controlStatus?' · '+a.controlStatus:''}${a.host.controlWarning?' · '+a.host.controlWarning:''}`;
        this.updateArchiveCounts();this.updateControlDetails();
        if(this.quickStatus)this.quickStatus.textContent=`大纲：${s?.title??'未绑定'} · ${s?recordCounts(s).outline:0} 条\n作者：${a.author?.data.title??'尚未加载'} · 写作 ${a.author?recordCounts(a.author.data).writing:0} 条\n${names[a.status]??a.status} · ${live}${a.error?'\n'+a.error:''}`;
        const recent=a.recentStatus;
        for(const [summary,body] of [[this.recentSummary,this.recentBody],[this.quickRecentSummary,this.quickRecentBody]])if(summary&&body){summary.textContent='最近状况 · '+recent[0];body.replaceChildren(...recent.slice(1).map(text=>el('p',text,'bbp-hint')));}

        if(this.entryStatus)this.entryStatus.textContent=activity+(a.error?' · '+a.error:'');
        if(this.entryEnabled){this.entryEnabled.checked=Boolean(a.settings?.enabled);this.entryEnabled.disabled=!a.settings;}
        if(this.ball){this.ball.hidden=!this.ui.showBall;this.ball.dataset.busy=String(Boolean(a.running||a.auxiliary));this.ball.dataset.error=String(Boolean(a.error));this.ball.title='BBPresets · '+activity;}
        if(this.ball&&!this.quick.hidden)this.layout();
    }
    open(tab=this.tab){
        if(tab!==this.tab){if(['settings','prompts'].includes(this.tab))this.pageCache.set(this.tab,[...this.content.childNodes]);this.tab=tab;const cached=this.pageCache.get(tab);if(cached)this.content.replaceChildren(...cached);else this.render();}
        else if(!this.content.children.length)this.render();
        this.setExpanded(true);this.updateNavigation();this.updateStatus();
    }
    updateNavigation(){
        const [id,,tabs]=groups.find(g=>g[2].includes(this.tab));this.groupTabs[id]=this.tab;
        for(const b of this.groupNav.children)b.setAttribute('aria-current',String(b.dataset.group===id));
        this.nav.hidden=tabs.length===1;
        for(const b of this.nav.children){b.hidden=!tabs.includes(b.dataset.tab);b.setAttribute('aria-current',String(b.dataset.tab===this.tab));}
    }
    close(){this.quick.hidden=true;this.ball.setAttribute('aria-expanded','false');}
    render(){
        this.pageCache.delete(this.tab);
        this.content.replaceChildren();this.updateStatus();this.updateNavigation();
        const fn={overview:'overview',archives:'archives',setup:'setup',records:'records',authors:'authors',feedback:'feedback',review:'review',settings:'settings',versions:'versions',prompts:'prompts',injection:'injectionPreview'}[this.tab];
        if(!this.app.profile&&this.tab!=='versions'){this.content.append(el('p','正在连接酒馆资料存储；失败时可到“工具 → 版本恢复”重新读取。'),this.button('打开版本恢复',()=>this.open('versions')));return;}
        if(!['overview','archives','authors','feedback','review','injection','settings','versions','prompts'].includes(this.tab)&&!this.app.story){this.content.append(el('h2','先选择故事大纲'),el('p','作者可跨聊天沿用；初始化和大纲条目需要当前聊天绑定一个故事。'),this.button('去存档新建或加载大纲',()=>this.open('archives')));return;}
        this[fn]();
    }
    section(title,hint=''){const card=el('section','','bbp-card');card.append(el('h3',title));if(hint)card.append(el('p',hint,'bbp-hint'));return card;}
    authorGate(){if(this.revealed)return true;this.content.append(el('p','此页包含世界幕后、行动意图和作者构思，可能透露剧情。'),this.button('查看剧情资料',()=>{this.revealed=true;this.render();}));return false;}
    archiveImport(container=this.content){
        const file=input('','file');file.accept='.json,application/json';container.append(field('导入存档文件',file),this.button('导入为独立副本',async()=>{const f=file.files[0];assert(f&&f.size<12000000,'请选择小于 12 MB 的 BBPresets 存档');await this.app.importArchive(JSON.parse(await f.text()));this.render();return '已导入独立副本，可在大纲或作者列表中选择';}));
    }
    overview(){
        const a=this.app,s=a.story?.data;this.content.append(el('h2','概览'));
        const card=el('section','','bbp-card');card.append(el('h3','无剧透概览'),el('p',s?'故事：'+s.title:'尚未绑定故事大纲'),el('p','当前作者：'+a.author.data.title));
        if(s)card.append(el('p','故事线 '+s.records.filter(r=>r.kind==='line').length+' · 章节与伏笔 '+s.records.filter(r=>['chapter','clue'].includes(r.kind)).length+' · 冲突 '+s.conflicts.length));
        card.append(el('p','作者偏好 '+a.author.data.records.filter(r=>r.kind==='guide').length+' 条；作者随账户沿用，切换大纲不会更换作者。','bbp-hint'));
        const next=el('div','','bbp-actions');if(s)next.append(this.button(s.records.some(r=>r.kind==='core')?'管理故事大纲':'开始初始化',()=>this.open(s.records.some(r=>r.kind==='core')?'records':'setup')));next.append(this.button('选择 / 管理存档',()=>this.open('archives')),this.button('管理个性化作者',()=>this.open('authors')),this.button(`查看任务（${a.jobs.length+a.proposals.length}）`,()=>this.open('review')));card.append(next);this.content.append(card);
    }
    archives(){
        const a=this.app,s=a.story?.data;this.content.append(el('h2','存档'),el('p','选择一个故事存档加载到当前聊天。资料持续自动保存，加载不会更换作者；换设备前请等待“已保存到酒馆服务器”。','bbp-hint'));
        const current=this.section('当前故事存档',s?s.title:'尚未绑定');
        if(s){
            current.append(el('p',s.manualSavedAt?'上次手动保存：'+when(s.manualSavedAt):'已启用自动保存'),this.button('保存存档',async()=>{const result=await a.saveCurrent();this.render();return result;}),this.button('导出当前大纲',async()=>download(await a.exportScope(s.id),'BBPresets-outline.json')));
            const rename=el('details'),name=input(s.title);name.maxLength=300;rename.append(el('summary','修改当前存档名称'),field('当前存档名称',name),this.button('保存存档名称',async()=>{assert(a.story?.data.id===s.id,'当前存档已变化，请重新打开存档页');assert(name.value.trim(),'请填写存档名称');await a.edit(s.id,d=>{d.title=name.value.trim();return d;});this.render();return '存档名称已保存';}));current.append(rename);
        }
        current.append(this.button('从服务器加载',async()=>{await a.refresh();this.render();return '已加载服务器上的大纲与作者资料';}));this.content.append(current);
        if(a.settings.memoryFollow)this.content.append(el('p','当前正在跟随 BB-Memory 的已确认存档。手动换档或新建前，请到设置关闭存档跟随。','bbp-hint'),this.button('打开联动设置',()=>this.open('settings')));
        const search=input(this.archiveQuery??'');search.placeholder='名称或存档 ID';search.addEventListener('input',()=>{this.archiveQuery=search.value;this.updateArchiveCounts();});this.content.append(field('搜索存档',search));
        this.archiveList=el('div','','bbp-archive-counts');this.content.append(this.archiveList);this.updateArchiveCounts();
        const create=this.section('新建 / 分支'),title=input('');title.maxLength=300;title.placeholder='例如：江南 · 初访';
        const add=this.button('新建空白故事',async()=>{await a.createStory(title.value);this.render();return '已新建并加载空白故事';});add.disabled=a.settings.memoryFollow;create.append(field('新存档名称',title),add);
        const source=a.branchCandidate?.storyId??s?.id;if(source){const fork=this.button(a.branchCandidate?'从原聊天复制 if 分支':'从当前档建立独立分支',async()=>{await a.createStory(title.value,{from:source});this.render();return '已建立并加载独立分支';});fork.disabled=a.settings.memoryFollow;create.append(fork);}this.content.append(create);
        const imports=el('details');imports.append(el('summary','导入大纲 / 作者存档'));this.archiveImport(imports);this.content.append(imports);
    }
    updateArchiveCounts(){
        if(!this.archiveList?.isConnected)return;
        const a=this.app;this.countCache??=new Map();this.countLoads??=new Set();
        const rows=[],query=(this.archiveQuery??'').trim().toLocaleLowerCase();
        const entries=Object.entries(a.repo.index?.documents??{}).sort(([id,x],[other,y])=>Number(other===a.story?.data.id)-Number(id===a.story?.data.id)||(y.at??0)-(x.at??0));
        for(const [id,entry] of entries){
            if(query&&![entry.title,id].some(v=>v.toLocaleLowerCase().includes(query)))continue;
            const key=id+':'+entry.revision,loaded=a.documentFor(id)?.data,counts=loaded?recordCounts(loaded):entry.counts??this.countCache.get(key);
            const isStory=entry.type==='story',current=id===(isStory?a.story?.data.id:a.author.data.id),card=this.section(entry.title);
            card.dataset.archiveId=id;card.append(el('p',`${current?'当前使用 · ':''}${isStory?'故事大纲':'作者档案'} · ${counts?`大纲 ${counts.outline} · 作者写作 ${counts.writing} · 历史参考 ${counts.reference} · 合计 ${counts.total}（已归档 ${counts.archived}）`:'正在读取条目数…'}`),el('p',`ID：${id} · 服务器保存：${when(entry.at)} · 版本 ${entry.revision}`,'bbp-hint'));
            const load=this.button(current?'当前使用':isStory?'加载到当前聊天':'使用此作者',async()=>{if(isStory)await a.selectStory(id);else await a.selectAuthor(id);this.render();return isStory?'已加载故事并绑定当前聊天':'已切换作者档案';});load.disabled=current||isStory&&a.settings.memoryFollow;card.append(load);rows.push(card);
            if(!counts&&!this.countLoads.has(key)){
                this.countLoads.add(key);
                void a.repo.loadVersion(id,entry).then(w=>{this.countCache.set(key,recordCounts(w.data));this.updateArchiveCounts();}).catch(()=>{if(this.archiveList?.isConnected)this.archiveList.append(el('p',entry.title+'：读取条目数失败，请从服务器加载后重试'));});
            }
        }
        this.archiveList.replaceChildren(...(rows.length?rows:[el('p','没有匹配的存档')]));
    }
    setup(){
        const a=this.app;if(!a.ready){this.waitingForStory=true;this.content.append(el('p','正在读取当前故事，请稍后。'));return;}this.waitingForStory=false;const d=a.ensureDraft();this.content.append(el('h2','为这个世界准备一个起点'),el('p','主 API 读取记忆、上下文与世界书后提出简短问题，再根据你的回答生成大纲。可以长答、跳过或补充想法。'));
        const steps=el('ol','','bbp-steps'),phase=a.story.data.records.some(r=>r.kind==='core')||a.story.data.jobs.some(j=>j.kind==='initialization')||a.story.data.proposals.some(j=>j.kind==='initialization')?2:d.questions.length?1:0;
        ['1 读取资料','2 回答问题','3 生成大纲'].forEach((text,index)=>{const step=el('li',text);if(index===phase)step.setAttribute('aria-current','step');steps.append(step);});this.content.append(steps);
        this.content.append(el('p','提问与建纲使用酒馆主 API。响应较慢时会继续等原请求；不要反复重试。','bbp-hint'),this.button('查看连接设置',()=>this.open('settings')));
        this.setupRequestStatus=el('p','','bbp-request-status');this.setupRequestStatus.setAttribute('role','status');this.content.append(this.setupRequestStatus);
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
        this.content.append(this.button('保存问答草稿',async()=>{await a.flushDraft();return '问答草稿已保存到酒馆服务器';}),this.button('导出问答草稿',()=>download(a.initialization,'BBPresets-initialization-draft.json')),this.setupBuild=this.button('建立初始资料',async()=>{await a.completeInitialization();this.tab='review';this.render();return a.story.data.jobs.some(j=>j.kind==='initialization'&&j.state==='failed')?'初始化未完成，请查看失败原因并重试':a.story.data.proposals.some(p=>p.kind==='initialization')?'初始资料已生成，请到提案中查看并应用':'初始资料已建立';}));
        const info=a.host.seedInfo;if(info)this.content.append(el('p',`已参考：${info.sections.join('、')}。${info.omitted?`有 ${info.omitted} 份资料按预算节选。`:''}${info.notes.join('；')}`,'bbp-hint'));
        this.content.append(el('p','草稿会自动保存，收起侧栏不会清空。示例不会当作你的偏好；半自动模式下初始资料先生成提案。','bbp-hint'));this.updateStatus();
    }
    records(){
        if(!this.authorGate())return;this.controlDetails=el('div','','bbp-card');this.content.append(this.controlDetails);this.updateControlDetails();this.content.append(el('h2','大纲条目'),el('p','大纲随聊天保存。故事核心、故事线、章节与伏笔在这里维护。'));
        this.content.append(this.outlineRequest());this.recordList(this.app.story.data,false);
    }
    updateControlDetails(){
        if(!this.controlDetails?.isConnected||!this.app.story)return;
        const a=this.app,state=chooseOutline(a.story.data,{chatKey:a.host.identity().chatKey,sources:a.currentSources??[]},a.settings).state;
        const names=state.nextIds.map(id=>a.story.data.records.find(r=>r.id===id)?.title||id);
        this.controlDetails.replaceChildren(el('h3','正文大纲维护'),el('p','当前剧情目标（progress）：'+(state.chapter?.progress||'尚未建立；下一轮从当前场景建立')),el('p','目标可跨多轮延续，表示后续发展方向。','bbp-hint'),el('p',a.settings.outlineInjection==='full'?'下轮调用：完整注入（仍受字符预算限制）':'下轮调用：'+(names.slice(0,a.settings.outlineMaxEntries??3).join('、')||'无；仅沿用目标与简短目录，不注入大纲全文')),el('p',a.controlStatus||'控制块默认隐藏在正文显示之外；发送一轮 RP 后可在这里查看接收结果。','bbp-hint'));
    }
    authors(){
        const a=this.app,doc=a.author.data;this.content.append(el('h2','个性化作者'),el('p','写作偏好保存在作者档案中。同一账户跨聊天沿用当前选择，也可切换为另一位作者。'));
        const choices=[['profile','默认作者 · '+a.profile.data.title],...Object.entries(a.repo.index.documents).filter(([,d])=>d.type==='author').map(([id,d])=>[id,d.title])],picker=select(choices,doc.id);
        this.content.append(field('当前个性化作者',picker),this.button('切换作者',async()=>{await a.selectAuthor(picker.value);this.render();return '作者已切换，大纲绑定保持不变';}));
        const name=input(doc.title);this.content.append(field('作者名称',name),this.button('保存作者名称',async()=>{assert(name.value.trim(),'请填写作者名称');await a.edit(doc.id,d=>{d.title=name.value.trim();return d;});this.render();return '作者名称已保存';}),this.button('导出当前作者',async()=>download(await a.exportScope(doc.id),'BBPresets-author.json')));
        const manage=el('details'),title=input('');manage.append(el('summary','新建 / 复制 / 导入作者'),field('新作者名称',title),this.button('新建作者',async()=>{await a.createAuthor(title.value);this.render();}),this.button('复制当前作者',async()=>{await a.createAuthor(title.value,{from:doc.id});this.render();}));this.archiveImport(manage);this.content.append(manage);
        const legacy=a.story?.data;if(legacy&&(legacy.records.some(r=>AUTHOR_KINDS.includes(r.kind))||legacy.feedback.some(f=>f.category!=='plot'))){const info=el('details');info.append(el('summary','旧故事中的写作偏好与点评（保留）'),el('p','这些旧资料尚未并入当前作者，不会覆盖你的作者选择。复制后会选用新作者，原故事资料保留。'),this.button('复制旧故事偏好为作者',async()=>{await a.createAuthor(legacy.title+' · 作者',{from:legacy.id});this.render();}));for(const r of legacy.records.filter(r=>AUTHOR_KINDS.includes(r.kind)))info.append(el('h4',r.title),el('p',body(r),'bbp-prose'));this.content.append(info);}
        this.recordList(doc,true);
    }
    recordList(doc,author){
        if(this.editor&&this.editor.target===doc.id){this.recordEditor();return;}
        const records=doc.records.filter(r=>AUTHOR_KINDS.includes(r.kind)===author);
        this.content.append(this.button('新增条目',()=>{this.editor={target:doc.id,draft:record({kind:author?'guide':'line'}),expected:null};this.render();}));
        const search=input(this.recordFilters?.[doc.id]?.search??'','search');search.placeholder='搜索标题、关键词和正文';const type=select([['','全部类别'],...kinds.filter(([k])=>AUTHOR_KINDS.includes(k)===author)],this.recordFilters?.[doc.id]?.kind??''),count=el('p','','bbp-hint'),list=el('div');
        this.content.append(field('搜索条目',search),field('类别筛选',type));
        const draw=()=>{
            const query=search.value.trim().toLocaleLowerCase();this.recordFilters??={};this.recordFilters[doc.id]={search:search.value,kind:type.value};
            const rows=records.filter(r=>(!type.value||r.kind===type.value)&&(!query||[r.title,r.summary??'',...(r.keywords??[]),body(r)].join('\n').toLocaleLowerCase().includes(query)));
            count.textContent=`找到 ${rows.length} / ${records.length} 条（包含折叠正文）`;list.replaceChildren();
            for(const r of rows){
                const key=doc.id+':'+r.id,card=el('details','','bbp-card bbp-record');card.open=Boolean(query)||this.expandedRecords.has(key);
                card.addEventListener('toggle',()=>{if(!search.value.trim())card.open?this.expandedRecords.add(key):this.expandedRecords.delete(key);});
                card.append(el('summary',`${r.title||'未命名条目'} · ${kinds.find(x=>x[0]===r.kind)?.[1]} · ${r.locked?'整条保护':r.blocks.some(b=>b.locked)?'局部保护':'可编辑'}${r.status==='archived'?' · 已归档':''}`));
                if(query){const text=body(r),index=text.toLocaleLowerCase().indexOf(query);card.append(el('p',index>=0?'…'+text.slice(Math.max(0,index-30),index+query.length+80)+'…':'标题或关键词命中','bbp-hint'));}
                card.append(el('p',body(r),'bbp-prose'),el('small',`ID：${r.id} · 关键词：${(r.keywords??[]).join('、')} · 来源：${r.origin}${doc.excluded.includes(r.id)?' · 来源冲突，暂停注入':''}`),this.button('编辑 / 设置保留',()=>{this.editor=this.recordDrafts.get(key)??{target:doc.id,draft:copy(r),expected:copy(r)};this.render();}));
                list.append(card);
            }
        };
        search.addEventListener('input',draw);type.addEventListener('change',draw);
        this.content.append(this.button('全部展开',()=>{for(const r of records)this.expandedRecords.add(doc.id+':'+r.id);draw();}),this.button('全部收起',()=>{for(const r of records)this.expandedRecords.delete(doc.id+':'+r.id);search.value='';draw();}),count,list);draw();
    }
    recordEditor(){
        const e=this.editor,r=simplifyRecord(e.draft);this.content.append(el('h2',e.expected?'编辑条目':'新增条目'));
        const allowedKinds=kinds.filter(([k])=>this.app.documentFor(e.target)?.data.type==='story'?!AUTHOR_KINDS.includes(k):AUTHOR_KINDS.includes(k));
        const title=input(r.title),kind=select(allowedKinds,r.kind),truth=select(truths,r.truth),importance=select([['minor','普通更新'],['major','重要改变']],r.importance),status=select([['active','使用中'],['archived','归档，不注入']],r.status),locked=check(r.locked);
        for(const [key,node] of Object.entries({title,kind,truth,importance,status,locked}))node.addEventListener(node.type==='text'?'input':'change',()=>{r[key]=node.type==='checkbox'?node.checked:node.value;});
        title.maxLength=300;this.content.append(field('标题',title),field('保护整个条目（AI 不得编辑）',locked));
        const keywords=input((r.keywords??[]).join('，')),summary=area(r.summary??''),links=input((r.links??[]).join('，'));
        keywords.addEventListener('input',()=>{r.keywords=keywords.value.split(/[,，\n]/).map(s=>s.trim()).filter(Boolean);});summary.addEventListener('input',()=>{r.summary=summary.value;});links.addEventListener('input',()=>{r.links=links.value.split(/[,，\n]/).map(s=>s.trim()).filter(Boolean);});
        this.content.append(field('关键词（逗号分隔）',keywords),field('目录摘要',summary),field('关联条目 ID（逗号分隔）',links));
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
        this.content.append(this.button('保存条目',async()=>{await this.app.saveRecord(e.target,r,e.expected);this.recordDrafts.delete(e.target+':'+r.id);this.editor=null;this.render();return '条目已保存';}),this.button('返回列表',()=>{this.recordDrafts.set(e.target+':'+r.id,e);this.editor=null;this.render();}),el('p','返回列表保留本次编辑草稿；重新打开同一条目可继续。整条保护优先，AI 不能改写保护内容。','bbp-hint'));
    }
    feedback(){
        const a=this.app;this.content.append(el('h2','划线评'),el('p','剧情随故事保存，写作随作者保存。待发送点评按分类与 API 分组，满 '+a.settings.feedbackThreshold+' 条自动处理；只保存不计数，全手动模式需手动发送。'),this.feedbackComposer());
        const scopes=a.scopes,labels={saved:'只保存',queued:'待处理',processed:'已处理',withdrawn:'已撤回'};
        const submit=async all=>{const epoch=a.epoch;for(const scope of scopes){assert(epoch===a.epoch,'资料已切换，请重新选择点评');const ids=all?a.feedbackGroups(scope.data).flatMap(g=>g.items.map(f=>f.id)):scope.data.feedback.filter(f=>this.selectedFeedback.has(scope.data.id+':'+f.id)).map(f=>f.id);if(ids.length)await a.sendFeedback(ids,scope.data.id);}this.selectedFeedback.clear();this.render();};
        this.content.append(this.button('发送勾选的点评',()=>submit(false)),this.button('发送所有待发送批次',()=>submit(true)));
        for(const scope of scopes){const doc=scope.data,list=doc.feedback.filter(f=>doc.type!=='story'||f.category==='plot');this.content.append(el('h3',(doc.type==='story'?'剧情 · ':'写作 · ')+doc.title));
            for(const f of [...list].reverse()){const card=el('section','','bbp-card'),key=doc.id+':'+f.id,pick=check(this.selectedFeedback.has(key));pick.disabled=['processed','withdrawn'].includes(f.status);pick.addEventListener('change',()=>pick.checked?this.selectedFeedback.add(key):this.selectedFeedback.delete(key));card.append(field(labels[f.status]+' · '+when(f.at)+' · '+((f.connection??a.feedbackConnection(f.category))==='main'?'主 API':'副 API'),pick),el('blockquote',f.quote),el('p',f.note));if(f.status!=='withdrawn')card.append(this.button('撤回此点评',async()=>{await a.withdrawFeedback(f.id,doc.id);this.render();}));this.content.append(card);}
        }
    }
    outlineRequest(){
        const note=area(),request=el('details','','bbp-card');request.append(el('summary','主动调整故事线'),field('主动调整故事线的要求',note),this.button('请求主模型修订大纲',async()=>{const result=await this.app.manual('outline',note.value);this.open('review');return result;}));return request;
    }
    review(){
        const a=this.app,label=job=>jobLabel(a,job);
        this.content.append(el('h2','任务队列'),el('p','先查看待办与失败原因，再审阅结果；已完成的变更收在历史记录中。','bbp-hint'),this.button('刷新本页状态',()=>this.render()));
        if(a.jobs.length)this.content.append(this.button('重试失败维护 / 继续队列',async()=>{const result=await a.retryJobs();this.render();return result;}));
        if(a.running||a.auxiliary)this.content.append(this.button('停止等待当前请求',()=>a.cancelRequests()));
        this.content.append(el('h3','进行中与待处理'));
        if(!a.jobs.length)this.content.append(el('p','当前没有排队或失败任务。','bbp-hint'));
        for(const {job:j,target} of a.jobs){const d=a.documentFor(target).data,card=this.section(label(j),(d.type==='story'?'大纲：':'作者：')+d.title);
            card.append(el('p',floorLabel(j.sources)+' · '+(j.state==='failed'?'失败':j.state==='held'?'等待手动运行':a.activeJob?.id===j.id?'处理中':'排队')+' · 尝试 '+j.attempts+' 次'+(j.error?' · '+j.error:'')),this.button('重试此任务',async()=>{const result=await a.retryJobs(j.id,target);this.render();return result;}));
            const raw=el('pre');raw.hidden=true;card.append(this.button('查看本设备模型响应（含剧透）',async()=>{const result=await a.diagnostic(j.id,target);raw.textContent=result?.text??'本设备没有响应记录（请求可能尚未返回，或来自其他设备）';raw.hidden=false;}),raw);this.content.append(card);
        }
        this.content.append(el('h3','待审阅结果'),el('p','待审阅 '+a.proposals.length+' 项'));
        if(!a.proposals.length)this.content.append(el('p','新结果需要确认时会显示在这里。','bbp-hint'));
        if(!a.scopes.some(w=>w.data.proposals.length||w.data.history.length||w.data.conflicts.length))return;
        if(!this.authorGate())return;
        for(const {job:p,target} of a.proposals){const d=a.documentFor(target).data,card=this.section(label(p)+' · '+when(p.at),(d.type==='story'?'大纲：':'作者：')+d.title);
            for(const c of p.changes){const before=d.records.find(r=>r.id===(c.id??c.record?.id));card.append(el('h4',c.record?.title??before?.title??c.id),el('pre','当前：\n'+body(before)),el('pre','建议：\n'+body(c.op==='put'?c.record:null)));}
            card.append(this.button('应用此提案',async()=>{await a.reviewProposal(p.id,true,target);this.render();}),this.button('拒绝此提案',async()=>{await a.reviewProposal(p.id,false,target);this.render();}));this.content.append(card);
        }
        for(const scope of a.scopes){const d=scope.data;
            if(d.conflicts.length){const conflicts=this.section('需要检查 · '+d.title);for(const c of d.conflicts)conflicts.append(el('p','冲突：'+c.reason+' · '+(c.recordId??c.feedbackId??'')+'。请检查对应条目；保护文字未改动。'));this.content.append(conflicts);}
            if(!d.history.length&&!d.retiredTasks?.length)continue;
            const history=el('details','','bbp-card');history.append(el('summary','变更历史 · '+d.title+'（'+d.history.length+' 次）'));
            if(d.retiredTasks?.length)history.append(el('p',d.retiredTasks.length+' 个旧版任务已停用，记录随存档保留。','bbp-hint'));
            for(const h of [...d.history].reverse().slice(0,30)){const details=el('details');details.append(el('summary',when(h.at)+' · '+h.origin+' · '+h.changes.length+' 个变更'));for(const c of h.changes)details.append(el('pre',(c.after?.title??c.before?.title??c.id)+'\n之前：'+body(c.before)+'\n之后：'+body(c.after)));history.append(details);}this.content.append(history);
        }
    }
    settings(){
        const a=this.app,s=copy(a.settings),fields={};this.content.append(el('h2','设置'),el('p','连接、生成规则与资料联动统一在这里设置；保存后生效。','bbp-hint'));
        const main=this.section('主 API · 初始化与大纲','提问、补问、建纲和常规改纲沿用酒馆当前主连接；剧情点评可单独选择 API，不需要在本插件重复填写地址或 Key。');
        main.append(this.button('测试主 API',()=>a.testConnection({...a.settings,connection:'main'})),el('p','测试只发送简短连接请求。主 API 达到等待时长后提示“响应较慢”，继续接收原结果；停止等待会保留输入，不强行中断酒馆请求。','bbp-hint'));this.content.append(main);
        const connection=this.section('点评处理连接','剧情默认主 API，写作默认副 API；已有写作连接设置保留。每条点评也可单独选择。初始化与普通改纲使用主 API。');
        fields.connection=select([['main','复用酒馆主连接'],['custom','独立副 API（OpenAI 兼容）']],s.connection);connection.append(field('写作点评默认 API',fields.connection));fields.plotConnection=select([['main','主 API'],['custom','副 API']],s.plotConnection??'main');connection.append(field('剧情点评默认 API',fields.plotConnection));
        const custom=el('div');fields.endpoint=input(s.endpoint);fields.model=input(s.model);const key=input('','password');key.autocomplete='off';key.placeholder=a.host.key?'已保存在本设备；留空保留':'仅保存在本设备，不随导出同步';custom.append(field('独立 API 地址（支持 /v1 或完整 /chat/completions）',fields.endpoint),field('独立模型名称',fields.model),field('独立 API Key',key),this.button('清除本设备 API Key',async()=>{await a.host.setKey('');key.value='';}));
        const showCustom=()=>{custom.hidden=fields.connection.value!=='custom'&&fields.plotConnection.value!=='custom';};fields.connection.addEventListener('change',showCustom);fields.plotConnection.addEventListener('change',showCustom);showCustom();connection.append(custom);
        const values=()=>({...s,...Object.fromEntries(Object.entries(fields).map(([k,n])=>[k,n.type==='checkbox'?n.checked:n.type==='number'?Number(n.value):n.value]))});
        connection.append(this.button('测试点评连接',()=>a.testConnection(values(),key.value||a.host.key)),el('p','测试使用当前表单，不提交故事；测试成功后请保存设置。独立 API 需允许浏览器跨域，Key 仅在本设备保存。','bbp-hint'));this.content.append(connection);
        const rules=this.section('生成与审阅');fields.mode=select([['semi','半自动：重要变更先审阅'],['auto','全自动：自动修改全部未保护资料'],['manual','全手动：只按按钮运行，变更先审阅']],s.mode);rules.append(field('编辑权限',fields.mode));
        for(const [k,label] of [['enabled','启用 BBPresets'],['waitOutline','改纲时等待完成后生成正文（可沿用旧大纲继续）']]){fields[k]=check(s[k]);rules.append(field(label,fields[k]));}
        const number=(container,k,label,min,max)=>{const n=fields[k]=input(s[k],'number');n.min=min;n.max=max;container.append(field(label,n));};
        number(rules,'feedbackThreshold','积累多少条待发送点评后总结',1,100);this.content.append(rules);
        const injection=this.section('大纲注入','默认仅在剧情转折、目标收束或需要确认方向时调用正文。新聊天或没有申请条目时，只带剧情目标与有上限的简短目录；日常对话可连续多轮不调用全文。');
        fields.outlineInjection=select([['requested','按需调用（默认）'],['full','完整注入（受总预算限制）']],s.outlineInjection??'requested');injection.append(field('大纲注入方式',fields.outlineInjection));
        number(injection,'outlineMaxEntries','按需调用单轮最多条数',1,12);number(injection,'outlineDirectoryChars','简短目录字符上限',300,6000);this.content.append(injection);
        const memory=this.section('BB-Memory · 故事资料联动','只影响故事大纲；作者选择不跟随记忆存档切换。');
        for(const [k,label] of [['memoryRead','允许读取已确认同故事的 BB-Memory'],['memoryFollow','跟随已映射的 BB-Memory 槽（默认关闭）']]){fields[k]=check(s[k]);memory.append(field(label,fields[k]));}
        if(a.story){const state=el('p'),show=()=>state.textContent=a.story.data.memoryBinding?`已确认槽：${a.story.data.memoryBinding.slotName}`:'尚无映射；不会读取其他故事';show();memory.append(state,this.button('确认当前两个存档属于同一故事',async()=>{await a.bindMemory();show();return '故事对应关系已保存；联动开关请点保存设置';}),this.button('解除此档映射',async()=>{await a.edit(a.story.data.id,d=>{d.memoryBinding=null;return d;});show();return '已解除映射；联动开关请点保存设置';}));}else memory.append(el('p','先在存档页加载大纲，再确认对应关系。'));this.content.append(memory);
        const budget=el('details','','bbp-card');budget.append(el('summary','上下文预算与等待时长'));
        for(const [k,label,min,max] of [['contextRounds','参考最近轮数',1,30],['maxInputChars','策划材料字符预算（不含固定指令）',2000,150000],['injectionChars','正文注入字符预算',500,40000],['timeoutSeconds','主 API 慢响应提醒 / 副 API 超时（秒）',10,300]])number(budget,k,label,min,max);
        budget.append(el('p','主 API 超过此时长继续等待原请求；副 API 超时会取消当次请求。短暂网络故障最多重试两次。','bbp-hint'));this.content.append(budget);
        const appearance=this.section('界面 · 本设备');const showBall=check(this.ui.showBall);showBall.addEventListener('change',()=>this.setBallVisible(showBall.checked));appearance.append(field('显示悬浮球（本设备，立即生效）',showBall),this.button('重置悬浮球位置',()=>{showBall.checked=true;return this.resetBall();}));this.content.append(appearance);
        const save=this.button('保存设置',async()=>{await a.saveSettings(values(),s);Object.assign(s,copy(a.settings));if(key.value)await a.host.setKey(key.value);key.value='';return '设置已保存';});save.classList.add('bbp-primary');this.content.append(save,this.button('载入已保存设置',()=>this.render()));
    }
    prompts(){
        const a=this.app;this.content.append(el('h2','全部提示词'),el('p','逐条展开后可编辑并保存。{{material}} 等占位符会填入本次资料；编辑不会解除保护或格式校验。提示词随账户保存，导出仅含提示词。'));
        if(a.settings.prompts?.control||a.settings.prompts?.injection)this.content.append(el('p','已保留你的自定义正文提示词。v0.5.5 使用 version:2、无 title 的剧情目标与默认空选条；请对照新默认值更新“作者建议与大纲说明”和“尾部控制信息”。旧版摘要不会作为新目标。','bbp-hint'));
        const file=input('','file');file.accept='.json,application/json';
        this.content.append(this.button('导出整套提示词',()=>download(a.exportPromptSet(),'BBPresets-prompts-v0.5.5.json')),field('导入提示词文件',file),this.button('导入并保存提示词',async()=>{assert(file.files[0]&&file.files[0].size<1000000,'请选择小于 1 MB 的提示词 JSON 文件');const result=await a.importPromptSet(JSON.parse(await file.files[0].text()));this.promptDrafts={};this.render();return result;}));
        const promptGroups=[['通用规则',['system','changeContract']],['初始化与大纲',['questions','replaceQuestions','appendQuestions','initialization','outline']],['划线评与正文',['feedback','plotFeedback','injection','control']],['连接与历史兼容',['connectionTest','legacyWorld','legacyReflection']]];
        for(const [title,keys] of promptGroups){const group=el('section','','bbp-prompt-group');group.append(el('h3',title));this.content.append(group);
        for(const key of keys){const entry=PROMPTS[key];
            const card=el('details','','bbp-card'),custom=Object.hasOwn(a.settings.prompts??{},key),base=a.settings.prompts?.[key];
            card.append(el('summary',entry.title+(custom?' · 已自定义':' · 默认')));
            const text=area(this.promptDrafts[key]??base??entry.text);text.rows=10;text.readOnly=true;text.setAttribute('aria-label',entry.title);
            const state=el('p','导出使用已保存的版本。未保存的输入在切页时保留。','bbp-hint');
            text.addEventListener('input',()=>{this.promptDrafts[key]=text.value;state.textContent='有未保存修改，请保存后再导出。';});
            card.append(text,this.button('编辑此提示词',()=>{text.readOnly=false;text.focus();}),this.button('恢复本条默认',()=>{text.value=entry.text;this.promptDrafts[key]=text.value;text.readOnly=false;state.textContent='已载入默认值，点击保存后生效。';}),this.button('保存此提示词',async()=>{
                assert(a.settings.prompts?.[key]===base,'服务器提示词已变化，当前输入保留；请重新载入后合并');
                const prompts={...a.settings.prompts};if(text.value===entry.text)delete prompts[key];else prompts[key]=text.value;validatePrompts(prompts);
                await a.saveSettings({...a.settings,prompts},copy(a.settings));delete this.promptDrafts[key];this.render();return '提示词已保存到酒馆服务器';
            }),state);group.append(card);
        }}
    }
    injectionPreview(){
        if(!this.authorGate())return;
        const a=this.app;this.content.append(el('h2','本轮注入预览'),el('p',a.controlStatus||'尚未收到本次会话的正文控制信息。'),el('p','控制块默认从正文显示中隐藏；可编辑该条回复检查原始文本中的 [BBP_CONTROL]。'),el('p','显示最近一次实际生成使用的作者资料快照，包含作者构思与未来规划。'),el('p',`已注入条目：${(a.lastInjection.recordIds??[]).join('、')||'尚未生成'} · 省略 ${a.lastInjection.omitted??0} 条`),el('pre',a.lastInjection.text||'发送下一条 RP 后在这里查看。'),el('p',`本设备本次会话请求 ${a.stats.calls} 次 · 成功 ${a.stats.success} · 失败 ${a.stats.failed} · 最近 API 用量：${a.stats.usage?JSON.stringify(a.stats.usage):'接口未提供，未知'}`),this.button('刷新注入预览',()=>this.render()));
    }
    versions(){
        const a=this.app;this.content.append(el('h2','服务器版本与恢复'),el('p','电脑显示“已保存到酒馆服务器”后，手机打开同一账户会读取这份记录。返回旧页面时先刷新服务器版本。'));
        this.content.append(this.button('重新读取服务器',async()=>{await a.refresh();this.render();}));
        const repair=el('details','','bbp-card');repair.append(el('summary','存储故障修复'),el('p','仅用于索引损坏或缺失时恢复服务器备份；日常接续请使用重新读取服务器。','bbp-hint'),this.button('主索引损坏时恢复备份',async()=>{await a.repo.recoverIndex();await a.refresh();this.render();}));this.content.append(repair);
        if(a.profile)this.content.append(this.button('导出全部资料',async()=>download(await a.exportAll())));
        if(a.profile){const scopes=[['profile','默认作者与账户设置'],...(a.author.data.id!=='profile'?[[a.author.data.id,'当前作者']]:[]),...(a.story?[[a.story.data.id,'当前大纲']]:[])],target=select(scopes,this.versionTarget??a.story?.data.id??'profile');if(!target.value)target.value='profile';target.addEventListener('change',()=>{this.versionTarget=target.value;this.render();});const id=target.value,versions=a.repo.index.documents[id]?.history??[],picker=select(versions.map((v,i)=>[String(i),`版本 ${v.revision} · ${when(v.at)}`]));this.content.append(field('恢复作用域',target),field('历史版本',picker),this.button('查看所选版本内容',async()=>{assert(versions.length,'尚无历史版本');const epoch=a.epoch,version=await a.repo.loadVersion(id,versions[Number(picker.value)]);assert(epoch===a.epoch,'故事已切换，请重新查看版本');const card=el('section','','bbp-card');card.append(el('h3',`版本 ${version.revision} · 资料内容`));for(const r of version.data.records)card.append(el('h4',r.title),el('pre',body(r)));this.content.append(card);}),this.button('恢复所选版本',async()=>{assert(versions.length,'尚无历史版本');await a.restore(id,versions[Number(picker.value)]);this.render();}),el('p','恢复会新建版本，保留已有历史和点评；当前保留文字若与旧版本冲突，恢复将停止。','bbp-hint'));}
        this.content.append(this.button('检查本设备未完成保存',async()=>{const rows=await a.recovery.list();const list=el('section','','bbp-card');list.append(el('h3',`待恢复副本 ${Object.keys(rows).length} 份`));for(const [id,p] of Object.entries(rows)){const archive={format:'bbpresets-export',schema:1,documents:[p.data]};list.append(el('p',`${p.data.title} · ${when(p.at)}`),this.button('导出此恢复副本',()=>download(archive,`BBPresets-recovery-${id}.json`)),this.button('恢复为独立副本',async()=>{await a.importArchive(archive);this.render();}));}this.content.append(list);}));
    }
    destroy(){this.destroyed=true;this.observer.disconnect();this.resizeObserver.disconnect();globalThis.removeEventListener('resize',this.onResize);globalThis.visualViewport?.removeEventListener('resize',this.onResize);globalThis.visualViewport?.removeEventListener('scroll',this.onResize);document.removeEventListener('keydown',this.onKey);document.removeEventListener('pointerup',this.onSelection);this.app.listeners.delete(this.onChange);this.surface.remove();this.entry.remove();}
}
function floorLabel(sources){const floors=sources.map(s=>s.floor).filter(Number.isInteger);return floors.length?'第 '+[...new Set(floors)].join('、')+' 楼':'无聊天楼层';}
