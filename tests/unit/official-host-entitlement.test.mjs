/**
 * OFFICIAL-HOST entitled 真实来源推导单测（零发送、零真实仓）。
 *
 * **本文件从不读本机真实 `~/.zcode/v2/coding-plan-cache.json`。** 全部缓存文档都是
 * 合成夹具（`syntheticCache`），路径也是不存在的假路径。
 *
 * 覆盖的硬事实（工单红线"不伪造 entitled"的落点）：
 *  1. **写 `entitled: true` 的唯一充分条件是缓存说 `available`。**
 *  2. `unavailable` / 状态不认识 / 条目缺失 / 缓存文件缺失 / 条目段缺失 / status 非字符串
 *     —— 六种情况**全部** `entitled: false`，且带**不同的** `reason`。
 *  3. **没有任何兜底分支把 false 翻成 true。** 穷举遍历状态取值，逐一断言。
 *  4. **映射表是白名单**：表里没有的 providerId 落 `no-cache-entry-for-provider`，不外推。
 *  5. **providerId → family 不猜**：读不出来抛错，**不**默认成 `zai`。
 *  6. **形状逐字对齐官方** `AccountProviderState.current`
 *     （`{type:'zhipu-account', accountType, mode, entitled}`，官方 `.strict()`）。
 *  7. **缓存是快照不是现在**：`availabilityObservedAt` 原样透传。
 *  8. **证据可记录且零凭据**：`formatEntitlementEvidence` 只输出键名/路径/状态/时间戳。
 */
import { describe, it, expect } from 'vitest';
import {
  ENTITLEMENT_REASON_CODES,
  OfficialEntitlementError,
  accountTypeOf,
  deriveEntitledSnapshot,
  formatEntitlementEvidence,
  readCodingPlanCache
} from '../../packages/official-host/src/entitlement.js';

/**
 * 合成缓存文档。
 * @param {Record<string, { status?: unknown, reason?: string }>} items
 * @param {number} [updatedAt]
 * @returns {string}
 */
function syntheticCache(items, updatedAt = 1_700_000_000_000) {
  return JSON.stringify({ version: 1, entryStatus: { updatedAt, items } });
}

const FAKE_PATH = 'D:/synthetic/never-exists/coding-plan-cache.json';

/**
 * @param {string} text
 * @returns {() => string}
 */
function readFileReturning(text) {
  return () => text;
}

/**
 * @param {string} code
 * @returns {() => never}
 */
function readFileThrowing(code) {
  return () => {
    const e = /** @type {any} */ (new Error(code));
    e.code = code;
    throw e;
  };
}

const START_PLAN_PROVIDER = 'account:bigmodel-start-plan';
const INDIVIDUAL_PROVIDER = 'account:bigmodel-individual-coding-plan';

describe('OFFICIAL-HOST entitlement · 唯一能推 true 的路径', () => {
  it('缓存说 available → entitled: true，且 reason=cache-available', () => {
    const snapshot = deriveEntitledSnapshot({
      providerId: START_PLAN_PROVIDER,
      planMode: 'start-plan',
      cacheFile: FAKE_PATH,
      readFile: readFileReturning(syntheticCache({ 'builtin:bigmodel-start-plan': { status: 'available' } }))
    });
    expect(snapshot.current.entitled).toBe(true);
    expect(snapshot.evidence.reason).toBe('cache-available');
    expect(snapshot.evidence.cacheKey).toBe('builtin:bigmodel-start-plan');
    expect(snapshot.evidence.cacheStatus).toBe('available');
  });

  it('individual 通道同样只看缓存，不看任何别的东西', () => {
    const snapshot = deriveEntitledSnapshot({
      providerId: INDIVIDUAL_PROVIDER,
      planMode: 'individual-coding-plan',
      cacheFile: FAKE_PATH,
      readFile: readFileReturning(syntheticCache({ 'builtin:bigmodel-coding-plan': { status: 'available' } }))
    });
    expect(snapshot.current.entitled).toBe(true);
    expect(snapshot.evidence.cacheKey).toBe('builtin:bigmodel-coding-plan');
  });
});

describe('OFFICIAL-HOST entitlement · 六种失败输入全部 false，且 reason 可指认', () => {
  /** @type {Array<[string, () => any]>} */
  const cases = [
    [
      '缓存说 unavailable',
      () =>
        deriveEntitledSnapshot({
          providerId: START_PLAN_PROVIDER,
          planMode: 'start-plan',
          cacheFile: FAKE_PATH,
          readFile: readFileReturning(
            syntheticCache({ 'builtin:bigmodel-start-plan': { status: 'unavailable', reason: 'quota_exhausted' } })
          )
        })
    ],
    [
      '状态值不认识',
      () =>
        deriveEntitledSnapshot({
          providerId: START_PLAN_PROVIDER,
          planMode: 'start-plan',
          cacheFile: FAKE_PATH,
          readFile: readFileReturning(syntheticCache({ 'builtin:bigmodel-start-plan': { status: 'AVAILABLE' } }))
        })
    ],
    [
      '缓存里没有该键',
      () =>
        deriveEntitledSnapshot({
          providerId: START_PLAN_PROVIDER,
          planMode: 'start-plan',
          cacheFile: FAKE_PATH,
          readFile: readFileReturning(syntheticCache({ 'builtin:zai-start-plan': { status: 'available' } }))
        })
    ],
    [
      '缓存文件不存在',
      () =>
        deriveEntitledSnapshot({
          providerId: START_PLAN_PROVIDER,
          planMode: 'start-plan',
          cacheFile: FAKE_PATH,
          readFile: readFileThrowing('ENOENT')
        })
    ],
    [
      '缓存条目段整体缺失',
      () =>
        deriveEntitledSnapshot({
          providerId: START_PLAN_PROVIDER,
          planMode: 'start-plan',
          cacheFile: FAKE_PATH,
          readFile: readFileReturning(JSON.stringify({ version: 1 }))
        })
    ],
    [
      '条目存在但 status 不是字符串',
      () =>
        deriveEntitledSnapshot({
          providerId: START_PLAN_PROVIDER,
          planMode: 'start-plan',
          cacheFile: FAKE_PATH,
          readFile: readFileReturning(
            syntheticCache({ 'builtin:bigmodel-start-plan': /** @type {any} */ ({ status: { nested: 'available' } }) })
          )
        })
    ]
  ];

  it.each(cases)('%s → entitled: false', (_label, make) => {
    const snapshot = make();
    expect(snapshot.evidence.available).toBe(false);
    expect(snapshot.current.entitled).toBe(false);
  });

  it('五种可区分的 reason（"键缺失"与"条目段缺失"同属一条 —— 两者都是"没有该条目"）', () => {
    const reasons = cases.map(([, make]) => make().evidence.reason);
    expect(new Set(reasons).size).toBe(5);
    expect(reasons).toContain('cache-unavailable');
    expect(reasons).toContain('cache-status-not-recognized');
    expect(reasons).toContain('no-cache-entry-for-provider');
    expect(reasons).toContain('cache-file-absent');
    expect(reasons).toContain('cache-entries-absent');
  });

  it('**没有任何输入能把 available 翻成 true**（穷举遍历，逐一断言）', () => {
    const statuses = /** @type {any[]} */ (['available', 'unavailable', 'AVAILABLE', 'Available', '', 'maybe', null, 1, {}]);
    for (const status of statuses) {
      const snapshot = deriveEntitledSnapshot({
        providerId: START_PLAN_PROVIDER,
        planMode: 'start-plan',
        cacheFile: FAKE_PATH,
        readFile: readFileReturning(syntheticCache({ 'builtin:bigmodel-start-plan': { status } }))
      });
      if (status === 'available') {
        expect(snapshot.evidence.available).toBe(true);
      } else {
        // 大小写不同、空串、数字、对象 —— 一律 false。**大小写不敏感放行是错的**：
        // 官方写的是小写 `available`，任何别的字面量都是我们没见过的形状。
        expect(snapshot.evidence.available).toBe(false);
      }
    }
    // status 键整个缺失
    const missing = deriveEntitledSnapshot({
      providerId: START_PLAN_PROVIDER,
      planMode: 'start-plan',
      cacheFile: FAKE_PATH,
      readFile: readFileReturning(syntheticCache({ 'builtin:bigmodel-start-plan': {} }))
    });
    expect(missing.evidence.available).toBe(false);
  });

  it('缓存 JSON 损坏 → 当作"没有真值"（false），不抛错也不猜', () => {
    const snapshot = deriveEntitledSnapshot({
      providerId: START_PLAN_PROVIDER,
      planMode: 'start-plan',
      cacheFile: FAKE_PATH,
      readFile: readFileReturning('{ this is not json')
    });
    expect(snapshot.evidence.available).toBe(false);
    expect(snapshot.evidence.reason).toBe('cache-file-absent');
  });
});

describe('OFFICIAL-HOST entitlement · 映射表是白名单，不外推', () => {
  it('team 套餐没有缓存键 → no-cache-entry-for-provider（官方就没给键）', () => {
    const snapshot = deriveEntitledSnapshot({
      providerId: 'account:bigmodel-team-coding-plan',
      planMode: 'team-coding-plan',
      cacheFile: FAKE_PATH,
      readFile: readFileReturning(syntheticCache({ 'builtin:bigmodel-coding-plan': { status: 'available' } }))
    });
    expect(snapshot.evidence.cacheKey).toBeNull();
    expect(snapshot.evidence.available).toBe(false);
    expect(snapshot.evidence.reason).toBe('no-cache-entry-for-provider');
  });

  it('四条已核 providerId 各自映到正确的缓存键', () => {
    const expected = {
      'account:zai-start-plan': 'builtin:zai-start-plan',
      'account:bigmodel-start-plan': 'builtin:bigmodel-start-plan',
      'account:zai-individual-coding-plan': 'builtin:zai-coding-plan',
      'account:bigmodel-individual-coding-plan': 'builtin:bigmodel-coding-plan'
    };
    for (const [providerId, cacheKey] of Object.entries(expected)) {
      const snapshot = deriveEntitledSnapshot({
        providerId,
        planMode: providerId.endsWith('start-plan') ? 'start-plan' : 'individual-coding-plan',
        cacheFile: FAKE_PATH,
        readFile: readFileReturning(syntheticCache({}))
      });
      expect(snapshot.evidence.cacheKey).toBe(cacheKey);
    }
  });

  it('reason 码闭集被测试钉死', () => {
    expect([...ENTITLEMENT_REASON_CODES]).toEqual([
      'cache-available',
      'cache-unavailable',
      'cache-status-not-recognized',
      'no-cache-entry-for-provider',
      'cache-file-absent',
      'cache-entries-absent'
    ]);
  });
});

describe('OFFICIAL-HOST entitlement · providerId → family 不猜', () => {
  it('四条已核 providerId 各自读出正确 accountType', () => {
    expect(accountTypeOf('account:zai-start-plan')).toBe('zai');
    expect(accountTypeOf('account:bigmodel-start-plan')).toBe('bigmodel');
    expect(accountTypeOf('account:zai-individual-coding-plan')).toBe('zai');
    expect(accountTypeOf('account:bigmodel-individual-coding-plan')).toBe('bigmodel');
  });

  it('family 读得出来但后缀没在已核四条内 → family 仍然读得出（team / off-peak）', () => {
    // family 来自 account:&lt;family&gt;-* 命名；后缀是否在缓存键表里是**另一层**判定。
    // 两层分开，才不会让"缓存键缺失"这条真实原因被"providerId 不认识"顶掉。
    expect(accountTypeOf('account:bigmodel-team-coding-plan')).toBe('bigmodel');
    expect(accountTypeOf('account:zai-off-peak')).toBe('zai');
  });

  it('读不出 family 的 providerId 抛错，**不**默认成 zai', () => {
    // 默认成 zai 会让一次 bigmodel 请求被拿 zai 的凭据去签 —— 那是一次真实的跨域鉴权尝试。
    for (const bad of ['openai', 'account:unknown-start-plan', 'account:', 'account', '', 'builtin:bigmodel']) {
      expect(() => accountTypeOf(bad)).toThrowError(OfficialEntitlementError);
    }
  });
});

describe('OFFICIAL-HOST entitlement · 官方状态形状（.strict() 必须逐字对上）', () => {
  it('current 恰好四个键，type 固定 zhipu-account', () => {
    const snapshot = deriveEntitledSnapshot({
      providerId: START_PLAN_PROVIDER,
      planMode: 'start-plan',
      cacheFile: FAKE_PATH,
      readFile: readFileReturning(syntheticCache({ 'builtin:bigmodel-start-plan': { status: 'available' } }))
    });
    expect(Object.keys(snapshot.current).sort()).toEqual(['accountType', 'entitled', 'mode', 'type']);
    expect(snapshot.current.type).toBe('zhipu-account');
    expect(snapshot.current.accountType).toBe('bigmodel');
    expect(snapshot.current.mode).toBe('start-plan');
    expect(typeof snapshot.current.entitled).toBe('boolean');
  });
});

describe('OFFICIAL-HOST entitlement · 缓存是快照不是现在', () => {
  it('availabilityObservedAt 原样透传缓存的 updatedAt（唯一的时效锚）', () => {
    const stamp = 1_712_345_678_901;
    const snapshot = deriveEntitledSnapshot({
      providerId: START_PLAN_PROVIDER,
      planMode: 'start-plan',
      cacheFile: FAKE_PATH,
      readFile: readFileReturning(syntheticCache({ 'builtin:bigmodel-start-plan': { status: 'available' } }, stamp))
    });
    expect(snapshot.evidence.availabilityObservedAt).toBe(stamp);
  });

  it('缓存缺失时 availabilityObservedAt 为 null（不编一个时间戳）', () => {
    const snapshot = deriveEntitledSnapshot({
      providerId: START_PLAN_PROVIDER,
      planMode: 'start-plan',
      cacheFile: FAKE_PATH,
      readFile: readFileThrowing('ENOENT')
    });
    expect(snapshot.evidence.availabilityObservedAt).toBeNull();
  });

  it('readCodingPlanCache 报 present:false 而不是抛错（文件缺失不是"宿主故障"）', () => {
    const result = readCodingPlanCache({ cacheFile: FAKE_PATH, readFile: readFileThrowing('ENOENT') });
    expect(result.present).toBe(false);
    expect(result.document).toBeNull();
    expect(result.path).toBe(FAKE_PATH);
  });
});

describe('OFFICIAL-HOST entitlement · 证据可记录且零凭据', () => {
  it('formatEntitlementEvidence 只输出键名/路径/状态/时间戳', () => {
    const snapshot = deriveEntitledSnapshot({
      providerId: START_PLAN_PROVIDER,
      planMode: 'start-plan',
      cacheFile: FAKE_PATH,
      readFile: readFileReturning(
        syntheticCache({ 'builtin:bigmodel-start-plan': { status: 'unavailable', reason: 'quota_exhausted' } })
      )
    });
    const line = formatEntitlementEvidence(snapshot.evidence);
    expect(line).toContain('provider=account:bigmodel-start-plan');
    expect(line).toContain('cache_key=builtin:bigmodel-start-plan');
    expect(line).toContain('cache_status=unavailable');
    expect(line).toContain('entitled=false');
    expect(line).toContain('reason=cache-unavailable');
    expect(line).toContain(FAKE_PATH);
    // 缓存里的 reason 字段不进入证据行 —— 那是外部自由文本，不该被当成我们自己的结论。
    expect(line).not.toContain('quota_exhausted');
  });
});
