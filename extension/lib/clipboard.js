/**
 * 复制文本到剪贴板（依赖可注入，方便在 Node 里单测）。
 *
 * 两条路径：
 *   1. navigator.clipboard.writeText —— 现代浏览器的首选，扩展页面 / 有用户手势时可用
 *   2. 隐藏 textarea + document.execCommand('copy') —— 兜底：底部 dock 是跨域 iframe，
 *      权限策略、旧内核或 Clipboard API 被拒时还能用
 *
 * 返回 true / false，调用方据此给「已复制 / 复制失败」反馈。
 */
export async function copyText(text, deps = {}) {
  const value = String(text ?? '');
  if (!value) return false;

  const nav = 'navigator' in deps ? deps.navigator : globalThis.navigator;
  const doc = 'document' in deps ? deps.document : globalThis.document;

  try {
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      await nav.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* Clipboard API 被拒（无权限 / 未聚焦 / 跨域 iframe），继续走兜底 */
  }

  const execCommand =
    typeof deps.execCommand === 'function'
      ? deps.execCommand
      : doc && typeof doc.execCommand === 'function'
        ? doc.execCommand.bind(doc)
        : null;
  if (!doc || typeof doc.createElement !== 'function' || !execCommand) return false;

  let textarea = null;
  try {
    textarea = doc.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
    const host = doc.body || doc.documentElement;
    if (!host || typeof host.appendChild !== 'function') return false;
    host.appendChild(textarea);
    if (typeof textarea.select === 'function') textarea.select();
    if (typeof textarea.setSelectionRange === 'function') {
      textarea.setSelectionRange(0, value.length);
    }
    return !!execCommand('copy');
  } catch {
    return false;
  } finally {
    if (textarea && typeof textarea.remove === 'function') textarea.remove();
  }
}
