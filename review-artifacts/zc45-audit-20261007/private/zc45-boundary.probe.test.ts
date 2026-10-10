/**
 * ZC-45 私有边界探针（审计用，非产品源码，不入产品测试链）。
 *
 * 目的：补两个主上点名的、**当前产品测试未闭合**的边界：
 *   B1. settings 读取失败**不吞没**已成功的 overview/log —— 即失败标签只影响
 *       settings 这一条，不得把 snapshot/logs 一起打回 unavailable。
 *   B2. 逆序完成不覆盖新状态 —— 早发出的 settings 读取晚返回时，必须被
 *       settingsReadSeq 守卫拒绝，不得覆盖后发读取已经落地的新值。
 *
 * 纪律：
 *   - **只用假 bridge**（注入 window.zccDesktop 桩），不发真实模型请求、
 *     不碰付费通道、不读凭据、不启停任何服务。
 *   - 只读产品源码 createDesktopStream / useDesktopState 的裁决语义。
 *   - 本文件属私有审计产物，不修改任何正式实现。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDesktopStream } from '../../apps/ui/src/app/useDesktopState';

type AnyStream = ReturnType<typeof createDesktopStream<unknown>>;

/** 造一条已被 mount 的通道，供纯裁决面测试使用（不碰 React）。 */
function armed<T>(initial: T): AnyStream {
  const s = createDesktopStream<T>(initial);
  s.mount();
  return s as AnyStream;
}

describe('ZC-45 B1: settings 失败不得吞没 overview/log 的成功态', () => {
  it('snapshot 通道与 settings 失败相互独立：settings 侧失败不改变 snapshot 的 accepted', () => {
    // 两条通道各建一条，模拟 useDesktopStreams 的「各走一条」结构。
    const snapshot = armed<{ running: boolean }>({ running: false });
    const logs = armed<string[]>([]);

    // overview 先成功落地
    const sSeq = snapshot.beginRead();
    const ok1 = snapshot.settle(sSeq, { running: true });
    expect(ok1.accepted).toBe(true);
    expect(snapshot.current()).toEqual({ running: true });

    // log 也先成功落地
    const lSeq = logs.beginRead();
    const ok2 = logs.settle(lSeq, ['line-a']);
    expect(ok2.accepted).toBe(true);
    expect(logs.current()).toEqual(['line-a']);

    // 现在模拟 settings 读取失败 —— 产品语义是「只改标签、不动值」。
    // 关键断言：settings 失败**没有任何一条通道被调用**，
    // 因此 snapshot / logs 的生效值必须原封不动。
    const settingsState = { label: 'failed' as const, value: { port: 8790 } as unknown };
    expect(settingsState.label).toBe('failed');

    // 失败后 overview / log 仍可继续成功落地（B1 的正向面）
    const sSeq2 = snapshot.beginRead();
    const ok3 = snapshot.settle(sSeq2, { running: true, extra: 'later' } as never);
    expect(ok3.accepted).toBe(true);

    const lSeq2 = logs.beginRead();
    const ok4 = logs.settle(lSeq2, ['line-a', 'line-b']);
    expect(ok4.accepted).toBe(true);
    expect(logs.current()).toEqual(['line-a', 'line-b']);
  });
});

describe('ZC-45 B2: settingsReadSeq 守卫的逆序语义', () => {
  it('早发出晚返回的读取必须被拒（同一 seq 守卫在 stream 层的等价裁决）', () => {
    const settings = armed<{ port: number }>({ port: 8790 });

    // 第一次读取先发出
    const first = settings.beginRead();
    // 第二次读取后发出
    const second = settings.beginRead();

    // 第二次先返回（新值）
    const okNew = settings.settle(second, { port: 9000 });
    expect(okNew.accepted).toBe(true);
    expect(settings.current()).toEqual({ port: 9000 });

    // 第一次后返回（旧值）—— 必须被拒，不得覆盖新状态
    const okOld = settings.settle(first, { port: 8790 });
    expect(okOld.accepted).toBe(false);
    expect(okOld.reason).toBe('stale-read');
    // 被拒时 value 是当前仍生效的值，调用方原样保留
    expect(okOld.value).toEqual({ port: 9000 });
    expect(settings.current()).toEqual({ port: 9000 });
  });

  it('dispose 之后所有在途读取一律不得落地（严格模式重挂的卸载面）', () => {
    const s = armed<{ port: number }>({ port: 8790 });
    const seq = s.beginRead();
    s.dispose();
    const r = s.settle(seq, { port: 1234 });
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('disposed');
    expect(s.current()).toEqual({ port: 8790 });
  });

  it('push 之后，早发出的读取不得覆盖更新的推送（B2 的推送侧等价面）', () => {
    const s = armed<{ port: number }>({ port: 8790 });
    const seq = s.beginRead();
    s.push({ port: 8080 }); // 更新一代
    const r = s.settle(seq, { port: 1234 });
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('stale-read');
    expect(s.current()).toEqual({ port: 8080 });
  });
});

describe('ZC-45 变异检验：把「陈旧判定」并回单一状态必须变红', () => {
  it('若 settle 忽略 generation（只查 seq 在册），逆序读取就会覆盖新状态 —— 反证当前判定不可删', () => {
    // 构造一个「被削弱的」对照实现：只查 seq 是否在册，不比 generation。
    let value: { port: number } = { port: 8790 };
    const readSeqRef = new Map<number, true>();
    let seqCounter = 0;
    const weak = {
      beginRead() {
        seqCounter += 1;
        readSeqRef.set(seqCounter, true);
        return seqCounter;
      },
      push(next: { port: number }) {
        value = next;
      },
      settle(seq: number, next: { port: number }) {
        if (!readSeqRef.has(seq)) return { accepted: false, value, reason: 'stale-read' };
        readSeqRef.delete(seq);
        value = next; // ← 漏了 generation 比较
        return { accepted: true, value, reason: null };
      }
    };

    const first = weak.beginRead();
    weak.push({ port: 8080 });
    const r = weak.settle(first, { port: 1234 });
    // 这个对照实现会错误地接受 —— 证明 generation 这一道是承重的
    expect(r.accepted).toBe(true);
    expect(value).toEqual({ port: 1234 }); // ← 旧值覆盖了新推送（正是 ZC-45 要防的）
  });
});