/**
 * UI04 —— 本机 API 通道（`GET /v1/zcc/catalog`）的**唯一**网络出口。
 *
 * 网络边界（本轮裁定）：UI 从 UI01/UI02 的"零网络"进入"**仅回环自连**"：
 *   - 只允许请求 companion 自己的 API，且必须是本机回环 origin（`127.0.0.1` /
 *     `localhost` / `[::1]`）或同源（空 base URL，由 UI 自己的服务器代理到回环端口）；
 *   - 任何其他来源（外网、局域网、`0.0.0.0`、带凭据的 URL、非 http(s) 协议）
 *     在**发起任何请求之前**就被 {@link resolveCatalogUrl} 拒绝；
 *   - 浏览器侧 CSP 同步收紧（见 `apps/ui/index.html` 的 meta CSP）：
 *     `default-src 'none'` + `connect-src 'self' http://127.0.0.1:8790`。
 *
 * 本文件是**整个产品代码里唯一含网络原语的模块**（`modelSource.test.ts` 第 8 组的
 * 静态扫描把"允许出现网络调用形态的文件"收敛成这一个白名单文件）。任何别的产品文件里
 * 再出现网络调用形态（fetch 调用、XMLHttpRequest 构造、WebSocket 构造、sendBeacon 等），
 * 测试立刻变红。
 *
 * 硬约束（不因接线而放松）：
 *  1. **只读目录，不发任何模型请求**：只发 `GET /v1/zcc/catalog`，不请求
 *     `/v1/chat/completions`，不带 `Authorization` / `Cookie` 头，不带任何凭据。
 *     本机 token 由 UI 自己的开发/预览服务器代理注入，不进浏览器、也不进本产物。
 *  2. **不跟随重定向**（`redirect: 'error'`）、**不缓存**（`cache: 'no-store'`），
 *     避免目录被中间层缓存或被 30x 带到别的来源。
 *  3. 失败一律映射到 UI02 已登记的失败原因，并**保留刷新前的旧列表**：
 *       - 回环守卫拒绝            → `transport_not_wired`
 *       - fetch 抛错（进程不在/端口不可达）→ `api_not_running`
 *       - 已连接但**响应头或响应正文**未在预算内完成（被中止）→ `timeout`
 *       - 非 2xx / 响应体读中断   → `connection_failed`
 *       - 2xx 但正文不是合法 JSON → `malformed_payload`
 *       - 2xx 且 JSON 合法但形状不合契约 → `malformed_payload`（由 modelSource 解析层整体拒绝）
 *       - 2xx 且 `models: []`      → `empty_source`
 *  4. 读回的条目**恒为** `availability: 'unverified'`、`sendEligible: false`
 *     （由 `parseCatalogPayload` 写死），fixture 模式与真实驱动器接入后都不会
 *     产生任何"看起来像官方真套餐"的条目。
 *
 * 本文件**不 import `packages/api/**`**：契约形状由 `modelSource.ts` 假定，
 * 联调时对着真实 API 跑即可。
 */

import {
  REFRESH_FAILURE_INFO,
  SOURCE_ENDPOINT,
  SourceUnavailableError,
  isFixtureScenario,
  offlineSourceLoader,
  resolveSourceLoader,
  type SourceLoader
} from './modelSource';
import { READ_STATUS_PATH } from './readStatus';

/* ------------------------------------------------------------------ *
 * base URL 与回环守卫
 * ------------------------------------------------------------------ */

/**
 * 默认 base URL = **同源**（空串）。
 *
 * 为什么默认不是 `http://127.0.0.1:8790`：
 * `apps/ui` 的 dev / preview 服务器把同源路径 `/v1/zcc/catalog` 反代到回环 API
 * （见 `apps/ui/vite.config.ts`），浏览器因此只发同源请求——既绕开"API 侧 CORS 永不
 * 开启"这条硬事实，也让 CSP 只需要 `connect-src 'self'`。直接把浏览器指向 8790 需要
 * API 侧放开 CORS/Origin 白名单，**属于需要协调者裁定的事项**，见报告 §16。
 */
export const DEFAULT_LOCAL_API_BASE_URL = '';

/** API01 裁定的本机端口（`DEFAULT_API_PORT = 8790`）对应的回环 origin。 */
export const LOOPBACK_API_BASE_URL = 'http://127.0.0.1:8790';

/**
 * 允许的回环主机名闭集。**不含** `0.0.0.0`（那是"绑定所有网卡"，不是回环）、
 * 不含通配、不含空串。IPv6 字面量在 `URL.hostname` 里带方括号，按该形态登记。
 */
export const LOOPBACK_HOSTNAMES: readonly string[] = ['127.0.0.1', 'localhost', '[::1]'];

/** 允许的协议闭集。`file:` / `javascript:` / `data:` 等一律不在内。 */
export const ALLOWED_BASE_PROTOCOLS: readonly string[] = ['http:', 'https:'];

/** 单次目录读取的超时上限（毫秒）。有界，不允许无界等待。 */
export const CATALOG_REQUEST_TIMEOUT_MS = 5000;

export type CatalogUrlVerdict =
  | { ok: true; base: string; origin: string; url: string }
  | { ok: false; base: string; reason: string };

function reject(base: string, reason: string): CatalogUrlVerdict {
  return { ok: false, base, reason };
}

/**
 * 把配置的 base URL 解析成唯一的目录请求 URL。
 *
 * 规则（任一不满足即拒，且**不发请求**）：
 *  1. 空串 / `/` → 同源，请求路径就是契约常量 `SOURCE_ENDPOINT`；
 *  2. 必须能被 `new URL()` 解析出 `http:` / `https:` 协议；
 *  3. 主机名必须落在 {@link LOOPBACK_HOSTNAMES} 闭集内；
 *  4. URL 里不得带用户名 / 密码；
 *  5. 路径必须为空或 `/`，且不得带 query / fragment —— 契约路径由常量拼，不接受调用方自带。
 */
export function resolveCatalogUrl(baseUrl: string): CatalogUrlVerdict {
  const raw = (baseUrl ?? '').trim();
  if (raw === '' || raw === '/') {
    return { ok: true, base: raw, origin: 'same-origin', url: SOURCE_ENDPOINT };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return reject(
      raw,
      `base URL 解析失败：不是带协议的绝对 URL（相对路径只允许空串或 /）。允许的回环 origin 形如 ${LOOPBACK_API_BASE_URL}。`
    );
  }
  if (!ALLOWED_BASE_PROTOCOLS.includes(url.protocol)) {
    return reject(raw, `协议 ${url.protocol} 不在允许闭集 ${ALLOWED_BASE_PROTOCOLS.join(' | ')} 内。`);
  }
  if (!LOOPBACK_HOSTNAMES.includes(url.hostname.toLowerCase())) {
    return reject(
      raw,
      `主机 ${url.hostname} 不是本机回环。UI04 只允许请求 companion 自己的回环 API` +
        `（${LOOPBACK_HOSTNAMES.join(' / ')}），任何其他来源（含 0.0.0.0 与局域网地址）一律拒绝。`
    );
  }
  if (url.username !== '' || url.password !== '') {
    return reject(raw, 'base URL 不得携带用户名或密码；本产品不在界面里传凭据。');
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    return reject(raw, `base URL 不得带路径 ${url.pathname}；契约路径 ${SOURCE_ENDPOINT} 由常量拼装。`);
  }
  if (url.search !== '' || url.hash !== '') {
    return reject(raw, 'base URL 不得带 query 或 fragment。');
  }
  return { ok: true, base: raw, origin: url.origin, url: `${url.origin}${SOURCE_ENDPOINT}` };
}

export function isAllowedLocalApiBaseUrl(baseUrl: string): boolean {
  return resolveCatalogUrl(baseUrl).ok;
}

/* ------------------------------------------------------------------ *
 * fetch 替身类型（测试可注入；生产走平台 fetch）
 * ------------------------------------------------------------------ */

export interface LocalApiRequestInit {
  method: 'GET';
  cache: 'no-store';
  redirect: 'error';
    credentials?: 'omit';
  /** 只接受 JSON。不带 Authorization / Cookie / X-Api-Key。 */
  headers: { accept: string };
  signal: AbortSignal;
}

export interface LocalApiResponseLike {
  ok: boolean;
  status: number;
  statusText?: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type LocalApiFetchLike = (
  url: string,
  init: LocalApiRequestInit
) => Promise<LocalApiResponseLike>;

export interface LocalApiFetchCall {
  url: string;
  init: LocalApiRequestInit;
}

export interface LocalApiSourceOptions {
  /** 见 {@link resolveCatalogUrl}。默认同源。 */
  baseUrl?: string;
  /** 超时上限（毫秒）。默认 {@link CATALOG_REQUEST_TIMEOUT_MS}。 */
  timeoutMs?: number;
  /** 测试注入点；缺省时在**调用时**读取平台 fetch（便于测试替换全局探针）。 */
  fetchImpl?: LocalApiFetchLike;
}

/** 需要在失败 detail 里如实回显的服务端诊断头。 */
const DIAGNOSTIC_HEADERS = ['x-zcc-status', 'x-zcc-driver', 'x-zcc-detail', 'x-zcc-fixture', 'www-authenticate'];

function diagnosticHeaderText(res: LocalApiResponseLike): string {
  const parts: string[] = [];
  for (const name of DIAGNOSTIC_HEADERS) {
    const v = res.headers.get(name);
    if (v !== null && v !== undefined && v !== '') parts.push(`${name}: ${v}`);
  }
  return parts.join('; ');
}

function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function abortError(): Error {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

/**
 * 在**同一个超时预算内**读取响应正文。
 *
 * 为什么必须自己与 abort 竞速（ZC-49 / F28）：平台 fetch 的 `res.text()` 只有在被
 * abort 时才拒绝，而"2xx 头已返回、正文不结束"的连接不会自己结束。若把计时器在
 * 头返回后就清掉，正文等待就进入**没有任何应用上限**的挂起，刷新永远停在 busy。
 * 这里不新增计时器——只复用驱动 abort 的那一个，因此预算仍是同一个 `timeoutMs`。
 */
function waitWithinBudget<T>(text: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    text.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

function readBodyWithinBudget(res: LocalApiResponseLike, signal: AbortSignal): Promise<string> {
  return waitWithinBudget(res.text(), signal);
}

/* ------------------------------------------------------------------ *
 * 本机 API 来源执行器
 * ------------------------------------------------------------------ */

export function createLocalApiSourceLoader(options: LocalApiSourceOptions = {}): SourceLoader {
  const baseUrl = options.baseUrl ?? DEFAULT_LOCAL_API_BASE_URL;
  const timeoutMs = options.timeoutMs ?? CATALOG_REQUEST_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl;

  return async (transport) => {
    if (transport !== 'local_api') return offlineSourceLoader(transport);
    // 守卫先行：不合规的 base URL 一个字节都不发出去。
    const verdict = resolveCatalogUrl(baseUrl);
    if (!verdict.ok) {
      throw new SourceUnavailableError(
        'transport_not_wired',
        `来源通道被回环守卫拒绝：${verdict.reason}（配置的 base URL：${JSON.stringify(verdict.base)}）`,
        REFRESH_FAILURE_INFO.transport_not_wired.remedy
      );
    }

    const doFetch: LocalApiFetchLike =
      fetchImpl ??
      ((url, init) =>
        globalThis.fetch(url, init as unknown as RequestInit) as unknown as Promise<LocalApiResponseLike>);

    const controller = new AbortController();
    let timedOut = false;
    // 同一预算覆盖「fetch + 响应头」与「完整正文」两段（ZC-49 / F28）：
    // 头返回不再撤销预算，只有外层 finally 才清理。
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      let res: LocalApiResponseLike;
      try {
        res = await doFetch(verdict.url, {
          method: 'GET',
          cache: 'no-store',
          redirect: 'error',
          headers: { accept: 'application/json' },
          signal: controller.signal
        });
      } catch (err) {
        if (timedOut) {
          throw new SourceUnavailableError(
            'timeout',
            `读取目录超时：${verdict.url} 在 ${timeoutMs}ms 内没有返回完整响应，请求已被中止（${errorText(err)}）。超时不做部分采纳。`,
            REFRESH_FAILURE_INFO.timeout.remedy
          );
        }
        throw new SourceUnavailableError(
          'api_not_running',
          `本机 API 未启动或端口不可达：${verdict.url}（${errorText(err)}）。` +
            `本产品只请求本机回环上的 companion API，不重试、不换来源、不填任何替代数据。`,
          REFRESH_FAILURE_INFO.api_not_running.remedy
        );
      }

      if (!res.ok) {
        const diag = diagnosticHeaderText(res);
        throw new SourceUnavailableError(
          'connection_failed',
          `目录端点返回非 2xx：${verdict.url} → HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}` +
            `${diag ? `｜${diag}` : ''}。已连接上来源但响应不合格，不部分采纳响应体。`,
          REFRESH_FAILURE_INFO.connection_failed.remedy
        );
      }

      let body: string;
      try {
        body = await readBodyWithinBudget(res, controller.signal);
      } catch (err) {
        if (timedOut) {
          throw new SourceUnavailableError(
            'timeout',
            `读取目录正文超时：${verdict.url} 在 ${timeoutMs}ms 内返回了 HTTP ${res.status} 响应头，但响应正文没有在同一个预算内读完，请求已被中止（${errorText(err)}）。超时不做部分采纳。`,
            REFRESH_FAILURE_INFO.timeout.remedy
          );
        }
        throw new SourceUnavailableError(
          'connection_failed',
          `目录响应体读取中断：${verdict.url} 返回 2xx 但正文读不出来（${errorText(err)}）。`,
          REFRESH_FAILURE_INFO.connection_failed.remedy
        );
      }

      try {
        return JSON.parse(body) as unknown;
      } catch (err) {
        throw new SourceUnavailableError(
          'malformed_payload',
          `目录响应体不是合法 JSON：${verdict.url} 返回 HTTP ${res.status}，正文前 200 字符=${JSON.stringify(body.slice(0, 200))}（${errorText(err)}）。`,
          REFRESH_FAILURE_INFO.malformed_payload.remedy
        );
      }
    } finally {
      clearTimeout(timer);
    }
  };
}

/* ------------------------------------------------------------------ *
 * readstatus 执行器（ZCC-GUI-EVIDENCE-20261008-A）
 * ------------------------------------------------------------------ */

/** readstatus 的请求预算。与目录通道同量级，覆盖「头 + 完整正文」。 */
export const READ_STATUS_REQUEST_TIMEOUT_MS = CATALOG_REQUEST_TIMEOUT_MS;

/**
 * 读取 `/v1/zcc/readstatus`。
 *
 * 与目录通道**同款守卫、同样零凭据**：
 *  - 不带 `Authorization` / `Cookie`，不带任何 body；
 *  - `redirect: 'error'` + `cache: 'no-store'`；
 *  - 同一超时预算覆盖 fetch 与完整正文，超时中止且**不做部分采纳**；
 *  - 任何失败都抛 {@link SourceUnavailableError}，**绝不返回半份 JSON**。
 *
 * 本函数**不做形状判定**：解析交给 `readStatus.ts` 的严格 parse，
 * 这样"网络失败"与"形状不合约"在 UI 上是两件可区分的事。
 */
export async function fetchReadStatus(
  baseUrl: string,
  fetchImpl: LocalApiFetchLike | undefined,
  timeoutMs: number = READ_STATUS_REQUEST_TIMEOUT_MS
): Promise<unknown> {
  const verdict = resolveCatalogUrl(baseUrl);
  if (!verdict.ok) {
    throw new SourceUnavailableError('transport_not_wired', verdict.reason, '检查「连接本机 API」的 base URL 是否为同源或本机回环。');
  }
  const url = verdict.origin === 'same-origin' ? READ_STATUS_PATH : `${verdict.origin}${READ_STATUS_PATH}`;
  const doFetch: LocalApiFetchLike =
    fetchImpl ??
    ((u, init) => globalThis.fetch(u, init as unknown as RequestInit) as unknown as Promise<LocalApiResponseLike>);

  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    let res: LocalApiResponseLike;
    try {
      res = await waitWithinBudget(doFetch(url, {
        method: 'GET',
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        headers: { accept: 'application/json' },
        signal: controller.signal
      }), controller.signal);
    } catch (err) {
      if (timedOut) {
        throw new SourceUnavailableError('timeout', `读取证据状态超时：${url} 在 ${timeoutMs}ms 内未返回响应头（${errorText(err)}）。超时不做部分采纳。`, REFRESH_FAILURE_INFO.timeout.remedy);
      }
      throw new SourceUnavailableError('api_not_running', `本机 API 不可达：${url}（${errorText(err)}）。`, REFRESH_FAILURE_INFO.api_not_running.remedy);
    }
    if (timedOut || controller.signal.aborted || Date.now() >= deadline) {
      throw new SourceUnavailableError('timeout', '证据状态响应头超过读取预算，已拒绝迟到响应。', REFRESH_FAILURE_INFO.timeout.remedy);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new SourceUnavailableError('connection_failed', `证据状态端点返回 HTTP ${res.status}：${url}。`, '确认本机 API 已启动且 key 可用。');
    }
    try {
      const body = await readBodyWithinBudget(res, controller.signal);
      if (timedOut || controller.signal.aborted || Date.now() >= deadline) {
        throw new SourceUnavailableError('timeout', '证据状态完整正文超过读取预算，已拒绝迟到响应。', REFRESH_FAILURE_INFO.timeout.remedy);
      }
      return body;
    } catch (err) {
      if (timedOut || controller.signal.aborted || Date.now() >= deadline || (err instanceof Error && err.name === 'AbortError')) {
        throw new SourceUnavailableError('timeout', '证据状态正文未在同一读取预算内完成，已中止且不做部分采纳。', REFRESH_FAILURE_INFO.timeout.remedy);
      }
      throw new SourceUnavailableError('connection_failed', '证据状态正文读取中断，不做部分采纳。', REFRESH_FAILURE_INFO.connection_failed.remedy);
    }
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * 执行器选择（界面真正使用的唯一决策点）
 * ------------------------------------------------------------------ */

export interface SourceLoaderChoice {
  /** `?sourceFixture=` 的场景名（测试态）。 */
  fixtureScenario?: string | null;
  /** 设置页「连接本机 API」开关。**默认 false = 零网络**。 */
  localApiEnabled: boolean;
  /** 本机 API base URL（同源或回环 origin）。 */
  baseUrl?: string;
}

/**
 * 选定来源执行器 —— UI04 的决策点（UI02 版的 `resolveSourceLoader` 仍是 fixture/离线的决策点）。
 *
 * 优先级：
 *  1. `fixtureScenario` 是已登记场景 → 本地 fixture 执行器（测试态，**零网络**）；
 *  2. `localApiEnabled === false`（默认）→ `offlineSourceLoader`（**零网络**，按 transport_not_wired 失败）；
 *  3. 其余 → 本机 API 回环 fetch 执行器。
 *
 * 第 2 条是"默认数据源仍是离线 fixture、连接本机 API 必须显式开启"的代码化：
 * 单元测试对第 2 条做**对象同一性**断言，填了 base URL 也不会绕过开关。
 */
export function resolveSourceLoaderForUi(choice: SourceLoaderChoice): SourceLoader {
  const scenario = choice.fixtureScenario;
  if (scenario && isFixtureScenario(scenario)) return resolveSourceLoader(scenario);
  if (!choice.localApiEnabled) return offlineSourceLoader;
  return createLocalApiSourceLoader({ baseUrl: choice.baseUrl ?? DEFAULT_LOCAL_API_BASE_URL });
}

/* ------------------------------------------------------------------ *
 * 界面用文案
 * ------------------------------------------------------------------ */

/** CSP 的 connect-src 值（与 `apps/ui/index.html` 的 meta CSP 保持一致，供界面展示与自检）。 */
export const CSP_CONNECT_SRC = `'self' ${LOOPBACK_API_BASE_URL}`;

export const LOCAL_API_NOTICE =
  `显式开启连接本机 API 后，手动刷新会向 companion 自己的回环 API 发起 ` +
  `GET ${SOURCE_ENDPOINT} 或 GET ${READ_STATUS_PATH}（只读取目录与历史证据状态，不发送任何模型请求）。` +
  `请求只允许去本机回环（${LOOPBACK_HOSTNAMES.join(' / ')}）或同源；` +
  `浏览器 CSP 为 default-src 'none' + connect-src ${CSP_CONNECT_SRC}，其他来源一律被拒。` +
  `关闭该开关即回到完全零网络的离线 fixture 路径。`;
