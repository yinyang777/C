#!/usr/bin/env node
/**
 * 本地冒烟测试：不需要 Kimi，直接以 MCP stdio 协议和 server/index.mjs 对话。
 *
 * 用法：
 *   node test/mcp-smoke.mjs              # 握手 + 列工具 + 两家各真调一次
 *   node test/mcp-smoke.mjs --offline    # 只验证协议与配置，不发真实请求
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const SERVER = path.join(PLUGIN_ROOT, 'server', 'index.mjs');
const OFFLINE = process.argv.includes('--offline');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const child = spawn(process.execPath, [SERVER], {
  cwd: PLUGIN_ROOT,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, KIMI_SMOKE_TEST: '1' },
});

let buffer = '';
const pending = new Map();
let seq = 0;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error('[client] 收到非 JSON 行：', line.slice(0, 200));
      continue;
    }
    if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
      const { resolve, timer } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));

function request(method, params, timeoutMs = 200_000) {
  const id = ++seq;
  const payload = { jsonrpc: '2.0', id, method };
  if (params !== undefined) payload.params = params;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`请求超时：${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, timer });
  });
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  return promise;
}

function notify(method, params) {
  const payload = { jsonrpc: '2.0', method };
  if (params !== undefined) payload.params = params;
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

const textOf = (msg) =>
  (msg?.result?.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

async function main() {
  // 1) 握手
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'mcp-smoke', version: '0.0.0' },
  });
  check(
    'initialize 握手',
    init.result?.serverInfo?.name === 'deepseek-mimo-bridge' &&
      typeof init.result?.protocolVersion === 'string',
    `protocolVersion=${init.result?.protocolVersion}`,
  );
  notify('notifications/initialized');

  // 2) 工具清单
  const list = await request('tools/list', {});
  const names = (list.result?.tools || []).map((t) => t.name).sort();
  check(
    'tools/list 暴露 3 个工具',
    names.length === 3 &&
      names.join(',') === 'ask_deepseek,ask_mimo,bridge_status',
    names.join(', '),
  );

  // 3) 自检
  const status = await request('tools/call', { name: 'bridge_status', arguments: {} });
  const statusText = textOf(status);
  check('bridge_status 返回 JSON', statusText.includes('"server"'), '');
  let parsed = null;
  try {
    parsed = JSON.parse(statusText.replace(/^```json\s*/, '').replace(/\s*```$/, ''));
  } catch {
    /* 忽略解析失败，下面只做文本断言 */
  }
  if (parsed) {
    for (const p of parsed.providers || []) {
      console.log(`       ${p.provider}: key=${p.apiKey.found ? p.apiKey.masked : '未找到'} 来源=${p.apiKey.source}`);
    }
  }

  if (OFFLINE) {
    check('离线模式跳过真实调用', true, '');
  } else {
    // 4) DeepSeek 真实调用
    const ds = await request('tools/call', {
      name: 'ask_deepseek',
      arguments: {
        prompt: '用一句话说明你是哪个厂商的哪个模型，并说出你支持的最大上下文长度。',
        max_tokens: 512,
      },
    });
    const dsText = textOf(ds);
    check(
      'ask_deepseek 真实调用',
      !ds.result?.isError && dsText.length > 20,
      dsText.split('\n')[0] || '',
    );
    console.log(`---- DeepSeek 返回（前 400 字）----\n${dsText.slice(0, 400)}\n`);

    // 5) MiMo 真实调用
    const mm = await request('tools/call', {
      name: 'ask_mimo',
      arguments: {
        prompt: '用一句话说明你是谁、由哪家公司研发，以及你的知识截止时间。',
        max_tokens: 512,
      },
    });
    const mmText = textOf(mm);
    check(
      'ask_mimo 真实调用',
      !mm.result?.isError && mmText.length > 20,
      mmText.split('\n')[0] || '',
    );
    console.log(`---- MiMo 返回（前 400 字）----\n${mmText.slice(0, 400)}\n`);
  }

  // 6) 错误路径：不存在的工具
  const bad = await request('tools/call', { name: 'no_such_tool', arguments: {} });
  check('未知工具返回 JSON-RPC 错误', bad.error?.code === -32602, bad.error?.message || '');
}

main()
  .catch((err) => {
    check('测试执行', false, err?.message || String(err));
  })
  .finally(() => {
    const failed = results.filter((r) => !r.ok);
    child.stdin.end();
    child.kill();
    console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
    process.exit(failed.length === 0 ? 0 : 1);
  });
