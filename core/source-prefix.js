import {sha256} from './digest.js';

// A fixed-size digest per message preserves full-history invalidation without
// copying the entire growing chat into every control receipt. Chat keys are
// deliberately excluded so an inherited prefix can be remapped to an if branch.
export function sourcePrefixes(sources) {
    const result=new Map(),encoder=new TextEncoder();let prefix='bbpresets-sources-v1';
    for(const source of sources){prefix=sha256(encoder.encode(JSON.stringify([prefix,source.id,source.hash])));result.set(source.id,prefix);}
    return result;
}
