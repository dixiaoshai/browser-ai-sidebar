import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS } from '../extension/lib/openai.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('DEFAULT_SETTINGS.panelMode 默认为 side（Chrome 原生侧边栏）', () => {
  assert.equal(DEFAULT_SETTINGS.panelMode, 'side');
});

test('DEFAULT_SETTINGS 其他关键默认值未回归', () => {
  assert.equal(DEFAULT_SETTINGS.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(DEFAULT_SETTINGS.apiKey, '');
  assert.equal(DEFAULT_SETTINGS.model, 'deepseek-chat');
  assert.equal(DEFAULT_SETTINGS.temperature, 0.3);
  assert.equal(DEFAULT_SETTINGS.pageCharLimit, 40000);
  assert.equal(DEFAULT_SETTINGS.maxTokens, 0);
  assert.equal(typeof DEFAULT_SETTINGS.systemPrompt, 'string');
  assert.ok(DEFAULT_SETTINGS.systemPrompt.length > 50, 'systemPrompt 默认值不应为空');
});

test('manifest 0.4.0 注册了原生 side_panel 默认页面与复制权限', () => {
  const manifestPath = path.join(ROOT, 'extension', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '0.4.0');
  assert.ok(manifest.permissions.includes('sidePanel'));
  assert.ok(manifest.permissions.includes('clipboardWrite'), '回答复制需要 clipboardWrite 权限');
  assert.equal(manifest.side_panel?.default_path, 'sidepanel/index.html');
  assert.ok(manifest.background?.service_worker === 'background.js');
  assert.ok(
    manifest.web_accessible_resources?.[0]?.resources.includes('lib/clipboard.js'),
    'lib/clipboard.js 应列入 web_accessible_resources（与其余 lib 保持一致）'
  );
});

test('设置弹窗的面板位置选项 side 在前、bottom 可选', () => {
  const htmlPath = path.join(ROOT, 'extension', 'sidepanel', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const select = html.match(/<select id="panelMode">([\s\S]*?)<\/select>/)?.[1];
  assert.ok(select, 'sidepanel/index.html 里找不到 #panelMode 设置项');
  const values = [...select.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(values, ['side', 'bottom']);
  assert.match(select, /value="side"[^>]*>[^<]*推荐/, '默认选项应标明「推荐」');
});
