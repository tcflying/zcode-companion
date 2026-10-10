#!/usr/bin/env node
// ZCC-AUTH-20261008 v3：只输出 custom_provider.zcc-companion 子树的**结构与模型标识**
// 硬约束：不输出任何 apiKey/token 值；非 zcc-companion 块一律不读、不 dump。
'use strict';

const { readFileSync } = require('node:fs');
const { readYamlScalarAtPath } = require('../../apps/desktop/lib/settings.cjs');

const CONFIG = 'C:/Users/datoo/.minimax/config.yaml';
const BASE = ['custom_provider', 'zcc-companion'];
const SECRET_LEAF = /^(apiKey|api_key|token|secret|password|authorization)$/i;

const text = readFileSync(CONFIG, 'utf8');
const lines = text.split(/\r?\n/);

// 1) 只在 zcc-companion 子树内收集键路径（不回显任何值）
const subtree = [];
let inSub = false;
let baseIndent = -1;
for (const line of lines) {
  if (line.trim() === '' || line.trim().startsWith('#')) continue;
  const m = /^(\s*)([^\s#][^:]*?)\s*:\s?(.*)$/.exec(line);
  if (!m) continue;
  const indent = m[1].length;
  const key = m[2].trim().replace(/^["']|["']$/g, '');
  if (!inSub) {
    if (indent === 0 && key === 'custom_provider') continue;
    if (indent === 2 && key === 'zcc-companion') { inSub = true; baseIndent = indent; }
    continue;
  }
  if (indent <= baseIndent) break;
  subtree.push({ indent, key, hasValue: m[3].trim() !== '' });
}

// 2) 模型 id / 展示名：按 zcc-companion 子树内实际出现的 key 名逐个精确取值
function valueAt(relPath) {
  const v = readYamlScalarAtPath(text, [...BASE, ...relPath]);
  return typeof v === 'string' ? v : null;
}

const models = [];
const effort = [];
const seen = new Set();
for (const node of subtree) {
  // 命中形如 models.<something>.<field> 的叶子
  const shape = /^(models|model_list|modelList)$/i;
  void shape;
}
// 直接按常见真实形状逐一探测（不猜、不展开，只取存在者）
const modelIdCandidates = [];
for (const node of subtree) {
  if (/^models$/i.test(node.key)) {
    // 记录 models 节点下的下一层 key 名（非值）
    const idx = subtree.indexOf(node);
    for (let i = idx + 1; i < subtree.length; i += 1) {
      if (subtree[i].indent <= node.indent) break;
      if (subtree[i].indent === node.indent + 2 && !seen.has(subtree[i].key)) {
        seen.add(subtree[i].key);
        modelIdCandidates.push(subtree[i].key);
      }
    }
  }
}

for (const id of modelIdCandidates) {
  const display = valueAt(['models', id, 'name']) ?? valueAt(['models', id, 'displayName']) ?? valueAt(['models', id, 'display_name']);
  models.push({ id, displayName: display });
  const effortCount = (() => {
    // 数组形状：thinking.effortOptions.0..n
    let n = 0;
    for (let k = 0; k < 12; k += 1) {
      if (valueAt(['models', id, 'thinking', 'effortOptions', String(k)]) !== null) n += 1;
    }
    if (n > 0) return n;
    // 标量形状：thinking.effortOptions 直接是逗号分隔
    const scalar = valueAt(['models', id, 'thinking', 'effortOptions']);
    if (scalar !== null) return { rawScalarLength: scalar.length };
    return 'UNKNOWN_NOT_FOUND';
  })();
  effort.push({ id, effortOptions: effortCount });
}

// 3) provider 级（不在 models 下）的非敏感字段
const topFields = ['enabled', 'api', 'baseURL', 'type', 'name'];
const providerLevel = {};
for (const f of topFields) providerLevel[f] = valueAt([f]);
// options 层
const optionsLevel = {};
for (const f of ['enabled', 'api', 'baseURL', 'base_url']) optionsLevel[f] = valueAt(['options', f]);

// 4) 关键：zcc-companion 子树里是否存在 secret 叶子，只报存在性
const secretLeavesPresent = subtree
  .filter((n) => SECRET_LEAF.test(n.key))
  .map((n) => n.key);

/**
 * key 叶子 raw 标量结构安全性（只输出 bool，不输出值）。
 * settings.cjs 的 scalarOf 对引号只取「第一个同类引号到下一个同类引号」，
 * 因此带转义或引号内嵌引号的值会被截断——必须先证明该叶子落在安全子集，
 * v2 的两端口 GET 结论才成立。
 */
function keyLeafStructure() {
  // 只在 custom_provider -> zcc-companion 子树内定位 apiKey 叶子，避免命中别家 provider
  let inSub = false;
  let baseIndent = -1;
  for (const line of lines) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const m = /^(\s*)([^\s#][^:]*?)\s*:\s?(.*)$/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    const key = m[2].trim().replace(/^["']|["']$/g, '');
    if (!inSub) {
      if (indent === 2 && key === 'zcc-companion') { inSub = true; baseIndent = indent; }
      continue;
    }
    if (indent <= baseIndent) return { located: false, note: 'zcc-companion 子树内未找到 apiKey 叶子' };
    if (key === 'apiKey') return analyzeLeaf(m[3]);
  }
  return { located: false, note: 'zcc-companion 子树提前结束，未找到 apiKey 叶子' };
}

function analyzeLeaf(rest) {
  const v = rest.trim();
  const quoted = v.startsWith('"') || v.startsWith("'");
  const hasBackslash = v.includes('\\');
  const end = quoted ? v.indexOf(v[0], 1) : -1;
  const inner = quoted && end > 0 ? v.slice(1, end) : v;
  // scalarOf 对引号只取「第一个同类引号到下一个同类引号」：
  // 只有单层、无转义、无空白的简单 token 才保证无截断。
  const safePlain = !quoted && /^[A-Za-z0-9._-]+$/.test(v);
  const safeSimpleQuoted = quoted && !hasBackslash && end > 0
    && [...inner].every((c) => /[A-Za-z0-9._-]/.test(c));
  return {
    located: true,
    quoted,
    hasBackslash,
    quoteClosed: quoted ? end > 0 : null,
    matchesSimpleTokenCharset: safePlain || safeSimpleQuoted,
    parseIsLosslessForThisLeaf: safePlain || safeSimpleQuoted,
    note: '仅 bool；值未输出、未哈希',
  };
}

const out = {
  schema: 'zcc-auth-models/3',
  task: 'ZCC-AUTH-20261008',
  subtreeLeafCount: subtree.length,
  subtreeTopLevelKeys: subtree.filter((n) => n.indent === baseIndent + 2).map((n) => n.key),
  providerLevelFound: providerLevel,
  optionsLevelFound: optionsLevel,
  models: models,
  effortOptions: effort,
  secretLeafNamesPresent: secretLeavesPresent,
  keyLeafStructure: keyLeafStructure(),
  secretValuesEmitted: false,
  otherProvidersRead: false,
};
console.log(JSON.stringify(out, null, 2));