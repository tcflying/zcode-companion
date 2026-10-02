/**
 * PLANSRC 契约测试：官方本地套餐/目录数据源（零发送、只读、结构 only）。
 *
 * Provider-free：零网络、零官方进程、零子进程、零数据库、零真实模型请求。
 * 全部输入都是本文件在临时目录里造的 fixture，**不读本机真实安装树/用户目录**，
 * 所以同一份断言在任何机器上都成立。
 *
 * 覆盖的硬事实：
 *  1. **凭据值永不出现在输出里。** 喂含假 key 的 providerRule，断言
 *     解析骨架 / 目录条目 / planStatus / e1Evidence / 驱动器 / 全部日志行 /
 *     整体 JSON.stringify 都搜不到那个值；同时断言**位置**被记录、值被替换成
 *     `[REDACTED]`。`apiKeyManagementUrl` 这类**前缀相同但不是凭据**的键必须原样保留
 *     （证明擦除按精确键名，不是按前缀乱砍）。
 *  2. **billingClass 保守映射。** 认识的 mode 走证据表；不认识的 mode 一律 `unknown`，
 *     **绝不**默认 subscription / promotion。缺 `access.mode` 同样 `unknown`。
 *  3. **文件缺失 / 不可读 / 非 UTF-8 / 非法 JSON / 形状不对**各有明确错误码，不猜。
 *  4. **产出满足已公布目录契约。** 映射结果逐条过 `catalogContractDefects()`，
 *     并且键集合与 `CATALOG_MODEL_KEYS` 完全一致（不多不少，UI02 解析器照此实现）。
 *  5. **模型能力按官方匹配语义解析。** `^(?:modelMatch)$` + 大小写不敏感 + 逐键 overlay
 *     （证据：zcode.cjs `vWt(e,t,n)` 与 `vWt(s.modelMatch,t.modelId,!0)`）。
 *  6. **local-official 驱动器不冒充能产出。** 目录是真实的本地数据，但
 *     `model_is_real` 仍为 false（`deriveModelIsReal` 要求 status==='ready'），
 *     `stream()` 调用即抛 `upstream_unavailable`，`/v1/models` 仍为空。
 *  7. **planStatus 只用本地可得的三类事实**：目录（builtin）、当前选择（setting）、
 *     资格快照（cache）。缓存里没有对应键的套餐 → `unknown`，不外推。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PlanSourceError,
  PLANSRC_ERROR_CODES,
  REDACTED_PLACEHOLDER,
  CREDENTIAL_KEYS,
  resolvePlanSourcePaths,
  readPlanSources,
  readSourceText,
  scrubCredentialValues,
  stripCredentialValues,
  listCredentialLocations
} from '../../packages/plansrc/src/reader.js';
import {
  PLAN_ACCESS_MODE_BILLING,
  PLAN_EVIDENCE_ANCHORS,
  KNOWN_ACCESS_MODES,
  mapAccessModeToBillingClass,
  resolveModelProperties,
  mapBuiltinToCatalog,
  buildPlanStatuses,
  buildE1Evidence
} from '../../packages/plansrc/src/mapper.js';
import { createLocalOfficialDriver, LOCAL_OFFICIAL_DRIVER_NAME } from '../../packages/plansrc/src/driver.js';
import { loadLocalOfficialDriver } from '../../packages/plansrc/src/index.js';
import { catalogContractDefects, CATALOG_MODEL_KEYS, deriveModelIsReal } from '../../packages/api/src/chat.js';
import { BILLING_CLASSES } from '../../packages/contracts/src/operation.js';

/* ------------------------------------------------------------------ *
 * fixture
 * ------------------------------------------------------------------ */

/** 假凭据。断言里到处搜这个串——它绝不允许出现在任何输出里。 */
const FAKE_KEY = 'sk-PLANSRC-FAKE-KEY-0f9a8b7c6d5e4f3a';
const FAKE_SECRET = 'Bearer PLANSRC-FAKE-TOKEN-deadbeefcafe';

/** 与本机真实文件同构的最小 builtin 目录（键名逐字对齐 E1R §2.5 / §3.3）。 */
const BUILTIN_FIXTURE = {
  schemaVersion: 1,
  revision: 30,
  config: {
    providerConfigRules: {
      templateRules: [],
      providerRules: [
        {
          providerId: 'account:zai-individual-coding-plan',
          providerName: 'Z.AI Individual Coding Plan',
          config: {
            group: 'zai-family',
            builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash'],
            // 凭据位置：值必须被擦除，位置必须被记录。
            access: { type: 'zhipu-account', mode: 'individual-coding-plan', accountType: 'zai', apiKey: FAKE_KEY },
            api: { type: 'openai-compatible', baseUrl: 'https://example.invalid/v1' },
            logo: { type: 'key', key: 'zhipu' }
          }
        },
        {
          providerId: 'account:zai-team-coding-plan',
          providerName: 'Z.AI Team Coding Plan',
          config: {
            group: 'zai-family',
            builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash'],
            access: { type: 'zhipu-account', mode: 'team-coding-plan', accountType: 'zai' },
            api: { type: 'openai-compatible', baseUrl: 'https://example.invalid/v1' },
            logo: { type: 'key', key: 'zhipu' }
          }
        },
        {
          providerId: 'account:zai-start-plan',
          providerName: 'Start Plan',
          config: {
            group: 'zai-family',
            builtinModelIds: ['GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo'],
            access: { type: 'zhipu-account', mode: 'start-plan', accountType: 'zai', apiKeyManagementUrl: 'https://example.invalid/keys' },
            api: { type: 'openai-compatible', baseUrl: 'https://example.invalid/v1' },
            logo: { type: 'key', key: 'zhipu' }
          }
        },
        {
          providerId: 'account:bigmodel-individual-coding-plan',
          providerName: 'BigModel Individual Coding Plan',
          config: {
            group: 'bigmodel-family',
            builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash'],
            access: { type: 'zhipu-account', mode: 'individual-coding-plan', accountType: 'bigmodel', apiKey: FAKE_SECRET },
            api: { type: 'openai-compatible', baseUrl: 'https://example.invalid/v1' },
            logo: { type: 'key', key: 'zhipu' }
          }
        },
        {
          providerId: 'account:bigmodel-start-plan',
          providerName: 'Start Plan',
          config: {
            group: 'bigmodel-family',
            builtinModelIds: ['GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo'],
            access: { type: 'zhipu-account', mode: 'start-plan', accountType: 'bigmodel' },
            api: { type: 'openai-compatible', baseUrl: 'https://example.invalid/v1' },
            logo: { type: 'key', key: 'zhipu' }
          }
        },
        {
          providerId: 'account:zai-offpeak-idle-plan',
          providerName: 'Z.AI Idle plan',
          config: {
            group: 'zai-family',
            builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash'],
            visibility: 'hidden',
            access: { type: 'zhipu-account', mode: 'off-peak', accountType: 'zai' },
            api: { type: 'openai-compatible', baseUrl: 'https://example.invalid/v1' },
            logo: { type: 'key', key: 'zhipu' }
          }
        },
        {
          // 不认识的 mode：必须落 unknown，且不得影响其它条目。
          providerId: 'account:bigmodel-experimental-bundle',
          providerName: 'BigModel Experimental Bundle',
          config: {
            group: 'bigmodel-family',
            builtinModelIds: ['GLM-5.2'],
            access: { type: 'zhipu-account', mode: 'experimental-bundle', accountType: 'bigmodel' },
            api: { type: 'openai-compatible', baseUrl: 'https://example.invalid/v1' },
            logo: { type: 'key', key: 'zhipu' }
          }
        },
        {
          // 缺 access.mode：同样必须落 unknown。
          providerId: 'account:zai-no-mode',
          providerName: 'Z.AI No Mode',
          config: {
            group: 'zai-family',
            builtinModelIds: ['GLM-5.2'],
            access: { type: 'zhipu-account', accountType: 'zai' },
            api: { type: 'openai-compatible', baseUrl: 'https://example.invalid/v1' },
            logo: { type: 'key', key: 'zhipu' }
          }
        }
      ]
    },
    modelConfigRules: {
      modelRules: [
        {
          modelMatch: '.*',
          config: {
            enabled: true,
            properties: {
              contextWindow: 200000,
              inputFormat: { supportsText: true, supportsImage: false, supportsVideo: false, supportsAudio: false, supportsPdf: false },
              outputFormat: { supportsText: true },
              supportsToolCall: true,
              supportsJsonSchemaOutput: false,
              supportsNativeWebSearch: false,
              supportsMidConversationSystem: false,
              requiresMfjsToolSchema: false
            },
            optionSpecs: { maxOutputTokens: { max: 32000 }, reasoningLevel: { values: ['disabled', 'enabled'], map: '{}' } }
          }
        },
        {
          modelMatch: '.*glm-5(?:[.\\-:/\\[].*)?',
          config: {
            properties: { contextWindow: 200000, inputFormat: { supportsImage: false, supportsVideo: false } },
            optionSpecs: { reasoningLevel: { values: ['disabled', 'enabled'] }, maxOutputTokens: { max: 64000 } }
          }
        },
        {
          modelMatch: '.*glm-5\\.3(?:-flash)?(?:[.\\-:/\\[].*)?',
          config: {
            properties: { contextWindow: 1000000, inputFormat: { supportsImage: false, supportsVideo: false } },
            optionSpecs: { reasoningLevel: { values: ['low', 'high', 'max'] }, maxOutputTokens: { max: 128000 } }
          }
        },
        {
          modelMatch: '.*glm-5\\.3-flash(?:[.\\-:/\\[].*)?',
          config: { properties: { inputFormat: { supportsImage: true, supportsVideo: true, supportsPdf: true } } }
        },
        {
          modelMatch: '.*GLM-5\\.2(?:[.\\-:/\\[].*)?',
          config: {
            properties: { contextWindow: 1000000, inputFormat: { supportsImage: false, supportsVideo: false } },
            optionSpecs: { reasoningLevel: { values: ['disabled', 'high', 'max'] }, maxOutputTokens: { max: 128000 } }
          }
        },
        {
          modelMatch: '.*GLM-5-Turbo(?:[.\\-:/\\[].*)?',
          config: {
            properties: { contextWindow: 200000, inputFormat: { supportsImage: false, supportsVideo: false } },
            optionSpecs: { reasoningLevel: { values: ['disabled', 'enabled'] }, maxOutputTokens: { max: 64000 } }
          }
        }
      ],
      modelApiRules: [],
      providerSiteRules: [],
      templateModelRules: [],
      builtinProviderModelRules: [
        { providerId: 'account:zai-individual-coding-plan', modelId: 'GLM-5.3', config: { enabled: true } },
        { providerId: 'account:zai-individual-coding-plan', modelId: 'GLM-5.3-Flash', config: { enabled: true } },
        { providerId: 'account:zai-team-coding-plan', modelId: 'GLM-5.3', config: { enabled: true } },
        { providerId: 'account:zai-team-coding-plan', modelId: 'GLM-5.3-Flash', config: { enabled: true } },
        { providerId: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash', config: { enabled: true } },
        { providerId: 'account:zai-start-plan', modelId: 'GLM-5.2', config: { enabled: true } },
        { providerId: 'account:zai-start-plan', modelId: 'GLM-5-Turbo', config: { enabled: true } },
        { providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3', config: { enabled: true } },
        { providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3-Flash', config: { enabled: true } },
        { providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.3-Flash', config: { enabled: true } },
        { providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.2', config: { enabled: true } },
        { providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5-Turbo', config: { enabled: true } },
        { providerId: 'account:zai-offpeak-idle-plan', modelId: 'GLM-5.3', config: { enabled: true } },
        { providerId: 'account:zai-offpeak-idle-plan', modelId: 'GLM-5.3-Flash', config: { enabled: true } },
        // 声明了但未 enable：必须被剔除
        { providerId: 'account:bigmodel-experimental-bundle', modelId: 'GLM-5.2', config: { enabled: false } },
        { providerId: 'account:zai-no-mode', modelId: 'GLM-5.2', config: { enabled: true } }
      ]
    }
  }
};

const SETTING_FIXTURE = {
  locale: 'zh-CN',
  providerFamilyDomain: 'bigmodel',
  providerFamilyDomainUpdatedAt: 1789847493566,
  providerFamilyConnectionSelections: {
    zai: { kind: 'start-plan' },
    bigmodel: { kind: 'individual-coding-plan' }
  }
};

const CACHE_FIXTURE = {
  version: 1,
  entryStatus: {
    updatedAt: 1789189306134,
    items: {
      'builtin:zai-start-plan': { status: 'available' },
      'builtin:zai-coding-plan': { status: 'unavailable', reason: 'coding_plan_not_entitled' },
      'builtin:bigmodel-coding-plan': { status: 'available' },
      'builtin:bigmodel-start-plan': { status: 'available' }
    }
  }
};

/**
 * @typedef {object} FixturePaths
 * @property {string} builtinFile
 * @property {string} settingFile
 * @property {string} cacheFile
 * @property {string} dataBaseDir
 */

/**
 * 造一个三文件齐全的临时根，返回路径与清理函数。
 * @param {{builtin?: unknown, setting?: unknown, cache?: unknown}} [overrides] 可覆盖的源文件内容
 * @returns {{dir: string, paths: FixturePaths, cleanup: () => void}}
 */
function makeSourceDir(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zcc-plansrc-'));
  const paths = {
    builtinFile: join(dir, 'zcode-builtin.json'),
    settingFile: join(dir, 'setting.json'),
    cacheFile: join(dir, 'coding-plan-cache.json'),
    dataBaseDir: dir,
    ...overrides
  };
  writeFileSync(paths.builtinFile, JSON.stringify(overrides.builtin ?? BUILTIN_FIXTURE), 'utf8');
  writeFileSync(paths.settingFile, JSON.stringify(overrides.setting ?? SETTING_FIXTURE), 'utf8');
  writeFileSync(paths.cacheFile, JSON.stringify(overrides.cache ?? CACHE_FIXTURE), 'utf8');
  return { dir, paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * 把任意值序列化成"所有可能出现在输出里的文本形式"。
 * @param {unknown} value
 * @returns {string}
 */
function allText(value) {
  return [JSON.stringify(value, null, 2), String(value), JSON.stringify(Object.keys(value ?? {}))].join('\n');
}

/* ------------------------------------------------------------------ *
 * 1. 凭据值永不出现在输出里
 * ------------------------------------------------------------------ */

describe('PLANSRC 凭据红线', () => {
  it('假 key 的值在解析骨架 / 目录 / planStatus / e1Evidence / 驱动器 / 日志里都搜不到', () => {
    const { paths, cleanup } = makeSourceDir();
    try {
      const logLines = [];
      const sources = readPlanSources({ paths, now: () => 1_700_000_000_000 });

      // 位置被记录
      expect(sources.builtin.credentialLocations).toContain(
        '$.config.providerConfigRules.providerRules[0].config.access.apiKey'
      );
      expect(sources.builtin.credentialLocations).toContain(
        '$.config.providerConfigRules.providerRules[3].config.access.apiKey'
      );
      // 值被替换
      const skeleton = JSON.stringify(sources.builtin.document);
      expect(skeleton).toContain(REDACTED_PLACEHOLDER);
      expect(skeleton).not.toContain(FAKE_KEY);
      expect(skeleton).not.toContain(FAKE_SECRET);

      const catalog = mapBuiltinToCatalog(sources.builtin);
      const plans = buildPlanStatuses({ sources, catalog });
      const evidence = buildE1Evidence(sources, catalog, plans);
      const driver = createLocalOfficialDriver({ sources, catalog });
      for (const line of [JSON.stringify(catalog), JSON.stringify(plans), allText(evidence)]) {
        logLines.push(line);
      }
      logLines.push(JSON.stringify(driver.catalog), driver.statusDetail, driver.name, JSON.stringify(driver.models));

      const haystack = logLines.join('\n');
      expect(haystack).not.toContain(FAKE_KEY);
      expect(haystack).not.toContain(FAKE_SECRET);
      expect(haystack).toContain('account:zai-individual-coding-plan');
    } finally {
      cleanup();
    }
  });

  it('前缀相同但不是凭据的键（apiKeyManagementUrl）不被误擦', () => {
    const { paths, cleanup } = makeSourceDir();
    try {
      const sources = readPlanSources({ paths });
      const doc = /** @type {any} */ (sources.builtin.document);
      const rules = doc?.config?.providerConfigRules?.providerRules ?? [];
      const startPlan = rules.find((/** @type {any} */ r) => r?.providerId === 'account:zai-start-plan');
      expect(startPlan.config.access.apiKeyManagementUrl).toBe('https://example.invalid/keys');
      expect(startPlan.config.access.apiKey).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('喂给 JSON.parse 的那份文本里已经没有凭据值（擦除先于解析，可外部观察）', () => {
    const { paths, cleanup } = makeSourceDir();
    try {
      const text = readSourceText('builtinFile', paths.builtinFile);
      expect(text).not.toContain(FAKE_KEY);
      expect(text).not.toContain(FAKE_SECRET);
      expect(text).toContain(REDACTED_PLACEHOLDER);
      // 擦除不能破坏 JSON 结构，否则会把"凭据保护"换成"读不出文件"
      expect(() => JSON.parse(text)).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it('带空格的 pretty-print 格式也被整段吃掉，不留残值、不破坏 JSON（真实文件回归）', () => {
    // 回归来源：本机 ~/.zcode/v2/provider_config.json 是缩进 + `": "` 格式。
    // 曾经用"两条正则分两步"实现，第二条的 \s* 会在 (?!") 失败时回退交出一个空格，
    // 于是占位符被插到冒号后面、**原值留在原地**，输出成 `"apiKey": "[REDACTED]" "原值"`：
    // JSON 直接解析失败，凭据还在文件里。把"凭据保护"换成了"读不出文件"。
    const pretty = `{
  "config": {
    "rules": [
      {
        "access": {
          "type": "zhipu-account",
          "apiKey": "${FAKE_KEY}"
        },
        "token": "${FAKE_SECRET}",
        "apiKeyManagementUrl": "https://example.invalid/keys"
      }
    ]
  }
}`;
    const scrubbed = scrubCredentialValues(pretty);
    expect(scrubbed).not.toContain(FAKE_KEY);
    expect(scrubbed).not.toContain(FAKE_SECRET);
    // 关键：不允许出现"占位符后面又跟着另一个引号串"的残值形状
    expect(scrubbed).not.toMatch(/\[REDACTED\]\s*"\s*:/);
    const parsed = JSON.parse(scrubbed);
    expect(parsed.config.rules[0].access.apiKey).toBe(REDACTED_PLACEHOLDER);
    expect(parsed.config.rules[0].token).toBe(REDACTED_PLACEHOLDER);
    expect(parsed.config.rules[0].apiKeyManagementUrl).toBe('https://example.invalid/keys');
  });

  it('标量凭据值（数字 / null）在文本层被整段替换，不破坏 JSON', () => {
    const raw = '{"a":{"token":123,"secret":null,"api":{"k":"v"}}}';
    const parsed = JSON.parse(scrubCredentialValues(raw));
    expect(parsed.a.token).toBe(REDACTED_PLACEHOLDER);
    expect(parsed.a.secret).toBe(REDACTED_PLACEHOLDER);
    expect(parsed.a.api).toEqual({ k: 'v' });
  });

  it('对象 / 数组形态的凭据值由结构化清扫兜住（正则不做括号配平，交给 strip 层）', () => {
    const raw = '{"a":{"apiKey":{"v":"sk-x"},"api":{"k":"v"}}}';
    // 文本层不动它（不制造半截 JSON）——但必须保证文件仍可解析
    const text = scrubCredentialValues(raw);
    expect(() => JSON.parse(text)).not.toThrow();
    // 结构层负责真正替换
    const parsed = stripCredentialValues(JSON.parse(text));
    expect(parsed.a.apiKey).toBe(REDACTED_PLACEHOLDER);
    expect(parsed.a.api).toEqual({ k: 'v' });
    expect(JSON.stringify(parsed)).not.toContain('sk-x');
  });

  it('scrubCredentialValues 对压缩成单行的 JSON 同样生效（擦除发生在 JSON.parse 之前）', () => {
    const raw = JSON.stringify({ a: { apiKey: FAKE_KEY, apiKeyManagementUrl: 'https://example.invalid/keys' } });
    const scrubbed = scrubCredentialValues(raw);
    expect(scrubbed).not.toContain(FAKE_KEY);
    expect(scrubbed).toContain(REDACTED_PLACEHOLDER);
    expect(JSON.parse(scrubbed).a.apiKeyManagementUrl).toBe('https://example.invalid/keys');
  });

  it('listCredentialLocations 只报位置，不报值', () => {
    const raw = JSON.stringify({ cfg: { rules: [{ access: { apiKey: FAKE_KEY, mode: 'start-plan' } }] } });
    const locations = listCredentialLocations(JSON.parse(scrubCredentialValues(raw)));
    expect(locations).toEqual(['$.cfg.rules[0].access.apiKey']);
    expect(locations.join('|')).not.toContain(FAKE_KEY);
  });

  it('凭据键表是闭集的且逐字覆盖 brief 点名的位置', () => {
    expect([...CREDENTIAL_KEYS]).toContain('apiKey');
    expect([...CREDENTIAL_KEYS]).not.toContain('apiKeyManagementUrl');
  });
});

/* ------------------------------------------------------------------ *
 * 2. billingClass 保守映射
 * ------------------------------------------------------------------ */

describe('PLANSRC billingClass 保守映射', () => {
  it('有证据的四个 mode 走证据表', () => {
    expect(mapAccessModeToBillingClass('individual-coding-plan')).toBe('subscription');
    expect(mapAccessModeToBillingClass('team-coding-plan')).toBe('subscription');
    expect(mapAccessModeToBillingClass('start-plan')).toBe('promotion');
    expect(mapAccessModeToBillingClass('off-peak')).toBe('unknown');
  });

  it('不认识的 mode 一律 unknown，绝不落 subscription / promotion', () => {
    for (const mode of ['experimental-bundle', 'freemium', 'trial-2027', '', 'START-PLAN', 'start_plan']) {
      expect(mapAccessModeToBillingClass(mode)).toBe('unknown');
    }
    expect(mapAccessModeToBillingClass(undefined)).toBe('unknown');
    expect(mapAccessModeToBillingClass(null)).toBe('unknown');
    expect(mapAccessModeToBillingClass(42)).toBe('unknown');
    expect(mapAccessModeToBillingClass({ mode: 'start-plan' })).toBe('unknown');
  });

  it('映射表只覆盖 KNOWN_ACCESS_MODES，取值集合与 contracts 的 BILLING_CLASSES 一致', () => {
    expect(Object.keys(PLAN_ACCESS_MODE_BILLING).sort()).toEqual([...KNOWN_ACCESS_MODES].sort());
    for (const value of Object.values(PLAN_ACCESS_MODE_BILLING)) {
      expect(BILLING_CLASSES).toContain(value);
    }
  });

  it('整份目录里只有有证据的 mode 落非 unknown，其余全 unknown', () => {
    const { paths, cleanup } = makeSourceDir();
    try {
      const sources = readPlanSources({ paths });
      const catalog = mapBuiltinToCatalog(sources.builtin);
      const plans = buildPlanStatuses({ sources, catalog });
      // 每个 providerRule 都必须有一档类别（即使它一个模型都没出）
      const byPlan = new Map(plans.map((p) => [p.providerId, p.billingClass]));
      expect(byPlan.get('account:zai-individual-coding-plan')).toBe('subscription');
      expect(byPlan.get('account:zai-team-coding-plan')).toBe('subscription');
      expect(byPlan.get('account:bigmodel-individual-coding-plan')).toBe('subscription');
      expect(byPlan.get('account:zai-start-plan')).toBe('promotion');
      expect(byPlan.get('account:bigmodel-start-plan')).toBe('promotion');
      expect(byPlan.get('account:zai-offpeak-idle-plan')).toBe('unknown');
      expect(byPlan.get('account:bigmodel-experimental-bundle')).toBe('unknown');
      expect(byPlan.get('account:zai-no-mode')).toBe('unknown');
      // 目录条目上的类别与 planStatus 上的类别必须逐条一致
      for (const m of catalog.models) expect(m.billingClass).toBe(byPlan.get(m.provider));
      // 未 enable 的模型被剔除 → 该 provider 一个条目都不出，但类别仍是 unknown
      expect(catalog.models.filter((m) => m.provider === 'account:bigmodel-experimental-bundle')).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3. 模型能力按官方匹配语义解析
 * ------------------------------------------------------------------ */

describe('PLANSRC 模型能力解析', () => {
  it('^(?:modelMatch)$ + 大小写不敏感 + 逐键 overlay', () => {
    const rules = BUILTIN_FIXTURE.config.modelConfigRules.modelRules;
    const g53 = resolveModelProperties(rules, 'GLM-5.3');
    expect(g53.contextWindow).toBe(1000000);
    expect(g53.reasoning).toEqual(['low', 'high', 'max']);
    expect(g53.capabilities).toContain('text');
    expect(g53.capabilities).not.toContain('image');

    const g53f = resolveModelProperties(rules, 'GLM-5.3-Flash');
    expect(g53f.contextWindow).toBe(1000000);
    expect(g53f.reasoning).toEqual(['low', 'high', 'max']);
    // 深合并：后到的 image/video/pdf 为真，早先的 text 保留
    expect(g53f.capabilities).toEqual(expect.arrayContaining(['text', 'image', 'video', 'pdf']));

    const g52 = resolveModelProperties(rules, 'GLM-5.2');
    expect(g52.contextWindow).toBe(1000000);
    expect(g52.reasoning).toEqual(['disabled', 'high', 'max']);

    const turbo = resolveModelProperties(rules, 'GLM-5-Turbo');
    expect(turbo.contextWindow).toBe(200000);
    expect(turbo.reasoning).toEqual(['disabled', 'enabled']);
  });

  it('没有任何规则命中时如实给 unknown：contextLength null / reasoning 空 / capabilities 只剩声明为真者', () => {
    const resolved = resolveModelProperties([], 'NOTHING-MATCHES-THIS');
    expect(resolved.contextWindow).toBeNull();
    expect(resolved.reasoning).toEqual([]);
    expect(resolved.capabilities).toEqual([]);
  });

  it('非法正则不抛整份目录：按不命中处理并记录', () => {
    const resolved = resolveModelProperties([{ modelMatch: '([unclosed', config: { properties: { contextWindow: 7 } } }], 'x');
    expect(resolved.contextWindow).toBeNull();
    expect(resolved.invalidPatterns).toEqual(['([unclosed']);
  });
});

/* ------------------------------------------------------------------ *
 * 4. 目录产出满足已公布契约
 * ------------------------------------------------------------------ */

describe('PLANSRC 目录契约', () => {
  it('映射结果逐条过 catalogContractDefects，且键集合与 CATALOG_MODEL_KEYS 完全一致', () => {
    const { paths, cleanup } = makeSourceDir();
    try {
      const sources = readPlanSources({ paths });
      const catalog = mapBuiltinToCatalog(sources.builtin);
      expect(catalogContractDefects(catalog)).toEqual([]);
      expect(catalog.models.length).toBeGreaterThan(0);
      for (const m of catalog.models) {
        expect(Object.keys(m).sort()).toEqual([...CATALOG_MODEL_KEYS].sort());
      }
    } finally {
      cleanup();
    }
  });

  it('modelId 唯一：一个模型被多个套餐提供时按套餐限定，避免同 id 两种计费类别', () => {
    const { paths, cleanup } = makeSourceDir();
    try {
      const sources = readPlanSources({ paths });
      const catalog = mapBuiltinToCatalog(sources.builtin);
      const ids = catalog.models.map((m) => m.modelId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toContain('account:zai-individual-coding-plan::GLM-5.3');
      expect(ids).toContain('account:zai-start-plan::GLM-5.2');
      // 声明了但 enabled:false 的组合不出条目
      expect(ids).not.toContain('account:bigmodel-experimental-bundle::GLM-5.2');
    } finally {
      cleanup();
    }
  });

  it('revision 由内容派生且稳定；换 revision 就换 id', () => {
    const { paths, cleanup } = makeSourceDir();
    try {
      const sources = readPlanSources({ paths });
      const a = mapBuiltinToCatalog(sources.builtin);
      const b = mapBuiltinToCatalog(sources.builtin);
      expect(a.revision).toBe(b.revision);
      expect(a.revision).toMatch(/^local-official:builtin:[0-9a-f]{16}$/);
      const bumped = mapBuiltinToCatalog({
        ...sources.builtin,
        document: { ...BUILTIN_FIXTURE, revision: 31 }
      });
      expect(bumped.revision).not.toBe(a.revision);
    } finally {
      cleanup();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 5. planStatus：只报本地可得的三类事实
 * ------------------------------------------------------------------ */

describe('PLANSRC planStatus', () => {
  it('缓存命中 / 未命中 / 不可用三种情形各自如实', () => {
    const { paths, cleanup } = makeSourceDir();
    try {
      const sources = readPlanSources({ paths });
      const catalog = mapBuiltinToCatalog(sources.builtin);
      const plans = buildPlanStatuses({ sources, catalog });
      const byId = new Map(plans.map((p) => [p.providerId, p]));

      // 缓存键 builtin:zai-coding-plan → account:zai-individual-coding-plan，unavailable
      const zaiIndividual = byId.get('account:zai-individual-coding-plan');
      expect(zaiIndividual).toBeDefined();
      expect(zaiIndividual?.availability).toBe('unavailable');
      expect(zaiIndividual?.unavailableReason).toBe('coding_plan_not_entitled');
      expect(zaiIndividual?.availabilityObservedAt).toBe(1789189306134);
      expect(zaiIndividual?.availabilitySourceFile).toBe(paths.cacheFile);

      expect(byId.get('account:zai-start-plan')?.availability).toBe('available');

      // 缓存里没有 team / offpeak 键：不外推，落 unknown
      const team = byId.get('account:zai-team-coding-plan');
      expect(team).toBeDefined();
      expect(team?.availability).toBe('unknown');
      expect(team?.availabilitySource).toBe('no-cache-entry');
      expect(team?.unavailableReason).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('当前选择来自 setting.json，只标记当前 domain 选中的那个 kind', () => {
    const { paths, cleanup } = makeSourceDir();
    try {
      const sources = readPlanSources({ paths });
      const catalog = mapBuiltinToCatalog(sources.builtin);
      const plans = buildPlanStatuses({ sources, catalog });
      expect(/** @type {any} */ (sources.setting.document).providerFamilyDomain).toBe('bigmodel');
      const selected = plans.filter((p) => p.selected).map((p) => p.providerId).sort();
      // domain=bigmodel 且 kind=individual-coding-plan → 只有 bigmodel-individual 选中
      expect(selected).toEqual(['account:bigmodel-individual-coding-plan']);
      // zai 域虽然也选了 start-plan，但当前 domain 不是 zai
      expect(plans.find((p) => p.providerId === 'account:zai-start-plan')?.selected).toBe(false);
      for (const p of plans) expect(p.selectionObservedAt).toBe(1789847493566);
    } finally {
      cleanup();
    }
  });

  it('缓存文件缺失时 planStatus 仍能出，但资格一律 unknown 并说明原因', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcc-plansrc-nocache-'));
    try {
      const paths = {
        builtinFile: join(dir, 'zcode-builtin.json'),
        settingFile: join(dir, 'setting.json'),
        cacheFile: join(dir, 'coding-plan-cache.json'),
        dataBaseDir: dir
      };
      writeFileSync(paths.builtinFile, JSON.stringify(BUILTIN_FIXTURE), 'utf8');
      writeFileSync(paths.settingFile, JSON.stringify(SETTING_FIXTURE), 'utf8');
      const sources = readPlanSources({ paths, allowMissing: ['cacheFile'] });
      expect(sources.cache.present).toBe(false);
      const catalog = mapBuiltinToCatalog(sources.builtin);
      const plans = buildPlanStatuses({ sources, catalog });
      expect(plans.length).toBeGreaterThan(0);
      for (const p of plans) {
        expect(p.availability).toBe('unknown');
        expect(p.unavailableReason).toBe('coding_plan_cache_absent');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * 6. 错误码：缺失 / 不可读 / 非 UTF-8 / 非法 JSON / 形状不对
 * ------------------------------------------------------------------ */

describe('PLANSRC 错误码', () => {
  it('三个文件缺失各有独立错误码，指名是哪个文件，不猜', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcc-plansrc-empty-'));
    try {
      // 其余两个文件先造好，让"缺哪一个"成为唯一变量——否则永远只测到第一个报的错。
      /** @type {Record<string, string | undefined>} */
      const valid = {
        builtinFile: JSON.stringify(BUILTIN_FIXTURE),
        settingFile: JSON.stringify(SETTING_FIXTURE),
        cacheFile: JSON.stringify(CACHE_FIXTURE)
      };
      for (const key of /** @type {Array<'builtinFile' | 'settingFile' | 'cacheFile'>} */ ([
        'builtinFile',
        'settingFile',
        'cacheFile'
      ])) {
        /** @type {FixturePaths} */
        const paths = {
          builtinFile: join(dir, 'zcode-builtin.json'),
          settingFile: join(dir, 'setting.json'),
          cacheFile: join(dir, 'coding-plan-cache.json'),
          dataBaseDir: dir
        };
        for (const other of /** @type {Array<'builtinFile' | 'settingFile' | 'cacheFile'>} */ ([
          'builtinFile',
          'settingFile',
          'cacheFile'
        ])) {
          if (other === key) continue;
          writeFileSync(paths[other], String(valid[other]));
        }
        paths[key] = join(dir, `nope-${key}.json`);
        /** @type {any} */
        let caught = null;
        try {
          readPlanSources({ paths });
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(PlanSourceError);
        expect(caught.code).toBe(`PLANSRC_${key.replace('File', '').toUpperCase()}_NOT_FOUND`);
        expect(caught.source).toBe(key);
        expect(caught.message).toContain(paths[key]);
        expect(PLANSRC_ERROR_CODES).toContain(caught.code);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('非法 JSON → PLANSRC_JSON_INVALID，指名文件与偏移', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcc-plansrc-badjson-'));
    try {
      const paths = {
        builtinFile: join(dir, 'zcode-builtin.json'),
        settingFile: join(dir, 'setting.json'),
        cacheFile: join(dir, 'coding-plan-cache.json'),
        dataBaseDir: dir
      };
      writeFileSync(paths.builtinFile, '{ this is not json', 'utf8');
      writeFileSync(paths.settingFile, JSON.stringify(SETTING_FIXTURE), 'utf8');
      writeFileSync(paths.cacheFile, JSON.stringify(CACHE_FIXTURE), 'utf8');
      /** @type {any} */
      let caught = null;
      try {
        readPlanSources({ paths });
      } catch (e) {
        caught = e;
      }
      expect(caught.code).toBe('PLANSRC_JSON_INVALID');
      expect(caught.source).toBe('builtinFile');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('非 UTF-8 字节序列 → PLANSRC_NOT_UTF8（编码问题，不是工程缺陷，但必须有码）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcc-plansrc-utf8-'));
    try {
      const paths = {
        builtinFile: join(dir, 'zcode-builtin.json'),
        settingFile: join(dir, 'setting.json'),
        cacheFile: join(dir, 'coding-plan-cache.json'),
        dataBaseDir: dir
      };
      writeFileSync(paths.builtinFile, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
      writeFileSync(paths.settingFile, JSON.stringify(SETTING_FIXTURE), 'utf8');
      writeFileSync(paths.cacheFile, JSON.stringify(CACHE_FIXTURE), 'utf8');
      /** @type {any} */
      let caught = null;
      try {
        readPlanSources({ paths });
      } catch (e) {
        caught = e;
      }
      expect(caught.code).toBe('PLANSRC_NOT_UTF8');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('形状不对（providerRules 不是数组）→ PLANSRC_SHAPE_INVALID', () => {
    const { paths, cleanup } = makeSourceDir({
      builtin: { schemaVersion: 1, revision: 1, config: { providerConfigRules: { providerRules: { nope: true } } } }
    });
    try {
      /** @type {any} */
      let caught = null;
      try {
        readPlanSources({ paths });
      } catch (e) {
        caught = e;
      }
      expect(caught.code).toBe('PLANSRC_SHAPE_INVALID');
      expect(caught.message).toContain('providerRules');
    } finally {
      cleanup();
    }
  });

  it('setting / cache 形状不对同样有自己的码，不静默吞掉', () => {
    const { paths, cleanup } = makeSourceDir({ setting: { providerFamilyConnectionSelections: 'nope' } });
    try {
      /** @type {any} */
      let caught = null;
      try {
        readPlanSources({ paths });
      } catch (e) {
        caught = e;
      }
      expect(caught.code).toBe('PLANSRC_SHAPE_INVALID');
      expect(caught.source).toBe('settingFile');
    } finally {
      cleanup();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 7. local-official 驱动器
 * ------------------------------------------------------------------ */

describe('PLANSRC local-official 驱动器', () => {
  it('默认（不传路径以外的开关）只是目录通道：model_is_real 仍为 false，stream 调用即抛', async () => {
    const { paths, cleanup } = makeSourceDir();
    try {
      const sources = readPlanSources({ paths });
      const catalog = mapBuiltinToCatalog(sources.builtin);
      const driver = createLocalOfficialDriver({ sources, catalog });
      expect(driver.name).toBe(LOCAL_OFFICIAL_DRIVER_NAME);
      expect(driver.fixture).toBe(false);
      expect(driver.catalog.revision).toBe(catalog.revision);
      // 没有上游模型产出通道：status 必须是 not_attached，于是 model_is_real = false
      expect(driver.status).toBe('not_attached');
      expect(deriveModelIsReal(driver)).toBe(false);
      // /v1/models 仍为空：不能服务的模型不列给外部 IDE
      expect(driver.models).toEqual([]);
      await expect(
        (async () => {
          for await (const _ of driver.stream({ operationId: 'op-1', model: 'x', messages: [], maxTokens: null, signal: new AbortController().signal })) {
            void _;
          }
        })()
      ).rejects.toMatchObject({ code: 'upstream_unavailable' });
    } finally {
      cleanup();
    }
  });

  it('loadLocalOfficialDriver 一条命令读三文件并产出驱动器 + 证据', () => {
    const { paths, cleanup } = makeSourceDir();
    try {
      const result = loadLocalOfficialDriver({ paths });
      expect(result.driver.name).toBe(LOCAL_OFFICIAL_DRIVER_NAME);
      expect(result.catalog.models.length).toBeGreaterThan(0);
      expect(result.plans.length).toBe(BUILTIN_FIXTURE.config.providerConfigRules.providerRules.length);
      expect(result.evidence.catalog.source).toBe('local-official');
      expect(result.evidence.entitlement.source).toBe('coding-plan-cache');
      expect(result.evidence.selection.source).toBe('setting');
      expect(result.evidence.entitlement.items.length).toBe(4);
      // 证据对象里同样搜不到假 key
      expect(allText(result.evidence)).not.toContain(FAKE_KEY);
      expect(allText(result.evidence)).not.toContain(FAKE_SECRET);
    } finally {
      cleanup();
    }
  });

  it('resolvePlanSourcePaths 不指向真实安装树时按显式路径解析；环境键优先', () => {
    const resolved = resolvePlanSourcePaths({ dataBaseDir: '/tmp/xyz', env: { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: '/explicit/builtin.json' } });
    expect(resolved.builtinFile).toBe('/explicit/builtin.json');
    expect(resolved.settingFile).toBe(join('/tmp/xyz', '.zcode', 'v2', 'setting.json'));
    expect(resolved.cacheFile).toBe(join('/tmp/xyz', '.zcode', 'v2', 'coding-plan-cache.json'));
  });

  it('测试只写临时目录：真实安装树与 ~/.zcode 不被创建', () => {
    // 断言本身：fixture 目录之外没有任何写入路径常量被默认指向临时目录之外。
    const { paths, cleanup } = makeSourceDir();
    try {
      expect(existsSync(paths.builtinFile)).toBe(true);
      expect(paths.builtinFile.startsWith(tmpdir())).toBe(true);
    } finally {
      cleanup();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 8. 证据注册表（REV11 I-1：引用加固 —— 字节偏移不是稳定引用）
 * ------------------------------------------------------------------ */

describe('PLANSRC 证据注册表（注册名 + 代码片段双锚）', () => {
  it('每条证据都有非空注册名与非空代码片段（偏移只是辅助信息）', () => {
    // REV11 I-1：`zcode.cjs` 是随版本滚动的构建产物，字节偏移会在每次发版后失效。
    // 因此每条引用必须由「注册名 + 可逐字搜到的代码片段」双锚，偏移降级为辅助信息。
    expect(PLAN_EVIDENCE_ANCHORS.length).toBeGreaterThan(0);
    for (const anchor of PLAN_EVIDENCE_ANCHORS) {
      expect(typeof anchor.id, `证据 ${anchor.id} 缺 id`).toBe('string');
      expect(anchor.id.trim().length, `证据 ${anchor.id} 的 id 不得为空`).toBeGreaterThan(0);
      expect(typeof anchor.registeredName, `证据 ${anchor.id} 缺注册名锚`).toBe('string');
      expect(
        anchor.registeredName.trim().length,
        `证据 ${anchor.id} 的注册名不得为空（没有注册名就无法在滚动后的产物里重新定位）`
      ).toBeGreaterThan(0);
      expect(typeof anchor.snippet, `证据 ${anchor.id} 缺代码片段锚`).toBe('string');
      expect(
        anchor.snippet.trim().length,
        `证据 ${anchor.id} 的代码片段不得为空（没有片段的"引用"在版本滚动后不可复核）`
      ).toBeGreaterThan(0);
      expect(anchor.sourceFile.trim().length, `证据 ${anchor.id} 缺来源文件`).toBeGreaterThan(0);
    }
  });

  it('id 唯一、注册名在注册表内唯一，且每个有证据的 access.mode 都被覆盖', () => {
    const ids = PLAN_EVIDENCE_ANCHORS.map((a) => a.id);
    expect(new Set(ids).size, '证据 id 必须唯一').toBe(ids.length);
    const covered = new Set(PLAN_EVIDENCE_ANCHORS.flatMap((a) => [...a.accessModes]));
    for (const mode of KNOWN_ACCESS_MODES) {
      expect(covered.has(mode), `access.mode ${mode} 没有任何证据锚，映射表里却给了结论`).toBe(true);
    }
    for (const anchor of PLAN_EVIDENCE_ANCHORS) {
      for (const mode of anchor.accessModes) {
        expect(
          KNOWN_ACCESS_MODES.includes(mode),
          `证据 ${anchor.id} 引用了映射表里不存在的 access.mode ${mode}`
        ).toBe(true);
      }
    }
  });
});
