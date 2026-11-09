#!/usr/bin/env node
/**
 * deepseek-mimo-bridge — zero-dependency MCP stdio server.
 *
 * 把 DeepSeek / MiMo 两个大模型包成 MCP 工具，供 Kimi Work 与 Kimi Code 在对话中
 * 按需调用（单模型、一问一答，不做双模型共答）。
 *
 * 密钥解析顺序（后者兜底）：
 *   1. 环境变量（DEEPSEEK_API_KEY / MIMO_API_KEY，可用 config.json 改名）
 *   2. 插件根目录 config.json 中的 providers.<id>.apiKey
 *   3. DSH（DeepSeek Harness）凭据库 ~/.dsh/.credentials.yaml 的 refs 段
 *      DeepSeek -> DEEPSEEK_API_KEY，MiMo(小米) -> XIAOMI_API_KEY
 *
 * 日志一律写 stderr，stdout 只允许出现 JSON-RPC 报文。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const SERVER_NAME = 'deepseek-mimo-bridge';
const SERVER_VERSION = '0.1.0';
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ID = path.basename(PLUGIN_ROOT);

const MAX_TOKENS_DEFAULT = 8192;
const MAX_TOKENS_CAP = 65536;
const TIMEOUT_MS = 170_000;
const RETRIES = 2;

/** @type {Record<string, any>} 上次调用记录，供 bridge_status 展示 */
const lastCalls = Object.create(null);

function log(...args) {
  process.stderr.write(`[${SERVER_NAME}] ${args.join(' ')}\n`);
}

function loadConfig() {
  const candidates = [];
  if (process.env.KIMI_BRIDGE_CONFIG) candidates.push(process.env.KIMI_BRIDGE_CONFIG);
  candidates.push(path.join(PLUGIN_ROOT, 'config.json'));
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf8');
        if (!raw.trim()) return {};
        return JSON.parse(raw);
      }
    } catch (err) {
      log(`config.json 解析失败（忽略）：${file} ${err.message}`);
    }
  }
  return {};
}

const CONFIG = loadConfig();

function envOr(name, fallback) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

/**
 * 极简 YAML refs 解析器：只读取 ~/.dsh/.credentials.yaml 中 refs 段的一级键值。
 * 该文件由 DSH 写入，结构固定（version / refs / records），无需完整 YAML 能力。
 */
function readDshCredentials(dshHome) {
  const file = path.join(dshHome, '.credentials.yaml');
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  const lines = raw.split(/\r?\n/);
  let inRefs = false;
  let refsIndent = -1;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (/^refs:\s*$/.test(line)) {
      inRefs = true;
      refsIndent = -1;
      continue;
    }
    if (!inRefs) continue;
    if (/^\S/.test(line)) break; // 离开 refs 段
    const m = line.match(/^(\s+)([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    if (refsIndent < 0) refsIndent = indent;
    if (indent !== refsIndent) continue;
    let value = m[3].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) out[m[2]] = value;
  }
  return out;
}

function dshHome() {
  return envOr('DSH_HOME', path.join(os.homedir(), '.dsh'));
}

/** provider 定义（可由 config.json 覆盖端点/模型名/默认参数） */
function buildProviders() {
  const cfgProviders = CONFIG.providers || {};
  return {
    deepseek: {
      id: 'deepseek',
      label: 'DeepSeek',
      baseUrl:
        envOr('DEEPSEEK_BASE_URL', cfgProviders.deepseek?.baseUrl) ||
        'https://api.deepseek.com',
      apiKeyEnv:
        cfgProviders.deepseek?.apiKeyEnv || 'DEEPSEEK_API_KEY',
      credRef: cfgProviders.deepseek?.credRef || 'DEEPSEEK_API_KEY',
      models: cfgProviders.deepseek?.models || ['deepseek-flash', 'deepseek-v4-pro'],
      defaultModel:
        cfgProviders.deepseek?.defaultModel || 'deepseek-flash',
      defaultMaxTokens:
        Number(cfgProviders.deepseek?.maxTokens) || MAX_TOKENS_DEFAULT,
    },
    mimo: {
      id: 'mimo',
      label: 'MiMo',
      baseUrl:
        envOr('MIMO_BASE_URL', cfgProviders.mimo?.baseUrl) ||
        'https://api.xiaomimimo.com/v1',
      apiKeyEnv: cfgProviders.mimo?.apiKeyEnv || 'MIMO_API_KEY',
      credRef: cfgProviders.mimo?.credRef || 'XIAOMI_API_KEY',
      models: cfgProviders.mimo?.models || ['mimo-v2.6-pro', 'mimo-v2.6-flash'],
      defaultModel: cfgProviders.mimo?.defaultModel || 'mimo-v2.6-pro',
      defaultMaxTokens:
        Number(cfgProviders.mimo?.maxTokens) || MAX_TOKENS_DEFAULT,
    },
  };
}

const PROVIDERS = buildProviders();

function mask(key) {
  if (!key) return '(未找到)';
  if (key.length <= 8) return '***';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

function resolveCredential(provider) {
  if (process.env[provider.apiKeyEnv]) {
    return { key: process.env[provider.apiKeyEnv].trim(), source: `环境变量 ${provider.apiKeyEnv}` };
  }
  const cfgKey = CONFIG.providers?.[provider.id]?.apiKey;
  if (cfgKey) return { key: String(cfgKey).trim(), source: 'config.json' };
  const creds = readDshCredentials(dshHome());
  if (creds[provider.credRef]) {
    return { key: creds[provider.credRef], source: `DSH 凭据 ${provider.credRef}` };
  }
  return { key: null, source: null };
}

function clampTokens(n, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(Math.floor(v), MAX_TOKENS_CAP);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class UpstreamError extends Error {
  constructor(message, { status, code, hint, retryable } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.code = code;
    this.hint = hint;
    this.retryable = Boolean(retryable);
  }
}

function httpError(provider, status, bodyText) {
  let detail = '';
  try {
    const parsed = JSON.parse(bodyText);
    detail = parsed?.error?.message || parsed?.message || '';
  } catch {
    detail = String(bodyText || '').slice(0, 500);
  }
  const map = {
    400: '请求被拒绝（检查模型名或参数）',
    401: '鉴权失败（API Key 无效或已过期）',
    403: '无权限（Key 未授权该模型）',
    404: '接口或模型不存在（检查 baseUrl / 模型名）',
    413: '请求体过大（prompt 太长）',
    422: '参数不合法',
    429: '触发限流（RPM/TPM 超限）',
    500: '上游服务错误',
    502: '上游网关错误',
    503: '上游服务不可用',
    504: '上游超时',
  };
  const hint = map[status] || '未知错误';
  const retryable = status === 429 || status >= 500;
  return new UpstreamError(
    `${provider.label} 调用失败：HTTP ${status} — ${hint}${detail ? `\n上游返回：${detail}` : ''}`,
    { status, hint, retryable },
  );
}

/**
 * 调用一家模型的 OpenAI 兼容 Chat Completions 接口。
 * @returns {Promise<{model:string, content:string, reasoning:string, usage:any, elapsedMs:number}>}
 */
async function callProvider(provider, opts) {
  const { prompt, system, model, effort, thinking, maxTokens } = opts;
  if (!prompt || !String(prompt).trim()) {
    throw new Error('prompt 不能为空');
  }
  if (String(prompt).length > 600_000) {
    throw new Error('prompt 过长（超过 60 万字符），请先分段或提炼后再调用');
  }
  const cred = resolveCredential(provider);
  if (!cred.key) {
    throw new Error(
      `${provider.label} 缺少 API Key。请设置环境变量 ${provider.apiKeyEnv}，` +
        `或在插件目录 config.json 的 providers.${provider.id}.apiKey 中填写，` +
        `或确认 ${path.join(dshHome(), '.credentials.yaml')} 的 refs 段包含 ${provider.credRef}。`,
    );
  }

  const chosenModel = model || provider.defaultModel;
  if (!provider.models.includes(chosenModel)) {
    throw new Error(
      `不支持的模型 ${chosenModel}；${provider.label} 可选：${provider.models.join(' / ')}`,
    );
  }

  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const messages = [];
  if (system && String(system).trim()) {
    messages.push({ role: 'system', content: String(system) });
  }
  messages.push({ role: 'user', content: String(prompt) });

  const body = { model: chosenModel, messages, stream: false };
  if (provider.id === 'deepseek') {
    body.max_tokens = clampTokens(maxTokens, provider.defaultMaxTokens);
    if (effort === 'off') {
      body.thinking = { type: 'disabled' };
    } else {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = effort || 'high';
    }
  } else {
    body.max_completion_tokens = clampTokens(maxTokens, provider.defaultMaxTokens);
    body.thinking = { type: thinking === 'off' ? 'disabled' : 'enabled' };
  }

  const started = Date.now();
  let lastError;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cred.key}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw httpError(provider, res.status, text);
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new UpstreamError(`${provider.label} 返回了非 JSON 响应：${text.slice(0, 300)}`);
      }
      const choice = json?.choices?.[0];
      const message = choice?.message || {};
      let content = message.content;
      if (Array.isArray(content)) {
        content = content
          .map((part) => (typeof part === 'string' ? part : part?.text || ''))
          .join('');
      }
      const result = {
        model: json?.model || chosenModel,
        content: String(content ?? '').trim(),
        reasoning: String(message.reasoning_content ?? '').trim(),
        usage: json?.usage || null,
        finishReason: choice?.finish_reason || null,
        elapsedMs: Date.now() - started,
      };
      if (!result.content && !result.reasoning) {
        throw new UpstreamError(
          `${provider.label} 返回了空内容（finish_reason=${result.finishReason || 'unknown'}）。` +
            `若因长度截断，请提高 max_tokens。`,
        );
      }
      return result;
    } catch (err) {
      const isAbort = err?.name === 'AbortError';
      if (isAbort) {
        lastError = new UpstreamError(
          `${provider.label} 调用超时（>${Math.round(TIMEOUT_MS / 1000)}s）。可稍后重试或缩短 prompt。`,
          { retryable: false },
        );
      } else if (err instanceof UpstreamError) {
        lastError = err;
      } else {
        lastError = new UpstreamError(
          `${provider.label} 网络层错误：${err?.message || err}（检查网络/代理或 baseUrl）`,
          { retryable: true },
        );
      }
      const canRetry = attempt < RETRIES && (lastError.retryable ?? true);
      if (!canRetry) break;
      await sleep(800 * (attempt + 1) ** 2);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function formatAnswer(provider, model, result, meta) {
  const usage = result.usage || {};
  const tokenLine = [
    usage.prompt_tokens != null ? `输入 ${usage.prompt_tokens}` : null,
    usage.completion_tokens != null ? `输出 ${usage.completion_tokens}` : null,
    usage.completion_tokens_details?.reasoning_tokens
      ? `其中思考 ${usage.completion_tokens_details.reasoning_tokens}`
      : null,
  ]
    .filter(Boolean)
    .join(' / ');

  const header = [
    `## ${provider.label} · ${model}`,
    `参数：${meta.params}`,
    `耗时：${(result.elapsedMs / 1000).toFixed(1)}s${tokenLine ? `　tokens：${tokenLine}` : ''}` +
      `${result.finishReason && result.finishReason !== 'stop' ? `　finish=${result.finishReason}` : ''}`,
  ].join('\n');

  const parts = [header, '', result.content || '(无正文)'];
  if (result.reasoning) {
    const trimmed =
      result.reasoning.length > 12_000
        ? `${result.reasoning.slice(0, 12_000)}\n…（思考内容过长，已截断）`
        : result.reasoning;
    parts.push('', '### 思考过程（原文，供参考）', trimmed);
  }
  parts.push('', `> 以上内容由 ${provider.label} 生成，Kimi 负责转述与整合。`);
  return parts.join('\n');
}

// --------------------------------------------------------------------------
// 工具定义
// --------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'ask_deepseek',
    title: '问 DeepSeek',
    description:
      '把一个问题/代码/文稿片段交给 DeepSeek 模型（deepseek-flash 或 deepseek-v4-pro），' +
      '返回它的完整回答与思考过程。适合需要第二意见、代码审查、硬核推理、中文写作时调用。' +
      '单次一问一答，不携带历史会话；需要上下文时把相关材料一起放进 prompt。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '要问 DeepSeek 的完整内容（含必要上下文）' },
        system: { type: 'string', description: '可选的 system 提示词，用于设定角色/格式' },
        model: {
          type: 'string',
          enum: ['deepseek-flash', 'deepseek-v4-pro'],
          description: '默认 deepseek-flash（快、便宜）；复杂任务用 deepseek-v4-pro',
        },
        effort: {
          type: 'string',
          enum: ['off', 'low', 'high', 'max'],
          description: '思考强度，默认 high；off = 关闭思考模式',
        },
        max_tokens: {
          type: 'number',
          description: `输出上限（含思考），默认 8192，上限 ${MAX_TOKENS_CAP}`,
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'ask_mimo',
    title: '问 MiMo',
    description:
      '把一个问题/代码/文稿片段交给小米 MiMo 模型（mimo-v2.6-pro 或 mimo-v2.6-flash），' +
      '返回回答与思考过程。适合换一个模型视角、长上下文阅读、多模态理解前的文本整理场景。' +
      '单次一问一答，不携带历史会话。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '要问 MiMo 的完整内容（含必要上下文）' },
        system: { type: 'string', description: '可选的 system 提示词' },
        model: {
          type: 'string',
          enum: ['mimo-v2.6-pro', 'mimo-v2.6-flash'],
          description: '默认 mimo-v2.6-pro；高频批量任务用 mimo-v2.6-flash',
        },
        thinking: {
          type: 'string',
          enum: ['on', 'off'],
          description: '深度思考开关，默认 on',
        },
        max_tokens: {
          type: 'number',
          description: `输出上限（含思考），默认 8192，上限 ${MAX_TOKENS_CAP}`,
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'bridge_status',
    title: '桥接自检',
    description:
      '检查 deepseek-mimo-bridge 的运行状态：密钥是否检测到（来源与掩码）、端点、可用模型、上次调用情况。' +
      '调用失败或怀疑没配好时先跑这个。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

async function toolAsk(providerId, args) {
  const provider = PROVIDERS[providerId];
  const meta = { params: '' };
  const opts = {
    prompt: args.prompt,
    system: args.system,
    model: args.model,
    effort: args.effort,
    thinking: args.thinking,
    maxTokens: args.max_tokens,
  };

  try {
    const result = await callProvider(provider, opts);
    if (providerId === 'deepseek') {
      meta.params = `model=${result.model} effort=${opts.effort || 'high'}`;
    } else {
      meta.params = `model=${result.model} thinking=${opts.thinking || 'on'}`;
    }
    lastCalls[providerId] = {
      at: new Date().toISOString(),
      ok: true,
      model: result.model,
      elapsedMs: result.elapsedMs,
    };
    return {
      content: [{ type: 'text', text: formatAnswer(provider, result.model, result, meta) }],
    };
  } catch (err) {
    lastCalls[providerId] = {
      at: new Date().toISOString(),
      ok: false,
      error: String(err?.message || err).slice(0, 300),
    };
    throw err;
  }
}

function toolStatus() {
  const providers = Object.values(PROVIDERS).map((p) => {
    const cred = resolveCredential(p);
    return {
      provider: p.id,
      label: p.label,
      baseUrl: p.baseUrl,
      models: p.models,
      defaultModel: p.defaultModel,
      apiKey: {
        found: Boolean(cred.key),
        masked: mask(cred.key),
        source: cred.source || '未找到（见 README 的密钥配置）',
      },
      lastCall: lastCalls[p.id] || '本次进程尚未调用',
    };
  });
  const report = {
    server: `${SERVER_NAME} v${SERVER_VERSION}`,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    pluginRoot: PLUGIN_ROOT,
    pluginId: PLUGIN_ID,
    configFile: process.env.KIMI_BRIDGE_CONFIG
      ? process.env.KIMI_BRIDGE_CONFIG
      : path.join(PLUGIN_ROOT, 'config.json'),
    dshCredentials: path.join(dshHome(), '.credentials.yaml'),
    providers,
  };
  return {
    content: [{ type: 'text', text: '```json\n' + JSON.stringify(report, null, 2) + '\n```' }],
  };
}

// --------------------------------------------------------------------------
// MCP stdio 传输层（JSON-RPC 2.0，按行分隔）
// --------------------------------------------------------------------------

const PROTOCOL_FALLBACK = '2025-06-18';
let initialized = false;

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  send({ jsonrpc: '2.0', id, error });
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    initialized = true;
    const requested = params?.protocolVersion;
    reply(id, {
      protocolVersion: typeof requested === 'string' && requested ? requested : PROTOCOL_FALLBACK,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        title: 'DeepSeek / MiMo 顾问桥',
      },
      instructions:
        'DeepSeek 与 MiMo 的外部模型顾问。按用户要求，用 ask_deepseek / ask_mimo 把问题转给指定模型；' +
        '一次只调用一个模型，不要用两个模型回答同一个问题。调用失败先跑 bridge_status。',
    });
    return;
  }

  if (method === 'ping') {
    reply(id, {});
    return;
  }

  if (method === 'tools/list') {
    reply(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      let result;
      if (name === 'ask_deepseek') result = await toolAsk('deepseek', args);
      else if (name === 'ask_mimo') result = await toolAsk('mimo', args);
      else if (name === 'bridge_status') result = toolStatus();
      else {
        replyError(id, -32602, `未知工具：${name}`, { tools: TOOLS.map((t) => t.name) });
        return;
      }
      reply(id, result);
    } catch (err) {
      log(`tools/call ${name} 失败：${err?.stack || err}`);
      const message = String(err?.message || err);
      const hint =
        '排查步骤：1) 调 bridge_status 看密钥是否检测到；2) 确认网络可访问对应 API；' +
        '3) 检查模型名是否为当前有效版本；4) 401/403 换 Key，429 降低频率。';
      reply(id, {
        content: [{ type: 'text', text: `${message}\n\n${hint}` }],
        isError: true,
      });
    }
    return;
  }

  // 其余方法（含 resources/list、prompts/list）明确不支持
  replyError(id, -32601, `方法未实现：${method}`);
}

function handleNotification(msg) {
  const { method } = msg;
  if (method === 'notifications/initialized') {
    log('客户端完成初始化');
    return;
  }
  if (method === 'notifications/cancelled') {
    log('收到取消通知（当前调用不中断，等待其自然结束）');
    return;
  }
  // 其他通知静默忽略
}

function start() {
  log(
    `启动 v${SERVER_VERSION} · node ${process.version} · 插件根目录 ${PLUGIN_ROOT} · ` +
      `密钥来源优先级 env > config.json > ${path.join(dshHome(), '.credentials.yaml')}`,
  );

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (err) {
      log(`收到非法 JSON：${trimmed.slice(0, 200)}`);
      replyError(null, -32700, 'Parse error');
      return;
    }
    if (!msg || typeof msg !== 'object') {
      replyError(null, -32600, 'Invalid Request');
      return;
    }
    const isNotification = msg.id === undefined || msg.id === null;
    if (isNotification) {
      handleNotification(msg);
      return;
    }
    handleRequest(msg).catch((err) => {
      log(`请求处理异常：${err?.stack || err}`);
      replyError(msg.id, -32603, `内部错误：${err?.message || err}`);
    });
  });

  rl.on('close', () => {
    log('stdin 关闭，退出');
    process.exit(0);
  });

  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  process.on('uncaughtException', (err) => {
    log(`未捕获异常：${err?.stack || err}`);
  });
}

start();
