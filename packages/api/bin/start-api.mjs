#!/usr/bin/env node
/**
 * `packages/api` 的**可运行入口**（API01 补件，见 §R2）。
 *
 * 一句话：在**没有任何虚构默认值**的前提下，把 `createApiServer()` 真正跑起来，
 * 让"本机 API"从一个只能被单测 import 的库变成一条能敲的进程命令。
 *
 * 七条硬事实：
 *  1. **没有 key 就不启动。** API key 只能来自环境变量 `ZCC_API_KEY`；缺失或全空白
 *     直接拒绝并非零退出。**绝不生成默认弱 key**——一个能被猜到的默认 key 等于
 *     任何本机进程都能白嫖本机 API，比"起不来"糟糕得多。
 *  2. **驱动器是闭集。** 只认 `none` / `fixture` / `local-official`（+ 默认 `none`）。
 *     未知值 fail-closed 拒绝，不静默回落到默认值。
 *  3. **`fixture` 在配置里表达不出来。** 它是"假模型产出"，生产路径必须结构上开不了。
 *     所以本入口**只认识这个名字、但不接受它**：给 `fixture` 报的是精确的
 *     `FIXTURE_DRIVER_TEST_ONLY`，而不是含糊的"未知驱动器"。唯一合法路径是进程内
 *     `import { FIXTURE_TEST_TOKEN }` 后构造——symbol 跨不过进程边界，这是设计，不是缺陷。
 *  4. **CORS 保持默认关闭、Origin 白名单保持空。** 本入口**从不**传 `allowedOrigins`。
 *     任何带 `Origin` 的请求照旧被拒；本轮不开这个口子。
 *  5. **只绑回环。** 绑定地址不暴露为配置：恒为 `HOST_LOOPBACK`（`127.0.0.1`）。
 *     要改绑定地址必须改源码并让契约测试变红，不给命令行后门。
 *  6. **不静默忽略未知 `ZCC_*` 环境变量。** 与 `API_SERVER_CONFIG_KEYS` 同一纪律：
 *     凡是我们不认的前缀键一律拒绝启动，而不是"读了几个剩下的"。
 *  7. **不用 `process.exit` 收尾。** `SIGINT` / `SIGTERM` 走 `server.stop()` 的
 *     **有界**收束（先停新连接 → 在途请求等到 `shutdownGraceMs` → 超时如实报
 *     `timedOut` 并强拆 socket）。收束完没有残留句柄，进程**自然**退出并带上退出码；
 *     用 `process.exit` 掐掉就等于把"还有人在途"这件事藏起来。
 *
 * ── 为什么需要一段模块解析钩子 ──
 * `packages/**` 的源码是 TypeScript，内部一律用 `nodenext` 约定的 `.js` 说明符互引
 * （`server.ts` 里 `import ... from './errors.js'`）。Node 的类型剥离**只**擦类型、
 * **不**改说明符，所以直接 `import '../src/server.js'` 会找不到文件。
 * 本文件注册一个**同步的** `registerHooks` 解析钩子：相对说明符若以 `.js` 结尾、
 * 且同目录下确实存在同名 `.ts`，就改指到那个 `.ts`。
 *  - 只在**真正被当作入口执行**时注册（`isMainModule()` 守卫），import 本模块做单测时
 *    不会把钩子装进 vitest 的工作线程、干扰它自己的解析。
 *  - 只在 `.ts` 兄弟文件**确实存在**时才改写，其余一律交回 Node 默认解析器。
 *
 * 零网络外联、零官方进程、零数据库、零模型请求。
 */
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';

/* -------------------------------------------------------------------------- */
/* 闭集                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 本入口认识的驱动器名。**闭集**：不在表里的一律拒绝启动。
 *
 * - `none`：不挂驱动器（`createApiServer` 的缺省）。目录为空、聊天路由 503。
 * - `local-official`：经 PLANSRC 既有闭集接入点 `loadLocalOfficialDriver()` 构造，
 *   目录来自本机官方本地文件（**只读、零发送**），但 `status` 仍是 `not_attached`，
 *   所以 `model_is_real === false` 且没有任何模型产出通道。
 * - `official-host`：经 OFFICIAL-HOST 包构造，**官方 bundle 作宿主**（子进程隔离）。
 *   显式 opt-in：只有 `ZCC_DRIVER=official-host` 或 `--driver official-host` 才会挂它，
 *   缺省（`none`）行为**一字不变**。它的推理档位另由 `ZCC_HOST_REASONING` 给出，
 *   取值闭集 `low | high | max`，闭集外**启动即拒**（fail-closed，不猜默认值）。
 *   该驱动会读官方本地凭据仓（**只读**、明文只存在于子宿主进程内存中），
 *   因此它不是 provider-free 路径：默认不启用，且启用前协调者须完成实弹验收。
 * - `fixture`：**故意不可从配置启用**，见文件头第 3 条。
 */
export const ENTRY_DRIVERS = Object.freeze(['none', 'fixture', 'local-official', 'official-host']);

/** 缺省端口。与 `server.ts` 的 `DEFAULT_API_PORT` 同源，启动时由源码校验一致。 */
export const ENTRY_DEFAULT_PORT = 8790;

/** 缺省收束上限（毫秒）。与 `ApiServerConfig.shutdownGraceMs` 缺省一致。 */
export const ENTRY_DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

/**
 * 本入口认识的环境变量。**闭集**：任何其它 `ZCC_*` 键都会让启动失败。
 *
 * | 键 | 含义 |
 * | --- | --- |
 * | `ZCC_API_KEY` | **必填**。Bearer key 的值。缺失即拒绝启动，不生成默认弱 key。 |
 * | `ZCC_API_PORT` | 监听端口，缺省 8790。`0` = 由系统分配临时端口（启动横幅会打印真实端口）。 |
 * | `ZCC_DRIVER` | 驱动器，缺省 `none`，取值见 {@link ENTRY_DRIVERS}。 |
 * | `ZCC_SHUTDOWN_GRACE_MS` | 在途请求收束上限，缺省 5000。 |
 * | `ZCC_HOST_REASONING` | official-host 推理档位，闭集 `low\|high\|max`，闭集外**启动即拒**。 |
 * | `ZCC_HOST_PERMISSION_MODE` | official-host 下发给官方 `session/create` 的 `mode`，闭集 `plan\|build\|edit\|yolo\|auto`，缺省 `yolo`（官方逐字 "Yolo mode bypasses permission prompts"）。闭集外**启动即拒**。 |
 * | `ZCC_HOST_TOOL_POLICY` | official-host 遇到 `interaction/requestPermission` 时的应答策略，闭集 `allow\|deny`，缺省 `allow`（工作区在隔离临时目录）。闭集外**启动即拒**。 |
 * | `ZCC_HOST_DEBUG` | official-host 诊断行开关，闭集 `0\|1`，缺省 `0`；闭集外**启动即拒**（HOSTFIX6）。 |
 */
export const ENTRY_ENV_KEYS = Object.freeze([
  'ZCC_API_KEY',
  'ZCC_API_PORT',
  'ZCC_DRIVER',
  'ZCC_SHUTDOWN_GRACE_MS',
  'ZCC_HOST_REASONING',
  'ZCC_HOST_PERMISSION_MODE',
  'ZCC_HOST_TOOL_POLICY',
  'ZCC_HOST_DEBUG'
]);

/**
 * `ZCC_HOST_PERMISSION_MODE` 的取值闭集。与 `scripts/official-host/session-drive.mjs`
 * 的 `OFFICIAL_SESSION_MODES`（官方 `$j` 逐字 `m.enum(["plan","build","edit","yolo","auto"])`）
 * 一致。**缺省 `yolo`**。
 */
export const ENTRY_HOST_PERMISSION_MODES = Object.freeze(['plan', 'build', 'edit', 'yolo', 'auto']);

/** 缺省下发的 `mode`。官方逐字 `"Yolo mode bypasses permission prompts"`。 */
export const ENTRY_DEFAULT_HOST_PERMISSION_MODE = 'yolo';

/**
 * `ZCC_HOST_TOOL_POLICY` 的取值闭集。**缺省 `allow`**——工作区在隔离临时目录
 * （`resolveHostWorkspaceRoot` + `isZCodeStorageRootPath` 闸门），且子宿主**没有**
 * 交互式用户通道，"不答"只会被官方的 `requestClient` 挂到 300 s 墙钟上限
 * （官方那条权限请求经 `dRn` 逐字**没有** `timeoutMs`）。
 */
export const ENTRY_HOST_TOOL_POLICIES = Object.freeze(['allow', 'deny']);

/** 缺省工具权限应答策略。放行。 */
export const ENTRY_DEFAULT_HOST_TOOL_POLICY = 'allow';

/**
 * `ZCC_HOST_DEBUG` 的取值闭集。**只有两个字面量**：`0`（关，缺省）与 `1`（开）。
 *
 * 与 `session-drive.mjs` 的 {@link HOST_DEBUG_ENV_KEY} 读取面**逐字同源**：
 * 那边**只认精确的 `'1'`**，其余一切（`'0'` / `'true'` / `'yes'` / 空串 / 未设置）都**关着**。
 * 入口这一道把同一个闭集写成**启动期**的 fail-closed 预检，所以一个拼错的开关
 * （`ZCC_HOST_DEBUG=2`、`=on`、`=true`）在**服务还没起来**时就指名报错，
 * 而不是让运维以为"诊断已经打开"、实际一行都看不到。
 *
 * **与 `ZCC_HOST_REASONING` 的处理有一处刻意的不同**（见 {@link parseEntryOptions}）：
 * 推理档位**只在 official-host 下**解析，调试开关**一律**解析。
 */
export const ENTRY_HOST_DEBUG_VALUES = Object.freeze(['0', '1']);

/** 缺省诊断开关取值。关。 */
export const ENTRY_DEFAULT_HOST_DEBUG = '0';

/**
 * `official-host` 推理档位闭集。与 `packages/official-host/src/host-driver.ts` 的
 * `REASONING_TO_THOUGHT_LEVEL` **键集合一致**——本文件只做**启动期**的 fail-closed 预检，
 * 真正的映射在驱动器里做一次。两处都查同一张表，是刻意的纵深：入口这一道让运维在
 * 启动横幅之前就拿到 `HOST_REASONING_UNKNOWN`，而不是等到第一次请求才失败。
 */
export const ENTRY_HOST_REASONING_LEVELS = Object.freeze(['low', 'high', 'max']);

/** 缺省推理档位。**不是**"随便挑一个"：这是本驱动自己承认的缺省，写死在这里让
 *  启动横幅能如实报出来，而不是让它看起来是用户选的。 */
export const ENTRY_DEFAULT_HOST_REASONING = 'high';

/** 退出码：配置 / 用法错误（fail-closed 拒绝，不启动）。 */
export const ENTRY_EXIT_USAGE = 2;
/** 退出码：运行期失败（端口占用、源文件不可读等）。 */
export const ENTRY_EXIT_RUNTIME = 1;

/** 启动参数解析失败。** 永远带 `code`，不靠字符串匹配判断原因。 */
export class EntryConfigError extends Error {
  /**
   * @param {string} code 稳定错误码（`NO_API_KEY` / `UNKNOWN_DRIVER` / …）
   * @param {string} message 给人看的完整原因
   */
  constructor(code, message) {
    super(message);
    this.name = 'EntryConfigError';
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* 模块解析钩子                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 让 Node 能直接吃下 `packages/**` 的 TypeScript 源码（见文件头说明）。
 * 只在入口被执行时调用；import 本模块不会触发。
 *
 * @returns {void}
 */
function installTypeScriptSpecifierHook() {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const parentUrl = context.parentURL ?? pathToFileURL(`${process.cwd()}/`).href;
        try {
          const target = new URL(specifier, parentUrl);
          if (target.pathname.endsWith('.js')) {
            const asTs = new URL(`${target.href.slice(0, -3)}.ts`);
            if (existsSync(fileURLToPath(asTs))) {
              return { url: asTs.href, format: 'module-typescript', shortCircuit: true };
            }
          }
        } catch {
          // 解析不了就交回默认解析器：钩子不做判断，只做改写。
        }
      }
      return nextResolve(specifier, context);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* 参数解析（纯函数，可单测）                                                     */
/* -------------------------------------------------------------------------- */

/**
 * @param {readonly string[]} argv `process.argv.slice(2)`
 * @param {string} flag
 * @returns {{ readonly flag: string; readonly value: string | null }}
 */
function readFlag(argv, flag) {
  const at = argv.indexOf(flag);
  if (at === -1) return { flag, value: null };
  const next = argv[at + 1];
  if (next === undefined || next.startsWith('--')) {
    throw new EntryConfigError('MISSING_FLAG_VALUE', `${flag} 后面必须跟一个值（收到 ${String(next)}）`);
  }
  return { flag, value: next };
}

/**
 * @param {unknown} raw
 * @param {string} flag
 * @returns {number}
 */
function parseIntegerOption(raw, flag) {
  if (typeof raw !== 'string' || raw.trim() === '' || !/^\d+$/.test(raw.trim())) {
    throw new EntryConfigError('INVALID_PORT', `${flag} 必须是非负整数，收到 ${JSON.stringify(raw)}`);
  }
  const value = Number.parseInt(raw.trim(), 10);
  if (value > 65_535) {
    throw new EntryConfigError('INVALID_PORT', `${flag} 必须在 0..65535 之间，收到 ${value}`);
  }
  return value;
}

/**
 * 把 CLI 参数 + 环境变量解析成一份**闭集**启动配置。
 *
 * 优先级：CLI `--flag` > 环境变量 > 缺省。
 *
 * @param {readonly string[]} argv
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {{ readonly port: number; readonly driver: string; readonly apiKey: string; readonly shutdownGraceMs: number, readonly hostReasoning?: string, readonly hostPermissionMode?: string, readonly hostToolPolicy?: string, readonly hostDebug: string }}
 * @throws {EntryConfigError}
 */
export function parseEntryOptions(argv, env) {
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('ZCC_') && !ENTRY_ENV_KEYS.includes(key)) {
      throw new EntryConfigError(
        'UNKNOWN_ENV_KEY',
        `本入口不认识环境变量 ${key}（不静默忽略未知配置；已知键：${ENTRY_ENV_KEYS.join(', ')}）`
      );
    }
    if (key.startsWith('ZCC_') && value !== undefined && /\r|\n/.test(value)) {
      throw new EntryConfigError('INVALID_ENV_VALUE', `环境变量 ${key} 含换行，拒绝使用`);
    }
  }

  const knownFlags = ['--port', '--driver', '--api-key', '--shutdown-grace-ms', '--help'];
  for (const token of argv) {
    if (token.startsWith('--') && !knownFlags.includes(token)) {
      throw new EntryConfigError('UNKNOWN_FLAG', `本入口不认识参数 ${token}（已知：${knownFlags.join(' ')}）`);
    }
  }

  const portRaw = readFlag(argv, '--port').value ?? env['ZCC_API_PORT'];
  const port = portRaw === undefined || portRaw === null ? ENTRY_DEFAULT_PORT : parseIntegerOption(portRaw, '--port / ZCC_API_PORT');

  const graceRaw = readFlag(argv, '--shutdown-grace-ms').value ?? env['ZCC_SHUTDOWN_GRACE_MS'];
  const shutdownGraceMs =
    graceRaw === undefined || graceRaw === null
      ? ENTRY_DEFAULT_SHUTDOWN_GRACE_MS
      : parseIntegerOption(graceRaw, '--shutdown-grace-ms / ZCC_SHUTDOWN_GRACE_MS');

  const driver = (readFlag(argv, '--driver').value ?? env['ZCC_DRIVER'] ?? 'none').trim();
  if (!ENTRY_DRIVERS.includes(driver)) {
    throw new EntryConfigError(
      'UNKNOWN_DRIVER',
      `未知驱动器 ${JSON.stringify(driver)}（闭集：${ENTRY_DRIVERS.join(' | ')}）`
    );
  }

  const rawHostReasoning = env['ZCC_HOST_REASONING'];
  const rawHostPermissionMode = env['ZCC_HOST_PERMISSION_MODE'];
  const rawHostToolPolicy = env['ZCC_HOST_TOOL_POLICY'];
  const rawHostDebug = env['ZCC_HOST_DEBUG'];

  const apiKey = (readFlag(argv, '--api-key').value ?? env['ZCC_API_KEY'] ?? '').trim();
  if (apiKey === '') {
    // 绝不生成默认弱 key：起不来比开一个无认证的模型入口安全得多。
    throw new EntryConfigError(
      'NO_API_KEY',
      '缺少 API key：本机 API 不允许在无认证状态下启动。请设置环境变量 ZCC_API_KEY 后重试（本入口不生成任何默认 key）'
    );
  }

  // 推理档位**只**在 official-host 下解析：其它驱动根本不读它，先校验会让一次
  // 无关的坏配置把一个本来能启动的服务挡住。
  const hostReasoning = driver === 'official-host' ? parseHostReasoning(rawHostReasoning) : null;
  // COMPAT1/C4：权限档位与工具应答策略**同样**只在 official-host 下解析（同一档理由），
  // 但**闭集外一律启动即拒**——它们各自决定"我们替官方 agent 做了什么决定"，
  // 静默回落等于让"配置写了什么"与"实际生效什么"分叉。
  const hostPermissionMode = driver === 'official-host' ? parseHostPermissionMode(rawHostPermissionMode) : null;
  const hostToolPolicy = driver === 'official-host' ? parseHostToolPolicy(rawHostToolPolicy) : null;

  // 调试开关**一律**解析（与上面那句相反，这里是刻意的）。
  // 理由：它是一个**诊断**开关，拼错的后果不是"用不上"，而是"以为开着、其实没开"——
  // 那正是本仓库最恨的一类静默错误（见文件头第 6 条：不静默忽略）。
  // 一个与所选驱动无关的拼错值，让启动失败并指名合法取值，比让它悄悄不生效更安全。
  const hostDebug = parseHostDebug(rawHostDebug);

  return {
    port,
    driver,
    apiKey,
    shutdownGraceMs,
    hostDebug,
    ...(hostReasoning === null ? {} : { hostReasoning }),
    ...(hostPermissionMode === null ? {} : { hostPermissionMode }),
    ...(hostToolPolicy === null ? {} : { hostToolPolicy })
  };
}

/**
 * `ZCC_HOST_PERMISSION_MODE` 解析。**fail-closed**：闭集外拒绝启动并指名已知取值。
 *
 * 闭集与官方 `session/create` params 的 `mode`（逐字 `$j=m.enum(["plan","build","edit","yolo","auto"])`，
 * 偏移 650957）**逐字一致**——构造一个闭集外的 `mode` 会被官方 `nGt.parse`（`.strict()` 的
 * 枚举）整帧拒掉，所以在这里失败比在那里失败更早也更准。
 *
 * @param {string | undefined} raw
 * @returns {string}
 * @throws {EntryConfigError}
 */
export function parseHostPermissionMode(raw) {
  const value = (raw ?? ENTRY_DEFAULT_HOST_PERMISSION_MODE).trim();
  if (!ENTRY_HOST_PERMISSION_MODES.includes(value)) {
    throw new EntryConfigError(
      'HOST_PERMISSION_MODE_UNKNOWN',
      `ZCC_HOST_PERMISSION_MODE=${JSON.stringify(value)} 不在闭集内（${ENTRY_HOST_PERMISSION_MODES.join(' | ')}）：拒绝启动而不是猜一档权限`
    );
  }
  return value;
}

/**
 * `ZCC_HOST_TOOL_POLICY` 解析。**fail-closed**：闭集外拒绝启动并指名已知取值。
 *
 * 缺省 `allow`。这条值逐字进子宿主的 `resolveToolPermissionResponse`（`policy`），
 * 并由 `buildChildEnv` 的"其余全量透传"下发给子进程，所以入口这一道与子宿主那一道
 * 判的是**同一个闭集**。
 *
 * @param {string | undefined} raw
 * @returns {string}
 * @throws {EntryConfigError}
 */
export function parseHostToolPolicy(raw) {
  const value = (raw ?? ENTRY_DEFAULT_HOST_TOOL_POLICY).trim();
  if (!ENTRY_HOST_TOOL_POLICIES.includes(value)) {
    throw new EntryConfigError(
      'HOST_TOOL_POLICY_UNKNOWN',
      `ZCC_HOST_TOOL_POLICY=${JSON.stringify(value)} 不在闭集内（${ENTRY_HOST_TOOL_POLICIES.join(' | ')}）：拒绝启动而不是猜一个权限策略`
    );
  }
  return value;
}

/**
 * `ZCC_HOST_REASONING` 解析。**fail-closed**：闭集外一律拒绝启动并指名已知取值。
 *
 * @param {string | undefined} raw
 * @returns {string}
 * @throws {EntryConfigError}
 */
export function parseHostReasoning(raw) {
  const value = (raw ?? ENTRY_DEFAULT_HOST_REASONING).trim();
  if (!ENTRY_HOST_REASONING_LEVELS.includes(value)) {
    throw new EntryConfigError(
      'HOST_REASONING_UNKNOWN',
      `ZCC_HOST_REASONING=${JSON.stringify(value)} 不在闭集内（${ENTRY_HOST_REASONING_LEVELS.join(' | ')}）：拒绝启动而不是猜一档`
    );
  }
  return value;
}

/**
 * `ZCC_HOST_DEBUG` 解析。**fail-closed**：闭集外一律拒绝启动并指名已知取值。
 *
 * 缺省 `0`（关）。取值**逐字**比较，不做 `Number()`、不做 `!!raw` 那种"真值化"——
 * `'false'` 与 `''` 在 JavaScript 里都是 truthy，而 `'0'` 也是；只有精确两个字面量
 * 才合法，才能让"写错 = 启动失败"这条纪律真的成立。
 *
 * @param {string | undefined} raw
 * @returns {string} `'0'` 或 `'1'`
 * @throws {EntryConfigError}
 */
export function parseHostDebug(raw) {
  const value = (raw ?? ENTRY_DEFAULT_HOST_DEBUG).trim();
  if (!ENTRY_HOST_DEBUG_VALUES.includes(value)) {
    throw new EntryConfigError(
      'HOST_DEBUG_UNKNOWN',
      `ZCC_HOST_DEBUG=${JSON.stringify(value)} 不在闭集内（${ENTRY_HOST_DEBUG_VALUES.join(' | ')}）：拒绝启动而不是猜一个开关状态`
    );
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* 启动横幅（纯函数，可单测）                                                     */
/* -------------------------------------------------------------------------- */

/**
 * @param {{
 *   readonly address: string,
 *   readonly port: number,
 *   readonly driver: string,
 *   readonly status: string,
 *   readonly catalogRevision: string,
 *   readonly catalogModels: number,
 *   readonly modelIsReal: boolean,
 *   readonly fixture: boolean,
 *   readonly keyFingerprint: string,
 *   readonly shutdownGraceMs: number
 * }} info
 * @returns {string}
 */
export function formatBanner(info) {
  return [
    `zcc-api listening address=http://${info.address}:${info.port} host=${info.address} port=${info.port}`,
    `zcc-api driver=${info.driver} status=${info.status} fixture=${String(info.fixture)} model_is_real=${String(info.modelIsReal)}`,
    `zcc-api catalog revision=${info.catalogRevision} models=${info.catalogModels} (GET /v1/zcc/catalog)`,
    'zcc-api models (GET /v1/models) 与 chat (POST /v1/chat/completions) 已挂载；无驱动器时 chat 返回 503 upstream_unavailable',
    'zcc-api cors=disabled allowed_origins=0（带 Origin 的请求一律拒绝；本轮不开 CORS）',
    `zcc-api auth=bearer required_key_fingerprint=${info.keyFingerprint}（key 值永不打印）`,
    `zcc-api shutdown: 向本进程发送 SIGINT 或 SIGTERM 优雅关闭（在途请求有界收束 ≤ ${info.shutdownGraceMs}ms，超时如实报 timedOut 并强拆 socket；不使用 process.exit 掩盖）`
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* 主流程                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * @param {readonly string[]} argv
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {{ readonly write: (line: string) => void, readonly error: (line: string) => void }} io
 * @returns {Promise<number>} 进程退出码
 */
export async function run(argv, env, io) {
  if (argv.includes('--help')) {
    io.write(
      [
        '用法: node packages/api/bin/start-api.mjs [--port <n>] [--driver none|fixture|local-official|official-host] [--shutdown-grace-ms <n>]',
        '',
        '环境变量（闭集；出现任何其它 ZCC_* 键即拒绝启动）:',
        '  ZCC_API_KEY             必填。Bearer key 的值。缺失即拒绝启动，不生成默认弱 key。',
        '  ZCC_API_PORT            监听端口，缺省 8790；0 = 由系统分配临时端口。',
        '  ZCC_DRIVER              none（缺省）| fixture（不可从配置启用）| local-official | official-host',
        '  ZCC_HOST_REASONING      official-host 的推理档位，闭集 low | high | max，缺省 high；闭集外拒绝启动',
        '  ZCC_HOST_PERMISSION_MODE official-host 下发给官方 session/create 的 mode，闭集 plan | build | edit | yolo | auto，'
          + '缺省 yolo（官方逐字 "Yolo mode bypasses permission prompts"：让官方 agent 的工具操作不再反向问我们）；闭集外拒绝启动',
        '  ZCC_HOST_TOOL_POLICY    official-host 遇到 interaction/requestPermission 时的应答策略，闭集 allow | deny，缺省 allow'
          + '（工作区在隔离临时目录，且子宿主没有交互式用户通道）；置 deny 时如实回拒绝。闭集外拒绝启动',
        '  ZCC_HOST_DEBUG          official-host 的诊断行开关，闭集 0 | 1，缺省 0；闭集外拒绝启动。'
          + '置 1 时子宿主把零凭据的会话摘要打到它自己的 stderr（父进程只对 stderr 计数，内容从不读取、从不转发）',
        '  ZCC_SHUTDOWN_GRACE_MS   在途请求收束上限，缺省 5000。',
        '',
        '优先级: CLI 参数 > 环境变量 > 缺省。绑定地址恒为 127.0.0.1，不暴露为配置。',
        '停止: 向进程发送 SIGINT 或 SIGTERM（优雅、有界收束，不用 process.exit）。'
      ].join('\n')
    );
    return 0;
  }

  let options;
  try {
    options = parseEntryOptions(argv, env);
  } catch (err) {
    if (err instanceof EntryConfigError) {
      io.error(`zcc-api 拒绝启动 [${err.code}] ${err.message}`);
      return ENTRY_EXIT_USAGE;
    }
    throw err;
  }

  if (options.driver === 'fixture') {
    io.error(
      'zcc-api 拒绝启动 [FIXTURE_DRIVER_TEST_ONLY] fixture 驱动器是假模型产出，生产配置无法启用它。' +
        '唯一合法路径是进程内 import { FIXTURE_TEST_TOKEN } 后构造 createApiServer(...)——symbol 跨不过进程边界，这是设计。'
    );
    return ENTRY_EXIT_USAGE;
  }

  installTypeScriptSpecifierHook();
  const { createApiServer, DEFAULT_API_PORT } = await import('../src/server.js');
  const { fingerprintApiKey } = await import('../src/auth.js');
  const { deriveModelIsReal } = await import('../src/chat.js');

  if (DEFAULT_API_PORT !== ENTRY_DEFAULT_PORT) {
    // 入口写死的缺省端口必须与 server.ts 同源，否则 --help 与真实行为会各说各话。
    throw new Error(`ENTRY_DEFAULT_PORT_DRIFT: 入口 ${ENTRY_DEFAULT_PORT} 与 server.ts ${DEFAULT_API_PORT} 不一致`);
  }

  /** @type {import('../src/chat.js').ChatDriver | undefined} */
  let driver;
  if (options.driver === 'local-official') {
    // 经 PLANSRC 既有闭集接入点构造：只读三个官方本地文件、零发送、零模型产出通道。
    const { loadLocalOfficialDriver } = await import('../../plansrc/src/index.js');
    const loaded = loadLocalOfficialDriver();
    driver = loaded.driver;
    io.write(
      `zcc-api plansrc source builtin=${loaded.paths.builtinFile} setting=${loaded.paths.settingFile} cache=${loaded.paths.cacheFile}` +
        ` (read-only, credential values never printed)`
    );
  } else if (options.driver === 'official-host') {
    // 官方 bundle 作宿主（子进程隔离）。目录复用 PLANSRC 那份真实 18 条，不重复造。
    // 凭据明文只在**子宿主进程**内存里：父进程连解都不解，因此不经过父子通道。
    const { loadOfficialHostDriver } = await import('../../official-host/src/host-driver.js');
    driver = await loadOfficialHostDriver({
      reasoning: options.hostReasoning ?? ENTRY_DEFAULT_HOST_REASONING,
      diagnostics: (line) => io.write(`zcc-api official-host ${line}`)
    });
    io.write(
      `zcc-api official-host reasoning=${options.hostReasoning ?? ENTRY_DEFAULT_HOST_REASONING} (闭集 low|high|max；不猜)` +
        ` host_debug=${options.hostDebug}` +
        ` permission_mode=${options.hostPermissionMode ?? ENTRY_DEFAULT_HOST_PERMISSION_MODE}` +
        ` tool_policy=${options.hostToolPolicy ?? ENTRY_DEFAULT_HOST_TOOL_POLICY}` +
        ' — 官方 bundle 由子宿主 **spawn 成独立 app-server 进程**（node <bundle> app-server --stdio --surface desktop），' +
        '崩溃只毁那次请求；凭据明文不出子进程；paid channel allowlist=account:'
    );
  }

  const server = createApiServer({
    enabled: true,
    port: options.port,
    apiKeys: [options.apiKey],
    shutdownGraceMs: options.shutdownGraceMs,
    // allowedOrigins 缺省 = 空数组 = 带 Origin 的请求全拒。CORS 永不开启。
    ...(driver === undefined ? {} : { driver }),
    logger: {
      info: (line) => io.write(`zcc-api ${line}`),
      warn: (line) => io.error(`zcc-api ${line}`),
      error: (line) => io.error(`zcc-api ${line}`)
    }
  });

  let result;
  try {
    result = await server.start();
  } catch (err) {
    io.error(`zcc-api 启动失败 [LISTEN_FAILED] ${err instanceof Error ? err.message : String(err)}`);
    await server.stop();
    return ENTRY_EXIT_RUNTIME;
  }
  if (result.started !== true) {
    io.error(`zcc-api 未监听 [${String(result.reason)}]`);
    await server.stop();
    return ENTRY_EXIT_RUNTIME;
  }

  const active = server.address();
  const boundPort = active?.port ?? result.port ?? options.port;
  // driver 缺省时 createApiServer 装的是 createUnavailableDriver({status:'not_attached'})：
  // name 'none'、目录空、非 fixture。横幅要报的就是这个真实状态，不是"看起来健康"。
  const activeDriver = /** @type {import('../src/chat.js').ChatDriver} */ (
    driver ?? { name: 'none', status: 'not_attached', statusDetail: '', models: [], fixture: false, catalog: { revision: 'none', models: [] }, stream: undefined }
  );
  io.write(
    formatBanner({
      address: active?.address ?? '127.0.0.1',
      port: boundPort,
      driver: activeDriver.name,
      status: activeDriver.status,
      catalogRevision: activeDriver.catalog.revision,
      catalogModels: activeDriver.catalog.models.length,
      modelIsReal: deriveModelIsReal(activeDriver),
      fixture: activeDriver.fixture,
      keyFingerprint: fingerprintApiKey(options.apiKey),
      shutdownGraceMs: options.shutdownGraceMs
    })
  );

  // 有界收束：server.stop() 内部先停新连接、再等在途请求到 grace 上限、超时如实报 timedOut。
  // 本文件不调用 process.exit：收束完成后没有残留句柄，进程自然退出并带上退出码。
  /**
   * @param {'SIGINT' | 'SIGTERM'} signal
   * @returns {Promise<void>}
   */
  const shutdown = async (signal) => {
    io.write(`zcc-api 收到 ${signal}，开始有界收束（≤ ${options.shutdownGraceMs}ms）…`);
    const outcome = await server.stop();
    io.write(`zcc-api 已关闭 closed=${String(outcome.closed)} timedOut=${String(outcome.timedOut)}`);
  };
  const onSigint = () => {
    void shutdown('SIGINT');
  };
  const onSigterm = () => {
    void shutdown('SIGTERM');
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  // 常驻：进程的生命周期由上面的监听与信号处理决定，不主动收尾，也不 process.exit。
  return new Promise(() => undefined);
}

/**
 * @param {readonly string[]} argv
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {Promise<number>}
 */
export async function main(argv, env) {
  return run(argv, env, {
    write: (line) => process.stdout.write(`${line}\n`),
    error: (line) => process.stderr.write(`${line}\n`)
  });
}

/* -------------------------------------------------------------------------- */
/* 入口守卫                                                                      */
/* -------------------------------------------------------------------------- */

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href;

if (invokedDirectly) {
  main(process.argv.slice(2), process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`zcc-api 未捕获启动错误: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exitCode = ENTRY_EXIT_RUNTIME;
    }
  );
}
