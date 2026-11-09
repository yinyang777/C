#!/usr/bin/env node
/**
 * 轻量 manifest 校验：对照 https://statics.kimi.ai/catalog/schemas/kimi.plugin.schema.json
 * 里对本插件有约束的字段做检查（不引入 ajv 依赖，保持插件零依赖）。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const errors = [];
const warns = [];
const ok = [];

function check(cond, msg, warnOnly = false) {
  if (cond) ok.push(msg);
  else (warnOnly ? warns : errors).push(msg);
}

const manifestPath = path.join(ROOT, 'kimi.plugin.json');
check(fs.existsSync(manifestPath), 'kimi.plugin.json 存在');
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

check(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(m.name || ''), `name 合法：${m.name}`);
check(
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(m.version || ''),
  `version 是完整 semver：${m.version}`,
);
check(typeof m.description === 'string' && m.description.length > 0, 'description 非空');

const iface = m.interface || {};
check(typeof iface.iconUrl === 'string' && /^https?:\/\//.test(iface.iconUrl), 'interface.iconUrl 为公网 http(s) 地址（发布必需）', true);
check((iface.shortDescription || '').length <= 20, `shortDescription ≤20（当前 ${(iface.shortDescription || '').length}）`);
check((iface.longDescription || '').length <= 500, `longDescription ≤500（当前 ${(iface.longDescription || '').length}）`);
check((iface.tryPrompts || []).length >= 1, 'tryPrompts 至少一条');
for (const p of iface.tryPrompts || []) {
  check(p.length <= 60 && !/[。！？.!?]$/.test(p), `tryPrompt 合规：${p}`, true);
}
const allowedPlatforms = ['macos', 'windows', 'linux', 'ios', 'android', 'harmonyos'];
check((iface.platforms || []).every((p) => allowedPlatforms.includes(p)), 'platforms 取值合法');
check(['hosted', 'local'].includes(iface.hostKind), 'hostKind 合法');
check(typeof iface.defaultLocale === 'string', 'defaultLocale 已声明');

const servers = m.mcpServers || {};
const serverKeys = Object.keys(servers);
check(serverKeys.length >= 1, 'mcpServers 至少一个服务');
for (const [key, s] of Object.entries(servers)) {
  check(Boolean(s.command) !== Boolean(s.url), `mcpServers.${key} 只声明 command 或 url 之一`);
  if (s.command) {
    check(s.command === 'node' || s.command.startsWith('./') || /^[A-Za-z]:\\/.test(s.command), `mcpServers.${key}.command 可解析：${s.command}`, true);
    check(typeof s.cwd === 'string' && s.cwd.startsWith('./'), `mcpServers.${key}.cwd 位于插件目录内`);
    for (const a of s.args || []) check(a.startsWith('./') || !a.startsWith('/'), `args 路径不越界：${a}`, true);
    for (const tool of s.enabledTools || []) check(typeof tool === 'string', `enabledTools 合法：${tool}`);
    check(Number.isInteger(s.toolTimeoutMs), 'toolTimeoutMs 是整数');
  }
}

// skills / commands / systemPromptPath 必须真实存在
const resolveIn = (p) => path.resolve(ROOT, p.replace(/^\.\//, ''));
if (m.skills) {
  const list = Array.isArray(m.skills) ? m.skills : [m.skills];
  for (const s of list) {
    check(!path.relative(ROOT, resolveIn(s)).startsWith('..'), `skills 路径在插件内：${s}`);
    check(fs.existsSync(resolveIn(s)), `skills 路径存在：${s}`);
  }
}
if (m.commands) {
  const list = Array.isArray(m.commands) ? m.commands : [m.commands];
  for (const c of list) check(fs.existsSync(resolveIn(c)), `commands 路径存在：${c}`);
}
if (m.systemPromptPath) check(fs.existsSync(resolveIn(m.systemPromptPath)), `systemPromptPath 存在：${m.systemPromptPath}`);
for (const f of ['server/index.mjs', 'README.md']) check(fs.existsSync(path.join(ROOT, f)), `文件存在：${f}`);

// 服务端工具与 manifest 的 enabledTools 对齐（静态解析，避免真正启动服务）
const serverSrc = fs.readFileSync(path.join(ROOT, 'server/index.mjs'), 'utf8');
const toolNames = [...serverSrc.matchAll(/name: '(ask_deepseek|ask_mimo|bridge_status)'/g)].map((x) => x[1]);
const enabled = servers[serverKeys[0]]?.enabledTools || [];
check(
  enabled.length === new Set(enabled).size,
  'enabledTools 无重复',
);
for (const t of enabled) check(toolNames.includes(t), `enabledTools 对应的工具已实现：${t}`);

const pass = errors.length === 0;
console.log(`校验：${ok.length} 通过 / ${warns.length} 警告 / ${errors.length} 失败`);
for (const w of warns) console.log(`  WARN  ${w}`);
for (const e of errors) console.log(`  FAIL  ${e}`);
process.exit(pass ? 0 : 1);
