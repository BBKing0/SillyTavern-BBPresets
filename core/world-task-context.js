const MAX_FLOOR = 1_000_000;
const MAX_SELECTED_FLOORS = 200;
const MAX_EXPRESSION_CHARS = 2000;
const ensure = (condition,message) => {if(!condition)throw Error(message);};

// Floors use the host's actual zero-based chat indexes, including gaps left by hidden system rows.
export function parseWorldTaskFloors(value) {
    ensure(typeof value==='string'&&value.length<=MAX_EXPRESSION_CHARS,'世界任务楼层范围须为最多 2000 字符的文字');
    if(!value.trim())return [];
    const selected=new Set();
    for(const part of value.split(/[,，]/)){
        const match=part.trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
        ensure(match,'世界任务楼层范围格式无效；请填写非负整数或范围，例如 31-36,20,22-24');
        const start=Number(match[1]),end=Number(match[2]??match[1]);
        ensure(Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start<=MAX_FLOOR&&end<=MAX_FLOOR,'世界任务楼层须为 0—1000000 的整数');
        ensure(start<=end,'世界任务楼层范围起点不能大于终点');
        ensure(end-start+1<=MAX_SELECTED_FLOORS,'世界任务正文一次最多选择 200 层');
        for(let floor=start;floor<=end;floor++){
            selected.add(floor);
            ensure(selected.size<=MAX_SELECTED_FLOORS,'世界任务正文一次最多选择 200 层');
        }
    }
    return [...selected].sort((a,b)=>a-b);
}

export function selectWorldTaskContext(context,settings={}, {cutoff=Infinity}={}) {
    const mode=settings.worldTaskContextMode??'recent';
    ensure(['recent','none','custom'].includes(mode),'世界任务正文上下文方式无效');
    if(mode==='none')return [];
    ensure(cutoff===Infinity||Number.isSafeInteger(cutoff)&&cutoff>=0,'世界任务正文截止楼层无效');
    const rows=(context?.rows??[])
        .filter(row=>Number.isSafeInteger(row.floor)&&row.floor>=0&&row.floor<=cutoff&&['user','assistant'].includes(row.role)&&typeof row.text==='string')
        .map(row=>({floor:row.floor,role:row.role,text:row.text.replace(/\[BBP_CONTROL\][\s\S]*?(?:\[\/BBP_CONTROL\]|$)/g,'').trimEnd()}))
        .filter(row=>row.text.trim());
    if(mode==='recent')return rows.slice(-6);
    const floors=parseWorldTaskFloors(settings.worldTaskContextFloors??'');
    ensure(floors.length,'请填写世界任务要注入的正文楼层；不需要正文时请选择“不注入正文”');
    const byFloor=new Map(rows.map(row=>[row.floor,row])),missing=floors.filter(floor=>!byFloor.has(floor));
    ensure(!missing.length,`世界任务所选楼层不可用：${missing.join(', ')}；请检查是否存在、属于正文且未超过本次截止楼层`);
    return floors.map(floor=>byFloor.get(floor));
}
