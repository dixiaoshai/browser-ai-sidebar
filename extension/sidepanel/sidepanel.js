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
  messages: [], // { role, content }
  streaming: false,
  abort: null,
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
    return;
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
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => {
    refreshPageContext().catch(() => {});
  }, 400);
}

function pageBlock() {
  if (!state.page || !state.page.text) return '';
  const limit = Math.max(2000, Number(state.settings.pageCharLimit) || 40000);
  const text = state.page.text;
  const truncated = text.length > limit;
  return [
    '【当前页面】',
    `标题：${state.page.title || '(无)'}`,
    `URL：${state.page.url || '(无)'}`,
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

// 回答的原始 Markdown 与对应复制按钮：DOM 里渲染的是 HTML，复制时要拿到原始文本
const answerTexts = new WeakMap();
const copyButtons = new WeakMap();

function createCopyButton(getText) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copy-btn';
  btn.textContent = COPY_LABEL;
  btn.title = COPY_TITLE;
  btn.setAttribute('aria-label', COPY_TITLE);
  let timer = 0;

  btn.addEventListener('click', async (event) => {
    const text = getText();
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

/** 流式渲染结束后登记回答原文，并让复制按钮出现（生成中不显示） */
function setAnswerText(body, text) {
  answerTexts.set(body, text || '');
  const button = copyButtons.get(body);
  if (button) button.hidden = !text;
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
    answerTexts.set(body, text || '');
    const copyBtn = createCopyButton(() => answerTexts.get(body) || '');
    // 流式生成中先不显示，生成结束（setAnswerText）后出现
    copyBtn.hidden = !text;
    copyButtons.set(body, copyBtn);
    head.appendChild(copyBtn);
  } else {
    body.textContent = text;
  }

  wrap.append(head, body);
  els.messages.appendChild(wrap);
  scrollToBottom(true);
  return { wrap, body };
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

// ---------------------------------------------------------------- 请求

function buildRequestMessages() {
  const systemParts = [state.settings.systemPrompt || DEFAULT_SETTINGS.systemPrompt];
  if (state.settings.attachPage !== false) {
    const block = pageBlock();
    if (block) systemParts.push(block);
  }

  const messages = [{ role: 'system', content: systemParts.filter(Boolean).join('\n\n') }];
  for (const message of state.messages.slice(-14)) {
    messages.push({ role: message.role, content: message.content });
  }
  return messages;
}

function setBusy(busy) {
  state.streaming = busy;
  els.sendBtn.disabled = busy;
  els.summarizeBtn.disabled = busy;
  els.stopBtn.hidden = !busy;
  els.input.disabled = false;
}

async function send(rawText) {
  const text = String(rawText || '').trim();
  if (!text || state.streaming) return;

  if (!state.settings.apiKey) {
    appendNotice('请先点右上角 ⚙ 填写 Base URL、API Key 和模型名。');
    openSettings();
    return;
  }

  els.input.value = '';
  state.messages.push({ role: 'user', content: text });
  appendMessage('user', text);

  const { wrap, body } = appendMessage('assistant', '');
  body.classList.add('streaming-cursor');
  setBusy(true);
  state.abort = new AbortController();

  let acc = '';
  let scheduled = 0;

  const flush = () => {
    body.innerHTML = renderMarkdown(acc) || '…';
    scrollToBottom();
  };

  try {
    const stream = streamChat({
      baseUrl: state.settings.baseUrl,
      apiKey: state.settings.apiKey,
      model: state.settings.model,
      temperature: Number(state.settings.temperature),
      maxTokens: Number(state.settings.maxTokens) || 0,
      messages: buildRequestMessages(),
      signal: state.abort.signal
    });

    for await (const delta of stream) {
      acc += delta;
      if (!scheduled) {
        scheduled = requestAnimationFrame(() => {
          scheduled = 0;
          flush();
        });
      }
    }
    if (scheduled) cancelAnimationFrame(scheduled);
    scheduled = 0;
    body.innerHTML = renderMarkdown(acc) || '（模型返回为空）';
    setAnswerText(body, acc);
    // 空回答不写进历史：部分 OpenAI 兼容服务会拒绝 content 为空的 assistant 消息
    if (acc) state.messages.push({ role: 'assistant', content: acc });
  } catch (error) {
    if (scheduled) cancelAnimationFrame(scheduled);
    scheduled = 0;
    const aborted = error && error.name === 'AbortError';
    if (aborted) {
      if (acc) {
        body.innerHTML = renderMarkdown(acc);
        setAnswerText(body, acc);
        state.messages.push({ role: 'assistant', content: acc });
        appendNotice('已停止生成。');
      } else {
        wrap.remove();
      }
    } else {
      if (acc) {
        body.innerHTML = renderMarkdown(acc);
        setAnswerText(body, acc);
        state.messages.push({ role: 'assistant', content: acc });
      } else {
        wrap.remove();
      }
      appendError(String(error && error.message ? error.message : error));
    }
  } finally {
    body.classList.remove('streaming-cursor');
    state.abort = null;
    setBusy(false);
    scrollToBottom();
  }
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

  await refreshPageContext().catch(() => {});

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
  if (!state.page) await refreshPageContext().catch(() => {});
  if (!state.page || !state.page.text) {
    appendNotice('这个页面读不到正文（可能是浏览器内部页面、PDF 查看器或尚未加载完）。可以手动把内容粘贴到输入框再问。');
    return;
  }
  await send('请总结这个页面的主要内容：先给 3–5 条要点，再给一句话结论。如果页面有明显结构，按结构列。');
}

function bindEvents() {
  els.sendBtn.addEventListener('click', () => send(els.input.value).catch(() => {}));
  els.stopBtn.addEventListener('click', () => {
    if (state.abort) state.abort.abort();
  });
  els.summarizeBtn.addEventListener('click', () => summarizePage().catch(() => {}));
  els.refreshBtn.addEventListener('click', () => refreshPageContext().catch(() => {}));
  els.clearBtn.addEventListener('click', () => {
    state.messages = [];
    renderEmptyState();
  });
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
  const stored = await chrome.storage.local.get('pendingSelection');
  const pending = stored && stored.pendingSelection;
  if (!pending || !pending.text) return false;
  await chrome.storage.local.remove('pendingSelection').catch(() => {});
  if (Date.now() - (pending.at || 0) > 120000) return false;
  await handleSelection(pending.text);
  return true;
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.type === 'SELECTION' && message.text) {
    handleSelection(message.text).catch(() => {});
  } else if (message.type === 'SUMMARIZE_PAGE') {
    summarizePage().catch(() => {});
  }
});

chrome.tabs.onActivated.addListener(() => scheduleRefresh());
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info && info.status === 'complete') scheduleRefresh();
});

// 侧边栏和底部 dock 可能同时存在：任一处改了设置，其他面板立即同步
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const next = changes.settings.newValue || {};
  state.settings = { ...DEFAULT_SETTINGS, ...next };
  refreshModelTag();
  refreshHint();
  if (els.attachPage) els.attachPage.checked = state.settings.attachPage !== false;
});

// ---------------------------------------------------------------- 启动

(async function init() {
  if (EMBED) document.body.classList.add('embed');
  await loadSettings();
  refreshModelTag();
  bindEvents();

  els.attachPage.checked = state.settings.attachPage !== false;
  renderEmptyState();
  refreshHint();

  await refreshPageContext().catch(() => {});

  const consumed = await consumePendingSelection().catch(() => false);
  if (!consumed) {
    // 面板刚被打开时，background 可能还在写 pendingSelection，稍后再兜一次
    setTimeout(() => {
      if (!state.messages.length) consumePendingSelection().catch(() => {});
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
