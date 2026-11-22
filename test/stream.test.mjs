import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { streamChat, normalizeBaseUrl, parseSseLine, DONE } from '../extension/lib/openai.js';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

async function collect(iterator) {
  let output = '';
  for await (const delta of iterator) output += delta;
  return output;
}

const baseArgs = {
  apiKey: 'sk-test',
  model: 'test-model',
  messages: [{ role: 'user', content: 'hi' }]
};

test('normalizeBaseUrl 去掉末尾斜杠与误填的完整路径', () => {
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1');
  assert.equal(normalizeBaseUrl(' https://x.dev/v1/chat/completions '), 'https://x.dev/v1');
  assert.throws(() => normalizeBaseUrl(''), /Base URL/);
  assert.throws(() => normalizeBaseUrl('api.example.com/v1'), /http/);
});

test('parseSseLine 处理增量、[DONE]、心跳与错误', () => {
  assert.equal(parseSseLine('data: {"choices":[{"delta":{"content":"你"}}]}'), '你');
  assert.equal(parseSseLine('data: [DONE]'), DONE);
  assert.equal(parseSseLine(': keep-alive'), null);
  assert.equal(parseSseLine('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}'), null);
  assert.equal(parseSseLine('data: {"choices":[{"delta":{"reasoning_content":"想一想"}}]}'), null);
  assert.throws(() => parseSseLine('data: {"error":{"message":"bad key"}}'), /bad key/);
});

test('流式读取：跨 TCP 分片的 SSE 也能拼出完整文本', async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer sk-test');
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      assert.equal(parsed.stream, true);
      assert.equal(parsed.model, 'test-model');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const payload =
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"好"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"，世界"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
        'data: [DONE]\n\n' +
        'data: {"choices":[{"delta":{"content":"不该出现"}}]}\n\n';
      // 故意切成很碎的片段，模拟网络分片
      for (let i = 0; i < payload.length; i += 7) {
        res.write(payload.slice(i, i + 7));
      }
      res.end();
    });
  });

  try {
    const text = await collect(streamChat({ ...baseArgs, baseUrl }));
    assert.equal(text, '你好，世界');
  } finally {
    server.close();
  }
});

test('最后一行没有换行符也能收尾', async () => {
  const { server, baseUrl } = await startServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"尾巴"}}]}');
  });
  try {
    assert.equal(await collect(streamChat({ ...baseArgs, baseUrl })), '尾巴');
  } finally {
    server.close();
  }
});

test('HTTP 401 给出可读错误（含 hint 与服务端 message）', async () => {
  const { server, baseUrl } = await startServer((_req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
  });
  try {
    await assert.rejects(collect(streamChat({ ...baseArgs, baseUrl })), (error) => {
      assert.match(error.message, /HTTP 401/);
      assert.match(error.message, /invalid api key/);
      assert.match(error.message, /API Key 无效/);
      return true;
    });
  } finally {
    server.close();
  }
});

test('网关忽略 stream 直接返回 JSON 时也能拿到文本', async () => {
  const { server, baseUrl } = await startServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '整段返回' } }]
      })
    );
  });
  try {
    assert.equal(await collect(streamChat({ ...baseArgs, baseUrl })), '整段返回');
  } finally {
    server.close();
  }
});

test('缺少 API Key 时直接报错，不发请求', async () => {
  let hit = false;
  const { server, baseUrl } = await startServer((_req, res) => {
    hit = true;
    res.end('{}');
  });
  try {
    await assert.rejects(collect(streamChat({ ...baseArgs, apiKey: '', baseUrl })), /API Key/);
    assert.equal(hit, false);
  } finally {
    server.close();
  }
});

test('AbortSignal 能中断流式读取', async () => {
  const { server, baseUrl } = await startServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n');
    // 不再 end，模拟长连接
  });
  const controller = new AbortController();
  try {
    const iterator = streamChat({ ...baseArgs, baseUrl, signal: controller.signal });
    let received = '';
    await assert.rejects(async () => {
      for await (const delta of iterator) {
        received += delta;
        controller.abort();
      }
    }, (error) => error.name === 'AbortError' || /abort/i.test(String(error)));
    assert.equal(received, '第一段');
  } finally {
    server.close();
  }
});
