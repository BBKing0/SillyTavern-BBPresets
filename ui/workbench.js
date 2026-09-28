import {assert,copy,record,uid,AUTHOR_KINDS,recordCounts} from '../core/model.js';
import {loadStyle,clampPosition} from './surface.js';
import {recordText,simplifyRecord,protectSelection} from './editor.js';
import {PROMPTS,validatePrompts} from '../core/prompt-templates.js';
import {stripControl} from '../core/outline.js';

// All imported/model/user text is rendered as text, never markup.
const el=(tag,text='',className='')=>{const n=document.createElement(tag);n.textContent=text;if(className)n.className=className;return n;};
const field=(label,input)=>{const n=el('label','', 'bbp-field');input.setAttribute('aria-label',label);n.append(el('span',label),input);return n;};
const input=(value='',type='text')=>{const n=el('input');n.type=type;n.value=value;return n;};
const area=(value='')=>{const n=el('textarea');n.value=value;n.rows=4;return n;};
const select=(items,value)=>{const n=el('select');for(const [id,label] of items){const o=el('option',label);o.value=id;n.append(o);}n.value=value??items[0]?.[0]??'';return n;};
const check=(value=false)=>{const n=input('','checkbox');n.checked=value;return n;};
const kinds=[['storyline','故事核'],['inspiration','灵感激发点'],['core','旧故事核心'],['line','旧故事线'],['chapter','旧章节'],['clue','旧伏笔 / 支线'],['guide','写作建议'],['world','历史世界参考'],['focus','历史叙事关注'],['experience','历史作者经验']];
const truths=[['plan','构思 / 待验证'],['intent','行动意图'],['event','已发生'],['guidance','写作指导']];
const when=n=>new Date(n).toLocaleString();
const body=r=>r?recordText(r):'（不存在）';
const pages=[['overview','概览'],['archives','存档'],['inspirations','灵感激发点'],['authors','个性化作者'],['feedback','划线评'],['review','任务队列'],['injection','注入预览'],['prompts','提示词'],['settings','设置'],['versions','版本恢复']];
const groups=[['overview','概览',['overview']],['archives','存档',['archives']],['inspiration','灵感',['inspirations']],['author','作者',['authors','feedback']],['tasks','任务',['review']],['tools','工具',['settings','prompts','injection','versions']]];
const UI_KEY='bbpresets_ui_v1'; // Device layout and selection preferences only: no story text or credentials.
const jobLabel=(app,job)=>{const name=job.kind==='feedback'?(job.feedback?.some(f=>f.category==='plot')?'剧情点评总结':'写作点评总结'):'废案任务';return name+' · '+(app.taskSettings(job.kind,job).connection==='main'?'主 API':'副 API');};
export function download(value,name='BBPresets-export.json'){
    const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
    const a=el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export class Workbench {
    constructor(app){
        this.app=app;this.tab='overview';this.revealed=false;this.selection=null;this.selectedFeedback=new Set();this.storyId=null;this.editor=null;this.expandedRecords=new Set();this.recordDrafts=new Map();this.promptDrafts={};this.feedbackDrafts=new Map();this.inspirationDrafts=new Map();
        this.ui={showBall:true,feedbackOpen:true,polarity:'positive',intent:'save',category:'writing'};try{const saved=JSON.parse(localStorage.getItem(UI_KEY));if(saved){this.ui.showBall=saved.showBall!==false;this.ui.feedbackOpen=saved.feedbackOpen!==false;for(const [key,allowed] of Object.entries({polarity:['positive','negative','neutral'],intent:['save','batch','send'],category:['writing','plot']}))if(allowed.includes(saved[key]))this.ui[key]=saved[key];if(Number.isFinite(saved.left)&&Number.isFinite(saved.top)){this.ui.left=saved.left;this.ui.top=saved.top;}}}catch{/* Storage restrictions must not prevent opening the workspace. */}
        this.surface=el('div');this.surface.id='bbpresets-surface';
        // A zero-size host never intercepts the chat. Only the panel and ball receive pointers.
        this.surface.style.cssText='position:fixed;inset:0 auto auto 0;width:0;height:0;z-index:100001;pointer-events:none;visibility:hidden';
        this.shadow=this.surface.attachShadow({mode:'open'});document.body.append(this.surface);
        loadStyle(this.shadow).ready.then(()=>{if(!this.destroyed){this.surface.style.visibility='visible';this.onResize();}}).catch(e=>this.app.report(e));
        this.dialog=el('section','','bbp-dialog bbp-embedded');this.dialog.id='bbpresets-workbench';this.dialog.setAttribute('aria-label','BBPresets 扩展工作台');
        const header=el('header');header.append(el('strong','个性化作者 · 灵感'));
        this.waitPanel=el('div','','bbp-card');this.waitLabel=el('p');this.waitPanel.append(this.waitLabel);this.waitPanel.hidden=true;
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
        this.onChange=()=>{const id=(this.app.inspiration?.data.id??'')+':'+this.app.host.identity().chatKey+':'+(this.app.author?.data.id??''),loaded=!this.hadProfile&&this.app.profile,draftLoaded=this.app.ready&&this.draftLoadVersion!==this.app.draftLoadVersion;if(this.app.ready)this.draftLoadVersion=this.app.draftLoadVersion;this.hadProfile=Boolean(this.app.profile);let switched=false;if(id!==this.storyId){this.storyId=id;this.revealed=false;if(this.editor)this.recordDrafts.set(this.editor.target+':'+this.editor.draft.id,this.editor);this.editor=null;this.pageCache.clear();this.selectedFeedback.clear();switched=true;}if(switched||loaded)this.quickActions();if(switched||loaded||((draftLoaded||this.waitingForStory&&this.app.ready)&&this.tab==='setup'))this.render();this.updateStatus();};
        app.listeners.add(this.onChange);
        this.onSelection=()=>{const s=globalThis.getSelection?.();if(!s||s.isCollapsed||!s.rangeCount)return;const range=s.getRangeAt(0),node=range.commonAncestorContainer;const parent=node.nodeType===1?node:node.parentElement;const message=parent?.closest('.mes');if(!message||!parent.closest('.mes_text'))return;const floor=Number(message.getAttribute('mesid')),m=app.host.ctx().chat?.[floor];if(m&&!m.is_user)this.selection={quote:s.toString(),raw:m.mes,floor,chatKey:app.host.identity().chatKey};};
        document.addEventListener('pointerup',this.onSelection);
        this.entry=el('div','','bbp-entry inline-drawer');this.entry.id='bbpresets-entry';
        const summary=el('div','','inline-drawer-toggle inline-drawer-header bbp-entry-toggle');summary.setAttribute('role','button');summary.tabIndex=0;this.summary=summary;
        summary.append(el('b','BBPresets v0.5.8'),el('div','','inline-drawer-icon fa-solid fa-circle-chevron-down down'));
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
        const toggle=()=>{if(this.quick.hidden)this.quickActions();this.quick.hidden=!this.quick.hidden;this.refreshQuickInspiration?.();this.ball.setAttribute('aria-expanded',String(!this.quick.hidden));this.layout();};
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
        c.append(section,this.quickInspiration(),this.button('快速保存',()=>a.saveCurrent()),this.button('管理灵感存档',()=>{this.open('archives');this.close();}),this.quickStatus,this.quickRecent);
    }
    quickInspiration(){
        const a=this.app,section=el('details','','bbp-quick-inspiration');section.append(el('summary','灵感激发点'));
        section.addEventListener('toggle',()=>this.layout());
        if(!a.inspiration){section.append(el('p','正在加载灵感档案。'),this.button('选择灵感存档',()=>{this.open('archives');this.close();}));return section;}
        const id=a.inspiration.data.id,key=id;
        if(!this.inspirationDrafts.has(key))this.inspirationDrafts.set(key,{text:''});
        const draft=this.inspirationDrafts.get(key),text=area(draft.text);text.rows=3;text.maxLength=1000;text.placeholder='想看什么情节？留待合适时机自然发生。';
        text.addEventListener('input',()=>{draft.text=text.value;});
        const count=el('p','','bbp-hint'),list=el('div','','bbp-quick-ideas');
        section.append(field('灵感内容',text),this.button('保存灵感',async()=>{
            assert(a.inspiration?.data.id===id&&id===key,'灵感档已切换，请回原档继续保存');
            const value=text.value.trim();assert(value,'请先填写灵感内容');
            await a.saveRecord(id,record({kind:'inspiration',title:value.slice(0,40),body:value}),null);
            if(text.value.trim()===value){draft.text='';text.value='';}
            return '灵感已保存到当前灵感档，等待合适时机使用';
        }),count,list,this.button('管理全部灵感',()=>{this.open('inspirations');this.close();}));
        let revision;
        this.refreshQuickInspiration=()=>{
            const current=[a.inspiration?.revision,a.settings.inspirationCapacity,a.settings.inspirationInjectCount,a.settings.injectInspiration].join(':');
            if(!section.isConnected||a.inspiration?.data.id!==id||revision===current)return;
            revision=current;const all=a.inspiration.data.records.filter(r=>r.kind==='inspiration'),pending=all.filter(r=>r.status==='active');
            count.textContent='待用 '+pending.length+' / '+a.settings.inspirationCapacity+' · 已归档 '+(all.length-pending.length)+' · '+(a.settings.injectInspiration===false?'灵感注入已关闭':'每轮最多注入 '+a.settings.inspirationInjectCount+' 条');
            list.replaceChildren();
            for(const item of pending.slice(-5).reverse()){
                const row=el('details');row.append(el('summary',item.title||'未命名灵感'),el('p',body(item),'bbp-prose'),el('small',item.creator==='ai'?'AI 素材':'用户期待'),this.button('归档此灵感',async()=>{await a.saveRecord(id,{...copy(item),status:'archived'},item);return '灵感已归档';}));list.append(row);
            }
            if(pending.length>5)list.append(el('p','最近显示 5 条，其余可在“管理全部灵感”查看。','bbp-hint'));
        };
        return section;
    }
    feedbackComposer(quick=false){
        const a=this.app,key=a.author.data.id+':'+(a.inspiration?.data.id??'')+':'+a.host.identity().chatKey;
        if(!this.feedbackDrafts.has(key))this.feedbackDrafts.set(key,{quote:'',note:'',source:null});
        const draft=this.feedbackDrafts.get(key),box=el('div','','bbp-feedback-composer');
        const quote=area(draft.quote),note=area(draft.note),polarity=select([['positive','喜欢'],['negative','不喜欢'],['neutral','中性 / 收藏']],this.ui.polarity);
        const category=select([['writing','写作 · 行文 / 用词'],['plot','剧情 · 叙事 / 节奏']],this.ui.category),connection=select([['main','主 API'],['custom','副 API']],a.feedbackConnection(this.ui.category));
        quote.rows=quick?2:5;note.rows=quick?2:4;
        quote.placeholder='粘贴原文，或用按钮载入选段';note.placeholder='写下你的评价与修改建议';
        quote.addEventListener('input',()=>{draft.quote=quote.value;});quote.addEventListener('paste',()=>{draft.source=null;});note.addEventListener('input',()=>{draft.note=note.value;});
        polarity.addEventListener('change',()=>{this.ui.polarity=polarity.value;this.saveUI();});
        const destination=el('p','','bbp-hint'),showDestination=()=>{destination.textContent='保存到作者：'+a.author.data.title;};showDestination();
        category.addEventListener('change',()=>{this.ui.category=category.value;connection.value=a.feedbackConnection(category.value);showDestination();this.saveUI();});
        const use=async selected=>{const selection=selected?this.selection:null;assert(!selected||selection,'请先在聊天正文中划选，或直接粘贴原文');const c=await a.host.capture();assert(!selection||selection.chatKey===c.chatKey,'选段来自其他聊天，请重新选择');const row=selection?c.rows.find(r=>r.floor===selection.floor):c.rows.findLast(r=>r.role==='assistant');assert(row,'没有可载入的回复');assert(!selection||selection.raw===row.text,'选段所在回复已变化，请重新划选');quote.value=selection?.quote??stripControl(row.text);draft.quote=quote.value;draft.source=c.sources.find(s=>s.id===row.id);return '原文已载入，请在点评框填写意见';};
        const tools=el('div','','bbp-actions bbp-small-actions');tools.append(this.button('载入选中段落',()=>use(true)),this.button('载入最新回复',()=>use(false)),this.button('手动粘贴原文',()=>{quote.focus();return '请在原文框粘贴，点评写在下方';}));
        const options=el('div','','bbp-feedback-options');options.append(field('分类',category),field('态度',polarity),field('处理 API',connection));
        box.append(tools,field('原文（可粘贴）',quote),options,destination,field('点评',note));
        const save=async mode=>{
            assert(a.author.data.id+':'+(a.inspiration?.data.id??'')+':'+a.host.identity().chatKey===key,'作者、故事或聊天已切换，请重新提交');
            const target=a.author.data.id;
            const id=await a.addFeedback({quote:quote.value,note:note.value,polarity:polarity.value,category:category.value,connection:connection.value,source:draft.source,status:mode==='batch'?'queued':'saved'});
            draft.quote='';draft.note='';draft.source=null;quote.value='';note.value='';
            if(mode==='send')await a.sendFeedback([id],target);this.pageCache.delete('feedback');if(!quick)this.render();
            return mode==='save'?'已保存到当前作者，未发送给 AI':mode==='batch'?'已加入待发送批次（按分类与 API 分别累计）':'点评已提交，请查看任务队列';
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
        const a=this.app,s=a.inspiration?.data,names={loading:'读取服务器中',saving:'正在保存',saved:'已保存到酒馆服务器',error:'保存未完成，请查看恢复区'};
        const live=a.requestState||(a.auxiliary?'测试连接中':a.activeJob?'正在处理点评':a.jobs.length?'点评任务待处理':a.settings?.enabled?'灵感按需使用，点评维护作者':'插件已停用');
        const status=`灵感：${s?.title??'尚未加载'}\n作者：${a.author?.data.title??'尚未加载'}\n${names[a.status]??a.status} · ${live}${a.error?'\n'+a.error:''}`;
        this.statusMain.textContent=status;this.statusMore.textContent=`待用灵感 ${s?.records.filter(r=>r.status==='active').length??0} 条 · 待办 ${a.jobs.length} / 提案 ${a.proposals.length}${a.controlStatus?' · '+a.controlStatus:''}${a.host.controlWarning?' · '+a.host.controlWarning:''}`;
        if(this.quickStatus)this.quickStatus.textContent=status;
        this.updateArchiveCounts();this.refreshRecords?.();this.refreshQuickInspiration?.();
        for(const [summary,body] of [[this.recentSummary,this.recentBody],[this.quickRecentSummary,this.quickRecentBody]])if(summary&&body){summary.textContent='最近状况 · '+a.recentStatus[0];body.replaceChildren(...a.recentStatus.slice(1).map(text=>el('p',text,'bbp-hint')));}
        if(this.entryEnabled){this.entryEnabled.checked=Boolean(a.settings?.enabled);this.entryEnabled.disabled=!a.settings;}
        if(this.ball){this.ball.hidden=!this.ui.showBall;this.ball.dataset.busy=String(Boolean(a.running||a.auxiliary));this.ball.dataset.error=String(Boolean(a.error));this.ball.title='BBPresets · '+live;if(!this.quick.hidden)this.layout();}
    }
    open(tab=this.tab){
        if(!pages.some(([id])=>id===tab))tab='archives';
        if(tab!==this.tab){if(this.editor){this.recordDrafts.set(this.editor.target+':'+this.editor.draft.id,this.editor);this.editor=null;}if(['settings','prompts'].includes(this.tab))this.pageCache.set(this.tab,[...this.content.childNodes]);this.tab=tab;const cached=this.pageCache.get(tab);if(cached)this.content.replaceChildren(...cached);else this.render();}
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
        this.refreshRecords=null;
        this.pageCache.delete(this.tab);
        this.content.replaceChildren();this.updateStatus();this.updateNavigation();
        const fn={overview:'overview',archives:'archives',inspirations:'inspirations',authors:'authors',feedback:'feedback',review:'review',settings:'settings',versions:'versions',prompts:'prompts',injection:'injectionPreview'}[this.tab];
        if(!this.app.profile&&this.tab!=='versions'){this.content.append(el('p','正在连接酒馆资料存储；失败时可到“工具 → 版本恢复”重新读取。'),this.button('打开版本恢复',()=>this.open('versions')));return;}
        if(this.tab==='inspirations'&&!this.app.inspiration){this.content.append(el('p','灵感档案尚未加载，请从服务器重试。'),this.button('重新读取服务器',()=>this.app.refresh()));return;}
        this[fn]();
    }
    section(title,hint=''){const card=el('section','','bbp-card');card.append(el('h3',title));if(hint)card.append(el('p',hint,'bbp-hint'));return card;}
    authorGate(){if(this.revealed)return true;this.content.append(el('p','此页包含世界幕后、行动意图和作者构思，可能透露剧情。'),this.button('查看剧情资料',()=>{this.revealed=true;this.render();}));return false;}
    archiveImport(container=this.content){
        const file=input('','file');file.accept='.json,application/json';container.append(field('导入存档文件',file),this.button('导入为独立副本',async()=>{const f=file.files[0];assert(f&&f.size<12000000,'请选择小于 12 MB 的 BBPresets 存档');await this.app.importArchive(JSON.parse(await f.text()));this.render();return '已导入独立副本，可在灵感或作者列表中选择；旧故事在废案中保留';}));
    }
    overview(){
        const a=this.app,s=a.inspiration?.data;this.content.append(el('h2','概览'));
        const card=this.section('当前存档','灵感与作者分别选择，随账户保存；切换聊天会沿用当前选择。');
        card.append(el('p','灵感：'+(s?.title??'尚未加载')),el('p','作者：'+a.author.data.title),el('p','待用灵感 '+(s?.records.filter(r=>r.status==='active').length??0)+' 条 · 作者建议 '+recordCounts(a.author.data).writing+' 条'),this.button('管理灵感',()=>this.open('inspirations')),this.button('选择 / 管理存档',()=>this.open('archives')),this.button('管理个性化作者',()=>this.open('authors')));this.content.append(card);
    }
    archives(){
        const a=this.app;this.content.append(el('h2','存档'),el('p','“灵感”与“作者”是两类独立存档，切换其中一个不会更换另一个。资料自动保存到同一酒馆账户。','bbp-hint'));
        for(const [label,wrapper] of [['灵感',a.inspiration],['作者',a.author]])if(wrapper){const d=wrapper.data,card=this.section('当前'+label+'存档',d.title),name=input(d.title);name.maxLength=300;
            card.append(field(label+'存档名称',name),this.button('保存'+label+'名称',async()=>{assert(name.value.trim(),'请填写名称');await a.edit(d.id,x=>{x.title=name.value.trim();return x;});this.render();return '名称已保存';}),this.button('保存'+label+'存档',async()=>{const result=await a.saveCurrent(d.id);this.render();return result;}),this.button('导出当前'+label,async()=>download(await a.exportScope(d.id),'BBPresets-'+d.type+'.json')));this.content.append(card);
        }
        this.content.append(this.button('从服务器加载',async()=>{await a.refresh();this.render();return '已加载服务器上的灵感与作者资料';}));
        const search=input(this.archiveQuery??'');search.placeholder='名称或存档 ID';search.addEventListener('input',()=>{this.archiveQuery=search.value;this.updateArchiveCounts();});this.content.append(field('搜索存档',search));
        this.archiveList=el('div','','bbp-archive-counts');this.archiveList.tabIndex=0;this.archiveList.setAttribute('role','region');this.archiveList.setAttribute('aria-label','存档列表，可滚动');this.archiveSignature=null;this.content.append(this.archiveList);this.updateArchiveCounts();
        const create=this.section('新建 / 复制存档'),title=input('');title.maxLength=300;
        create.append(field('新存档名称',title),this.button('新建灵感档',async()=>{const result=await a.createInspiration(title.value);this.render();return result;}),this.button('另存当前灵感',async()=>{const result=await a.createInspiration(title.value,{from:a.inspiration.data.id,select:false});this.render();return result;}),this.button('新建作者档',async()=>{await a.createAuthor(title.value);this.render();return '已新建并选用作者';}),this.button('复制当前作者',async()=>{await a.createAuthor(title.value,{from:a.author.data.id});this.render();return '已复制并选用作者';}));this.content.append(create);
        const imports=el('details');imports.append(el('summary','导入灵感 / 作者 / 旧版存档'));this.archiveImport(imports);this.content.append(imports);
    }
    updateArchiveCounts(){
        if(!this.archiveList?.isConnected)return;
        const a=this.app,query=(this.archiveQuery??'').trim().toLocaleLowerCase(),signature=JSON.stringify([a.repo.index?.commitId,a.inspiration?.data.id,a.author?.data.id,query]);
        if(signature===this.archiveSignature)return;this.archiveSignature=signature;
        const sections=new Map([['inspiration',this.section('灵感存档')],['author',this.section('作者存档')],['story',el('details','','bbp-card')]]);
        sections.get('story').append(el('summary','废案 · 旧故事核 / 大纲'),el('p','旧功能已停止，资料仅供查看与导出。原有灵感已复制为独立档案，旧故事原文、保护和历史版本保留。'));
        for(const [id,entry] of Object.entries(a.repo.index?.documents??{})){
            if(query&&![entry.title,id].some(v=>v.toLocaleLowerCase().includes(query)))continue;
            const kind=entry.type==='profile'?'author':entry.type,current=id===(kind==='inspiration'?a.inspiration?.data.id:a.author?.data.id),card=this.section(entry.title);
            card.dataset.archiveId=id;const counts=entry.counts;
            card.append(el('p',`${current?'当前使用 · ':''}${kind==='story'?'只读废案':kind==='inspiration'?'灵感存档':'作者存档'}${counts?' · 共 '+counts.total+' 条':''}`),el('p',`服务器保存：${when(entry.at)} · 版本 ${entry.revision}`,'bbp-hint'));
            if(kind!=='story'){const load=this.button(current?'当前使用':kind==='inspiration'?'使用此灵感':'使用此作者',async()=>{if(kind==='inspiration')await a.selectInspiration(id);else await a.selectAuthor(id);this.render();return '已切换'+(kind==='inspiration'?'灵感':'作者')+'存档';});load.disabled=current;card.append(load);
                if(kind==='inspiration'&&entry.saved)card.append(this.button('读取手动保存点',async()=>{const result=await a.loadSavedInspiration(id);this.render();return result;}));
            }else card.append(this.button('查看废案资料',async()=>{const doc=(await a.repo.load(id)).data,view=el('div');for(const r of doc.records)view.append(el('h4',r.title||r.kind),el('p',body(r),'bbp-prose'),...(r.nextNode?[el('p','旧节点：'+r.nextNode)]:[]));for(const f of doc.feedback)view.append(el('blockquote',f.quote),el('p',f.note));view.append(el('p',`保留历史 ${doc.history.length} 次 · 旧任务 ${doc.jobs.length+doc.proposals.length+(doc.retiredTasks?.length??0)} 项（均不运行）`));card.append(view);}),this.button('复制旧写作资料为作者',async()=>{await a.createAuthor(entry.title+' · 作者',{from:id});this.render();return '原资料保留，已选用复制的作者';}));
            card.append(this.button('导出此档',async()=>download(await a.exportScope(id))));sections.get(kind)?.append(card);
        }
        const scroll=this.archiveList.scrollTop;this.archiveList.replaceChildren(...sections.values());this.archiveList.scrollTop=scroll;
    }
    inspirations(){
        const a=this.app;
        this.content.append(el('h2','灵感激发点'),el('p','把暂时不适合当前场景、以后很想写的素材留在这里。AI 也可克制地补充；不要求下一轮兑现，正文实际使用后才归档。'));
        const options=this.section('数量与注入'),capacity=input(a.settings.inspirationCapacity??20,'number'),count=input(a.settings.inspirationInjectCount??3,'number'),enabled=check(a.settings.inspirationAiEnabled!==false);capacity.min=1;capacity.max=200;count.min=0;count.max=20;
        options.append(field('待用灵感数量上限',capacity),field('每轮注入灵感条数',count),field('允许 AI 新增和修订灵感',enabled),this.button('保存灵感设置',async()=>{await a.saveSettings({...a.settings,inspirationCapacity:Number(capacity.value),inspirationInjectCount:Number(count.value),inspirationAiEnabled:enabled.checked},copy(a.settings));return '灵感设置已保存；降低上限不会删除已有素材';}),el('p','默认待用上限 20、每轮注入 3，可设为 0。用户期待优先，同组按创建顺序；字符预算不足时省略。AI 每轮最多新增 1 条，新增后的两轮暂停新增；关闭新增/修订后，实际使用回报仍可归档。','bbp-hint'));
        const choices=Object.entries(a.repo.index.documents).filter(([,d])=>d.type==='inspiration').map(([id,d])=>[id,d.title]),picker=select(choices,a.inspiration.data.id);
        this.content.append(field('当前灵感存档',picker),this.button('切换灵感',async()=>{await a.selectInspiration(picker.value);this.render();return '已切换灵感，作者保持不变';}),this.button('新建 / 复制 / 导出灵感档',()=>this.open('archives')),options);this.recordList(a.inspiration.data,false,'inspiration');
    }
    authors(){
        const a=this.app,doc=a.author.data;this.content.append(el('h2','个性化作者'),el('p','写作偏好保存在作者档案中。同一账户跨聊天沿用当前选择，也可切换为另一位作者。'));
        const choices=[['profile','默认作者 · '+a.profile.data.title],...Object.entries(a.repo.index.documents).filter(([,d])=>d.type==='author').map(([id,d])=>[id,d.title])],picker=select(choices,doc.id);
        this.content.append(field('当前个性化作者',picker),this.button('切换作者',async()=>{await a.selectAuthor(picker.value);this.render();return '作者已切换，灵感选择保持不变';}));
        const name=input(doc.title);this.content.append(field('作者名称',name),this.button('保存作者名称',async()=>{assert(name.value.trim(),'请填写作者名称');await a.edit(doc.id,d=>{d.title=name.value.trim();return d;});this.render();return '作者名称已保存';}),this.button('导出当前作者',async()=>download(await a.exportScope(doc.id),'BBPresets-author.json')));
        const manage=el('details'),title=input('');manage.append(el('summary','新建 / 复制 / 导入作者'),field('新作者名称',title),this.button('新建作者',async()=>{await a.createAuthor(title.value);this.render();}),this.button('复制当前作者',async()=>{await a.createAuthor(title.value,{from:doc.id});this.render();}));this.archiveImport(manage);this.content.append(manage);
        this.recordList(doc,true);
    }
    recordList(doc,author,kindFilter=null){
        if(this.editor&&this.editor.target===doc.id){this.recordEditor();return;}
        let records=doc.records.filter(r=>kindFilter?r.kind===kindFilter:AUTHOR_KINDS.includes(r.kind)===author);
        this.content.append(this.button(kindFilter==='inspiration'?'新增灵感':kindFilter==='storyline'?'新增故事线':'新增条目',()=>{this.editor={target:doc.id,draft:record({kind:kindFilter??(author?'guide':'storyline'),body:kindFilter==='inspiration'?'想看……':kindFilter==='storyline'?'一个……的人，在……的情况下，要完成……的事。':''}),expected:null};this.render();}));
        const filterKey=doc.id+':'+(kindFilter??'author'),search=input(this.recordFilters?.[filterKey]?.search??'','search');search.placeholder='搜索标题、关键词和正文';const type=select([['','全部类别'],...kinds.filter(([k])=>kindFilter?k===kindFilter:AUTHOR_KINDS.includes(k)===author)],this.recordFilters?.[filterKey]?.kind??''),status=select([['active','待用 / 使用中'],['archived','已归档'],['','全部状态']],this.recordFilters?.[filterKey]?.status??'active'),count=el('p','','bbp-hint'),list=el('div');
        this.content.append(field('搜索条目',search),field('类别筛选',type));
        if(kindFilter)this.content.append(field('状态筛选',status));
        const draw=()=>{
            doc=this.app.documentFor(doc.id)?.data??doc;records=doc.records.filter(r=>kindFilter?r.kind===kindFilter:AUTHOR_KINDS.includes(r.kind)===author);
            const query=search.value.trim().toLocaleLowerCase();this.recordFilters??={};this.recordFilters[filterKey]={search:search.value,kind:type.value,status:status.value};
            const rows=records.filter(r=>(!kindFilter||!status.value||r.status===status.value)&&(!type.value||r.kind===type.value)&&(!query||[r.title,r.nextNode??'',r.summary??'',...(r.keywords??[]),body(r)].join('\n').toLocaleLowerCase().includes(query)));
            count.textContent=`找到 ${rows.length} / ${records.length} 条（包含折叠正文）`;list.replaceChildren();
            for(const r of rows){
                const key=doc.id+':'+r.id,card=el('details','','bbp-card bbp-record');card.open=Boolean(query)||this.expandedRecords.has(key);
                card.addEventListener('toggle',()=>{if(!search.value.trim())card.open?this.expandedRecords.add(key):this.expandedRecords.delete(key);});
                card.append(el('summary',`${r.title||'未命名条目'} · ${kinds.find(x=>x[0]===r.kind)?.[1]} · ${r.locked?'整条保护':r.blocks.some(b=>b.locked)?'局部保护':'可编辑'}${r.status==='archived'?' · 已归档':''}`));
                if(query){const text=body(r),index=text.toLocaleLowerCase().indexOf(query);card.append(el('p',index>=0?'…'+text.slice(Math.max(0,index-30),index+query.length+80)+'…':'标题或关键词命中','bbp-hint'));}
                card.append(el('p',body(r),'bbp-prose'),el('small',`ID：${r.id} · 关键词：${(r.keywords??[]).join('、')} · 来源：${r.origin}${doc.excluded.includes(r.id)?' · 来源冲突，暂停注入':''}`),this.button('编辑 / 设置保留',()=>{this.editor=this.recordDrafts.get(key)??{target:doc.id,draft:copy(r),expected:copy(r)};this.render();}));
                if(r.kind==='storyline')card.append(el('p','下一个节点：'+(r.nextNode||'暂未安排'),'bbp-prose'));
                if(r.kind==='inspiration'){card.append(el('p','创作来源：'+(r.creator==='ai'?'AI 素材':'用户期待')),this.button(r.status==='archived'?'恢复待用':'归档此灵感',async()=>{const next=copy(r);next.status=r.status==='archived'?'active':'archived';await this.app.saveRecord(doc.id,next,r);this.render();return next.status==='active'?'灵感已恢复待用':'灵感已归档';}));}
                list.append(card);
            }
        };
        search.addEventListener('input',draw);type.addEventListener('change',draw);status.addEventListener('change',draw);
        let drawnRevision=this.app.documentFor(doc.id)?.revision;this.refreshRecords=()=>{const revision=this.app.documentFor(doc.id)?.revision;if(list.isConnected&&revision!==drawnRevision){drawnRevision=revision;draw();}};
        this.content.append(this.button('全部展开',()=>{for(const r of records)this.expandedRecords.add(doc.id+':'+r.id);draw();}),this.button('全部收起',()=>{for(const r of records)this.expandedRecords.delete(doc.id+':'+r.id);search.value='';draw();}),count,list);draw();
    }
    recordEditor(){
        const e=this.editor,r=simplifyRecord(e.draft);this.content.append(el('h2',e.expected?'编辑条目':'新增条目'));
        const compact=['storyline','inspiration'].includes(r.kind);
        const allowedKinds=kinds.filter(([k])=>compact?k===r.kind:this.app.documentFor(e.target)?.data.type==='story'?!AUTHOR_KINDS.includes(k)&&!['storyline','inspiration'].includes(k):AUTHOR_KINDS.includes(k));
        const title=input(r.title),kind=select(allowedKinds,r.kind),truth=select(truths,r.truth),importance=select([['minor','普通更新'],['major','重要改变']],r.importance),status=select([['active','使用中'],['archived','归档，不注入']],r.status),locked=check(r.locked);
        for(const [key,node] of Object.entries({title,kind,truth,importance,status,locked}))node.addEventListener(node.type==='text'?'input':'change',()=>{r[key]=node.type==='checkbox'?node.checked:node.value;});
        title.maxLength=300;this.content.append(field('标题',title),field('保护整个条目（AI 不得编辑）',locked));
        const keywords=input((r.keywords??[]).join('，')),summary=area(r.summary??''),links=input((r.links??[]).join('，'));
        keywords.addEventListener('input',()=>{r.keywords=keywords.value.split(/[,，\n]/).map(s=>s.trim()).filter(Boolean);});summary.addEventListener('input',()=>{r.summary=summary.value;});links.addEventListener('input',()=>{r.links=links.value.split(/[,，\n]/).map(s=>s.trim()).filter(Boolean);});
        if(!compact)this.content.append(field('关键词（逗号分隔）',keywords),field('目录摘要',summary),field('关联条目 ID（逗号分隔）',links));
        const advanced=el('details');advanced.append(el('summary','条目属性'),field('类别',kind),field('事实状态',truth),field('重要程度',importance),field('使用状态',status));this.content.append(advanced);
        const segmented=r.blocks.some(b=>b.locked),blocks=el('div','','bbp-blocks');
        for(const [index,b] of r.blocks.entries()){
            const wrap=el('section','','bbp-text-section'),text=area(b.text);text.rows=segmented?4:8;
            text.addEventListener('input',()=>{b.text=text.value;});wrap.append(field(segmented?(b.locked?'保护段':'可编辑正文')+' '+(index+1):r.kind==='storyline'?'一句话故事核':r.kind==='inspiration'?'灵感内容':'正文',text));
            if(b.locked){wrap.classList.add('bbp-protected');wrap.append(this.button('取消此段保护',()=>{b.locked=false;this.render();}));}
            else wrap.append(this.button('保护选中文字',()=>{protectSelection(r,b.id,text.selectionStart,text.selectionEnd);this.render();}));
            blocks.append(wrap);
        }
        this.content.append(blocks,this.button('增加保护段',()=>{r.blocks.push({id:uid(),text:'',locked:true});this.render();}));
        if(r.kind==='storyline'){const node=area(r.nextNode);node.maxLength=500;node.addEventListener('input',()=>{r.nextNode=node.value;});this.content.append(field('下一个节点',node),el('p','故事核最多 500 字符，建议用一句话写完。节点可以跨多轮保持不变；整条保护也会保护节点。','bbp-hint'));}
        this.content.append(this.button('保存条目',async()=>{await this.app.saveRecord(e.target,r,e.expected);this.recordDrafts.delete(e.target+':'+r.id);this.editor=null;this.render();return '条目已保存';}),this.button('返回列表',()=>{this.recordDrafts.set(e.target+':'+r.id,e);this.editor=null;this.render();}),el('p','返回列表保留本次编辑草稿；重新打开同一条目可继续。整条保护优先，AI 不能改写保护内容。','bbp-hint'));
    }
    feedback(){
        const a=this.app;this.content.append(el('h2','划线评'),el('p','剧情和写作点评均随当前作者保存，整理成有适用范围的作者建议。待发送点评按分类与 API 分组，满 '+a.settings.feedbackThreshold+' 条自动处理；只保存不计数，全手动模式需手动发送。'),this.feedbackComposer());
        const scopes=[a.author],labels={saved:'只保存',queued:'待处理',processed:'已处理',withdrawn:'已撤回'};
        const submit=async all=>{const epoch=a.epoch;for(const scope of scopes){assert(epoch===a.epoch,'资料已切换，请重新选择点评');const ids=all?a.feedbackGroups(scope.data).flatMap(g=>g.items.map(f=>f.id)):scope.data.feedback.filter(f=>this.selectedFeedback.has(scope.data.id+':'+f.id)).map(f=>f.id);if(ids.length)await a.sendFeedback(ids,scope.data.id);}this.selectedFeedback.clear();this.render();};
        this.content.append(this.button('发送勾选的点评',()=>submit(false)),this.button('发送所有待发送批次',()=>submit(true)));
        for(const scope of scopes){const doc=scope.data,list=doc.feedback.filter(f=>doc.type!=='story'||f.category==='plot');this.content.append(el('h3','作者 · '+doc.title));
            for(const f of [...list].reverse()){const card=el('section','','bbp-card'),key=doc.id+':'+f.id,pick=check(this.selectedFeedback.has(key));pick.disabled=['processed','withdrawn'].includes(f.status);pick.addEventListener('change',()=>pick.checked?this.selectedFeedback.add(key):this.selectedFeedback.delete(key));card.append(field((f.category==='plot'?'剧情':'写作')+' · '+labels[f.status]+' · '+when(f.at)+' · '+((f.connection??a.feedbackConnection(f.category))==='main'?'主 API':'副 API'),pick),el('blockquote',f.quote),el('p',f.note));if(f.status!=='withdrawn')card.append(this.button('撤回此点评',async()=>{await a.withdrawFeedback(f.id,doc.id);this.render();}));this.content.append(card);}
        }
    }
    review(){
        const a=this.app,label=job=>jobLabel(a,job);
        this.content.append(el('h2','任务队列'),el('p','先查看待办与失败原因，再审阅结果；已完成的变更收在历史记录中。','bbp-hint'),this.button('刷新本页状态',()=>this.render()));
        if(a.jobs.length)this.content.append(this.button('重试失败维护 / 继续队列',async()=>{const result=await a.retryJobs();this.render();return result;}));
        if(a.running||a.auxiliary)this.content.append(this.button('停止等待当前请求',()=>a.cancelRequests()));
        this.content.append(el('h3','进行中与待处理'));
        if(!a.jobs.length)this.content.append(el('p','当前没有排队或失败任务。','bbp-hint'));
        for(const {job:j,target} of a.jobs){const d=a.documentFor(target).data,card=this.section(label(j),(d.type==='story'?'故事：':'作者：')+d.title);
            card.append(el('p',(j.kind==='initialization'?'角色卡 / 世界书 / 已确认记忆；聊天来源仅作变更校验':floorLabel(j.sources))+' · '+(j.state==='failed'?'失败':j.state==='held'?'等待手动运行':a.activeJob?.id===j.id?'处理中':'排队')+' · 尝试 '+j.attempts+' 次'+(j.error?' · '+j.error:'')),this.button('重试此任务',async()=>{const result=await a.retryJobs(j.id,target);this.render();return result;}));
            const raw=el('pre');raw.hidden=true;card.append(this.button('查看本设备模型响应（含剧透）',async()=>{const result=await a.diagnostic(j.id,target);raw.textContent=result?.text??'本设备没有响应记录（请求可能尚未返回，或来自其他设备）';raw.hidden=false;}),raw);this.content.append(card);
        }
        this.content.append(el('h3','待审阅结果'),el('p','待审阅 '+a.proposals.length+' 项'));
        if(!a.proposals.length)this.content.append(el('p','新结果需要确认时会显示在这里。','bbp-hint'));
        if(!a.scopes.some(w=>w.data.proposals.length||w.data.history.length||w.data.conflicts.length))return;
        if(!this.authorGate())return;
        for(const {job:p,target} of a.proposals){const d=a.documentFor(target).data,card=this.section(label(p)+' · '+when(p.at),(d.type==='story'?'故事：':'作者：')+d.title);
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
        const switches=this.section('正文注入','两个开关相互独立，可只开一个，也可组合或全部关闭。关闭后保留资料，并停止该类正文自动维护。');
        for(const [k,label] of [['injectAuthor','注入作者'],['injectInspiration','注入灵感激发点']]){fields[k]=check(s[k]!==false);switches.append(field(label,fields[k]));}this.content.append(switches);
        const main=this.section('主 API','点评可使用酒馆当前主连接，无需重复填写地址或 Key。灵感维护随正文控制完成，无额外请求。');
        main.append(this.button('测试主 API',()=>a.testConnection({...a.settings,connection:'main'})),el('p','测试只发送简短连接请求。主 API 达到等待时长后提示“响应较慢”，继续接收原结果；停止等待会保留输入，不强行中断酒馆请求。','bbp-hint'));this.content.append(main);
        const connection=this.section('点评处理连接','剧情默认主 API，写作默认副 API；已有写作连接设置保留。每条点评也可单独选择。所有点评都保存到当前作者。');
        fields.connection=select([['main','复用酒馆主连接'],['custom','独立副 API（OpenAI 兼容）']],s.connection);connection.append(field('写作点评默认 API',fields.connection));fields.plotConnection=select([['main','主 API'],['custom','副 API']],s.plotConnection??'main');connection.append(field('剧情点评默认 API',fields.plotConnection));
        const custom=el('div');fields.endpoint=input(s.endpoint);fields.model=input(s.model);const key=input('','password');key.autocomplete='off';key.placeholder=a.host.key?'已保存在本设备；留空保留':'仅保存在本设备，不随导出同步';custom.append(field('独立 API 地址（支持 /v1 或完整 /chat/completions）',fields.endpoint),field('独立模型名称',fields.model),field('独立 API Key',key),this.button('清除本设备 API Key',async()=>{await a.host.setKey('');key.value='';}));
        const showCustom=()=>{custom.hidden=fields.connection.value!=='custom'&&fields.plotConnection.value!=='custom';};fields.connection.addEventListener('change',showCustom);fields.plotConnection.addEventListener('change',showCustom);showCustom();connection.append(custom);
        const values=()=>({...s,...Object.fromEntries(Object.entries(fields).map(([k,n])=>[k,n.type==='checkbox'?n.checked:n.type==='number'?Number(n.value):n.value]))});
        connection.append(this.button('测试点评连接',()=>a.testConnection(values(),key.value||a.host.key)),el('p','测试使用当前表单，不提交故事；测试成功后请保存设置。独立 API 需允许浏览器跨域，Key 仅在本设备保存。','bbp-hint'));this.content.append(connection);
        const rules=this.section('生成与审阅');fields.mode=select([['semi','半自动：重要变更先审阅'],['auto','全自动：自动修改全部未保护资料'],['manual','全手动：只按按钮运行，变更先审阅']],s.mode);rules.append(field('编辑权限',fields.mode));
        for(const [k,label] of [['enabled','启用 BBPresets']]){fields[k]=check(s[k]);rules.append(field(label,fields[k]));}
        const number=(container,k,label,min,max)=>{const n=fields[k]=input(s[k],'number');n.min=min;n.max=max;container.append(field(label,n));};
        number(rules,'feedbackThreshold','积累多少条待发送点评后总结',1,100);this.content.append(rules);
        const budget=el('details','','bbp-card');budget.append(el('summary','上下文预算与等待时长'));
        for(const [k,label,min,max] of [['maxInputChars','点评材料字符预算（不含固定指令）',2000,150000],['injectionChars','正文注入字符预算',500,40000],['timeoutSeconds','主 API 慢响应提醒 / 副 API 超时（秒）',10,300]])number(budget,k,label,min,max);
        budget.append(el('p','主 API 超过此时长继续等待原请求；副 API 超时会取消当次请求。短暂网络故障最多重试两次。','bbp-hint'));this.content.append(budget);
        const appearance=this.section('界面 · 本设备');const showBall=check(this.ui.showBall);showBall.addEventListener('change',()=>this.setBallVisible(showBall.checked));appearance.append(field('显示悬浮球（本设备，立即生效）',showBall),this.button('重置悬浮球位置',()=>{showBall.checked=true;return this.resetBall();}));this.content.append(appearance);
        const save=this.button('保存设置',async()=>{await a.saveSettings(values(),s);Object.assign(s,copy(a.settings));if(key.value)await a.host.setKey(key.value);key.value='';return '设置已保存';});save.classList.add('bbp-primary');this.content.append(save,this.button('载入已保存设置',()=>this.render()));
    }
    prompts(){
        const a=this.app;this.content.append(el('h2','全部提示词'),el('p','逐条展开后可编辑并保存。{{material}} 等占位符会填入本次资料；编辑不会解除保护或格式校验。提示词随账户保存，导出仅含提示词。'));
        this.content.append(el('p','v0.5.8 使用独立的作者/灵感说明与 version:4 灵感协议。旧大纲和正文模板保留在导出文件中，不再调用。','bbp-hint'));
        const file=input('','file');file.accept='.json,application/json';
        this.content.append(this.button('导出整套提示词',()=>download(a.exportPromptSet(),'BBPresets-prompts-v0.5.8.json')),field('导入提示词文件',file),this.button('导入并保存提示词',async()=>{assert(file.files[0]&&file.files[0].size<1000000,'请选择小于 1 MB 的提示词 JSON 文件');const result=await a.importPromptSet(JSON.parse(await file.files[0].text()));this.promptDrafts={};this.render();return result;}));
        const promptGroups=[['通用规则',['system','authorContract']],['划线评',['feedback','plotAuthorFeedback']],['正文与灵感',['inspirationInjection','inspirationControl']],['连接',['connectionTest']]];
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
        if(a.profile){const scopes=[['profile','默认作者与账户设置'],...(a.author.data.id!=='profile'?[[a.author.data.id,'当前作者']]:[]),...(a.inspiration?[[a.inspiration.data.id,'当前灵感']]:[])],target=select(scopes,this.versionTarget??a.inspiration?.data.id??'profile');if(!target.value)target.value='profile';target.addEventListener('change',()=>{this.versionTarget=target.value;this.render();});const id=target.value,versions=a.repo.index.documents[id]?.history??[],picker=select(versions.map((v,i)=>[String(i),`版本 ${v.revision} · ${when(v.at)}`]));this.content.append(field('恢复作用域',target),field('历史版本',picker),this.button('查看所选版本内容',async()=>{assert(versions.length,'尚无历史版本');const epoch=a.epoch,version=await a.repo.loadVersion(id,versions[Number(picker.value)]);assert(epoch===a.epoch,'故事已切换，请重新查看版本');const card=el('section','','bbp-card');card.append(el('h3',`版本 ${version.revision} · 资料内容`));for(const r of version.data.records)card.append(el('h4',r.title),el('pre',body(r)));this.content.append(card);}),this.button('恢复所选版本',async()=>{assert(versions.length,'尚无历史版本');await a.restore(id,versions[Number(picker.value)]);this.render();}),el('p','恢复会新建版本，保留已有历史和点评；当前保留文字若与旧版本冲突，恢复将停止。','bbp-hint'));}
        this.content.append(this.button('检查本设备未完成保存',async()=>{const rows=await a.recovery.list();const list=el('section','','bbp-card');list.append(el('h3',`待恢复副本 ${Object.keys(rows).length} 份`));for(const [id,p] of Object.entries(rows)){const archive={format:'bbpresets-export',schema:1,documents:[p.data]};list.append(el('p',`${p.data.title} · ${when(p.at)}`),this.button('导出此恢复副本',()=>download(archive,`BBPresets-recovery-${id}.json`)),this.button('恢复为独立副本',async()=>{await a.importArchive(archive);this.render();}));}this.content.append(list);}));
    }
    destroy(){this.destroyed=true;this.observer.disconnect();this.resizeObserver.disconnect();globalThis.removeEventListener('resize',this.onResize);globalThis.visualViewport?.removeEventListener('resize',this.onResize);globalThis.visualViewport?.removeEventListener('scroll',this.onResize);document.removeEventListener('keydown',this.onKey);document.removeEventListener('pointerup',this.onSelection);this.app.listeners.delete(this.onChange);this.surface.remove();this.entry.remove();}
}
function floorLabel(sources){const floors=[...new Set(sources.map(s=>s.floor).filter(Number.isInteger))].sort((a,b)=>a-b);return floors.length?'来源校验：'+(floors.length>6?`${floors[0]}—${floors.at(-1)} 楼，共 ${floors.length} 条`:floors.join('、')+' 楼'):'无聊天楼层';}
