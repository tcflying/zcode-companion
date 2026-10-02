/**
 * OFFICIAL-HOST · 反向请求应答器（`scripts/official-host/reverse-responder.mjs`）纯函数单测。
 *
 * ## 这份文件钉什么
 *
 * 端到端那几条（`official-host-stub-bundle.test.mjs` 的 HOSTFIX3 段）证明的是**时序**：
 * 官方来要 → 我们答 → 才放行。这份文件证明的是**每一个分支都不会出错子**：
 *
 *  1. 判别只认那一条帧（应答帧 / 通知帧 / 非对象都不误判）。
 *  2. providerId 不一致 → 拒答（跨通道挪用闸门）。
 *  3. `shouldRefreshBeforeModelRequest` 返回假 → 拒答（官方已问，必须给肯定答复）。
 *  4. port 抛 `HeadersPortError` → 拒答，且**只带结构化 code/detail**。
 *  5. port 抛未知错误 → 拒答，且**不附原始异常**。
 *  6. port 返回值不满足 `DGt` 必需条件 → 拒答。
 *  7. **形状对齐**：应答帧逐字只有 `{id, result}`；`result.requestAuth` 逐字只有 `apiKey`
 *     （我们 port 那个多一个 `entryKey`，而且带一个会抛错的 `toJSON`——
 *     直接序列化会炸，`DGt` 的 `.strict()` 也会拒）。
 *  8. 零凭据：任何一条分支产出的 `errorMessage` 里都搜不到凭据片段。
 *
 * 官方出处（`C:\ZCode\resources\glm\zcode.cjs`，只读，偏移为字符偏移）：
 *  - `va` 枚举偏移 787197 逐字 `interactionRequestProviderRuntimeHeaders:"interaction/requestProviderRuntimeHeaders"`
 *  - `qir`（请求帧）偏移 735526 / `Vir`（应答帧）偏移 735705，都 `.strict()`
 *  - `DGt`（应答 result schema，注册名 `zcodeProviderRuntimeHeadersResponseSchema`）偏移 769026
 *  - `fUi`（请求 params schema）偏移 769026 同段
 *  - `tat` 偏移 4014209 逐字 `if (!o.headersApplied || !o.requestAuth) throw …`
 */
import { describe, it, expect } from 'vitest';
import {
  buildProviderRuntimeHeadersRequest,
  isProviderRuntimeHeadersRequest,
  isSessionRequestRuntimePreferencesRequest,
  isToolPermissionRequest,
  isUserInputRequest,
  HOST_TOOL_POLICIES,
  HOST_TOOL_POLICY_ENV_KEY,
  PERMISSION_DECISIONS,
  REFUSAL_MESSAGE_MAX,
  REVERSE_REFUSAL_CODES,
  REVERSE_REQUEST_PERMISSION,
  REVERSE_REQUEST_PROVIDER_RUNTIME_HEADERS,
  REVERSE_REQUEST_RUNTIME_PREFERENCES,
  REVERSE_REQUEST_USER_INPUT,
  REVERSE_RUNTIME_PREFERENCES_SCOPES,
  resolveHostToolPolicy,
  resolveProviderRuntimeHeadersResponse,
  resolveSessionRuntimePreferencesResponse,
  resolveToolPermissionResponse,
  resolveUserInputResponse,
  RUNTIME_PREFERENCES_DEFAULT_MODEL_CONTEXT_BUDGET_STRATEGY,
  RUNTIME_PREFERENCES_FAIL_CLOSED,
  RUNTIME_PREFERENCES_MODEL_CONTEXT_BUDGET_STRATEGIES,
  RUNTIME_PREFERENCES_REQUEST_FIELDS,
  RUNTIME_PREFERENCES_RESULT_FIELDS,
  USER_INPUT_ACTIONS
} from '../../scripts/official-host/reverse-responder.mjs';
// COMPAT1/C4：`mode` 的闭集与两个 env 解析器**从生产代码 import**，测试不硬写第二份
// （`reverse-responder.mjs` 本身也是从 `host-driver.ts` 重导出的——单一出处）。
import {
  DEFAULT_HOST_PERMISSION_MODE,
  HOST_PERMISSION_MODE_ENV_KEY,
  OFFICIAL_SESSION_MODES,
  resolveHostPermissionMode
} from '../../packages/official-host/src/host-driver.js';
import { createHeadersPort, HeadersPortError } from '../../packages/official-host/src/headers-port.js';
import { CredentialValue } from '../../packages/official-host/src/credentials.js';

/** 合成明文。它绝不该出现在任何一条 `errorMessage` / 摘要里。 */
const SYNTHETIC_PLAINTEXT = 'zcc-responder-unit-synthetic-secret-value';
/** 测试私钥。不是任何真实 secret。 */
const TEST_SECRET = 'zcc-responder-unit-test-secret';

/**
 * 造一帧官方形状的反向请求。默认逐字对齐官方 `fUi`。
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, any>}
 */
function reverseRequest(overrides = {}) {
  return {
    ...buildProviderRuntimeHeadersRequest({
      id: 'server-1',
      requestId: 'sess-1:provider-runtime-headers:uuid',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      workspace: { workspaceKey: 'C:/synthetic/ws', workspacePath: 'C:/synthetic/ws' },
      providerId: 'account:zai-start-plan',
      modelId: 'GLM-5.3-Flash',
      accountAccess: { type: 'zhipu-account', accountType: 'zai', mode: 'start-plan', entitled: true },
      reason: 'model-request'
    }),
    ...overrides
  };
}

/**
 * 一个会成功返回 `requestAuth` 的假 port。**形状与 `createHeadersPort` 逐字一致**，
 * 包括 `requestAuth` 上那个会抛错的 `toJSON`（用来证明我们没有直接序列化它）。
 *
 * @param {string} [apiKey]
 */
function okPort(apiKey = SYNTHETIC_PLAINTEXT) {
  return {
    shouldRefreshBeforeModelRequest: () => true,
    refreshBeforeModelRequest: () => ({
      headersApplied: true,
      requestAuth: {
        apiKey,
        entryKey: 'zcodejwttoken',
        toJSON() {
          throw new Error('toJSON trap: 不许被直接序列化');
        }
      }
    })
  };
}

describe('OFFICIAL-HOST · 反向请求判别', () => {
  it('官方那一条帧被认出（`id` + `method` + 对象 `params` 三条同时成立）', () => {
    expect(isProviderRuntimeHeadersRequest(reverseRequest())).toBe(true);
  });

  it('官方字面量逐字一致（改一个字就不再是它）', () => {
    expect(REVERSE_REQUEST_PROVIDER_RUNTIME_HEADERS).toBe('interaction/requestProviderRuntimeHeaders');
    expect(isProviderRuntimeHeadersRequest(reverseRequest({ method: 'interaction/requestProviderRuntimeHeader' }))).toBe(false);
    expect(isProviderRuntimeHeadersRequest(reverseRequest({ method: 'interaction/requestPermission' }))).toBe(false);
  });

  it('**应答帧不会被误判**（`{id, result}` 没有 `method`）', () => {
    expect(isProviderRuntimeHeadersRequest({ id: 'server-1', result: { headersApplied: true, requestAuth: { apiKey: 'x' } } })).toBe(false);
  });

  it('通知帧、请求帧、空 `id`、缺 `params`、非对象一律不认', () => {
    expect(isProviderRuntimeHeadersRequest({ method: 'session/event', params: { type: 'part.delta' } })).toBe(false);
    expect(isProviderRuntimeHeadersRequest({ id: 'zcc-host-op-1', method: REVERSE_REQUEST_PROVIDER_RUNTIME_HEADERS })).toBe(false);
    expect(isProviderRuntimeHeadersRequest({ id: '  ', method: REVERSE_REQUEST_PROVIDER_RUNTIME_HEADERS, params: {} })).toBe(false);
    expect(isProviderRuntimeHeadersRequest({ id: 'server-1', method: REVERSE_REQUEST_PROVIDER_RUNTIME_HEADERS, params: null })).toBe(false);
    expect(isProviderRuntimeHeadersRequest(null)).toBe(false);
    expect(isProviderRuntimeHeadersRequest('session/event')).toBe(false);
  });
});

describe('OFFICIAL-HOST · 反向请求应答：放行分支', () => {
  it('**帧逐字只有 `{id, result}`**，result 逐字对齐官方 `DGt`', async () => {
    const { frame, summary } = await resolveProviderRuntimeHeadersResponse({
      frame: reverseRequest(),
      port: okPort(),
      expectedProviderId: 'account:zai-start-plan'
    });
    expect(Object.keys(frame).sort()).toEqual(['id', 'result']);
    expect(frame.id).toBe('server-1');
    expect(Object.keys(/** @type {any} */ (frame.result).requestAuth).sort()).toEqual(['apiKey']);
    expect(/** @type {any} */ (frame.result).headersApplied).toBe(true);
    expect(summary).toEqual({ id: 'server-1', providerIdMatched: true, headersApplied: true, refusalCode: null });
  });

  it('**不把 port 的 `requestAuth` 直接序列化**（它带会抛的 `toJSON`、多一个 `entryKey`）', async () => {
    const { frame } = await resolveProviderRuntimeHeadersResponse({
      frame: reverseRequest(),
      port: okPort(),
      expectedProviderId: 'account:zai-start-plan'
    });
    // 直接 `JSON.stringify(port 的对象)` 会炸；我们的产物不会。
    const wire = JSON.stringify(frame);
    expect(wire).toContain(SYNTHETIC_PLAINTEXT);
    // `entryKey` 不上 wire（`DGt` 的 `requestAuth` 是 `.strict()` 的）。
    expect(wire).not.toContain('entryKey');
    expect(wire).not.toContain('zcodejwttoken');
    // 官方 `fTt.decodeLine` 逐字先过 `qHt.safeParse`，`.strict()` 失败就发 `-32600`。
    expect(Object.keys(JSON.parse(wire)).sort()).toEqual(['id', 'result']);
  });

  it('**真的用生产 port**：白名单内的 providerId 走通 `createHeadersPort` 产出的对象', async () => {
    const port = createHeadersPort({
      providerId: 'account:zai-start-plan',
      planKind: 'start-plan',
      family: 'zai',
      // 自注入取键：**合成**值，不碰任何真实仓。走真的 `CredentialValue`
      // （它的 `#plaintext` 是真私有字段 + `toJSON` 抛错，正是我们要守住的那道）。
      resolveCredential: () => new CredentialValue('zcodejwttoken', SYNTHETIC_PLAINTEXT)
    });
    const { frame, summary } = await resolveProviderRuntimeHeadersResponse({
      frame: reverseRequest(),
      port,
      expectedProviderId: 'account:zai-start-plan'
    });
    expect(summary.headersApplied).toBe(true);
    expect(JSON.parse(JSON.stringify(frame)).result.requestAuth.apiKey).toBe(SYNTHETIC_PLAINTEXT);
  });

  it('官方传给 port 的实参形状逐字对齐 `ZJo`（providerId / modelId / sessionId / reason）', async () => {
    /** @type {any[]} */
    const seen = [];
    await resolveProviderRuntimeHeadersResponse({
      frame: reverseRequest(),
      port: {
        shouldRefreshBeforeModelRequest: () => true,
        // 测试替身：只记录实参形状。
        refreshBeforeModelRequest: (/** @type {unknown} */ n) => {
          seen.push(n);
          return { headersApplied: true, requestAuth: { apiKey: 'x' } };
        }
      },
      expectedProviderId: 'account:zai-start-plan'
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].providerId).toBe('account:zai-start-plan');
    expect(seen[0].modelId).toBe('GLM-5.3-Flash');
    expect(seen[0].sessionId).toBe('sess-1');
    expect(seen[0].turnId).toBe('turn-1');
    expect(seen[0].reason).toBe('model-request');
    expect(seen[0].accountAccess).toEqual({ type: 'zhipu-account', accountType: 'zai', mode: 'start-plan', entitled: true });
  });
});

describe('OFFICIAL-HOST · 反向请求应答：拒答分支（fail-closed）', () => {
  it('**跨通道挪用**：providerId 不是本次会话那一个 → `PROVIDER_MISMATCH`', async () => {
    let called = false;
    const { frame, summary } = await resolveProviderRuntimeHeadersResponse({
      frame: reverseRequest(),
      port: {
        shouldRefreshBeforeModelRequest: () => true,
        refreshBeforeModelRequest: () => {
          called = true;
          return { headersApplied: true, requestAuth: { apiKey: SYNTHETIC_PLAINTEXT } };
        }
      },
      expectedProviderId: 'account:zai-individual-coding-plan'
    });
    // **取键根本不该被调用**——判定在它之前。
    expect(called).toBe(false);
    expect(summary.refusalCode).toBe('PROVIDER_MISMATCH');
    expect(summary.headersApplied).toBe(false);
    expect(/** @type {any} */ (frame.result).headersApplied).toBe(false);
    expect(typeof /** @type {any} */ (frame.result).errorMessage).toBe('string');
    expect(String(/** @type {any} */ (frame.result).errorMessage)).toContain('PROVIDER_MISMATCH');
  });

  it('`shouldRefreshBeforeModelRequest` 返回假 → `HEADERS_PORT_DECLINED`（官方已问，不能不答）', async () => {
    const { frame, summary } = await resolveProviderRuntimeHeadersResponse({
      frame: reverseRequest(),
      port: {
        shouldRefreshBeforeModelRequest: () => false,
        refreshBeforeModelRequest: () => {
          throw new Error('不该被调用');
        }
      },
      expectedProviderId: 'account:zai-start-plan'
    });
    expect(summary.refusalCode).toBe('HEADERS_PORT_DECLINED');
    expect(/** @type {any} */ (frame.result).headersApplied).toBe(false);
  });

  it('port 抛 `HeadersPortError` → `HEADERS_PORT_FAILED`，且只搬运结构化 code/detail', async () => {
    const { frame, summary } = await resolveProviderRuntimeHeadersResponse({
      frame: reverseRequest(),
      port: {
        shouldRefreshBeforeModelRequest: () => true,
        refreshBeforeModelRequest: () => {
          throw new HeadersPortError('CHANNEL_BLOCKED', 'account:zai-start-plan', 'providerId 命中付费通道黑名单，拒绝注入（未取键、未解密、未触网）');
        }
      },
      expectedProviderId: 'account:zai-start-plan'
    });
    expect(summary.refusalCode).toBe('HEADERS_PORT_FAILED');
    const message = String(/** @type {any} */ (frame.result).errorMessage);
    expect(message).toContain('CHANNEL_BLOCKED');
    // providerId 不回显（回显它没有诊断价值，却多一处能被塞进秘密的面）。
    expect(message).not.toContain('account:zai-start-plan');
  });

  it('port 抛未知错误 → `UNEXPECTED`，**不附原始异常**', async () => {
    const { frame, summary } = await resolveProviderRuntimeHeadersResponse({
      frame: reverseRequest(),
      port: {
        shouldRefreshBeforeModelRequest: () => true,
        refreshBeforeModelRequest: () => {
          throw new Error(`LEAK-CANARY-原始异常里塞了秘密 ${SYNTHETIC_PLAINTEXT}`);
        }
      },
      expectedProviderId: 'account:zai-start-plan'
    });
    expect(summary.refusalCode).toBe('UNEXPECTED');
    const message = String(/** @type {any} */ (frame.result).errorMessage);
    expect(message).not.toContain(SYNTHETIC_PLAINTEXT);
    expect(message).not.toContain('LEAK-CANARY');
  });

  it('port 返回值不满足 `DGt` 必需条件 → `HEADERS_PORT_SHAPE_INVALID`', async () => {
    for (const bad of [
      { headersApplied: false, requestAuth: { apiKey: SYNTHETIC_PLAINTEXT } },
      { headersApplied: true, requestAuth: null },
      { headersApplied: true, requestAuth: { apiKey: '   ' } },
      { headersApplied: true },
      { headersApplied: true, requestAuth: { apiKey: 123 } }
    ]) {
      const { summary } = await resolveProviderRuntimeHeadersResponse({
        frame: reverseRequest(),
        port: { shouldRefreshBeforeModelRequest: () => true, refreshBeforeModelRequest: () => bad },
        expectedProviderId: 'account:zai-start-plan'
      });
      expect(summary.refusalCode).toBe('HEADERS_PORT_SHAPE_INVALID');
      expect(summary.headersApplied).toBe(false);
    }
  });

  it('**异步 port 也支持**（官方 `ZJo` 的 `refreshBeforeModelRequest` 是 async）', async () => {
    const { frame, summary } = await resolveProviderRuntimeHeadersResponse({
      frame: reverseRequest(),
      port: {
        shouldRefreshBeforeModelRequest: () => true,
        refreshBeforeModelRequest: async () => ({ headersApplied: true, requestAuth: { apiKey: SYNTHETIC_PLAINTEXT } })
      },
      expectedProviderId: 'account:zai-start-plan'
    });
    expect(summary.headersApplied).toBe(true);
    expect(/** @type {any} */ (frame.result).requestAuth.apiKey).toBe(SYNTHETIC_PLAINTEXT);
  });
});

describe('OFFICIAL-HOST · 反向请求应答：零凭据与闭集', () => {
  it('**每一条拒答分支的 `errorMessage` 里都没有凭据片段**', async () => {
    const ports = [
      { shouldRefreshBeforeModelRequest: () => true, refreshBeforeModelRequest: () => { throw new Error(SYNTHETIC_PLAINTEXT); } },
      { shouldRefreshBeforeModelRequest: () => true, refreshBeforeModelRequest: () => ({ headersApplied: false, requestAuth: { apiKey: SYNTHETIC_PLAINTEXT } }) },
      { shouldRefreshBeforeModelRequest: () => false, refreshBeforeModelRequest: () => ({ headersApplied: true, requestAuth: { apiKey: SYNTHETIC_PLAINTEXT } }) }
    ];
    for (const port of ports) {
      const { frame, summary } = await resolveProviderRuntimeHeadersResponse({
        frame: reverseRequest(),
        port,
        expectedProviderId: 'account:zai-start-plan'
      });
      const message = String(/** @type {any} */ (frame.result).errorMessage);
      expect(message).not.toContain(SYNTHETIC_PLAINTEXT);
      expect(message).not.toContain(TEST_SECRET);
      expect(message.length).toBeLessThanOrEqual(REFUSAL_MESSAGE_MAX);
      // 摘要里也没有。
      expect(JSON.stringify(summary)).not.toContain(SYNTHETIC_PLAINTEXT);
    }
  });

  it('**拒答码是闭集**，且 `errorMessage` 以拒答码开头（可运维、可断言）', async () => {
    const { frame, summary } = await resolveProviderRuntimeHeadersResponse({
      frame: reverseRequest(),
      port: okPort(),
      expectedProviderId: 'account:other-plan'
    });
    expect(REVERSE_REFUSAL_CODES).toContain(summary.refusalCode);
    expect(String(/** @type {any} */ (frame.result).errorMessage).startsWith(`${summary.refusalCode}:`)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* HOSTFIX4：`session/requestRuntimePreferences`                                  */
/* -------------------------------------------------------------------------- */

/**
 * 造一帧官方形状的偏好请求。逐字对齐官方 `G5i`（偏移 759235）
 * `m.object({sessionId:Dn,scope:jsr}).strict()`，其中 `Dn = m.string().trim().min(1)`、
 * `jsr = m.enum(["runtime-materialization","user-execution"])`（偏移 759169）。
 *
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, any>}
 */
function preferencesRequest(overrides = {}) {
  return {
    id: 'server-1',
    method: REVERSE_REQUEST_RUNTIME_PREFERENCES,
    params: { sessionId: 'sess-1', scope: 'runtime-materialization' },
    ...overrides
  };
}

describe('OFFICIAL-HOST · HOSTFIX4 偏好请求：判别', () => {
  it('官方那一条帧被认出；字面量逐字一致（改一个字就不再是它）', () => {
    expect(REVERSE_REQUEST_RUNTIME_PREFERENCES).toBe('session/requestRuntimePreferences');
    expect(isSessionRequestRuntimePreferencesRequest(preferencesRequest())).toBe(true);
    expect(
      isSessionRequestRuntimePreferencesRequest(preferencesRequest({ method: 'session/requestRuntimePreference' }))
    ).toBe(false);
    expect(isSessionRequestRuntimePreferencesRequest(preferencesRequest({ method: 'session/create' }))).toBe(false);
  });

  it('**与凭据那条判别互斥**（两条 method 字面量不同，谁也不会认错谁）', () => {
    expect(isProviderRuntimeHeadersRequest(preferencesRequest())).toBe(false);
    expect(isSessionRequestRuntimePreferencesRequest(reverseRequest())).toBe(false);
  });

  it('通知帧、空 `id`、非对象一律不认', () => {
    expect(isSessionRequestRuntimePreferencesRequest({ method: REVERSE_REQUEST_RUNTIME_PREFERENCES, params: {} })).toBe(
      false
    );
    expect(
      isSessionRequestRuntimePreferencesRequest({ id: '  ', method: REVERSE_REQUEST_RUNTIME_PREFERENCES, params: {} })
    ).toBe(false);
    expect(isSessionRequestRuntimePreferencesRequest(null)).toBe(false);
    expect(isSessionRequestRuntimePreferencesRequest('session/requestRuntimePreferences')).toBe(false);
  });

  it('**`params` 缺失也认**——因为应答值与请求参数无关，认出来就必须答', () => {
    // 官方 `CKo`（偏移 14509003）的 catch 对 `-32022` 是 `throw l`：
    // **"不答"在这里不是 fail-closed，是 fail-fatal**——15 秒后整轮 `session/create`
    // 抛掉、拿不到 sessionId。所以判别刻意**不**要求 params 是对象。
    expect(isSessionRequestRuntimePreferencesRequest({ id: 'server-1', method: REVERSE_REQUEST_RUNTIME_PREFERENCES })).toBe(
      true
    );
  });
});

describe('OFFICIAL-HOST · HOSTFIX4 偏好请求：应答形状逐字段对齐官方 `pGt`', () => {
  it('**帧逐字只有 `{id, result}`**（官方 `Vir` 偏移 735705，`.strict()`）', () => {
    const { frame } = resolveSessionRuntimePreferencesResponse({ frame: preferencesRequest() });
    expect(Object.keys(frame).sort()).toEqual(['id', 'result']);
    // 官方 `pTt.resolveClientRequest` 逐字 `String(t)` 查表 → id 必须原样回。
    expect(frame.id).toBe('server-1');
    // `JSON.stringify` 必须成功（`qHt.safeParse` 之前还有 `JSON.parse`）。
    expect(Object.keys(JSON.parse(JSON.stringify(frame))).sort()).toEqual(['id', 'result']);
  });

  it('**result 逐字段对齐官方 `pGt`**（偏移 759339，跨度 759339..759588）', () => {
    // 官方逐字：
    //   pGt=m.object({nativeSearchEnhancementsEnabled:m.boolean(),memoryEnabled:m.boolean().default(!1),
    //   askUserQuestionAutoResolutionEnabled:m.boolean().default(!0),integratedTerminalShell:aYe.optional(),
    //   modelContextBudgetStrategy:Bsr.default(WO)}).strict()
    const { frame } = resolveSessionRuntimePreferencesResponse({ frame: preferencesRequest() });
    const result = frame.result;
    // 我们只回这三个，且逐字是 `pGt` 里的**同名**字段。`.strict()` 之下**多一个键就非法**。
    expect(Object.keys(result).sort()).toEqual([
      'askUserQuestionAutoResolutionEnabled',
      'memoryEnabled',
      'nativeSearchEnhancementsEnabled'
    ]);
    for (const k of Object.keys(result)) expect(RUNTIME_PREFERENCES_RESULT_FIELDS).toContain(k);
    // `nativeSearchEnhancementsEnabled` 是 `pGt` 里**唯一**没有 `.default()` 的字段 → 必填布尔。
    expect(typeof result.nativeSearchEnhancementsEnabled).toBe('boolean');
    expect(typeof result.memoryEnabled).toBe('boolean');
    expect(typeof result.askUserQuestionAutoResolutionEnabled).toBe('boolean');
  });

  it('**三个值全 `false`（fail-closed），且刻意偏离官方的兜底默认值**', () => {
    const { frame } = resolveSessionRuntimePreferencesResponse({ frame: preferencesRequest() });
    expect(frame.result).toEqual({
      nativeSearchEnhancementsEnabled: false,
      memoryEnabled: false,
      askUserQuestionAutoResolutionEnabled: false
    });
    // 官方 `CKo` 对 -32601/-32020 的兜底逐字是
    // `{askUserQuestionAutoResolutionEnabled:!0, memoryEnabled:!1, modelContextBudgetStrategy:WO, nativeSearchEnhancementsEnabled:!0}`
    // ——那两个 `!0` 都是**宽松**方向（开原生搜索增强、开 askUserQuestion 自动放行）。
    // 我们是 headless 子宿主：没有原生搜索面、没有 memory 后端、**没有交互式用户输入通道**；
    // 自动放行等于"官方替用户做决定"。所以那两条必须反过来。
    expect(RUNTIME_PREFERENCES_FAIL_CLOSED.nativeSearchEnhancementsEnabled).toBe(false);
    expect(RUNTIME_PREFERENCES_FAIL_CLOSED.askUserQuestionAutoResolutionEnabled).toBe(false);
    // 内存这一条与官方兜底一致（两边都是关），但仍要钉住。
    expect(RUNTIME_PREFERENCES_FAIL_CLOSED.memoryEnabled).toBe(false);
    expect(Object.isFrozen(RUNTIME_PREFERENCES_FAIL_CLOSED)).toBe(true);
  });

  it('**只省略两个字段，且省略是安全的**（逐字依据见 reverse-responder.mjs 字段表）', () => {
    const { frame } = resolveSessionRuntimePreferencesResponse({ frame: preferencesRequest() });
    // `integratedTerminalShell`（`aYe.optional()`，偏移 716367）：省略 → 官方 `TXa`
    // （偏移 14508688）逐字 `if(!(!e||e.mode==="auto")) return {…}` 返回 `undefined`
    // → `IXa` 不覆盖用户配置，回落官方默认 shell。
    expect(frame.result).not.toHaveProperty('integratedTerminalShell');
    // `modelContextBudgetStrategy`（`Bsr.default("preflight-v1")`）：官方 `CXa`（偏移 14510354）
    // 逐字**丢弃**它（`return {memoryEnabled: s.memoryEnabled, modelContextBudgetStrategy: WO, …}`，
    // 恒用 `WO`），写了也白写；省略后 `pGt.parse` 自己补成 `WO`。
    expect(frame.result).not.toHaveProperty('modelContextBudgetStrategy');
    // 闭集常量本身也被钉住（供替身夹具与文档引用）。
    expect(RUNTIME_PREFERENCES_MODEL_CONTEXT_BUDGET_STRATEGIES).toEqual(['legacy', 'preflight-v1']);
    expect(RUNTIME_PREFERENCES_DEFAULT_MODEL_CONTEXT_BUDGET_STRATEGY).toBe('preflight-v1');
    // 官方 `pGt` 的字段全表（`.strict()` 之下的全集）也被钉住——**不多不少**。
    expect(RUNTIME_PREFERENCES_RESULT_FIELDS).toEqual([
      'nativeSearchEnhancementsEnabled',
      'memoryEnabled',
      'askUserQuestionAutoResolutionEnabled',
      'integratedTerminalShell',
      'modelContextBudgetStrategy'
    ]);
  });

  it('**返回值是新建对象，不是模块级冻结常量**（调用方改不动我们的常量）', () => {
    const a = resolveSessionRuntimePreferencesResponse({ frame: preferencesRequest() });
    const b = resolveSessionRuntimePreferencesResponse({ frame: preferencesRequest() });
    expect(a.frame.result).not.toBe(b.frame.result);
    // 调用方就算强行改了自己的副本，也**改不到**模块级常量。
    a.frame.result.memoryEnabled = true;
    expect(resolveSessionRuntimePreferencesResponse({ frame: preferencesRequest() }).frame.result.memoryEnabled).toBe(false);
  });
});

describe('OFFICIAL-HOST · HOSTFIX4 偏好请求：两个 scope 都应答、零凭据、闭集不变', () => {
  it('**`runtime-materialization` 与 `user-execution` 都应答**，且应答内容与 scope 无关', () => {
    // 官方 `jsr`（偏移 759169）逐字 `m.enum(["runtime-materialization","user-execution"])`。
    expect(REVERSE_RUNTIME_PREFERENCES_SCOPES).toEqual(['runtime-materialization', 'user-execution']);
    const results = REVERSE_RUNTIME_PREFERENCES_SCOPES.map((scope) =>
      resolveSessionRuntimePreferencesResponse({ frame: preferencesRequest({ params: { sessionId: 'sess-1', scope } }) })
    );
    // 官方 `CXa` 对两个 scope 走的是**同一个** `CKo`、同一份 `pGt`。
    const [first, second] = results;
    expect(first === undefined ? null : first.frame.result).toEqual(second === undefined ? null : second.frame.result);
    expect(results.map((r) => r.summary.scope)).toEqual(['runtime-materialization', 'user-execution']);
    for (const r of results) expect(r.summary.requestShapeValid).toBe(true);
  });

  it('**请求形状不合法也照样应答**（形状只进摘要，不参与判定——不答就是 15 秒后整轮失败）', () => {
    for (const params of [
      undefined,
      null,
      {},
      { sessionId: '' },
      { sessionId: 123, scope: 'runtime-materialization' },
      { sessionId: 'sess-1', scope: 'not-a-real-scope' },
      { sessionId: 'sess-1', scope: 'runtime-materialization', extra: 1 }
    ]) {
      const { frame, summary } = resolveSessionRuntimePreferencesResponse({
        frame: { id: 'server-1', method: REVERSE_REQUEST_RUNTIME_PREFERENCES, params }
      });
      // **必然应答**，且形状恒定。
      expect(Object.keys(frame).sort()).toEqual(['id', 'result']);
      expect(frame.result).toEqual({
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: false
      });
      // 形状问题**只**被记下来，不改变应答。
      expect(summary.requestShapeValid).toBe(false);
      expect(summary.answered).toBe(true);
    }
    // 逐字 `G5i`（偏移 759235）`m.object({sessionId:Dn,scope:jsr}).strict()` —— 字段表也钉住。
    expect(RUNTIME_PREFERENCES_REQUEST_FIELDS).toEqual(['sessionId', 'scope']);
  });

  it('**零凭据**：应答帧与摘要里搜不到任何凭据片段，摘要字段是闭集**', () => {
    const { frame, summary } = resolveSessionRuntimePreferencesResponse({
      frame: preferencesRequest({
        params: { sessionId: 'sess-1', scope: 'runtime-materialization', apiKey: SYNTHETIC_PLAINTEXT }
      })
    });
    const wire = JSON.stringify(frame);
    expect(wire).not.toContain(SYNTHETIC_PLAINTEXT);
    expect(wire).not.toContain(TEST_SECRET);
    expect(JSON.stringify(summary)).not.toContain(SYNTHETIC_PLAINTEXT);
    // 摘要字段是闭集：id / method / scope / requestShapeValid / answered。**没有** providerId 回显。
    expect(Object.keys(summary).sort()).toEqual(['answered', 'id', 'method', 'requestShapeValid', 'scope']);
    expect(summary.method).toBe(REVERSE_REQUEST_RUNTIME_PREFERENCES);
    expect(summary.answered).toBe(true);
  });

  it('**拒答码闭集不变**（本分支不新增任何拒答码——官方那条路上"拒答"不是存在的姿势）', () => {
    // 官方 `CKo` 的 catch 逐字只对 `-32601` / `-32020` 返回默认对象，其余 `throw l`。
    // 所以偏好这条**没有** fail-closed 的拒答姿势，只能答。
    expect(REVERSE_REFUSAL_CODES).toEqual([
      'PROVIDER_MISMATCH',
      'HEADERS_PORT_DECLINED',
      'HEADERS_PORT_FAILED',
      'HEADERS_PORT_SHAPE_INVALID',
      'UNEXPECTED'
    ]);
    expect(REVERSE_REFUSAL_CODES).toHaveLength(5);
  });
});

/* -------------------------------------------------------------------------- */
/* COMPAT1/C4：工具权限 / 用户输入两条反向请求应答                              */
/* -------------------------------------------------------------------------- */

/**
 * 官方出处（`C:\ZCode\resources\glm\zcode.cjs`，**只读**，偏移为字符偏移）：
 *  - `va` 枚举偏移 787107 / 787167 逐字
 *    `interactionRequestPermission:"interaction/requestPermission"` /
 *    `interactionRequestUserInput:"interaction/requestUserInput"`
 *  - 权限请求 params `dUi` 偏移 767390、应答 `JL` 偏移 650914（都 `.strict()`）
 *  - 用户输入请求 params `pUi` 偏移 768496、应答 `CYe` 偏移 768638（都 `.strict()`）
 *  - `pTt.requestClient` 偏移 14668930 逐字
 *    `s?.timeoutMs!==void 0 && (f.timeout=setTimeout(...))` —— 权限/输入经 `dRn`
 *    （偏移 14447817）**没有** `timeoutMs`，所以"不答"不是 15 秒超时，是**永不落定**
 *  - `checkPermission` 偏移 5092771 逐字
 *    `return t.mode==="yolo"&&!u ? this.allow(t,a,"mode.yolo","Yolo mode bypasses permission prompts") : t.mode==="auto" ? this.deny(t,a,"mode.auto.unimplemented","Auto mode is reserved but not implemented yet") : ...`
 */
describe('OFFICIAL-HOST · COMPAT1/C4 工具权限 / 用户输入应答', () => {
  /**
   * 造一帧逐字对齐官方 `dUi`（偏移 767390）的权限请求。
   * @param {Record<string, unknown>} [overrides]
   * @returns {Record<string, any>}
   */
  const permissionRequest = (overrides = {}) => ({
    id: 'server-9',
    method: REVERSE_REQUEST_PERMISSION,
    params: {
      requestId: 'req-1',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
      toolName: 'Bash',
      reason: 'needs approval',
      riskLevel: 'medium',
      input: { command: 'echo hi' },
      options: [{ optionId: 'allowOnce', kind: 'allow', name: 'Allow once', response: { decision: 'allow' } }],
      ...overrides
    }
  });

  /**
   * 造一帧逐字对齐官方 `pUi`（偏移 768496）的用户输入请求。
   * @param {Record<string, unknown>} [overrides]
   * @returns {Record<string, any>}
   */
  const userInputRequest = (overrides = {}) => ({
    id: 'server-10',
    method: REVERSE_REQUEST_USER_INPUT,
    params: {
      requestId: 'req-2',
      sessionId: 'sess-1',
      toolCallId: 'tc-2',
      toolName: 'AskUserQuestion',
      prompt: 'Which approach?',
      questions: [{ question: 'Which approach?', header: 'Approach', options: [{ value: 'a', label: 'A' }] }],
      ...overrides
    }
  });

  it('两个 method 字面量与官方 `va` 枚举**逐字一致**（测试不硬写第二份字面量）', () => {
    expect(REVERSE_REQUEST_PERMISSION).toBe('interaction/requestPermission');
    expect(REVERSE_REQUEST_USER_INPUT).toBe('interaction/requestUserInput');
    // 与官方同处一个字面量对象的那条，必须逐字等于既有常量（防止三条各写各的）
    expect(REVERSE_REQUEST_PROVIDER_RUNTIME_HEADERS).toBe('interaction/requestProviderRuntimeHeaders');
  });

  it('判别器：只认"有 id + method 逐字 + params 是对象"，其余一律不认', () => {
    expect(isToolPermissionRequest(permissionRequest())).toBe(true);
    expect(isUserInputRequest(userInputRequest())).toBe(true);
    // 没有 id（通知帧）
    expect(isToolPermissionRequest({ method: REVERSE_REQUEST_PERMISSION, params: {} })).toBe(false);
    expect(isUserInputRequest({ method: REVERSE_REQUEST_USER_INPUT, params: {} })).toBe(false);
    // 空 id
    expect(isToolPermissionRequest({ id: '  ', method: REVERSE_REQUEST_PERMISSION, params: {} })).toBe(false);
    expect(isUserInputRequest({ id: '  ', method: REVERSE_REQUEST_USER_INPUT, params: {} })).toBe(false);
    // params 不是对象
    expect(isToolPermissionRequest({ id: 'x', method: REVERSE_REQUEST_PERMISSION, params: 'nope' })).toBe(false);
    expect(isUserInputRequest({ id: 'x', method: REVERSE_REQUEST_USER_INPUT, params: 'nope' })).toBe(false);
    // 互斥：一条权限帧不能被用户输入判别器认出来（反之亦然）
    expect(isUserInputRequest(permissionRequest())).toBe(false);
    expect(isToolPermissionRequest(userInputRequest())).toBe(false);
    // 非对象 / null
    for (const junk of [null, 1, 'str', []]) {
      expect(isToolPermissionRequest(junk)).toBe(false);
      expect(isUserInputRequest(junk)).toBe(false);
    }
  });

  it('权限应答：缺省 `allow`，`result` **只有** `decision` + `reason`（官方 `JL` 是 `.strict()`）', () => {
    const { frame, summary } = resolveToolPermissionResponse({ frame: permissionRequest() });
    expect(Object.keys(frame).sort()).toEqual(['id', 'result']);
    expect(frame.id).toBe('server-9');
    // **不多一个键**：官方 `pTt.resolveClientRequest` 逐字 `s.resolve(s.resultSchema.parse(n))`，
    // `.strict()` 下多一个键就整条 reject。
    expect(Object.keys(frame.result).sort()).toEqual(['decision', 'reason']);
    expect(frame.result.decision).toBe('allow');
    // 刻意**不**构造的三个键，各有理由（见 reverse-responder.mjs 的函数注释）
    expect(frame.result).not.toHaveProperty('modifiedInput');
    expect(frame.result).not.toHaveProperty('permissionUpdates');
    expect(summary.decision).toBe('allow');
    expect(summary.policy).toBe('allow');
    expect(summary.method).toBe(REVERSE_REQUEST_PERMISSION);
  });

  it('权限应答：`policy=deny` 时**如实回拒绝**（不假装放行）', () => {
    const { frame, summary } = resolveToolPermissionResponse({ frame: permissionRequest(), policy: 'deny' });
    expect(frame.result.decision).toBe('deny');
    expect(Object.keys(frame.result).sort()).toEqual(['decision', 'reason']);
    expect(summary.policy).toBe('deny');
    expect(summary.decision).toBe('deny');
    // 决策闭集只有官方 `jZe` 那四个；我们只可能产出其中两个
    expect(PERMISSION_DECISIONS).toEqual(['allow', 'deny', 'escalate', 'modify']);
    expect(['allow', 'deny']).toContain(frame.result.decision);
  });

  it('**零凭据 + 零回显**：应答与摘要里搜不到 toolName / input / 路径，也不回显请求内容', () => {
    const { frame, summary } = resolveToolPermissionResponse({
      frame: permissionRequest({ input: { command: `cat ${SYNTHETIC_PLAINTEXT}` } })
    });
    const wire = JSON.stringify(frame);
    expect(wire).not.toContain(SYNTHETIC_PLAINTEXT);
    expect(wire).not.toContain(TEST_SECRET);
    expect(wire).not.toContain('Bash');
    expect(JSON.stringify(summary)).not.toContain(SYNTHETIC_PLAINTEXT);
    // 摘要字段是闭集
    expect(Object.keys(summary).sort()).toEqual(['answered', 'decision', 'id', 'method', 'policy']);
  });

  it('用户输入应答：恒 `action:"cancel"`，**不**构造 `content`（`accept` 要真实答案，我们没有）', () => {
    const { frame, summary } = resolveUserInputResponse({ frame: userInputRequest() });
    expect(Object.keys(frame).sort()).toEqual(['id', 'result']);
    expect(frame.id).toBe('server-10');
    // 官方 `GZa` 逐字 `e.action==="accept" ? {action:"accept",content:e.content??{}} : {action:e.action}`——
    // 非 accept 路径**根本不读** `content`，所以省略是官方支持的形态。
    expect(Object.keys(frame.result).sort()).toEqual(['action', 'reason']);
    expect(frame.result.action).toBe('cancel');
    expect(frame.result).not.toHaveProperty('content');
    // 官方 `CYe` 逐字 `m.enum(["accept","decline","cancel"])` —— 闭集逐字
    expect(USER_INPUT_ACTIONS).toEqual(['accept', 'decline', 'cancel']);
    expect(USER_INPUT_ACTIONS).toContain(frame.result.action);
    expect(summary.action).toBe('cancel');
  });

  it('用户输入应答**与 policy 无关**（`deny` 也不改变 cancel：子宿主没有交互式用户通道）', () => {
    // 签名上就没有 policy 这个参数 —— 编译期就挡掉了"按策略改成 accept"的写法。
    const { frame } = resolveUserInputResponse({ frame: userInputRequest() });
    expect(frame.result.action).toBe('cancel');
    // 而 `reason` 必须说清"为什么"，让客户端能看懂这不是一次"有人看了然后拒绝"。
    expect(String(frame.result.reason)).toContain('no interactive user channel');
  });

  it('工具策略解析：闭集 + 缺省 `allow`，闭集外**抛错不回落**', () => {
    expect(resolveHostToolPolicy({})).toBe('allow');
    expect(resolveHostToolPolicy({ [HOST_TOOL_POLICY_ENV_KEY]: '' })).toBe('allow');
    expect(resolveHostToolPolicy({ [HOST_TOOL_POLICY_ENV_KEY]: '   ' })).toBe('allow');
    expect(resolveHostToolPolicy({ [HOST_TOOL_POLICY_ENV_KEY]: 'allow' })).toBe('allow');
    expect(resolveHostToolPolicy({ [HOST_TOOL_POLICY_ENV_KEY]: 'deny' })).toBe('deny');
    // 闭集外：立刻失败。**不**回落成 allow 或 deny —— 那会让"配置说了什么"与
    // "实际生效什么"分叉（`ALLOW` 大小写不同就静默放行是**安全方向的放松**）。
    for (const bad of ['ALLOW', 'Deny', 'yes', '1', 'true', 'allow,deny']) {
      expect(() => resolveHostToolPolicy({ [HOST_TOOL_POLICY_ENV_KEY]: bad }), bad).toThrow(/TOOL_POLICY_UNSUPPORTED/);
    }
    expect(HOST_TOOL_POLICIES).toEqual(['allow', 'deny']);
  });

  it('权限档位解析：闭集 = 官方 `$j` 逐字，缺省 `yolo`，闭集外**抛错不回落**', () => {
    expect(resolveHostPermissionMode({})).toBe('yolo');
    expect(resolveHostPermissionMode({ [HOST_PERMISSION_MODE_ENV_KEY]: '' })).toBe('yolo');
    for (const good of OFFICIAL_SESSION_MODES) {
      expect(resolveHostPermissionMode({ [HOST_PERMISSION_MODE_ENV_KEY]: good })).toBe(good);
    }
    // **绝不选 `auto`**：官方 `checkPermission` 逐字把它判成
    // `this.deny(t,a,"mode.auto.unimplemented","Auto mode is reserved but not implemented yet")`
    // ——那等于每次工具调用都被拒。所以它**在**闭集里（我们不篡改官方闭集），
    // 但**不是**缺省；这一条把那个理由钉死。
    expect(DEFAULT_HOST_PERMISSION_MODE).toBe('yolo');
    expect(DEFAULT_HOST_PERMISSION_MODE).not.toBe('auto');
    for (const bad of ['YOLO', 'bypass', 'bypassPermissions', '1', 'true']) {
      expect(() => resolveHostPermissionMode({ [HOST_PERMISSION_MODE_ENV_KEY]: bad }), bad).toThrow(/PERMISSION_MODE_UNSUPPORTED/);
    }
    // 官方闭集逐字（本仓这一份就是官方 `$j` 的原样）
    expect(OFFICIAL_SESSION_MODES).toEqual(['plan', 'build', 'edit', 'yolo', 'auto']);
  });

  it('**应答器是纯函数**：同一个输入连答两次结果逐字相同，且两次不共享引用', () => {
    const frame = permissionRequest();
    const a = resolveToolPermissionResponse({ frame });
    const b = resolveToolPermissionResponse({ frame });
    expect(JSON.stringify(a.frame)).toBe(JSON.stringify(b.frame));
    // 不共享引用：调用方改不到模块级常量，也污染不到另一次调用
    expect(a.frame.result).not.toBe(b.frame.result);
    expect(a.frame).not.toBe(b.frame);
  });
});
