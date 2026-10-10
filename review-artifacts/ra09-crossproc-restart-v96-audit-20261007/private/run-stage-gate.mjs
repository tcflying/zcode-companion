// stage-gate 包装器：把子进程 cwd 强制到**仓库根**再跑。
//
// 为什么要包：evidence-gate 的 `run --cwd` 必须在 round 目录内（gate.py:93 `safe(cwd, root)`），
// 而 `scripts/stage-gate.mjs` 是按**仓库根**解析配置的。在 round 目录下直接调它会红，
// 那是**调用姿势**造成的假红，不是产品缺陷——但 gate 只看子进程 exit code，
// 假红和真红在它眼里没有区别，所以必须在这一层把 cwd 纠正。
//
// 本包装器**不吞失败**：stage-gate 的真实退出码原样透传，红就是红。

import { spawnSync } from 'node:child_process';

const REPO = 'G:/zcode-project/zcode-companion';
const sub = process.argv[2];
if (typeof sub !== 'string' || sub === '') {
  console.log('USAGE: run-stage-gate.mjs <typecheck:apps|typecheck:desktop|test:ui|...>');
  process.exit(2);
}

const run = spawnSync(process.execPath, ['scripts/stage-gate.mjs', sub], {
  cwd: REPO,
  encoding: 'utf8',
  timeout: 900000
});

const raw = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
// **原样转发全部输出，不做任何过滤**。父审要求「跑原始未过滤命令、留真实 receipt」——
// 这里若只挑关键行，封存的 stdout 就不是那条命令的真实输出，证据会被我自己的加工污染。
console.log(raw);
console.log(`STAGE_GATE_SUB=${sub}`);
console.log(`STAGE_GATE_EXIT=${run.status}`);
process.exit(run.status === null ? 1 : run.status);