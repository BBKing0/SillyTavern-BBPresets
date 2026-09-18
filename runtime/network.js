// Retries cover transport failures only. User cancellation and invalid responses never retry.
export function transient(error) {
    if(error?.retryable===false)return false;
    return error?.retryable === true || error?.name === 'TypeError' || error?.name === 'TimeoutError' || /fetch|network|load failed|connection reset|断网/i.test(error?.message ?? '');
}
export function networkError(message, retryable = true) {
    return Object.assign(new Error(message), {retryable});
}
export function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        const cleanup = () => {clearTimeout(timer);signal?.removeEventListener('abort', cancel);};
        const cancel = () => {cleanup();reject(new Error('请求已取消'));};
        const timer = setTimeout(() => {cleanup();resolve();}, ms);
        if (signal?.aborted) return cancel();
        signal?.addEventListener('abort', cancel, {once:true});
    });
}
export async function online(signal) {
    if (globalThis.navigator?.onLine !== false) return;
    await new Promise((resolve, reject) => {
        const cleanup = () => {globalThis.removeEventListener('online', resume);signal?.removeEventListener('abort', cancel);};
        const resume = () => {cleanup();resolve();};
        const cancel = () => {cleanup();reject(new Error('请求已取消'));};
        globalThis.addEventListener('online', resume, {once:true});
        signal?.addEventListener('abort', cancel, {once:true});
        if (signal?.aborted) cancel();
        else if (globalThis.navigator?.onLine !== false) resume();
    });
}
export async function retryRequest(request, {signal, timeoutSeconds=90, retries=2, onState=()=>{}, wait=delay, waitOnline=online}={}) {
    for (let attempt=0; ; attempt++) {
        if (signal?.aborted) throw new Error('请求已取消');
        onState(globalThis.navigator?.onLine===false?'网络已断开，等待恢复':'正在请求模型');
        await waitOnline(signal);
        const controller=new AbortController();let timedOut=false;
        const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
        const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutSeconds*1000);
        try {
            const result=await request(controller.signal,attempt);
            if(signal?.aborted)throw new Error('请求已取消');
            if(timedOut)throw networkError('模型响应超时');
            return result;
        } catch(error) {
            if(signal?.aborted)throw new Error('请求已取消');
            if(timedOut)error=networkError('模型响应超时');
            if(!transient(error)||attempt>=retries)throw error;
            onState(`连接暂时中断，正在重试 ${attempt+1}/${retries}；输入已保留`);
        } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
        await wait(1000*2**attempt,signal);
    }
}
