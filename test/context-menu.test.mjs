import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';

const worker = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');

for (const panelMode of ['side', 'bottom']) {
  test(`页面右键在 ${panelMode} 模式下只打开原生侧边栏`, async () => {
    const listeners = {};
    const menus = [];
    const calls = [];
    const event = (name) => ({ addListener: (callback) => { listeners[name] = callback; } });
    const chrome = {
      action: { onClicked: event('action') },
      contextMenus: {
        removeAll: async () => { menus.length = 0; },
        create: (menu) => menus.push(menu),
        onClicked: event('menuClick')
      },
      runtime: {
        onInstalled: event('installed'),
        onStartup: event('startup'),
        onMessage: event('message'),
        sendMessage: async ({ type }) => { calls.push(['runtime', type]); }
      },
      sidePanel: {
        open: async ({ tabId }) => { calls.push(['side', tabId]); },
        setPanelBehavior: async () => {}
      },
      storage: {
        local: { get: async () => ({ settings: { panelMode } }) },
        onChanged: event('storage')
      },
      tabs: { sendMessage: async (_tabId, { type }) => { calls.push(['tab', type]); } }
    };
    runInNewContext(worker, { chrome });
    listeners.installed();
    await setImmediate();
    const pageMenus = menus.filter(({ contexts }) => contexts.includes('page'));
    assert.deepEqual(pageMenus.map(({ title }) => title), ['打开 AI 侧边栏']);
    assert.ok(menus.some(({ contexts, title }) =>
      contexts.includes('selection') && title === '用 AI 解读选中内容'));

    listeners.menuClick({ menuItemId: pageMenus[0].id }, { id: 42 });
    await Promise.resolve();
    assert.deepEqual(calls, [['side', 42]]);
  });
}
