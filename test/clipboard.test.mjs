import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyText } from '../extension/lib/clipboard.js';

/** 构造最小 document / textarea 桩，记录兜底路径的调用 */
function fakeDocument({ execCommandResult = true } = {}) {
  const calls = { createElement: [], appendChild: [], select: 0, setSelectionRange: [], remove: 0, execCommand: [] };
  const textarea = {
    value: '',
    style: { cssText: '' },
    attrs: {},
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    select() {
      calls.select += 1;
    },
    setSelectionRange(start, end) {
      calls.setSelectionRange.push([start, end]);
    },
    remove() {
      calls.remove += 1;
    }
  };
  const doc = {
    body: {
      appendChild(element) {
        calls.appendChild.push(element);
      }
    },
    createElement(tag) {
      calls.createElement.push(tag);
      return textarea;
    },
    execCommand(command) {
      calls.execCommand.push(command);
      return execCommandResult;
    }
  };
  return { doc, calls, textarea };
}

test('复制回答：优先使用 navigator.clipboard.writeText', async () => {
  const written = [];
  const ok = await copyText('## 结论\n**量子计算**仍处于早期阶段。', {
    navigator: { clipboard: { writeText: async (text) => written.push(text) } },
    document: null
  });
  assert.equal(ok, true);
  assert.deepEqual(written, ['## 结论\n**量子计算**仍处于早期阶段。']);
});

test('Clipboard API 抛错（跨域 iframe 权限策略）时退回 execCommand', async () => {
  const { doc, calls, textarea } = fakeDocument();
  const ok = await copyText('回答 **原文**', {
    navigator: {
      clipboard: {
        writeText: async () => {
          throw new Error('NotAllowedError');
        }
      }
    },
    document: doc
  });
  assert.equal(ok, true);
  assert.deepEqual(calls.execCommand, ['copy']);
  assert.equal(textarea.value, '回答 **原文**');
  assert.equal(textarea.attrs.readonly, '');
  assert.deepEqual(calls.setSelectionRange, [[0, '回答 **原文**'.length]]);
  assert.equal(calls.remove, 1);
});

test('环境没有 Clipboard API 时也走 execCommand 兜底', async () => {
  const { doc, calls, textarea } = fakeDocument();
  const ok = await copyText('兜底文本', { navigator: {}, document: doc });
  assert.equal(ok, true);
  assert.deepEqual(calls.execCommand, ['copy']);
  assert.equal(textarea.value, '兜底文本');
});

test('两条路径都失败时返回 false，且 textarea 被清理', async () => {
  const { doc, calls } = fakeDocument({ execCommandResult: false });
  const ok = await copyText('复制不了', {
    navigator: {
      clipboard: {
        writeText: async () => {
          throw new Error('denied');
        }
      }
    },
    document: doc
  });
  assert.equal(ok, false);
  assert.deepEqual(calls.execCommand, ['copy']);
  assert.equal(calls.remove, 1);
});

test('空内容不写剪贴板（流式生成中复制按钮不应该生效）', async () => {
  const written = [];
  const nav = { clipboard: { writeText: async (text) => written.push(text) } };
  const { doc, calls } = fakeDocument();
  for (const value of ['', null, undefined]) {
    assert.equal(await copyText(value, { navigator: nav, document: doc }), false);
  }
  assert.deepEqual(written, []);
  assert.deepEqual(calls.createElement, []);
});

test('既没有 Clipboard API 也没有 DOM 时返回 false，不抛异常', async () => {
  assert.equal(await copyText('x', { navigator: {}, document: null }), false);
});
