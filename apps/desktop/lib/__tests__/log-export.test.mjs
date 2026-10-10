/**
 * 脱敏日志导出（`apps/desktop/lib/log-export.cjs`）单测。
 *
 * 落盘目标**只在 `os.tmpdir()`**：本文件用 `fs.mkdtempSync` 现造私有目录，
 * 任何断言都只读/只写那里。绝不触碰真实用户文件、真实设置目录或真实凭据。
 * 合成 canary 全部是本文件现造的常量串。
 *
 * 运行：`node --test apps/desktop/lib/__tests__/log-export.test.mjs`
 */

'use strict';

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DEFAULT_MAX_BYTES,
  MIN_MAX_BYTES,
  HARD_MAX_BYTES,
  EXPORT_FIELD_ALLOWLIST,
  ALLOWLISTED_FIELDS,
  selectAllowlistedFields,
  planLogExport,
  buildLogExport,
  createLogExporter
} = require('../log-export.cjs');

/** 合成 canary：非凭据形状，本文件现造，不对应任何真实值。 */
const CANARY_BODY = 'RA09CANARY-7f3a91c4e2b6d05';
const CANARY_REGISTERED = 'zcc-canary-registered-4f1d9a';
const OP_ID = 'chatcmpl-68379b97-81c8-4329-9e3a-46e6cfdafbfb';
const HEX64 = 'a'.repeat(64);
const FIXED_NOW = () => Date.parse('2026-10-07T08:00:00.000Z');
const AT = Date.parse('2026-10-07T07:59:00.000Z');

function line(text, stream = 'stdout') {
  return { stream, at: AT, text };
}

/** 私有临时目录：所有落盘断言只在这里发生。 */
function privateTmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `zcc-ra09-exp-${tag}-`));
}

/* -------------------------------------------------------------------------- */
/* 白名单：字段名与取值文法                                                     */
/* -------------------------------------------------------------------------- */

test('正文 canary 所在的自由文本根本不进导出', () => {
  const built = buildLogExport({
    lines: [line(`event=completion operation=${OP_ID} status=200 用户提问：${CANARY_BODY}`)],
    secrets: [],
    now: FIXED_NOW
  });
  assert.equal(built.ok, true);
  assert.equal(built.text.includes(CANARY_BODY), false, '正文 canary 不得出现在导出文本里');
  assert.ok(built.text.includes('event=completion'), '白名单字段必须保留');
  assert.ok(built.text.includes(OP_ID));
});

test('非白名单字段被丢弃并计数', () => {
  const built = buildLogExport({
    lines: [line(`event=operation operation=${OP_ID} my_private_field=${CANARY_BODY} x-zcc-session-id=${CANARY_BODY}`)],
    secrets: [],
    now: FIXED_NOW
  });
  assert.equal(built.droppedFields, 2, '两个非白名单字段都必须被计数');
  assert.equal(built.text.includes(CANARY_BODY), false);
  assert.equal(built.text.includes('my_private_field'), false);
});

test('白名单字段的取值不合文法 ⇒ 丢弃（不是替换，替换等于把原文留在文件里）', () => {
  const built = buildLogExport({
    // key 字段文法是 zcc-fp:<12 hex>；塞 canary 进去必须被丢，而不是被洗成 [REDACTED] 留下。
    lines: [line(`event=operation key=${CANARY_BODY} status=200`)],
    secrets: [],
    now: FIXED_NOW
  });
  assert.equal(built.droppedInvalid, 1);
  assert.equal(built.text.includes(CANARY_BODY), false);
  assert.ok(built.text.includes('event=operation'));
});

test('反向对照：一行纯白名单字段必须 0 丢弃、0 脱敏', () => {
  const text = `event=operation key=zcc-fp:1a2b3c4d5e6f operation=${OP_ID} status=200 stream=false fixture=false idempotency=none`;
  const built = buildLogExport({ lines: [line(text)], secrets: [], now: FIXED_NOW });
  assert.equal(built.droppedFields, 0, '白名单字段不得被误丢');
  assert.equal(built.droppedInvalid, 0, '合法取值不得被误判');
  assert.equal(built.redactedLines, 0);
});

test('已登记机密不出现在导出里——但**承重防线是取值文法，不是机密替换**', () => {
  // 如实标注机制：`reason` 的文法不接受任何含 `zcc-canary-...` 的取值，
  // 所以即便把机密替换循环整段删掉，这条断言**照样成立**。
  // 也就是说 `redactValue` 的机密循环在导出路径上是**纵深防御、不是承重项**。
  // 把它写成"因为机密替换才不泄漏"会是**归因错误**——那种断言看着有牙，实则恒真。
  const built = buildLogExport({
    lines: [line(`event=rate_limited key=zcc-fp:1a2b3c4d5e6f reason=${CANARY_REGISTERED}`)],
    secrets: [CANARY_REGISTERED],
    now: FIXED_NOW
  });
  assert.equal(built.text.includes(CANARY_REGISTERED), false);
  assert.ok(built.droppedInvalid + built.droppedFields > 0, '真正丢弃它的是字段取值文法');
});

test('凭据形状在白名单字段里同样被洗掉', () => {
  const built = buildLogExport({
    lines: [line('event=rejected status=401 token=sk-abcdef123456')],
    secrets: [],
    now: FIXED_NOW
  });
  assert.equal(built.text.includes('sk-abcdef123456'), false);
});

test('能力边界如实记录：白名单字段里形似合法的 canary 认不出来（不假装解决）', () => {
  // reason 文法是 `^([a-z][a-z0-9_]{0,63})$`，小写短串都合法。
  // 一个**全小写**的 canary 塞在 reason 里确实过得去——这是已知边界，写成测试钉住，
  // 免得将来有人以为白名单等于万能防护。
  const lowercaseCanary = 'ra09canarylower7f3a91c4';
  const built = buildLogExport({
    lines: [line(`event=x reason=${lowercaseCanary}`)],
    secrets: [],
    now: FIXED_NOW
  });
  assert.equal(built.text.includes(lowercaseCanary), true, '这是已知能力边界，如实钉住');
});

/* -------------------------------------------------------------------------- */
/* 字节上限                                                                    */
/* -------------------------------------------------------------------------- */

test('不超上限时不截断且完整', () => {
  const built = buildLogExport({ lines: [line('event=a'), line('event=b')], now: FIXED_NOW });
  assert.equal(built.truncated, false);
  assert.equal(built.droppedLines, 0);
  assert.equal(built.includedLines, 2);
});

test('超上限时按行截断、如实标记，实际字节不超上限', () => {
  const many = Array.from({ length: 400 }, (_, i) => line(`event=filler stream=false status=200 in_flight=false ${'x'.repeat(70)}`));
  const built = buildLogExport({ lines: many, maxBytes: 4096, now: FIXED_NOW });
  assert.equal(built.truncated, true);
  assert.ok(built.droppedLines > 0);
  assert.equal(built.includedLines + built.droppedLines, built.totalLines);
  assert.ok(built.bytes <= 4096, `实际字节 ${built.bytes} 超上限`);
  assert.ok(built.text.includes('截断'));
});

test('上限夹在 [MIN, HARD]', () => {
  assert.equal(planLogExport({ maxBytes: 10 }).maxBytes, MIN_MAX_BYTES);
  assert.equal(planLogExport({ maxBytes: 10 ** 12 }).maxBytes, HARD_MAX_BYTES);
  assert.equal(planLogExport({}).maxBytes, DEFAULT_MAX_BYTES);
});

test('非法输入一律 INVALID_INPUT', () => {
  assert.equal(buildLogExport({ mode: 'nope', lines: [] }).code, 'INVALID_INPUT');
  assert.equal(buildLogExport({ maxBytes: -1 }).code, 'INVALID_INPUT');
  assert.equal(buildLogExport({ lines: 'not-an-array' }).code, 'INVALID_INPUT');
  assert.equal(buildLogExport({ lines: [42] }).code, 'INVALID_INPUT');
});

/* -------------------------------------------------------------------------- */
/* 确定性与只读                                                                */
/* -------------------------------------------------------------------------- */

test('同输入同时间 ⇒ 同 sha256；不同时间 ⇒ 不同 sha256', () => {
  const input = { lines: [line('event=a')], secrets: [] };
  const a = buildLogExport({ ...input, now: FIXED_NOW });
  const b = buildLogExport({ ...input, now: FIXED_NOW });
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.sha256, crypto.createHash('sha256').update(a.text, 'utf8').digest('hex'));
  const c = buildLogExport({ ...input, now: () => Date.parse('2026-10-07T08:00:01.000Z') });
  assert.notEqual(a.sha256, c.sha256);
});

test('导出是只读旁路：不修改传入的 lines', () => {
  const lines = [line('event=a')];
  const snapshot = JSON.stringify(lines);
  buildLogExport({ lines, secrets: [], now: FIXED_NOW });
  assert.equal(JSON.stringify(lines), snapshot);
});

/* -------------------------------------------------------------------------- */
/* 真实驱动：preview / save / cancel / repeat                                   */
/* -------------------------------------------------------------------------- */

/** 造一个导出器，`saveAs` 与 `writeFile` 都是可控桩，写入目标由测试指定在私有临时目录内。 */
function makeExporter({ dir, lines, secrets = [], saveAs, now = FIXED_NOW }) {
  const writes = [];
  const run = createLogExporter({
    getLines: () => lines,
    getSecrets: () => secrets,
    saveAs,
    writeFile: (filePath, text) => {
      writes.push(filePath);
      fs.writeFileSync(filePath, text, 'utf8');
    },
    now
  });
  return { run, writes };
}

test('preview：只读不落盘，且回吐内容里没有正文 canary', async () => {
  const dir = privateTmp('preview');
  const { run, writes } = makeExporter({
    dir,
    lines: [line(`event=completion operation=${OP_ID} 正文：${CANARY_BODY}`)],
    saveAs: async () => {
      throw new Error('preview 不该调用 saveAs');
    }
  });
  const result = await run({ mode: 'preview' });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'preview');
  assert.equal(typeof result.preview, 'string');
  assert.equal(result.preview.includes(CANARY_BODY), false);
  assert.ok(result.sha256);
  assert.deepEqual(writes, [], 'preview 不得写任何文件');
});

test('save：真实落盘到私有临时目录，文件内容不含 canary，且 hash 可复算', async () => {
  const dir = privateTmp('save');
  const target = path.join(dir, 'export.txt');
  const { run, writes } = makeExporter({
    dir,
    lines: [line(`event=completion operation=${OP_ID} 正文：${CANARY_BODY}`)],
    saveAs: async () => ({ canceled: false, filePath: target })
  });
  const result = await run({ mode: 'save' });
  assert.equal(result.ok, true);
  assert.equal(result.path, target);
  assert.deepEqual(writes, [target], '只应写一次，且只写用户选定的那一个目标');

  const onDisk = fs.readFileSync(target, 'utf8');
  assert.equal(onDisk.includes(CANARY_BODY), false, '落盘文件不得含正文 canary');
  assert.equal(
    crypto.createHash('sha256').update(onDisk, 'utf8').digest('hex'),
    result.sha256,
    ':876 要的脱敏导出 hash 必须能从落盘文件复算出来'
  );
});

test('cancel：不写任何文件，且回 CANCELLED（不是错误码也不是成功）', async () => {
  const dir = privateTmp('cancel');
  const { run, writes } = makeExporter({
    dir,
    lines: [line('event=a')],
    saveAs: async () => ({ canceled: true })
  });
  const result = await run({ mode: 'save' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CANCELLED');
  assert.deepEqual(writes, [], '取消不得留下任何写入');
  assert.deepEqual(fs.readdirSync(dir), [], '取消不得在目标目录留下任何文件');
});

test('cancel：选了路径但 filePath 为空串，同样按取消处理', async () => {
  const dir = privateTmp('cancel2');
  const { run, writes } = makeExporter({
    dir,
    lines: [line('event=a')],
    saveAs: async () => ({ canceled: false, filePath: '' })
  });
  const result = await run({ mode: 'save' });
  assert.equal(result.code, 'CANCELLED');
  assert.deepEqual(writes, []);
});

test('repeat：保存进行中时再来一次 ⇒ EXPORT_IN_PROGRESS，且不重复写盘', async () => {
  const dir = privateTmp('repeat');
  const target = path.join(dir, 'export.txt');
  let saveCalls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { run, writes } = makeExporter({
    dir,
    lines: [line('event=a')],
    saveAs: async () => {
      saveCalls += 1;
      await gate; // 把第一次保存卡在「选目标」这一步，制造真实的并发窗口
      return { canceled: false, filePath: target };
    }
  });

  const first = run({ mode: 'save' });
  const second = await run({ mode: 'save' });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'EXPORT_IN_PROGRESS', '重复动作必须被在途闸门挡住');
  assert.equal(saveCalls, 1, '第二次不得再弹一次保存对话框');

  release();
  const firstResult = await first;
  assert.equal(firstResult.ok, true);
  assert.deepEqual(writes, [target], '整个过程只写一次，不重复写盘');
  // 超时是**必需**的，不是保险：把在途闸门短接掉之后，第二次 run() 会同样卡在
  // saveAs 的 gate 上，`await second` 永远不返回 ⇒ 整轮挂死而不是变红。
  // 挂死的变异体验证等于没有验证（它既不报通过也不报失败，只是把门卡住）。
}, { timeout: 15000 });

test('写盘失败 ⇒ SAVE_FAILED（如实报错，不假装保存成功）', async () => {
  const dir = privateTmp('writefail');
  const run = createLogExporter({
    getLines: () => [line('event=a')],
    getSecrets: () => [],
    saveAs: async () => ({ canceled: false, filePath: path.join(dir, 'x.txt') }),
    writeFile: () => {
      throw new Error('disk is read-only (fixture)');
    },
    now: FIXED_NOW
  });
  const result = await run({ mode: 'save' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SAVE_FAILED');
  assert.match(result.reason, /read-only/);
});

test('写盘失败后闸门必须释放：下一次保存仍可成功（不被残留状态永久卡死）', async () => {
  const dir = privateTmp('release');
  const target = path.join(dir, 'export.txt');
  let shouldFail = true;
  const run = createLogExporter({
    getLines: () => [line('event=a')],
    getSecrets: () => [],
    saveAs: async () => ({ canceled: false, filePath: target }),
    writeFile: (filePath, text) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('transient fixture failure');
      }
      fs.writeFileSync(filePath, text, 'utf8');
    },
    now: FIXED_NOW
  });
  assert.equal((await run({ mode: 'save' })).code, 'SAVE_FAILED');
  assert.equal((await run({ mode: 'save' })).ok, true, '闸门必须已释放');
  assert.ok(fs.existsSync(target));
});

test('非法 mode 在触达 saveAs 之前就被拒', async () => {
  const dir = privateTmp('badmode');
  let saveCalls = 0;
  const { run } = makeExporter({
    dir,
    lines: [line('event=a')],
    saveAs: async () => {
      saveCalls += 1;
      return { canceled: true };
    }
  });
  const result = await run({ mode: 'upload-to-cloud' });
  assert.equal(result.code, 'INVALID_INPUT');
  assert.equal(saveCalls, 0);
});

/* -------------------------------------------------------------------------- */
/* 白名单本身                                                                  */
/* -------------------------------------------------------------------------- */

test('白名单是显式表，且不含任何自由文本字段', () => {
  assert.ok(Array.isArray(ALLOWLISTED_FIELDS));
  assert.ok(ALLOWLISTED_FIELDS.includes('event'));
  assert.ok(ALLOWLISTED_FIELDS.includes('operation'));
  for (const forbidden of ['message', 'text', 'content', 'prompt', 'body', 'raw']) {
    assert.equal(ALLOWLISTED_FIELDS.includes(forbidden), false, `白名单不得含 ${forbidden}`);
  }
});

test('selectAllowlistedFields：自由文本不产生任何字段', () => {
  const out = selectAllowlistedFields(`用户消息：${CANARY_BODY}`, []);
  assert.deepEqual(out.kept, []);
  assert.equal(out.droppedFields, 0);
  assert.equal(out.droppedInvalid, 0);
});

/* -------------------------------------------------------------------------- */
/* 原型链字段名回归（父审 08:34:17 UTC 实跑崩溃）                                 */
/* -------------------------------------------------------------------------- */

/**
 * `Object.prototype` 上的字段名。它们全部**不是** `undefined`，
 * 所以旧判定 `EXPORT_FIELD_ALLOWLIST[key] === undefined` 会把它们放行，
 * 紧接着 `grammar.test(...)` 抛 `grammar.test is not a function`。
 */
const PROTOTYPE_KEYS = [
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  '__proto__'
];

test('回归钉死：父审崩溃输入 `event=done constructor=x` 不再抛，且按「非白名单」丢弃计数', () => {
  // 真实崩溃：主线程 08:34:17 UTC 实跑正式 log-export.cjs，
  // `event=done constructor=x` ⇒ TypeError: grammar.test is not a function，
  // PID 5260，exit 1（回执 0ba6c18e）。
  const out = selectAllowlistedFields('event=done constructor=x', []);
  assert.deepEqual(out.kept, [{ key: 'event', value: 'done' }], '只有 event 该留下');
  assert.equal(out.droppedFields, 1, 'constructor 必须计入「非白名单字段」');
  assert.equal(out.droppedInvalid, 0, 'constructor 不得被算成「白名单但取值非法」');
});

test('原型链上的字段名一个都不能被当成白名单字段，且全部计入丢弃计数', () => {
  const text = `event=done ${PROTOTYPE_KEYS.map((k) => `${k}=${CANARY_BODY}`).join(' ')}`;
  const out = selectAllowlistedFields(text, []);
  assert.deepEqual(out.kept, [{ key: 'event', value: 'done' }], '只有 event 该留下');
  assert.equal(out.droppedFields, PROTOTYPE_KEYS.length, `应有 ${PROTOTYPE_KEYS.length} 个被丢弃计数`);
  assert.equal(out.droppedInvalid, 0);
  assert.equal(
    out.kept.some((f) => f.value.includes(CANARY_BODY)),
    false,
    '原型链取值不得进结果'
  );
});

test('承重性对照：旧判定对这些 key 全部放行 —— 所以 hasOwnProperty 不是恒真的装饰', () => {
  // 这条是**可分辨性**证明，不是注释。若它不成立，就无法说「旧代码崩、新代码不崩」
  // 是这次判定带来的，而不是别的原因。
  for (const key of ['constructor', 'toString', '__proto__']) {
    const legacyHit = EXPORT_FIELD_ALLOWLIST[key]; // 旧代码走的正是这条路
    assert.notEqual(legacyHit, undefined, `${key} 在原型链上取得到值 ⇒ 旧判定 === undefined 会放行`);
    assert.notEqual(legacyHit instanceof RegExp, true, `${key} 取到的不是 RegExp，调用 .test 必崩`);
    assert.equal(Object.prototype.hasOwnProperty.call(EXPORT_FIELD_ALLOWLIST, key), false, `${key} 不是自有属性`);
  }
  assert.equal(EXPORT_FIELD_ALLOWLIST.event instanceof RegExp, true, '正控：自有属性确实是 RegExp');
});

test('未知字段（既不在白名单也不在原型链上）同样计入丢弃计数', () => {
  const out = selectAllowlistedFields(`event=done totally_unknown_field=${CANARY_BODY} zzz=1`, []);
  assert.deepEqual(out.kept, [{ key: 'event', value: 'done' }]);
  assert.equal(out.droppedFields, 2);
  assert.equal(out.droppedInvalid, 0);
});

test('正控：已知合法字段 0 丢弃 0 脱敏，原样留在导出里', () => {
  const text = `event=completion operation=${OP_ID} status=200 session_key=${HEX64} state=done in_flight=false port=8791`;
  const built = buildLogExport({ lines: [line(text)], secrets: [], now: FIXED_NOW });
  assert.equal(built.ok, true);
  assert.equal(built.droppedFields, 0);
  assert.equal(built.droppedInvalid, 0);
  assert.equal(built.redactedLines, 0, '合法取值不该被脱敏规则误伤');
  for (const frag of [
    'event=completion',
    `operation=${OP_ID}`,
    'status=200',
    `session_key=${HEX64}`,
    'state=done',
    'in_flight=false',
    'port=8791'
  ]) {
    assert.ok(built.text.includes(frag), `正控字段 ${frag} 必须留在导出里`);
  }
});

test('真实驱动回归：带原型链字段名的行，preview / save / cancel 三条路径都走通', async () => {
  const dir = privateTmp('proto-driver');
  const lines = [
    line(`event=done constructor=${CANARY_BODY} toString=x __proto__=y event=completion operation=${OP_ID}`)
  ];
  const { run, writes } = makeExporter({
    dir,
    lines,
    saveAs: async () => ({ canceled: false, filePath: path.join(dir, 'export.log') })
  });

  const preview = await run({ mode: 'preview' });
  assert.equal(preview.ok, true, 'preview 不得因原型链字段而崩');
  assert.equal(preview.preview.includes(CANARY_BODY), false, 'preview 不得回吐原型链取值');
  assert.deepEqual(writes, [], 'preview 不写盘');

  const saved = await run({ mode: 'save' });
  assert.equal(saved.ok, true, 'save 不得因原型链字段而崩');
  assert.equal(writes.length, 1);
  const onDisk = fs.readFileSync(path.join(dir, 'export.log'), 'utf8');
  assert.equal(onDisk.includes(CANARY_BODY), false, '落盘文件不得含原型链取值');
  assert.ok(onDisk.includes(`operation=${OP_ID}`), '落盘文件必须保留合法字段');
  assert.equal(
    crypto.createHash('sha256').update(onDisk, 'utf8').digest('hex'),
    saved.sha256,
    '落盘内容的 hash 必须等于回执里的 sha256'
  );

  const canceled = await createLogExporter({
    getLines: () => lines,
    getSecrets: () => [],
    saveAs: async () => ({ canceled: true }),
    writeFile: () => {
      throw new Error('取消路径不得写盘');
    },
    now: FIXED_NOW
  })({ mode: 'save' });
  assert.equal(canceled.ok, false);
  assert.equal(canceled.code, 'CANCELLED', '取消必须回 CANCELLED，不是别的错误');
});