#!/usr/bin/env node
// ZCC-AUTH-20261008 有界只读诊断：operations metadata 终态回读
//
// 范围硬约束：
//   - 只读 companion **自有** journal（userData/journal.json），不读官方业务 DB、不读其他会话
//   - 目录来源由仓库源码确定（apps/desktop/main.cjs: `path.dirname(settingsFile)` = app.getPath('userData')），
//     本脚本据此**推导**而非硬编码猜测；推导结果与实际存在性分别如实报告
//   - 只输出 metadata：operationId / state / outcome / 时间戳 / inFlight 计数
//     **不输出** prompt、body、request 正文、key，也不 dump 整个库
//   - 不发任何模型请求、不重试、不启停服务、不处理残留 tmp
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// root 官方 provider test 的 UTC 窗口（本轮三档 10s timeout 即发生在此窗口）
const WINDOW_START_UTC = '2026-10-07T21:38:21.216956Z';
const WINDOW_END_UTC = '2026-10-07T21:38:55.149392Z';

const JOURNAL_STATES = ['in_flight', 'done', 'failed', 'unknown'];

function resolveUserDataCandidates() {
  // Electron userData = %APPDATA%/<appName>。appName 来自可执行名 / package productName。
  // 这里只列**由仓库源码可推导**的候选，并如实报告哪个存在，不扫全 home。
  const roaming = process.env.APPDATA;
  if (!roaming) return [];
  return [
    path.join(roaming, 'ZCodeCompanion'),
    path.join(roaming, 'zcode-companion'),
    path.join(roaming, 'Electron'),
  ];
}

function main() {
  const out = {
    schema: 'zcc-operation-status/1',
    task: 'ZCC-AUTH-20261008',
    stage: 'operations-metadata-readonly',
    startedUtc: new Date().toISOString(),
    window: { startUtc: WINDOW_START_UTC, endUtc: WINDOW_END_UTC },
    source: 'apps/desktop/main.cjs: journalDir = path.dirname(settingsFile); journalFile = journal.json',
    candidates: [],
    journalFound: false,
    journalPath: null,
    entriesInWindow: [],
    inFlightCount: null,
    terminalInWindow: [],
    verdict: null,
    notes: [],
  };

  for (const dir of resolveUserDataCandidates()) {
    const settingsPath = path.join(dir, 'settings.json');
    const journalPath = path.join(dir, 'journal.json');
    const rec = {
      dir,
      dirExists: fs.existsSync(dir),
      settingsJsonExists: fs.existsSync(settingsPath),
      journalJsonExists: fs.existsSync(journalPath),
      selected: false,
    };
    if (!out.journalFound && rec.journalJsonExists) {
      rec.selected = true;
      out.journalFound = true;
      out.journalPath = journalPath;
    }
    out.candidates.push(rec);
  }

  if (!out.journalFound) {
    // 这是**可核事实**，不是猜测：目录存在但 journal 未落盘
    const existing = out.candidates.filter((c) => c.dirExists);
    out.verdict = existing.length === 0 ? 'NO_USERDATA_DIR_FOUND' : 'JOURNAL_NOT_PERSISTED_ON_DISK';
    out.notes.push(
      existing.length === 0
        ? '未能从仓库源码推导出的任何 userData 目录位置找到 userData 根'
        : 'userData 目录存在且与 settings.json 同根，但 journal.json 不在磁盘上 —— 与 start-api.mjs 文档一致：journalDir 缺省即纯内存不落盘。',
    );
    out.finishedUtc = new Date().toISOString();
    return out;
  }

  // 只读解析；不 dump 库，只取白名单 metadata
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(out.journalPath, 'utf8'));
  } catch (err) {
    out.verdict = 'JOURNAL_UNREADABLE';
    out.error = String(err.code ?? err.message);
    out.finishedUtc = new Date().toISOString();
    return out;
  }

  const rawEntries = Array.isArray(doc) ? doc : (Array.isArray(doc.entries) ? doc.entries : []);
  out.entryCount = rawEntries.length;

  const t0 = Date.parse(WINDOW_START_UTC);
  const t1 = Date.parse(WINDOW_END_UTC);

  let inFlight = 0;
  const windowEntries = [];
  for (const e of rawEntries) {
    if (e === null || typeof e !== 'object') continue;
    const state = typeof e.state === 'string' ? e.state : 'UNKNOWN';
    if (state === 'in_flight') inFlight += 1;
    const at = typeof e.at === 'number' ? e.at : null;
    const inWindow = at !== null && at >= t0 && at <= t1;
    // 白名单：只取 metadata 字段
    const meta = {
      operationId: typeof e.operationId === 'string' ? e.operationId : null,
      state,
      outcome: typeof e.outcome === 'string' ? e.outcome : null,
      atIso: at === null ? null : new Date(at).toISOString(),
      inWindow,
    };
    if (inWindow) windowEntries.push(meta);
  }
  out.inFlightCount = inFlight;
  out.entriesInWindow = windowEntries;
  out.terminalInWindow = windowEntries.filter((e) => e.state !== 'in_flight');
  out.terminalCountInWindow = out.terminalInWindow.length;
  out.hasPromptOrBodyFields = rawEntries.some((e) => e && typeof e === 'object'
    && ('prompt' in e || 'body' in e || 'request' in e || 'messages' in e));
  out.verdict = out.terminalCountInWindow >= 3 && inFlight === 0
    ? 'TERMINAL_THREE_PRESENT_AND_NO_ACTIVE'
    : 'INSUFFICIENT_TERMINAL_EVIDENCE';
  out.finishedUtc = new Date().toISOString();
  return out;
}

const result = main();
console.log(JSON.stringify(result, null, 2));