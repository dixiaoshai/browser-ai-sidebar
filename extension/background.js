/**
 * Service worker：负责“打开对话面板 + 转发消息 + 右键菜单”。
 * 不碰用户数据，也不发起任何模型请求（请求都在对话页面里直接发）。
 *
 * 两种呈现方式（设置里可切换，默认浏览器侧边栏）：
 *   side   —— Chrome 原生 sidePanel（固定在右侧，默认模式）
 *   bottom —— 内容脚本在页面底部注入 dock，对话页用 iframe 加载（可选模式）
 */

const MENU_EXPLAIN = 'ai-sidebar-explain-selection';
const MENU_SUMMARIZE = 'ai-sidebar-summarize-page';
const MAX_SELECTION = 6000;

// 面板模式缓存：让用户手势（工具栏点击、右键菜单等）能同步决策，不用先 await storage
let cachedPanelMode = 'side';

function broadcast(payload) {
  // 面板没打开时没有接收方，会 reject，属正常情况
  return chrome.runtime.sendMessage(payload).catch(() => {});
}

/** 打开原生侧边栏，resolve true/false（调用方据此决定是否收起底部面板） */
function openSidePanel(tabId) {
  if (typeof tabId !== 'number') return Promise.resolve(false);
  try {
    // 尽量同步调用，保住用户手势
    return chrome.sidePanel.open({ tabId }).then(
      () => true,
      (error) => {
        console.warn('[ai-sidebar] 打开侧边栏失败：', error);
        return false;
      }
    );
  } catch (error) {
    console.warn('[ai-sidebar] 打开侧边栏异常：', error);
    return Promise.resolve(false);
  }
}

/** 底部模式：让内容脚本展开 dock；页面没有内容脚本时退回原生侧边栏 */
function openBottomPanel(tabId) {
  if (typeof tabId !== 'number') return Promise.resolve();
  return chrome.tabs
    .sendMessage(tabId, { type: 'OPEN_DOCK' })
    .catch(() => openSidePanel(tabId));
}

function toggleBottomPanel(tabId) {
  if (typeof tabId !== 'number') return Promise.resolve();
  return chrome.tabs
    .sendMessage(tabId, { type: 'TOGGLE_DOCK' })
    .catch(() => openSidePanel(tabId));
}

/** 按当前模式打开对话面板（默认走原生侧边栏，底部为可选模式） */
function openPanel(tabId) {
  if (cachedPanelMode === 'bottom') return openBottomPanel(tabId);
  return openSidePanel(tabId);
}

function applyPanelBehavior() {
  // 侧边栏模式交给浏览器原生处理（用户手势最稳）；底部模式由 action.onClicked 接管
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: cachedPanelMode !== 'bottom' })
    .catch(() => {});
}

async function refreshCachedMode() {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    cachedPanelMode = settings && settings.panelMode === 'bottom' ? 'bottom' : 'side';
  } catch {
    cachedPanelMode = 'side';
  }
  applyPanelBehavior();
}

async function setupMenus() {
  try {
    await chrome.contextMenus.removeAll();
  } catch {
    /* ignore */
  }
  chrome.contextMenus.create({
    id: MENU_EXPLAIN,
    title: '用 AI 解读选中内容',
    contexts: ['selection']
  });
  chrome.contextMenus.create({
    id: MENU_SUMMARIZE,
    title: '用 AI 总结本页',
    contexts: ['page']
  });
}

chrome.runtime.onInstalled.addListener(() => {
  setupMenus();
  refreshCachedMode();
});

chrome.runtime.onStartup.addListener(() => {
  setupMenus();
  refreshCachedMode();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const next = changes.settings.newValue || {};
  cachedPanelMode = next.panelMode === 'bottom' ? 'bottom' : 'side';
  applyPanelBehavior();
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab || typeof tab.id !== 'number') return;
  if (cachedPanelMode === 'bottom') {
    toggleBottomPanel(tab.id);
    return;
  }
  openSidePanel(tab.id);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || typeof tab.id !== 'number') return;

  if (info.menuItemId === MENU_SUMMARIZE) {
    openPanel(tab.id);
    broadcast({ type: 'SUMMARIZE_PAGE' });
    return;
  }

  if (info.menuItemId === MENU_EXPLAIN) {
    const text = String(info.selectionText || '').trim().slice(0, MAX_SELECTION);
    if (!text) return;
    openPanel(tab.id);
    chrome.storage.local
      .set({ pendingSelection: { text, at: Date.now() } })
      .catch(() => {});
    broadcast({ type: 'SELECTION', text });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  if (message.type === 'ASK_SELECTION') {
    const text = String(message.text || '').trim().slice(0, MAX_SELECTION);
    if (!text) return;
    const tabId = sender?.tab?.id;
    openPanel(tabId);
    chrome.storage.local.set({ pendingSelection: { text, at: Date.now() } }).catch(() => {});
    broadcast({ type: 'SELECTION', text });
    return;
  }

  if (message.type === 'OPEN_SIDE_PANEL') {
    // 内容脚本（底部 dock 的「侧边栏」按钮）用 sender.tab；扩展页面自己调用时显式传 tabId
    const tabId = typeof sender?.tab?.id === 'number' ? sender.tab.id : message.tabId;
    const opened = openSidePanel(tabId); // 同步发起，保住用户手势
    if (message.switchMode) {
      opened.then((ok) => {
        if (!ok) return;
        chrome.storage.local
          .get('settings')
          .then(({ settings }) =>
            chrome.storage.local.set({ settings: { ...(settings || {}), panelMode: 'side' } })
          )
          .catch(() => {});
      });
    }
    // 异步回执：dock 只有确认侧边栏真的打开了，才收起自己
    opened.then((ok) => sendResponse({ ok })).catch(() => sendResponse({ ok: false }));
    return true;
  }
});

// 冷启动时同步一次模式（不阻塞监听器注册）
refreshCachedMode();
