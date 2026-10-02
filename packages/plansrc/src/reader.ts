/**
 * PLANSRC reader —— 官方本地套餐/目录三文件只读器。
 *
 * 五条硬事实：
 *  1. **零发送。** 本文件只做 `readFileSync`。没有 fetch、没有 http、没有 child_process、
 *     没有官方进程启动，也不读 SQLite。三个源文件全程**只读**：只打开读取，绝不写、
 *     绝不 rename、绝不删。
 *  2. **凭据值在 JSON.parse 之前就被擦掉。** 这不是"解析完再删字段"——那样值已经作为
 *     JS 字符串在本进程里存在过了。`scrubCredentialValues()` 在**文本层**把
 *     `"<凭据键>": "<任意内容>"` 整段替换成 `"<凭据键>": "[REDACTED]"`，之后才交给
 *     `JSON.parse`。因此假 key 的值从不成为本进程的字符串、也从不进日志。
 *     解析后再做一次纵深清扫（`stripCredentialValues`），覆盖"值不是 JSON 字符串"
 *     的写法（例如 `"apiKey": { "v": "..." }`）。两条都不依赖调用方记得别打印。
 *  3. **只记位置，不记值。** `listCredentialLocations()` 返回 JSONPath 数组
 *     （如 `$.config.providerConfigRules.providerRules[0].config.access.apiKey`），
 *     用来回答"这里有没有凭据"，不回答"凭据是什么"。
 *  4. **不猜。** 文件缺失 / 目录不可读 / 非 UTF-8 / 非法 JSON / 形状不对，各有独立
 *     错误码并指名是哪个文件、哪条路径。`allowMissing` 是**显式**的：默认三个文件缺一不可。
 *  5. **擦除按精确键名，不按前缀。** `apiKeyManagementUrl` 与 `apiKey` 前缀相同但**不是**
 *     凭据（它是管理页 URL），必须原样保留——按前缀乱砍会把可用配置删掉，而按精确键名
 *     砍则既不漏也不误伤。
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/* -------------------------------------------------------------------------- */
/* 错误码                                                                        */
/* -------------------------------------------------------------------------- */

export const PLANSRC_ERROR_CODES = [
  'PLANSRC_BUILTIN_NOT_FOUND',
  'PLANSRC_SETTING_NOT_FOUND',
  'PLANSRC_CACHE_NOT_FOUND',
  'PLANSRC_UNREADABLE',
  'PLANSRC_NOT_UTF8',
  'PLANSRC_JSON_INVALID',
  'PLANSRC_SHAPE_INVALID'
] as const;
export type PlanSourceErrorCode = (typeof PLANSRC_ERROR_CODES)[number];

/** 哪个源文件。既是错误里的定位信息，也是 `allowMissing` 的取值。 */
export type PlanSourceId = 'builtinFile' | 'settingFile' | 'cacheFile';

const NOT_FOUND_CODE: Readonly<Record<PlanSourceId, PlanSourceErrorCode>> = {
  builtinFile: 'PLANSRC_BUILTIN_NOT_FOUND',
  settingFile: 'PLANSRC_SETTING_NOT_FOUND',
  cacheFile: 'PLANSRC_CACHE_NOT_FOUND'
};

export class PlanSourceError extends Error {
  readonly code: PlanSourceErrorCode;
  readonly source: PlanSourceId;
  readonly path: string;

  constructor(code: PlanSourceErrorCode, source: PlanSourceId, path: string, detail: string) {
    super(`${code}: ${detail}（文件 ${source} = ${path}）`);
    this.name = 'PlanSourceError';
    this.code = code;
    this.source = source;
    this.path = path;
  }
}

/* -------------------------------------------------------------------------- */
/* 凭据红线                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 凭据键的**闭集**。加一个键是一次必须同时改测试的显式动作。
 *
 * 短名单是有意的：宁可漏掉一个键让纵深清扫兜住，也不要把 `logo.key`
 * 这类非凭据字段误删——误删会让真实配置丢失，那比多留一个键更糟。
 */
export const CREDENTIAL_KEYS = [
  'apiKey',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'password',
  'authorization',
  'cookie',
  'credential',
  'privateKey'
] as const;
export type CredentialKey = (typeof CREDENTIAL_KEYS)[number];

const CREDENTIAL_KEY_SET: ReadonlySet<string> = new Set<string>(CREDENTIAL_KEYS);

/** 值被替换成的占位符。它本身不是凭据，可以安全地出现在输出里。 */
export const REDACTED_PLACEHOLDER = '[REDACTED]';

/**
 * 文本层擦除。**必须发生在 `JSON.parse` 之前**。
 *
 * 值用**一条**正则一次吃掉，这是实测踩出来的：
 *  - 字符串值：`"任意字符串"`（含转义引号）整段替换。
 *  - 标量值：`123` / `true` / `false` / `null` 整段替换。
 *
 * **对象 / 数组形态的凭据值不在这一层处理**（`"apiKey": {"v":"sk-…"}`）：
 * 正则无法括号配平，硬凑只会把文件改坏（`{` / `}` 会在内部被截断）。那一层交给
 * {@link stripCredentialValues} 的**结构化**清扫——它在解析后的对象上做，正确处理任意嵌套。
 * 两层分工：文本层保证"值不作为文本流过"，结构层保证"输出里没有它"。
 * 标量分支因此把 `{ } [ ] " 空白 ,` 全部排除：JSON 标量（number / true / false / null）
 * 一个都用不到这些字符，所以"只吃标量"既精确又不会误吞结构字符。
 *
 * 之所以**必须一次吃完**（曾经写成"先替字符串、再替非字符串"两条正则，结果把文件改坏）：
 * 第二条正则里 `\s*:\s*` 是贪婪的，引擎在 `(?!")` 失败时会**回退** `\s*` 交出一个空格，
 * 于是它在 `": "` 的空格处匹配成功，把占位符插到冒号后面，**原值被留在原地**。
 * 本机 `~/.zcode/v2/provider_config.json` 正是带空格的 pretty-print 格式，
 * 实测输出变成 `"apiKey": "[REDACTED]" "原值"`，JSON 直接解析失败——
 * 把"凭据保护"换成了"读不出文件"。合并成单条正则后值被完整消费，不再有残留。
 *
 * 之所以按 `"键名"` **带引号精确匹配**而不是按 `apiKey` 子串：`"apiKeyManagementUrl"`
 * 里含有 `apiKey` 子串，按子串匹配会把它也擦掉，那是误伤。
 * JSON 字符串值内部的引号必然被转义成 `\"`，所以值里出现的 `\"apiKey\"` 不会
 * 被误判成键名。
 */
const CREDENTIAL_VALUE_RE = new RegExp(
  `("(?:${CREDENTIAL_KEYS.join('|')})"\\s*:\\s*)(?:"(?:[^"\\\\]|\\\\.)*"|[^"{}\\[\\]\\s,]+)`,
  'g'
);

/**
 * 把原始 JSON 文本里的凭据值整段替换成 {@link REDACTED_PLACEHOLDER}。
 * 纯字符串变换，不做解析；非 JSON 输入也安全（正则匹配不到就原样返回）。
 *
 * @param raw 原始文本
 * @returns 擦除后的文本；**保证仍是合法 JSON**（本机真实 pretty-print 文件已实测）
 */
export function scrubCredentialValues(raw: string): string {
  return raw.replace(CREDENTIAL_VALUE_RE, `$1"${REDACTED_PLACEHOLDER}"`);
}

/**
 * 纵深清扫：把对象里所有凭据键的值换成占位符。返回**新对象**，不改入参。
 * 覆盖解析后才发现的形态（例如凭据藏在数组元素里、或值是对象）。
 *
 * @param value 任意已解析值
 * @returns 擦除后的深拷贝
 */
export function stripCredentialValues<T>(value: T): T {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map((x) => walk(x));
    if (node === null || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      out[key] = CREDENTIAL_KEY_SET.has(key) ? REDACTED_PLACEHOLDER : walk(child);
    }
    return out;
  };
  return walk(value) as T;
}

/**
 * 枚举凭据键的 **JSONPath 位置**。只报位置，绝不返回值。
 *
 * @param doc 已擦除的文档
 * @returns 形如 `$.config.providerConfigRules.providerRules[0].config.access.apiKey` 的数组
 */
export function listCredentialLocations(doc: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const at = `${path}.${key}`;
      if (CREDENTIAL_KEY_SET.has(key)) {
        out.push(at);
        continue;
      }
      walk(child, at);
    }
  };
  walk(doc, '$');
  return out;
}

/* -------------------------------------------------------------------------- */
/* 路径                                                                          */
/* -------------------------------------------------------------------------- */

/** 安装树里官方内置目录的真实位置（E1R §2.3 实测存在）。 */
export const DEFAULT_BUILTIN_PROVIDER_FILE = 'C:/ZCode/resources/config/provider/zcode-builtin.json';

export interface ResolvedPlanSourcePaths {
  readonly builtinFile: string;
  readonly settingFile: string;
  readonly cacheFile: string;
  readonly dataBaseDir: string;
}

export interface ResolvePathOptions {
  readonly dataBaseDir?: string;
  readonly builtinFile?: string;
  readonly settingFile?: string;
  readonly cacheFile?: string;
  /** 供测试注入的环境变量；缺省用 `process.env`。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 供测试注入的家目录；缺省用 `os.homedir()`。 */
  readonly homeDir?: string;
}

/**
 * 解析三个源文件路径。优先级：显式参数 > 环境变量 > 约定默认值。
 *
 * - builtin：`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`（官方 CLI 自己注入的键，E1R §2.1）
 *   优先于安装树默认值——运行时刷新过的副本比安装树里的更新。
 * - setting / cache：`<dataBaseDir>/.zcode/v2/…`，`dataBaseDir` 取
 *   `ZCODE_DATA_BASE_DIR` 或家目录，与官方 `dQi` 的 `dataBaseDir ?? ZCODE_DATA_BASE_DIR ?? homedir()`
 *   逐字一致（E1R §2.2）。
 *
 * 本函数**只算路径，不碰文件系统**：路径不存在由读取时报明确的 NOT_FOUND。
 *
 * @param options 覆盖项
 * @returns 三个已解析路径
 */
export function resolvePlanSourcePaths(options: ResolvePathOptions = {}): ResolvedPlanSourcePaths {
  const env = options.env ?? (process.env as Readonly<Record<string, string | undefined>>);
  const dataBaseDir = options.dataBaseDir ?? env['ZCODE_DATA_BASE_DIR']?.trim() ?? options.homeDir ?? homedir();
  const builtinFile =
    options.builtinFile ??
    env['ZCODE_BUILTIN_PROVIDER_CONFIG_FILE']?.trim() ??
    env['ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE']?.trim() ??
    DEFAULT_BUILTIN_PROVIDER_FILE;
  const v2 = join(dataBaseDir, '.zcode', 'v2');
  return {
    builtinFile,
    settingFile: options.settingFile ?? join(v2, 'setting.json'),
    cacheFile: options.cacheFile ?? join(v2, 'coding-plan-cache.json'),
    dataBaseDir
  };
}

/* -------------------------------------------------------------------------- */
/* 读取                                                                          */
/* -------------------------------------------------------------------------- */

/** 单个源文件的读取结果。`present: false` 只在显式 `allowMissing` 时出现。 */
export interface PlanSourceDocument<T = unknown> {
  readonly id: PlanSourceId;
  readonly path: string;
  readonly present: boolean;
  readonly bytes: number;
  readonly sha256: string;
  /** 已擦除凭据后的文档；`present: false` 时为 `null`。 */
  readonly document: T | null;
  /** 凭据键的 JSONPath 位置（**不含值**）。 */
  readonly credentialLocations: readonly string[];
  readonly readAt: number;
}

export interface ReadPlanSourcesOptions {
  readonly paths?: ResolvedPlanSourcePaths | Partial<ResolvedPlanSourcePaths>;
  /** 显式允许缺失的源文件。默认三个都必需。 */
  readonly allowMissing?: readonly PlanSourceId[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  /** 测试用：注入读取函数。生产路径恒为 `readFileSync`（只读）。 */
  readonly readFile?: (path: string) => Buffer;
}

export interface PlanSources {
  readonly builtin: PlanSourceDocument;
  readonly setting: PlanSourceDocument;
  readonly cache: PlanSourceDocument;
}

/** 空文档（`present: false` 时用）。所有字段都诚实为空，不填占位。 */
function absentDocument(id: PlanSourceId, path: string, readAt: number): PlanSourceDocument {
  return { id, path, present: false, bytes: 0, sha256: '', document: null, credentialLocations: [], readAt };
}

/** 严格 UTF-8 解码 + 去 BOM。`fatal: true` 保证非法字节序列被识别而不是悄悄变成 U+FFFD。 */
function decodeUtf8Strict(bytes: Buffer, id: PlanSourceId, path: string): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new PlanSourceError('PLANSRC_NOT_UTF8', id, path, '文件不是合法 UTF-8 字节序列（不是 JSON 结构问题，是编码问题）');
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 读一次，拿到原始字节与**已擦除**的文本。文件只被打开一次。 */
function readAndScrub(id: PlanSourceId, filePath: string, readFile: (path: string) => Buffer): { bytes: number; sha256: string; text: string } {
  let raw: Buffer;
  try {
    raw = readFile(filePath);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') {
      throw new PlanSourceError(NOT_FOUND_CODE[id], id, filePath, '源文件不存在；不会改用别的路径或猜测位置');
    }
    throw new PlanSourceError('PLANSRC_UNREADABLE', id, filePath, `读取失败：${err?.code ?? String(e)}`);
  }
  return {
    bytes: raw.length,
    sha256: createHash('sha256').update(raw).digest('hex'),
    text: scrubCredentialValues(decodeUtf8Strict(raw, id, filePath))
  };
}

/**
 * 读单个源文件并返回**即将交给 `JSON.parse` 的那份文本**（已擦除、仍是合法 JSON）。
 *
 * 单独导出它，是为了让"擦除发生在 `JSON.parse` 之前"这条性质**可被外部观察与断言**。
 * 只断言最终 DTO 里搜不到凭据值，证明不了"解析前就没读过它"——那是两件事：
 * 前者是输出安全，后者是那个字符串在本进程里**根本不存在过**。
 *
 * @param id 源文件标识（决定错误码）
 * @param filePath 文件路径
 * @param readFile 注入的读取函数；缺省 `readFileSync`（只读）
 * @returns 擦除后的原始文本
 * @throws {PlanSourceError} 缺失 / 不可读 / 非 UTF-8
 */
export function readSourceText(id: PlanSourceId, filePath: string, readFile?: (path: string) => Buffer): string {
  return readAndScrub(id, filePath, readFile ?? ((p: string) => readFileSync(p))).text;
}

function readOne<T>(
  id: PlanSourceId,
  path: string,
  readFile: (path: string) => Buffer,
  readAt: number,
  allowAbsent: boolean
): PlanSourceDocument<T> {
  let scrubbed: { bytes: number; sha256: string; text: string };
  try {
    scrubbed = readAndScrub(id, path, readFile);
  } catch (e) {
    if (allowAbsent && e instanceof PlanSourceError && e.code === NOT_FOUND_CODE[id]) {
      return absentDocument(id, path, readAt) as PlanSourceDocument<T>;
    }
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(scrubbed.text);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'parse failed';
    throw new PlanSourceError('PLANSRC_JSON_INVALID', id, path, `不是合法 JSON：${message}`);
  }
  const document = stripCredentialValues(parsed);
  return {
    id,
    path,
    present: true,
    bytes: scrubbed.bytes,
    sha256: scrubbed.sha256,
    document: document as T,
    credentialLocations: listCredentialLocations(document),
    readAt
  };
}

/**
 * 读三个源文件。全程只读。
 *
 * @param options 路径覆盖 / 允许缺失 / 时钟 / 读取函数
 * @returns 三个已擦除的文档 + 各自的 sha256 与凭据位置
 * @throws {PlanSourceError} 文件缺失 / 不可读 / 非 UTF-8 / 非法 JSON
 */
export function readPlanSources(options: ReadPlanSourcesOptions = {}): PlanSources {
  const resolved = resolvePlanSourcePaths(options.paths ?? {});
  const now = options.now ?? Date.now;
  const readFile = options.readFile ?? ((p: string) => readFileSync(p));
  const allow = new Set<PlanSourceId>(options.allowMissing ?? []);
  const readAt = now();
  const sources: PlanSources = {
    builtin: readOne<BuiltinDocument>('builtinFile', resolved.builtinFile, readFile, readAt, allow.has('builtinFile')),
    setting: readOne<SettingDocument>('settingFile', resolved.settingFile, readFile, readAt, allow.has('settingFile')),
    cache: readOne<CacheDocument>('cacheFile', resolved.cacheFile, readFile, readAt, allow.has('cacheFile'))
  };
  // 形状校验紧跟读取：读到了但结构对不上同样是"明确错误码"，不是"尽力而为"。
  assertPlanSourceShapes(sources);
  return sources;
}

/* -------------------------------------------------------------------------- */
/* 骨架类型（只声明本包真正读到的键；其余键一律不碰）                                  */
/* -------------------------------------------------------------------------- */

export interface BuiltinAccess {
  readonly type?: unknown;
  readonly mode?: unknown;
  readonly accountType?: unknown;
  readonly [key: string]: unknown;
}

export interface BuiltinProviderRule {
  readonly providerId?: unknown;
  readonly providerName?: unknown;
  readonly config?: {
    readonly group?: unknown;
    readonly visibility?: unknown;
    readonly builtinModelIds?: unknown;
    readonly access?: BuiltinAccess;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

export interface BuiltinModelRule {
  readonly modelMatch?: unknown;
  readonly config?: {
    readonly enabled?: unknown;
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly optionSpecs?: Readonly<Record<string, unknown>>;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

export interface BuiltinProviderModelRule {
  readonly providerId?: unknown;
  readonly modelId?: unknown;
  readonly config?: { readonly enabled?: unknown; readonly [key: string]: unknown };
  readonly [key: string]: unknown;
}

export interface BuiltinDocument {
  readonly schemaVersion?: unknown;
  readonly revision?: unknown;
  readonly config?: {
    readonly providerConfigRules?: { readonly providerRules?: unknown; readonly [key: string]: unknown };
    readonly modelConfigRules?: {
      readonly modelRules?: unknown;
      readonly builtinProviderModelRules?: unknown;
      readonly [key: string]: unknown;
    };
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

export interface SettingDocument {
  readonly providerFamilyDomain?: unknown;
  readonly providerFamilyDomainUpdatedAt?: unknown;
  readonly providerFamilyConnectionSelections?: unknown;
  readonly [key: string]: unknown;
}

export interface CacheDocument {
  readonly version?: unknown;
  readonly entryStatus?: {
    readonly updatedAt?: unknown;
    readonly items?: unknown;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

/* -------------------------------------------------------------------------- */
/* 形状校验：不猜，报明确码                                                         */
/* -------------------------------------------------------------------------- */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireArray(
  value: unknown,
  id: PlanSourceId,
  path: string,
  jsonPath: string,
  doc: PlanSourceDocument
): unknown[] {
  if (!Array.isArray(value)) {
    throw new PlanSourceError('PLANSRC_SHAPE_INVALID', id, path, `${jsonPath} 必须是数组，实际是 ${describe(value)}（${doc.sha256.slice(0, 12)}）`);
  }
  return value;
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function optionalArray(value: unknown, id: PlanSourceId, path: string, jsonPath: string, doc: PlanSourceDocument): unknown[] {
  if (value === undefined) return [];
  return requireArray(value, id, path, jsonPath, doc);
}

/** 校验三个文档的关键骨架。任何一处对不上就抛 `PLANSRC_SHAPE_INVALID`，指名 JSONPath。 */
export function assertPlanSourceShapes(sources: PlanSources): void {
  const b = sources.builtin;
  if (b.present) {
    requireArray(
      (b.document as BuiltinDocument | null)?.config?.providerConfigRules?.providerRules,
      'builtinFile',
      b.path,
      '$.config.providerConfigRules.providerRules',
      b
    );
    optionalArray(
      (b.document as BuiltinDocument | null)?.config?.modelConfigRules?.modelRules,
      'builtinFile',
      b.path,
      '$.config.modelConfigRules.modelRules',
      b
    );
    optionalArray(
      (b.document as BuiltinDocument | null)?.config?.modelConfigRules?.builtinProviderModelRules,
      'builtinFile',
      b.path,
      '$.config.modelConfigRules.builtinProviderModelRules',
      b
    );
  }
  const s = sources.setting;
  if (s.present) {
    const selections = (s.document as SettingDocument | null)?.providerFamilyConnectionSelections;
    if (selections !== undefined && !isPlainObject(selections)) {
      throw new PlanSourceError(
        'PLANSRC_SHAPE_INVALID',
        'settingFile',
        s.path,
        `$.providerFamilyConnectionSelections 必须是对象，实际是 ${describe(selections)}`
      );
    }
    const domain = (s.document as SettingDocument | null)?.providerFamilyDomain;
    if (domain !== undefined && domain !== null && typeof domain !== 'string') {
      throw new PlanSourceError(
        'PLANSRC_SHAPE_INVALID',
        'settingFile',
        s.path,
        `$.providerFamilyDomain 必须是字符串，实际是 ${describe(domain)}`
      );
    }
  }
  const c = sources.cache;
  if (c.present) {
    const cd = c.document as CacheDocument | null;
    const items = cd?.entryStatus?.items;
    if (items !== undefined && !isPlainObject(items)) {
      throw new PlanSourceError('PLANSRC_SHAPE_INVALID', 'cacheFile', c.path, `$.entryStatus.items 必须是对象，实际是 ${describe(items)}`);
    }
    const updatedAt = cd?.entryStatus?.updatedAt;
    if (updatedAt !== undefined && typeof updatedAt !== 'number') {
      throw new PlanSourceError('PLANSRC_SHAPE_INVALID', 'cacheFile', c.path, `$.entryStatus.updatedAt 必须是数字，实际是 ${describe(updatedAt)}`);
    }
  }
}
