/**
 * OFFICIAL-HOST 出站白名单 + providerRuntimeHeadersPort 单测（零发送、零真实仓）。
 *
 * 覆盖的硬事实：
 *  1. **付费通道命中即拒且不触网。** 判定是**纯字符串、零 I/O**，且发生在
 *     `createHeadersPort()` 的构造期 —— 因此 `resolveCredential` 这个"取键"回调
 *     **一次都没有被调用过**。测试用一个"调用即抛"的探针证明这一点。
 *  2. **白名单前缀硬编码。** 只有 `account:` 前缀放行；其余一律拒。
 *  3. **黑名单闭集被钉死**，且必须覆盖工单点名的四个付费 id。
 *  4. **port 形状逐字对齐官方。** `shouldRefreshBeforeModelRequest()` 恒 `true`；
 *     `refreshBeforeModelRequest(n)` 返回 `{headersApplied: true, requestAuth: {apiKey}}`。
 *  5. **明文零落地。** `requestAuth` 的 `toJSON()` 抛错；错误 detail 不含明文。
 *  6. **解密失败 → 结构化错误**，不降级、不静默放行。
 *
 * checkJs 说明：判定的返回是 discriminated union，JS 里 `expect(x.ok).toBe(false)` 不构成
 * 收窄，所以这些调用点一律经内联的 any 断言读取。收窄正确性由运行时断言证明。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ALLOWED_CHANNEL_PREFIX,
  BLOCKED_CHANNEL_IDS,
  BLOCKED_CHANNEL_IDS_REQUIRED,
  HEADERS_PORT_ERROR_CODES,
  HeadersPortError,
  createHeadersPort,
  evaluateChannelPolicy
} from '../../packages/official-host/src/headers-port.js';
import { CredentialValue, OfficialCredentialError } from '../../packages/official-host/src/credentials.js';

const SYNTHETIC_PLAINTEXT = 'synthetic-port-value-do-not-use-anywhere';

/** 探针：一旦被调用就让测试失败 —— 用来证明"拒绝路径真的没取键"。 */
function neverCalled() {
  return vi.fn(() => {
    throw new Error('RESOLVE_MUST_NOT_RUN: 白名单拒绝路径上不允许取键');
  });
}

describe('OFFICIAL-HOST headers-port · 出站白名单（硬编码、默认拒绝）', () => {
  it('白名单前缀是 account:（与 tap 的 ALLOWED_CHANNEL_PREFIX 逐字同值）', () => {
    expect(ALLOWED_CHANNEL_PREFIX).toBe('account:');
  });

  it('黑名单闭集覆盖工单点名的四个付费 id', () => {
    for (const id of BLOCKED_CHANNEL_IDS_REQUIRED) {
      expect(BLOCKED_CHANNEL_IDS).toContain(id);
    }
    // 闭集全集（含官方 legacy 形态的 builtin:zai）
    expect([...BLOCKED_CHANNEL_IDS]).toEqual([
      'bigmodel-api',
      'zai-api',
      'zai-standard-api',
      'builtin:bigmodel',
      'builtin:zai'
    ]);
  });

  it.each(BLOCKED_CHANNEL_IDS)('%s 命中即 blocked_channel 并指名回显', (id) => {
    const decision = /** @type {any} */ (evaluateChannelPolicy(id));
    expect(decision.ok).toBe(false);
    expect(decision.code).toBe('blocked_channel');
    // 恰好等于黑名单常量时才回显取值
    expect(decision.matched).toBe(id);
  });

  it.each(['opencodex', 'ollama-cloud', 'openai', 'anthropic', 'zai-standard', ''])(
    '非 account: 前缀一律 channel_not_allowlisted，且不回显取值',
    (id) => {
      const decision = /** @type {any} */ (evaluateChannelPolicy(id));
      expect(decision.ok).toBe(false);
      expect(decision.code).toBe('channel_not_allowlisted');
      // 非黑名单命中的取值一个字符都不回显 —— 避免调用方把自己的秘密塞进 providerId 再被回显
      expect(decision.matched).toBeNull();
      if (id !== '') expect(JSON.stringify(decision)).not.toContain(id);
    }
  );

  it('四条已核订阅 providerId 放行', () => {
    for (const id of [
      'account:zai-start-plan',
      'account:bigmodel-start-plan',
      'account:zai-individual-coding-plan',
      'account:bigmodel-individual-coding-plan'
    ]) {
      const decision = /** @type {any} */ (evaluateChannelPolicy(id));
      expect(decision.ok).toBe(true);
      expect(decision.channel).toBe(id);
    }
  });

  it('providerId 缺失 / 非字符串 / 全空白 → 默认拒绝', () => {
    for (const bad of [undefined, null, 42, '   ', {}, []]) {
      const decision = /** @type {any} */ (evaluateChannelPolicy(bad));
      expect(decision.ok).toBe(false);
      expect(decision.code).toBe('channel_not_allowlisted');
    }
  });
});

describe('OFFICIAL-HOST headers-port · 拒绝路径不触网', () => {
  it.each(BLOCKED_CHANNEL_IDS)('%s：构造期就抛，取键探针一次都没被调用', (id) => {
    const resolve = neverCalled();
    let caught;
    try {
      createHeadersPort({ providerId: id, planKind: 'start-plan', family: 'zai', resolveCredential: resolve });
    } catch (e) {
      caught = /** @type {any} */ (e);
    }
    expect(caught).toBeInstanceOf(HeadersPortError);
    expect(caught.code).toBe('CHANNEL_BLOCKED');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('非白名单前缀：构造期抛，取键探针一次都没被调用', () => {
    const resolve = neverCalled();
    expect(() =>
      createHeadersPort({ providerId: 'openai', planKind: 'start-plan', family: 'zai', resolveCredential: resolve })
    ).toThrowError(/CHANNEL_NOT_ALLOWLISTED/);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('工单点名的四个付费 id 逐个被钉死（加 id 逃不掉这一关）', () => {
    for (const id of BLOCKED_CHANNEL_IDS_REQUIRED) {
      const resolve = neverCalled();
      expect(() =>
        createHeadersPort({ providerId: id, planKind: 'start-plan', family: 'zai', resolveCredential: resolve })
      ).toThrowError(/CHANNEL_BLOCKED/);
      expect(resolve).not.toHaveBeenCalled();
    }
  });

  it('错误码闭集被测试钉死', () => {
    expect([...HEADERS_PORT_ERROR_CODES]).toEqual(['CHANNEL_BLOCKED', 'CHANNEL_NOT_ALLOWLISTED', 'CREDENTIAL_RESOLUTION_FAILED']);
  });
});

describe('OFFICIAL-HOST headers-port · 官方 port 形状', () => {
  it('shouldRefreshBeforeModelRequest 恒 true；应答形状逐字对齐官方', () => {
    const port = createHeadersPort({
      providerId: 'account:zai-start-plan',
      planKind: 'start-plan',
      family: 'zai',
      resolveCredential: () => new CredentialValue('zcodejwttoken', SYNTHETIC_PLAINTEXT)
    });
    expect(typeof port.shouldRefreshBeforeModelRequest).toBe('function');
    expect(port.shouldRefreshBeforeModelRequest()).toBe(true);
    const result = port.refreshBeforeModelRequest({ /* 官方传的 n：形状未知，不依赖它 */ });
    expect(result.headersApplied).toBe(true);
    expect(result.requestAuth.apiKey).toBe(SYNTHETIC_PLAINTEXT);
    expect(result.requestAuth.entryKey).toBe('zcodejwttoken');
  });

  it('每次 refresh 都重新取键（不做跨请求缓存：明文不跨请求存活）', () => {
    const resolve = vi.fn(() => new CredentialValue('zcodejwttoken', SYNTHETIC_PLAINTEXT));
    const port = createHeadersPort({
      providerId: 'account:zai-start-plan',
      planKind: 'start-plan',
      family: 'zai',
      resolveCredential: resolve
    });
    port.refreshBeforeModelRequest({});
    port.refreshBeforeModelRequest({});
    port.refreshBeforeModelRequest({});
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('requestAuth 序列化被结构化堵死（toJSON 抛错）', () => {
    const port = createHeadersPort({
      providerId: 'account:zai-start-plan',
      planKind: 'start-plan',
      family: 'zai',
      resolveCredential: () => new CredentialValue('zcodejwttoken', SYNTHETIC_PLAINTEXT)
    });
    const result = port.refreshBeforeModelRequest({});
    expect(() => JSON.stringify(result.requestAuth)).toThrowError(/禁止被序列化/);
    expect(() => JSON.stringify({ result })).toThrowError(/禁止被序列化/);
  });

  it('individual 分支把 family **与 providerId** 都传给取键函数（不在实现里硬编码 zai，也不自己拼键）', () => {
    const resolve = vi.fn(() => new CredentialValue('account-provider:coding-plan:…:api-key', SYNTHETIC_PLAINTEXT));
    const port = createHeadersPort({
      providerId: 'account:bigmodel-individual-coding-plan',
      planKind: 'individual-coding-plan',
      family: 'bigmodel',
      resolveCredential: resolve
    });
    const result = port.refreshBeforeModelRequest({});
    // providerId 必须**透传**：individual 的 api-key 键内嵌它（官方 accountProviderCredentialKey），
    // port 少传一个字段，下游就只能 fail-closed 报 ACCOUNT_PROVIDER_ID_MISSING。
    expect(resolve).toHaveBeenCalledWith({
      planKind: 'individual-coding-plan',
      family: 'bigmodel',
      providerId: 'account:bigmodel-individual-coding-plan'
    });
    expect(result.requestAuth.entryKey).toBe('account-provider:coding-plan:…:api-key');
  });
});

describe('OFFICIAL-HOST headers-port · 解密失败即结构化错误', () => {
  it('OfficialCredentialError 被搬成 CREDENTIAL_RESOLUTION_FAILED，且 detail 不含明文', () => {
    const port = createHeadersPort({
      providerId: 'account:zai-start-plan',
      planKind: 'start-plan',
      family: 'zai',
      resolveCredential: () => {
        throw new OfficialCredentialError('CREDENTIAL_ENTRY_MISSING', '凭据仓里没有条目 zcodejwttoken（只报键名，不报任何值）', {
          entryKey: 'zcodejwttoken'
        });
      }
    });
    let caught;
    try {
      port.refreshBeforeModelRequest({});
    } catch (e) {
      caught = /** @type {any} */ (e);
    }
    expect(caught).toBeInstanceOf(HeadersPortError);
    expect(caught.code).toBe('CREDENTIAL_RESOLUTION_FAILED');
    expect(caught.detail).toContain('CREDENTIAL_ENTRY_MISSING');
    expect(caught.providerId).toBe('account:zai-start-plan');
    expect(JSON.stringify(caught)).not.toContain(SYNTHETIC_PLAINTEXT);
  });

  it('未知异常不带原始异常转发（防止实现把自己的明文塞进 message 后被搬出去）', () => {
    const port = createHeadersPort({
      providerId: 'account:zai-start-plan',
      planKind: 'start-plan',
      family: 'zai',
      resolveCredential: () => {
        throw new Error(`内部实现不小心把 ${SYNTHETIC_PLAINTEXT} 放进了 message`);
      }
    });
    let caught;
    try {
      port.refreshBeforeModelRequest({});
    } catch (e) {
      caught = /** @type {any} */ (e);
    }
    expect(caught.code).toBe('CREDENTIAL_RESOLUTION_FAILED');
    expect(caught.detail).toBe('凭据取键失败（错误来源未知，不附原始异常）');
    expect(JSON.stringify(caught)).not.toContain(SYNTHETIC_PLAINTEXT);
  });
});
