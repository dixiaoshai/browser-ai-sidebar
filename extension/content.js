/**
 * 内容脚本：三件事
 *   1. 响应侧边栏 / 底部面板的“提取正文”请求（可读性启发式，无第三方依赖）
 *   2. 划词后在选区旁浮出「问 AI」按钮，点了通知 background 打开对话面板并带上选区
 *   3. 页面底部悬浮面板（dock）：仅在设置里选了「页面底部悬浮」时使用（默认是原生侧边栏）。
 *      Chrome 原生 sidePanel 只能固定在右侧，这里在页面底部注入一个可拖拽高度的 dock，
 *      内部用 iframe 加载扩展自己的对话页
 *
 * 注意：不要在这里引入任何网络请求，页面内容只通过消息传给扩展自身。
 */
(() => {
  if (window.__AI_SIDEBAR_CONTENT_LOADED__) return;
  window.__AI_SIDEBAR_CONTENT_LOADED__ = true;
  // 冒烟测试专用标记：只有 URL 带 ?__ai_sidebar_test=1 时才写入 DOM，
  // 避免平时浏览被网站探测到扩展存在（隔离世界的 window 看不到，DOM 属性看得到）。
  try {
    if (new URLSearchParams(location.search).has('__ai_sidebar_test')) {
      document.documentElement.setAttribute('data-ai-sidebar-content', '1');
    }
  } catch {
    /* ignore */
  }

  const MAX_SELECTION = 6000;
  const MIN_SELECTION = 2;

  // 这些节点通常是导航/装饰，直接剔除
  const REMOVE_SELECTORS = [
    'script',
    'style',
    'noscript',
    'template',
    'svg',
    'canvas',
    'iframe',
    'object',
    'embed',
    'nav',
    'header',
    'footer',
    'aside',
    'form',
    'button',
    'input',
    'select',
    'textarea',
    '[aria-hidden="true"]',
    '[role="navigation"]',
    '[role="banner"]',
    '[role="contentinfo"]',
    '[role="complementary"]'
  ].join(',');

  const BLOCK_SELECTOR = 'p,li,h1,h2,h3,h4,h5,h6,pre,blockquote,td,th,dd,dt,figcaption';

  const GOOD_ROOTS = [
    'article',
    'main',
    '[role="main"]',
    '.article-content',
    '.post-content',
    '.entry-content',
    '.markdown-body',
    '.rich_media_content',
    '#js_content',
    '#content',
    '#main'
  ];

  function cleanText(input) {
    return String(input || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function textLength(el) {
    return (el.textContent || '').length;
  }

  /** 选一个最像“正文”的容器 */
  function pickRoot() {
    let best = null;
    let bestLen = 0;

    for (const selector of GOOD_ROOTS) {
      for (const el of document.querySelectorAll(selector)) {
        const len = textLength(el);
        if (len > bestLen) {
          bestLen = len;
          best = el;
        }
      }
    }
    if (best && bestLen >= 500) return best;

    // 退一步：按段落的文本密度挑 div
    let bestDiv = null;
    let bestScore = 0;
    let scanned = 0;
    for (const el of document.querySelectorAll('div')) {
      if (++scanned > 4000) break;
      if (textLength(el) < 400) continue;
      const paragraphs = el.querySelectorAll('p');
      if (!paragraphs.length) continue;
      let score = 0;
      for (const p of paragraphs) score += textLength(p);
      // 嵌套 div 越多越可能是布局容器，扣分
      score -= el.querySelectorAll('div').length * 50;
      if (score > bestScore) {
        bestScore = score;
        bestDiv = el;
      }
    }
    if (bestDiv && bestScore > 300) return bestDiv;
    return document.body;
  }

  /** 从容器里按块级元素顺序抽取文字，去掉重复块 */
  function extractFrom(root) {
    if (!root) return '';
    const clone = root.cloneNode(true);
    try {
      clone.querySelectorAll(REMOVE_SELECTORS).forEach((node) => node.remove());
    } catch {
      /* ignore */
    }

    const blocks = Array.from(clone.querySelectorAll(BLOCK_SELECTOR));
    const parts = [];
    const seen = new Set();

    for (const block of blocks) {
      // 只保留最内层块，避免父容器和子段落重复
      if (block.querySelector(BLOCK_SELECTOR)) continue;
      const text = cleanText(block.textContent);
      if (text.length < 2 || seen.has(text)) continue;
      seen.add(text);
      parts.push(text);
    }

    let text = parts.join('\n\n');
    if (text.length < 200) {
      text = cleanText(clone.textContent);
    }
    return text;
  }

  function pageTitle() {
    const og = document.querySelector('meta[property="og:title"]');
    const title = (og && og.getAttribute('content')) || document.title || '';
    return cleanText(title).slice(0, 200);
  }

  function extractPage() {
    const root = pickRoot();
    const text = extractFrom(root);
    return {
      ok: true,
      title: pageTitle(),
      url: location.href,
      text: text.slice(0, 200000),
      charCount: text.length,
      selection: currentSelection()
    };
  }

  function currentSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return '';
    return String(selection).trim();
  }

  // ---------------- 划词浮层 ----------------

  const SELECTION_GAP = 20;
  const VIEWPORT_MARGIN = 8;
  const POINTER_GAP = 12;

  let host = null;
  let shadow = null;
  let button = null;
  let pendingSelection = '';
  let selectionTimer;

  function ensureButton() {
    if (button) return;
    host = document.createElement('div');
    host.setAttribute('data-ai-sidebar-float', '1');
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      .ask {
        position: fixed;
        display: none;
        align-items: center;
        gap: 4px;
        padding: 6px 10px;
        border: none;
        border-radius: 999px;
        background: #1f6feb;
        color: #fff;
        font: 12px/1 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 4px 14px rgba(0,0,0,.28);
        white-space: nowrap;
        user-select: none;
      }
      .ask:hover { background: #2f81f7; }
      .ask:active { transform: translateY(1px); }
    `;
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'ask';
    button.textContent = '问 AI';
    button.title = '把选中内容发给侧边栏里的 AI';

    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const text = pendingSelection;
      hideButton();
      if (!text) return;
      try {
        chrome.runtime.sendMessage({ type: 'ASK_SELECTION', text }).catch(() => {});
      } catch {
        /* 扩展被重载后 context 失效，忽略 */
      }
    });

    shadow.append(style, button);
    (document.documentElement || document.body).appendChild(host);
  }

  function hideButton() {
    clearTimeout(selectionTimer);
    pendingSelection = '';
    if (button) button.style.display = 'none';
  }

  function showButton(rect, releasePoint, text) {
    const viewport = document.compatMode === 'BackCompat' ? document.body : document.documentElement;
    const viewportWidth = viewport?.clientWidth || window.innerWidth;
    const viewportHeight = viewport?.clientHeight || window.innerHeight;
    if (rect.right <= 0 || rect.left >= viewportWidth || rect.bottom <= 0 || rect.top >= viewportHeight) {
      hideButton();
      return;
    }

    ensureButton();
    button.style.display = 'flex';
    const size = button.getBoundingClientRect();
    const width = Math.ceil(size.width);
    const height = Math.ceil(size.height);
    const min = VIEWPORT_MARGIN;
    const maxLeft = viewportWidth - width - min;
    const maxTop = viewportHeight - height - min;
    const centerLeft = clamp(Math.round((rect.left + rect.right - width) / 2), min, maxLeft);
    const centerTop = clamp(Math.round((rect.top + rect.bottom - height) / 2), min, maxTop);

    // 贴近视口边缘时换一侧，不把按钮硬挤回选区上方。
    const positions = [
      [centerLeft, Math.floor(rect.top - height - SELECTION_GAP)],
      [centerLeft, Math.ceil(rect.bottom + SELECTION_GAP)],
      [Math.ceil(rect.right + SELECTION_GAP), centerTop],
      [Math.floor(rect.left - width - SELECTION_GAP), centerTop]
    ];
    const position = positions.find(([left, top]) =>
      left >= min && left <= maxLeft && top >= min && top <= maxTop &&
      (!releasePoint || releasePoint.x < left - POINTER_GAP || releasePoint.x > left + width + POINTER_GAP ||
        releasePoint.y < top - POINTER_GAP || releasePoint.y > top + height + POINTER_GAP)
    );
    if (!position) {
      hideButton();
      return;
    }

    const [left, top] = position;
    button.style.left = `${left}px`;
    button.style.top = `${top}px`;
    pendingSelection = text;
  }

  function inEditable(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!el || !el.closest) return false;
    return !!el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
  }

  function handleSelectionChange(releasePoint) {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        hideButton();
        return;
      }
      const text = String(selection).trim();
      if (text.length < MIN_SELECTION || text.length > MAX_SELECTION) {
        hideButton();
        return;
      }
      if (inEditable(selection.anchorNode)) {
        hideButton();
        return;
      }
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (!rect.width || !rect.height) {
        hideButton();
        return;
      }
      showButton(rect, releasePoint, text);
    }, 10);
  }

  function onAskButton(event) {
    return host && event.composedPath().includes(host);
  }

  document.addEventListener('mouseup', (event) => {
    if (event.button === 0 && !onAskButton(event)) {
      handleSelectionChange({ x: event.clientX, y: event.clientY });
    }
  }, true);
  document.addEventListener('keyup', (event) => {
    if (event.key === 'Escape') hideButton();
    else if (!onAskButton(event)) handleSelectionChange();
  }, true);
  document.addEventListener('mousedown', (event) => {
    if (!onAskButton(event)) hideButton();
  }, true);
  window.addEventListener('scroll', hideButton, { passive: true, capture: true });
  window.addEventListener('resize', hideButton, { passive: true });


  // ---------------- 页面底部悬浮面板（dock，可选模式） ----------------
  // 默认呈现方式是原生侧边栏；只有用户在设置里选择「页面底部悬浮」时才用到这里。
  // 原生 sidePanel 不能放底部，这里用内容脚本注入。iframe 加载的是扩展页面，
  // 所以对话逻辑、设置、chunk 渲染都复用 sidepanel/，不重复实现。

  const DOCK_MIN_HEIGHT = 220;
  const DOCK_DEFAULT_RATIO = 0.42;

  let dockHost = null;
  let dockShadow = null;
  let dockFrameWrap = null;
  let dockFrame = null;
  let dockOpen = false;
  let dockHeight = 0;
  let dragState = null;

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function dockMaxHeight() {
    return Math.round(Math.max(DOCK_MIN_HEIGHT, window.innerHeight * 0.85));
  }

  function ensureDock() {
    if (dockHost) return;

    dockHost = document.createElement('div');
    dockHost.setAttribute('data-ai-sidebar-dock', '1');
    dockHost.setAttribute('data-ai-sidebar-dock-open', '0');
    dockHost.style.cssText =
      'position:fixed;left:0;right:0;bottom:0;height:0;display:none;z-index:2147483646;pointer-events:none;';
    dockShadow = dockHost.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      .dock {
        /* 绝对定位铺满宿主 dockHost（宿主是 fixed 且高度由拖拽控制）；
           不能用 position:fixed + height:100%，否则百分比按视口解析，
           面板会盖住整页、拖拽高度也不生效 */
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        background: #ffffff;
        color: #1b1f24;
        border-top: 1px solid #e3e6ea;
        box-shadow: 0 -10px 30px rgba(15, 23, 42, 0.18);
        font: 12px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
        pointer-events: auto;
      }
      @media (prefers-color-scheme: dark) {
        .dock {
          background: #16181d;
          color: #e7e9ee;
          border-top-color: #2b3038;
          box-shadow: 0 -10px 30px rgba(0, 0, 0, 0.5);
        }
      }
      .bar {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        border-bottom: 1px solid rgba(127, 127, 127, 0.2);
        flex: 0 0 auto;
        user-select: none;
      }
      .grip {
        width: 44px;
        height: 12px;
        border-radius: 6px;
        background: rgba(127, 127, 127, 0.35);
        cursor: ns-resize;
        flex: 0 0 auto;
      }
      .grip:hover { background: rgba(127, 127, 127, 0.55); }
      .title { font-weight: 600; }
      .spacer { flex: 1 1 auto; }
      button.mini {
        font: inherit;
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 6px;
        border: 1px solid rgba(127, 127, 127, 0.35);
        background: transparent;
        color: inherit;
        cursor: pointer;
      }
      button.mini:hover { border-color: #1f6feb; color: #1f6feb; }
      .frame-wrap { flex: 1 1 auto; min-height: 0; overflow: hidden; }
      .frame-wrap iframe {
        width: 100%;
        height: 100%;
        border: 0;
        display: block;
        background: #ffffff;
        color-scheme: light dark;
      }
    `;

    const dock = document.createElement('div');
    dock.className = 'dock';

    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.innerHTML =
      '<span class="grip" title="拖动调整高度"></span>' +
      '<span class="title">AI 阅读</span>' +
      '<span class="spacer"></span>' +
      '<button class="mini" type="button" data-act="side" title="切换到浏览器侧边栏">侧边栏</button>' +
      '<button class="mini" type="button" data-act="close" title="收起面板（Esc）">收起</button>';

    dockFrameWrap = document.createElement('div');
    dockFrameWrap.className = 'frame-wrap';

    dock.append(bar, dockFrameWrap);
    dockShadow.append(style, dock);
    (document.documentElement || document.body).appendChild(dockHost);

    const grip = bar.querySelector('.grip');
    grip.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      dragState = {
        startY: event.clientY,
        startHeight: Math.round(dockHost.getBoundingClientRect().height)
      };
      document.addEventListener('mousemove', onDragMove, true);
      document.addEventListener('mouseup', stopDrag, true);
    });

    bar.querySelector('[data-act="close"]').addEventListener('click', () => closeDock());
    bar.querySelector('[data-act="side"]').addEventListener('click', () => {
      // 切回浏览器侧边栏：打开成功才收起 dock，并把「面板位置」设置改回 side
      // （否则失败时既没打开侧边栏、又丢了底部面板）
      chrome.runtime
        .sendMessage({ type: 'OPEN_SIDE_PANEL', switchMode: true })
        .then((response) => {
          if (response && response.ok) closeDock();
        })
        .catch(() => {
          /* 扩展上下文失效（重载后），忽略 */
        });
    });
  }

  function onDragMove(event) {
    if (!dragState) return;
    const next = dragState.startHeight + (dragState.startY - event.clientY);
    dockHeight = clamp(Math.round(next), DOCK_MIN_HEIGHT, dockMaxHeight());
    applyDockHeight();
  }

  function stopDrag() {
    dragState = null;
    document.removeEventListener('mousemove', onDragMove, true);
    document.removeEventListener('mouseup', stopDrag, true);
  }

  function applyDockHeight() {
    if (!dockHost) return;
    // 收起时 display:none，避免宿主高度为 0 时内部内容（横条/边框）残留在页面底部
    dockHost.style.display = dockOpen ? 'block' : 'none';
    dockHost.style.height = dockOpen ? `${dockHeight}px` : '0px';
    dockHost.style.pointerEvents = dockOpen ? 'auto' : 'none';
    dockHost.setAttribute('data-ai-sidebar-dock-open', dockOpen ? '1' : '0');
  }

  function ensureDockFrame() {
    if (dockFrame) return;
    ensureDock();
    dockFrame = document.createElement('iframe');
    dockFrame.setAttribute('title', 'AI 阅读面板');
    // 底部 dock 是跨域 iframe（扩展页面嵌在普通页面里），默认权限策略会禁掉
    // 剪贴板写入；显式放开，回答的「复制」按钮在底部模式才可用
    dockFrame.setAttribute('allow', 'clipboard-write');
    dockFrame.src = `${chrome.runtime.getURL('sidepanel/index.html')}?embed=bottom`;
    dockFrame.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#fff;';
    dockFrameWrap.appendChild(dockFrame);
  }

  function openDock() {
    ensureDock();
    if (!dockHeight) {
      dockHeight = clamp(
        Math.round(window.innerHeight * DOCK_DEFAULT_RATIO),
        DOCK_MIN_HEIGHT,
        dockMaxHeight()
      );
    }
    dockOpen = true;
    ensureDockFrame();
    applyDockHeight();
  }

  function closeDock() {
    if (!dockOpen) return;
    dockOpen = false;
    applyDockHeight();
  }

  function toggleDock() {
    if (dockOpen) closeDock();
    else openDock();
  }

  window.addEventListener('resize', () => {
    if (!dockHost || !dockOpen) return;
    const max = dockMaxHeight();
    if (dockHeight > max) {
      dockHeight = max;
      applyDockHeight();
    }
  });

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && dockOpen) closeDock();
    },
    true
  );

  // ---------------- 与扩展通信 ----------------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'EXTRACT_PAGE') {
      try {
        sendResponse(extractPage());
      } catch (error) {
        sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
      }
    } else if (message?.type === 'GET_SELECTION') {
      sendResponse({ ok: true, text: currentSelection() });
    } else if (message?.type === 'TOGGLE_DOCK') {
      toggleDock();
      sendResponse({ ok: true, open: dockOpen });
    } else if (message?.type === 'OPEN_DOCK') {
      openDock();
      sendResponse({ ok: true, open: dockOpen });
    } else if (message?.type === 'CLOSE_DOCK') {
      closeDock();
      sendResponse({ ok: true, open: dockOpen });
    } else if (message?.type === 'DOCK_STATE') {
      sendResponse({ ok: true, open: dockOpen });
    }
    return false;
  });
})();
