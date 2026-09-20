import {TavernHost} from './runtime/host.js';
import {BBPresetsApp} from './runtime/app.js';
import {Workbench} from './ui/workbench.js';
import {loadStyle} from './ui/surface.js';

// Host-owned extension loader invokes this registered interceptor before its model request.
let app,workbench,styleLink,destroyed=false,starting;
globalThis.bbPresetsInterceptor=async(_chat,_contextSize,_abort,type)=>{
    if(!app||destroyed)return;
    try{app.host.filterPrompt(_chat);await app.beforeGenerate(type);}catch(e){_abort?.(true);app.host.inject('');app.report(e);}
};
export async function start(){
    if(starting)return starting;
    starting=(async()=>{
        if(destroyed)return;
        const style=loadStyle(document.head);styleLink=style.link;
        await style.ready;
        if(destroyed)return;
        const host=new TavernHost();
        app=new BBPresetsApp(host,{notify:(message,kind)=>globalThis.toastr?.[kind]?.(message,'BBPresets',{escapeHtml:true})});
        workbench=new Workbench(app);
        try{await app.init();}catch(e){app.report(e);}
        document.addEventListener('visibilitychange',visibility);
        globalThis.addEventListener('pageshow',resume);
        globalThis.addEventListener('pagehide',pause);
        globalThis.addEventListener('beforeunload',leaving);
        globalThis.addEventListener('online',resume);
    })();return starting;
}
function pause(){app?.background();}
async function resume(){if(!app?.repo||destroyed||document.hidden)return;try{await app.resume();}catch(e){app.report(e);}}
function visibility(){if(document.hidden)pause();else void resume();}
function leaving(event){if(app?.status==='saving'||app?.running||app?.auxiliary||app?.preparing||app?.buildingInitialization||app?.draftEntry()?.dirty){event.preventDefault();event.returnValue='';}}
export function destroy(){destroyed=true;workbench?.destroy();styleLink?.remove();app?.destroy();document.removeEventListener('visibilitychange',visibility);globalThis.removeEventListener('pageshow',resume);globalThis.removeEventListener('pagehide',pause);globalThis.removeEventListener('beforeunload',leaving);globalThis.removeEventListener('online',resume);delete globalThis.bbPresetsInterceptor;}
// Extensions load after the host bootstrap; a small readiness retry also supports slower devices.
let tries=0;
function ready(){if(destroyed)return;if(!document.body||!globalThis.SillyTavern?.getContext){if(++tries<60)setTimeout(ready,500);else console.error('[BBPresets] 酒馆上下文未就绪，请刷新页面');return;}void start().catch(e=>{console.error('[BBPresets]',e);globalThis.toastr?.error(e.message,'BBPresets',{escapeHtml:true});});}
ready();
