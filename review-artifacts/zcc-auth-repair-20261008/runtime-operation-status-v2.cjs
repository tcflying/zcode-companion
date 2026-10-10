#!/usr/bin/env node
// ZCC-AUTH-20261008 operations metadata 只读诊断 v2（单 stage）
//
// 更正 v1 的查错文件名：v1 查的是桌面侧 journal.json；
// API child 用的是 api-operations-journal.json（packages/api/src/journal-store.ts:160 API_JOURNAL_FILE_NAME）。
// 同目录、不同名、两个独立进程各自的原子覆盖写。**不能因 journal.json 缺失推断 API journal 未落盘。**
//
// 范围硬约束：
//   - 只读 C:/Users/datoo/AppData/Roaming/ZCodeCompanion/api-operations-journal.json 这一个已确认路径，
//     不探索其他 userData 候选、不扫 home
//   - 只输出 metadata：operationId / state / outcome / at
//     **不输出** bodyHash / sessionKey / prompt / key，也不 dump 整个库
//   - 不发任何模型请求、不重试、不启停服务
//   - state=unknown 不等于底层已终止；wrapper 结束与 child 活动另行标注，绝不当作 active 0 即安全
'use strict';

const fs = require('node:fs');

const JOURNAL = 'C:/Users/datoo/AppData/Roaming/ZCodeCompanion/api-operations-journal.json';
// root 官方 provider test 窗口；放宽到 21:39:30 以覆盖三档全部起止
const WINDOW_START_UTC = '2026-10-07T21:38:21.216956Z';
const WINDOW_END_UTC = '2026-10-07T21:39:30.000000Z';

function main() {
  const out = {
    schema: 'zcc-operation-status/2',
    task: 'ZCC-AUTH-20261008',
    stage: 'api-journal-metadata-readonly',
    startedUtc: new Date().toISOString(),
    journalPath: JOURNAL,
    journalExists: false,
    journalBytes: null,
    journalLastWriteUtc: null,
    journalSha256: null,
    shape: null,
    totalEntries: null,
    window: { startUtc: WINDOW_START_UTC, endUtc: WINDOW_END_UTC },
    entriesInWindow: [],
    terminalInWindow: [],
    inFlightInWindow: [],
    currentInFlightCount: null,
    inFlightIsLowerBoundOnly: true,
    terminalMeansUnderlyingFinished: null,
    activeCountIsZeroProven: null,
    canaryRecommended: false,
    canaryReason: null,
    verdict: null,
  };

  if (!fs.existsSync(JOURNAL)) {
    out.verdict = 'API_JOURNAL_FILE_ABSENT';
    out.canaryReason = 'API journal 文件在磁盘上不存在；operations 终态无从读取，不做任何推断';
    out.finishedUtc = new Date().toISOString();
    return out;
  }
  out.journalExists = true;
  const st = fs.statSync(JOURNAL);
  out.journalBytes = st.size;
  out.journalLastWriteUtc = st.mtime.toISOString();

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(JOURNAL, 'utf8'));
  } catch (err) {
    out.verdict = 'API_JOURNAL_UNREADABLE';
    out.parseError = String(err.code ?? err.message);
    out.finishedUtc = new Date().toISOString();
    return out;
  }

  const entries = Array.isArray(doc) ? doc : (doc && Array.isArray(doc.entries) ? doc.entries : null);
  if (entries === null) {
    out.shape = Array.isArray(doc) ? 'top-level-array' : `keys:${Object.keys(doc ?? {}).join(',')}`;
    out.verdict = 'API_JOURNAL_UNEXPECTED_SHAPE';
    out.finishedUtc = new Date().toISOString();
    return out;
  }
  out.shape = Array.isArray(doc) ? 'top-level-array' : '{entries:[...]}';
  out.totalEntries = entries.length;

  const t0 = Date.parse(WINDOW_START_UTC);
  const t1 = Date.parse(WINDOW_END_UTC);
  let inFlight = 0;

  for (const e of entries) {
    if (e === null || typeof e !== 'object') continue;
    const state = typeof e.state === 'string' ? e.state : 'UNKNOWN_SHAPE';
    const at = typeof e.at === 'number' ? e.at : null;
    // 白名单 metadata：不含 bodyHash / sessionKey / prompt / key
    const meta = {
      operationId: typeof e.operationId === 'string' ? e.operationId : null,
      state,
      outcome: typeof e.outcome === 'string' ? e.outcome : null,
      atIso: at === null ? null : new Date(at).toISOString(),
    };
    if (state === 'in_flight') inFlight += 1;
    if (at !== null && at >= t0 && at <= t1) out.entriesInWindow.push(meta);
  }

  out.currentInFlightCount = inFlight;
  out.inFlightInWindow = out.entriesInWindow.filter((e) => e.state === 'in_flight');
  out.terminalInWindow = out.entriesInWindow.filter((e) => e.state !== 'in_flight');
  out.terminalCountInWindow = out.terminalInWindow.length;

  // unknown 是"结果不可知"，不是"底层已结束"；不能据此宣称 active 0 安全
  const hasUnknown = out.terminalInWindow.some((e) => e.state === 'unknown');
  out.hasUnknownRecords = hasUnknown;
  out.terminalMeansUnderlyingFinished = hasUnknown ? false : null;
  out.activeCountIsZeroProven = inFlight === 0 && out.terminalCountInWindow >= 3;

  if (out.terminalCountInWindow >= 3 && inFlight === 0 && !hasUnknown) {
    out.canaryRecommended = true;
    out.canaryReason = '窗口内三项终态齐全、无 in_flight、无 unknown';
  } else {
    out.canaryRecommended = false;
    out.canaryReason = [
      `terminalInWindow=${out.terminalCountInWindow}（需>=3）`,
      `inFlight=${inFlight}`,
      `hasUnknown=${hasUnknown}`,
    ].join('; ');
  }
  out.verdict = out.canaryRecommended ? 'TERMINAL_THREE_AND_NO_ACTIVE' : 'INSUFFICIENT_TERMINAL_EVIDENCE';
  out.finishedUtc = new Date().toISOString();
  return out;
}

console.log(JSON.stringify(main(), null, 2));