/**
 * ZCC-GUI-EVIDENCE-20261008-A：`/v1/zcc/readstatus` 契约测试（provider-free）。
 *
 * 关键负例（都必须是真实断言，不是"跑过就算"）：
 *  A. status 只认逐字 available/unavailable；ready/valid/OK/AVAILABLE/带空格 → unknown
 *  B. 同层 catalog count/revision 才比对；servable 子集不同大小不算缺陷
 *  D. e1Blocking 与 usageWarnings 分离；权威桶/消费缺项不入 E1
 *  E. driver.status 固定闭集；不透传 statusDetail
 *  F. 未来/NaN/负时间戳、present 非布尔、数组非法、kind 非法 → invalid/null，不静默采纳
 *  G. 缺证据时 sourceKind 必须是 unknown，且带全部具名缺口
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  createApiServer,
  READ_STATUS_PATH,
  API_SERVER_CONFIG_KEYS,
  FIXTURE_TEST_TOKEN
} from '../../packages/api/src/server.js';
import {
  buildReadStatus,
  READ_STATUS_E1_BLOCKING_GAPS,
  READ_STATUS_USAGE_WARNINGS,
  READ_STATUS_DRIVER_KINDS
} from '../../packages/api/src/read-status.js';

const KEY = 'read-status-contract-key';
const LOOPBACK = '127.0.0.1';
const NOW = 1_700_000_100_000;
const READ_AT = 1_700_000_000_000;

/** 默认全合法的证据；每条负例只改一处 */
function evidenceFixture(over = {}) {
  return {
    catalog: {
      schemaVersion: 1,
      documentRevision: 7,
      catalogRevision: 'rev-fixture',
      catalogEntryCount: 18,
      readAt: READ_AT,
      providerRuleCount: 18
    },
    entitlement: {
      present: true,
      updatedAt: READ_AT,
      items: [
        { cacheKey: 'SECRET-account-abc', status: 'available', reason: 'free-text-with-secret' },
        { cacheKey: 'SECRET-account-xyz', status: 'unavailable', reason: null }
      ]
    },
    selection: {
      present: true,
      domainUpdatedAt: READ_AT,
      selections: [{ domain: 'SECRET-domain.example', kind: 'coding-plan' }]
    },
    planCount: 18,
    ...over
  };
}

/** 默认全合法的调用参数 */
/** Deliberately malformed overrides are passed at this test boundary.
 * @param {Record<string, unknown>} over
 * @returns {import('../../packages/api/src/read-status.js').BuildReadStatusOptions}
 */
function opts(over = {}) {
  return {
    driverKind: /** @type {'official-host'} */ ('official-host'),
    driverCatalogCount: 18,
    driverCatalogRevision: 'rev-fixture',
    servableCount: 10,
    driverStatus: /** @type {'ready'} */ ('ready'),
    evidence: evidenceFixture(),
    now: NOW,
    ...over
  };
}

const forbidden = [
  'SECRET-account-abc', 'SECRET-account-xyz', 'SECRET-domain.example',
  'free-text-with-secret', 'cacheKey', 'credentialLocations',
  'providerFamilyDomain', 'sha256', '.json', 'statusDetail'
];

describe('A · status 严格按 mapper 契约逐字匹配', () => {
  it('available / unavailable 精确匹配', () => {
    const p = buildReadStatus(opts());
    expect(p.entitlement?.availableCount).toBe(1);
    expect(p.entitlement?.unavailableCount).toBe(1);
    expect(p.entitlement?.unknownCount).toBe(0);
  });

  it.each(['ready', 'valid', 'ok', 'OK', 'AVAILABLE', ' available', 'available ', 'expired', 'disabled'])(
    '别名/大小写/空格 %j 一律 unknown，绝不当成额度',
    (s) => {
      const p = buildReadStatus(opts({
        evidence: evidenceFixture({
          entitlement: { present: true, updatedAt: READ_AT, items: [{ cacheKey: 'k', status: s, reason: null }] }
        })
      }));
      expect(p.entitlement?.availableCount).toBe(0);
      expect(p.entitlement?.unknownCount).toBe(1);
    }
  );
});

describe('B · 同层比对，servable 子集不算缺陷', () => {
  it('servable(10) != catalog(18) 不产生 mismatch', () => {
    const p = buildReadStatus(opts({ servableCount: 10, driverCatalogCount: 18 }));
    expect(p.e1Blocking).not.toContain('driver_catalog_mismatch');
  });

  it('同层 count 不一致 → mismatch', () => {
    const p = buildReadStatus(opts({ driverCatalogCount: 99 }));
    expect(p.e1Blocking).toContain('driver_catalog_mismatch');
  });

  it('同层 revision 漂移 → mismatch（条数没变也算）', () => {
    const p = buildReadStatus(opts({ driverCatalogRevision: 'rev-other' }));
    expect(p.e1Blocking).toContain('driver_catalog_mismatch');
  });

  it('revision 任一侧 null → 不参与比对，也不判为一致', () => {
    const p = buildReadStatus(opts({ driverCatalogRevision: null }));
    expect(p.e1Blocking).not.toContain('driver_catalog_mismatch');
  });

  it('servable > catalog（违反子集约束）→ mismatch', () => {
    const p = buildReadStatus(opts({ servableCount: 99 }));
    expect(p.e1Blocking).toContain('driver_catalog_mismatch');
  });
});

describe('D · E1 阻断与 E3 提示分离', () => {
  it('权威桶/消费缺项只进 usageWarnings，不进 e1Blocking', () => {
    const p = buildReadStatus(opts());
    expect(p.e1Blocking).not.toContain('authoritative_bucket_unobserved');
    expect(p.e1Blocking).not.toContain('consumption_unobserved');
    expect(p.usageWarnings).toContain('authoritative_bucket_unobserved');
    expect(p.usageWarnings).toContain('consumption_unobserved');
  });

  it('usageWarnings 不等于 E1 硬门：billing_class 映射仍在 e1Blocking', () => {
    const p = buildReadStatus(opts());
    expect(p.e1Blocking).toContain('billing_class_mapping_unproven');
    expect(p.usageWarnings).not.toContain('billing_class_mapping_unproven');
  });

  it('证据齐全仍保留全部恒定资格缺口（不自称够 E1）', () => {
    const p = buildReadStatus(opts());
    for (const g of ['account_unproven', 'entitlement_staleness_unproven', 'selection_unproven']) {
      expect(p.e1Blocking).toContain(g);
    }
    expect(p.gradedByServer).toBe(false);
    expect(p.validityWindowKnown).toBe(false);
  });
});

describe('E · driver 状态闭集', () => {
  it.each(['ready', 'not_attached', 'unavailable'])('%s 透传', (s) => {
    expect(buildReadStatus(opts({ driverStatus: s })).driver.status).toBe(s);
  });

  it('非法状态降级为 not_attached 并记 invalid', () => {
    const p = buildReadStatus(opts({ driverStatus: 'weird-status' }));
    expect(p.driver.status).toBe('not_attached');
    expect(p.e1Blocking).toContain('evidence_field_invalid');
  });

  it('driverKind 必须落在闭集内', () => {
    expect(buildReadStatus(opts({ driverKind: 'evil' })).driver.kind).toBe('none');
  });
});

describe('F · 非法输入必须显式拒绝或 unknown', () => {
  it('now 非法（NaN/Infinity/<=0）→ timestamp_invalid', () => {
    for (const n of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
      const p = buildReadStatus(opts({ now: n }));
      expect(p.e1Blocking).toContain('timestamp_invalid');
    }
  });

  it('未来时间戳一律 invalid（无时钟宽容）', () => {
    const future = NOW + 1;
    const p = buildReadStatus(opts({ evidence: evidenceFixture({ catalog: { schemaVersion: 1, documentRevision: 1, catalogRevision: 'r', catalogEntryCount: 18, readAt: future, providerRuleCount: 18 } }) }));
    expect(p.catalog.readAt).toBeNull();
    expect(p.e1Blocking).toContain('timestamp_invalid');
  });

  it('entitlement.updatedAt 未来 → invalid', () => {
    const p = buildReadStatus(opts({
      evidence: evidenceFixture({ entitlement: { present: true, updatedAt: NOW + 1, items: [{ cacheKey: 'k', status: 'available', reason: null }] } })
    }));
    expect(p.entitlement?.updatedAt).toBeNull();
    expect(p.e1Blocking).toContain('timestamp_invalid');
  });

  it('selection.domainUpdatedAt 未来 → invalid', () => {
    const p = buildReadStatus(opts({
      evidence: evidenceFixture({ selection: { present: true, domainUpdatedAt: NOW + 1, selections: [{ domain: 'd', kind: 'coding-plan' }] } })
    }));
    expect(p.selection?.updatedAt).toBeNull();
    expect(p.e1Blocking).toContain('timestamp_invalid');
  });

  it('present=false 但 items 非空 → invalid', () => {
    const p = buildReadStatus(opts({
      evidence: evidenceFixture({ entitlement: { present: false, updatedAt: READ_AT, items: [{ cacheKey: 'k', status: 'available', reason: null }] } })
    }));
    expect(p.e1Blocking).toContain('evidence_field_invalid');
  });

  it('present=true 但 items 为空 → invalid', () => {
    const p = buildReadStatus(opts({
      evidence: evidenceFixture({ entitlement: { present: true, updatedAt: READ_AT, items: [] } })
    }));
    expect(p.e1Blocking).toContain('evidence_field_invalid');
  });

  it('present 非布尔（字符串）→ invalid 且按 false 处理', () => {
    const p = buildReadStatus(opts({
      evidence: evidenceFixture({ entitlement: { present: 'yes', updatedAt: READ_AT, items: [{ cacheKey: 'k', status: 'available', reason: null }] } })
    }));
    expect(p.entitlement?.present).toBe(false);
    expect(p.e1Blocking).toContain('evidence_field_invalid');
  });

  it('items 非数组 → invalid，不静默当空', () => {
    const p = buildReadStatus(opts({
      evidence: evidenceFixture({ entitlement: { present: true, updatedAt: READ_AT, items: { nope: 1 } } })
    }));
    expect(p.e1Blocking).toContain('evidence_field_invalid');
    expect(p.entitlement?.itemCount).toBe(0);
  });

  it('selection present=false 但有合法 selections → invalid', () => {
    const p = buildReadStatus(opts({
      evidence: evidenceFixture({ selection: { present: false, domainUpdatedAt: READ_AT, selections: [{ domain: 'd', kind: 'k' }] } })
    }));
    expect(p.e1Blocking).toContain('evidence_field_invalid');
  });

  it('selections 里 kind 非法 → 不计入 selectedCount 且记 invalid', () => {
    const p = buildReadStatus(opts({
      evidence: evidenceFixture({ selection: { present: true, domainUpdatedAt: READ_AT, selections: [{ domain: 'd', kind: 'ok' }, { domain: 'd2', kind: '' }, { domain: 'd3' }] } })
    }));
    expect(p.selection?.selectedCount).toBe(1);
    expect(p.e1Blocking).toContain('evidence_field_invalid');
  });

  it('负数/小数 count → null + invalid，绝不透出', () => {
    for (const c of [-1, 1.5]) {
      const p = buildReadStatus(opts({ evidence: evidenceFixture({ catalog: { schemaVersion: 1, documentRevision: 1, catalogRevision: 'r', catalogEntryCount: c, readAt: READ_AT, providerRuleCount: 1 } }) }));
      expect(p.catalog.entryCount).toBeNull();
      expect(p.e1Blocking).toContain('catalog_absent');
    }
  });

  it('catalog 结构错（无对象）不抛 TypeError', () => {
    const p = buildReadStatus(opts({ evidence: { catalog: null, entitlement: null, selection: null, planCount: 0 } }));
    expect(p.e1Blocking).toContain('evidence_field_invalid');
    expect(p.catalog.entryCount).toBeNull();
  });

  it('driverCatalogCount 非法 → null + invalid', () => {
    const p = buildReadStatus(opts({ driverCatalogCount: -3 }));
    expect(p.driver.catalogCount).toBeNull();
    expect(p.e1Blocking).toContain('evidence_field_invalid');
  });
});

describe('G · 缺证据 / 脱敏', () => {
  it('缺证据时 sourceKind 必须是 unknown', () => {
    const p = buildReadStatus(opts({ evidence: null }));
    expect(p.catalog.sourceKind).toBe('unknown');
  });

  it('缺证据时带全部关键具名缺口', () => {
    const p = buildReadStatus(opts({ evidence: null }));
    for (const g of ['evidence_not_captured', 'catalog_absent', 'entitlement_absent', 'selection_absent', 'account_unproven']) {
      expect(p.e1Blocking).toContain(g);
    }
    expect(p.entitlement).toBeNull();
    expect(p.selection).toBeNull();
  });

  it('有证据时 sourceKind 与 driver.kind 是两回事', () => {
    const p = buildReadStatus(opts({ driverKind: 'official-host' }));
    expect(p.catalog.sourceKind).toBe('local-official-files');
    expect(p.driver.kind).toBe('official-host');
  });

  it('投影不含任何路径/sha/bytes/cacheKey/domain/自由 reason', () => {
    const p = buildReadStatus(opts());
    const json = JSON.stringify(p);
    for (const t of forbidden) expect(json).not.toContain(t);
  });

  it('gaps 均在闭集内', () => {
    const p = buildReadStatus(opts());
    for (const g of p.e1Blocking) expect(READ_STATUS_E1_BLOCKING_GAPS).toContain(g);
    for (const w of p.usageWarnings) expect(READ_STATUS_USAGE_WARNINGS).toContain(w);
    for (const k of READ_STATUS_DRIVER_KINDS) expect(READ_STATUS_DRIVER_KINDS).toContain(k);
  });
});

describe('HTTP 契约', () => {
  let base = '';
  /** @type {ReturnType<typeof createApiServer> | null} */
  let server = null;

  beforeAll(async () => {
    server = createApiServer({
      enabled: true,
      host: LOOPBACK,
      port: 0,
      apiKeys: [KEY],
      readStatus: () => ({
        driverKind: 'official-host',
        driverCatalogCount: 18,
        driverCatalogRevision: 'rev-fixture',
        servableCount: 10,
        driverStatus: 'ready',
        evidence: evidenceFixture()
      })
    });
    const started = await server.start();
    base = `http://${LOOPBACK}:${started.port}`;
  });

  afterAll(async () => {
    if (server) await server.stop();
  });

  it('config 闭集登记 readStatus', () => {
    expect(API_SERVER_CONFIG_KEYS).toContain('readStatus');
  });

  it('GET 200 + zcc-read-status + no-store', async () => {
    const res = await fetch(`${base}${READ_STATUS_PATH}`, { headers: { authorization: `Bearer ${KEY}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    /** @type {any} JSON boundary, assertions validate the DTO. */
    const body = await res.json();
    expect(body.schema).toBe('zcc-read-status');
    expect(body.version).toBe(1);
    for (const t of forbidden) expect(JSON.stringify(body)).not.toContain(t);
  });

  it('未认证 401', async () => {
    expect((await fetch(`${base}${READ_STATUS_PATH}`)).status).toBe(401);
  });

  it('非 GET 405', async () => {
    const r = await fetch(`${base}${READ_STATUS_PATH}`, { method: 'POST', headers: { authorization: `Bearer ${KEY}` } });
    expect(r.status).toBe(405);
  });

  it('CORS 永不开启：带 Origin 被拒', async () => {
    const r = await fetch(`${base}${READ_STATUS_PATH}`, { headers: { authorization: `Bearer ${KEY}`, origin: 'http://evil.example' } });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it('缺 readStatus 配置 → 200 + evidence_not_captured（不 500 不伪造）', async () => {
    const bare = createApiServer({ enabled: true, host: LOOPBACK, port: 0, apiKeys: [KEY] });
    const started = await bare.start();
    try {
      const res = await fetch(`http://${LOOPBACK}:${started.port}${READ_STATUS_PATH}`, { headers: { authorization: `Bearer ${KEY}` } });
      expect(res.status).toBe(200);
      /** @type {any} JSON boundary, assertions validate the DTO. */
      const body = await res.json();
      expect(body.e1Blocking).toContain('evidence_not_captured');
      expect(body.catalog.sourceKind).toBe('unknown');
    } finally {
      await bare.stop();
    }
  });

  it('GET 不重读源：连续两次 GET 结果一致（readAt 不刷新）', async () => {
    /** @type {any} */
    const a = await (await fetch(`${base}${READ_STATUS_PATH}`, { headers: { authorization: `Bearer ${KEY}` } })).json();
    /** @type {any} */
    const b = await (await fetch(`${base}${READ_STATUS_PATH}`, { headers: { authorization: `Bearer ${KEY}` } })).json();
    expect(b.catalog.readAt).toBe(a.catalog.readAt);
    expect(b.catalog.revision).toBe(a.catalog.revision);
  });

  it('fixture 后门仍需 token', () => {
    expect(FIXTURE_TEST_TOKEN).toBeTypeOf('symbol');
    expect(() => createApiServer({ enabled: true, host: LOOPBACK, port: 0, apiKeys: [KEY], .../** @type {Record<string, unknown>} */ ({ fixture: true }) })).toThrow();
  });
});