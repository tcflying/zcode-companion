/**
 * `app://` 协议的全部策略（静态产物 + `/v1/` 转发），抽成不依赖 Electron 的纯模块。
 *
 * 三条硬事实：
 *  1. **转发前缀闭集：只有 `/v1/`。** 其余路径一律走 `apps/ui/dist` 静态文件。
 *     `/v1`（无尾斜杠）、`/v1x/…`、解码后越出 `/v1/` 的路径都**不转发**。
 *  2. **key 只在主进程。** 转发时注入 `Authorization: Bearer <key>`、剥掉
 *     `Origin` / `Cookie` / `Referer` / 浏览器自带的 `Authorization` 与 `Host`。
 *     这一组动作复刻 `apps/ui/vite.config.ts` 里已确立的 dev 反代设计：浏览器只发
 *     同源请求，因此 API 侧「Origin 白名单默认全拒 + CORS 永不开启」不需要开口子。
 *  3. **静态目录穿越照旧拒。** 解析后的绝对路径必须仍在 dist 之内，否则 403。
 *     转发与静态是**并列**的两条分支，任何一条都不做「兜底回退」：转发失败就如实
 *     报上游状态/错误，绝不悄悄回落到静态文件把 404 伪装成成功。
 *
 * 之所以把策略抽出来：白名单、头改写、穿越防护都能在没有 Electron 的情况下被单测
 * 直接钉死，主进程只负责「拿到判定结果后去执行」。
 */

'use strict';

const path = require('node:path');

/** 唯一允许转发的路径前缀。 */
const FORWARD_PREFIX = '/v1/';
/** 唯一允许转发的上游主机。**永不从请求里取**，只由设置里的端口拼出来。 */
const UPSTREAM_HOST = '127.0.0.1';

/**
 * 转发时必须剥掉的请求头。
 *
 * - `origin` / `referer`：API 侧 Origin 白名单默认全拒，带 Origin 的请求会被拒；
 *   代理层剥掉它正是「同源反代」的设计前提。
 * - `cookie`：本机 API 不使用会话，透传只会把界面 cookie 无意义地送到上游。
 * - `authorization`：**必须先剥再注入**，否则渲染进程可以自带任意 token 顶掉主进程
 *   注入的那把——这会把「key 只在主进程」变成一句空话。
 * - `host`：属于禁设头（显式设置会让 `net.fetch` 抛 `net::ERR_INVALID_ARGUMENT`），
 *   而 Chromium 本来就按上游 URL 生成 `127.0.0.1:<port>`，渲染进程的 `app://bundle`
 *   不会渗进上游那跳。
 * - `accept-encoding` / `content-length`：交给 fetch 自己算，透传会与实际编解码冲突。
 * - 逐跳头与 `sec-fetch-*`：它们描述的是「浏览器 → app://」这一跳，转发后全部失真。
 */
const STRIPPED_REQUEST_HEADERS = Object.freeze([
  'origin',
  'referer',
  'cookie',
  'authorization',
  'proxy-authorization',
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'content-length',
  'accept-encoding',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform'
]);

/** 逐跳响应头与 `set-cookie` 不回传给渲染进程。`authorization` 在响应侧也一律不回传。 */
const STRIPPED_RESPONSE_HEADERS = Object.freeze([
  'set-cookie',
  'set-cookie2',
  'authorization',
  'proxy-authorization',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'content-encoding',
  'content-length',
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-expose-headers',
  'access-control-max-age'
]);

/**
 * 这些状态码按规范不能带 body，转发时必须把 body 置空而不是硬塞。
 *
 * **刻意不含 101 / 103。** `new Response(body, { status })` 只接受 200..599，喂
 * 101 会抛 `RangeError`；那个异常若被上游转发的 catch 吞掉，就会把「上游回了
 * 1xx」误报成「上游不可达」，诊断方向完全跑偏。1xx 属于「不能如实转发」那一类，
 * 由 `classifyUpstreamStatus` 单独判成 `invalid`。
 */
const BODYLESS_STATUSES = Object.freeze([204, 205, 304]);

/** Response 构造器的合法下界。低于它的状态码无法被如实重建。 */
const MIN_CONSTRUCTIBLE_STATUS = 200;

/**
 * @typedef {object} RouteDecision
 * @property {'forward'|'static'|'reject'} kind
 * @property {string} [reason] kind 为 `reject` 时的稳定原因码。
 * @property {string} [pathname] kind 为 `static` 时在 dist 内解析出的绝对路径。
 * @property {string} [rawPath] kind 为 `forward` 时透传给上游的原始 path+search。
 */

/**
 * 判定一条 `app://` 请求的去向。**纯函数**：没有 IO，可被单测逐条钉死。
 *
 * @param {string} requestUrl
 * @param {object} options
 * @param {string} options.distRoot `apps/ui/dist` 的绝对路径。
 * @returns {RouteDecision}
 */
function routeAppRequest(requestUrl, options) {
  const distRoot = options.distRoot;
  /** @type {URL} */
  let url;
  try {
    url = new URL(requestUrl);
  } catch {
    return { kind: 'reject', reason: 'URL_UNPARSEABLE' };
  }
  if (url.protocol !== 'app:') {
    return { kind: 'reject', reason: 'SCHEME_NOT_APP' };
  }

  const raw = url.pathname;
  if (raw.startsWith(FORWARD_PREFIX)) {
    // 解码后再判一次：%2e%2e%2f 这类编码过的 `..` 必须在转发前被挡住。
    let decoded;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return { kind: 'reject', reason: 'PATH_UNDECODABLE' };
    }
    if (!decoded.startsWith(FORWARD_PREFIX)) return { kind: 'reject', reason: 'PATH_ESCAPES_PREFIX' };
    const segments = decoded.split('/');
    if (segments.some((s) => s === '..' || s === '.')) return { kind: 'reject', reason: 'PATH_TRAVERSAL' };
    if (decoded.includes('\\')) return { kind: 'reject', reason: 'PATH_BACKSLASH' };
    return { kind: 'forward', rawPath: `${raw}${url.search}` };
  }

  let rel;
  try {
    rel = decodeURIComponent(raw === '' || raw === '/' ? 'index.html' : raw.replace(/^\/+/, ''));
  } catch {
    return { kind: 'reject', reason: 'PATH_UNDECODABLE' };
  }
  const target = path.resolve(distRoot, rel);
  if (target !== distRoot && !target.startsWith(distRoot + path.sep)) {
    return { kind: 'reject', reason: 'STATIC_TRAVERSAL' };
  }
  return { kind: 'static', pathname: target };
}

/**
 * 构造转发放大的请求。
 *
 * @param {string} rawPath `/v1/...` 加查询串（已通过白名单判定）。
 * @param {object} options
 * @param {number} options.port 本机 API 端口（已过闭集校验）。
 * @param {string} options.apiKey 主进程持有的 key；空串 = 未配置，直接 fail-closed。
 * @param {string} options.method
 * @param {Iterable<[string, string]>} options.headers 原始请求头。
 * @param {unknown} [options.body] 允许流式请求体（`request.body` 是 ReadableStream）。
 * @returns {{ ok: true, url: string, init: Record<string, unknown> } | { ok: false, status: number, reason: string }}
 */
function buildUpstreamRequest(rawPath, options) {
  if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '') {
    return { ok: false, status: 503, reason: 'API_KEY_NOT_CONFIGURED' };
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    return { ok: false, status: 500, reason: 'API_PORT_INVALID' };
  }
  const method = options.method.toUpperCase();
  const /** @type {Record<string, string>} */ headers = {};
  for (const [rawName, rawValue] of options.headers) {
    const name = rawName.toLowerCase();
    if (STRIPPED_REQUEST_HEADERS.includes(name)) continue;
    headers[name] = rawValue;
  }
  // 注入放在剥除之后：渲染进程自带的 authorization 已经在上面被丢掉了。
  headers['authorization'] = `Bearer ${options.apiKey}`;
  // **绝不**显式写 `host`：Electron 的 `net.fetch` 走 Chromium 网络栈，显式 `host`
  // 会被判为非法参数，整条请求以 `net::ERR_INVALID_ARGUMENT` 失败（实测，见
  // `review-artifacts/i10/e2e/header-bisect.cjs`）。而 Host 门要看的东西并不需要
  // 我们来写：Chromium 始终**按上游 URL** 生成 Host，也就是 `127.0.0.1:<port>`，
  // 渲染进程的 `app://bundle` origin 不会顺着转发渗进上游那跳。
  // 渲染进程自带的 `host` 已在上面的剥除闭集里被丢掉，这里补一条不许回填的纪律。

  /** @type {Record<string, unknown>} */
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD' && options.body !== undefined && options.body !== null) {
    init['body'] = options.body;
    // 流式请求体必须显式声明半双工，否则 undici 系实现会拒收。
    init['duplex'] = 'half';
  }
  return { ok: true, url: `http://${UPSTREAM_HOST}:${options.port}${rawPath}`, init };
}

/**
 * 过滤上游响应头。
 *
 * 两道过滤，缺一不可：
 *  1. **按名字**丢：逐跳头、`set-cookie`、CORS 头，以及响应侧的 `authorization`
 *     （请求侧我们注入了它，响应侧绝不能把它原样送回渲染进程）。
 *  2. **按值**丢：只要某个头��**值**里出现了已知机密串，整个头被丢掉。
 *     本仓 API 自己不回显凭据，但「上游今天不回显」不是「上游永远不回显」——
 *     一个把 token 塞进 `x-echo` 的上游就能让第 1 道形同虚设。
 *
 * 顺带把 `content-encoding` / `content-length` 丢掉：`net.fetch` 交回的 body 已经
 * 解码，带着原编码头会让渲染进程按错误的长度/编码去读流。
 *
 * @param {Iterable<[string, string]>} headers
 * @param {readonly string[]} [secrets] 已注册的机密（主进程那把 API key）。
 * @returns {Record<string, string>}
 */
function buildResponseHeaders(headers, secrets = []) {
  const needles = secrets.filter((s) => typeof s === 'string' && s.length >= 8);
  /** @type {Record<string, string>} */
  const out = {};
  for (const [rawName, rawValue] of headers) {
    const name = rawName.toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.includes(name)) continue;
    if (needles.some((secret) => String(rawValue).includes(secret))) continue;
    out[name] = rawValue;
  }
  return out;
}

/**
 * @param {number} status
 * @returns {boolean}
 */
function isBodylessStatus(status) {
  return BODYLESS_STATUSES.includes(status);
}

/**
 * 把上游状态码分成三类，供转发决定「怎么如实重建这个响应」。
 *
 *  - `bodyless`：2xx/3xx 里按规范不能带 body 的那几个，置空即可。
 *  - `ok`：可以带着 body 原样重建。
 *  - `invalid`：**低于 200**（1xx 与非法值）。`Response` 构造器只接受 200..599，
 *    硬转会抛 `RangeError` 并被外层 catch 误报成 `upstream_unreachable`——那是假的
 *    诊断。单独归类，调用方据此报一个说人话的错误码。
 *
 * @param {number} status
 * @returns {'ok' | 'bodyless' | 'invalid'}
 */
function classifyUpstreamStatus(status) {
  if (!Number.isInteger(status) || status < MIN_CONSTRUCTIBLE_STATUS || status > 599) return 'invalid';
  return BODYLESS_STATUSES.includes(status) ? 'bodyless' : 'ok';
}

exports.FORWARD_PREFIX = FORWARD_PREFIX;
exports.UPSTREAM_HOST = UPSTREAM_HOST;
exports.STRIPPED_REQUEST_HEADERS = STRIPPED_REQUEST_HEADERS;
exports.STRIPPED_RESPONSE_HEADERS = STRIPPED_RESPONSE_HEADERS;
exports.routeAppRequest = routeAppRequest;
exports.buildUpstreamRequest = buildUpstreamRequest;
exports.buildResponseHeaders = buildResponseHeaders;
exports.isBodylessStatus = isBodylessStatus;
exports.classifyUpstreamStatus = classifyUpstreamStatus;
exports.BODYLESS_STATUSES = BODYLESS_STATUSES;
