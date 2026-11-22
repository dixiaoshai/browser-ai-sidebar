import { DEFAULT_SETTINGS, normalizeBaseUrl, streamChat, testConnection } from '../lib/openai.js';
import { renderMarkdown } from '../lib/markdown.js';
import { copyText } from '../lib/clipboard.js';

// 页面底部 dock 会以 iframe 方式加载本页（?embed=bottom）；原生侧边栏（默认）不带参数
const EMBED = new URLSearchParams(location.search).get('embed') === 'bottom';

const els = {
  messages: document.getElementById('messages'),
  input: document.getElementById('input'),
  sendBtn: document.getElementById('sendBtn'),
  stopBtn: document.getElementById('stopBtn'),
  summarizeBtn: document.getElementById('summarizeBtn'),
  translateBtn: document.getElementById('translateBtn'),
  refreshBtn: document.getElementById('refreshBtn'),
  clearBtn: document.getElementById('clearBtn'),
  settingsBtn: document.getElementById('settingsBtn'),
  pageTitle: document.getElementById('pageTitle'),
  attachPage: document.getElementById('attachPage'),
  hint: document.getElementById('hint'),
  modelTag: document.getElementById('modelTag'),
  dialog: document.getElementById('settingsDialog'),
  form: document.getElementById('settingsForm'),
  baseUrl: document.getElementById('baseUrl'),
  apiKey: document.getElementById('apiKey'),
  model: document.getElementById('model'),
  temperature: document.getElementById('temperature'),
  pageCharLimit: document.getElementById('pageCharLimit'),
  panelMode: document.getElementById('panelMode'),
  systemPrompt: document.getElementById('systemPrompt'),
  testBtn: document.getElementById('testBtn'),
  testResult: document.getElementById('testResult'),
  cancelBtn: document.getElementById('cancelBtn')
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  page: null, // { title, url, text, charCount }
  messages: [], // { turnId, role, content }
  historyChanges: 0,
  clearCount: 0,
  streaming: false,
  preparingTranslation: false,
  clearing: false,
  abort: null,
  activeTurn: null,
  lastSelectionKey: '',
  lastSelectionAt: 0,
  refreshTimer: 0
};

// ---------------------------------------------------------------- 设置

async function loadSettings() {
  const stored = await chrome.storage.local.get('settings');
  const saved = stored && stored.settings ? stored.settings : {};
  state.settings = { ...DEFAULT_SETTINGS, ...saved };
}

async function persistSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  await chrome.storage.local.set({ settings: state.settings });
  refreshModelTag();
  refreshHint();
}

function refreshModelTag() {
  els.modelTag.textContent = state.settings.model || '';
  els.modelTag.title = state.settings.model ? `模型：${state.settings.model}` : '未设置模型';
}

function openSettings() {
  els.baseUrl.value = state.settings.baseUrl || '';
  els.apiKey.value = state.settings.apiKey || '';
  els.model.value = state.settings.model || '';
  els.temperature.value = String(state.settings.temperature ?? 0.3);
  els.pageCharLimit.value = String(state.settings.pageCharLimit ?? 40000);
  els.panelMode.value = state.settings.panelMode === 'bottom' ? 'bottom' : 'side';
  els.systemPrompt.value = state.settings.systemPrompt || DEFAULT_SETTINGS.systemPrompt;
  els.testResult.textContent = '';
  els.testResult.className = 'test-result';
  if (!els.dialog.open) els.dialog.showModal();
  els.baseUrl.focus();
}

function readSettingsForm() {
  return {
    baseUrl: els.baseUrl.value.trim(),
    apiKey: els.apiKey.value.trim(),
    model: els.model.value.trim(),
    temperature: Number(els.temperature.value) || 0,
    pageCharLimit: Math.max(2000, Number(els.pageCharLimit.value) || 40000),
    panelMode: els.panelMode.value === 'bottom' ? 'bottom' : 'side',
    systemPrompt: els.systemPrompt.value.trim() || DEFAULT_SETTINGS.systemPrompt
  };
}

async function switchPanelMode(mode) {
  const tab = await activeTab();
  const tabId = tab && typeof tab.id === 'number' ? tab.id : null;

  // 切到「页面底部悬浮」：在当前标签页展开 dock（受限页面无法注入，提示回退侧边栏）
  if (mode === 'bottom') {
    let opened = false;
    if (tabId !== null) {
      const response = await chrome.tabs
        .sendMessage(tabId, { type: 'OPEN_DOCK' })
        .catch(() => null);
      opened = !!(response && response.ok);
    }
    appendNotice(
      opened
        ? '已切换为页面底部悬浮，面板已在本页底部展开。点「收起」或按 Esc 关闭。'
        : '已切换为页面底部悬浮；当前页面无法注入面板（如浏览器内部页），点工具栏图标时会自动回退到侧边栏。'
    );
    return;
  }

  // 切回「浏览器侧边栏」（默认模式）
  if (!EMBED) {
    appendNotice('已切换为浏览器侧边栏，点工具栏图标（Alt+Shift+A）打开。');
    return;
  }

  // 从底部 dock 切到原生侧边栏：先尝试直接打开；扩展页面若被浏览器限制，
  // 再交给 background 试一次。打开成功后才收起 dock，失败时保留底部面板可用。
  let opened = false;
  if (tabId !== null) {
    try {
      await chrome.sidePanel.open({ tabId });
      opened = true;
    } catch {
      const response = await chrome.runtime
        .sendMessage({ type: 'OPEN_SIDE_PANEL', tabId })
        .catch(() => null);
      opened = !!(response && response.ok);
    }
  }
  if (opened) {
    if (tabId !== null) {
      await chrome.tabs.sendMessage(tabId, { type: 'CLOSE_DOCK' }).catch(() => {});
    }
    return;
  }
  appendNotice('已切换为浏览器侧边栏。如果没自动弹出，点一下工具栏图标即可。');
}

async function saveSettingsFromForm() {
  const previousMode = state.settings.panelMode === 'bottom' ? 'bottom' : 'side';
  const values = readSettingsForm();
  try {
    normalizeBaseUrl(values.baseUrl);
  } catch (error) {
    els.testResult.className = 'test-result bad';
    els.testResult.textContent = error.message;
    return false;
  }
  if (!values.model) {
    els.testResult.className = 'test-result bad';
    els.testResult.textContent = '请填写模型名，例如 deepseek-chat';
    return false;
  }
  await persistSettings(values);
  els.dialog.close();
  if (!state.settings.apiKey) {
    appendNotice('还没填 API Key，暂时无法提问。点 ⚙ 补上即可。');
  }
  if (values.panelMode !== previousMode) {
    await switchPanelMode(values.panelMode);
  }
  return true;
}

// ---------------------------------------------------------------- 页面上下文

function formatNumber(value) {
  return String(value ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}

function setPageLabel(text, offline = false) {
  els.pageTitle.textContent = text;
  els.pageTitle.classList.toggle('offline', offline);
  els.pageTitle.title = text;
}

async function refreshPageContext() {
  const tab = await activeTab();
  if (!tab || typeof tab.id !== 'number') {
    state.page = null;
    setPageLabel('没有可用的标签页', true);
    refreshHint();
    return null;
  }

  setPageLabel(`读取中：${tab.title || tab.url || ''}`);

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_PAGE' });
    if (!response || !response.ok) throw new Error((response && response.error) || '提取失败');
    state.page = {
      title: response.title || tab.title || tab.url || '',
      url: response.url || tab.url || '',
      text: response.text || '',
      charCount: response.charCount || (response.text || '').length
    };
    setPageLabel(`${state.page.title || '未命名页面'} · ${formatNumber(state.page.charCount)} 字`);
  } catch {
    state.page = null;
    setPageLabel(`${tab.title || tab.url || '当前页面'}（无法读取正文）`, true);
  }
  refreshHint();
  return state.page;
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => {
    refreshPageContext().catch(() => {});
  }, 400);
}

function pageBlock(page = state.page) {
  if (!page || !page.text) return '';
  const limit = Math.max(2000, Number(state.settings.pageCharLimit) || 40000);
  const text = page.text;
  const truncated = text.length > limit;
  return [
    '【当前页面】',
    `标题：${page.title || '(无)'}`,
    `URL：${page.url || '(无)'}`,
    `正文${truncated ? `（超长，已截断到前 ${formatNumber(limit)} 字）` : ''}：`,
    '"""',
    text.slice(0, limit),
    '"""'
  ].join('\n');
}

function refreshHint() {
  if (!state.settings.apiKey) {
    els.hint.textContent = '未配置模型 · 点 ⚙ 设置';
    return;
  }
  if (state.settings.attachPage === false) {
    els.hint.textContent = '未附带页面正文';
  } else if (state.page && state.page.charCount) {
    els.hint.textContent = `附带页面 ${formatNumber(state.page.charCount)} 字`;
  } else {
    els.hint.textContent = '未读取到页面正文';
  }
}

// ---------------------------------------------------------------- 渲染

function clearMessages() {
  els.messages.innerHTML = '';
}

function renderEmptyState() {
  clearMessages();
  const wrap = document.createElement('div');
  wrap.className = 'empty';
  wrap.innerHTML = `
    <h3>在阅读时随时提问</h3>
    <p>
      选中网页里的任意文字，点浮出的「问 AI」即可追问。<br />
      也可以直接问我关于这一页的问题。
    </p>
    <div class="samples">
      <button class="sample" data-prompt="请总结这个页面的主要内容：先给 3–5 条要点，再给一句话结论。">总结本页</button>
      <button class="sample" data-prompt="这个页面最核心的结论是什么？用 3 句话说明。">核心结论</button>
      <button class="sample" data-prompt="这个页面里有哪些事实或数字需要我特别注意？">关键数据</button>
    </div>
  `;
  wrap.querySelectorAll('.sample').forEach((btn) => {
    btn.addEventListener('click', () => {
      els.input.value = btn.dataset.prompt || '';
      send(els.input.value).catch(() => {});
    });
  });
  els.messages.appendChild(wrap);
}

function nearBottom() {
  const el = els.messages;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 100;
}

function scrollToBottom(force = false) {
  if (!force && !nearBottom()) return;
  els.messages.scrollTop = els.messages.scrollHeight;
}

const COPY_LABEL = '复制';
const COPY_DONE_LABEL = '已复制';
const COPY_FAIL_LABEL = '复制失败';
const COPY_TITLE = '复制这条回答（Markdown 原文）';

// DOM 里渲染的是 HTML，复制时使用回答的原始 Markdown。
function createCopyButton(text) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copy-btn';
  btn.textContent = COPY_LABEL;
  btn.title = COPY_TITLE;
  btn.setAttribute('aria-label', COPY_TITLE);
  let timer = 0;

  btn.addEventListener('click', async (event) => {
    if (!text) return;
    // 键盘（Enter / 空格）或辅助技术触发时 event.detail 为 0；鼠标点击为 1
    const viaKeyboard = event.detail === 0;
    const ok = await copyText(text);
    // execCommand 兜底会临时聚焦隐藏 textarea，键盘触发时把焦点还给按钮
    if (viaKeyboard && document.activeElement !== btn) btn.focus({ preventScroll: true });
    btn.classList.toggle('copied', ok);
    btn.classList.toggle('failed', !ok);
    btn.textContent = ok ? COPY_DONE_LABEL : COPY_FAIL_LABEL;
    btn.title = ok ? '已复制到剪贴板' : '复制失败，请手动选中回答文字复制';
    btn.setAttribute('aria-label', btn.title);
    clearTimeout(timer);
    timer = setTimeout(() => {
      btn.textContent = COPY_LABEL;
      btn.title = COPY_TITLE;
      btn.setAttribute('aria-label', COPY_TITLE);
      btn.classList.remove('copied', 'failed');
    }, 1600);
  });

  return btn;
}

function appendMessage(role, text) {
  const empty = els.messages.querySelector('.empty');
  if (empty) empty.remove();

  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;

  const head = document.createElement('div');
  head.className = 'msg-head';

  const label = document.createElement('div');
  label.className = 'msg-role';
  label.textContent = role === 'user' ? '你' : role === 'assistant' ? 'AI' : '系统';
  head.appendChild(label);

  const body = document.createElement('div');
  body.className = 'msg-body';
  if (role === 'assistant') {
    body.innerHTML = renderMarkdown(text);
    if (text) head.appendChild(createCopyButton(text));
  } else {
    body.textContent = text;
  }

  wrap.append(head, body);
  els.messages.appendChild(wrap);
  return body;
}

function appendNotice(text) {
  const empty = els.messages.querySelector('.empty');
  if (empty) empty.remove();
  const wrap = document.createElement('div');
  wrap.className = 'msg notice';
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.textContent = text;
  wrap.appendChild(body);
  els.messages.appendChild(wrap);
  scrollToBottom(true);
}

function appendError(text) {
  const wrap = document.createElement('div');
  wrap.className = 'msg error';
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.textContent = text;
  wrap.appendChild(body);
  els.messages.appendChild(wrap);
  scrollToBottom(true);
}

// ---------------------------------------------------------------- 对话历史

async function loadHistory() {
  const version = state.historyChanges;
  const { chatHistory } = await chrome.storage.local.get('chatHistory');
  if (version === state.historyChanges) {
    state.messages = Array.isArray(chatHistory) ? chatHistory : [];
  }
}

async function updateHistory(action, turnId, content) {
  const result = await chrome.runtime.sendMessage({ type: 'UPDATE_CHAT_HISTORY', action, turnId, content });
  if (!result?.ok) throw new Error('对话存储操作失败');
  return result.messages;
}

function renderHistory(messages = state.messages, preserveScroll = false) {
  if (!messages.length) {
    renderEmptyState();
    return;
  }
  const previousTop = preserveScroll && !nearBottom() ? els.messages.scrollTop : null;
  clearMessages();
  for (const { role, content } of messages) appendMessage(role, content);
  if (previousTop === null) scrollToBottom(true);
  else els.messages.scrollTop = previousTop;
}

async function clearHistory() {
  if (state.clearing) return;
  state.clearing = true;
  state.clearCount++;
  updateRequestControls();
  try {
    await updateHistory('clear');
    state.abort?.abort();
    els.input.value = '';
    state.lastSelectionKey = '';
    await loadHistory();
    renderHistory();
  } catch {
    appendError('无法清空本地对话，请重试。');
  } finally {
    state.clearing = false;
    updateRequestControls();
  }
}

// ---------------------------------------------------------------- 请求

function buildRequestMessages(history, pageContext) {
  const systemParts = [state.settings.systemPrompt || DEFAULT_SETTINGS.systemPrompt];
  const block = pageContext ?? (state.settings.attachPage !== false ? pageBlock() : '');
  if (block) systemParts.push(block);

  const messages = [{ role: 'system', content: systemParts.filter(Boolean).join('\n\n') }];
  for (const message of history.slice(-14)) {
    messages.push({ role: message.role, content: message.content });
  }
  return messages;
}

function requestBusy() {
  return state.streaming || state.preparingTranslation || state.clearing;
}

function updateRequestControls() {
  const busy = requestBusy();
  els.sendBtn.disabled = busy;
  els.summarizeBtn.disabled = busy;
  els.translateBtn.disabled = busy;
  els.clearBtn.disabled = state.clearing;
  els.stopBtn.hidden = !state.streaming;
}

function setBusy(busy) {
  state.streaming = busy;
  updateRequestControls();
}

async function send(rawText, { pageContext } = {}) {
  const text = String(rawText || '').trim();
  if (!text || requestBusy()) return;

  if (!state.settings.apiKey) {
    appendNotice('请先点右上角 ⚙ 填写 Base URL、API Key 和模型名。');
    openSettings();
    return;
  }

  setBusy(true);
  const turnId = crypto.randomUUID();
  const controller = new AbortController();
  state.activeTurn = turnId;
  state.abort = controller;

  let history;
  try {
    // 先保存问题；即使生成期间关闭面板，重新打开仍看得到已发送的问题。
    history = await updateHistory('start', turnId, text);
  } catch {
    state.activeTurn = null;
    state.abort = null;
    setBusy(false);
    appendError('无法保存本地对话，消息未发送。');
    return;
  }

  let acc = '';
  let scheduled = 0;
  let failure;
  try {
    controller.signal.throwIfAborted();
    els.input.value = '';
    renderHistory(history);
    const body = appendMessage('assistant', '');
    body.classList.add('streaming-cursor');
    scrollToBottom(true);

    const stream = streamChat({
      baseUrl: state.settings.baseUrl,
      apiKey: state.settings.apiKey,
      model: state.settings.model,
      temperature: Number(state.settings.temperature),
      maxTokens: Number(state.settings.maxTokens) || 0,
      messages: buildRequestMessages(history, pageContext),
      signal: controller.signal
    });

    for await (const delta of stream) {
      acc += delta;
      if (!scheduled) {
        scheduled = requestAnimationFrame(() => {
          scheduled = 0;
          body.innerHTML = renderMarkdown(acc) || '…';
          scrollToBottom();
        });
      }
    }
  } catch (error) {
    failure = error;
  }
  if (scheduled) cancelAnimationFrame(scheduled);

  // 停止或请求出错时保留已收到的部分。空回答不进入模型上下文。
  let saveFailed = false;
  if (acc) {
    await updateHistory('finish', turnId, acc).catch(() => { saveFailed = true; });
  }
  await loadHistory().catch(() => {});
  renderHistory(state.messages, true);
  if (state.messages.some((message) => message.turnId === turnId)) {
    if (saveFailed) {
      appendMessage('assistant', acc);
      appendError('无法保存这条回答，重新打开面板后将不会显示。');
    }
    if (failure?.name === 'AbortError') {
      appendNotice('已停止生成。');
    } else if (failure) {
      appendError(String(failure.message || failure));
    } else if (!acc) {
      appendNotice('（模型返回为空）');
    }
  }
  state.activeTurn = null;
  state.abort = null;
  setBusy(false);
}

// ---------------------------------------------------------------- 交互

function selectionPrompt(text) {
  const quoted = String(text)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `请解释下面这段内容（来自我当前正在阅读的页面），并结合上下文说明它是什么意思、为什么重要：\n\n${quoted}`;
}

async function handleSelection(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return;

  const key = `${text.slice(0, 80)}|${text.length}`;
  const now = Date.now();
  if (key === state.lastSelectionKey && now - state.lastSelectionAt < 3000) return;
  state.lastSelectionKey = key;
  state.lastSelectionAt = now;

  const clearCount = state.clearCount;
  await refreshPageContext().catch(() => {});
  if (clearCount !== state.clearCount || state.clearing) return;

  if (!state.settings.apiKey) {
    els.input.value = selectionPrompt(text);
    els.input.focus();
    appendNotice('还没配置模型。选中的内容已放进输入框，配置好之后点发送即可。');
    openSettings();
    return;
  }

  await send(selectionPrompt(text));
}

async function summarizePage() {
  if (requestBusy()) return;
  if (!state.page) await refreshPageContext().catch(() => {});
  if (!state.page || !state.page.text) {
    appendNotice('这个页面读不到正文（可能是浏览器内部页面、PDF 查看器或尚未加载完）。可以手动把内容粘贴到输入框再问。');
    return;
  }
  await send('请总结这个页面的主要内容：先给 3–5 条要点，再给一句话结论。如果页面有明显结构，按结构列。');
}

async function translatePage() {
  if (requestBusy()) return;
  const clearCount = state.clearCount;
  state.preparingTranslation = true;
  updateRequestControls();
  let page;
  try {
    page = await refreshPageContext().catch(() => null);
  } finally {
    state.preparingTranslation = false;
    updateRequestControls();
  }
  if (clearCount !== state.clearCount || state.clearing) return;

  const pageContext = pageBlock(page);
  if (!pageContext) {
    appendNotice('无法读取当前页面正文，暂时不能翻译。你可以把要翻译的文字粘贴到输入框。');
    return;
  }
  // 显式翻译需要本页正文，但不改变普通提问的「附带页面」设置。
  await send('请把当前页面的正文逐段翻译成简体中文，保留标题、段落和列表结构。已有的简体中文内容保持原样。只输出译文，不要总结或补写。', { pageContext });
}

function bindEvents() {
  els.sendBtn.addEventListener('click', () => send(els.input.value).catch(() => {}));
  els.stopBtn.addEventListener('click', () => {
    if (state.abort) state.abort.abort();
  });
  els.summarizeBtn.addEventListener('click', () => summarizePage().catch(() => {}));
  els.translateBtn.addEventListener('click', () => translatePage().catch(() => {}));
  els.refreshBtn.addEventListener('click', () => refreshPageContext().catch(() => {}));
  els.clearBtn.addEventListener('click', clearHistory);
  els.settingsBtn.addEventListener('click', openSettings);
  els.cancelBtn.addEventListener('click', () => els.dialog.close());

  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    saveSettingsFromForm().catch(() => {});
  });

  els.testBtn.addEventListener('click', async () => {
    const values = readSettingsForm();
    els.testBtn.disabled = true;
    els.testResult.className = 'test-result';
    els.testResult.textContent = '测试中…';
    try {
      const reply = await testConnection({
        baseUrl: values.baseUrl,
        apiKey: values.apiKey,
        model: values.model
      });
      els.testResult.className = 'test-result ok';
      els.testResult.textContent = `连接成功，模型回复：${reply.slice(0, 80)}`;
    } catch (error) {
      els.testResult.className = 'test-result bad';
      els.testResult.textContent = String(error && error.message ? error.message : error);
    } finally {
      els.testBtn.disabled = false;
    }
  });

  els.attachPage.addEventListener('change', () => {
    persistSettings({ attachPage: els.attachPage.checked }).catch(() => {});
  });

  els.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send(els.input.value).catch(() => {});
    }
  });

  els.dialog.addEventListener('close', () => {
    els.testResult.textContent = '';
  });
}

// ---------------------------------------------------------------- 消息入口

async function consumePendingSelection() {
  if (requestBusy()) return false;
  const clearCount = state.clearCount;
  const pending = await chrome.runtime.sendMessage({ type: 'TAKE_PENDING_SELECTION' });
  if (!pending?.text || clearCount !== state.clearCount || state.clearing) return false;
  if (Date.now() - (pending.at || 0) > 120000) return false;
  await handleSelection(pending.text);
  return true;
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.type === 'SELECTION' && message.pending) {
    ready.then(consumePendingSelection).catch(() => {});
  } else if (message.type === 'SUMMARIZE_PAGE') {
    ready.then(() => summarizePage()).catch(() => {});
  }
});

chrome.tabs.onActivated.addListener(() => scheduleRefresh());
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info && info.status === 'complete') scheduleRefresh();
});

// 侧边栏和底部 dock 共享设置和对话历史。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) {
    const next = changes.settings.newValue || {};
    state.settings = { ...DEFAULT_SETTINGS, ...next };
    refreshModelTag();
    refreshHint();
    els.attachPage.checked = state.settings.attachPage !== false;
  }
  if (changes.chatHistory) {
    const { oldValue, newValue } = changes.chatHistory;
    state.historyChanges++;
    state.messages = Array.isArray(newValue) ? newValue : [];
    const cleared = newValue === undefined;
    if (cleared) {
      state.clearCount++;
      if (Array.isArray(oldValue) && oldValue.some((message) => message.turnId === state.activeTurn)) {
        state.abort?.abort();
      }
    }
    // 普通写入等当前流结束再渲染；清空需要立即移除旧消息。
    if (!state.streaming || cleared) renderHistory();
  }
});

// ---------------------------------------------------------------- 启动

let historyLoadFailed = false;
const ready = Promise.all([loadSettings(), loadHistory().catch(() => { historyLoadFailed = true; })]);

(async function init() {
  if (EMBED) document.body.classList.add('embed');
  await ready;
  refreshModelTag();
  bindEvents();

  els.attachPage.checked = state.settings.attachPage !== false;
  renderHistory();
  if (historyLoadFailed) appendError('无法读取本地对话。');
  refreshHint();

  await refreshPageContext().catch(() => {});

  const consumed = await consumePendingSelection().catch(() => false);
  if (!consumed) {
    // 面板刚被打开时，background 可能还在写 pendingSelection，稍后再兜一次
    setTimeout(() => {
      if (!state.streaming && !state.clearing) consumePendingSelection().catch(() => {});
    }, 800);
  }

  // 底部 dock 常驻页面，划词后不会重新加载；轮询一次性选区，保证每次都能接上
  if (EMBED) {
    setInterval(() => {
      if (state.streaming) return;
      consumePendingSelection().catch(() => {});
    }, 1500);
  }

  if (!state.settings.apiKey) {
    appendNotice('第一次使用：点右上角 ⚙ 填写 Base URL、API Key 和模型名（例如 https://api.deepseek.com/v1 + deepseek-chat）。');
  }

  els.input.focus();
})();
