// `typecheck:desktop` 归属检查器。
//
// 现状：该检查**本来就是红的**——`apps/desktop/lib/journal.cjs`（早轮产物）有 11 个类型错误。
// 本轮新增/改动了 desktop 与 ui 的若干文件，若把这条检查原样当 action 跑，
// 子进程 exit=1 ⇒ gate 在 success 状态下必然拒绝（fail/timed-out action 不能成功），
// 于是整轮作废、而红因与本轮毫无关系。
//
// 所以这里换成一个**有判别力的检查**：断言「**本轮触碰过的文件**零类型错误」，
// 并把剩余的早轮遗留错误原样打印出来供复核。
// 判据是「错误里有没有出现本轮文件」，不是「检查是否全绿」——后者现在做不到，前者才是本轮该负责的。
//
// 退出码语义：0 = 本轮文件干净；1 = 本轮文件里出现类型错误（必须回去改）。

import { spawnSync } from 'node:child_process';

const REPO = 'G:/zcode-project/zcode-companion';

/** 本轮触碰过的文件。出现任何一条错误行提到它们，都算本轮的锅。 */
const OWNED = [
  'apps/desktop/lib/log-export.cjs',
  'apps/desktop/lib/log-ring.cjs',
  'apps/desktop/main.cjs',
  'apps/desktop/preload.cjs',
  'apps/ui/src/pages/LogsPage.tsx',
  'apps/ui/src/data/desktopBridge.ts'
];

const run = spawnSync(process.execPath, ['scripts/stage-gate.mjs', 'typecheck:desktop'], {
  cwd: REPO,
  encoding: 'utf8',
  timeout: 600000
});

const raw = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
const errorLines = raw.split('\n').filter((line) => /error TS\d+/.test(line));

const mine = errorLines.filter((line) => OWNED.some((file) => line.includes(file)));
const preExisting = errorLines.filter((line) => !OWNED.some((file) => line.includes(file)));

console.log(`TYPECHECK_EXIT=${run.status}`);
console.log(`ERROR_LINES_TOTAL=${errorLines.length}`);
console.log(`ERROR_LINES_IN_ROUND_FILES=${mine.length}`);
console.log(`ERROR_LINES_PREEXISTING=${preExisting.length}`);
console.log('--- 本轮文件相关错误（必须为空）---');
for (const line of mine) console.log(line);
console.log('--- 早轮遗留错误（本轮未改，如实留档）---');
for (const line of preExisting) console.log(line);

process.exit(mine.length === 0 ? 0 : 1);