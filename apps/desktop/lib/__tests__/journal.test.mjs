/**
 * journal 验收：容量不足拒新发 / 不丢 unknown / 重开保留 / 取消·重复·写失败。
 *
 * 数据一律写**私有临时目录**（`fs.mkdtempSync(os.tmpdir())`），跑完清理，
 * 绝不触碰真实 `userData`、不启动宿主、不发网络、不用真实凭据。
 *
 * 运行：`node --test apps/desktop/lib/__tests__/journal.test.mjs`
 */

'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require2 = createRequire(import.meta.url);
const {
  createJournal,
  journalFilePath,
  loadJournal,
  validateEntry,
  evictable,
  JOURNAL_STATE_UNKNOWN
} = require2('../journal.cjs');

/** 每个用例一份私有临时目录。 */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zcc-journal-test-'));
}

function done(id, at) {
  return { operationId: id, state: 'done', at };
}

function unknown(id, at, outcome = 'driver_threw_midway') {
  return { operationId: id, state: JOURNAL_STATE_UNKNOWN, outcome, at };
}

test('J1 容量不足时明确拒绝新发：不丢旧条目、不假装写入成功', () => {
  const dir = tempDir();
  try {
    // 容量 3：先填 3 条可淘汰的 done
    const j = createJournal({ dir, maxEntries: 3 });
    j.load();
    assert.equal(j.append(done('op1', 1)).ok, true);
    assert.equal(j.append(done('op2', 2)).ok, true);
    assert.equal(j.append(done('op3', 3)).ok, true);
    assert.equal(j.size(), 3);

    // 现在有 3 条 done，追加第 4 条：应该淘汰最旧的 op1 并成功
    const r4 = j.append(done('op4', 4));
    assert.equal(r4.ok, true, '有可淘汰条目时应写入成功');
    assert.equal(r4.evicted, 1, '应恰好淘汰 1 条');
    assert.deepEqual(j.list().map((e) => e.operationId), ['op4', 'op3', 'op2']);

    // 关键：拒新发的情形——把所有剩余条目变成不可淘汰
    const j2 = createJournal({ dir: path.join(dir, 'full'), maxEntries: 2 });
    j2.load();
    j2.append(unknown('u1', 1));
    j2.append({ operationId: 'f1', state: 'in_flight', at: 2 });
    assert.equal(j2.size(), 2, '两条都不可淘汰，已满');

    const rejected = j2.append(done('new1', 3));
    assert.equal(rejected.ok, false, '无可淘汰对象时必须拒绝新发');
    assert.equal(rejected.reason, 'journal_capacity_exceeded', '拒绝原因必须明确');
    assert.equal(rejected.entry, null, '被拒时不得返回条目');
    assert.equal(j2.size(), 2, '被拒后条目数不变——没有丢旧条目');

    // 被拒的条目不得落盘（重开也看不到）
    const j3 = createJournal({ dir: path.join(dir, 'full'), maxEntries: 2 });
    const loaded = j3.load();
    assert.deepEqual(
      loaded.entries.map((e) => e.operationId),
      ['f1', 'u1'],
      '重开后应只有两条原始记录，被拒的新发不在其中'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('J2 unknown 记录永不淘汰：容量压力下逐字保留', () => {
  const dir = tempDir();
  try {
    const j = createJournal({ dir, maxEntries: 3 });
    j.load();
    j.append(unknown('u1', 1, 'upstream_timeout_after_send'));
    j.append(done('d1', 2));
    j.append(done('d2', 3));
    j.append(done('d3', 4)); // 触发淘汰，最旧的 u1 是 unknown → 不可淘汰
    const r = j.append(done('d4', 5));

    // d1 是最旧的可淘汰条目，先被淘汰；再压一轮直到只剩 unknown + in_flight
    for (let i = 6; i <= 12; i += 1) j.append(done(`bulk${i}`, i));

    const list = j.list();
    const u = list.find((e) => e.operationId === 'u1');
    assert.ok(u, 'unknown 记录必须仍在');
    assert.equal(u.state, JOURNAL_STATE_UNKNOWN, '状态必须仍是 unknown');
    assert.equal(u.outcome, 'upstream_timeout_after_send', 'outcome 必须逐字保留');
    assert.equal(u.at, 1, 'at 必须逐字保留');
    assert.equal(evictable(u), false, 'unknown 明确不可淘汰');
    assert.equal(r.ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('J3 进程重开后仍在：unknown 与全部记录从磁盘读回', () => {
  const dir = tempDir();
  try {
    const j1 = createJournal({ dir, maxEntries: 8 });
    j1.load();
    j1.append(unknown('u1', 1, 'outcome_unknown_at_upstream'));
    j1.append(done('d1', 2));
    j1.append({ operationId: 'f1', state: 'failed', at: 3 });

    // 新实例 = 模拟进程重开
    const j2 = createJournal({ dir, maxEntries: 8 });
    const { entries, problems } = j2.load();
    assert.deepEqual(problems, [], '正常文件不应报问题');
    assert.equal(entries.length, 3, '重开后应读回 3 条');
    const u = entries.find((e) => e.operationId === 'u1');
    assert.ok(u, '重开后 unknown 仍在');
    assert.equal(u.outcome, 'outcome_unknown_at_upstream');
    assert.equal(u.state, JOURNAL_STATE_UNKNOWN);
    assert.ok(entries.some((e) => e.operationId === 'd1'));
    assert.ok(entries.some((e) => e.operationId === 'f1'));

    // 落盘位置就是 dataDir/journal.json
    assert.ok(fs.existsSync(journalFilePath(dir)), 'journal.json 应已落盘');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('J4 边界语义：取消不改写 unknown、重复键幂等、写失败不假装成功', () => {
  const dir = tempDir();
  try {
    // 4a 取消不改写已有 unknown
    const j = createJournal({ dir, maxEntries: 8 });
    j.load();
    j.append(unknown('op1', 1, 'already_unknown'));
    j.cancel('op1', 'user_hit_stop');
    const u = j.list().find((e) => e.operationId === 'op1');
    assert.equal(u.state, JOURNAL_STATE_UNKNOWN, '取消不得把 unknown 洗成 failed');
    assert.equal(u.outcome, 'already_unknown', 'outcome 不得被覆盖');
    assert.ok(j.list().some((e) => e.operationId === 'op1#cancel'), '取消应另记一条事实');

    // 4b 重复键幂等（独立子目录，避免与 4a 的记录混在一起）
    const j2 = createJournal({ dir: path.join(dir, 'dup'), maxEntries: 8 });
    j2.load();
    const a = j2.append(done('same', 1));
    const b = j2.append(done('same', 2));
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, true, '重复 operationId 应被识别');
    assert.equal(j2.size(), 1, '重复键不产生第二条');
    assert.equal(b.entry.at, 1, '重复时返回既有条目，不被后到者覆盖');

    // 4c 写失败：如实返回失败，内存态不变，不假装成功（独立子目录）
    const failDir = path.join(dir, 'failwrite');
    const j3 = createJournal({ dir: failDir, maxEntries: 8, failWrites: true });
    j3.load();
    const w = j3.append(done('w1', 1));
    assert.equal(w.ok, false, '写失败必须返回失败');
    assert.match(w.reason, /journal_write_failed/, '失败原因必须明确');
    assert.equal(j3.size(), 0, '写失败不得更新内存态');
    assert.equal(fs.existsSync(journalFilePath(failDir)), false, '写失败不得留下文件');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('J5 读损坏时逐条丢弃并如实报告，不整份丢弃、不覆盖原文件', () => {
  const dir = tempDir();
  try {
    const file = journalFilePath(dir);
    fs.mkdirSync(dir, { recursive: true });
    const good = { operationId: 'good1', state: 'done', at: 1 };
    const badNoOutcome = { operationId: 'bad1', state: JOURNAL_STATE_UNKNOWN, at: 2 }; // 缺 outcome
    const badState = { operationId: 'bad2', state: 'weird_state', at: 3 };
    const good2 = { operationId: 'good2', state: JOURNAL_STATE_UNKNOWN, outcome: 'kept', at: 4 };
    fs.writeFileSync(file, JSON.stringify({ entries: [good, badNoOutcome, badState, good2] }), 'utf8');

    const { entries, problems } = loadJournal(file);
    assert.deepEqual(
      entries.map((e) => e.operationId),
      ['good1', 'good2'],
      '只丢损坏条目，保留其余（loadJournal 按文件原序返回，不重排）'
    );
    assert.equal(problems.length, 2, '两条损坏各报一次');
    assert.ok(problems.some((p) => p.includes('bad1')), 'unknown 缺 outcome 应被报');
    assert.ok(problems.some((p) => p.includes('bad2')), '非法 state 应被报');
    // 原文件不被覆盖
    assert.ok(fs.existsSync(file), '原文件必须保留');
    assert.ok(fs.readFileSync(file, 'utf8').includes('bad1'), '原文件内容未被覆盖');

    // 顶层损坏：退回空表并报告
    fs.writeFileSync(file, '{not json', 'utf8');
    const broken = loadJournal(file);
    assert.deepEqual(broken.entries, []);
    assert.ok(broken.problems.some((p) => p.includes('JOURNAL_FILE_UNREADABLE')));
    assert.equal(validateEntry({ operationId: 'x', state: 'nope' }) !== null, true, '非法 state 应被拒');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});