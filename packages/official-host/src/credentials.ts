/**
 * OFFICIAL-HOST 凭据层 —— 官方本地凭据仓的**只读**信封解密与三分支取键。
 *
 * 七条硬事实（每条都对应下面一组函数，测试逐条钉死）：
 *
 *  1. **明文只在内存里。** 解密结果是**函数返回值**；本模块没有任何 logger、没有
 *     `JSON.stringify` 出口、没有 `toString`。`CredentialValue` 用 `#private` 字段 +
 *     `toJSON()` 抛错双重封口：`JSON.stringify` 一个持有明文的结构会在**取值**那一刻
 *     抛错，因此"不小心把 port 结果打进日志"这条失败路径在结构上就不成立。
 *  2. **错误消息零凭据。** `OfficialCredentialError` 的 message 只含错误码、**条目
 *     键名**与来源路径，**永远不含**密文、信封或明文的任何片段。取键失败时报的是
 *     "哪个键不在仓里"，不是"这个键的值是什么"。
 *  3. **信封形状是闭集。** `enc:v1:<iv>.<tag>.<ct>`（base64url 三段、AES-256-GCM、
 *     IV 12B / tag 16B）。前缀不对、段数不对、段长不对一律 `fail-closed` 报错，
 *     绝不"试着解一下"。
 *  4. **secret 推导是 env 优先、兜底串次之。** env `ZCODE_CREDENTIAL_SECRET`；缺省
 *     `zcode-credential-fallback:${platform}:${homedir}:${username}`；密钥恒为
 *     `sha256(secret)`。两条来源都产 32 字节，形状一致，无法从长度反推来源。
 *  5. **三分支按官方逐字语义。**
 *     - `start-plan` → 条目 `zcodejwttoken`（**不是** oauth access_token）
 *     - `individual-coding-plan` → 条目
 *       `account-provider:coding-plan:<providerId>:account:<encodeURIComponent(账号身份)>:api-key`，
 *       账号身份**必须先从 `oauth:<oauthProviderId>:user_info` 的 `.id` 解析出来**（见下）
 *     - `team-coding-plan` → 本版**显式不支持**并诚实报错（见 `TEAM_PLAN_UNSUPPORTED`）
 *     family 不认识时也报错，不猜。
 *  5b. **individual 分支的键里内嵌账号身份，所以键不能凭空拼。** 官方桌面侧
 *     `loadIndividualPlanApiKey`（`out/host/index.js` @1358203）逐字是
 *     `loadUserProfile(oauthProviderIdOf(family))?.id` → `accountProviderCredentialKey(...)`；
 *     官方 CLI 侧 `t3e`（`zcode.cjs` @14112901）产出**逐字节相同**的键。解析链任一环拿不到
 *     就 fail-closed 报 `ACCOUNT_IDENTITY_UNRESOLVED`，**绝不**退化成"猜一个键名去读"。
 *  6. **不传 `standalone` 是有意的。** 官方 `startProcessProviderRegistryRuntime(e, t)` 的
 *     实参二里 `t.standalone` 一旦为真就会取 `t.standalone.credentialStore`，而
 *     `nPn` 那侧会硬过滤 `mode === "individual-coding-plan"` → start-plan 永远 not entitled。
 *     本模块因此**不提供** `credentialStore` 形状的导出，避免被误传。
 *  7. **只读。** 没有 `writeFileSync`、没有 `unlink`、没有 `rename`。仓文件只被打开读取。
 *
 * 官方出处（`C:\ZCode\resources\glm\zcode.cjs`，**只读**逐字节核对，压缩名随版本滚动，
 * 因此每条同时给出**可逐字搜到的片段**这一稳定锚）：
 *  - 信封与密钥：`Qdn="enc:v1:"`、`JZr="aes-256-gcm"`、`KZr=12`、`H7s=16`、
 *    `G7s="ZCODE_CREDENTIAL_SECRET"`，与兜底串模板
 *    `` `zcode-credential-fallback:${(0,oge.platform)()}:${(0,oge.homedir)()}:${n}` `` 同段。
 *  - 仓路径：`function n$s(e={}){ … join(eYr(n),".zcode","v2","credentials.json") }`。
 *  - 条目键名表：`{bigmodelAccessToken:"oauth:bigmodel:access_token", …,
 *    zaiUserInfo:"oauth:zai:user_info", zcodeJwtToken:"zcodejwttoken"}`（注册名
 *    `createSharedZCodeCredentialStore`）。
 *  - **账号身份来源**：`loadIndividualPlanApiKey(oe,Me)`（`out/host/index.js` @1358203 逐字）
 *    `let pt=Me==="zai"?"zai":Ne, ht=(await D.loadUserProfile(pt))?.id;
 *     return ht?B.loadCodingPlanApiKey({providerId:oe,family:Me,accountIdentity:ht}):null`。
 *  - **user_info 键与三字段闸门**：`xy(e)=` `` `oauth:${e}:user_info` ``（`out/host/index.js`
 *    @838895 的 `loadUserProfileFromKey`）：`id` / `username` / `displayName` **三者都必须是
 *    string**，否则整个 profile 判为 null。
 *  - **api-key 条目键**：`Oy`（注册名 `accountProviderCredentialKey`，`out/host/index.js`
 *    @859336 逐字）：
 *    `account-provider:${planKind==="team-coding-plan" ? ["team",providerId,productId,organizationId,projectId].map(encodeURIComponent).join(":") : `${planKind==="start-plan"?"start-plan":"coding-plan"}:${providerId}`}:account:${encodeURIComponent(accountIdentity)}:api-key`。
 *  - **交叉验证**：CLI 侧 `t3e`（注册名 `standaloneAccountProviderCredentialKey`，
 *    `zcode.cjs` @14112901 逐字）
 *    `` `account-provider:coding-plan:${providerId}:account:${encodeURIComponent(accountIdentity)}:api-key` ``
 *    与 `Oy` 在 `planKind==="individual-coding-plan"` 时**逐字节相同**。两条独立实现互证。
 */
import { createDecipheriv, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { platform as osPlatform, homedir as osHomedir, userInfo as osUserInfo } from 'node:os';
import { join } from 'node:path';

/* -------------------------------------------------------------------------- */
/* 错误                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 凭据层错误码。**闭集**——每条都对应一个具体的 fail-closed 拒绝点。
 * 新增一条是一次必须同时改测试的显式动作。
 */
export const OFFICIAL_CREDENTIAL_ERROR_CODES = [
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
] as const;
export type OfficialCredentialErrorCode = (typeof OFFICIAL_CREDENTIAL_ERROR_CODES)[number];

/**
 * 凭据层错误。
 *
 * **message 里只有：稳定错误码 + 条目键名 + 来源路径。** 没有任何一处引用密文、信封
 * 或明文——构造函数的第二个参数由调用方负责只放这三类信息，本文件内部的每一处 `new
 * OfficialCredentialError(...)` 都遵守这条。任何新增的抛出点都必须同样遵守。
 */
export class OfficialCredentialError extends Error {
  readonly code: OfficialCredentialErrorCode;
  /** 涉及的**条目键名**（如 `zcodejwttoken`）。不是值。 */
  readonly entryKey: string | null;
  /** 来源文件绝对路径。仓路径本身不是秘密。 */
  readonly sourcePath: string | null;

  constructor(code: OfficialCredentialErrorCode, message: string, options: { readonly entryKey?: string | null; readonly sourcePath?: string | null } = {}) {
    super(`${code}: ${message}`);
    this.name = 'OfficialCredentialError';
    this.code = code;
    this.entryKey = options.entryKey ?? null;
    this.sourcePath = options.sourcePath ?? null;
  }
}

/* -------------------------------------------------------------------------- */
/* 凭据值：明文封装                                                             */
/* -------------------------------------------------------------------------- */

/**
 * 一次解密得到的**明文凭据**。
 *
 * 封口是**结构性**的，不是靠调用方记得别打印：
 *  - `#plaintext` 是真私有字段，外部拿不到，TS 也检查不到；
 *  - `toJSON()` 直接抛 —— 任何 `JSON.stringify` / 结构化日志 / 错误 detail 序列化
 *    在**取值**那一刻就炸，而不是悄悄把明文写出去；
 *  - 没有 `toString` 覆写时 `String(v)` 会给出 `[object Object]`，不含明文；
 *  - 唯一读出口 {@link reveal}，调用点只有一处：`headers-port.ts` 把它交给官方 port。
 */
export class CredentialValue {
  readonly #plaintext: string;
  /** 产生这条值的条目键名（**不是值**）。用于诊断与错误指名。 */
  readonly entryKey: string;

  constructor(entryKey: string, plaintext: string) {
    this.#plaintext = plaintext;
    this.entryKey = entryKey;
  }

  /**
   * 取出明文。**唯一出口。**
   *
   * 调用方负责：拿到之后直接交给官方 port，不得拼接进任何字符串、日志或错误消息。
   * 交出之后调用方不得长期持有副本。
   */
  reveal(): string {
    return this.#plaintext;
  }

  /** 明确堵死结构化输出。抛错而不是返回一个"安全视图"，因为安全视图会诱使人以为可以序列化。 */
  toJSON(): never {
    throw new OfficialCredentialError(
      'ENVELOPE_MALFORMED',
      '凭据明文禁止被序列化：CredentialValue.toJSON() 永远抛错。请用 reveal() 并直接交给官方 port。',
      { entryKey: this.entryKey }
    );
  }
}

/* -------------------------------------------------------------------------- */
/* secret 推导                                                                 */
/* -------------------------------------------------------------------------- */

/** 环境变量名。与官方 `G7s` 常量同名。 */
export const CREDENTIAL_SECRET_ENV_KEY = 'ZCODE_CREDENTIAL_SECRET';

/** 兜底串的固定前缀。与官方同段模板逐字一致。 */
export const CREDENTIAL_FALLBACK_PREFIX = 'zcode-credential-fallback';

export type CredentialSecretSource = 'env' | 'fallback';

export interface DerivedCredentialSecret {
  readonly source: CredentialSecretSource;
  /** 32 字节 AES-256 密钥。**不进日志**：`toJSON` 抛错。 */
  readonly key: Buffer;
  /**
   * 可安全记录的来源说明。只含前缀与来源标签，**不含** secret 本体
   * （env 分支甚至不记录 env 的键名之外任何东西；fallback 分支不记录 username/homedir）。
   */
  readonly provenance: string;
}

function sha256(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export interface SecretDerivationInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 供测试注入；缺省用 `os.platform()`。 */
  readonly platform?: string;
  /** 供测试注入；缺省用 `os.homedir()`。 */
  readonly homeDir?: string;
  /** 供测试注入；缺省用 `os.userInfo().username`。 */
  readonly username?: string;
}

/**
 * 推导 AES-256 密钥。**env 优先，兜底串次之**，两条来源形状完全一致。
 *
 * env 存在但全空白时**不**回落到兜底串——那会让"运维显式清空了 secret"被静默解释成
 * "没配过 secret"，从而用一条谁都不知道的兜底密钥去解一个谁都没配过的信封。直接报错。
 *
 * @param input env + 平台三元组（均可注入，便于零真实主机依赖的单测）
 * @returns 32 字节密钥 + 可记录的来源说明
 * @throws OfficialCredentialError `SECRET_SOURCE_INVALID`
 */
export function deriveCredentialSecret(input: SecretDerivationInput): DerivedCredentialSecret {
  const raw = input.env[CREDENTIAL_SECRET_ENV_KEY];
  if (raw !== undefined) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new OfficialCredentialError(
        'SECRET_SOURCE_INVALID',
        `${CREDENTIAL_SECRET_ENV_KEY} 存在但为空白；不回落到兜底串（回落会把"显式清空"误读成"未配置"）`
      );
    }
    return { source: 'env', key: sha256(raw), provenance: 'secret=env' };
  }

  const platform = input.platform ?? osPlatform();
  const homeDir = input.homeDir ?? osHomedir();
  const username = input.username ?? safeUsername();
  if (
    typeof platform !== 'string' || platform.trim() === '' ||
    typeof homeDir !== 'string' || homeDir.trim() === '' ||
    typeof username !== 'string' || username.trim() === ''
  ) {
    throw new OfficialCredentialError('SECRET_SOURCE_INVALID', '兜底 secret 的平台三元组不完整（platform / homedir / username 之一为空）');
  }
  const fallback = `${CREDENTIAL_FALLBACK_PREFIX}:${platform}:${homeDir}:${username}`;
  return { source: 'fallback', key: sha256(fallback), provenance: 'secret=fallback' };
}

/** `os.userInfo()` 在某些容器/沙箱下会抛；拿不到就返回空串，让调用方按"不完整"报错。 */
function safeUsername(): string {
  try {
    return osUserInfo().username;
  } catch {
    return '';
  }
}

/* -------------------------------------------------------------------------- */
/* 信封解密                                                                    */
/* -------------------------------------------------------------------------- */

/** 信封前缀。与官方 `Qdn` 同值。 */
export const ENVELOPE_PREFIX = 'enc:v1:';
/** AES-GCM IV 字节数。与官方 `KZr` 同值。 */
export const ENVELOPE_IV_BYTES = 12;
/** AES-GCM tag 字节数。与官方 `H7s` 同值。 */
export const ENVELOPE_TAG_BYTES = 16;

/** 严格 base64url 判定。官方用 `Buffer.toString("base64url")`，只出 `A-Za-z0-9-_`。 */
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * 解一个 `enc:v1:` 信封。
 *
 * 三道 fail-closed 闸门，顺序即代价从低到高：
 *  1. **形状**：前缀、三段、每段非空且只含 base64url 字符。形状不对时**不解密**——
 *     拿一段畸形输入去 `decipher.final()` 只会得到一个不可解释的 auth 失败。
 *  2. **字节长度**：iv 解出来必须恰好 12 字节、tag 恰好 16 字节。
 *  3. **认证**：`setAuthTag` + `final()`。GCM 认证失败抛错，**不返回任何部分明文**。
 *
 * @param envelope 信封全文
 * @param key 32 字节密钥
 * @param entryKey 条目键名（仅用于错误指名）
 * @returns 明文
 * @throws OfficialCredentialError
 */
export function decryptEnvelope(envelope: string, key: Buffer, entryKey: string): string {
  if (typeof envelope !== 'string' || !envelope.startsWith(ENVELOPE_PREFIX)) {
    throw new OfficialCredentialError('ENVELOPE_MALFORMED', `条目 ${entryKey} 的值不是 ${ENVELOPE_PREFIX} 信封（未加密或版本不支持）`, { entryKey });
  }
  const body = envelope.slice(ENVELOPE_PREFIX.length);
  const parts = body.split('.');
  if (parts.length !== 3) {
    throw new OfficialCredentialError(
      'ENVELOPE_MALFORMED',
      `条目 ${entryKey} 的信封必须是 3 段（iv.tag.ciphertext），实际 ${parts.length} 段`,
      { entryKey }
    );
  }
  const [ivPart, tagPart, ctPart] = parts as [string, string, string];
  for (const part of [ivPart, tagPart, ctPart]) {
    if (part.length === 0 || !BASE64URL_RE.test(part)) {
      throw new OfficialCredentialError('ENVELOPE_SEGMENT_INVALID', `条目 ${entryKey} 的信封含非 base64url 段`, { entryKey });
    }
  }
  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  const ciphertext = Buffer.from(ctPart, 'base64url');
  if (iv.length !== ENVELOPE_IV_BYTES) {
    throw new OfficialCredentialError('ENVELOPE_SEGMENT_INVALID', `条目 ${entryKey} 的 iv 段长度 ${iv.length} != ${ENVELOPE_IV_BYTES}`, { entryKey });
  }
  if (tag.length !== ENVELOPE_TAG_BYTES) {
    throw new OfficialCredentialError('ENVELOPE_SEGMENT_INVALID', `条目 ${entryKey} 的 tag 段长度 ${tag.length} != ${ENVELOPE_TAG_BYTES}`, { entryKey });
  }
  if (key.length !== 32) {
    throw new OfficialCredentialError('SECRET_SOURCE_INVALID', `AES-256-GCM 密钥长度 ${key.length} != 32`, { entryKey });
  }
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // GCM 认证失败 / 密钥不对。**不返回任何部分明文**，也不把 catch 里的原始异常
    // 往上传——Node 的认证错误消息可能带上下文，逐字上传等于把内部形状泄漏出去。
    throw new OfficialCredentialError('ENVELOPE_DECRYPT_FAILED', `条目 ${entryKey} 解密失败：密钥不匹配或密文被篡改`, { entryKey });
  }
  return plaintext.toString('utf8');
}

/* -------------------------------------------------------------------------- */
/* 三分支取键                                                                  */
/* -------------------------------------------------------------------------- */

/** 官方 T3 的三种 planKind。**闭集**。 */
export const OFFICIAL_PLAN_KINDS = ['start-plan', 'individual-coding-plan', 'team-coding-plan'] as const;
export type OfficialPlanKind = (typeof OFFICIAL_PLAN_KINDS)[number];

/**
 * 官方共享凭据仓的**条目键名表**（闭集，来自官方 `createSharedZCodeCredentialStore` 的
 * 字面量映射）。本包**只**暴露本驱动真正会读的那几个键；其余条目不读、不列、不猜。
 *
 * - `zcodejwttoken` —— start-plan 用。**不是** `oauth:*:access_token`（后者是网页登录态，
 *   不是订阅凭据；用它会让 start-plan 在官方侧根本不被认成订阅通道）。
 * - `oauth:<oauthProviderId>:user_info` —— **账号身份**的来源条目（individual-coding-plan）。
 * - `account-provider:coding-plan:<providerId>:account:<账号身份>:api-key` —— individual 用。
 */
export const START_PLAN_ENTRY_KEY = 'zcodejwttoken';

/** 官方认识的 provider family 闭集。与 `accountType: m.enum(["zai","bigmodel"])` 同值。 */
export const PROVIDER_FAMILIES = ['zai', 'bigmodel'] as const;
export type ProviderFamily = (typeof PROVIDER_FAMILIES)[number];

/**
 * family → OAuth providerId。逐字对应官方 `loadIndividualPlanApiKey` 的
 * `Me==="zai"?"zai":Ne`（`Ne` 即 `"bigmodel"`，由 `Iue=[Ne,"zai"]` 与仓内
 * `oauth:bigmodel:access_token` 双向闭合）。**闭集内外的 family 都不猜**：
 * 调用方先过 {@link isProviderFamily} 闸门。
 */
export function resolveOAuthProviderId(family: ProviderFamily): 'zai' | 'bigmodel' {
  return family === 'zai' ? 'zai' : 'bigmodel';
}

/** 官方 `xy`（注册名 `userInfoKey`）逐字：`oauth:${e}:user_info`。 */
export function userInfoEntryKey(oauthProviderId: 'zai' | 'bigmodel'): string {
  return `oauth:${oauthProviderId}:user_info`;
}

/**
 * official {@link accountProviderCredentialKey} 的 `planKind === "team-coding-plan"` 分支
 * 需要的三个额外字段。本版 team 走远程（见 {@link TEAM_PLAN_UNSUPPORTED}），因此**没有**
 * 分支会读这三个字段——它们只作为**形状锚点**存在，让 team 的真实键形在代码里可见，
 * 而不是靠注释复述。
 */
export interface TeamPlanKeyExtra {
  readonly productId: string;
  readonly organizationId: string;
  readonly projectId: string;
}

/**
 * 官方 `accountProviderCredentialKey`（桌面注册名 `Oy`，`out/host/index.js` @859336 逐字）。
 *
 * ```js
 * function Oy(e){
 *   let t=gp(e.providerId,"Provider ID"), n=gp(e.accountIdentity,"账号身份");
 *   return `account-provider:${e.planKind==="team-coding-plan"
 *     ? ["team",t,gp(e.productId,…),gp(e.organizationId,…),gp(e.projectId,…)].map(encodeURIComponent).join(":")
 *     : `${e.planKind==="start-plan"?"start-plan":"coding-plan"}:${t}`}:account:${encodeURIComponent(n)}:api-key`
 * }
 * ```
 *
 * `gp` 是官方 `required`：`.trim()` 后为空即抛。本实现把它翻译成
 * {@link OfficialCredentialError}（`ACCOUNT_PROVIDER_ID_MISSING` /
 * `ACCOUNT_IDENTITY_UNRESOLVED`），**不**让 `undefined` 渗进模板串变成字符串 `"undefined"`
 * ——那会造出一个"永远读不到、但错误信息看起来很正常"的键。
 */
export function accountProviderCredentialKey(params: {
  readonly providerId: string;
  readonly planKind: OfficialPlanKind;
  readonly accountIdentity: string;
  readonly team?: TeamPlanKeyExtra;
}): string {
  const providerId = typeof params.providerId === 'string' ? params.providerId.trim() : '';
  if (!providerId) {
    throw new OfficialCredentialError('ACCOUNT_PROVIDER_ID_MISSING', '构造 account-provider 凭据键缺少 providerId（不拼 "undefined" 键）');
  }
  const accountIdentity = typeof params.accountIdentity === 'string' ? params.accountIdentity.trim() : '';
  if (!accountIdentity) {
    throw new OfficialCredentialError('ACCOUNT_IDENTITY_UNRESOLVED', '构造 account-provider 凭据键缺少账号身份（不拼空身份键）');
  }
  const middle =
    params.planKind === 'team-coding-plan'
      ? ['team', providerId, ...teamExtras(params.team)].map((part) => encodeURIComponent(part)).join(':')
      : `${params.planKind === 'start-plan' ? 'start-plan' : 'coding-plan'}:${providerId}`;
  return `account-provider:${middle}:account:${encodeURIComponent(accountIdentity)}:api-key`;
}

function teamExtras(extra: TeamPlanKeyExtra | undefined): string[] {
  if (!extra) {
    throw new OfficialCredentialError('PLAN_KIND_UNSUPPORTED', TEAM_PLAN_UNSUPPORTED);
  }
  const parts = [extra.productId, extra.organizationId, extra.projectId].map((part) =>
    typeof part === 'string' ? part.trim() : ''
  );
  if (parts.some((part) => part === '')) {
    throw new OfficialCredentialError('PLAN_KIND_UNSUPPORTED', TEAM_PLAN_UNSUPPORTED);
  }
  return parts;
}

/**
 * individual-coding-plan 的 api-key 条目键。逐字等价于官方在
 * `planKind === "individual-coding-plan"` 下的 {@link accountProviderCredentialKey}，
 * 也逐字节等于 CLI 侧 `t3e`（`standaloneAccountProviderCredentialKey`）。
 *
 * ⚠️ **键里内嵌账号身份**——因此这个函数**必须**拿到先解析出来的身份才能调，
 * 不能拿 family 直接拼一个键去读。
 */
export function individualPlanEntryKey(providerId: string, accountIdentity: string): string {
  return accountProviderCredentialKey({ providerId, planKind: 'individual-coding-plan', accountIdentity });
}

/**
 * 官方 `loadUserProfileFromKey`（`out/host/index.js` @838895 逐字）的三字段闸门：
 * `id` / `username` / `displayName` **三者都必须是 string**，否则整体判为 `null`。
 *
 * 逐字实现，不放宽：少一个字段官方就当没登录，我们少一个字段就必须同样当没登录——
 * 否则我们会拿着一个官方根本不会认的 profile 去拼键，报出与真实原因无关的错误。
 *
 * @param rawUserProfile `oauth:<provider>:user_info` 的**明文**（已解密，未解析）
 * @param entryKey 该条目键名，仅用于错误指名
 * @returns 非空的 `.id` 字符串
 * @throws OfficialCredentialError `ACCOUNT_IDENTITY_UNRESOLVED`
 */
export function resolveAccountIdentityFromUserProfile(rawUserProfile: string, entryKey: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawUserProfile);
  } catch {
    // JSON 解析错误消息会带出**输入片段**——而输入就是 user_info 明文。不上传。
    throw new OfficialCredentialError(
      'ACCOUNT_IDENTITY_UNRESOLVED',
      `条目 ${entryKey} 的明文不是合法 JSON（不附原始解析消息：其中可能含 profile 片段）`,
      { entryKey }
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OfficialCredentialError('ACCOUNT_IDENTITY_UNRESOLVED', `条目 ${entryKey} 顶层不是对象`, { entryKey });
  }
  const profile = parsed as Record<string, unknown>;
  const fields = ['id', 'username', 'displayName'] as const;
  for (const field of fields) {
    if (typeof profile[field] !== 'string') {
      throw new OfficialCredentialError(
        'ACCOUNT_IDENTITY_UNRESOLVED',
        `条目 ${entryKey} 缺官方要求的三字段之一（${field} 不是 string）；官方此时判 profile 为 null`,
        { entryKey }
      );
    }
  }
  return (profile['id'] as string).trim();
}

/**
 * team-coding-plan 的取键**本版不支持**。
 *
 * 官方对团队套餐走 `resolveTeamPlanApiKey`，其取值依赖官方账号服务的实时应答而不是本地
 * 凭据仓里的固定条目；仓里没有对应键，编一个键名去读只会读到 `undefined` 然后报一个
 * 与真实原因无关的错误。所以这里**显式不支持并诚实报错**（brief 允许的做法）。
 *
 * 解除路径：等官方把团队套餐的本地凭据形状定死后再加分支，届时必须同时加测试。
 */
export const TEAM_PLAN_UNSUPPORTED =
  'team-coding-plan 需要官方 resolveTeamPlanApiKey 的实时应答，本地凭据仓里没有对应条目；本版显式不支持，不猜键名。';

export interface ResolveCredentialRequest {
  readonly planKind: OfficialPlanKind;
  readonly family: ProviderFamily;
  /**
   * 目标 providerId（如 `account:bigmodel-individual-coding-plan`）。
   *
   * individual-coding-plan **必填**：官方 api-key 条目键里内嵌 providerId，拿不到就
   * fail-closed 报 `ACCOUNT_PROVIDER_ID_MISSING`。start-plan 的条目键是平铺的
   * `zcodejwttoken`，**不**用到它，因此对它可省略。
   */
  readonly providerId?: string;
  /** 仓路径。缺省按官方 `n$s` 规则解析。 */
  readonly credentialsPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 供测试注入的读取函数。缺省 `readFileSync`（只读）。 */
  readonly readFile?: (path: string) => string;
  /** 供测试注入的平台三元组。 */
  readonly platform?: string;
  readonly homeDir?: string;
  readonly username?: string;
}

/** 仓路径解析。逐字对应官方 `resolveSharedZCodeCredentialsPath`。 */
export function resolveCredentialsPath(options: { readonly credentialsPath?: string; readonly env?: Readonly<Record<string, string | undefined>>; readonly homeDir?: string } = {}): string {
  if (options.credentialsPath !== undefined) return options.credentialsPath;
  const env = options.env ?? (process.env as Readonly<Record<string, string | undefined>>);
  const baseDir = env['ZCODE_DATA_BASE_DIR']?.trim() ?? options.homeDir ?? osHomedir();
  return join(baseDir, '.zcode', 'v2', 'credentials.json');
}

/** 仓文档形状：顶层是 `{ [条目键名]: <信封字符串> }`。我们只按需读键，不遍历。 */
export type CredentialStoreDocument = Readonly<Record<string, unknown>>;

/** 解析仓文本。**只做 JSON 形状校验，不解密任何条目**——解密是按需的、逐条发生的。 */
export function parseCredentialStore(text: string, path: string): CredentialStoreDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 解析失败的消息**不上传**：Node 的 JSON 错误会带出文件内容片段，而仓里全是密文。
    throw new OfficialCredentialError('CREDENTIALS_JSON_INVALID', '凭据仓不是合法 JSON（不附原始解析消息：其中可能含密文片段）', { sourcePath: path });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OfficialCredentialError('CREDENTIALS_SHAPE_INVALID', '凭据仓顶层必须是对象', { sourcePath: path });
  }
  return parsed as CredentialStoreDocument;
}

/** 读仓（只读）。缺失 / 不可读各报明确码。 */
export function readCredentialStore(options: ResolveCredentialRequest = { planKind: 'start-plan', family: 'zai' }): { readonly path: string; readonly document: CredentialStoreDocument } {
  const path = resolveCredentialsPath(options);
  const readFile = options.readFile ?? defaultReadFile;
  let text: string;
  try {
    text = readFile(path);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') {
      throw new OfficialCredentialError('CREDENTIALS_FILE_NOT_FOUND', `凭据仓不存在于约定路径；不会改用别的路径或猜测位置`, { sourcePath: path });
    }
    throw new OfficialCredentialError('CREDENTIALS_UNREADABLE', `凭据仓读取失败：${err?.code ?? 'unknown'}`, { sourcePath: path });
  }
  return { path, document: parseCredentialStore(text, path) };
}

function defaultReadFile(path: string): string {
  // 只读。绝不用 writeFileSync / unlink / rename——本仓是官方凭据，写它等于改用户账号。
  return readFileSync(path, 'utf8');
}

/**
 * 仓内取一个条目的信封。**只按键名取，不遍历、不打印。**
 *
 * 缺失时报的是"哪个键不在仓里"，不是"这个键的值是什么"。
 */
function readEnvelope(document: CredentialStoreDocument, entryKey: string, path: string): string {
  const raw = document[entryKey];
  if (raw === undefined || raw === null) {
    throw new OfficialCredentialError('CREDENTIAL_ENTRY_MISSING', `凭据仓里没有条目 ${entryKey}（只报键名，不报任何值）`, { entryKey, sourcePath: path });
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new OfficialCredentialError('CREDENTIALS_SHAPE_INVALID', `条目 ${entryKey} 的值不是非空字符串`, { entryKey, sourcePath: path });
  }
  return raw;
}

/**
 * 解出一个条目并封成 {@link CredentialValue}。
 *
 * "解出空串就拒"是**第三层**防线（信封形状合法、认证通过，但内容是空）——空 apiKey 会让
 * 官方侧报一个与真实原因（仓被清空 / 换过密钥）完全无关的鉴权错误。
 */
function openEntry(
  document: CredentialStoreDocument,
  entryKey: string,
  key: Buffer,
  path: string
): CredentialValue {
  const plaintext = decryptEnvelope(readEnvelope(document, entryKey, path), key, entryKey);
  if (plaintext.trim() === '') {
    throw new OfficialCredentialError('ENVELOPE_DECRYPT_FAILED', `条目 ${entryKey} 解密结果是空串；拒绝把空值当凭据送出`, { entryKey, sourcePath: path });
  }
  return new CredentialValue(entryKey, plaintext);
}

/**
 * 三分支取键（工单交付物 1）。
 *
 * 逐字对齐官方桌面 `AccountProviderRequestAuthService.resolveCurrent`
 * （`out/host/index.js` @933554）：
 * ```js
 * if(r.planKind==="start-plan")        { return{apiKey:k_(s?.zcodeJwtToken,n)} }
 * if(r.planKind==="individual-coding-plan"){ return{apiKey:k_(await loadIndividualPlanApiKey(n,r.family),n)} }
 * return{apiKey:k_(await resolveTeamPlanApiKey(r),n)}
 * ```
 * 第三支依赖远程账号服务（`resolveTeamPlanApiKey`），本版**显式不支持**（见
 * {@link TEAM_PLAN_UNSUPPORTED}）——不编键名去读。
 *
 * 返回的 {@link CredentialValue} 的明文只在 {@link CredentialValue.reveal} 被调用时存在，
 * 调用点的唯一合法去向是官方 `providerRuntimeHeadersPort`。
 *
 * @param request planKind + family + providerId + 可注入的仓/env/平台
 * @returns 带明文的凭据值
 * @throws OfficialCredentialError
 */
export function resolveCredentialForPlan(request: ResolveCredentialRequest): CredentialValue {
  const derived = deriveCredentialSecret({
    env: request.env ?? (process.env as Readonly<Record<string, string | undefined>>),
    ...(request.platform === undefined ? {} : { platform: request.platform }),
    ...(request.homeDir === undefined ? {} : { homeDir: request.homeDir }),
    ...(request.username === undefined ? {} : { username: request.username })
  });
  const { path, document } = readCredentialStore(request);

  if (request.planKind === 'start-plan') {
    // 平铺条目：不需要账号身份，也不需要 providerId。**这条分支逐字未改**。
    return openEntry(document, START_PLAN_ENTRY_KEY, derived.key, path);
  }

  if (request.planKind === 'individual-coding-plan') {
    if (!(PROVIDER_FAMILIES as readonly string[]).includes(request.family)) {
      throw new OfficialCredentialError('PROVIDER_FAMILY_UNKNOWN', `provider family ${JSON.stringify(request.family)} 不在闭集内（不猜）`);
    }
    // 官方 `Oy` 的 `gp(e.providerId,"Provider ID")`：缺 providerId 必须在这里停，
    // 不能让它渗进模板串变成 "undefined" 键——那会读到一个永远不存在的条目，
    // 报出与真实原因（调用方没传 providerId）无关的 CREDENTIAL_ENTRY_MISSING。
    const providerId = typeof request.providerId === 'string' ? request.providerId.trim() : '';
    if (!providerId) {
      throw new OfficialCredentialError(
        'ACCOUNT_PROVIDER_ID_MISSING',
        'individual-coding-plan 的 api-key 条目键内嵌 providerId；未提供则拒绝拼键（不猜、不拼 "undefined"）'
      );
    }
    // 官方 `loadIndividualPlanApiKey`：账号身份来自 `oauth:<oauthProviderId>:user_info` 的 `.id`。
    const userInfoKey = userInfoEntryKey(resolveOAuthProviderId(request.family as ProviderFamily));
    const accountIdentity = resolveAccountIdentityFromUserProfile(
      openEntry(document, userInfoKey, derived.key, path).reveal(),
      userInfoKey
    );
    if (!accountIdentity) {
      throw new OfficialCredentialError('ACCOUNT_IDENTITY_UNRESOLVED', `条目 ${userInfoKey} 的 id 为空白；拒绝用空身份拼键`, { entryKey: userInfoKey, sourcePath: path });
    }
    return openEntry(document, individualPlanEntryKey(providerId, accountIdentity), derived.key, path);
  }

  throw new OfficialCredentialError('PLAN_KIND_UNSUPPORTED', TEAM_PLAN_UNSUPPORTED);
}

/**
 * 解密结果的**可记录摘要**：只有来源标签与条目键名，**没有值、也没有值的长度**。
 *
 * 值的长度也是指纹——start-plan 的 apiKey 与 oauth access_token 长度不同，能把"拿错了
 * 条目"这类错误区分出来。所以这里连长度都不给，只给"解成功 / 解失败"。
 */
export interface CredentialResolutionSummary {
  readonly entryKey: string;
  readonly planKind: OfficialPlanKind;
  readonly family: ProviderFamily;
  readonly secretSource: CredentialSecretSource;
  readonly decrypted: boolean;
  readonly sourcePath: string;
}

export function summarizeCredentialResolution(
  value: CredentialValue,
  request: Pick<ResolveCredentialRequest, 'planKind' | 'family' | 'env' | 'platform' | 'homeDir' | 'username' | 'credentialsPath'>,
  path: string
): CredentialResolutionSummary {
  const derived = deriveCredentialSecret({
    env: request.env ?? (process.env as Readonly<Record<string, string | undefined>>),
    ...(request.platform === undefined ? {} : { platform: request.platform }),
    ...(request.homeDir === undefined ? {} : { homeDir: request.homeDir }),
    ...(request.username === undefined ? {} : { username: request.username })
  });
  return {
    entryKey: value.entryKey,
    planKind: request.planKind,
    family: request.family,
    secretSource: derived.source,
    decrypted: true,
    sourcePath: path
  };
}
