// Panel styles are loaded only inside our ShadowRoots. Host entry CSS is separate.
export const STYLE_URL = new URL('../style.css?v=0.5.4', import.meta.url).href;
export function loadStyle(root,entry=false) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = entry?new URL('../entry.css?v=0.5.4',import.meta.url).href:STYLE_URL;
    const ready = new Promise((resolve, reject) => {
        link.onload = resolve;
        link.onerror = () => reject(Error('BBPresets 样式加载失败，请更新扩展并完整刷新页面。'));
    });
    root.append(link);
    return {link, ready};
}

export function clampPosition(position, bounds, size) {
    const clamp = (value, min, max) => Math.max(min, Math.min(Math.max(min, max), value));
    return {
        left: clamp(position.left, bounds.left, bounds.right - size.width),
        top: clamp(position.top, bounds.top, bounds.bottom - size.height),
    };
}
