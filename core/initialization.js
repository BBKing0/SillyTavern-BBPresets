import {assert,copy,uid} from './model.js';

export function newDraft(chatKey) {
    return {chatKey,questions:[],previous:[],notes:'',cursor:0,updatedAt:Date.now()};
}
export function questionSet(draft, questions, mode='replace') {
    const next=copy(draft);
    if(mode==='replace') {
        next.previous.push(...next.questions.filter(q=>q.answer.trim()));
        next.questions=[];next.cursor=0;
    } else next.cursor=next.questions.length;
    next.questions.push(...questions.map(q=>({...q,id:uid(),answer:''})));
    next.updatedAt=Date.now();delete next.request;
    return next;
}
export function draftAnswers(draft) {
    return [...draft.previous,...draft.questions].map(q=>`问题：${q.question}\n用户回答：${q.answer||'（未回答，不推断偏好）'}`).join('\n\n')+'\n用户自由补充：\n'+draft.notes;
}
export function validateDraft(draft) {
    assert(draft&&typeof draft.chatKey==='string'&&draft.chatKey.length<=500&&Array.isArray(draft.questions)&&Array.isArray(draft.previous),'初始化草稿归属无效');
    assert(typeof draft.notes==='string'&&Number.isInteger(draft.cursor)&&Number.isFinite(draft.updatedAt),'初始化草稿格式无效');
    const ids=new Set();
    for(const q of [...draft.previous,...draft.questions]) {
        assert(q&&typeof q.id==='string'&&!ids.has(q.id)&&typeof q.question==='string'&&typeof q.example==='string'&&typeof q.answer==='string','初始化问答格式无效');ids.add(q.id);
    }
    return draft;
}
