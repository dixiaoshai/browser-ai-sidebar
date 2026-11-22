/**
 * 极简 OpenAI 兼容客户端（纯函数，不依赖 chrome API，方便在 Node 里单测）。
 *
 * 只做两件事：
 *   1. 规范化 Base URL，拼出 /chat/completions
 *   2. 流式（SSE）读取增量文本；服务端不支持流式时自动退回整段 JSON
 */

export const DEFAULT_SETTINGS = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.3,
  // 面板呈现方式：side = 浏览器原生侧边栏（默认），bottom = 页面底部悬浮（可选）
  panelMode: 'side',
  // 每轮最多带多少字的页面正文
  pageCharLimit: 40000,
  // 0 表示不显式传 max_tokens（交给服务端默认）
  maxTokens: 0,
  systemPrompt:
    '你是一个严谨、简洁的中文阅读助手。用户正在浏览器里阅读一个网页，我会把页面正文提供给你。\n' +
    '规则：\n' +
    '1. 优先基于页面内容回答；页面里没有的信息要明确说“页面中没有提到”，不要编造。\n' +
    '2. 回答用中文，尽量短，能引用原文时用「」引一小段。\n' +
    '3. 用户问“这段是什么意思”时，先解释字面意思，再说明它在上下文里的作用。'
};

/** 去掉末尾斜杠；如果用户误填了完整的 /chat/completions，也自动剥掉 */
export function normalizeBaseUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) throw new Error('请先填写 API Base URL');
  url = url.replace(/\/+$/, '');
  url = url.replace(/\/chat\/completions$/i, '');
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Base URL 需以 http:// 或 https:// 开头');
  }
  return url;
}

/** 统一的错误信息，方便界面直接展示 */
export function formatHttpError(status, body) {
  let detail = String(body || '').slice(0, 600).trim();
  try {
    const json = JSON.parse(body);
    detail =
      json?.error?.message ||
      json?.message ||
      json?.error ||
      detail;
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch {
    /* 不是 JSON，保留原文本 */
  }
  const hint =
    status === 401
      ? '（API Key 无效或没有权限）'
      : status === 404
        ? '（接口地址不对，检查 Base URL 是否要带 /v1）'
        : status === 429
          ? '（限流或余额不足）'
          : '';
  return `请求失败：HTTP ${status}${hint}\n${detail}`;
}

function buildPayload({ model, messages, temperature, maxTokens }) {
  if (!model) throw new Error('请先在设置里填写模型名，例如 deepseek-chat');
  const payload = { model, messages, stream: true };
  if (typeof temperature === 'number') payload.temperature = temperature;
  if (maxTokens && maxTokens > 0) payload.max_tokens = maxTokens;
  return payload;
}

/**
 * 解析一行 SSE，返回：
 *   string        -> 增量文本
 *   DONE          -> 结束标记
 *   null          -> 忽略（空行、注释、心跳、usage 等）
 */
export const DONE = Symbol('done');
export function parseSseLine(line) {
  const trimmed = line.replace(/\r$/, '');
  if (!trimmed || trimmed.startsWith(':')) return null;
  if (!trimmed.startsWith('data:')) return null;
  const data = trimmed.slice(5).trim();
  if (!data) return null;
  if (data === '[DONE]') return DONE;
  let json;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  if (json?.error) {
    throw new Error(json.error.message || String(json.error));
  }
  const choice = json?.choices?.[0];
  if (!choice) return null;
  const delta = choice.delta ?? choice.message ?? {};
  // 兼容 reasoning_content（DeepSeek R1 类模型），但默认只产出正文
  const text = delta.content;
  if (typeof text === 'string' && text.length) return text;
  return null;
}

function extractAssistantContent(json) {
  const choice = json?.choices?.[0];
  if (!choice) {
    if (json?.error) throw new Error(json.error.message || String(json.error));
    return '';
  }
  const content = choice.message?.content ?? choice.delta?.content ?? '';
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  }
  return typeof content === 'string' ? content : '';
}

/**
 * 流式聊天。异步生成器，逐段 yield 文本。
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {Array<{role: string, content: string}>} opts.messages
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @param {AbortSignal} [opts.signal]
 * @param {typeof fetch} [opts.fetchImpl] 便于测试注入
 */
export async function* streamChat({
  baseUrl,
  apiKey,
  model,
  messages,
  temperature,
  maxTokens,
  signal,
  fetchImpl = globalThis.fetch
}) {
  if (!apiKey) throw new Error('请先在设置里填写 API Key');
  if (typeof fetchImpl !== 'function') throw new Error('当前环境不支持 fetch');
  const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(buildPayload({ model, messages, temperature, maxTokens })),
    signal
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(formatHttpError(res.status, body));
  }

  const contentType = (res.headers?.get?.('content-type') || '').toLowerCase();

  // 有些网关会忽略 stream:true，直接返回完整 JSON
  if (contentType.includes('application/json') && !contentType.includes('event-stream')) {
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`服务端返回了无法解析的内容：${text.slice(0, 300)}`);
    }
    const content = extractAssistantContent(json);
    if (content) yield content;
    return;
  }

  if (!res.body) {
    throw new Error('服务端没有返回可读取的响应体');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const parsed = parseSseLine(line);
        if (parsed === DONE) return;
        if (parsed) yield parsed;
      }
    }
    // 收尾：处理最后一行没有换行符的情况
    buffer += decoder.decode();
    const tail = parseSseLine(buffer);
    if (tail && tail !== DONE) yield tail;
  } finally {
    reader.releaseLock?.();
  }
}

/** 设置面板里的“测试连接”：发一个最小请求，返回模型回复的前若干字符 */
export async function testConnection({ baseUrl, apiKey, model, fetchImpl = globalThis.fetch }) {
  const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: '回复两个字：可用' }],
      stream: false,
      max_tokens: 16
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(formatHttpError(res.status, body));
  }
  const json = await res.json();
  return extractAssistantContent(json) || '（连接成功，但模型返回为空）';
}
