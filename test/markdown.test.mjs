import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, escapeHtml } from '../extension/lib/markdown.js';

test('转义模型输出里的 HTML，防注入', () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)"> & <script>alert(2)</script>');
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<script'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

test('围栏代码块保留原文且不被后续格式规则破坏', () => {
  const html = renderMarkdown('说明：\n```js\nconst a = 1 * 2 * 3;\nif (a < 10) { console.log("**hi**"); }\n```\n结束');
  assert.match(html, /<pre class="md-pre"><code>/);
  assert.match(html, /const a = 1 \* 2 \* 3;/);
  assert.match(html, /\*\*hi\*\*/);
  assert.ok(html.includes('&lt; 10'));
});

test('行内代码、粗体、标题、列表', () => {
  const html = renderMarkdown('## 小节\n- 第一条\n- 第二条\n\n1. 甲\n2. 乙\n\n调用 `streamChat()`，注意 **重要**。');
  assert.match(html, /md-h3/);
  assert.match(html, /<ul class="md-ul"><li>第一条<\/li><li>第二条<\/li><\/ul>/);
  assert.match(html, /<ol class="md-ol"><li>甲<\/li><li>乙<\/li><\/ol>/);
  assert.match(html, /<code class="md-code">streamChat\(\)<\/code>/);
  assert.match(html, /<strong>重要<\/strong>/);
});

test('只放行 http(s) 链接，javascript: 不会被渲染成可点链接', () => {
  const ok = renderMarkdown('见 [文档](https://example.com/a?b=1)');
  assert.match(ok, /<a href="https:\/\/example.com\/a\?b=1" target="_blank" rel="noopener noreferrer">文档<\/a>/);

  const bad = renderMarkdown('[点我](javascript:alert(1))');
  assert.ok(!bad.includes('<a '));
  assert.ok(bad.includes('javascript:alert(1)'));
});

test('流式中间态（未闭合代码块）不抛异常', () => {
  assert.doesNotThrow(() => renderMarkdown('```js\nconst a = 1'));
  assert.doesNotThrow(() => renderMarkdown(''));
  assert.doesNotThrow(() => renderMarkdown(null));
  assert.equal(renderMarkdown(null), '');
});

test('escapeHtml 覆盖五个敏感字符', () => {
  assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
});
