/**
 * 验包自检（`verify:package`）里那条最要紧的判据，抽成不依赖 Electron 的纯函数。
 *
 * 为什么要抽出来：这条判据**同时**被主进程（产物侧写自检报告）和门脚本（仓库侧读
 * 报告判定）使用。曾经两份拷贝不一致——主进程把 `EXTERNAL`（端口上已有别人的服务、
 * 自己什么都没 spawn）当成了「启动成功」，门脚本又照单全收，于是整道门用**一个不是
 * 本包拉起的进程**给本包的自足性签了字。重复的判据迟早会漂，所以只留这一份。
 *
 * 三条 fail-closed 规则，缺一条都判失败：
 *  1. `code === 'EXTERNAL'` 或 `state === 'external'` ⇒ **没有** spawn 任何运行时。
 *     后面的 `/v1` 转发打到的不是本包的东西，自足性未被证明。
 *  2. `state !== 'running'` ⇒ 状态机没走到可用态。
 *  3. `pid` 不是一个数字 ⇒ 没有可证的自有子进程，等于没拉起来。
 *
 * 只判「是不是自己拉起来的」，不判转发结果——那是自检的下一���。
 */

'use strict';

/**
 * @typedef {object} SpawnStep
 * @property {string} [step]
 * @property {boolean} [ok]
 * @property {string} [code]  `start()` 的返回码。
 * @property {string} [state] 状态机状态。
 * @property {number|null} [pid]
 * @property {number|null} [port]
 */

/**
 * @typedef {{ ok: true } | { ok: false, reason: string }} SpawnVerdict
 */

/**
 * 判定「产物是不是真的把反代拉起来了」。
 *
 * @param {SpawnStep | undefined} spawnStep
 * @param {number | null} [port] 失败时用于点名端口；缺省取 step 自带的。
 * @returns {SpawnVerdict}
 */
function assessSpawnStep(spawnStep, port) {
  if (spawnStep === undefined || spawnStep === null) {
    return { ok: false, reason: '自检报告里没有 spawn-runtime 这一步' };
  }
  const where = port ?? spawnStep.port ?? '<未知>';
  if (spawnStep.code === 'EXTERNAL' || spawnStep.state === 'external') {
    return {
      ok: false,
      reason:
        `端口 ${where} 上已有服务，本包进入 external 态、**没有**拉起自己的运行时` +
        '（自检端口请用空闲端口：ZCC_VERIFY_PORT）。'
    };
  }
  if (spawnStep.state !== 'running' || typeof spawnStep.pid !== 'number') {
    return {
      ok: false,
      reason: `包内反代运行时未能启动：${String(spawnStep.code)}（state=${String(spawnStep.state)}，pid=${String(spawnStep.pid)}）`
    };
  }
  return { ok: true };
}

exports.assessSpawnStep = assessSpawnStep;
