/**
 * 反代子进程的 spawn 规格构造（I10）。
 *
 * 抽成可注入的纯函数只有一个理由：**「key 只在 env、不在命令行」这条安全承诺必须是
 * 可测的**。它原先长在 `main.cjs` 里，测试只能对着自己手写的字面量断言——那份
 * 字面量与产品代码没有任何关系，把 `main.cjs` 的 `args` 改成 `--api-key <key>`
 * 测试照样绿。承诺挂在注释里，不等于被守住。
 *
 * 纯函数、无 IO：所有会变的部分（运行时寻址、设置、父进程 env、Node 运行时来源）
 * 都从参数进来，因此可以在没有 Electron、没有网络的条件下对**真实产物**逐字断言。
 */

'use strict';

const { buildChildEnv } = require('./proxy-manager.cjs');

/**
 * @typedef {object} SpawnRuntime
 * @property {string} apiEntry    反代入口绝对路径。
 * @property {string} runtimeRoot 子进程工作目录（官方宿主要建隔离工作区）。
 */

/**
 * @typedef {object} NodeCommand
 * @property {string} command 可执行文件。
 * @property {Record<string, string>} [extra] 额外的非 ZCC 键（如 `ELECTRON_RUN_AS_NODE`）。
 */

/**
 * 组装 spawn 规格。
 *
 * @param {object} options
 * @param {SpawnRuntime} options.runtime
 * @param {{ apiKey: string, apiPort: number, driver: string, reasoning: string }} options.settings
 * @param {NodeCommand} options.node Node 运行时来源。
 * @param {Record<string, string | undefined>} options.parentEnv
 * @param {number} [options.shutdownGraceMs]
 * @param {string} [options.journalDir] 子进程操作 journal 落盘目录（= 主进程 settings 所在目录）。
 * @returns {{ command: string, args: string[], env: Record<string, string>, cwd: string, windowsHide: boolean, shell: boolean }}
 */
function buildSpawnSpec(options) {
  return {
    command: options.node.command,
    // key 绝不进 argv：命令行参数对本机所有进程可见（`tasklist`/进程管理器都能看到），
    // `--api-key` 等于把 key 贴在了进程列表上。它只走 env。
    args: [options.runtime.apiEntry, '--driver', options.settings.driver],
    env: buildChildEnv({
      apiKey: options.settings.apiKey,
      apiPort: options.settings.apiPort,
      reasoning: options.settings.reasoning,
      // 929.md:875：journal 必须落在**既有配置路径**下，不能要求用户另设开关。
      // 目录不是机密，所以走 env 也满足「key 不进 argv」那条纪律。
      journalDir: options.journalDir,
      shutdownGraceMs: options.shutdownGraceMs,
      parentEnv: options.parentEnv,
      extra: options.node.extra
    }),
    cwd: options.runtime.runtimeRoot,
    // 不弹独立 cmd 窗口是本工单的产品承诺之一：这两个开关必须为真。
    windowsHide: true,
    shell: false
  };
}

exports.buildSpawnSpec = buildSpawnSpec;
