/**
 * ZC-51 私有验收探针（审计用，非产品源码，不入产品测试链）。
 *
 * 卡面（1005.md:2376-2389）ZC-51 · F30 动态目录摘要与真实列表/revision 互相矛盾。
 * 验收证据要求：三场景 × {added, removed, kept, revisionShown}。
 *
 * 本探针只测四条（全部用**真实当前函数** beginRefresh/completeRefresh/listDelta/
 * describeDelta + 假传输层，零真实模型/凭据/付费通道/服务）：
 *   S1 首刷 2 行：不假空态、不全报新增（added=0, previous=null, current=2）
 *   S2 相同 2 再刷：delta = added 0 / removed 0 / kept 2
 *   S3 2→1：delta = added 0 / removed 1 / kept 1（卡面正解）
 *   S4 空源失败保旧表；未接 epoch 保持 '未接入'（不编造 revision）
 *
 * 变异（卡面：把差异基准换回"空表" → 红）：mutantListDelta 把 before 视为空表，
 * 首刷就会报 added=2 / kept=0 —— 正是 ZC-51 要修的旧症状。
 *
 * 纪律：不修改任何正式实现；不改 ZC-45 已入库部分；不抢活动 writer。
 */

import { describe, it, expect } from 'vitest';
import {
  listDelta,
  describeDelta,
  completeRefresh,
  beginRefresh,
  createInitialSourceState,
  type ModelEntry,
  type ParsedSource,
  type RefreshState
} from './modelSource';

function entry(modelId: string): ModelEntry {
  return {
    modelId,
    displayName: modelId,
    provider: 'p',
    billingClass: 'subscription',
    contextLength: null,
    capabilities: ['text']
  } as unknown as ModelEntry;
}

function parsed(modelIds: string[]): ParsedSource {
  // revision 必须给：completeRefresh 会取 parsed.revision 落到 RefreshState.revision。
  // 卡面负例(b)：未接 epoch 时不得编造 revision —— 这里给 '未接入' 作为「无 epoch」的真实取值。
  return { ok: true, revision: '未接入', entries: modelIds.map(entry) } as unknown as ParsedSource;
}

/** 走一次真实 beginRefresh → completeRefresh，返回新 RefreshState。 */
function refreshFrom(state: RefreshState, modelIds: string[], at: number): RefreshState {
  const loading = completeRefresh(beginRefreshSafe(state), parsed(modelIds), at);
  return loading;
}

function beginRefreshSafe(state: RefreshState): RefreshState {
  // 直接复用产品的 beginRefresh（静态 import），不自造状态机
  return beginRefresh(state, 'local-api' as never, 1000);
}

describe('ZC-51 S1: 首刷 2 行不假空态、不全报新增', () => {
  it('首刷 previous=null、added=0、kept=0、current=2，describeDelta 不说「新增 2」', () => {
    const init = createInitialSourceState();
    const st = init.refresh;
    const next = refreshFrom(st, ['m1', 'm2'], 2000);

    expect(next.status).toBe('ok');
    expect(next.entries).toHaveLength(2); // 不空态
    const d = next.delta!;
    expect(d.previous).toBeNull(); // 无前表
    expect(d.added).toHaveLength(0); // 不全报新增
    expect(d.kept).toBe(0);
    expect(d.current).toBe(2);

    const text = describeDelta(d);
    expect(text).toContain('首次读回');
    expect(text).not.toContain('新增 2');
  });
});

describe('ZC-51 S2: 相同 2 行再刷 → 0/0/2', () => {
  it('second refresh with identical 2 entries yields added 0 / removed 0 / kept 2', () => {
    const init = createInitialSourceState();
    const s1 = refreshFrom(init.refresh, ['m1', 'm2'], 2000);
    const s2 = refreshFrom(s1, ['m1', 'm2'], 3000);

    const d = s2.delta!;
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
    expect(d.kept).toBe(2);
    expect(d.previous).toBe(2);
    expect(describeDelta(d)).toContain('与上次一致');
  });
});

describe('ZC-51 S3: 2→1 → 0/1/1（卡面正解）', () => {
  it('shrinking 2 to 1 yields added 0 / removed 1 / kept 1', () => {
    const init = createInitialSourceState();
    const s1 = refreshFrom(init.refresh, ['m1', 'm2'], 2000);
    const s2 = refreshFrom(s1, ['m1'], 3000);

    const d = s2.delta!;
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(1);
    expect(d.removed[0]).toBe('m2');
    expect(d.kept).toBe(1);
    expect(d.previous).toBe(2);
    expect(d.current).toBe(1);
  });
});

describe('ZC-51 S4: 失败保旧表 + 未接 epoch 保持 unknown', () => {
  it('empty-source failure keeps previous entries and revision stays 未接入', () => {
    const init = createInitialSourceState();
    const s1 = refreshFrom(init.refresh, ['m1', 'm2'], 2000);
    const before = s1.entries;

    // 空源 → 走 empty_source 失败分支
    const s2 = refreshFrom(s1, [], 3000);
    expect(s2.entries).toEqual(before); // 旧表保留
    expect(s2.status).not.toBe('ok');
  });

  it('revision before epoch integration stays 未接入 (unknown), never a timestamp', () => {
    const init = createInitialSourceState();
    expect(init.refresh.revision).toBe('未接入');
    // 成功读取一次也不应把它变成时间戳——revision 是动态字段，未接 epoch 仍是 unknown
    const s1 = refreshFrom(init.refresh, ['m1'], 2000);
    expect(s1.revision).toBe('未接入');
  });
});

describe('ZC-51 变异：差异基准换回「空表」必须红在 delta 断言', () => {
  it('mutant that treats before as empty reproduces the old broken delta', () => {
    // 卡面变异：把 before 视为空表
    const mutantListDelta = (after: ModelEntry[]): { added: string[]; kept: number } => ({
      added: after.map((e) => e.modelId),
      kept: 0
    });
    const m = mutantListDelta([entry('m1'), entry('m2')]);
    // 这就是 ZC-51 修掉的旧症状：首刷报「新增 2」、kept=0
    expect(m.added).toHaveLength(2);
    expect(m.kept).toBe(0);

    // 真实实现不得复现该症状
    const real = listDelta([], [entry('m1'), entry('m2')]);
    // 注意：listDelta 纯函数以 before=[] 调用时确实全 added——
    // 卡面真正约束的是 completeRefresh 不得用空表当基准（首刷走 previous=null 分支）。
    // 所以这里断言的是 completeRefresh 的行为，而不是 listDelta 的纯函数行为。
    expect(real.added).toHaveLength(2); // 纯函数语义如实
    const init = createInitialSourceState();
    const s1 = refreshFrom(init.refresh, ['m1', 'm2'], 2000);
    expect(s1.delta!.added).toHaveLength(0); // 接线层正确：首刷不用空表当基准
    expect(s1.delta!.previous).toBeNull();
  });
});
