// Extract one complete JSON value. Never evaluate model output or invent missing data.
export function responseText(raw) {
    if (typeof raw === 'string') return raw;
    const value = raw?.text ?? raw?.choices?.[0]?.message?.content;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.filter(x => x?.type === 'text' && typeof x.text === 'string').map(x => x.text).join('\n');
    return '';
}

export function parseModelJSON(raw, label = '模型响应') {
    let source = responseText(raw).replace(/^\uFEFF/, '').trim();
    if (!source || source.length > 200000) throw Error(`${label}缺失或超过 20 万字符，结果未应用`);
    source = source.replace(/^<(think|thinking|analysis)>[\s\S]*?<\/\1>\s*/i, '').trim();
    try { return JSON.parse(source); } catch { /* Look for a complete fenced or prose-wrapped value. */ }
    const candidates = [];
    let start = -1, depth = 0, quoted = false, escaped = false;
    for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        if (start < 0) { if (ch === '{' || ch === '[') { start = i; depth = 1; } continue; }
        if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; continue; }
        if (ch === '"') quoted = true;
        else if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') {
            if (--depth === 0) {
                try { candidates.push(JSON.parse(source.slice(start, i + 1))); } catch { /* Invalid candidates remain invalid. */ }
                start = -1;
            }
        }
    }
    if (candidates.length === 1 && start < 0) return candidates[0];
    throw Error(`${label}无法解析 JSON${start >= 0 ? '（内容可能被截断）' : candidates.length > 1 ? '（存在多个结果，无法确定）' : ''}，结果未应用；回答已保留，可查看响应后重试`);
}
