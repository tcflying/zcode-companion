// 变异验证：证明跨进程探针 T15 **有区分力**，不是恒绿。
//
// 为什么必须做：T15 与被测代码是同一轮写的，全绿的信息量接近零。
// 判据是「把产品改坏，它会不会红」——而且必须**因为预期的原因**红，
// 不是因为脚本自己崩了（我踩过「exit≠0 但零 FAIL 行 = 根本没跑起来」的坑，
// 那比不做变异检查更糟，因为它给的是虚假的安心）。
//
// 零正式源码写入：把 packages/api/src 与 packages/contracts/src **复制**到
// os.tmpdir()，在副本上做变异，再把子进程入口指向副本打包。
// 正式目录一个字节都不动，runner 的 STRAY 断言仍然成立。
//
// 预期失败的负例由**本 wrapper 的退出码**承载：wrapper spawn 变异体（它必然红），
// 然后断言「确实红了 + 红因是预期的那个」。所以 wrapper 自身 exit 0。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = 'G:/zcode-project/zcode-companion';
const PRIVATE = `${REPO}/review-artifacts/ra09-crossproc-restart-v96-audit-20261007/private`;
const VITEST = `${REPO}/node_modules/vitest/vitest.mjs`;
const CONFIG = `${PRIVATE}/vitest.crossproc.config.mts`;
const PROBE = `${PRIVATE}/journal-crossproc.probe.test.mjs`;

const MUTATIONS = [
  {
    id: 'M1-no-recover-inflight',
    target: 'journal-store.ts',
    // 承接动作的全部实质就在这一行。短接它 ⇒ B 读盘后 in_flight 仍是 in_flight
    // ⇒ 会话闸门（只看 unknown）判不到 ⇒ 同会话重发会被放行并 dispatch。
    from: '    if (e.state !== IN_FLIGHT) return e;',
    to: '    return e; /* MUTANT M1: 不承接任何 in_flight */',
    // 红因必须是「同会话重发本该被拒却放行了」，不是别的错误。
    expectFailPattern: '同会话重发必须被拒',
    expectFailTests: 'T15'
  },
  {
    id: 'M2-session-gate-shortcircuit',
    target: 'server.ts',
    // 会话闸门整段短接：pending 判空直接跳过。
    from: '      const pending = operationJournal.lookupSessionUnknown(session.sessionKey);',
    to: '      const pending = undefined; /* MUTANT M2: 会话闸门短接 */',
    expectFailPattern: '同会话重发必须被拒',
    expectFailTests: 'T15'
  },
  {
    id: 'M3-restore-raw-session-log',
    target: 'server.ts',
    // 把「只写指纹」的最小修复改回「写原值」。
    // T17 是这条修复的回归守卫：若它对这种回退**不红**，说明它是恒真断言。
    from: 'session_key=${session.sessionKey} pending_operation=',
    to: 'client=${session.clientId} session=${session.sessionId} pending_operation=',
    expectFailPattern: '合成 canary 原值不得出现在日志里',
    expectFailTests: 'T17'
  }
];

function copyTree(from, to) {
  fs.cpSync(from, to, { recursive: true });
}

function stageMutant(mutation) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcc-ra09-mut-'));
  // 保持与正式树**同构**，这样 `./x.js` 与 `../../contracts/src/...` 的相对深度不变。
  fs.mkdirSync(path.join(tmp, 'packages/api'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'private'), { recursive: true });
  copyTree(`${REPO}/packages/api/src`, path.join(tmp, 'packages/api/src'));
  copyTree(`${REPO}/packages/contracts/src`, path.join(tmp, 'packages/contracts/src'));

  // 子进程入口的仓库相对 import 改指副本。
  const tmpForward = tmp.replace(/\\/g, '/');
  let child = fs.readFileSync(`${PRIVATE}/crossproc-child.ts`, 'utf8');
  const before = child;
  child = child.split("'../../../packages/").join(`'${tmpForward}/packages/`);
  if (child === before) throw new Error('child import rewrite did not apply');
  fs.writeFileSync(path.join(tmp, 'private/crossproc-child.ts'), child, 'utf8');

  // 变异本体。锚点没命中必须单独报，否则会把「没改成」误报成「被抓到了」。
  const targetPath = path.join(tmp, 'packages/api/src', mutation.target);
  const source = fs.readFileSync(targetPath, 'utf8');
  if (!source.includes(mutation.from)) {
    return { tmp, anchored: false, reason: `anchor not found in ${mutation.target}` };
  }
  fs.writeFileSync(targetPath, source.replace(mutation.from, mutation.to), 'utf8');
  return { tmp, anchored: true };
}

function buildChild(entry, outDir) {
  const r = spawnSync(process.execPath, [`${PRIVATE}/build-child.mjs`, entry, outDir], {
    cwd: REPO,
    encoding: 'utf8'
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function runProbe(bundle) {
  const r = spawnSync(process.execPath, [VITEST, 'run', '--config', CONFIG], {
    cwd: REPO,
    encoding: 'utf8',
    // 必须**显式清空** ZCC_CP_EVIDENCE_FILE：调用方（我的 shell）可能带着它，
    // 那样每一次变异运行都会把自己的证据行追加进「正例」那个 artifact，
    // 把两者的证据混成一份——实测踩过：artifact 里出现了 8 行、正例只有 3 行。
    // 混进去的证据比没有证据更糟，因为它看起来是全的。
    env: { ...process.env, ZCC_CP_BUNDLE: bundle, ZCC_CP_EVIDENCE_FILE: '' },
    timeout: 300000
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 从 vitest 汇总行取失败条数：零 FAIL 行 + 非零退出 = 没跑起来，不能算「抓到」。 */
function failCount(stdout) {
  const m = stdout.match(/^\s*Tests\s+(.+)$/m);
  if (m === null) return { known: false, failed: 0, summary: '' };
  const fm = m[1].match(/(\d+)\s+failed/);
  return { known: true, failed: fm === null ? 0 : Number(fm[1]), summary: m[1] };
}

let confirmed = 0;
let failed = 0;

for (const mutation of MUTATIONS) {
  const staged = stageMutant(mutation);
  if (!staged.anchored) {
    console.log(`SURVIVED-BY-ANCHOR ${mutation.id} ${staged.reason}`);
    failed += 1;
    continue;
  }

  const build = buildChild(path.join(staged.tmp, 'private/crossproc-child.ts'), path.join(staged.tmp, 'build'));
  if (build.code !== 0) {
    console.log(`MUTANT_BUILD_FAILED ${mutation.id}\n${build.stdout}\n${build.stderr}`);
    failed += 1;
    continue;
  }

  const bundle = path.join(staged.tmp, 'build/crossproc-child.mjs');
  const run = runProbe(bundle);
  const counts = failCount(run.stdout);
  const combined = `${run.stdout}\n${run.stderr}`;

  // 三重判据，缺一不可：
  //  1. 真红（非零退出）
  //  2. **有 FAIL 行**（排除「脚本自己崩了」这种假红）
  //  3. 红因是预期的那条断言
  const redEnough = run.code !== 0 && counts.known && counts.failed > 0;
  const rightReason = combined.includes(mutation.expectFailPattern);

  if (redEnough && rightReason) {
    console.log(`MUTANT_CONFIRMED ${mutation.id} exit=${run.code} tests="${counts.summary}" probe=${PROBE}`);
    confirmed += 1;
  } else {
    console.log(
      `MUTANT_NOT_CONFIRMED ${mutation.id} exit=${run.code} tests="${counts.summary}" ` +
        `redEnough=${redEnough} rightReason=${rightReason}`
    );
    console.log(combined.slice(0, 3000));
    failed += 1;
  }
}

console.log(`MUTATION_SUMMARY confirmed=${confirmed} failed=${failed} total=${MUTATIONS.length}`);
process.exit(failed === 0 && confirmed === MUTATIONS.length ? 0 : 1);