/**
 * 验包自检那条判据的钉死测试（I10）。
 *
 * 这条判据曾经是两份拷贝，而且**漂了**：产物侧把 `EXTERNAL`（端口上已有别人的服务、
 * 自己一个进程都没 spawn）当成启动成功，门脚本照单全收，于是整道门用一个不是本包
 * 拉起的进程替本包的自足性签了字。现在两边共用 `assessSpawnStep`，这里把它逐条钉死。
 *
 * 纪律：判定**只能更严**。任何一条把这些 case 判成 ok 的改动都让本文件变红。
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assessSpawnStep } = require('../../apps/desktop/lib/verify-contract.cjs');

/** 一条「真的由本包 spawn 起来了」的自检步骤，作为对照组的起点。 */
const owned = () => ({ step: 'spawn-runtime', ok: true, code: 'STARTED', state: 'running', pid: 41234, port: 8897 });

describe('验包自检：必须证明「是本包自己拉起的」', () => {
  it('对照组：自己 spawn 起来的 running 态才算通过', () => {
    expect(assessSpawnStep(owned())).toEqual({ ok: true });
  });

  it('EXTERNAL 判失败：端口上有别人的服务，本包什么都没 spawn', () => {
    const verdict = assessSpawnStep({ step: 'spawn-runtime', ok: true, code: 'EXTERNAL', state: 'external', pid: null, port: 8899 });
    expect(verdict.ok).toBe(false);
    // 原因里必须点名端口与修法：这条报错是给人照着改的。
    expect(verdict.ok === false && verdict.reason).toContain('8899');
    expect(verdict.ok === false && verdict.reason).toContain('ZCC_VERIFY_PORT');
  });

  it('code 是 EXTERNAL 但 state 不是 external（或反过来）一样判失败', () => {
    expect(assessSpawnStep({ code: 'EXTERNAL', state: 'running', pid: 7, port: 8897 }).ok).toBe(false);
    expect(assessSpawnStep({ code: 'STARTED', state: 'external', pid: null, port: 8897 }).ok).toBe(false);
  });

  it('`ok: true` 不作数：state 不是 running 一律失败', () => {
    for (const state of ['stopped', 'starting', 'failed']) {
      const verdict = assessSpawnStep({ step: 'spawn-runtime', ok: true, code: 'STARTED', state, pid: 9, port: 8897 });
      expect(verdict.ok, `state=${state} 必须判失败`).toBe(false);
    }
  });

  it('没有可证的 pid 不算拉起来了', () => {
    // 字符串 pid 是运行时可能出现的脏形状（报告被手改过 / 序列化错位），判据必须照样拒。
    // 越过类型标注是故意的：要测的就是「类型不对时也不放过」。
    const bad = [null, undefined, /** @type {any} */ ('41234')];
    for (const pid of bad) {
      const verdict = assessSpawnStep({ step: 'spawn-runtime', ok: true, code: 'STARTED', state: 'running', pid, port: 8897 });
      expect(verdict.ok, `pid=${String(pid)} 必须判失败`).toBe(false);
    }
  });

  it('启动超时 / spawn 失败的返回码都落在失败侧，且原因里带上 code', () => {
    for (const code of ['START_TIMEOUT', 'SPAWN_FAILED', 'CHILD_EXITED', 'PORT_NOT_SET', 'SPAWN_SPEC_NOT_SET', 'DISPOSED']) {
      const verdict = assessSpawnStep({ step: 'spawn-runtime', ok: false, code, state: 'failed', pid: null, port: 8897 });
      expect(verdict.ok, `code=${code} 必须判失败`).toBe(false);
      expect(verdict.ok === false && verdict.reason).toContain(code);
    }
  });

  it('缺步骤 / 缺端口都 fail-closed，不猜', () => {
    expect(assessSpawnStep(undefined).ok).toBe(false);
    const noPort = assessSpawnStep({ code: 'EXTERNAL', state: 'external', pid: null });
    expect(noPort.ok).toBe(false);
    expect(noPort.ok === false && noPort.reason).toContain('<未知>');
  });
});
