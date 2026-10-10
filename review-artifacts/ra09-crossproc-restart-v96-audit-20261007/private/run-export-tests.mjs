// 桌面侧测试 runner：跑导出与 journal 两个测试文件，并把汇总**解析成机器可读行**。
//
// 为什么要自己包一层：`node --test` 的汇总行长这样（Node 24 实测）：
//   ℹ tests 18 / ℹ pass 18 / ℹ fail 0   —— 走 **stdout**，前缀是 U+2139 而不是 `#`。
// 下游证据要靠 `TESTS_PASSED=` / `TESTS_FAILED=` 判定，所以必须自己归一。
// 判据不是「进程非零」（import 失败也是非零，那不是「断言抓到了问题」）：
// 必须**同时**有 Tests 汇总行且 failed=0。

import { spawnSync } from 'node:child_process';

const REPO = 'G:/zcode-project/zcode-companion';
const FILES = [
  'apps/desktop/lib/__tests__/log-export.test.mjs',
  'apps/desktop/lib/__tests__/journal.test.mjs'
];

// `--test-timeout` 是必需的安全网：某个变异把在途闸门短接后，用例会**挂死**在
// 永不 resolve 的 await 上。没有超时 ⇒ 整轮既不报通过也不报失败，只是把门卡住。
const run = spawnSync(process.execPath, ['--test', '--test-timeout=60000', ...FILES], {
  cwd: REPO,
  encoding: 'utf8',
  timeout: 600000
});

const raw = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
const pick = (label) => {
  const m = raw.match(new RegExp(`^\\s*(?:#|ℹ|»)?\\s*${label}\\s+(\\d+)\\s*$`, 'm'));
  return m === null ? null : Number(m[1]);
};
const tests = pick('tests');
const passed = pick('pass');
const failed = pick('fail');

const ranAnything = tests !== null && passed !== null;
const allGreen = ranAnything && failed === 0 && passed > 0;
const class_ = allGreen ? 'all_passed' : ranAnything ? 'assertion_failed' : 'did_not_run';

console.log(`NODE_TEST_EXIT=${run.status}`);
console.log(`TESTS_TOTAL=${tests ?? 'unknown'}`);
console.log(`TESTS_PASSED=${passed ?? 0}`);
console.log(`TESTS_FAILED=${failed ?? 0}`);
console.log(`CLASS=${class_}`);
if (!allGreen) console.log(raw.slice(0, 3000));

process.exit(allGreen ? 0 : 1);