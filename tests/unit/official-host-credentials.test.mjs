/**
 * OFFICIAL-HOST 凭据层单测（零发送、零真实仓）。
 *
 * **本文件从不读本机真实凭据仓。** 全部信封都是这份测试自己用测试私钥**自己加密、
 * 自己也解密**的合成夹具（`syntheticEnvelope`），密钥从一个写死的测试 secret 推导。
 * 断言"往返一致"证明的是形状与实现自洽，不是"能解开官方真仓的值"——后者需要真实仓，
 * 属于协调者的验收范围，不在本工单内。
 *
 * 覆盖的硬事实：
 *  1. **信封往返。** 自己加密 → 自己解密，明文逐字节一致。
 *  2. **secret 推导 env 优先、兜底次之。** 两条来源都产 32 字节；env 存在但空白
 *     **不回落到兜底串**（报 `SECRET_SOURCE_INVALID`）。
 *  3. **形状 fail-closed。** 前缀不对 / 段数不对 / 非 base64url / iv 长度不对 /
 *     tag 长度不对 / GCM 认证失败，各报明确码，且**不返回任何部分明文**。
 *  4. **三分支取键。** start-plan → `zcodejwttoken`；individual → 先从
 *     `oauth:<provider>:user_info` 的 `.id` 解析**账号身份**，再拼
 *     `account-provider:coding-plan:<providerId>:account:<身份>:api-key`；
 *     team → 显式 `PLAN_KIND_UNSUPPORTED`；不认识的 family → `PROVIDER_FAMILY_UNKNOWN`；
 *     individual 缺 providerId → `ACCOUNT_PROVIDER_ID_MISSING`；
 *     身份解析不出来 → `ACCOUNT_IDENTITY_UNRESOLVED`。
 *  5. **明文零落地。** 错误消息、`String()`、`toJSON()`、`JSON.stringify` 全部搜不到
 *     明文；`toJSON()` 直接抛错。
 *
 * checkJs 说明：JS 里的 catch 绑定与联合类型收窄在类型层不成立，因此这些调用点
 * 一律经内联的 any 断言读取。收窄正确性由运行时断言证明——那才是本文件的目的。
 */
import { describe, it, expect } from 'vitest';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import {
  CREDENTIAL_FALLBACK_PREFIX,
  CREDENTIAL_SECRET_ENV_KEY,
  CredentialValue,
  ENVELOPE_IV_BYTES,
  ENVELOPE_PREFIX,
  OFFICIAL_CREDENTIAL_ERROR_CODES,
  OFFICIAL_PLAN_KINDS,
  OfficialCredentialError,
  PROVIDER_FAMILIES,
  START_PLAN_ENTRY_KEY,
  accountProviderCredentialKey,
  decryptEnvelope,
  deriveCredentialSecret,
  individualPlanEntryKey,
  parseCredentialStore,
  resolveAccountIdentityFromUserProfile,
  resolveCredentialForPlan,
  resolveCredentialsPath,
  resolveOAuthProviderId,
  userInfoEntryKey
} from '../../packages/official-host/src/credentials.js';

/** 测试私钥。**不是**任何真实 secret，且只在本文件内。 */
const TEST_SECRET = 'official-host-unit-test-secret-not-a-real-credential';
const TEST_KEY = createHash('sha256').update(TEST_SECRET, 'utf8').digest();

/**
 * 造一个合成信封。**自己加密自己解**，不涉及任何真实仓。
 * @param {string} plaintext
 * @returns {string} `enc:v1:<iv>.<tag>.<ct>`
 */
function syntheticEnvelope(plaintext) {
  const iv = randomBytes(ENVELOPE_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', TEST_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${ENVELOPE_PREFIX}${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

/**
 * 合成仓文本。
 * @param {Record<string, string>} entries
 * @returns {string}
 */
function syntheticStore(entries) {
  return JSON.stringify(entries);
}

const SYNTHETIC_PLAINTEXT = 'synthetic-credential-value-do-not-use-anywhere';
const SYNTHETIC_PLAN_ENV = { [CREDENTIAL_SECRET_ENV_KEY]: TEST_SECRET };

/**
 * 合成 providerId / 账号身份。**形状照抄真实仓的键形，值全合成。**
 *
 * 真实仓里 individual / team 的 api-key 条目键形是
 * `account-provider:coding-plan:<providerId>:account:<账号身份>:api-key`，
 * 且**账号身份内嵌在键里**——bigmodel 族是 17 位数字，zai 族是 36 位 UUID。
 * 这两个常量如实复刻那种形状，但**不是**任何真实账号的 id。
 */
const SYNTHETIC_BIGMODEL_PROVIDER_ID = 'account:bigmodel-individual-coding-plan';
const SYNTHETIC_ZAI_PROVIDER_ID = 'account:zai-individual-coding-plan';
const SYNTHETIC_IDENTITY = '10000000000000001';
const SYNTHETIC_UUID_IDENTITY = '00000000-0000-4000-8000-000000000000';

/**
 * 断言给定内容里搜不到明文 / 测试 secret。
 * @param {unknown} haystack
 * @param {string} label
 */
function assertNoPlaintext(haystack, label) {
  expect(String(haystack), label).not.toContain(SYNTHETIC_PLAINTEXT);
  expect(String(haystack), label).not.toContain(TEST_SECRET);
}

describe('OFFICIAL-HOST credentials · 信封往返（合成夹具，不碰真实仓）', () => {
  it('自己加密的信封能自己解开，明文逐字节一致', () => {
    const envelope = syntheticEnvelope(SYNTHETIC_PLAINTEXT);
    expect(envelope.startsWith(ENVELOPE_PREFIX)).toBe(true);
    expect(envelope.slice(ENVELOPE_PREFIX.length).split('.')).toHaveLength(3);
    expect(decryptEnvelope(envelope, TEST_KEY, 'unit-test-entry')).toBe(SYNTHETIC_PLAINTEXT);
  });

  it('空明文产出空 ciphertext 段 → 形状层就拒（fail-closed，不进解密）', () => {
    // 这是**有意**的行为：空段判定发生在解密之前。空 ciphertext 段是畸形信封的强信号，
    // 放它进 GCM 只会得到一个不可解释的认证失败。
    // `resolveCredentialForPlan` 里"解出空串就拒"是**另一层**防线（形状合法但内容空）。
    expect(() => decryptEnvelope(syntheticEnvelope(''), TEST_KEY, 'k')).toThrowError(/ENVELOPE_SEGMENT_INVALID/);
  });

  it('CJK 明文逐字节往返（base64url 不截断多字节）', () => {
    const cjk = '合成凭据值-中文-测试';
    expect(decryptEnvelope(syntheticEnvelope(cjk), TEST_KEY, 'unit-test-entry')).toBe(cjk);
  });
});

describe('OFFICIAL-HOST credentials · secret 推导', () => {
  it('env 优先：产出 sha256(env secret) 且 32 字节', () => {
    const derived = deriveCredentialSecret({ env: { [CREDENTIAL_SECRET_ENV_KEY]: TEST_SECRET } });
    expect(derived.source).toBe('env');
    expect(derived.key).toHaveLength(32);
    expect(derived.key.equals(TEST_KEY)).toBe(true);
    expect(derived.provenance).toBe('secret=env');
    assertNoPlaintext(derived.provenance, 'env provenance');
  });

  it('兜底串次之：sha256(zcode-credential-fallback:<platform>:<home>:<user>)，32 字节', () => {
    const derived = deriveCredentialSecret({ env: {}, platform: 'testplat', homeDir: 'C:/test-home', username: 'tester' });
    const expected = createHash('sha256')
      .update(`${CREDENTIAL_FALLBACK_PREFIX}:testplat:C:/test-home:tester`, 'utf8')
      .digest();
    expect(derived.source).toBe('fallback');
    expect(derived.key.equals(expected)).toBe(true);
    expect(derived.provenance).toBe('secret=fallback');
    // 兜底串的原料（家目录 / 用户名）不得出现在可记录的 provenance 里。
    expect(derived.provenance).not.toContain('tester');
    expect(derived.provenance).not.toContain('test-home');
  });

  it('env 存在但空白 → SECRET_SOURCE_INVALID，且**不**回落到兜底串', () => {
    let caught;
    try {
      deriveCredentialSecret({ env: { [CREDENTIAL_SECRET_ENV_KEY]: '   ' } });
    } catch (e) {
      caught = /** @type {any} */ (e);
    }
    expect(caught.code).toBe('SECRET_SOURCE_INVALID');
  });

  it('兜底三元组不完整 → SECRET_SOURCE_INVALID（不猜默认值）', () => {
    expect(() => deriveCredentialSecret({ env: {}, platform: 'p', homeDir: 'h', username: '' })).toThrowError(
      /SECRET_SOURCE_INVALID/
    );
  });
});

describe('OFFICIAL-HOST credentials · 信封形状 fail-closed', () => {
  const good = syntheticEnvelope(SYNTHETIC_PLAINTEXT);

  it('前缀不对 → ENVELOPE_MALFORMED', () => {
    let caught;
    try {
      decryptEnvelope('plain-text-value', TEST_KEY, 'k');
    } catch (e) {
      caught = /** @type {any} */ (e);
    }
    expect(caught.code).toBe('ENVELOPE_MALFORMED');
    assertNoPlaintext(caught.message, 'malformed message');
  });

  it('段数不对 → ENVELOPE_MALFORMED', () => {
    expect(() => decryptEnvelope(`${ENVELOPE_PREFIX}a.b`, TEST_KEY, 'k')).toThrowError(/ENVELOPE_MALFORMED/);
  });

  it('非 base64url 字符 → ENVELOPE_SEGMENT_INVALID', () => {
    expect(() => decryptEnvelope(`${ENVELOPE_PREFIX}a+b.c.d`, TEST_KEY, 'k')).toThrowError(/ENVELOPE_SEGMENT_INVALID/);
  });

  it('iv 长度不对 → ENVELOPE_SEGMENT_INVALID（不进入解密）', () => {
    expect(() => decryptEnvelope(`${ENVELOPE_PREFIX}AAAA.c.d`, TEST_KEY, 'k')).toThrowError(/ENVELOPE_SEGMENT_INVALID/);
  });

  it('tag 长度不对 → ENVELOPE_SEGMENT_INVALID', () => {
    const bad = `${ENVELOPE_PREFIX}${good.slice(ENVELOPE_PREFIX.length).split('.')[0]}.AA.zz`;
    expect(() => decryptEnvelope(bad, TEST_KEY, 'k')).toThrowError(/ENVELOPE_SEGMENT_INVALID/);
  });

  it('密钥不对 → ENVELOPE_DECRYPT_FAILED，且不返回部分明文', () => {
    const wrongKey = createHash('sha256').update('a-different-test-secret', 'utf8').digest();
    let caught;
    try {
      decryptEnvelope(good, wrongKey, 'unit-test-entry');
    } catch (e) {
      caught = /** @type {any} */ (e);
    }
    expect(caught.code).toBe('ENVELOPE_DECRYPT_FAILED');
    assertNoPlaintext(caught.message, 'decrypt failure message');
  });

  it('密钥长度不是 32 → SECRET_SOURCE_INVALID', () => {
    expect(() => decryptEnvelope(good, Buffer.alloc(16), 'k')).toThrowError(/SECRET_SOURCE_INVALID/);
  });

  it('错误消息只报键名，不报密文信封', () => {
    try {
      decryptEnvelope(`${ENVELOPE_PREFIX}AAAA.c.d`, TEST_KEY, 'named-entry-key');
    } catch (e) {
      const err = /** @type {any} */ (e);
      expect(err.message).toContain('named-entry-key');
      expect(err.message).not.toContain(good);
    }
  });
});

describe('OFFICIAL-HOST credentials · 三分支取键', () => {
  it('start-plan → 条目 zcodejwttoken（**不是** oauth access_token）', () => {
    expect(START_PLAN_ENTRY_KEY).toBe('zcodejwttoken');
    const value = resolveCredentialForPlan({
      planKind: 'start-plan',
      family: 'zai',
      env: SYNTHETIC_PLAN_ENV,
      platform: 'testplat',
      homeDir: 'C:/test-home',
      username: 'tester',
      readFile: () =>
        syntheticStore({
          [START_PLAN_ENTRY_KEY]: syntheticEnvelope(SYNTHETIC_PLAINTEXT),
          'oauth:zai:access_token': syntheticEnvelope('a-different-secret-token')
        })
    });
    expect(value.entryKey).toBe('zcodejwttoken');
    expect(value.reveal()).toBe(SYNTHETIC_PLAINTEXT);
  });

  it('start-plan **不受 individual 修复影响**：仓里没有任何 user_info 也能取到', () => {
    // 这条是 CREDFIX 的回归护栏：修 individual 分支时若把身份解析误提到 start-plan 上，
    // 仓里没有 `oauth:*:user_info` 就会开始失败——而 start-plan 通道是实弹全通的那一支，
    // 绝不能被改坏。
    const value = resolveCredentialForPlan({
      planKind: 'start-plan',
      family: 'bigmodel',
      env: SYNTHETIC_PLAN_ENV,
      platform: 'testplat',
      homeDir: 'C:/test-home',
      username: 'tester',
      readFile: () => syntheticStore({ [START_PLAN_ENTRY_KEY]: syntheticEnvelope(SYNTHETIC_PLAINTEXT) })
    });
    expect(value.entryKey).toBe(START_PLAN_ENTRY_KEY);
    expect(value.reveal()).toBe(SYNTHETIC_PLAINTEXT);
  });

  it('individual-coding-plan → 先解析账号身份，再拼 account-provider:coding-plan 键', () => {
    for (const family of PROVIDER_FAMILIES) {
      // 每族一条**独立合成**的 providerId / 身份：bigmodel 族用 17 位数字身份，
      // zai 族用 UUID 形身份——两族真实仓里的身份形状本来就不同，夹具如实复刻。
      const providerId = family === 'bigmodel' ? SYNTHETIC_BIGMODEL_PROVIDER_ID : SYNTHETIC_ZAI_PROVIDER_ID;
      const identity = family === 'bigmodel' ? SYNTHETIC_IDENTITY : SYNTHETIC_UUID_IDENTITY;
      // 合成 user_info profile 的明文：三字段闸门要的三项齐全（官方逐字要求）。
      const profile = JSON.stringify({ id: identity, username: 'synthetic-user', displayName: 'Synthetic' });
      // 关键：**夹具用字面量键**，不是用被测函数算出来的键。
      // 因此生产代码必须自己独立地拼对这一个字符，才能读到这条目。
      const literalKey = `account-provider:coding-plan:${providerId}:account:${encodeURIComponent(identity)}:api-key`;
      const value = resolveCredentialForPlan({
        planKind: 'individual-coding-plan',
        family,
        providerId,
        env: SYNTHETIC_PLAN_ENV,
        platform: 'testplat',
        homeDir: 'C:/test-home',
        username: 'tester',
        readFile: () =>
          syntheticStore({
            [userInfoEntryKey(resolveOAuthProviderId(family))]: syntheticEnvelope(profile),
            [literalKey]: syntheticEnvelope(`${SYNTHETIC_PLAINTEXT}-${family}`)
          })
      });
      expect(value.entryKey).toBe(literalKey);
      expect(value.reveal()).toBe(`${SYNTHETIC_PLAINTEXT}-${family}`);
    }
  });

  it('键形状被字面量钉死：改错任意一位就红（CREDFIX 变异体靶子）', () => {
    // 这一组断言**不**经过仓、不经过解密，只钉 `accountProviderCredentialKey` 的键形本身。
    // 它是 CREDFIX 那个 bug（`oauth:<family>:api-key`）的直接反面：旧实现在这里必红。
    expect(accountProviderCredentialKey({ providerId: SYNTHETIC_BIGMODEL_PROVIDER_ID, planKind: 'individual-coding-plan', accountIdentity: SYNTHETIC_IDENTITY }))
      .toBe('account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:10000000000000001:api-key');
    // providerId 里**自带冒号**（`account:bigmodel-...`）：这一段不能被 encode，
    // 官方 `Oy` 只 encode 中段与身份，不 encode providerId。
    expect(accountProviderCredentialKey({ providerId: SYNTHETIC_BIGMODEL_PROVIDER_ID, planKind: 'individual-coding-plan', accountIdentity: SYNTHETIC_IDENTITY }))
      .toContain(':account:bigmodel-individual-coding-plan:account:');
    // 身份**要**被 encodeURIComponent：含 `/` `:` 的身份不能撑破键结构。
    expect(accountProviderCredentialKey({ providerId: 'account:x', planKind: 'individual-coding-plan', accountIdentity: 'a/b:c' }))
      .toBe('account-provider:coding-plan:account:x:account:a%2Fb%3Ac:api-key');
    // start-plan 段名不同（`start-plan:`），coding-plan 段名不带 plan 尾巴。
    expect(accountProviderCredentialKey({ providerId: 'account:x', planKind: 'start-plan', accountIdentity: 'id1' }))
      .toBe('account-provider:start-plan:account:x:account:id1:api-key');
    expect(individualPlanEntryKey(SYNTHETIC_BIGMODEL_PROVIDER_ID, SYNTHETIC_IDENTITY))
      .toBe(accountProviderCredentialKey({ providerId: SYNTHETIC_BIGMODEL_PROVIDER_ID, planKind: 'individual-coding-plan', accountIdentity: SYNTHETIC_IDENTITY }));
  });

  it('身份来源逐字：user_info 的 .id，经官方三字段闸门', () => {
    expect(userInfoEntryKey('bigmodel')).toBe('oauth:bigmodel:user_info');
    expect(userInfoEntryKey('zai')).toBe('oauth:zai:user_info');
    // 官方 `Me==="zai"?"zai":Ne`：非 zai 一律 bigmodel。
    expect(resolveOAuthProviderId('zai')).toBe('zai');
    expect(resolveOAuthProviderId('bigmodel')).toBe('bigmodel');
    const ok = JSON.stringify({ id: `  ${SYNTHETIC_IDENTITY}  `, username: 'u', displayName: 'd' });
    expect(resolveAccountIdentityFromUserProfile(ok, 'oauth:bigmodel:user_info')).toBe(SYNTHETIC_IDENTITY);
  });

  it('三字段闸门逐字：少一个字段官方判 profile 为 null，我们同样 fail-closed', () => {
    for (const dropped of ['id', 'username', 'displayName']) {
      const profile = /** @type {Record<string, unknown>} */ ({ id: SYNTHETIC_IDENTITY, username: 'u', displayName: 'd' });
      delete profile[dropped];
      let caught;
      try {
        resolveAccountIdentityFromUserProfile(JSON.stringify(profile), 'oauth:bigmodel:user_info');
      } catch (e) {
        caught = /** @type {any} */ (e);
      }
      expect(caught.code).toBe('ACCOUNT_IDENTITY_UNRESOLVED');
    }
  });

  it('individual 缺 providerId → ACCOUNT_PROVIDER_ID_MISSING（不拼 "undefined" 键）', () => {
    let caught;
    try {
      resolveCredentialForPlan({
        planKind: 'individual-coding-plan',
        family: 'bigmodel',
        env: SYNTHETIC_PLAN_ENV,
        platform: 'testplat',
        homeDir: 'C:/test-home',
        username: 'tester',
        readFile: () => syntheticStore({})
      });
    } catch (e) {
      caught = /** @type {any} */ (e);
    }
    expect(caught.code).toBe('ACCOUNT_PROVIDER_ID_MISSING');
    // 报错时**没有**拼出任何键：既没有 entryKey，消息里也不含 "undefined" 参与拼键的痕迹。
    // 这正是本 bug 的病根形状——"undefined" 渗进模板串会造出一个永远读不到的键。
    expect(caught.entryKey).toBeNull();
    expect(caught.message).not.toMatch(/:undefined/);
    expect(caught.message).not.toMatch(/undefined:/);
  });

  it('individual 的 user_info 缺失 → CREDENTIAL_ENTRY_MISSING，指名 user_info 键', () => {
    let caught;
    try {
      resolveCredentialForPlan({
        planKind: 'individual-coding-plan',
        family: 'bigmodel',
        providerId: SYNTHETIC_BIGMODEL_PROVIDER_ID,
        env: SYNTHETIC_PLAN_ENV,
        platform: 'testplat',
        homeDir: 'C:/test-home',
        username: 'tester',
        readFile: () => syntheticStore({})
      });
    } catch (e) {
      caught = /** @type {any} */ (e);
    }
    expect(caught.code).toBe('CREDENTIAL_ENTRY_MISSING');
    expect(caught.entryKey).toBe('oauth:bigmodel:user_info');
  });

  it('键拼错一位 → CREDENTIAL_ENTRY_MISSING（fail-closed，指名**拼出来的那条**键）', () => {
    // 仓里放的是正确键；请求的 providerId 多一个字符 → 生产代码拼出的键不同 → 读不到。
    const profile = JSON.stringify({ id: SYNTHETIC_IDENTITY, username: 'u', displayName: 'd' });
    const goodKey = `account-provider:coding-plan:${SYNTHETIC_BIGMODEL_PROVIDER_ID}:account:${SYNTHETIC_IDENTITY}:api-key`;
    let caught;
    try {
      resolveCredentialForPlan({
        planKind: 'individual-coding-plan',
        family: 'bigmodel',
        providerId: `${SYNTHETIC_BIGMODEL_PROVIDER_ID}-x`,
        env: SYNTHETIC_PLAN_ENV,
        platform: 'testplat',
        homeDir: 'C:/test-home',
        username: 'tester',
        readFile: () =>
          syntheticStore({
            'oauth:bigmodel:user_info': syntheticEnvelope(profile),
            [goodKey]: syntheticEnvelope(SYNTHETIC_PLAINTEXT)
          })
      });
    } catch (e) {
      caught = /** @type {any} */ (e);
    }
    expect(caught.code).toBe('CREDENTIAL_ENTRY_MISSING');
    expect(caught.entryKey).not.toBe(goodKey);
    assertNoPlaintext(caught.message, 'missing entry message');
  });

  it('team-coding-plan → PLAN_KIND_UNSUPPORTED（显式不支持并诚实报错）', () => {
    let caught;
    try {
      resolveCredentialForPlan({
        planKind: 'team-coding-plan',
        family: 'zai',
        env: SYNTHETIC_PLAN_ENV,
        readFile: () => syntheticStore({})
      });
    } catch (e) {
      caught = /** @type {any} */ (e);
    }
    expect(caught.code).toBe('PLAN_KIND_UNSUPPORTED');
    expect(caught.message).toContain('resolveTeamPlanApiKey');
  });

  it('team 的真实键形可见：account-provider:team:<pid>:<product>:<org>:<proj>:…（仍不发请求）', () => {
    // 官方 `Oy` 的 team 分支需要 productId/organizationId/projectId 三个远端字段。
    // 本版不支持 team，所以这条断言只证明**键形翻译正确**，不证明能取到值。
    expect(
      accountProviderCredentialKey({
        providerId: 'account:bigmodel-team-coding-plan',
        planKind: 'team-coding-plan',
        accountIdentity: SYNTHETIC_IDENTITY,
        team: { productId: 'p1', organizationId: 'o1', projectId: 'j1' }
      })
    ).toBe('account-provider:team:account%3Abigmodel-team-coding-plan:p1:o1:j1:account:10000000000000001:api-key');
    // 少任一远端字段 → 直接 PLAN_KIND_UNSUPPORTED，不编半个键。
    expect(() =>
      accountProviderCredentialKey({
        providerId: 'account:bigmodel-team-coding-plan',
        planKind: 'team-coding-plan',
        accountIdentity: SYNTHETIC_IDENTITY
      })
    ).toThrowError(/PLAN_KIND_UNSUPPORTED/);
  });

  it('不认识的 family → PROVIDER_FAMILY_UNKNOWN（不默认成 zai）', () => {
    let caught;
    try {
      // `anthropic` 故意在闭集外：那正是本条断言要覆盖的输入。
      resolveCredentialForPlan(
        /** @type {any} */ ({
          planKind: 'individual-coding-plan',
          family: 'anthropic',
          providerId: SYNTHETIC_BIGMODEL_PROVIDER_ID,
          env: SYNTHETIC_PLAN_ENV,
          readFile: () => syntheticStore({})
        })
      );
    } catch (e) {
      caught = /** @type {any} */ (e);
    }
    expect(caught.code).toBe('PROVIDER_FAMILY_UNKNOWN');
  });

  it('planKind 闭集恰好三个；family 闭集恰好两个', () => {
    expect([...OFFICIAL_PLAN_KINDS]).toEqual(['start-plan', 'individual-coding-plan', 'team-coding-plan']);
    expect([...PROVIDER_FAMILIES]).toEqual(['zai', 'bigmodel']);
  });
});

describe('OFFICIAL-HOST credentials · 仓读取 fail-closed', () => {
  it('文件不存在 → CREDENTIALS_FILE_NOT_FOUND，且不猜别的路径', () => {
    let caught;
    try {
      resolveCredentialForPlan({
        planKind: 'start-plan',
        family: 'zai',
        env: SYNTHETIC_PLAN_ENV,
        platform: 'testplat',
        homeDir: 'C:/test-home',
        username: 'tester',
        readFile: () => {
          const e = /** @type {any} */ (new Error('ENOENT'));
          e.code = 'ENOENT';
          throw e;
        }
      });
    } catch (e) {
      caught = /** @type {any} */ (e);
    }
    expect(caught.code).toBe('CREDENTIALS_FILE_NOT_FOUND');
  });

  it('其他读取错误 → CREDENTIALS_UNREADABLE', () => {
    let caught;
    try {
      resolveCredentialForPlan({
        planKind: 'start-plan',
        family: 'zai',
        env: SYNTHETIC_PLAN_ENV,
        platform: 'testplat',
        homeDir: 'C:/test-home',
        username: 'tester',
        readFile: () => {
          const e = /** @type {any} */ (new Error('EACCES'));
          e.code = 'EACCES';
          throw e;
        }
      });
    } catch (e) {
      caught = /** @type {any} */ (e);
    }
    expect(caught.code).toBe('CREDENTIALS_UNREADABLE');
  });

  it('非法 JSON → CREDENTIALS_JSON_INVALID，且不附原始解析消息（其中可能含密文片段）', () => {
    let caught;
    try {
      parseCredentialStore(`{"${START_PLAN_ENTRY_KEY}": "enc:v1:AAAA`, '/synthetic/credentials.json');
    } catch (e) {
      caught = /** @type {any} */ (e);
    }
    expect(caught.code).toBe('CREDENTIALS_JSON_INVALID');
    assertNoPlaintext(caught.message, 'json invalid message');
  });

  it('顶层不是对象 → CREDENTIALS_SHAPE_INVALID', () => {
    expect(() => parseCredentialStore('[]', '/synthetic/credentials.json')).toThrowError(/CREDENTIALS_SHAPE_INVALID/);
    expect(() => parseCredentialStore('"str"', '/synthetic/credentials.json')).toThrowError(/CREDENTIALS_SHAPE_INVALID/);
  });

  it('解密结果是空串 → 拒绝把空值当凭据送出（否则官方会报一个无关的鉴权错）', () => {
    let caught;
    try {
      resolveCredentialForPlan({
        planKind: 'start-plan',
        family: 'zai',
        env: SYNTHETIC_PLAN_ENV,
        platform: 'testplat',
        homeDir: 'C:/test-home',
        username: 'tester',
        readFile: () => syntheticStore({ [START_PLAN_ENTRY_KEY]: syntheticEnvelope('   ') })
      });
    } catch (e) {
      caught = /** @type {any} */ (e);
    }
    expect(caught.code).toBe('ENVELOPE_DECRYPT_FAILED');
  });

  it('仓路径解析：显式参数 > ZCODE_DATA_BASE_DIR > homedir（.zcode/v2/credentials.json）', () => {
    expect(resolveCredentialsPath({ credentialsPath: '/explicit/creds.json' })).toBe('/explicit/creds.json');
    expect(resolveCredentialsPath({ env: { ZCODE_DATA_BASE_DIR: 'D:/base' } }).replace(/\\/g, '/')).toBe(
      'D:/base/.zcode/v2/credentials.json'
    );
    expect(resolveCredentialsPath({ env: {}, homeDir: 'C:/home' }).replace(/\\/g, '/')).toBe(
      'C:/home/.zcode/v2/credentials.json'
    );
  });
});

describe('OFFICIAL-HOST credentials · 明文零落地', () => {
  it('toJSON() 抛错——结构化输出这条路在结构上被堵死', () => {
    const value = new CredentialValue('unit-test-entry', SYNTHETIC_PLAINTEXT);
    expect(() => JSON.stringify({ value })).toThrowError(/ENVELOPE_MALFORMED/);
    expect(() => value.toJSON()).toThrowError(/凭据明文禁止被序列化/);
  });

  it('String(value) 不含明文', () => {
    const value = new CredentialValue('unit-test-entry', SYNTHETIC_PLAINTEXT);
    assertNoPlaintext(String(value), 'String()');
    assertNoPlaintext(`${value}`, 'template literal');
  });

  it('错误对象的 own 属性里没有明文（message / entryKey / sourcePath 逐个查）', () => {
    let caught;
    try {
      // secret 与信封的加密密钥不同 → GCM 认证失败。这条路径最容易把上下文带进消息。
      resolveCredentialForPlan({
        planKind: 'start-plan',
        family: 'zai',
        env: { [CREDENTIAL_SECRET_ENV_KEY]: 'a-mismatched-test-secret' },
        platform: 'testplat',
        homeDir: 'C:/test-home',
        username: 'tester',
        readFile: () => syntheticStore({ [START_PLAN_ENTRY_KEY]: syntheticEnvelope(SYNTHETIC_PLAINTEXT) })
      });
    } catch (e) {
      caught = /** @type {any} */ (e);
    }
    expect(caught).toBeInstanceOf(OfficialCredentialError);
    expect(caught.code).toBe('ENVELOPE_DECRYPT_FAILED');
    for (const key of Object.keys(caught)) {
      assertNoPlaintext(caught[key], `error.${key}`);
    }
    assertNoPlaintext(
      JSON.stringify({ code: caught.code, entryKey: caught.entryKey, sourcePath: caught.sourcePath }),
      'error json'
    );
  });

  it('错误码闭集被测试钉死（加码必须同时改这里）', () => {
    expect([...OFFICIAL_CREDENTIAL_ERROR_CODES]).toEqual([
      'CREDENTIALS_FILE_NOT_FOUND',
      'CREDENTIALS_UNREADABLE',
      'CREDENTIALS_JSON_INVALID',
      'CREDENTIALS_SHAPE_INVALID',
      'ENVELOPE_MALFORMED',
      'ENVELOPE_SEGMENT_INVALID',
      'ENVELOPE_DECRYPT_FAILED',
      'SECRET_SOURCE_INVALID',
      'PLAN_KIND_UNSUPPORTED',
      'PROVIDER_FAMILY_UNKNOWN',
      'ACCOUNT_PROVIDER_ID_MISSING',
      'ACCOUNT_IDENTITY_UNRESOLVED',
      'CREDENTIAL_ENTRY_MISSING'
    ]);
  });
});
