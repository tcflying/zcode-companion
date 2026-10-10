/**
 * UI02 单元测试：来源模式切换语义、刷新结果与失败呈现、写死条目的不可发送性。
 *
 * 既有分组为纯函数 / 本地状态测试；ZC-51 追加真实页面回调和 SSR 接线验证。
 * 全部零网络、零磁盘，不代替真实 mounted React 或 GUI 验收。
 * 不使用恒真断言、不 skip。
 *
 * 本轮（UI02-F1）新增覆盖：
 * 1. 六种刷新失败原因**逐一**在单一来源映射里有非空文案 + 未知原因码走兜底；
 * 2. `GET /v1/zcc/catalog` 扩展契约的六种离线 fixture 场景：
 *    正常 / revision 变化 / 条目增删 diff / 非法 billingClass / 缺字段 / 非对象 payload；
 * 3. 刷新失败保留**非空**旧列表（REV3-UI02-I1 缺口）。
 *
 * 本轮（UI02-F3 Minor 清理）新增覆盖：
 * 4. C1(b)「默认路径零网络」的自动化回归钉（REV5-UI02-M3）：
 *    执行器选择的对象同一性 + 全局网络原语探针 + 产品源码全量静态扫描。
 */

import { describe, expect, it } from 'vitest';
import { BILLING_CLASSES, CURRENT_EVIDENCE, SEND_DISABLED_LABEL } from './snapshot';
import {
  addManualEntry,
  beginRefresh,
  buildManualEntry,
  CATALOG_FIXTURE_V1,
  CATALOG_FIXTURE_V2,
  channelAccepted,
  completeRefresh,
  createFixtureSourceLoader,
  createInitialSourceState,
  describeDelta,
  describeRefreshFailure,
  EMPTY_MANUAL_DRAFT,
  filterEntries,
  FIXTURE_SCENARIOS,
  formatDefects,
  isFixtureScenario,
  isRefreshFailureReason,
  listDelta,
  MANUAL_ENTRY_BADGE,
  offlineSourceLoader,
  parseCatalogPayload,
  REFRESH_FAILURE_INFO,
  REFRESH_FAILURE_REASONS,
  resolveSourceLoader,
  runRefresh,
  sendEligibilityFor,
  SOURCE_ENDPOINT,
  switchMode,
  UNKNOWN_FAILURE_INFO,
  UNVERIFIED_LABEL,
  validateManualDraft,
  type ManualDraft,
  type ModelSourceState,
  type SourceLoader,
  SourceUnavailableError
} from './modelSource';

const DRAFT: ManualDraft = {
  displayName: '本机自建通道',
  provider: 'local',
  modelId: 'local-model-a',
  billingClass: 'subscription',
  contextLength: '128000',
  reasoning: 'high, low',
  capabilities: '工具调用, 长上下文',
  note: ''
};

function withManualEntry(overrides: Partial<ManualDraft> = {}): ModelSourceState {
  const manual = switchMode(createInitialSourceState(), 'manual').state;
  return addManualEntry(manual, { ...DRAFT, ...overrides }).state;
}

function fixtureLoader(payload: unknown): SourceLoader {
  return () => Promise.resolve(payload);
}

/* ================================================================== *
 * 1. 六种失败原因：逐一映射 + 未知码兜底（REV3-UI02-I2）
 * ================================================================== */

describe('失败原因单一来源：六种原因逐一有人读文案与处理建议', () => {
  it('失败原因枚举恰好是裁定清单里的六种，且没有多余项', () => {
    expect(REFRESH_FAILURE_REASONS).toEqual([
      'api_not_running',
      'connection_failed',
      'timeout',
      'transport_not_wired',
      'malformed_payload',
      'empty_source'
    ]);
    for (const r of REFRESH_FAILURE_REASONS) {
      expect(isRefreshFailureReason(r)).toBe(true);
      expect(Object.keys(REFRESH_FAILURE_INFO).sort()).toEqual([...REFRESH_FAILURE_REASONS].sort());
    }
  });

  const perReason: Array<[string, RegExp, RegExp]> = [
    ['api_not_running', /API/, /启动|监听|进程/],
    ['connection_failed', /连接|端口|拒绝/, /连接|端口|监听/],
    ['timeout', /超时|无响应/, /超时|响应/],
    ['transport_not_wired', /未接线|尚未/, /接线|读取/],
    ['malformed_payload', /契约|不符合/, /契约|字段/],
    ['empty_source', /0 个|空/, /空|0 个/]
  ];

  for (const [reason, titleRe, remedyRe] of perReason) {
    it(`原因 ${reason}：映射存在、标题/人读说明/处理建议均非空`, () => {
      const info = REFRESH_FAILURE_INFO[reason as keyof typeof REFRESH_FAILURE_INFO];
      expect(info).toBeDefined();
      expect(info.title.trim().length).toBeGreaterThan(0);
      expect(info.human.trim().length).toBeGreaterThan(0);
      expect(info.remedy.trim().length).toBeGreaterThan(0);
      // 六种原因都必须保留刷新前读到的列表（这是硬保证，不是文案承诺）
      expect(info.keepsPreviousList).toBe(true);
      expect(titleRe.test(info.title + info.human)).toBe(true);
      expect(remedyRe.test(info.remedy)).toBe(true);
    });
  }

  it('六种原因都能被 describeRefreshFailure 解析成 known=true 的视图', () => {
    for (const r of REFRESH_FAILURE_REASONS) {
      const v = describeRefreshFailure(r);
      expect(v.code).toBe(r);
      expect(v.known).toBe(true);
      expect(v.info).toBe(REFRESH_FAILURE_INFO[r]);
    }
  });

  it('未知原因码走通用兜底：不是空白、不是吞掉，仍然保留旧列表', () => {
    const v = describeRefreshFailure('teapot_418_i_am_teapot');
    expect(v.known).toBe(false);
    expect(v.code).toBe('teapot_418_i_am_teapot');
    expect(v.info.title).toBe(UNKNOWN_FAILURE_INFO.title);
    expect(v.info.human.trim().length).toBeGreaterThan(0);
    expect(v.info.remedy.trim().length).toBeGreaterThan(0);
    expect(v.info.keepsPreviousList).toBe(true);
    // 兜底文案里必须带上原始原因码，界面上不能只显示"未知"两个字
    expect(v.info.human).toContain('teapot_418_i_am_teapot');
  });

  it('未知原因码为空串时同样兜底，不抛错也不返回空白', () => {
    const v = describeRefreshFailure('');
    expect(v.known).toBe(false);
    expect(v.info.title.trim().length).toBeGreaterThan(0);
  });

  it('SourceUnavailableError 带任意未知码时，失败态仍能显示兜底而不是空白面板', async () => {
    const s = createInitialSourceState().refresh;
    const r = await runRefresh(
      s,
      () =>
        Promise.reject(
          new SourceUnavailableError(
            'not_in_the_table' as never,
            '执行器抛出了本版本未登记的原因码。',
            '按未知处理。'
          )
        ),
      () => 7
    );
    expect(r.status).toBe('failed');
    expect(r.failure?.reason).toBe('not_in_the_table');
    const v = describeRefreshFailure(r.failure!.reason);
    expect(v.known).toBe(false);
    expect(v.info.title).toBe(UNKNOWN_FAILURE_INFO.title);
    expect(v.info.human.length).toBeGreaterThan(0);
  });

  it('每种失败原因都能让状态机进入 failed 且保留旧列表（6/6 全路径）', async () => {
    const seed = await runRefresh(
      createInitialSourceState().refresh,
      fixtureLoader(CATALOG_FIXTURE_V1),
      () => 1
    );
    expect(seed.entries.length).toBeGreaterThanOrEqual(2);
    const seeds: Array<[string, SourceLoader, (s: typeof seed) => typeof seed | Promise<typeof seed>]> = [
      ['api_not_running', () => Promise.reject(new SourceUnavailableError('api_not_running', '本机 API 进程不在运行。', '启动本机 API。')), (s) => s],
      ['connection_failed', () => Promise.reject(new Error('ECONNREFUSED 127.0.0.1:4318')), (s) => s],
      ['timeout', () => Promise.reject(new SourceUnavailableError('timeout', '读取超时 3000ms。', '稍后重试。')), (s) => s],
      ['transport_not_wired', offlineSourceLoader, (s) => s],
      ['malformed_payload', fixtureLoader({ hello: 'world' }), (s) => s],
      ['empty_source', fixtureLoader({ revision: 'r-empty', models: [] }), (s) => s]
    ];
    const seen: string[] = [];
    for (const [reason, loader] of seeds) {
      const r = await runRefresh(seed, loader, () => 2);
      expect(r.status).toBe('failed');
      expect(r.failure?.reason).toBe(reason);
      // 六种原因下旧列表都还在，且没有假数据混入
      expect(r.entries).toHaveLength(seed.entries.length);
      expect(r.entries.map((e) => e.modelId)).toEqual(seed.entries.map((e) => e.modelId));
      expect(r.failure?.detail.trim().length).toBeGreaterThan(0);
      const v = describeRefreshFailure(r.failure!.reason);
      expect(v.info.remedy.trim().length).toBeGreaterThan(0);
      seen.push(reason);
    }
    expect(seen).toEqual([...REFRESH_FAILURE_REASONS]);
  });
});

/* ================================================================== *
 * 2. GET /v1/zcc/catalog 扩展契约：六种离线 fixture 场景
 * ================================================================== */

describe('/v1/zcc/catalog 契约解析：六种离线 fixture 场景', () => {
  it('场景 1 正常：条目按契约逐字段投影，恒为未验证且不可发送', () => {
    const p = parseCatalogPayload(CATALOG_FIXTURE_V1);
    expect(p.defects).toEqual([]);
    expect(p.ok).toBe(true);
    expect(p.revision).toBe('fixture-rev-1');
    expect(p.entries).toHaveLength(2);
    const a = p.entries[0]!;
    expect(a.modelId).toBe('fixture-model-a');
    expect(a.displayName).toBe('目录条目甲');
    expect(a.provider).toBe('fixture-provider');
    expect(a.billingClass).toBe('subscription');
    expect(a.contextLength).toBe(200000);
    expect(a.reasoning).toEqual(['high']);
    expect(a.capabilities).toEqual(['工具调用']);
    expect(a.key).toBe('source:fixture-model-a');
    expect(a.origin).toBe('source');
    expect(a.availability).toBe('unverified');
    expect(a.sendEligible).toBe(false);
    expect(sendEligibilityFor(a).eligible).toBe(false);
    const b = p.entries[1]!;
    expect(b.billingClass).toBe('metered_api');
    expect(b.contextLength).toBeNull();
    expect(b.reasoning).toEqual([]);
  });

  it('场景 2 revision 变化：读到的 revision 更新，列表变化按 diff 呈现', async () => {
    const s0 = createInitialSourceState().refresh;
    const r1 = await runRefresh(s0, fixtureLoader(CATALOG_FIXTURE_V1), () => 100);
    expect(r1.status).toBe('ok');
    expect(r1.revision).toBe('fixture-rev-1');
    expect(r1.entries).toHaveLength(2);
    expect(r1.delta?.previous).toBeNull();
    expect(describeDelta(r1.delta!)).toContain('首次读回');

    const r2 = await runRefresh(r1, fixtureLoader(CATALOG_FIXTURE_V2), () => 200);
    expect(r2.status).toBe('ok');
    expect(r2.revision).toBe('fixture-rev-2');
    expect(r2.entries).toHaveLength(3);
    const d = listDelta(r1.entries, r2.entries);
    expect(d.added).toEqual(['fixture-model-c']);
    expect(d.removed).toEqual([]);
    expect(d.kept).toBe(2);
    expect(d.previous).toBe(2);
    expect(d.current).toBe(3);
    expect(describeDelta(d)).toContain('新增 1');
  });

  it('场景 3 条目增删：消失的 modelId 能被 diff 反映出来', () => {
    const v2 = parseCatalogPayload(CATALOG_FIXTURE_V2);
    const v1 = parseCatalogPayload(CATALOG_FIXTURE_V1);
    expect(v2.ok).toBe(true);
    expect(v1.ok).toBe(true);
    const d = listDelta(v2.entries, v1.entries);
    expect(d.removed).toEqual(['fixture-model-c']);
    expect(d.added).toEqual([]);
    expect(describeDelta(d)).toContain('消失 1');
    // 同时增删时两侧都报出来
    const both = listDelta(v1.entries, v2.entries);
    expect(both.added).toEqual(['fixture-model-c']);
    expect(both.kept).toBe(2);
  });

  it('场景 4 非法 billingClass：整体拒绝，一条都不部分采纳', () => {
    const p = parseCatalogPayload({
      revision: 'fixture-rev-bad-billing',
      models: [
        { modelId: 'ok-1', displayName: '合法条目', provider: 'p', billingClass: 'promotion', contextLength: 1000, reasoning: [], capabilities: [] },
        { modelId: 'bad-1', displayName: '非法类别条目', provider: 'p', billingClass: 'freemium', contextLength: 1000, reasoning: [], capabilities: [] }
      ]
    });
    expect(p.ok).toBe(false);
    expect(p.entries).toEqual([]);
    expect(p.defects).toHaveLength(1);
    expect(p.defects[0]?.code).toBe('enum_invalid');
    expect(p.defects[0]?.path).toBe('$.models[1].billingClass');
    expect(p.defects[0]?.message).toContain('freemium');
    // 非法枚举不得被偷偷降级成 unknown 后采纳
    expect(formatDefects(p.defects)).toContain('enum_invalid');
  });

  it('场景 5 缺字段：缺必填字段整体拒绝，并逐条列出位置', () => {
    const p = parseCatalogPayload({
      revision: 'fixture-rev-missing',
      models: [
        { displayName: '没有 modelId', provider: 'p', billingClass: 'subscription', contextLength: 1000, reasoning: [], capabilities: [] },
        { modelId: 'm2', displayName: '没有 capabilities', provider: 'p', billingClass: 'subscription', contextLength: 1000, reasoning: [] },
        { modelId: 'm3', displayName: '上下文长度类型错', provider: 'p', billingClass: 'subscription', contextLength: '200000', reasoning: [], capabilities: [] }
      ]
    });
    expect(p.ok).toBe(false);
    expect(p.entries).toEqual([]);
    const codes = p.defects.map((d) => d.code);
    expect(codes).toContain('field_missing');
    expect(codes).toContain('field_type');
    const paths = p.defects.map((d) => d.path);
    expect(paths).toContain('$.models[0].modelId');
    expect(paths).toContain('$.models[1].capabilities');
    expect(paths).toContain('$.models[2].contextLength');
    expect(formatDefects(p.defects).length).toBeGreaterThan(0);
  });

  it('场景 6 非对象 payload：字符串 / 数组 / null / 缺 models 一律整体拒绝', () => {
    for (const bad of ['nope', 42, null, [1, 2, 3]]) {
      const p = parseCatalogPayload(bad);
      expect(p.ok).toBe(false);
      expect(p.entries).toEqual([]);
      expect(p.defects[0]?.code).toBe('payload_not_object');
    }
    const noModels = parseCatalogPayload({ revision: 'r' });
    expect(noModels.ok).toBe(false);
    expect(noModels.defects.some((d) => d.code === 'models_missing')).toBe(true);
    const badModels = parseCatalogPayload({ revision: 'r', models: { a: 1 } });
    expect(badModels.ok).toBe(false);
    expect(badModels.defects.some((d) => d.code === 'models_type')).toBe(true);
  });

  it('外部 IDE 用的标准 /v1/models 形状不是本来源的数据源，被显式拒绝', () => {
    const foreign = {
      object: 'list',
      data: [
        { id: 'glm-5.3', object: 'model', created: 1, owned_by: 'some-vendor', displayName: 'x', provider: 'p', billingClass: 'subscription', contextLength: 1, reasoning: [], capabilities: [] }
      ]
    };
    const p = parseCatalogPayload(foreign);
    expect(p.ok).toBe(false);
    expect(p.entries).toEqual([]);
    expect(p.defects[0]?.code).toBe('payload_foreign_shape');
    expect(p.defects[0]?.message).toContain('/v1/models');
  });

  it('解析失败整体进错误面板：失败原因固定为 malformed_payload，并逐条列出缺陷', async () => {
    const s = await runRefresh(
      createInitialSourceState().refresh,
      fixtureLoader({ revision: 'r', models: [{ modelId: 'a', billingClass: 'freemium' }] }),
      () => 9
    );
    expect(s.status).toBe('failed');
    expect(s.failure?.reason).toBe('malformed_payload');
    expect(s.failure?.defects?.length).toBeGreaterThan(0);
    expect(s.failure?.detail).toContain('enum_invalid');
    expect(describeRefreshFailure(s.failure!.reason).known).toBe(true);
  });

  it('空 models 数组解析层放行，由刷新层判为 empty_source 失败', async () => {
    const p = parseCatalogPayload({ revision: 'r-empty', models: [] });
    expect(p.ok).toBe(true);
    expect(p.entries).toEqual([]);
    const s = await runRefresh(createInitialSourceState().refresh, fixtureLoader({ revision: 'r-empty', models: [] }), () => 3);
    expect(s.status).toBe('failed');
    expect(s.failure?.reason).toBe('empty_source');
  });

  it('契约要求的字段一个都不能被默认值补齐：reasoning / capabilities / contextLength 缺失即拒', () => {
    const p = parseCatalogPayload({
      revision: 'r',
      models: [{ modelId: 'm', displayName: 'd', provider: 'p', billingClass: 'unknown' }]
    });
    expect(p.ok).toBe(false);
    const fields = p.defects.map((d) => d.path);
    expect(fields).toContain('$.models[0].contextLength');
    expect(fields).toContain('$.models[0].reasoning');
    expect(fields).toContain('$.models[0].capabilities');
  });

  it('重复 modelId 整体拒绝（不静默去重、不部分采纳）', () => {
    const p = parseCatalogPayload({
      revision: 'r',
      models: [
        { modelId: 'dup', displayName: '一', provider: 'p', billingClass: 'unknown', contextLength: null, reasoning: [], capabilities: [] },
        { modelId: 'dup', displayName: '二', provider: 'p', billingClass: 'unknown', contextLength: null, reasoning: [], capabilities: [] }
      ]
    });
    expect(p.ok).toBe(false);
    expect(p.defects.some((d) => d.code === 'duplicate_model_id')).toBe(true);
  });

  it('四个合法计费类别全部接受，非法值一律拒', () => {
    for (const cls of BILLING_CLASSES) {
      const p = parseCatalogPayload({
        revision: 'r',
        models: [{ modelId: 'm', displayName: 'd', provider: 'p', billingClass: cls, contextLength: null, reasoning: [], capabilities: [] }]
      });
      expect(p.ok).toBe(true);
      expect(p.entries[0]?.billingClass).toBe(cls);
    }
  });
});

/* ================================================================== *
 * 3. 刷新失败保留非空旧列表（REV3-UI02-I1 缺口）
 * ================================================================== */

describe('刷新失败保留非空旧列表', () => {
  it('先读回 2 条再失败：旧列表 2 条原样保留，错误面板叠加呈现', async () => {
    const seed = await runRefresh(
      createInitialSourceState().refresh,
      fixtureLoader(CATALOG_FIXTURE_V1),
      () => 1000
    );
    expect(seed.entries).toHaveLength(2);
    const failed = await runRefresh(seed, offlineSourceLoader, () => 3000);
    expect(failed.status).toBe('failed');
    expect(failed.failure?.reason).toBe('transport_not_wired');
    expect(failed.entries).toHaveLength(2);
    expect(failed.entries.map((e) => e.modelId)).toEqual(['fixture-model-a', 'fixture-model-b']);
    expect(failed.previousEntryCount).toBe(2);
    expect(failed.lastSuccessAt).toBe(1000);
    expect(failed.lastAttemptAt).toBe(3000);
    // 错误面板里"当前列表"这一行要能被界面直接取到非 0 的保留条数
    expect(describeRefreshFailure(failed.failure!.reason).info.keepsPreviousList).toBe(true);
  });

  it('先读回 2 条再失败：连接类失败同样保留 2 条，且 detail 带真实错误文本', async () => {
    const seed = await runRefresh(createInitialSourceState().refresh, fixtureLoader(CATALOG_FIXTURE_V1), () => 10);
    const failed = await runRefresh(seed, () => Promise.reject(new Error('ECONNREFUSED 127.0.0.1:4318')), () => 20);
    expect(failed.failure?.reason).toBe('connection_failed');
    expect(failed.failure?.detail).toContain('ECONNREFUSED');
    expect(failed.entries).toHaveLength(2);
  });

  it('失败不会把旧列表换成占位行或任何假数据：sendEligible 仍恒为 false', async () => {
    const seed = await runRefresh(createInitialSourceState().refresh, fixtureLoader(CATALOG_FIXTURE_V1), () => 1);
    const failed = await runRefresh(seed, offlineSourceLoader, () => 2);
    for (const e of failed.entries) {
      expect(e.sendEligible).toBe(false);
      expect(e.availability).toBe('unverified');
      expect(sendEligibilityFor(e).eligible).toBe(false);
    }
  });
});

/* ================================================================== *
 * 4. 截图取证用的 fixture 执行器（测试态，界面必须显式标注）
 * ================================================================== */

describe('fixture 执行器：只用于离线测试与截图取证', () => {
  it('场景表覆盖刷新失败要拍的两种形态', () => {
    expect(Object.keys(FIXTURE_SCENARIOS)).toEqual(
      expect.arrayContaining(['catalog2_then_conn_fail', 'catalog2_then_malformed'])
    );
  });

  it('catalog2_then_conn_fail：第一次刷新读回 2 条，第二次失败且保留 2 条', async () => {
    const loader = createFixtureSourceLoader('catalog2_then_conn_fail');
    const s0 = createInitialSourceState().refresh;
    const ok = await runRefresh(s0, loader, () => 100);
    expect(ok.status).toBe('ok');
    expect(ok.entries).toHaveLength(2);
    const bad = await runRefresh(ok, loader, () => 200);
    expect(bad.status).toBe('failed');
    expect(bad.failure?.reason).toBe('connection_failed');
    expect(bad.entries).toHaveLength(2);
  });

  it('catalog2_then_malformed：第二次刷新因契约违规被整体拒绝，旧列表保留', async () => {
    const loader = createFixtureSourceLoader('catalog2_then_malformed');
    const s0 = createInitialSourceState().refresh;
    const ok = await runRefresh(s0, loader, () => 1);
    expect(ok.entries).toHaveLength(2);
    const bad = await runRefresh(ok, loader, () => 2);
    expect(bad.status).toBe('failed');
    expect(bad.failure?.reason).toBe('malformed_payload');
    expect(bad.failure?.defects?.length).toBeGreaterThan(0);
    expect(bad.entries).toHaveLength(2);
  });

  it('未知场景名不被当成成功：直接按未接线失败，不返回任何目录', async () => {
    const r = await runRefresh(createInitialSourceState().refresh, createFixtureSourceLoader('nope'), () => 1);
    expect(r.status).toBe('failed');
    expect(r.entries).toEqual([]);
  });
});

/* ================================================================== *
 * 5. 写死固定模式：录入与标记（红线下仍成立）
 * ================================================================== */

describe('写死固定模式：录入与标记', () => {
  it('录入合法草稿后条目被标记为未验证、不可发送，并带手工录入标记', () => {
    const r = addManualEntry(createInitialSourceState(), DRAFT);
    expect(r.errors).toEqual([]);
    expect(r.entry).not.toBeNull();
    const e = r.entry!;
    expect(e.origin).toBe('manual');
    expect(e.availability).toBe('unverified');
    expect(e.sendEligible).toBe(false);
    expect(e.note).toBe(MANUAL_ENTRY_BADGE);
    expect(e.contextLength).toBe(128000);
    expect(e.capabilities).toEqual(['工具调用', '长上下文']);
    expect(e.reasoning).toEqual(['high', 'low']);
    expect(r.state.manualEntries).toHaveLength(1);
  });

  it('显示名或 modelId 为空时拒绝录入，并给出逐条错误', () => {
    const v = validateManualDraft({ ...DRAFT, displayName: '  ', modelId: '' });
    expect(v.ok).toBe(false);
    expect(v.errors).toContain('显示名不能为空');
    expect(v.errors).toContain('modelId 不能为空');
    const r = addManualEntry(createInitialSourceState(), { ...DRAFT, displayName: '', modelId: '' });
    expect(r.entry).toBeNull();
    expect(r.state.manualEntries).toHaveLength(0);
  });

  it('上下文长度必须为正整数：非整数被拒，留空表示来源未提供', () => {
    expect(validateManualDraft({ ...DRAFT, contextLength: '12.5' }).ok).toBe(false);
    expect(validateManualDraft({ ...DRAFT, contextLength: '-1' }).ok).toBe(false);
    expect(validateManualDraft({ ...DRAFT, contextLength: '' }).ok).toBe(true);
    const e = buildManualEntry({ ...EMPTY_MANUAL_DRAFT, displayName: 'x', modelId: 'y' });
    expect(e.contextLength).toBeNull();
    expect(e.reasoning).toEqual([]);
    expect(e.capabilities).toEqual([]);
    expect(e.provider).toBe('unknown');
    expect(e.billingClass).toBe('unknown');
  });

  it('写死条目即使计费类别为合法订阅通道也永远不获得可发送资格', () => {
    for (const cls of ['subscription', 'promotion', 'metered_api', 'unknown'] as const) {
      const e = buildManualEntry({ ...DRAFT, billingClass: cls });
      const gate = sendEligibilityFor(e);
      expect(gate.eligible).toBe(false);
      expect(gate.label).toBe(SEND_DISABLED_LABEL);
      expect(gate.label).toContain(CURRENT_EVIDENCE);
      expect(gate.reason).toContain(UNVERIFIED_LABEL);
      expect(e.sendEligible).toBe(false);
    }
    expect(channelAccepted('subscription')).toBe(true);
    expect(channelAccepted('promotion')).toBe(true);
    expect(channelAccepted('metered_api')).toBe(false);
    expect(channelAccepted('unknown')).toBe(false);
  });
});

/* ================================================================== *
 * 6. 动态刷新模式：状态机与筛选
 * ================================================================== */

describe('动态刷新模式：来源列表变化能反映', () => {
  it('首次刷新读回条目，再次刷新能反映新增', async () => {
    const s0 = createInitialSourceState();
    const s1 = await runRefresh(s0.refresh, fixtureLoader(CATALOG_FIXTURE_V1), () => 1000);
    expect(s1.status).toBe('ok');
    expect(s1.entries).toHaveLength(2);
    expect(s1.revision).toBe('fixture-rev-1');
    expect(s1.previousEntryCount).toBe(0);
    expect(s1.lastSuccessAt).toBe(1000);
    expect(s1.attemptCount).toBe(1);

    const s2 = await runRefresh(s1, fixtureLoader(CATALOG_FIXTURE_V2), () => 2000);
    expect(s2.status).toBe('ok');
    expect(s2.entries).toHaveLength(3);
    expect(s2.revision).toBe('fixture-rev-2');
    expect(s2.previousEntryCount).toBe(2);
    const delta2 = listDelta(s1.entries, s2.entries);
    expect(delta2.added).toEqual(['fixture-model-c']);
    expect(delta2.removed).toEqual([]);
    expect(delta2.kept).toBe(2);
    expect(describeDelta(delta2)).toContain('新增 1');
  });

  it('搜索与计费类别筛选在来源条目上生效', () => {
    const p = parseCatalogPayload(CATALOG_FIXTURE_V2);
    expect(filterEntries(p.entries, '', 'all')).toHaveLength(3);
    expect(filterEntries(p.entries, '条目乙', 'all').map((e) => e.modelId)).toEqual(['fixture-model-b']);
    expect(filterEntries(p.entries, 'fixture-model', 'promotion').map((e) => e.modelId)).toEqual([
      'fixture-model-c'
    ]);
    expect(filterEntries(p.entries, '不存在的名字', 'all')).toHaveLength(0);
  });

  it('beginRefresh 进入 loading 并清掉上一次的失败，失败时不伪造成功时间', () => {
    const s0 = createInitialSourceState().refresh;
    const failed = completeRefresh(beginRefresh(s0, 'local_api', 100), parseCatalogPayload({ hello: 'world' }), 150);
    expect(failed.status).toBe('failed');
    expect(failed.failure?.reason).toBe('malformed_payload');
    expect(failed.lastSuccessAt).toBeNull();
    const loading = beginRefresh(failed, 'local_config_file', 200);
    expect(loading.status).toBe('loading');
    expect(loading.failure).toBeNull();
    expect(loading.transport).toBe('local_config_file');
    expect(loading.attemptCount).toBe(2);
  });
});

describe('模式切换：不静默清空已输入内容', () => {
  it('写死 → 动态 → 写死：手工录入内容往返保留，并在提示中说明', () => {
    const s1 = withManualEntry();
    expect(s1.manualEntries).toHaveLength(1);

    const toDynamic = switchMode(s1, 'dynamic');
    expect(toDynamic.state.mode).toBe('dynamic');
    expect(toDynamic.state.manualEntries).toHaveLength(1);
    expect(toDynamic.preserved).toBe(true);
    expect(toDynamic.notice).toContain('已手工录入的 1 个条目');
    expect(toDynamic.notice).toContain('未清空任何内容');

    const back = switchMode(toDynamic.state, 'manual');
    expect(back.state.manualEntries).toHaveLength(1);
    expect(back.state.mode).toBe('manual');
    expect(back.state.manualEntries[0]?.modelId).toBe('local-model-a');
  });

  it('动态来源上次读到的条目在切换后仍保留', async () => {
    const s0 = createInitialSourceState();
    const read = await runRefresh(s0.refresh, fixtureLoader(CATALOG_FIXTURE_V1), () => 1);
    const withRead: ModelSourceState = { mode: 'dynamic', refresh: read, manualEntries: [] };
    const toManual = switchMode(withRead, 'manual');
    expect(toManual.state.refresh.entries).toHaveLength(2);
    expect(toManual.notice).toContain('动态来源上次读到的 2 个条目');
    const back = switchMode(toManual.state, 'dynamic');
    expect(back.state.refresh.entries).toHaveLength(2);
  });

  it('两种模式都为空时，提示明确说"没有内容被清空"', () => {
    const r = switchMode(createInitialSourceState(), 'manual');
    expect(r.preserved).toBe(false);
    expect(r.notice).toContain('不会清空任何已输入内容');
  });

  it('重复点同一模式不改变状态', () => {
    const s = withManualEntry();
    const r = switchMode(s, 'manual');
    expect(r.state.mode).toBe('manual');
    expect(r.notice).toContain('未发生切换');
    expect(r.state.manualEntries).toHaveLength(1);
  });

  it('切换不会解锁任何写死条目的发送资格', () => {
    const s1 = withManualEntry();
    const s2 = switchMode(s1, 'manual').state;
    const s3 = switchMode(s2, 'dynamic').state;
    const s4 = switchMode(s3, 'manual').state;
    for (const e of s4.manualEntries) {
      expect(sendEligibilityFor(e).eligible).toBe(false);
    }
  });
});

/* ================================================================== *
 * 8. C1(b) 默认路径零网络：自动化回归钉（REV5-UI02-M3）
 *
 * 缺口背景：此前「默认执行器就是 offlineSourceLoader」只有读代码的结论，
 * 没有任何用例钉住 —— 将来把默认值改掉、或往离线执行器里塞一个 fetch，
 * 测试套件都不会变红。本组把该结论钉成回归门：
 *   a) 执行器选择的**对象同一性**（不是"看起来像"）；
 *   b) 全局网络原语探针 + 走一遍默认刷新，零次命中；
 *   c) 模块级静态扫描：apps/ui/src 的产品代码里不存在任何网络调用原语。
 * ================================================================== */

declare global {
  interface ImportMeta {
    /** Vite 的编译期 glob；apps/ui 有意不引 vite/client，这里局部补最小声明。 */
    glob?: (
      patterns: string | string[],
      options?: { eager?: boolean; query?: string; import?: string }
    ) => Record<string, string>;
  }
}

/** 产品源码原语扫描用：只取非测试、非 .d.ts 的 .ts/.tsx 文本。 */
const PRODUCT_SOURCE_FILES = import.meta.glob!(['../**/*.ts', '../**/*.tsx'], {
  eager: true,
  query: '?raw',
  import: 'default'
});

/** 产品代码里出现即视为网络原语的形态（只匹配调用/构造，不匹配文案里的 "fetch/XHR"）。 */
const NETWORK_PRIMITIVE_PATTERNS: Array<[string, RegExp]> = [
  ['fetch 调用', /\bfetch\s*\(/],
  ['XMLHttpRequest 构造/调用', /\b(?:new\s+)?XMLHttpRequest\s*\(/],
  ['WebSocket 构造', /\bnew\s+WebSocket\b/],
  ['EventSource 构造', /\bnew\s+EventSource\b/],
  ['sendBeacon 调用', /\.sendBeacon\s*\(/],
  ['importScripts 调用', /\bimportScripts\s*\(/],
  ['axios 引用', /\baxios\b/],
  ['node-fetch 引用', /\bnode-fetch\b/],
  ['undici 引用', /\bundici\b/]
];

/** UI04 起，全产品**唯一**允许含网络原语的文件（本机 API 回环通道）。 */
const LOOPBACK_CHANNEL_FILE = 'localApiSource.ts';

function productSourceEntries(): Array<[string, string]> {
  return Object.entries(PRODUCT_SOURCE_FILES)
    .filter(([path]) => !/\.test\.ts$/.test(path) && !/\.d\.ts$/.test(path))
    .map(([path, text]) => [path, text] as [string, string]);
}

/** 在全局对象上装网络原语探针：任何调用/构造都会被记进 calls，绝不真的发出去。 */
function installNetworkProbe(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const scope = globalThis as unknown as Record<string, unknown>;
  const undos: Array<() => void> = [];
  const hit = (detail: string) => {
    calls.push(detail);
  };

  const replace = (key: string, value: unknown) => {
    const had = Object.prototype.hasOwnProperty.call(scope, key);
    const prev = scope[key];
    scope[key] = value;
    undos.push(() => {
      if (had) scope[key] = prev;
      else Reflect.deleteProperty(scope, key);
    });
  };

  replace('fetch', (...args: unknown[]) => {
    hit(`fetch(${String(args[0])})`);
    return Promise.resolve(undefined);
  });
  replace(
    'XMLHttpRequest',
    class {
      constructor() {
        hit('new XMLHttpRequest()');
      }
    }
  );
  replace(
    'WebSocket',
    class {
      constructor(url: string) {
        hit(`new WebSocket(${url})`);
      }
    }
  );
  replace(
    'EventSource',
    class {
      constructor(url: string) {
        hit(`new EventSource(${url})`);
      }
    }
  );

  const nav = scope['navigator'] as { sendBeacon?: (url: string, data?: unknown) => boolean } | undefined;
  if (nav && typeof nav.sendBeacon === 'function') {
    const prev = nav.sendBeacon;
    nav.sendBeacon = (url: string) => {
      hit(`navigator.sendBeacon(${url})`);
      return false;
    };
    undos.push(() => {
      nav.sendBeacon = prev;
    });
  }

  return {
    calls,
    restore() {
      for (const undo of undos.reverse()) undo();
      undos.length = 0;
      calls.length = 0;
    }
  };
}

describe('C1(b) 默认路径零网络：执行器选择与网络原语回归钉', () => {
  it('不带 ?sourceFixture= 时选中的执行器就是 offlineSourceLoader 本身（对象同一性）', () => {
    expect(resolveSourceLoader(null)).toBe(offlineSourceLoader);
  });

  it('空串、undefined 与任何未登记场景名都回落到 offlineSourceLoader（不会误开 fixture）', () => {
    const rejected = [
      '',
      undefined,
      'nope',
      'FIXTURE',
      'catalog2_then_conn_fail ',
      ' catalog2_then_conn_fail',
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty'
    ];
    for (const bad of rejected) {
      expect(resolveSourceLoader(bad)).toBe(offlineSourceLoader);
    }
    // 前提：这批非法值确实都不是已登记场景（否则本用例会因前提错误而误判为红）。
    for (const bad of rejected) {
      if (typeof bad === 'string') expect(isFixtureScenario(bad)).toBe(false);
    }
  });

  it('已登记场景名才会换执行器，且换出来的确实返回 fixture 条目（fixture- 前缀 + 不可发送）', async () => {
    const registered = Object.keys(FIXTURE_SCENARIOS);
    expect(registered.length).toBeGreaterThan(0);
    expect(resolveSourceLoader('catalog2_then_conn_fail')).not.toBe(offlineSourceLoader);
    const next = await runRefresh(
      createInitialSourceState().refresh,
      resolveSourceLoader('catalog2_then_conn_fail'),
      () => 7
    );
    expect(next.status).toBe('ok');
    expect(next.entries.length).toBeGreaterThan(0);
    for (const e of next.entries) {
      expect(e.modelId.startsWith('fixture-')).toBe(true);
      expect(e.sendEligible).toBe(false);
    }
  });

  it('走一遍默认刷新：网络原语探针零次命中，结果按 transport_not_wired 失败且不产出任何条目', async () => {
    const probe = installNetworkProbe();
    try {
      const next = await runRefresh(
        createInitialSourceState().refresh,
        resolveSourceLoader(null),
        () => 4242
      );
      expect(probe.calls).toEqual([]);
      expect(next.status).toBe('failed');
      expect(next.failure?.reason).toBe('transport_not_wired');
      expect(next.entries).toEqual([]);
      expect(next.lastAttemptAt).toBe(4242);
      expect(next.lastSuccessAt).toBeNull();
    } finally {
      probe.restore();
    }
  });

  it('探针本身是有效的：往全局塞一个会被记下来的 fetch（证明上一条不是恒真）', async () => {
    const probe = installNetworkProbe();
    try {
      await (globalThis as unknown as { fetch: (u: string) => Promise<unknown> }).fetch(
        'http://127.0.0.1:1/v1/models'
      );
      expect(probe.calls).toEqual(['fetch(http://127.0.0.1:1/v1/models)']);
    } finally {
      probe.restore();
    }
  });

  it('产品源码里除"本机 API 回环通道"外不存在任何网络调用原语（apps/ui/src 全量静态扫描，排除测试文件）', () => {
    const files = productSourceEntries();
    expect(files.length).toBeGreaterThanOrEqual(8);
    // UI04 起网络边界从"零网络"改为"仅回环自连"：全产品**只允许**一个文件含网络原语。
    const hits: string[] = [];
    const seenAllowed: string[] = [];
    for (const [path, text] of files) {
      const fileHits = NETWORK_PRIMITIVE_PATTERNS.filter(([, re]) => re.test(text)).map(
        ([label]) => label
      );
      if (fileHits.length === 0) continue;
      if (path.replace(/\\/g, '/').endsWith(LOOPBACK_CHANNEL_FILE)) {
        seenAllowed.push(`${path}：${fileHits.join('、')}`);
        continue;
      }
      hits.push(`${path} 命中「${fileHits.join('、')}」`);
    }
    expect(hits).toEqual([]);
    // 前提不是恒真：白名单文件必须真的命中，且真的只此一个文件。
    expect(seenAllowed.length).toBe(1);
    expect(seenAllowed[0]).toContain(LOOPBACK_CHANNEL_FILE);
    expect(seenAllowed[0]).toContain('fetch 调用');
  });

  it('唯一含网络原语的模块同时带着回环守卫与契约路径常量（不许退化成裸请求）', () => {
    const entry = productSourceEntries().find(([path]) =>
      path.replace(/\\/g, '/').endsWith(LOOPBACK_CHANNEL_FILE)
    );
    expect(entry).toBeDefined();
    const text = entry![1];
    expect(text).toContain('LOOPBACK_HOSTNAMES');
    expect(text).toContain('resolveCatalogUrl');
    expect(text).toContain('SOURCE_ENDPOINT');
    expect(text).toContain("redirect: 'error'");
  });


  it('契约端点是相对路径：UI 数据层没有硬编码任何上游 origin', () => {
    expect(SOURCE_ENDPOINT.startsWith('/')).toBe(true);
    expect(SOURCE_ENDPOINT).not.toMatch(/^https?:\/\//i);
    expect(SOURCE_ENDPOINT).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
  });
});


// ZC-51: execute the real ModelsPage refresh callback and render its returned
// element tree. Hook storage is deterministic; this is not mounted DOM/GUI.
import { vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppState } from '../app/useAppState';

async function zc51PageHarness(payloads: unknown[]) {
  const slots: unknown[] = [];
  const logs: string[] = [];
  let cursor = 0;
  vi.resetModules();
  vi.doMock('react', async (original) => ({
    ...(await original<typeof import('react')>()),
    useState: (initial: unknown) => {
      const n = cursor++;
      if (!(n in slots)) slots[n] = typeof initial === 'function' ? initial() : initial;
      return [slots[n], (next: unknown) => { slots[n] = typeof next === 'function' ? next(slots[n]) : next; }];
    },
    useRef: (initial: unknown) => {
      const n = cursor++;
      if (!(n in slots)) slots[n] = { current: initial };
      return slots[n];
    },
    useMemo: (fn: () => unknown) => fn(),
    useCallback: (fn: unknown) => fn
  }));
  vi.doMock('./localApiSource', async (original) => ({
    ...(await original<typeof import('./localApiSource')>()),
    resolveSourceLoaderForUi: () => async () => {
      if (!payloads.length) throw new Error('fixture exhausted');
      return payloads.shift();
    }
  }));
  const { ModelsPage } = await import('../pages/ModelsPage');
  const state: AppState = {
    logs: [], log: (_level, _source, message) => { logs.push(message); },
    clearLogs: () => undefined, bootedAt: 0, now: 0, clockBroken: false,
    setClockBroken: () => undefined, localApiEnabled: true,
    setLocalApiEnabled: () => undefined, localApiBaseUrl: '', setLocalApiBaseUrl: () => undefined,
    // ZCC-GUI-EVIDENCE-20261008-A：证据读取默认 idle（零网络）
    readStatus: { phase: 'idle', snapshot: null, failure: null, loadedAt: null },
    refreshReadStatus: () => Promise.resolve()
  };
  const render = () => { cursor = 0; return ModelsPage({ state }); };
  function findRefresh(value: unknown): (() => void) | undefined {
    if (Array.isArray(value)) {
      for (const child of value) { const found = findRefresh(child); if (found) return found; }
    } else if (value && typeof value === 'object') {
      const node = value as { type?: unknown; props?: Record<string, unknown> };
      if (node.type === 'button' && typeof node.props?.children === 'string' && node.props.children.includes('刷新来源')) {
        return node.props.onClick as () => void;
      }
      if (node.props) for (const child of Object.values(node.props)) {
        const found = findRefresh(child); if (found) return found;
      }
    }
    return undefined;
  }
  return {
    logs,
    html: () => renderToStaticMarkup(render()),
    refresh: async () => {
      const click = findRefresh(render());
      if (!click) throw new Error('real refresh button not found');
      click();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    },
    restore: () => { vi.doUnmock('react'); vi.doUnmock('./localApiSource'); vi.resetModules(); vi.restoreAllMocks(); }
  };
}

describe('ZC-51 actual page refresh wiring', () => {
  it('first success has a success panel and dynamic revision/time without inventing epoch', async () => {
    const h = await zc51PageHarness([CATALOG_FIXTURE_V1]);
    try {
      vi.spyOn(Date, 'now').mockReturnValue(0);
      expect(h.html()).toContain('目录 revision unknown');
      expect(h.html()).toContain('最近同步 unknown');
      await h.refresh();
      const html = h.html();
      expect(html).not.toContain('来源当前返回 0 个条目');
      expect(html).toContain('来源读取成功');
      expect(html).toContain('目录 revision fixture-rev-1');
      expect(html).toMatch(/最近同步 1970-/);
      expect(html).toContain('账号 epoch unknown');
      expect(html).toContain('配置 revision unknown');
      expect(h.logs.at(-1)).toContain('首次读回');
      expect(h.logs.at(-1)).not.toContain('新增 2');
    } finally { h.restore(); }
  });
  it('same list and removal share the correct delta across notice, log and summary', async () => {
    const one = { ...CATALOG_FIXTURE_V1, revision: 'one-row', models: CATALOG_FIXTURE_V1.models.slice(0, 1) };
    const h = await zc51PageHarness([CATALOG_FIXTURE_V1, CATALOG_FIXTURE_V1, one]);
    try {
      await h.refresh(); await h.refresh();
      expect(h.logs.at(-1)).toContain('与上次一致：2 个条目，无增删');
      expect(h.html().split('与上次一致：2 个条目，无增删').length).toBeGreaterThanOrEqual(3);
      await h.refresh();
      expect(h.logs.at(-1)).toContain('新增 0');
      expect(h.logs.at(-1)).toContain('消失 1');
      expect(h.logs.at(-1)).toContain('保持 1 个');
      const html = h.html();
      expect(html.split('新增 0').length).toBeGreaterThanOrEqual(3);
      expect(html).toContain('目录 revision one-row');
    } finally { h.restore(); }
  });
  it('empty failure keeps rows/revision and the next success compares against the last successful list', async () => {
    const one = { ...CATALOG_FIXTURE_V1, revision: 'after-failure', models: CATALOG_FIXTURE_V1.models.slice(0, 1) };
    const h = await zc51PageHarness([CATALOG_FIXTURE_V1, { revision: 'empty', models: [] }, one]);
    try {
      await h.refresh(); await h.refresh();
      const failed = h.html();
      expect(failed).toContain('保留刷新前读到的 2 条');
      expect(failed).toContain('目录 revision fixture-rev-1');
      expect(failed).not.toContain('目录 revision empty');
      await h.refresh();
      expect(h.logs.at(-1)).toContain('新增 0');
      expect(h.logs.at(-1)).toContain('消失 1');
      expect(h.logs.at(-1)).toContain('保持 1 个');
    } finally { h.restore(); }
  });
});


describe('ZC-51 known empty baseline', () => {
  it('a known empty baseline is comparable, while only null means no prior catalog', () => {
    const entries = parseCatalogPayload(CATALOG_FIXTURE_V1);
    if (!entries.ok) throw new Error('invalid fixture');
    const delta = listDelta([], entries.entries);
    expect(delta.previous).toBe(0);
    expect(describeDelta(delta)).toContain('新增 2');
    expect(describeDelta(delta)).not.toContain('首次读回');
    expect(describeDelta(listDelta([], []))).toBe('与上次一致：0 个条目，无增删');
    expect(describeDelta({ ...delta, previous: null })).toContain('首次读回');
    expect(describeDelta({ ...delta, previous: null })).not.toContain('新增');
  });
});
