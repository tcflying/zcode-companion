/**
 * ZCC-GUI-EVIDENCE-20261008-A · UI 侧 readStatus 严格 parse + 读取态测试（provider-free）。
 *
 * 覆盖：
 *  - 默认零网络：idle 初始态不发任何请求
 *  - 严格 parse：任一形状不符 → 整体 null（不做部分采纳）
 *  - 闭集防御：driver.kind/status、sourceKind、gaps 闭集外一律拒
 *  - 脱敏：不含 cacheKey / domain / reason / statusDetail
 *  - 不定级：gradedByServer=false / validityWindowKnown=false
 *  - fetchReadStatus：redirect:error、no-store、零凭据、失败不返回半份
 */
import { describe, expect, it, vi } from 'vitest';
import {
  parseReadStatus,
  describeBlockingGaps,
  INITIAL_READ_STATUS_STATE,
  READ_PHASE_LABEL,
  type ReadStatusSnapshot
} from './readStatus';
import { fetchReadStatus, resolveCatalogUrl, type LocalApiRequestInit } from './localApiSource';

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'zcc-read-status',
    version: 1,
    driver: { kind: 'official-host', status: 'ready', catalogCount: 18, servableCount: 10 },
    catalog: {
      sourceKind: 'local-official-files',
      revision: 'rev-x',
      entryCount: 18,
      schemaVersion: 1,
      documentRevision: 7,
      readAt: 1_700_000_000_000
    },
    entitlement: { present: true, updatedAt: 1_700_000_000_000, availableCount: 2, unavailableCount: 1, unknownCount: 0, itemCount: 3 },
    selection: { present: true, updatedAt: 1_700_000_000_000, selectedCount: 1 },
    e1Blocking: ['account_unproven', 'entitlement_staleness_unproven', 'selection_unproven', 'billing_class_mapping_unproven'],
    usageWarnings: ['authoritative_bucket_unobserved'],
    validityWindowKnown: false,
    gradedByServer: false,
    ...over
  };
}

describe('默认零网络', () => {
  it('初始态是 idle 且无 snapshot / 无失败', () => {
    expect(INITIAL_READ_STATUS_STATE.phase).toBe('idle');
    expect(INITIAL_READ_STATUS_STATE.snapshot).toBeNull();
    expect(INITIAL_READ_STATUS_STATE.loadedAt).toBeNull();
  });

  it('idle 标签明确写着零网络', () => {
    expect(READ_PHASE_LABEL.idle).toContain('零网络');
  });
});

describe('严格 parse', () => {
  it('合法 payload 解析成功', () => {
    const s = parseReadStatus(payload());
    expect(s).not.toBeNull();
    expect(s?.driver.catalogCount).toBe(18);
    expect(s?.driver.servableCount).toBe(10);
  });

  it('非对象 / 数组 / null 一律 null', () => {
    for (const bad of [null, undefined, 1, 'x', [], true]) {
      expect(parseReadStatus(bad)).toBeNull();
    }
  });

  it('schema/version 不符一律 null', () => {
    expect(parseReadStatus(payload({ schema: 'other' }))).toBeNull();
    expect(parseReadStatus(payload({ version: 2 }))).toBeNull();
  });

  it('driver.kind/status 闭集外一律 null', () => {
    expect(parseReadStatus(payload({ driver: { kind: 'evil', status: 'ready', catalogCount: 1, servableCount: 1 } }))).toBeNull();
    expect(parseReadStatus(payload({ driver: { kind: 'none', status: 'weird', catalogCount: 1, servableCount: 1 } }))).toBeNull();
  });

  it('count 负数/小数/缺字段 → null', () => {
    expect(parseReadStatus(payload({ driver: { kind: 'none', status: 'not_attached', catalogCount: -1, servableCount: 1 } }))).toBeNull();
    expect(parseReadStatus(payload({ driver: { kind: 'none', status: 'not_attached', catalogCount: 1.5, servableCount: 1 } }))).toBeNull();
    expect(parseReadStatus(payload({ driver: { kind: 'none', status: 'not_attached', servableCount: 1 } }))).toBeNull();
  });

  it('sourceKind 闭集外 null', () => {
    const p = payload();
    (p['catalog'] as Record<string, unknown>)['sourceKind'] = 'remote-official';
    expect(parseReadStatus(p)).toBeNull();
  });

  it('gaps 闭集外 null（不做部分采纳）', () => {
    expect(parseReadStatus(payload({ e1Blocking: ['account_unproven', 'not_a_real_gap'] }))).toBeNull();
    expect(parseReadStatus(payload({ usageWarnings: ['billing_unobserved'] }))).toBeNull();
  });

  it('present 非布尔 → null', () => {
    expect(parseReadStatus(payload({ entitlement: { present: 'yes', updatedAt: null, availableCount: 0, unavailableCount: 0, unknownCount: 0, itemCount: 0 } }))).toBeNull();
  });

  it('entitlement/selection 允许 null（缺源），但给了就必须合法', () => {
    expect(parseReadStatus(payload({ entitlement: null, selection: null, e1Blocking: ['account_unproven', 'entitlement_staleness_unproven', 'selection_unproven', 'billing_class_mapping_unproven', 'entitlement_absent', 'selection_absent'] }))).not.toBeNull();
    expect(parseReadStatus(payload({ entitlement: { present: true } }))).toBeNull();
    expect(parseReadStatus(payload({ selection: { present: true, selectedCount: -1 } }))).toBeNull();
  });

  it('validityWindowKnown / gradedByServer 必须为 false', () => {
    expect(parseReadStatus(payload({ validityWindowKnown: true }))).toBeNull();
    expect(parseReadStatus(payload({ gradedByServer: true }))).toBeNull();
  });
});

describe('脱敏与不定级', () => {
  it('解析结果不含任何秘密字段名', () => {
    const s = parseReadStatus(payload());
    const j = JSON.stringify(s);
    for (const t of ['cacheKey', 'credentialLocations', 'statusDetail', 'providerFamilyDomain', 'sha256', 'path']) {
      expect(j).not.toContain(`"${t}"`);
    }
  });

  it('gradedByServer / validityWindowKnown 恒 false', () => {
    const s = parseReadStatus(payload()) as ReadStatusSnapshot;
    expect(s.gradedByServer).toBe(false);
    expect(s.validityWindowKnown).toBe(false);
  });

  it('describeBlockingGaps 给出中文缺口清单', () => {
    const s = parseReadStatus(payload()) as ReadStatusSnapshot;
    const labels = describeBlockingGaps(s);
    expect(labels.length).toBe(4);
    expect(labels.join('')).toContain('账号');
  });

  it('describeBlockingGaps(null) 不编造', () => {
    expect(describeBlockingGaps(null)).toEqual(['尚未读到证据状态']);
  });
});

describe('fetchReadStatus：守卫 / 零凭据 / 不返回半份', () => {
  it('base URL 非回环 → 拒绝，一个字节都不发', async () => {
    const fetchImpl = vi.fn();
    await expect(fetchReadStatus('http://evil.example', fetchImpl as never)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('同源默认 base URL 走契约路径', () => {
    expect(resolveCatalogUrl('').ok).toBe(true);
  });

  it('请求带 redirect:error / no-store / 无凭据头', async () => {
    const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string, init: Record<string, unknown>) => {
      calls.push({ url, init });
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        text: async () => JSON.stringify(payload())
      };
    });
    const raw = await fetchReadStatus('', fetchImpl as never);
    expect(JSON.parse(raw as string).schema).toBe('zcc-read-status');
    const init = calls[0]!.init as Record<string, unknown>;
    expect(init['redirect']).toBe('error');
    expect(init['cache']).toBe('no-store');
    const headers = init['headers'] as Record<string, string>;
    expect(Object.keys(headers)).toEqual(['accept']);
    expect(headers['authorization']).toBeUndefined();
    expect(headers['cookie']).toBeUndefined();
  });

  it('非 2xx → 抛错，不返回半份 JSON', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 401, ok: false, headers: { get: () => null }, text: async () => '{"error":"unauthorized"}'
    }));
    await expect(fetchReadStatus('', fetchImpl as never)).rejects.toThrow();
  });

  it('正文读不出来 → 抛错', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 200, ok: true, headers: { get: () => null }, text: async () => { throw new Error('boom'); }
    }));
    await expect(fetchReadStatus('', fetchImpl as never)).rejects.toThrow();
  });

  it('不发任何模型 POST：始终 GET 且无 body', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_u: string, init: Record<string, unknown>) => {
      calls.push(init);
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(payload()) };
    });
    await fetchReadStatus('', fetchImpl as never);
    expect(calls[0]!['method']).toBe('GET');
    expect(calls[0]!['body']).toBeUndefined();
  });
});
describe('精确 DTO 与矛盾拒绝', () => {
  it('每层每个必填字段缺失或多出字段均整体拒绝', () => {
    for (const scope of ['', 'driver', 'catalog', 'entitlement', 'selection']) {
      const original = payload();
      const object = scope ? original[scope] as Record<string, unknown> : original;
      for (const key of Object.keys(object)) {
        const p = structuredClone(original);
        delete (scope ? p[scope] as Record<string, unknown> : p)[key];
        expect(parseReadStatus(p), `${scope}.${key}`).toBeNull();
      }
      object['privateExtra'] = 'never-adopt';
      expect(parseReadStatus(original), scope).toBeNull();
    }
  });
  it('计数和、present-count、servable 子集、重复gap、职责和未来时间均拒绝', () => {
    const now = 1_700_000_100_000;
    const cases: Array<(p: Record<string, unknown>) => void> = [
      p => { (p['entitlement'] as Record<string, unknown>)['itemCount'] = 4; },
      p => { (p['entitlement'] as Record<string, unknown>)['present'] = false; },
      p => { (p['selection'] as Record<string, unknown>)['selectedCount'] = 0; },
      p => { (p['driver'] as Record<string, unknown>)['servableCount'] = 19; },
      p => { p['e1Blocking'] = ['account_unproven', 'account_unproven']; },
      p => { p['usageWarnings'] = ['consumption_unobserved', 'consumption_unobserved']; },
      p => { p['e1Blocking'] = ['consumption_unobserved']; },
      p => { (p['catalog'] as Record<string, unknown>)['readAt'] = now + 1; },
      p => { (p['selection'] as Record<string, unknown>)['updatedAt'] = now + 1; },
      p => { (p['entitlement'] as Record<string, unknown>)['updatedAt'] = now + 1; },
      p => { (p['catalog'] as Record<string, unknown>)['sourceKind'] = 'unknown'; },
      p => { p['e1Blocking'] = [...p['e1Blocking'] as string[], 'entitlement_absent']; }
    ];
    for (const mutate of cases) { const p = payload(); mutate(p); expect(parseReadStatus(p, now)).toBeNull(); }
    expect(parseReadStatus(payload(), Number.NaN)).toBeNull();
    expect(parseReadStatus(payload(), now)?.driver.servableCount).toBe(10);
  });
});

describe('readstatus 实际 URL 与完整预算', () => {
  it.each([
    ['', '/v1/zcc/readstatus'], ['/', '/v1/zcc/readstatus'],
    ['http://127.0.0.1:8791', 'http://127.0.0.1:8791/v1/zcc/readstatus'],
    ['http://localhost:12345/', 'http://localhost:12345/v1/zcc/readstatus'],
    ['http://[::1]:12345/', 'http://[::1]:12345/v1/zcc/readstatus']
  ])('实际请求 %s → %s，无目录尾缀、无token', async (base, wanted) => {
    const fetcher = vi.fn(async (_url: string, _init: LocalApiRequestInit) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' }));
    await fetchReadStatus(base, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(wanted);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', headers: { accept: 'application/json' } });
  });
  it.each(['http://127.0.0.1:8791/v1/zcc/catalog', 'http://localhost:1//', '/path', 'http://127.0.0.1:1/?x=1', 'http://user:pass@127.0.0.1:1/'])('带路径/斜线/凭据输入 %s 发前拒绝', async base => {
    const fetcher = vi.fn();
    await expect(fetchReadStatus(base, fetcher)).rejects.toMatchObject({ reason: 'transport_not_wired' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('默认预算实际为5000ms；头+正文同预算，忽略abort的迟到正文也拒绝', async () => {
    vi.useFakeTimers();
    try {
      let bodyResolve: (s: string) => void = () => undefined;
      const fetcher = vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, text: () => new Promise<string>(resolve => { bodyResolve = resolve; }) }));
      const promise = fetchReadStatus('', fetcher);
      const assertion = expect(promise).rejects.toMatchObject({ reason: 'timeout' });
      await vi.advanceTimersByTimeAsync(4999);
      expect(fetcher.mock.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
      bodyResolve('{}'); await Promise.resolve();
    } finally { vi.useRealTimers(); }
  });
  it('正文 AbortError 分类 timeout，非abort正文失败分类 connection_failed', async () => {
    for (const [name, code] of [['AbortError', 'timeout'], ['Error', 'connection_failed']]) {
      const err = new Error('synthetic'); err.name = name!;
      const fetcher = vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => { throw err; } }));
      await expect(fetchReadStatus('', fetcher)).rejects.toMatchObject({ reason: code });
    }
  });
});

// Deterministic fetch substitute, including one budget across delayed headers + body.
describe('迟到响应头与正文总预算', () => {
  it('无视abort的头也在5000ms结束，迟到头不采纳', async () => {
    vi.useFakeTimers(); try {
      let deliver: (v: { ok: boolean; status: number; headers: { get: () => null }; text: () => Promise<string> }) => void = () => undefined;
      const fetcher = vi.fn(() => new Promise<{ ok: boolean; status: number; headers: { get: () => null }; text: () => Promise<string> }>(resolve => { deliver = resolve; }));
      const request = fetchReadStatus('', fetcher);
      const rejected = expect(request).rejects.toMatchObject({ reason: 'timeout' });
      await vi.advanceTimersByTimeAsync(5000); await rejected;
      deliver({ ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' }); await Promise.resolve();
    } finally { vi.useRealTimers(); }
  });
  it('头耗3000ms后正文只有剩余2000ms，不另开5000ms', async () => {
    vi.useFakeTimers(); try {
      const fetcher = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 3000)); return { ok: true, status: 200, headers: { get: () => null }, text: () => new Promise<string>(resolve => setTimeout(() => resolve('{}'), 2500)) }; });
      const request = fetchReadStatus('', fetcher); const rejected = expect(request).rejects.toMatchObject({ reason: 'timeout' });
      await vi.advanceTimersByTimeAsync(5000); await rejected;
    } finally { vi.useRealTimers(); }
  });
});
