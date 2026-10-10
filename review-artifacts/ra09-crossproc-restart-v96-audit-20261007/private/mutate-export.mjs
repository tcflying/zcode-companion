// 脱敏日志导出的变异验证：证明测试**有区分力**，不是恒绿。
//
// 方法：把 `apps/desktop/lib/log-export.cjs` **复制**到 os.tmpdir()（保持 `__tests__` 的相对层级，
// 测试里的 `require('../log-export.cjs')` 仍然指得到），在副本上做变异，跑副本里的测试。
// 正式源码目录零写入。
//
// 三重判据，缺一不可（我踩过「exit≠0 但零 FAIL 行 = 根本没跑起来」的坑，比不做变异检查更糟）：
//  1. 真红：子进程非零退出
//  2. **有 FAIL 行**：排除「脚本自己崩了」这种假红
//  3. 红因是**预期的那条断言**
//
// wrapper 自身 exit 0 ⇒ 三个变异体全被抓住。预期失败的负例由 wrapper 的退出码承载，
// 不由被测负例的退出码承载（否则那一轮永远不可能申报 success）。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = 'G:/zcode-project/zcode-companion';
const LIB = path.join(REPO, 'apps/desktop/lib');

const MUTATIONS = [
  {
    id: 'E1-allowlist-disabled',
    // 去掉字段名白名单 ⇒ 非白名单字段（含带连字符的那些）会一起进导出。
    // 注意：不能只把 `if (...)` 改成 `if (false)` —— 那样非白名单字段会取到
    // `grammar === undefined`，随后 `grammar.test` 抛 TypeError，那是**崩**不是**漏**，
    // 红因不对。所以这里连取值一起放宽，让它以「漏」的方式红。
    edits: [
      {
        from: `    const grammar = Object.prototype.hasOwnProperty.call(EXPORT_FIELD_ALLOWLIST, key)
      ? EXPORT_FIELD_ALLOWLIST[key]
      : undefined;
    if (grammar === undefined) {
      droppedFields += 1;
      continue;
    }`,
        to: `    const grammar = EXPORT_FIELD_ALLOWLIST[key] ?? /^\\S*$/;`
      }
    ],
    expect: '非白名单字段被丢弃并计数'
  },
  {
    id: 'F1-own-property-check-reverted',
    // **本轮修复点的变异体**：把「自有属性」判定退回成**直接索引**。
    // `Object.prototype` 上的 key 索引得到值（`constructor` 是 `Object` 函数、`__proto__`
    // 是原型对象）⇒ 全部穿过 `=== undefined` ⇒ `grammar.test` 抛
    // `grammar.test is not a function`，也就是父审 08:34:17 UTC 那次崩溃原样复现。
    edits: [
      {
        from: `    const grammar = Object.prototype.hasOwnProperty.call(EXPORT_FIELD_ALLOWLIST, key)
      ? EXPORT_FIELD_ALLOWLIST[key]
      : undefined;`,
        to: `    const grammar = EXPORT_FIELD_ALLOWLIST[key];`
      }
    ],
    expect: '回归钉死：父审崩溃输入'
  },
  {
    id: 'F2-in-operator-instead-of-own-property',
    // 用 `in` 代替**自有**属性判定：`in` 会把原型链上的 key 也算成"存在"。
    // 它证明这次修复的关键是「**自有**」，不是「换一个能用的检查」——
    // `in` 看起来一样对，但它会把崩溃原样放回来。
    edits: [
      {
        from: `    const grammar = Object.prototype.hasOwnProperty.call(EXPORT_FIELD_ALLOWLIST, key)
      ? EXPORT_FIELD_ALLOWLIST[key]
      : undefined;`,
        to: `    const grammar = key in EXPORT_FIELD_ALLOWLIST ? EXPORT_FIELD_ALLOWLIST[key] : undefined;`
      }
    ],
    expect: '回归钉死：父审崩溃输入'
  },
  {
    id: 'E2-value-grammar-disabled',
    // 去掉取值文法 ⇒ 白名单字段里塞 canary 就会原样通过。
    edits: [
      {
        from: `    if (!grammar.test(redacted)) {
      droppedInvalid += 1;
      continue;
    }`,
        to: `    if (false) {
      droppedInvalid += 1;
      continue;
    }`
      }
    ],
    expect: '取值不合文法'
  },
  {
    id: 'E3-remove-byte-cap-both-enforcements',
    // 字节上限有**两道**独立防线：贪心装填 + 末尾无条件终钳。
    // 只去掉其中一道会**存活**——那说明的是「有第二道」，不是「断言恒真」。
    edits: [
      { from: '    if (bytes + candidateBytes > maxBytes) break;', to: '    if (false && bytes + candidateBytes > maxBytes) break;' },
      { from: '  if (encoder.encode(text).byteLength > maxBytes) {', to: '  if (false) {' }
    ],
    expect: '超上限时按行截断'
  },
  {
    id: 'E4-free-text-flows-through',
    // 让**自由文本**（用户正文所在处）直接进入导出。
    // 这才是「正文不外带」的承重防线——比字段白名单更靠前的一道：
    // 白名单管的是 k=v 字段，自由文本根本不是字段，只有在这里它才可能被写出去。
    edits: [
      {
        from: '    prepared.push(`${stamp} stream=${stream} ${body}`.trimEnd());',
        to: '    prepared.push(`${stamp} stream=${stream} ${text}`);'
      }
    ],
    expect: '正文 canary 所在的自由文本根本不进导出'
  },
  {
    id: 'E5-inflight-guard-removed',
    // 去掉在途闸门 ⇒ 重复的保存动作会再弹一次对话框、再写一次盘。
    edits: [
      { from: '    if (inFlight) {', to: '    if (false) {' }
    ],
    expect: 'repeat：保存进行中时再来一次'
  }
];

function stage(mutation) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcc-ra09-exp-mut-'));
  fs.mkdirSync(path.join(tmp, 'apps/desktop/lib/__tests__'), { recursive: true });
  fs.copyFileSync(path.join(LIB, 'log-export.cjs'), path.join(tmp, 'apps/desktop/lib/log-export.cjs'));
  fs.copyFileSync(
    path.join(LIB, '__tests__/log-export.test.mjs'),
    path.join(tmp, 'apps/desktop/lib/__tests__/log-export.test.mjs')
  );
  const target = path.join(tmp, 'apps/desktop/lib/log-export.cjs');
  let source = fs.readFileSync(target, 'utf8');
  for (const edit of mutation.edits) {
    if (!source.includes(edit.from)) return { tmp, anchored: false, reason: `anchor not found: ${edit.from.slice(0, 48)}` };
    source = source.replace(edit.from, edit.to);
  }
  fs.writeFileSync(target, source, 'utf8');
  return { tmp, anchored: true };
}

function runTests(tmp) {
  const r = spawnSync(process.execPath, ['--test', '--test-timeout=30000', 'apps/desktop/lib/__tests__/log-export.test.mjs'], {
    cwd: tmp,
    encoding: 'utf8',
    timeout: 300000
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function failCount(stdout) {
  // Node 24 的 `--test` 汇总行前缀是 **`ℹ`**（U+2139），不是 `#`：
  // 实测原文是 `ℹ fail 0`，走 **stdout**（stderr 长度 0）。
  // 我一开始按 `# fail N` 匹配、又怀疑是 stderr，两个猜测都错 ⇒ fail 读成 null，
  // 于是把「红对了」误判成「没红」。教训：**判据格式先实测，别猜**。
  const m = stdout.match(/^\s*(?:#|ℹ|»)?\s*fail\s+(\d+)\s*$/m);
  return m === null ? null : Number(m[1]);
}

let confirmed = 0;
let failed = 0;

for (const mutation of MUTATIONS) {
  const staged = stage(mutation);
  if (!staged.anchored) {
    console.log(`SURVIVED-BY-ANCHOR ${mutation.id}：${staged.reason ?? ''} —— 锚点没命中，根本没改成功，不能算「被抓到」`);
    failed += 1;
    continue;
  }
  const run = runTests(staged.tmp);
  const combined = `${run.stdout}\n${run.stderr}`;
  const fails = failCount(combined);
  // 超时**也是一种红**，但它和「断言 FAIL」不是一回事，必须分开标注：
  // 短接掉在途闸门后，第二次保存会卡在 saveAs 里永不返回 ⇒ 表现为超时而非断言失败。
  // 把两者混为一谈就会写出「exit≠0 所以抓到了」这种含糊结论。
  const timedOut = /timed out after \d+ms/.test(combined);
  const redEnough = run.code !== 0 && (fails !== null && fails > 0 ? true : timedOut);
  const redMode = fails !== null && fails > 0 ? 'assertion' : timedOut ? 'timeout' : 'none';
  const rightReason = combined.includes(mutation.expect);
  if (redEnough && rightReason) {
    console.log(`MUTANT_CONFIRMED ${mutation.id} exit=${run.code} fail=${fails} redMode=${redMode} expect="${mutation.expect}"`);
    confirmed += 1;
  } else {
    console.log(
      `MUTANT_NOT_CONFIRMED ${mutation.id} exit=${run.code} fail=${fails} redEnough=${redEnough} rightReason=${rightReason}`
    );
    console.log(combined.slice(0, 2500));
    failed += 1;
  }
}

console.log(`MUTATION_SUMMARY confirmed=${confirmed} failed=${failed} total=${MUTATIONS.length}`);
process.exit(failed === 0 && confirmed === MUTATIONS.length ? 0 : 1);