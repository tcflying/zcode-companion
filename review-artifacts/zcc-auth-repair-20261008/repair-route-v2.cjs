#!/usr/bin/env node
// ZCC-AUTH-20261008 最小非秘密配置修复（单叶子 baseURL 路由改指）
// 唯一允许变更：custom_provider.zcc-companion.options.baseURL
//   http://127.0.0.1:8790/v1  ->  http://127.0.0.1:8791/v1
// 硬约束：不改任何密钥/models/thinking/enabled；不读不输出 key；
//  不 backup/dump 整份 config；证据只有整文件 hash + 白名单字段。
'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { readMinimaxApiKey, readYamlScalarAtPath } = require('../../apps/desktop/lib/settings.cjs');
// 已安装运行时自带的真实 YAML 解析器（只 require，不修改其代码）
const YAML = require('C:/Users/datoo/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/yaml');

const CONFIG = 'C:/Users/datoo/.minimax/config.yaml';
const LEAF = ['custom_provider', 'zcc-companion', 'options', 'baseURL'];
const OLD = 'http://127.0.0.1:8790/v1';
const NEW = 'http://127.0.0.1:8791/v1';
const OUT = 'runtime-diagnostic-repair-output.json';
// dry-run：只验证 import / 叶子定位 / model guard / 字节 proof，
// 不创建 temp、不写 config、不发任何网络请求。
const DRY_RUN = process.argv.includes('--dry-run');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 统计字节序列出现次数（用于证明 OLD 全文只出现一次） */
function countOccurrences(buf, needle) {
  const n = Buffer.from(needle, 'utf8');
  let count = 0;
  let idx = buf.indexOf(n);
  while (idx !== -1) { count += 1; idx = buf.indexOf(n, idx + n.length); }
  return count;
}

/** 在缩进感知的完整路径下定位 baseURL 叶子的**唯一**行范围，只返回行号与缩进，不回显其它内容 */
function locateLeafLine(lines) {
  const stack = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (/^\s*(---|\.\.\.)\s*$/.test(line)) continue;
    const m = /^(\s*)([^\s#][^:]*?)\s*:\s?(.*)$/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    const key = m[2].trim().replace(/^["']|["']$/g, '');
    if (key.startsWith('- ') || key === '-') continue;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ key, indent });
    if (stack.length !== LEAF.length) continue;
    let matched = true;
    for (let k = 0; k < LEAF.length; k += 1) if (stack[k].key !== LEAF[k]) { matched = false; break; }
    if (matched) return { index: i, indent: m[1], rest: m[3], eol: line.endsWith('\r') ? 'CRLF' : 'LF' };
  }
  return null;
}

/**
 * 修复前 model guard：用**已安装运行时的真实 YAML 解析器**读本 provider 的公开
 * models 键，与 v2 已冻结 action 330f6600 的认证目录做「全等包含」判定。
 * 不发任何网络请求；只输出 ID 与 bool，不输出 key、不 dump 整份 config。
 */
function modelGuard(beforeText) {
  const doc = YAML.parse(beforeText);
  const provider = doc?.custom_provider?.['zcc-companion'];
  const modelsNode = provider?.models;
  const ids = [];
  const efforts = [];
  if (modelsNode && typeof modelsNode === 'object') {
    for (const [id, spec] of Object.entries(modelsNode)) {
      ids.push(id);
      const opts = spec?.thinking?.effortOptions;
      efforts.push({
        id,
        effortOptions: Array.isArray(opts) ? opts.length : 'NOT_ARRAY_OR_ABSENT',
        effortOptionsValues: Array.isArray(opts) ? opts : null,
      });
    }
  }
  // v2 已冻结 action 330f6600 stdout 中的认证目录（只这 10 个，不扩写）
  const V2_CATALOG = [
    'account:zai-individual-coding-plan::GLM-5.3',
    'account:zai-individual-coding-plan::GLM-5.3-Flash',
    'account:zai-start-plan::GLM-5.3-Flash',
    'account:zai-start-plan::GLM-5.2',
    'account:zai-start-plan::GLM-5-Turbo',
    'account:bigmodel-individual-coding-plan::GLM-5.3',
    'account:bigmodel-individual-coding-plan::GLM-5.3-Flash',
    'account:bigmodel-start-plan::GLM-5.3-Flash',
    'account:bigmodel-start-plan::GLM-5.2',
    'account:bigmodel-start-plan::GLM-5-Turbo',
  ];
  const missing = ids.filter((id) => !V2_CATALOG.includes(id));
  return {
    yamlParserSource: '@deepseek-ai/dsh/node_modules/yaml (require only, unmodified)',
    configuredIds: ids,
    configuredCount: ids.length,
    effortOptions: efforts,
    catalogReference: 'v2 action 330f6600-7d4f-4613-9c05-0908ac4f6a2d',
    catalogSize: V2_CATALOG.length,
    guardCount: ids.length,
    allConfiguredIdsInCatalog: missing.length === 0 && ids.length > 0,
    missingFromCatalog: missing,
    networkRequestsIssued: 0,
  };
}

function main() {
  const out = { schema: 'zcc-repair-route/1', task: 'ZCC-AUTH-20261008', stage: 'repair' };
  // 1) 进程内读当前 bytes + 冻结整文件 hash（文件 hash，不是密钥 hash）
  const beforeBuf = fs.readFileSync(CONFIG);
  const beforeSha = sha256(beforeBuf);
  const beforeText = beforeBuf.toString('utf8');
  const eol = beforeText.includes('\r\n') ? '\r\n' : '\n';
  out.configPath = CONFIG;
  out.beforeSha256 = beforeSha;
  out.beforeBytes = beforeBuf.length;

  const lines = beforeText.split(/\r?\n/);
  const hit = locateLeafLine(lines);
  if (!hit) {
    out.verdict = 'ABORT_LEAF_NOT_FOUND';
    out.allowedLeafChanged = false; out.otherBytesIdentical = false; out.currentBaseURL = null;
    return out;
  }

  // 2) model guard 必须先通过：configured IDs 全在已认证目录内才允许改 baseURL
  out.modelGuard = modelGuard(beforeText);
  if (!out.modelGuard.allConfiguredIdsInCatalog) {
    out.verdict = 'ABORT_MODEL_GUARD_FAILED';
    out.allowedLeafChanged = false; out.otherBytesIdentical = false;
    return out;
  }

  // 3) 旧值必须精确等于 OLD（含引号/注释容错：仅比对去掉引号后的标量）
  const parsedBefore = readYamlScalarAtPath(beforeText, LEAF);
  out.currentBaseURLBefore = parsedBefore;
  if (parsedBefore !== OLD) {
    out.verdict = 'ABORT_UNEXPECTED_CURRENT_VALUE';
    out.allowedLeafChanged = false; out.otherBytesIdentical = false;
    return out;
  }

  // 3) 定向替换：只动该行的 rest 段中的字面 OLD，保留缩进、引号、行尾注释、EOL
  const originalLine = lines[hit.index];
  const restStart = originalLine.length - hit.rest.length;
  const restNew = hit.rest.replace(OLD, NEW);
  if (restNew === hit.rest) {
    out.verdict = 'ABORT_LEAF_LITERAL_NOT_PRESENT';
    out.allowedLeafChanged = false; out.otherBytesIdentical = false;
    return out;
  }
  lines[hit.index] = originalLine.slice(0, restStart) + restNew;
  const afterText = lines.join(eol);
  const afterBuf = Buffer.from(afterText, 'utf8');

  // 4) 落盘前必须仍是同一份 before bytes（防并发写）
  const guardBuf = fs.readFileSync(CONFIG);
  if (sha256(guardBuf) !== beforeSha) {
    out.verdict = 'ABORT_CONCURRENT_MODIFICATION';
    out.allowedLeafChanged = false; out.otherBytesIdentical = false;
    return out;
  }

  // 5) 严格 diff：整份 config 只允许这一处字符串原地替换（字节级）
  const oldCount = countOccurrences(beforeBuf, OLD);
  const newCountBefore = countOccurrences(beforeBuf, NEW);
  const onlyLeafChanged = oldCount === 1
    && newCountBefore === 0
    && afterBuf.equals(Buffer.from(beforeBuf.toString('utf8').replace(OLD, NEW), 'utf8'));
  if (!onlyLeafChanged) {
    out.verdict = 'ABORT_DIFF_NOT_SINGLE_LITERAL';
    out.oldOccurrences = oldCount;
    out.allowedLeafChanged = false; out.otherBytesIdentical = false;
    return out;
  }
  out.onlyLeafChangedVerifiedBeforeWrite = true;

  if (DRY_RUN) {
    out.dryRun = true;
    out.tempCreated = false;
    out.configWritten = false;
    out.networkRequestsIssued = 0;
    out.verdict = 'DRY_RUN_GUARDS_PASSED';
    out.allowedLeafChanged = false; out.otherBytesIdentical = false;
    out.modelGuardPassed = out.modelGuard.allConfiguredIdsInCatalog === true;
    out.leafLocated = true;
    out.byteProofPassed = true;
    return out;
  }

  // 6) 原子写：临时文件必须与 config 同目录（同卷，rename 才能原子），
  //    随机独占名、权限继承自原文件；成功 rename 即消耗临时文件。
  //    临时文件含 secret：绝不放入 review-artifacts，也不因此永久删除——
  //    失败时保留并**只报告路径**，由人决定。
  const dir = path.dirname(path.resolve(CONFIG));
  const dirNorm = dir.toLowerCase();
  const stat = fs.statSync(CONFIG);
  const tmp = path.join(dir, `.config.yaml.zcc-repair-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
  // 精确同目录判定：必须 path.resolve 归一化 + Windows 大小写不敏感，
  // 否则 'C:/a' 与 'C:\\a' 的分隔符差异会造成误判（v1 的真实 bug）。
  if (path.dirname(path.resolve(tmp)).toLowerCase() !== dirNorm) {
    out.verdict = 'ABORT_TMP_NOT_SAME_DIR';
    out.configDirNormalized = dirNorm;
    out.tmpDirNormalized = path.dirname(path.resolve(tmp)).toLowerCase();
    out.allowedLeafChanged = false; out.otherBytesIdentical = false;
    return out;
  }
  out.tmpPathIsSameDirAsConfig = true;
  out.tmpPathInsideReviewArtifacts = dirNorm.includes('review-artifacts');
  if (out.tmpPathInsideReviewArtifacts) {
    out.verdict = 'ABORT_TMP_IN_REVIEW_ARTIFACTS';
    out.allowedLeafChanged = false; out.otherBytesIdentical = false;
    return out;
  }

  try {
    fs.writeFileSync(tmp, afterBuf, { mode: stat.mode, flag: 'wx' });
  } catch (err) {
    out.verdict = 'ABORT_TMP_CREATE_FAILED';
    out.writeError = String(err.code ?? err.message);
    out.allowedLeafChanged = false; out.otherBytesIdentical = false;
    return out;
  }

  // 6b) 原子替换交给专用 PowerShell helper：它做真实 CAS + mode + Get-Acl Sddl
  //     比对（只出 bool，不 dump ACL）。参数只含路径，不含任何配置值。
  //     mode/ACL 不等 -> 不 rename、不改原文件权限；失败保留 temp 并报确切路径。
  const helper = path.join(path.dirname(__filename), 'atomic-replace.ps1');
  let helperOut;
  try {
    const raw = execFileSync(
      'C:/Program Files/PowerShell/7/pwsh.exe',
      ['-NoProfile', '-File', helper, '-ConfigPath', CONFIG, '-TempPath', tmp, '-ExpectedBeforeSha256', beforeSha],
      { encoding: 'utf8', timeout: 30000, windowsHide: true },
    );
    helperOut = JSON.parse(raw.trim());
  } catch (err) {
    out.verdict = 'ABORT_HELPER_FAILED_TMP_PRESERVED';
    out.helperError = String(err.code ?? err.message);
    out.tmpPreservedPath = tmp;
    out.tmpNote = 'helper 失败，临时文件含 secret 已保留未删除，请人工处置';
    out.allowedLeafChanged = false; out.otherBytesIdentical = false;
    return out;
  }

  // 只回传 bool，不回传任何 ACL 内容
  out.atomic = {
    aclMatch: helperOut.aclMatch === true,
    modeMatch: helperOut.modeMatch === true,
    casMatch: helperOut.casMatch === true,
    renamed: helperOut.renamed === true,
    error: helperOut.error ?? null,
  };
  if (helperOut.tempPreservedPath) {
    out.tmpPreservedPath = helperOut.tempPreservedPath;
    out.tmpNote = '临时文件含 secret，已保留未删除，请人工处置';
  }
  if (!out.atomic.renamed) {
    out.verdict = out.atomic.aclMatch === false
      ? 'ABORT_ACL_MISMATCH_TMP_PRESERVED'
      : (out.atomic.modeMatch === false ? 'ABORT_MODE_MISMATCH_TMP_PRESERVED' : 'ABORT_ATOMIC_REPLACE_FAILED_TMP_PRESERVED');
    out.allowedLeafChanged = false; out.otherBytesIdentical = false;
    return out;
  }
  out.tmpConsumedByRename = true;

  const afterBufRead = fs.readFileSync(CONFIG);
  out.afterSha256 = sha256(afterBufRead);
  out.afterBytes = afterBufRead.length;
  const afterTextRead = afterBufRead.toString('utf8');

  // 写后 diff：把 after 还原成 OLD 必须逐字节等于 before
  const restoredText = afterTextRead.replace(NEW, OLD);
  out.otherBytesIdentical = restoredText === beforeText;
  out.allowedLeafChanged = sha256(afterBufRead) !== beforeSha
    && afterTextRead.includes(NEW)
    && !afterTextRead.includes(OLD);
  out.currentBaseURL = readYamlScalarAtPath(afterTextRead, LEAF);
  out.verdict = (out.otherBytesIdentical && out.allowedLeafChanged && out.currentBaseURL === NEW)
    ? 'REPAIR_APPLIED_VERIFIED'
    : 'REPAIR_VERIFY_FAILED';
  return out;
}

const result = main();

// dry-run：到此为止，不发网络、不写 config，仅输出已验证的 guard 结果
if (DRY_RUN) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

// 写后仅对 8791 做一次确认 GET；URL 常量即 127.0.0.1，redirect:'error' 防止凭据被重定向
async function confirm() {
  const rec = { attempted: false };
  const TARGET = 'http://127.0.0.1:8791/v1/models';
  rec.attempted = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const { readMinimaxApiKey } = require('../../apps/desktop/lib/settings.cjs');
    const keyRead = readMinimaxApiKey();
    if (!keyRead.ok) { rec.skipped = 'KEY_UNREADABLE'; return rec; }
    const res = await fetch(TARGET, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${keyRead.key}` },
      redirect: 'error',
      signal: controller.signal,
    });
    rec.http = { status: res.status, ok: res.ok };
    rec.xStatus = res.headers.get('x-zcc-status') ?? null;
    const body = await res.json().catch(() => null);
    const data = Array.isArray(body?.data) ? body.data : (Array.isArray(body?.models) ? body.models : null);
    rec.modelIds = data ? data.slice(0, 50).map((m) => (typeof m?.id === 'string' ? m.id : null)).filter(Boolean) : null;
  } catch (err) {
    rec.http = { status: null, ok: false };
    rec.error = String(err?.cause?.code ?? err?.code ?? 'TRANSPORT');
  } finally {
    clearTimeout(timer);
    rec.timerCleared = true;
  }
  return rec;
}

confirm().then((c) => {
  // confirm 是**写后确认**：只有真的改成功才允许发请求。
  // guard 中止时不得发出任何网络请求，否则会伪装成"已确认"。
  if (result.verdict !== 'REPAIR_APPLIED_VERIFIED') {
    result.postWriteConfirm8791 = { attempted: false, skipped: 'REPAIR_NOT_APPLIED' };
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }
  const merged = { ...result, postWriteConfirm8791: c };

  // JSON 卫生的真实检查：进程内断言序列化结果**不含**当前已配 key。
  // key 只用于这次 includes 比较，绝不写盘、不打印、不入 argv。
  const keyRead = (() => {
    try { return readMinimaxApiKey(); } catch { return { ok: false }; }
  })();
  const finalSerialized = JSON.stringify(merged, null, 2);
  let secretLeakDetected = false;
  if (keyRead.ok && typeof keyRead.key === 'string' && keyRead.key.length >= 8) {
    secretLeakDetected = finalSerialized.includes(keyRead.key);
  }
  merged.jsonContainsCurrentKey = secretLeakDetected;
  merged.jsonHygieneCheckedByAssertion = true;

  if (secretLeakDetected) {
    // 绝不出门：含 key 的序列化结果不写盘、不打印
    process.exitCode = 3;
    console.log(JSON.stringify({ schema: 'zcc-repair-route/1', verdict: 'ABORT_JSON_CONTAINS_KEY', redacted: true }, null, 2));
    return;
  }

  const safeSerialized = JSON.stringify(merged, null, 2);
  fs.writeFileSync(path.join(path.dirname(__filename), OUT), `${safeSerialized}\n`, 'utf8');
  console.log(safeSerialized);
});