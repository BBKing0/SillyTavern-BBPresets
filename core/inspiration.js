import {copy,newDocument,validateDocument} from './model.js';

// Copy only inspiration state. The retired story and its server versions stay intact.
export function inspirationFrom(source,{id,title}={}) {
    const next=newDocument('inspiration',title??source.title+' · 灵感',id);
    const ids=new Set(source.records.filter(r=>r.kind==='inspiration').map(r=>r.id));
    for(const h of source.history)for(const c of h.changes)if(c.before?.kind==='inspiration'||c.after?.kind==='inspiration')ids.add(c.id);
    next.records=copy(source.records.filter(r=>r.kind==='inspiration'));
    next.history=copy(source.history.map(h=>({...h,changes:h.changes.filter(c=>ids.has(c.id)).map(c=>({...c,before:c.before?.kind==='inspiration'?c.before:null,after:c.after?.kind==='inspiration'?c.after:null}))})).filter(h=>h.changes.length));
    next.processed=next.history.map(h=>h.key);
    next.excluded=source.excluded.filter(id=>ids.has(id));
    next.conflicts=copy(source.conflicts.filter(c=>ids.has(c.recordId)));
    next.controls=copy((source.controls??[]).filter(c=>[3,4].includes(c.version))).map(c=>({...c,version:4,chapter:null,nextIds:[],updatedNodeIds:[]}));
    if(source.type==='story')next.legacySourceId=source.id;
    return validateDocument(next);
}

export function retireTasks(doc) {
    const next=copy(doc),obsolete=j=>!['profile','author'].includes(next.type)||j.kind!=='feedback';
    const retired=[...next.jobs.filter(obsolete),...next.proposals.filter(obsolete)];
    if(retired.length)next.retiredTasks=[...(next.retiredTasks??[]),...retired.map(j=>({...j,state:'retired'}))];
    next.jobs=next.jobs.filter(j=>!obsolete(j));next.proposals=next.proposals.filter(j=>!obsolete(j));
    return validateDocument(next);
}
