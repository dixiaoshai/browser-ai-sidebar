/**
 * 端到端冒烟测试（需要本机 Chrome；默认 macOS 路径，可用 CHROME_PATH 覆盖）。
 *
 * 为什么不用 `--load-extension`：Chrome 137+ 会以受限模式加载命令行扩展
 * （没有 content script 注入、没有 host 权限）。改用 CDP 的
 * `Extensions.loadUnpacked`（需要 --enable-unsafe-extension-debugging），
 * 效果和用户在 chrome://extensions 里手动「加载已解压」一致。
 *
 * 默认呈现方式是 Chrome 原生右侧边栏（settings.panelMode = 'side'），
 * 「页面底部悬浮」是可选项。本测试按顺序覆盖：
 *   1. 扩展加载 + content.js 注入
 *   2. 默认 side 模式：划词浮层出现 → 点「问 AI」→ 底部 dock 不出现，
 *      且 background 把选区写入 storage.pendingSelection
 *   3. service worker 里调用 chrome.tabs.sendMessage(EXTRACT_PAGE)，校验正文提取
 *   4. 侧边栏页面加载 → 设置弹窗默认选中 side → 切到文章页 → 点「重读」→ 页面字数
 *   5. 点「总结本页」→ 走真实 SSE 流式渲染 → 校验请求里带了页面正文；
 *      回答里的「复制」按钮复制原始 Markdown 并给出「已复制」反馈
 *   6. 侧边栏收到 SELECTION 广播 → 请求里带选区 + 页面正文；关闭重开恢复历史、追问，
 *      清空后再次关闭重开，验证设置保留且新请求没有旧历史
 *   7. 显式把 settings.panelMode 切成 'bottom'（等 background storage.onChanged 生效）
 *      → 再划词点「问 AI」→ 当前页展开底部 dock（iframe src 含 ?embed=bottom）
 *   8. dock iframe 轮询 pendingSelection → 请求里带选区 + 页面正文
 *
 * headless 下的 chrome.sidePanel.open 实测：它要求用户手势。脚本合成的
 * element.click() 不带用户激活，会被浏览器拒绝（"may only be called in response
 * to a user gesture"），于是第 2 步里侧边栏不会真的打开、pendingSelection 留在
 * storage 中——这正是我们断言的行为。若用 CDP Input.dispatchMouseEvent 发真实
 * 手势，面板会真的打开并消费掉 pendingSelection（本次验证的实际结论）。
 *
 * 可选环境变量：
 *   CHROME_PATH            覆盖 Chrome 可执行文件路径
 *   CDP_PORT               调试端口（默认 9337）
 *   SMOKE_SCREENSHOT       整页截图（文章页 + 底部 dock）保存路径
 *   SMOKE_SIDE_SCREENSHOT  侧边栏页面截图（约 380x900 视口）保存路径
 *
 * 用法：node test/smoke-chrome.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = path.join(ROOT, 'extension');
const PROFILE_DIR = path.join(ROOT, '.tmp', 'chrome-profile');
const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT = Number(process.env.CDP_PORT || 9337);

// 模拟回答故意带 Markdown（粗体 + 列表）：界面渲染成 HTML，复制按钮应拿到原始 Markdown
const MOCK_REPLY_MD = '**总结**：量子计算仍处于早期阶段。\n\n- 要点一：叠加态\n- 要点二：纠错';
const MOCK_REPLY_TEXT = '总结：量子计算仍处于早期阶段。';
const CLEAR_DURING_STREAM = '测试生成过程中清空对话';
const PARTIAL_REPLY = '这段未完成的回答不能在清空后恢复。';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ARTICLE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>量子计算的现状 · 测试页</title></head>
<body>
<nav><a href="/">首页</a> | <a href="/about">关于</a></nav>
<article>
  <h1>量子计算的现状</h1>
  <p>量子计算利用量子叠加与量子纠缠来处理经典计算机难以处理的问题。与经典比特只能取 0 或 1 不同，量子比特可以同时处于叠加态，这使得某些特定问题的求解复杂度显著下降。</p>
  <p>2025 年以来，超导量子比特的数量已经突破一千，但错误率与纠错开销仍然是工程化的最大瓶颈。业内普遍认为，容错量子计算还需要多轮技术迭代。</p>
  <h2>关键判断</h2>
  <ul><li>短期内量子优势集中在特定模拟类问题上</li><li>通用量子计算尚不适合作为通用计算平台</li></ul>
  <p>对普通开发者而言，更现实的路径是关注量子编程框架与云上真机资源的开放节奏，而不是等待硬件成熟。</p>
</article>
<footer>版权所有 © 测试页</footer>
</body></html>`;

// ---------------------------------------------------------------- 工具

function log(step, message) {
  console.log(`[${step}] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function startServer() {
  const captured = { chatRequest: null };
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (pathname === '/v1/chat/completions') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          captured.chatRequest = JSON.parse(body);
        } catch {
          captured.chatRequest = { raw: body };
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        if (captured.chatRequest.messages?.at(-1)?.content === CLEAR_DURING_STREAM) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: PARTIAL_REPLY } }] })}\n\n`);
          // 等面板清空时主动中断，让测试确实覆盖未结束的流。
          return;
        }
        // 分 3 段推送，顺便验证 SSE 跨 chunk 拼接；拼起来必须等于 MOCK_REPLY_MD
        const chunks = [
          '**总结**：',
          '量子计算仍处于早期阶段。\n\n- 要点一：叠加态',
          '\n- 要点二：纠错'
        ];
        let payload = '';
        for (const chunk of chunks) {
          payload += `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`;
        }
        payload += 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
        payload += 'data: [DONE]\n\n';
        for (let i = 0; i < payload.length; i += 13) res.write(payload.slice(i, i + 13));
        res.end();
      });
      return;
    }

    if (pathname === '/article' || pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ARTICLE_HTML);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}`, captured });
    });
  });
}

async function waitForCdp(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) return res.json();
    } catch {
      /* 还没就绪 */
    }
    await sleep(200);
  }
  fail('Chrome 的 CDP 端口没有就绪');
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  const eventHandlers = [];
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')));
  });

  ws.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message}（${message.error.code}）`));
      else resolve(message.result);
      return;
    }
    for (const handler of eventHandlers) {
      try {
        handler(message);
      } catch {
        /* 订阅方异常不影响主流程 */
      }
    }
  });

  return {
    async send(method, params = {}) {
      await opened;
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    onEvent(handler) {
      eventHandlers.push(handler);
    },
    close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  };
}

async function evaluate(client, expression, { awaitPromise = true } = {}) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails;
    fail(`页面内执行出错：${detail.text || ''} ${detail.exception?.description || ''}`);
  }
  return result.result?.value;
}

async function waitFor(client, expression, timeoutMs = 8000, label = expression) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(client, expression)) return true;
    await sleep(150);
  }
  fail(`等待超时：${label}`);
}

async function listTargets() {
  return (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
}

async function openTarget(url) {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT'
  });
  if (!res.ok) fail(`打开标签页失败：HTTP ${res.status}`);
  return res.json();
}

function resolveOutputPath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

function pngInfo(absPath) {
  const buffer = fs.readFileSync(absPath);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bytes: buffer.length
  };
}

async function saveScreenshot(client, filePath) {
  const absPath = resolveOutputPath(filePath);
  await client.send('Page.enable').catch(() => {});
  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, Buffer.from(shot.data, 'base64'));
  return { absPath, ...pngInfo(absPath) };
}

// ---------------------------------------------------------------- 页面交互

/** 选中文章里的某一段；返回选中文字，并等划词浮层的按钮真正显示出来 */
async function selectParagraph(client, index, label) {
  const text = await evaluate(
    client,
    `(() => {
      const paragraphs = document.querySelectorAll('article p');
      const target = paragraphs[${index}];
      if (!target) return null;
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return String(selection).trim();
    })()`
  );
  if (!text) fail(`没找到第 ${index + 1} 段正文（${label}）`);
  await waitFor(
    client,
    `(() => {
      const host = document.querySelector('div[data-ai-sidebar-float]');
      const button = host && host.shadowRoot && host.shadowRoot.querySelector('button');
      return !!button && button.style.display !== 'none';
    })()`,
    5000,
    `划词浮层（${label}）`
  );
  return text;
}

async function clickFloatButton(client) {
  const label = await evaluate(
    client,
    `(() => {
      const host = document.querySelector('div[data-ai-sidebar-float]');
      const button = host && host.shadowRoot && host.shadowRoot.querySelector('button');
      if (!button) return 'no-button';
      button.click();
      return button.textContent;
    })()`,
    { awaitPromise: false }
  );
  if (label === 'no-button') fail('浮层里没有按钮');
  return label;
}

// Use real Range and button rectangles, not assumptions about font-dependent button size.
async function checkSelectionPlacement(client) {
  async function selectFixture({ top, width, text, releaseX = 10, releaseY = 700 }) {
    await evaluate(client, `(() => {
      document.getElementById('placement-fixture')?.remove();
      const el = document.createElement('div');
      el.id = 'placement-fixture';
      el.style.cssText = 'position:fixed;left:150px;top:${top}px;width:${width}px;font:16px/24px sans-serif;z-index:1';
      el.textContent = ${JSON.stringify(text)};
      document.body.appendChild(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles:true, clientX:${releaseX}, clientY:${releaseY} }));
    })()`);
    await waitFor(client, `(() => {
      const b = document.querySelector('[data-ai-sidebar-float]')?.shadowRoot?.querySelector('button');
      return b && getComputedStyle(b).display !== 'none';
    })()`, 5000, 'placement fixture button');
    // Give any queued handler time to finish before measuring.
    await sleep(100);
    return evaluate(client, `(() => {
      const range = getSelection().getRangeAt(0);
      const selection = range.getBoundingClientRect();
      const button = document.querySelector('[data-ai-sidebar-float]').shadowRoot.querySelector('button').getBoundingClientRect();
      const rect = r => ({left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height});
      return { selection:rect(selection), button:rect(button), lines:range.getClientRects().length,
        viewport:{width:innerWidth,height:innerHeight} };
    })()`);
  }
  function check(info, direction, label) {
    const { selection: s, button: b, viewport: v } = info;
    const epsilon = 0.75;
    if (!(b.width > 0 && b.height > 0) || b.left < 8 - epsilon || b.top < 8 - epsilon ||
        b.right > v.width - 8 + epsilon || b.bottom > v.height - 8 + epsilon) {
      fail(`${label}: button outside viewport margin: ${JSON.stringify(info)}`);
    }
    if (direction === 'above' && b.bottom > s.top - 20 + epsilon ||
        direction === 'below' && b.top < s.bottom + 20 - epsilon) {
      fail(`${label}: expected ${direction} with 20px gap from full selection: ${JSON.stringify(info)}`);
    }
  }
  const single = 'This is selected text for the placement regression test.';
  const typical = await selectFixture({ top: 180, width: 500, text: single });
  check(typical, 'above', 'typical selection');
  const top = await selectFixture({ top: 10, width: 500, text: single });
  check(top, 'below', 'top-edge selection');
  const multi = await selectFixture({ top: 300, width: 140, text: single.repeat(3) });
  if (multi.lines < 2) fail(`multiline fixture did not wrap: ${JSON.stringify(multi)}`);
  check(multi, 'above', 'multiline selection');

  // Put the release point in the normal above candidate. It must not end up
  // inside or within 12px of the actual button rectangle.
  const x = (typical.button.left + typical.button.right) / 2;
  const y = (typical.button.top + typical.button.bottom) / 2;
  const near = await selectFixture({ top: 180, width: 500, text: single, releaseX: x, releaseY: y });
  const dx = Math.max(near.button.left - x, 0, x - near.button.right);
  const dy = Math.max(near.button.top - y, 0, y - near.button.bottom);
  if (Math.hypot(dx, dy) < 11.25) fail(`button too close to mouseup: ${JSON.stringify(near)}`);

  // A button mouseup must not schedule a fresh show after the click hides it.
  await evaluate(client, `(() => {
    const b = document.querySelector('[data-ai-sidebar-float]').shadowRoot.querySelector('button');
    b.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, composed:true}));
    b.click();
  })()`);
  await sleep(150);
  const resurfaced = await evaluate(client, `getComputedStyle(document.querySelector('[data-ai-sidebar-float]').shadowRoot.querySelector('button')).display !== 'none'`);
  if (resurfaced) fail('button mouseup rescheduled a show after click');

  // Escape must cancel an already queued show, not just hide the current button.
  await evaluate(client, `(() => {
    document.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, clientX:10, clientY:700}));
    document.dispatchEvent(new KeyboardEvent('keyup', {bubbles:true, key:'Escape'}));
  })()`);
  await sleep(150);
  const visible = await evaluate(client, `getComputedStyle(document.querySelector('[data-ai-sidebar-float]').shadowRoot.querySelector('button')).display !== 'none'`);
  if (visible) fail('queued selection show survived Escape');
  await evaluate(client, `(() => {
    document.getElementById('placement-fixture').remove();
    getSelection().removeAllRanges();
  })()`);
  console.log('     划词定位：普通、顶部、多行、鼠标释放点与取消排队 ✅');
}

// ---------------------------------------------------------------- 主流程

let chrome;
let serverHandle;
const clients = [];
const watchdog = setTimeout(() => {
  console.error('\n❌ 冒烟测试超时（120s）');
  process.exit(2);
}, 120000);
watchdog.unref();

try {
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(PROFILE_DIR), { recursive: true });

  log('1/8', '启动本地测试站（文章页 + 假 OpenAI 接口）');
  serverHandle = await startServer();
  const articleUrl = `${serverHandle.baseUrl}/article?__ai_sidebar_test=1`;
  console.log(`     ${articleUrl}`);

  log('2/8', '启动 headless Chrome（Extensions.loadUnpacked 加载扩展）');
  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--window-size=1280,900',
      '--enable-unsafe-extension-debugging',
      `--user-data-dir=${PROFILE_DIR}`,
      `--remote-debugging-port=${CDP_PORT}`,
      'about:blank'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let chromeStderr = '';
  chrome.stderr.on('data', (chunk) => (chromeStderr += chunk.toString()));

  const version = await waitForCdp();
  const browser = connect(version.webSocketDebuggerUrl);
  clients.push(browser);
  const loaded = await browser.send('Extensions.loadUnpacked', { path: EXT_DIR });
  const extId = loaded.id;
  console.log(`     扩展 ID = ${extId}`);

  let swTarget = null;
  for (let i = 0; i < 30 && !swTarget; i += 1) {
    swTarget = (await listTargets()).find(
      (target) => target.type === 'service_worker' && target.url.includes(`${extId}/background.js`)
    );
    if (!swTarget) await sleep(200);
  }
  if (!swTarget) fail(`扩展的 service worker 没起来。Chrome stderr：\n${chromeStderr.slice(-1200)}`);
  const sw = connect(swTarget.webSocketDebuggerUrl);
  clients.push(sw);
  await sw.send('Runtime.enable');

  // background 的 console.warn 对判断 sidePanel.open 是否失败很有帮助，收集起来
  const swConsole = [];
  sw.onEvent((message) => {
    if (message.method === 'Runtime.consoleAPICalled') {
      const text = (message.params.args || [])
        .map((arg) => arg.value ?? arg.description ?? '')
        .join(' ');
      swConsole.push(text);
      if (process.env.SMOKE_DEBUG) console.log(`     [sw:${message.params.type}] ${text}`);
    }
  });

  // 预置设置：不传 panelMode，验证 DEFAULT_SETTINGS 的默认值（side）真正生效
  await evaluate(
    sw,
    `chrome.storage.local
      .set({
        settings: {
          baseUrl: ${JSON.stringify(`${serverHandle.baseUrl}/v1`)},
          apiKey: 'sk-test',
          model: 'mock-model',
          temperature: 0.2,
          pageCharLimit: 40000,
          systemPrompt: '你是测试用阅读助手。',
          attachPage: true
        }
      })
      .then(() => chrome.storage.local.remove('pendingSelection'))`
  );

  log('3/8', '打开文章页，等待 content.js 注入');
  const articleTarget = await openTarget(articleUrl);
  const page = connect(articleTarget.webSocketDebuggerUrl);
  clients.push(page);
  await page.send('Runtime.enable');
  await waitFor(page, 'document.readyState === "complete"');
  await waitFor(
    page,
    'document.documentElement.getAttribute("data-ai-sidebar-content") === "1"',
    8000,
    'content.js 注入标记'
  );
  console.log('     内容脚本已注入 ✅');
  await checkSelectionPlacement(page);

  // ============ 4. 默认 side 模式：不注入 dock，选区写入 pendingSelection ============
  log('4/8', '默认侧边栏：划词 → 点「问 AI」→ 底部 dock 不出现 + background 暂存选区');
  const firstSelection = await selectParagraph(page, 0, '默认 side');

  const clickedLabel = await clickFloatButton(page);
  console.log(`     点击了「${clickedLabel}」按钮（合成 click，无用户手势）`);

  // 默认 side 模式下内容脚本绝不应展开 dock；给 background 1.5s 处理 ASK_SELECTION
  await sleep(1600);
  const defaultDock = await evaluate(
    page,
    `(() => {
      const dock = document.querySelector('div[data-ai-sidebar-dock]');
      return { exists: !!dock, open: dock ? dock.getAttribute('data-ai-sidebar-dock-open') : null };
    })()`
  );
  if (defaultDock.open === '1') fail('默认 side 模式下仍然展开了底部 dock');
  console.log(`     底部 dock 未展开（exists=${defaultDock.exists}）✅`);

  let pendingSelection = null;
  {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const stored = await evaluate(sw, "chrome.storage.local.get('pendingSelection')");
      pendingSelection = stored && stored.pendingSelection;
      if (pendingSelection && String(pendingSelection.text || '').includes('量子比特')) break;
      await sleep(150);
    }
  }
  if (!pendingSelection || !String(pendingSelection.text || '').includes('量子比特')) {
    fail(`background 没有把选区写入 pendingSelection：${JSON.stringify(pendingSelection)}`);
  }
  if (String(pendingSelection.text) !== firstSelection) {
    fail('pendingSelection 的内容与页面选中文字不一致');
  }
  console.log(`     background 已暂存选区（${pendingSelection.text.length} 字）✅`);

  // 实测记录：headless 下合成点击不会真的打开 side panel；若真的打开了就打印出来
  const sidePageTargetsAtDefault = (await listTargets()).filter(
    (target) => target.type === 'page' && String(target.url).includes('/sidepanel/index.html')
  );
  console.log(
    `     [实测] 合成点击后 sidePanel 页面目标数 = ${sidePageTargetsAtDefault.length}（chrome.sidePanel.open 需要用户手势）`
  );

  // 清掉预置选区，避免接下来侧边栏页面初始化时自动消费它
  await evaluate(sw, "chrome.storage.local.remove('pendingSelection')");

  // ============ 5. EXTRACT_PAGE 正文提取 ============
  log('5/8', 'service worker 调用 EXTRACT_PAGE，校验正文提取');
  const tabs = await evaluate(sw, 'chrome.tabs.query({})');
  const articleTab = tabs.find((tab) => String(tab.url || '').includes('/article'));
  if (!articleTab) fail(`没找到文章标签页：${JSON.stringify(tabs.map((t) => t.url))}`);
  const articleTabId = articleTab.id;

  const extracted = await evaluate(
    sw,
    `chrome.tabs.sendMessage(${articleTabId}, { type: 'EXTRACT_PAGE' })`
  );
  if (!extracted || !extracted.ok) fail(`提取失败：${JSON.stringify(extracted)}`);
  if (!String(extracted.text).includes('量子比特')) fail('提取正文里没有预期关键词「量子比特」');
  if (String(extracted.text).includes('版权所有')) fail('页脚噪音没有被剔除');
  console.log(`     标题「${extracted.title}」，正文 ${extracted.charCount} 字 ✅`);

  // ============ 6. 侧边栏页面：默认 side + 重读 + 总结 SSE ============
  log('6/8', '侧边栏页面：设置默认 side → 重读 → 总结（真实 SSE 流式渲染 + 回答复制）');
  const sideTarget = await openTarget(`chrome-extension://${extId}/sidepanel/index.html`);
  const side = connect(sideTarget.webSocketDebuggerUrl);
  clients.push(side);
  await side.send('Runtime.enable');
  await waitFor(side, 'document.readyState === "complete"');
  await waitFor(side, '!!document.getElementById("summarizeBtn")');

  const manifestName = await evaluate(side, 'chrome.runtime.getManifest().name');
  if (manifestName !== '侧边 AI 阅读助手') fail(`扩展页面 API 不可用，manifest.name = ${manifestName}`);
  console.log(`     侧边栏页面已加载（${manifestName}）✅`);

  // 设置弹窗：默认面板位置应为 side（默认设置未被旧值覆盖）
  const modeUi = await evaluate(
    side,
    `(() => {
      document.getElementById('settingsBtn').click();
      const dialog = document.getElementById('settingsDialog');
      const select = document.getElementById('panelMode');
      const result = {
        open: dialog.open,
        value: select.value,
        options: Array.from(select.options).map((option) => option.value)
      };
      dialog.close();
      return result;
    })()`,
    { awaitPromise: false }
  );
  if (!modeUi.open) fail('设置弹窗打不开');
  if (modeUi.value !== 'side') fail(`设置弹窗默认面板位置不是 side，实际 ${modeUi.value}`);
  if (!modeUi.options.includes('bottom')) fail('设置里没有 bottom 选项');
  console.log(
    `     设置弹窗可打开，面板位置默认「${modeUi.value}」，可选 [${modeUi.options.join(', ')}] ✅`
  );

  // 切到文章页，让「当前标签页」是文章
  await evaluate(side, `chrome.tabs.update(${articleTabId}, { active: true })`);
  await sleep(400);
  await evaluate(side, 'document.getElementById("refreshBtn").click()', { awaitPromise: false });
  await waitFor(side, '/字$/.test(document.getElementById("pageTitle").textContent)', 8000, '页面字数显示');
  const pageLabel = await evaluate(side, 'document.getElementById("pageTitle").textContent');
  console.log(`     页面上下文：${pageLabel} ✅`);

  // 总结本页 → 真实 SSE 流式渲染 → 请求携带页面正文
  serverHandle.captured.chatRequest = null;
  await evaluate(side, 'document.getElementById("summarizeBtn").click()', { awaitPromise: false });
  await waitFor(
    side,
    `document.getElementById('messages').textContent.includes(${JSON.stringify(MOCK_REPLY_TEXT)})`,
    10000,
    '流式回答渲染'
  );
  const rendered = await evaluate(side, 'document.getElementById("messages").textContent');
  if (!rendered.includes(MOCK_REPLY_TEXT)) {
    fail(`界面没有渲染完整回答，实际：${rendered.slice(-300)}`);
  }
  if (rendered.includes('**')) fail('Markdown 没有渲染，界面上残留了 ** 标记');

  {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !serverHandle.captured.chatRequest) await sleep(150);
  }
  const request = serverHandle.captured.chatRequest;
  if (!request) fail('假接口没有收到请求');
  if (request.model !== 'mock-model') fail(`模型名不对：${request.model}`);
  if (request.stream !== true) fail('请求没有开启 stream');
  const systemPrompt = request.messages?.[0]?.content || '';
  if (!systemPrompt.includes('量子比特')) fail('请求里没有附带页面正文');
  if (!String(request.messages?.at(-1)?.content || '').includes('总结')) fail('最后一轮不是总结指令');
  console.log(
    `     请求体：model=${request.model}, stream=true, system ${systemPrompt.length} 字，已带页面正文 ✅`
  );

  // 回答复制：按钮在回答右上角（流式结束后才出现），复制的是原始 Markdown 而不是渲染后的
  // DOM 文本；点击后反馈「已复制」。headless 没有系统剪贴板，这里替换 writeText 捕获内容。
  await waitFor(
    side,
    `!!document.querySelector('#messages .msg.assistant .copy-btn:not([hidden])')`,
    5000,
    '回答复制按钮出现'
  );
  const copyInfo = await evaluate(
    side,
    `(async () => {
      const answers = Array.from(document.querySelectorAll('#messages .msg.assistant'));
      const last = answers[answers.length - 1];
      const button = last ? last.querySelector('.copy-btn') : null;
      if (!button) return { found: false };
      const captured = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text) => { captured.push(text); } }
      });
      button.click();
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && button.textContent !== '已复制') {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return {
        found: true,
        hidden: button.hidden,
        label: button.textContent,
        captured,
        userHasButton: !!document.querySelector('#messages .msg.user .copy-btn')
      };
    })()`
  );
  if (!copyInfo || !copyInfo.found) fail('回答里没有复制按钮');
  if (copyInfo.hidden) fail('回答生成结束后复制按钮仍然隐藏');
  if (copyInfo.userHasButton) fail('用户消息里不应该出现复制按钮');
  if (!copyInfo.captured.length) fail('点复制后没有写入剪贴板');
  if (copyInfo.captured[0] !== MOCK_REPLY_MD) {
    fail(
      `复制内容不是回答的原始 Markdown：${JSON.stringify(copyInfo.captured[0])}` +
        `（期望 ${JSON.stringify(MOCK_REPLY_MD)}）`
    );
  }
  if (!copyInfo.captured[0].includes('**总结**')) fail('复制内容丢失了 Markdown 标记');
  if (copyInfo.label !== '已复制') fail(`复制后的按钮反馈不对：${copyInfo.label}`);
  console.log('     回答复制：原始 Markdown + 「已复制」反馈，用户消息无复制按钮 ✅');

  // ============ 7. 侧边栏收到 SELECTION 广播 ============
  log('7/8', '侧边栏收到 SELECTION 广播 → 请求含选区 + 页面正文');
  serverHandle.captured.chatRequest = null;
  await evaluate(side, `chrome.tabs.update(${articleTabId}, { active: true })`);
  await sleep(400);
  const broadcastText = '侧边栏广播测试：量子比特「同时处于叠加态」在这篇文章里是什么含义？';
  await evaluate(
    sw,
    `chrome.storage.local.set({ pendingSelection: { text: ${JSON.stringify(broadcastText)}, at: Date.now() } })
      .then(() => chrome.runtime.sendMessage({ type: 'SELECTION', pending: true }).catch(() => null))`
  );
  {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline && !serverHandle.captured.chatRequest) await sleep(150);
  }
  const broadcastRequest = serverHandle.captured.chatRequest;
  if (!broadcastRequest) fail('SELECTION 广播后假接口没有收到请求');
  const broadcastUser = String(broadcastRequest.messages?.at(-1)?.content || '');
  if (!broadcastUser.includes('侧边栏广播测试')) {
    fail(`广播请求的用户内容不对：${broadcastUser.slice(0, 160)}`);
  }
  if (!String(broadcastRequest.messages?.[0]?.content || '').includes('量子比特')) {
    fail('广播请求没有附带页面正文');
  }
  await waitFor(
    side,
    `(() => {
      const bodies = Array.from(document.querySelectorAll('#messages .msg.assistant .msg-body'));
      return bodies.length >= 2 && bodies[bodies.length - 1].textContent.includes(${JSON.stringify(MOCK_REPLY_TEXT)});
    })()`,
    10000,
    '广播回答渲染'
  );
  console.log('     广播链路：请求含选区 + 页面正文，界面渲染完成 ✅');

  // 可选：侧边栏页面截图（约 380x900 视口，模拟原生侧边栏宽度）
  const sideShotPath = process.env.SMOKE_SIDE_SCREENSHOT;
  if (sideShotPath) {
    await side.send('Page.enable').catch(() => {});
    await side.send('Emulation.setDeviceMetricsOverride', {
      width: 380,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    });
    await sleep(500);
    // 悬停到最近一条回答上，让「复制」按钮以 hover 状态出现在截图里
    const hoverPoint = await evaluate(
      side,
      `(() => {
        const answers = Array.from(document.querySelectorAll('#messages .msg.assistant'));
        const target = answers[answers.length - 1];
        if (!target) return null;
        const rect = target.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.bottom - 4) };
      })()`
    );
    if (hoverPoint) {
      await side.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: hoverPoint.x,
        y: hoverPoint.y,
        button: 'none',
        buttons: 0
      });
      await sleep(300);
    }
    const info = await saveScreenshot(side, sideShotPath);
    await side.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    console.log(
      `     侧边栏截图已保存：${info.absPath}（${info.width}x${info.height}，${(info.bytes / 1024).toFixed(1)} KB）`
    );
  }

  // 关闭确切的扩展页面 target（不是刷新或只断开 CDP），再创建新 target 验证持久化。
  async function closeSideTarget(target, client) {
    const result = await browser.send('Target.closeTarget', { targetId: target.id });
    if (!result.success) fail(`关闭侧边栏 target 失败：${target.id}`);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (await listTargets()).some((item) => item.id === target.id)) {
      await sleep(150);
    }
    if ((await listTargets()).some((item) => item.id === target.id)) {
      fail(`侧边栏 target 仍未关闭：${target.id}`);
    }
    client.close();
  }
  async function reopenSideTarget() {
    const target = await openTarget(`chrome-extension://${extId}/sidepanel/index.html`);
    const client = connect(target.webSocketDebuggerUrl);
    clients.push(client);
    await client.send('Runtime.enable');
    await waitFor(client, 'document.readyState === "complete"');
    await waitFor(client, '!!document.getElementById("sendBtn")');
    return { target, client };
  }

  // 等待完整回答及异步存储完成，避免在流式渲染中途关闭页面。
  await waitFor(side, '!document.getElementById("sendBtn").disabled', 8000, '广播回答完成');
  const settingsBeforeClear = await evaluate(sw, "chrome.storage.local.get('settings').then(result => result.settings)");
  await closeSideTarget(sideTarget, side);
  const restored = await reopenSideTarget();
  await waitFor(
    restored.client,
    `(() => {
      const users = Array.from(document.querySelectorAll('#messages .msg.user'));
      const answers = Array.from(document.querySelectorAll('#messages .msg.assistant'));
      return users.some(el => el.textContent.includes(${JSON.stringify(broadcastText)})) &&
        answers.some(el => el.textContent.includes(${JSON.stringify(MOCK_REPLY_TEXT)}));
    })()`,
    8000,
    '关闭并重新打开后恢复用户消息和 AI 回答'
  );

  const followUp = '重开后的追问：请继续解释刚才的内容。';
  serverHandle.captured.chatRequest = null;
  await evaluate(restored.client, `(() => {
    document.getElementById('input').value = ${JSON.stringify(followUp)};
    document.getElementById('sendBtn').click();
  })()`, { awaitPromise: false });
  await waitFor(restored.client, '!document.getElementById("sendBtn").disabled', 10000, '追问回答完成');
  const followRequest = serverHandle.captured.chatRequest;
  const followMessages = followRequest?.messages || [];
  const priorUserIndex = followMessages.findIndex(m => m.role === 'user' && String(m.content).includes(broadcastText));
  const priorAnswerIndex = followMessages.findIndex((m, i) => i > priorUserIndex && m.role === 'assistant' && m.content === MOCK_REPLY_MD);
  if (priorUserIndex < 0 || priorAnswerIndex <= priorUserIndex ||
      followMessages.at(-1)?.role !== 'user' || followMessages.at(-1)?.content !== followUp ||
      priorAnswerIndex >= followMessages.length - 1) {
    fail(`重开后的追问未按顺序携带历史：${JSON.stringify(followMessages)}`);
  }
  await evaluate(restored.client, `(() => {
    document.getElementById('input').value = ${JSON.stringify(CLEAR_DURING_STREAM)};
    document.getElementById('sendBtn').click();
  })()`, { awaitPromise: false });
  await waitFor(restored.client, `document.querySelector('.streaming-cursor')?.textContent === ${JSON.stringify(PARTIAL_REPLY)}`, 5000, '清空前已有正在生成的回答');
  await evaluate(restored.client, 'document.getElementById("clearBtn").click()', { awaitPromise: false });
  await waitFor(restored.client, `!!document.querySelector('#messages .empty') &&
    !document.getElementById('clearBtn').disabled && !document.getElementById('sendBtn').disabled`, 5000, '清空界面并停止生成');
  await closeSideTarget(restored.target, restored.client);

  const cleared = await reopenSideTarget();
  // 等待初始化完成后再检查，防止异步恢复历史在断言之后才发生。
  await waitFor(cleared.client, `document.getElementById('modelTag').textContent === 'mock-model'`, 8000, '设置与历史加载');
  const remaining = await evaluate(cleared.client, `Array.from(document.querySelectorAll('#messages .msg.user, #messages .msg.assistant')).map(el => el.textContent)`);
  if (remaining.length) fail(`清空后重开仍有消息：${JSON.stringify(remaining)}`);
  const settingsAfterClear = await evaluate(sw, "chrome.storage.local.get('settings').then(result => result.settings)");
  if (JSON.stringify(settingsAfterClear) !== JSON.stringify(settingsBeforeClear)) fail('清空对话更改了已保存设置');
  const settingsUi = await evaluate(cleared.client, `(() => {
    document.getElementById('settingsBtn').click();
    const result = { baseUrl: document.getElementById('baseUrl').value, apiKey: document.getElementById('apiKey').value,
      model: document.getElementById('model').value, panelMode: document.getElementById('panelMode').value };
    document.getElementById('settingsDialog').close();
    return result;
  })()`);
  if (settingsUi.baseUrl !== `${serverHandle.baseUrl}/v1` || settingsUi.apiKey !== 'sk-test' ||
      settingsUi.model !== 'mock-model' || settingsUi.panelMode !== 'side') fail('清空后重开没有保留设置');

  const freshText = '清空重开后的新问题：量子计算是什么？';
  serverHandle.captured.chatRequest = null;
  await evaluate(cleared.client, `(() => {
    document.getElementById('input').value = ${JSON.stringify(freshText)};
    document.getElementById('sendBtn').click();
  })()`, { awaitPromise: false });
  await waitFor(cleared.client, '!document.getElementById("sendBtn").disabled', 10000, '新对话回答完成');
  const freshRequest = serverHandle.captured.chatRequest;
  const freshMessages = freshRequest?.messages || [];
  if (freshRequest?.model !== 'mock-model' || freshRequest?.temperature !== 0.2 ||
      freshMessages.length !== 2 || freshMessages[0]?.role !== 'system' ||
      freshMessages[1]?.role !== 'user' || freshMessages[1]?.content !== freshText ||
      !String(freshMessages[0]?.content || '').includes('你是测试用阅读助手。')) {
    fail(`清空重开后的请求不是使用原设置的新对话：${JSON.stringify(freshRequest)}`);
  }
  console.log('     侧边栏关闭重开恢复历史及追问；清空后重开保持设置并发送新对话 ✅');

  // 模拟侧栏在文章标签页中打开：独立的扩展测试页本身不能作为正文来源。
  await evaluate(sw, `chrome.tabs.update(${articleTabId}, { active: true })`);
  await waitFor(cleared.client, `document.getElementById('pageTitle').textContent.includes('字')`, 5000, '翻译前已读取文章正文');
  // 翻译必须重新提取当前页面，而不是复用前一次读取；选区不应被当成快捷操作指令。
  const translateBodyMarker = '最新文章内容标记：翻译时必须读取这段新增正文。';
  const translateSelectionMarker = '不应附带的选区快捷指令标记';
  await evaluate(page, `(() => {
    const paragraph = document.createElement('p');
    paragraph.id = 'translate-body-fixture';
    paragraph.textContent = ${JSON.stringify(translateBodyMarker)};
    document.querySelector('article').appendChild(paragraph);
    const selectionFixture = document.createElement('span');
    selectionFixture.id = 'translate-selection-fixture';
    selectionFixture.textContent = ${JSON.stringify(translateSelectionMarker)};
    document.querySelector('nav').appendChild(selectionFixture);
    const range = document.createRange();
    range.selectNodeContents(selectionFixture);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  })()`);
  const translateUi = await evaluate(cleared.client, `(() => {
    const translate = document.getElementById('translateBtn');
    const summarize = document.getElementById('summarizeBtn');
    return { exists: !!translate, label: translate?.textContent.trim(),
      adjacent: !!translate && !!summarize && translate.parentElement === summarize.parentElement &&
        (translate.previousElementSibling === summarize || translate.nextElementSibling === summarize) };
  })()`);
  if (!translateUi.exists || !translateUi.adjacent || !translateUi.label.includes('翻译')) {
    fail(`翻译本页按钮未与总结按钮相邻：${JSON.stringify(translateUi)}`);
  }
  const previousAnswers = await evaluate(cleared.client, `document.querySelectorAll('#messages .msg.assistant').length`);
  serverHandle.captured.chatRequest = null;
  await evaluate(cleared.client, 'document.getElementById("translateBtn").click()', { awaitPromise: false });
  await waitFor(cleared.client, `(() => {
    const answers = document.querySelectorAll('#messages .msg.assistant .msg-body');
    return answers.length > ${previousAnswers} && answers[answers.length - 1].textContent.includes(${JSON.stringify(MOCK_REPLY_TEXT)}) &&
      !document.getElementById('sendBtn').disabled;
  })()`, 10000, '翻译流式回答完成');
  const translateRequest = serverHandle.captured.chatRequest;
  const translateSystem = String(translateRequest?.messages?.[0]?.content || '');
  const translateUser = String(translateRequest?.messages?.at(-1)?.content || '');
  if (translateRequest?.stream !== true || !translateUser.includes('翻译') ||
      !translateUser.includes('简体中文') || !translateSystem.includes(translateBodyMarker) ||
      translateSystem.includes(translateSelectionMarker) || translateUser.includes(translateSelectionMarker)) {
    fail(`翻译请求未使用最新正文或包含选区：${JSON.stringify(translateRequest)}`);
  }
  await evaluate(page, `(() => {
    document.getElementById('translate-body-fixture').remove();
    document.getElementById('translate-selection-fixture').remove();
    getSelection().removeAllRanges();
  })()`);
  console.log('     翻译本页：新提取正文、简体中文指令、不带选区、流式回答 ✅');
  await closeSideTarget(cleared.target, cleared.client);

  // ============ 8. 显式切换到底部模式 ============
  log('8/8', '切到 panelMode=bottom → 划词点「问 AI」→ dock 展开 → 轮询追问');
  await evaluate(
    sw,
    `chrome.storage.local
      .get('settings')
      .then(({ settings }) =>
        chrome.storage.local.set({ settings: { ...(settings || {}), panelMode: 'bottom' } })
      )`
  );
  // background 的 storage.onChanged 会同步 cachedPanelMode 并 setPanelBehavior：
  // bottom 模式下 openPanelOnActionClick=false，把它当成「background 已生效」的可观测信号
  {
    const deadline = Date.now() + 8000;
    let applied = false;
    while (Date.now() < deadline) {
      const behavior = await evaluate(sw, 'chrome.sidePanel.getPanelBehavior()');
      if (behavior && behavior.openPanelOnActionClick === false) {
        applied = true;
        break;
      }
      await sleep(150);
    }
    if (!applied) fail('background 没有在 storage.onChanged 后切到底部模式');
  }
  console.log('     background 已切到底部模式（openPanelOnActionClick=false）✅');

  await evaluate(sw, `chrome.tabs.update(${articleTabId}, { active: true })`);
  await sleep(400);

  serverHandle.captured.chatRequest = null;
  const dockSelection = await selectParagraph(page, 1, '底部模式');
  const dockClickLabel = await clickFloatButton(page);
  console.log(`     再次点击「${dockClickLabel}」按钮`);

  await waitFor(
    page,
    `(() => {
      const dock = document.querySelector('div[data-ai-sidebar-dock]');
      return !!dock && dock.getAttribute('data-ai-sidebar-dock-open') === '1';
    })()`,
    6000,
    '底部 dock 展开'
  );
  const dockInfo = await evaluate(
    page,
    `(() => {
      const dock = document.querySelector('div[data-ai-sidebar-dock]');
      const iframe = dock && dock.shadowRoot && dock.shadowRoot.querySelector('iframe');
      const inner = dock && dock.shadowRoot && dock.shadowRoot.querySelector('.dock');
      return JSON.stringify({
        open: dock && dock.getAttribute('data-ai-sidebar-dock-open'),
        height: Math.round(dock.getBoundingClientRect().height),
        innerHeight: inner ? Math.round(inner.getBoundingClientRect().height) : null,
        viewportHeight: window.innerHeight,
        src: iframe ? iframe.src : null,
        allow: iframe ? iframe.getAttribute('allow') : null
      });
    })()`,
    { awaitPromise: false }
  );
  const parsedDock = JSON.parse(dockInfo);
  if (!parsedDock.src || !parsedDock.src.includes('/sidepanel/index.html?embed=bottom')) {
    fail(`dock iframe 的 src 不是底部嵌入页面：${parsedDock.src}`);
  }
  // 跨域 iframe 默认被权限策略禁掉剪贴板写入，dock 必须显式 allow="clipboard-write"，
  // 否则底部模式里回答的「复制」按钮会一直失败
  if (!String(parsedDock.allow || '').includes('clipboard-write')) {
    fail(`dock iframe 没有放开 clipboard-write：${parsedDock.allow}`);
  }
  // dock 应该是「页面底部面板」，不能铺满整个视口（.dock 必须受 dockHost 高度约束）
  if (parsedDock.innerHeight > parsedDock.height + 2) {
    fail(
      `dock 内层面板高度 ${parsedDock.innerHeight}px 超过 dock 宿主高度 ${parsedDock.height}px，` +
        `底部面板铺满了视口（viewport=${parsedDock.viewportHeight}px）`
    );
  }
  if (parsedDock.height > parsedDock.viewportHeight * 0.85 + 2) {
    fail(
      `dock 宿主高度 ${parsedDock.height}px 超过视口的 85%（viewport=${parsedDock.viewportHeight}px），` +
        '底部面板不应该接近全屏'
    );
  }
  console.log(`     dock 已展开：${dockInfo} ✅`);

  // 点击「问 AI」后 background 写入的 pendingSelection 应被 dock iframe 消费并自动追问
  {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !serverHandle.captured.chatRequest) await sleep(200);
  }
  const dockRequest = serverHandle.captured.chatRequest;
  if (!dockRequest) fail('dock 里的 iframe 没有发起请求（点击产生的选区没被消费）');
  const dockUser = String(dockRequest.messages?.at(-1)?.content || '');
  if (!dockUser.includes(dockSelection.slice(0, 30))) {
    fail(`dock 请求的用户内容不对：${dockUser.slice(0, 160)}`);
  }
  if (!String(dockRequest.messages?.[0]?.content || '').includes('量子比特')) {
    fail('dock 请求没有附带页面正文');
  }
  if (dockRequest.messages?.[1]?.content !== freshText || dockRequest.messages?.[2]?.content !== MOCK_REPLY_MD) {
    fail('底部 dock 没有继续使用侧边栏的对话历史');
  }
  console.log('     dock iframe 已消费点击产生的选区，请求含选区 + 页面正文 ✅');

  // dock 常驻页面：再手动写一次 pendingSelection，验证轮询链路仍可用
  serverHandle.captured.chatRequest = null;
  const polledText = '底部 dock 轮询测试：容错量子计算还需要多长时间才能落地？';
  await evaluate(
    sw,
    `chrome.storage.local.set({ pendingSelection: { text: ${JSON.stringify(polledText)}, at: Date.now() } })`
  );
  {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !serverHandle.captured.chatRequest) await sleep(200);
  }
  const polledRequest = serverHandle.captured.chatRequest;
  if (!polledRequest) fail('dock iframe 没有轮询消费 pendingSelection');
  const polledUser = String(polledRequest.messages?.at(-1)?.content || '');
  if (!polledUser.includes('底部 dock 轮询测试')) {
    fail(`轮询请求的用户内容不对：${polledUser.slice(0, 160)}`);
  }
  if (!String(polledRequest.messages?.[0]?.content || '').includes('量子比特')) {
    fail('轮询请求没有附带页面正文');
  }
  console.log('     dock iframe 轮询 pendingSelection → 请求含选区 + 页面正文 ✅');

  // 可选：整页截图（文章页 + 底部 dock），给 README 用
  const shotPath = process.env.SMOKE_SCREENSHOT;
  if (shotPath) {
    await evaluate(page, '(() => { window.scrollTo(0, 0); return true; })()', {
      awaitPromise: false
    });
    await sleep(1800);
    const info = await saveScreenshot(page, shotPath);
    console.log(
      `     整页截图已保存：${info.absPath}（${info.width}x${info.height}，${(info.bytes / 1024).toFixed(1)} KB）`
    );
  }

  // 收起 dock：宿主应真正变回 display:none，避免高度 0 时内部横条/边框残留
  await evaluate(sw, `chrome.tabs.sendMessage(${articleTabId}, { type: 'CLOSE_DOCK' })`);
  await waitFor(
    page,
    `(() => {
      const dock = document.querySelector('div[data-ai-sidebar-dock]');
      return !!dock && dock.getAttribute('data-ai-sidebar-dock-open') === '0';
    })()`,
    5000,
    'dock 收起'
  );
  const closedDock = await evaluate(
    page,
    `(() => {
      const dock = document.querySelector('div[data-ai-sidebar-dock]');
      return {
        display: getComputedStyle(dock).display,
        height: Math.round(dock.getBoundingClientRect().height)
      };
    })()`
  );
  if (closedDock.display !== 'none') {
    fail(`dock 收起后宿主 display 应为 none，实际 ${closedDock.display}`);
  }
  console.log(`     dock 已收起（display=${closedDock.display}，height=${closedDock.height}）✅`);

  // dock iframe 使用同一扩展页面；单独打开底部模式 URL 验证按钮存在，
  // 不再发送请求，避免干扰上面的选区与历史断言。
  const bottomTarget = await openTarget(`chrome-extension://${extId}/sidepanel/index.html?embed=bottom`);
  const bottom = connect(bottomTarget.webSocketDebuggerUrl);
  clients.push(bottom);
  await bottom.send('Runtime.enable');
  await waitFor(bottom, 'document.readyState === "complete"');
  const bottomUi = await evaluate(bottom, `(() => {
    const translate = document.getElementById('translateBtn');
    const summarize = document.getElementById('summarizeBtn');
    return { exists: !!translate, adjacent: !!translate && !!summarize &&
      translate.parentElement === summarize.parentElement &&
      (translate.previousElementSibling === summarize || translate.nextElementSibling === summarize) };
  })()`);
  if (!bottomUi.exists || !bottomUi.adjacent) fail(`底部模式缺少相邻的翻译本页按钮：${JSON.stringify(bottomUi)}`);
  await closeSideTarget(bottomTarget, bottom);
  console.log('     底部模式页面包含翻译本页按钮 ✅');

  console.log('\n✅ 端到端冒烟测试全部通过（默认浏览器侧边栏 + 可选底部悬浮）：');
  console.log('   - 扩展加载 / content.js 注入');
  console.log('   - 默认 side：划词浮层 → 点「问 AI」→ 不注入底部 dock + background 暂存 pendingSelection');
  console.log('   - EXTRACT_PAGE 正文提取（去导航、去页脚）');
  console.log('   - 侧边栏页面：设置弹窗默认 panelMode=side，可正常打开');
  console.log('   - 侧边栏读取当前页面 → 页面字数');
  console.log('   - 总结本页 → SSE 流式渲染，请求携带页面正文');
  console.log('   - 翻译本页 → 重新提取正文、简体中文指令、不带选区、流式渲染；底部模式按钮存在');
  console.log('   - 回答复制：复制原始 Markdown + 「已复制」反馈，用户消息无按钮；dock iframe 允许 clipboard-write');
  console.log('   - 侧边栏收到 SELECTION 广播 → 请求携带选区 + 页面正文');
  console.log('   - 显式切到 panelMode=bottom（等 background 生效）→ 划词点「问 AI」→ dock 展开（?embed=bottom）');
  console.log('   - dock 尺寸回归：内层面板高度≈宿主高度、宿主 ≤85% 视口；收起后宿主 display:none');
  console.log('   - dock iframe 轮询 pendingSelection → 请求携带选区 + 页面正文');
  process.exitCode = 0;
} catch (error) {
  console.error('\n❌ 冒烟测试失败：', error?.stack || error);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  for (const client of clients) client.close();
  if (chrome) chrome.kill('SIGKILL');
  if (serverHandle) serverHandle.server.close();
  await sleep(400);
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
}
