import {assert,uid} from '../core/model.js';

export const recordText=r=>r.blocks.map(b=>b.text).join(r.joiner??'\n\n');
export function simplifyRecord(r) {
    // Merge ordinary text only; existing protected anchors remain intact.
    const blocks=[];
    for(const block of r.blocks) {
        const last=blocks.at(-1);
        if(last&&!last.locked&&!block.locked)last.text+=(r.joiner??'\n\n')+block.text;
        else blocks.push({...block});
    }
    r.blocks=blocks;return r;
}
export function protectSelection(r, id, start, end) {
    let index=r.blocks.findIndex(b=>b.id===id);const block=r.blocks[index];
    assert(block&&!block.locked&&end>start,'先选中要保护的文字；手机也可以直接增加保护段');
    // Convert legacy separators to explicit text before splitting so no text is lost or added.
    const separator=r.joiner??'\n\n';
    if(separator)r.blocks=r.blocks.flatMap((b,i)=>i<r.blocks.length-1?[{...b},{id:uid(),text:separator,locked:false}]:[{...b}]);
    r.joiner='';index=r.blocks.findIndex(b=>b.id===id);
    const value=r.blocks[index].text,parts=[];
    if(start)parts.push({id:block.id,text:value.slice(0,start),locked:false});
    parts.push({id:uid(),text:value.slice(start,end),locked:true});
    if(end<value.length)parts.push({id:uid(),text:value.slice(end),locked:false});
    r.blocks.splice(index,1,...parts);return r;
}
