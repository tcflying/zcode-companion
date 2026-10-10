/**
 * ZCC-ACCOUNT-EVIDENCE-20261009 · 账号/权益读回 + 证据等级计算的定向测试（纯函数，不触网）。
 *
 * 覆盖：
 *  - 「账号与权益」投影：revision / 总数 / entitled / provider×billingClass 分布；
 *  - entitled **口径**：只有 subscription|promotion 计为「目录侧套餐通道条目」；
 *  - 证据等级计算：目录读回成功且有 entitled → E1；无 entitled → E0；
 *  - 读取执行器 reject（fetch 失败）→ E0 并如实带原因码，绝不返回半份目录；
 *  - 加载中 / 空目录 / 契约不合 → 一律 E0 且不闪旧数据。
 *
 * 装配模式沿用 `apps/ui` 既有单测（vitest + node 环境，无 jsdom）。
 */
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_CATALOG_PHASE_LABEL,
  ENTITLED_BILLING_CLASSES,
  INITIAL_ACCOUNT_CATALOG,
  countByBillingClass,
  loadAccountCatalog,
  providersOf,
  summarizeEntries,
  type AccountCatalogState
} from './accountCatalog';
import { computeEvidenceLevel } from './evidence';
import { SourceUnavailableError, type SourceLoader } from './modelSource';

const entry = (
  modelId: string,
  provider: string,
  billingClass: 'subscription' | 'promotion' | 'metered_api' | 'unknown'
) => ({
  key: `source:${modelId}`,
  displayName: modelId,
  provider,
  modelId,
  billingClass,
  contextLength: null,
  reasoning: [],
  capabilities: [],
  origin: 'source' as const,
  availability: 'unverified' as const,
  sendEligible: false as const,
  note: '来源读回（资格未验证）'
});

function payload(models: readonly unknown[]) {
  return { revision: 'rev-x', models };
}

function state(over: Partial<AccountCatalogState>): AccountCatalogState {
  return { ...INITIAL_ACCOUNT_CATALOG, ...over };
}

describe('账号与权益投影（纯函数）', () => {
  it('读回真实字段：revision / 总数 / provider×billingClass 分布，确定性排序', () => {
    const summary = summarizeEntries('rev-9', [
      entry('b', 'bigmodel-start-plan', 'promotion'),
      entry('a', 'bigmodel', 'subscription'),
      entry('c', 'bigmodel', 'subscription'),
      entry('d', 'zai', 'metered_api')
    ]);
    expect(summary.revision).toBe('rev-9');
    expect(summary.total).toBe(4);
    // bigmodel/subscription ×2、bigmodel-start-plan/promotion ×1、zai/metered_api ×1
    expect(summary.buckets).toEqual([
      { provider: 'bigmodel', billingClass: 'subscription', count: 2 },
      { provider: 'bigmodel-start-plan', billingClass: 'promotion', count: 1 },
      { provider: 'zai', billingClass: 'metered_api', count: 1 }
    ]);
    expect(providersOf(summary)).toEqual(['bigmodel', 'bigmodel-start-plan', 'zai']);
    expect(countByBillingClass(summary, 'promotion')).toBe(1);
    expect(countByBillingClass(null, 'promotion')).toBe(0);
  });

  it('entitled 口径 = 目录侧套餐/活动通道条目（subscription|promotion），metered_api/unknown 不算', () => {
    expect([...ENTITLED_BILLING_CLASSES]).toEqual(['subscription', 'promotion']);
    const summary = summarizeEntries('rev-1', [
      entry('a', 'bigmodel', 'subscription'),
      entry('b', 'bigmodel-start-plan', 'promotion'),
      entry('c', 'zai', 'metered_api'),
      entry('d', 'unknown-provider', 'unknown')
    ]);
    expect(summary.entitled).toBe(2);
    expect(summary.total).toBe(4);
  });

  it('初始态是「未读取」而不是「已读回」，四态标签齐全', () => {
    expect(INITIAL_ACCOUNT_CATALOG.phase).toBe('idle');
    expect(INITIAL_ACCOUNT_CATALOG.summary).toBeNull();
    expect(Object.keys(ACCOUNT_CATALOG_PHASE_LABEL)).toEqual(['idle', 'loading', 'loaded', 'failed']);
  });
});

describe('目录读取执行器：失败如实降级，绝不返回半份目录', () => {
  it('执行器 reject（fetch 失败）→ 失败原因码原样带出，不返回目录', async () => {
    const loader: SourceLoader = () =>
      Promise.reject(new SourceUnavailableError('api_not_running', '本机 API 未启动', '先启动本机 API。'));
    const result = await loadAccountCatalog(loader);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('api_not_running');
    expect(result.message).toContain('本机 API 未启动');
  });

  it('未登记原因码也照原样带出，不猜不吞', async () => {
    const loader: SourceLoader = () => Promise.reject(new SourceUnavailableError('weird_code', 'x', 'y'));
    const result = await loadAccountCatalog(loader);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('weird_code');
  });

  it('非 SourceUnavailableError 的抛出按 connection_failed 收敛并保留原文', async () => {
    const loader: SourceLoader = () => Promise.reject(new Error('boom'));
    const result = await loadAccountCatalog(loader);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('connection_failed');
    expect(result.message).toBe('boom');
  });

  it('契约不合 → malformed_payload 并逐条带缺陷（整体拒绝，不部分采纳）', async () => {
    const loader: SourceLoader = () =>
      Promise.resolve(payload([{ modelId: 'bad', displayName: 'x', provider: 'p', billingClass: 'freemium', contextLength: 1, reasoning: [] }]));
    const result = await loadAccountCatalog(loader);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('malformed_payload');
    expect(result.message).toContain('enum_invalid');
  });

  it('读回成功 → summary 里有真实 revision 与条目', async () => {
    const loader: SourceLoader = () =>
      Promise.resolve(
        payload([
          {
            modelId: 'bigmodel::GLM',
            displayName: 'GLM',
            provider: 'bigmodel',
            billingClass: 'subscription',
            contextLength: 200000,
            reasoning: [],
            capabilities: []
          }
        ])
      );
    const result = await loadAccountCatalog(loader);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.summary.revision).toBe('rev-x');
    expect(result.summary.total).toBe(1);
    expect(result.summary.entitled).toBe(1);
  });
});

describe('证据等级计算：有 entitled → E1；无 entitled / 读失败 → E0', () => {
  it('目录读回成功且存在 entitled 条目 → E1', () => {
    const summary = summarizeEntries('rev-2', [
      entry('a', 'bigmodel-start-plan', 'promotion'),
      entry('b', 'zai', 'metered_api')
    ]);
    const verdict = computeEvidenceLevel(state({ phase: 'loaded', summary, loadedAt: 1 }));
    expect(verdict.level).toBe('E1');
    expect(verdict.reasonCode).toBe('catalog_entitled_present');
    expect(verdict.reason).toContain('rev-2');
  });

  it('目录读回成功但没有 entitled 条目 → E0（不升格）', () => {
    const summary = summarizeEntries('rev-3', [entry('c', 'zai', 'metered_api'), entry('d', 'p', 'unknown')]);
    const verdict = computeEvidenceLevel(state({ phase: 'loaded', summary, loadedAt: 1 }));
    expect(verdict.level).toBe('E0');
    expect(verdict.reasonCode).toBe('catalog_no_entitled');
    expect(verdict.reason).toContain('rev-3');
  });

  it('目录读回成功但 0 条目 → E0（空目录是事实，不是不确定）', () => {
    const verdict = computeEvidenceLevel(state({ phase: 'loaded', summary: summarizeEntries('none', []), loadedAt: 1 }));
    expect(verdict.level).toBe('E0');
    expect(verdict.reasonCode).toBe('catalog_empty');
  });

  it('读取失败 → E0，原因码如实出现在原因里', () => {
    const verdict = computeEvidenceLevel(
      state({ phase: 'failed', failure: { code: 'timeout', message: '读取超时', at: 1 } })
    );
    expect(verdict.level).toBe('E0');
    expect(verdict.reasonCode).toBe('timeout');
    expect(verdict.reason).toContain('timeout');
    expect(verdict.reason).toContain('读取超时');
  });

  it('加载中 → E0 且不闪旧数据（summary 被清掉时等级不得升格）', () => {
    const verdict = computeEvidenceLevel(state({ phase: 'loading' }));
    expect(verdict.level).toBe('E0');
    expect(verdict.reasonCode).toBe('catalog_loading');
  });

  it('未读取（初始态）→ E0', () => {
    const verdict = computeEvidenceLevel(INITIAL_ACCOUNT_CATALOG);
    expect(verdict.level).toBe('E0');
    expect(verdict.reasonCode).toBe('catalog_not_read');
  });

  it('等级取值恒在 E0–E3 闭集内，且 E1 不等于可发送（发送门口径不变）', () => {
    const summary = summarizeEntries('rev-4', [entry('a', 'bigmodel', 'subscription')]);
    const verdict = computeEvidenceLevel(state({ phase: 'loaded', summary, loadedAt: 1 }));
    expect(['E0', 'E1', 'E2', 'E3']).toContain(verdict.level);
    expect(verdict.unlocksSend).toBe(false);
    expect(verdict.reason).toContain('不改变发送门');
  });
});