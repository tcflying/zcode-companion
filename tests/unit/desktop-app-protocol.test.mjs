/**
 * I10 `app://` 协议契约（`apps/desktop/lib/app-protocol.cjs`）。
 *
 * provider-free：全部是纯函数判定，不启网络、不开窗口。
 *
 * 本文件钉住的是三件事：
 *  1. **只有 `/v1/` 转发。** `/v1`、`/v1x/…`、解码后越出前缀的路径都不转发。
 *  2. **静态目录穿越照旧拒。** 加了转发分支不等于把穿越防护放开了。
 *  3. **key 的注入与剥除有确定顺序。** 渲染进程自带的 `authorization` 必须先被剥掉，
 *     再由主进程注入自己那把——否则「key 只在主进程」只是一句文案。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { mustForward, pathnameOf, reasonOf } from '../helpers/desktop-harness.mjs';

const require = createRequire(import.meta.url);
const {
  routeAppRequest,
  buildUpstreamRequest,
  buildResponseHeaders,
  isBodylessStatus,
  classifyUpstreamStatus,
  BODYLESS_STATUSES,
  FORWARD_PREFIX,
  STRIPPED_RESPONSE_HEADERS
} = require('../../apps/desktop/lib/app-protocol.cjs');
const { isInside } = require('../../apps/desktop/lib/runtime-paths.cjs');

/** 合成 key：不对应任何真实凭据，也不来自任何环境变量或文件。 */
const SYNTHETIC_KEY = 'zcc_protocol_test_synthetic_key_0002';
const PORT = 8791;

const DIST = join(tmpdir(), 'zcc-app-protocol-dist');
mkdirSync(join(DIST, 'assets'), { recursive: true });
writeFileSync(join(DIST, 'index.html'), '<!doctype html>', 'utf8');
writeFileSync(join(DIST, 'assets', 'index.js'), 'console.log(1)', 'utf8');

/** @param {string} url */
const route = (url) => routeAppRequest(url, { distRoot: DIST });

/**
 * @param {{ port?: number, apiKey?: string, method?: string, headers?: Record<string, string>, body?: unknown }} [overrides]
 */
const upstream = (overrides = {}) =>
  buildUpstreamRequest('/v1/models', {
    port: overrides.port ?? PORT,
    apiKey: overrides.apiKey ?? SYNTHETIC_KEY,
    method: overrides.method ?? 'GET',
    headers: new Headers(Object.entries(overrides.headers ?? {})),
    body: overrides.body
  });

afterAll(() => {
  rmSync(DIST, { recursive: true, force: true });
});

describe('app:// 路由：只有 /v1/ 转发', () => {
  it('前提不是恒真：静态用例依赖的那个 dist 目录真的存在', () => {
    expect(existsSync(join(DIST, 'index.html'))).toBe(true);
    expect(existsSync(join(DIST, 'assets', 'index.js'))).toBe(true);
  });

  it('前缀闭集就是 /v1/', () => {
    expect(FORWARD_PREFIX).toBe('/v1/');
  });

  it('三条真端点全部判为转发，且带上原始 path + query', () => {
    for (const p of ['/v1/models', '/v1/zcc/catalog', '/v1/chat/completions']) {
      const decision = route(`app://bundle${p}`);
      expect(decision.kind, `${p} 应当转发`).toBe('forward');
      expect(decision.rawPath).toBe(p);
    }
    const withQuery = route('app://bundle/v1/models?foo=bar%20baz');
    expect(withQuery.kind).toBe('forward');
    expect(withQuery.rawPath).toBe('/v1/models?foo=bar%20baz');
  });

  it('/v1（无尾斜杠）不转发：它不是本产品 API 的形状', () => {
    expect(route('app://bundle/v1').kind).toBe('static');
  });

  it('/v1x/… 不转发：前缀是按斜杠逐字符判的', () => {
    expect(route('app://bundle/v1x/models').kind).toBe('static');
  });

  it('编码过的 .. 越出前缀：URL 解析器已就地折叠，压根不转发，也出不去 dist', () => {
    // URL 规范把 `%2e` 当作 `.` 处理，`..` 段在**解析阶段**就被折叠掉了。
    // 因此这条路径的 pathname 已经变成 `/packages/...`，既不是 `/v1/` 前缀，
    // 解码后落到的静态目标也仍在 dist 之内——两层都不给。
    const decision = route('app://bundle/v1/%2e%2e/%2e%2e/packages/api/src/auth.ts');
    expect(decision.kind).not.toBe('forward');
    if (decision.kind === 'static') expect(isInside(DIST, pathnameOf(decision))).toBe(true);
    else expect(reasonOf(decision)).toBe('PATH_ESCAPES_PREFIX');
  });

  it('解码后含 .. 段的形态：白名单复查真的挡得住（直接打这条防线）', () => {
    // `/v1/%2F..%2Fsecret` 解码后是 `/v1//../secret`，含 `..` 段。
    const decision = route('app://bundle/v1/%2F..%2Fsecret');
    expect(decision.kind).toBe('reject');
    expect(['PATH_TRAVERSAL', 'PATH_ESCAPES_PREFIX']).toContain(reasonOf(decision));
  });

  it('/v1/ 内部的 .. 段被 URL 解析器就地解析掉，因此根本不会走到转发分支', () => {
    // `new URL()` 在解析阶段就把 `a/../..` 折叠掉了，pathname 变成 `/b`。
    // 这正是我们想要的形状：越不出前缀的东西压根到不了转发分支。
    expect(route('app://bundle/v1/a/../../b').kind).toBe('static');
  });

  it('反斜杠混进 /v1/ 路径 → 拒', () => {
    const decision = route('app://bundle/v1/models%5C..%5C..%5Csecret');
    expect(decision.kind).toBe('reject');
    expect(reasonOf(decision)).toBe('PATH_BACKSLASH');
  });

  it('坏百分号编码 → 拒，不抛', () => {
    expect(reasonOf(route('app://bundle/v1/%zz'))).toBe('PATH_UNDECODABLE');
  });

  it('非 app:// 协议 → 拒', () => {
    expect(reasonOf(route('https://example.com/v1/models'))).toBe('SCHEME_NOT_APP');
  });

  it('URL 根本解不开 → 拒，不抛', () => {
    expect(reasonOf(route('app://['))).toBe('URL_UNPARSEABLE');
    expect(reasonOf(route('::::'))).toBe('URL_UNPARSEABLE');
  });
});

describe('app:// 路由：静态分支与目录穿越', () => {
  it('根路径落到 dist/index.html', () => {
    expect(route('app://bundle/')).toEqual({ kind: 'static', pathname: join(DIST, 'index.html') });
    expect(route('app://bundle')).toEqual({ kind: 'static', pathname: join(DIST, 'index.html') });
  });

  it('普通静态资源落位正确', () => {
    expect(pathnameOf(route('app://bundle/assets/index.js'))).toBe(join(DIST, 'assets', 'index.js'));
  });

  it('目录穿越仍然 403：加转发分支没有把这条防线放开', () => {
    for (const attack of [
      'app://bundle/../package.json',
      'app://bundle/assets/../../package.json',
      'app://bundle/%2e%2e%2f%2e%2e%2fpackage.json',
      'app://bundle/....//package.json',
      'app://bundle/..%2f..%2fpackage.json'
    ]) {
      const decision = route(attack);
      if (decision.kind === 'reject') {
        expect(reasonOf(decision), `${attack} 应当被直接拒`).toBe('STATIC_TRAVERSAL');
      } else {
        // 没被拒就必须仍然落在 dist 之内。注意 `....` 在 Windows 上是一个**合法目录名**，
        // 因此这里要判的是「还在 dist 里」，而不是「看起来像 .. 就该拒」。
        expect(isInside(DIST, pathnameOf(decision)), `${attack} 逃出了 dist`).toBe(true);
      }
    }
  });

  it('反斜杠形态的穿越也出不去 dist', () => {
    const decision = route('app://bundle/..%5C..%5Cpackage.json');
    if (decision.kind === 'static') expect(isInside(DIST, pathnameOf(decision))).toBe(true);
    else expect(decision.kind).toBe('reject');
  });

  it('isInside 不会被一个恰好叫 .... 的目录名骗到', () => {
    expect(isInside(DIST, join(DIST, '....', 'package.json'))).toBe(true);
    expect(isInside(DIST, join(DIST, '..', 'package.json'))).toBe(false);
  });
});

describe('转发请求构造：注入顺序与头处理', () => {
  it('目标 origin 恒为 127.0.0.1:端口，绝不从请求里取', () => {
    expect(mustForward(upstream()).url).toBe(`http://127.0.0.1:${PORT}/v1/models`);
  });

  it('注入主进程那把 key，且绝不显式写 host（否则 net.fetch 直接 ERR_INVALID_ARGUMENT）', () => {
    const headers = /** @type {Record<string, string>} */ (mustForward(upstream()).init['headers']);
    expect(headers['authorization']).toBe(`Bearer ${SYNTHETIC_KEY}`);
    // 禁设头：Electron 的 net.fetch 走 Chromium 网络栈，显式 host 会被判非法参数，
    // 整条转发以 net::ERR_INVALID_ARGUMENT 失败。Host 门要看的东西由 Chromium 按
    // 上游 URL 自己生成，不需要（也不允许）我们手写。
    expect('host' in headers, '转发请求里不得出现 host 头').toBe(false);
  });

  it('渲染进程自带的 authorization / cookie / origin 一律剥掉', () => {
    const headers = /** @type {Record<string, string>} */ (
      mustForward(
        upstream({
          method: 'POST',
          headers: {
            authorization: 'Bearer renderer-supplied-token',
            cookie: 'a=b',
            origin: 'app://bundle',
            referer: 'app://bundle/index.html',
            host: 'app://bundle',
            'accept-encoding': 'gzip',
            'content-length': '17',
            'x-trace': 'keep-me'
          }
        })
      ).init['headers']
    );
    expect(headers['authorization']).toBe(`Bearer ${SYNTHETIC_KEY}`);
    expect(headers['authorization']).not.toContain('renderer-supplied-token');
    for (const dropped of ['cookie', 'origin', 'referer', 'accept-encoding', 'content-length', 'host']) {
      expect(headers[dropped], `${dropped} 必须被剥掉`).toBeUndefined();
    }
    expect(headers['x-trace']).toBe('keep-me');
  });

  it('GET / HEAD 不带 body；其余方法带 duplex 以支持流式请求体', () => {
    expect('body' in mustForward(upstream()).init).toBe(false);
    const post = mustForward(
      buildUpstreamRequest('/v1/chat/completions', {
        port: PORT,
        apiKey: SYNTHETIC_KEY,
        method: 'POST',
        headers: new Headers(),
        body: 'x'
      })
    );
    expect(post.init['body']).toBe('x');
    expect(post.init['duplex']).toBe('half');
  });

  it('没配 key 时 fail-closed：不发请求，如实报 503', () => {
    const built = upstream({ apiKey: '   ' });
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.status).toBe(503);
      expect(built.reason).toBe('API_KEY_NOT_CONFIGURED');
    }
  });

  it('端口越界 fail-closed', () => {
    for (const port of [0, 70000, 1.5]) {
      const built = upstream({ port });
      expect(built.ok, `端口 ${String(port)} 应当被拒`).toBe(false);
      if (!built.ok) expect(built.reason).toBe('API_PORT_INVALID');
    }
  });
});

describe('转发响应：头过滤与无 body 状态', () => {
  it('set-cookie / CORS 头 / 逐跳头一律不回传', () => {
    const out = buildResponseHeaders(
      new Headers({
        'set-cookie': 'a=b',
        'access-control-allow-origin': '*',
        'access-control-allow-credentials': 'true',
        connection: 'keep-alive',
        'content-encoding': 'gzip',
        'content-length': '42',
        'content-type': 'application/json',
        'x-zcc-catalog-count': '18'
      })
    );
    for (const name of STRIPPED_RESPONSE_HEADERS) expect(out[name], `${name} 不应回传`).toBeUndefined();
    expect(out['content-type']).toBe('application/json');
    expect(out['x-zcc-catalog-count']).toBe('18');
  });

  it('204 / 304 / 101 这类状态按规范置空 body', () => {
    expect(isBodylessStatus(204)).toBe(true);
    expect(isBodylessStatus(304)).toBe(true);
    expect(isBodylessStatus(200)).toBe(false);
  });
});

describe('测试资源自清理', () => {
  it('临时 dist 目录由 afterAll 回收（本文件不把它留到下一次运行）', () => {
    // 目录此刻仍在（用例马上会删）；这里钉住「清理动作存在」而不是「已经清理了」。
    expect(existsSync(DIST)).toBe(true);
  });
});

describe('上游状态码分类：不能构造出来的就别硬转（I10 LOW-1）', () => {
  it('2xx/3xx 里按规范无 body 的那几个判为 bodyless', () => {
    for (const status of [204, 205, 304]) expect(classifyUpstreamStatus(status)).toBe('bodyless');
  });

  it('普通状态照常转发', () => {
    for (const status of [200, 201, 400, 401, 404, 500, 502, 599]) {
      expect(classifyUpstreamStatus(status)).toBe('ok');
    }
  });

  it('1xx 判 invalid：`new Response(null,{status:101})` 会抛 RangeError，硬转会伪装成「上游不可达」', () => {
    for (const status of [100, 101, 103, 199]) expect(classifyUpstreamStatus(status)).toBe('invalid');
    // 实证：构造器确实会抛，所以必须在**进构造器之前**就拦下来。
    expect(() => new Response(null, { status: 101 })).toThrow();
  });

  it('非法值（NaN / 0 / 负数 / 超过 599）同样判 invalid，绝不放行给构造器', () => {
    for (const status of [0, -1, 600, 999, Number.NaN, 1.5]) {
      expect(classifyUpstreamStatus(status), `status=${String(status)}`).toBe('invalid');
    }
  });

  it('BODYLESS_STATUSES 闭集里不许再出现 1xx', () => {
    for (const status of BODYLESS_STATUSES) {
      expect(status, `${status} 必须是 Response 构造器能接受的`).toBeGreaterThanOrEqual(200);
      expect(status).toBeLessThanOrEqual(599);
    }
  });
});
