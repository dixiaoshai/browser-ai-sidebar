/**
 * Service worker：负责打开对话面板、转发消息、右键菜单和本地对话存储。
 * 不发起模型请求（请求都在对话页面里直接发）。
 *
 * 两种呈现方式（设置里可切换，默认浏览器侧边栏）：
 *   side   —— Chrome 原生 sidePanel（固定在右侧，默认模式）
 *   bottom —— 内容脚本在页面底部注入 dock，对话页用 iframe 加载（可选模式）
 */

const MENU_EXPLAIN = 'ai-sidebar-explain-selection';
const MENU_OPEN_SIDE_PANEL = 'ai-sidebar-open-side-panel';
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
    id: MENU_OPEN_SIDE_PANEL,
    title: '打开 AI 侧边栏',
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

  if (info.menuItemId === MENU_OPEN_SIDE_PANEL) {
    openSidePanel(tab.id);
    return;
  }

  if (info.menuItemId === MENU_EXPLAIN) {
    const text = String(info.selectionText || '').trim().slice(0, MAX_SELECTION);
    if (!text) return;
    openPanel(tab.id);
    queueSelection(text).catch(() => {});
  }
});

// 同一个对话由多个面板共享；串行读写，避免并行回复覆盖彼此或在清空后恢复旧消息。
let storageWrites = Promise.resolve();
function serializeStorage(task) {
  const write = storageWrites.then(task);
  storageWrites = write.catch(() => {});
  return write;
}

async function queueSelection(text) {
  await serializeStorage(() => chrome.storage.local.set({ pendingSelection: { text, at: Date.now() } }));
  broadcast({ type: 'SELECTION', pending: true });
}

function takePendingSelection() {
  return serializeStorage(async () => {
    const { pendingSelection } = await chrome.storage.local.get('pendingSelection');
    if (!pendingSelection) return null;
    await chrome.storage.local.remove('pendingSelection');
    return pendingSelection;
  });
}

function updateChatHistory({ action, turnId, content }) {
  return serializeStorage(async () => {
    if (action === 'clear') {
      await chrome.storage.local.remove(['chatHistory', 'pendingSelection']);
      return [];
    }

    const { chatHistory } = await chrome.storage.local.get('chatHistory');
    const messages = Array.isArray(chatHistory) ? chatHistory : [];
    if (action === 'start') {
      messages.push({ turnId, role: 'user', content });
    } else {
      const index = messages.findIndex((item) => item.turnId === turnId && item.role === 'user');
      if (index === -1 || messages[index + 1]?.turnId === turnId) return messages;
      messages.splice(index + 1, 0, { turnId, role: 'assistant', content });
    }
    await chrome.storage.local.set({ chatHistory: messages });
    return messages;
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  const fromPanel = sender.url?.split('?')[0] === chrome.runtime.getURL('sidepanel/index.html');
  if (message.type === 'TAKE_PENDING_SELECTION' && fromPanel) {
    takePendingSelection().then(sendResponse, () => sendResponse(null));
    return true;
  }

  if (message.type === 'UPDATE_CHAT_HISTORY' && fromPanel) {
    const { action, turnId, content } = message;
    if (action !== 'clear' && !(
      (action === 'start' || action === 'finish') &&
      typeof turnId === 'string' && turnId && typeof content === 'string' && content
    )) return;
    updateChatHistory(message).then(
      (messages) => sendResponse({ ok: true, messages }),
      () => sendResponse({ ok: false })
    );
    return true;
  }

  if (message.type === 'ASK_SELECTION') {
    const text = String(message.text || '').trim().slice(0, MAX_SELECTION);
    if (!text) return;
    const tabId = sender?.tab?.id;
    openPanel(tabId);
    queueSelection(text).catch(() => {});
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
