/**
 * 极简 Markdown 渲染（纯函数，可单测）。
 * 设计取舍：先转义再套格式，保证模型输出里的 HTML 不会被执行；
 * 只支持问答场景够用的子集：代码块、行内代码、标题、粗体、链接、无序/有序列表。
 */

export function escapeHtml(input) {
  return String(input).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

const PLACEHOLDER = /\u0000B(\d+)\u0000/g;

export function renderMarkdown(source) {
  if (source === undefined || source === null) return '';
  const blocks = [];

  // 1. 先把围栏代码块抽出来，避免里面的符号被后续规则误伤
  let text = String(source).replace(/```[ \t]*([\w+#.-]*)[ \t]*\n?([\s\S]*?)```/g, (_match, _lang, code) => {
    const index = blocks.length;
    blocks.push(`<pre class="md-pre"><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000B${index}\u0000`;
  });

  // 2. 转义其余内容
  let html = escapeHtml(text);

  // 3. 行内代码
  html = html.replace(/`([^`\n]+)`/g, '<code class="md-code">$1</code>');

  // 4. 标题
  html = html.replace(/^(#{1,4})[ \t]+(.+)$/gm, (_m, hashes, content) => {
    const level = hashes.length <= 2 ? 3 : 4;
    return `<div class="md-h md-h${level}">${content.trim()}</div>`;
  });

  // 5. 粗体 / 斜体
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[\s(（])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  // 6. 链接：只放行 http(s)
  html = html.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // 7. 列表：把连续的列表行包成 <ul> / <ol>
  html = html.replace(/(?:^[ \t]*[-*+][ \t]+.+(?:\n|$))+/gm, (block) => {
    const items = block
      .replace(/\n$/, '')
      .split('\n')
      .map((line) => line.replace(/^[ \t]*[-*+][ \t]+/, ''));
    return `<ul class="md-ul">${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;
  });
  html = html.replace(/(?:^[ \t]*\d+[.)][ \t]+.+(?:\n|$))+/gm, (block) => {
    const items = block
      .replace(/\n$/, '')
      .split('\n')
      .map((line) => line.replace(/^[ \t]*\d+[.)][ \t]+/, ''));
    return `<ol class="md-ol">${items.map((item) => `<li>${item}</li>`).join('')}</ol>`;
  });

  // 8. 还原代码块
  html = html.replace(PLACEHOLDER, (_m, index) => blocks[Number(index)] ?? '');

  return html;
}
