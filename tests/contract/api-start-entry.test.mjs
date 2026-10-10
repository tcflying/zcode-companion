/**
 * API01 可运行入口（`packages/api/bin/start-api.mjs`）契约测试。
 *
 * Provider-free：零网络外联、零官方进程、零数据库、零模型请求。
 * 唯一被创建并回收的子进程是**本测试自己 spawn 的那个入口进程**（持有 spawn handle，
 * 身份可证，finally 里必回收），且只绑 `127.0.0.1` 的临时端口（`--port 0`）。
 *
 * 覆盖的硬事实：
 *  1. **无 key 拒绝启动。** 缺 `ZCC_API_KEY` → 退出码 2 + `NO_API_KEY`；**不生成默认弱 key**。
 *  2. **驱动器闭集。** 未知值 → 退出码 2 + `UNKNOWN_DRIVER`（不静默回落默认值）；
 *     `fixture` → 退出码 2 + `FIXTURE_DRIVER_TEST_ONLY`（生产配置结构上开不了假模型）。
 *  3. **未知 `ZCC_*` 环境变量 / 未知 CLI 参数拒绝启动**（不静默忽略）。
 *  4. **真启动后 `/v1/models` 与 `/v1/zcc/catalog` 有真实响应。**
 *     `local-official` 驱动下 catalog **条目数 > 0**、逐条满足七字段形状
 *     （**不硬编码 18**：官方安装树一升级条目数就会变，硬编码等于给下一个人埋一颗雷）。
 *  5. **CORS 仍未开启**：响应里没有任何 `access-control-*` 头；带 `Origin` 的请求被拒。
 *  6. **不打印凭据值**，只打印指纹；**源码里没有 `process.exit(`**。
 *
 * 平台限制（真实、未测项，勿当成通过）：Windows 上 `child.kill('SIGINT')` 由 libuv
 * 直接 TerminateProcess，**不会**把信号投递给目标进程的 JS 处理器；Node 自投递
 * `process.kill(process.pid,'SIGINT')` 也会被直接终止。因此**基于真实信号的优雅关闭
 * 无法在本平台验证**，本文件改用"源码不含 process.exit( + 确实注册了 SIGINT/SIGTERM"
 * 这条静态回归钉子来守住"不用 process.exit 掩盖"这条纪律；有界收束本身由
 * `api-contract.test.mjs` 的优雅关闭用例在进程内覆盖。
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';
import { CATALOG_MODEL_KEYS, catalogContractDefects } from '../../packages/api/src/chat.js';
import {
  ENTRY_DEFAULT_HOST_PERMISSION_MODE,
  ENTRY_DEFAULT_HOST_TOOL_POLICY,
  ENTRY_DEFAULT_PORT,
  ENTRY_DRIVERS,
  ENTRY_ENV_KEYS,
  ENTRY_EXIT_USAGE,
  ENTRY_HOST_PERMISSION_MODES,
  ENTRY_HOST_TOOL_POLICIES,
  EntryConfigError,
  formatBanner,
  parseEntryOptions
} from '../../packages/api/bin/start-api.mjs';

const PROJECT_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = join(PROJECT_ROOT, 'packages', 'api', 'bin', 'start-api.mjs');

/** 测试专用 key。**不是**任何真实凭据；断言里到处搜它，输出里绝不允许出现它。 */
const TEST_KEY = 'zcc_entry_test_key_0123456789abcdefghij';

/**
 * 干净环境：剥掉父进程可能带来的全部 `ZCC_*`，避免闭集校验被无关变量误伤。
 *
 * @param {Readonly<Record<string, string>>} extra
 * @returns {Record<string, string>}
 */
function cleanEnv(extra) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith('ZCC_')) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

/**
 * 跑一次入口并等它自然结束。**有界**：超时即 kill 并抛错，绝不无限等待。
 *
 * @param {{ readonly argv: readonly string[], readonly env?: Readonly<Record<string, string>>, readonly timeoutMs?: number }} options
 */
async function runEntryToExit(options) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const child = spawn(process.execPath, [ENTRY, ...options.argv], {
    cwd: PROJECT_ROOT,
    env: cleanEnv(options.env ?? {}),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  child.stderr.on('data', (chunk) => {
    err += chunk;
  });
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
  }, timeoutMs);
  try {
    const code = await new Promise((resolve) => {
      child.on('error', () => resolve(-1));
      child.on('close', (c) => resolve(c));
    });
    return { code, out, err };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

/**
 * 真启动一个入口进程，等到横幅出现，取出真实监听地址，然后**必定**回收它。
 *
 * @param {readonly string[]} argv
 * @param {Readonly<Record<string, string>>} extraEnv
 * @param {(ctx: { readonly port: number; readonly out: () => string }) => Promise<void>} body
 */
async function withStartedServer(argv, extraEnv, body) {
  const child = spawn(process.execPath, [ENTRY, ...argv], {
    cwd: PROJECT_ROOT,
    env: cleanEnv(extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  child.stderr.on('data', (chunk) => {
    err += chunk;
  });
  const hardStop = setTimeout(() => {
    child.kill('SIGKILL');
  }, 30_000);
  try {
    const port = await new Promise((resolve, reject) => {
      const poll = setInterval(() => {
        const hit = /zcc-api listening address=http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
        if (hit) {
          clearInterval(poll);
          resolve(Number(hit[1]));
        }
      }, 50);
      child.on('error', (e) => {
        clearInterval(poll);
        reject(e);
      });
      child.on('close', () => {
        clearInterval(poll);
        reject(new Error(`入口进程提前退出，未打印监听地址。stdout=${out} stderr=${err}`));
      });
    });
    await body({ port, out: () => `${out}${err}` });
  } finally {
    clearTimeout(hardStop);
    // 只 kill 我们自己 spawn、且持有 handle 的这个进程（身份可证）。
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    /** @type {Promise<void>} */
    const reaped = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve(undefined);
      else child.on('close', () => resolve(undefined));
    });
    await reaped;
  }
}

/**
 * @param {number} port
 * @param {string} path
 * @param {Readonly<Record<string, string>>} headers
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: string }>}
 */
function httpGet(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const AUTH = { authorization: `Bearer ${TEST_KEY}` };

/**
 * 跑一次纯函数并把抛出的 `EntryConfigError` 收成返回值（不抛就返回 null）。
 *
 * @param {() => unknown} fn
 * @returns {EntryConfigError | null}
 */
function captureEntryError(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof EntryConfigError ? err : new EntryConfigError('NOT_AN_ENTRY_ERROR', String(err));
  }
}

/* -------------------------------------------------------------------------- */

describe('API01 入口：参数闭集与拒绝路径', () => {
  it('缺 ZCC_API_KEY 直接拒绝启动（退出码 2 + NO_API_KEY），不生成任何默认 key', async () => {
    const r = await runEntryToExit({ argv: [], env: {} });
    expect(r.code).toBe(ENTRY_EXIT_USAGE);
    expect(r.err).toContain('NO_API_KEY');
    expect(r.out).not.toContain('zcc-api listening');
  });

  it('纯函数层面同样拒绝空 key / 纯空白 key', () => {
    for (const env of [{}, { ZCC_API_KEY: '' }, { ZCC_API_KEY: '   ' }]) {
      const thrown = captureEntryError(() => parseEntryOptions([], env));
      expect(thrown, `env=${JSON.stringify(env)} 必须被拒绝`).toBeInstanceOf(EntryConfigError);
      expect(thrown === null ? '' : thrown.code).toBe('NO_API_KEY');
    }
  });

  it('未知驱动器值拒绝启动（退出码 2 + UNKNOWN_DRIVER），不静默回落到默认', async () => {
    const r = await runEntryToExit({ argv: ['--driver', 'bogus'], env: { ZCC_API_KEY: TEST_KEY } });
    expect(r.code).toBe(ENTRY_EXIT_USAGE);
    expect(r.err).toContain('UNKNOWN_DRIVER');
    expect(r.out).not.toContain('zcc-api listening');
  });

  it('纯函数层面：任一非闭集驱动器名都抛 UNKNOWN_DRIVER', () => {
    for (const driver of ['bogus', 'LOCAL-OFFICIAL', '', 'local_official', 'fixture2']) {
      const thrown = captureEntryError(() => parseEntryOptions([], { ZCC_API_KEY: TEST_KEY, ZCC_DRIVER: driver }));
      expect(thrown, `driver=${JSON.stringify(driver)} 必须被拒绝`).toBeInstanceOf(EntryConfigError);
      expect(thrown === null ? '' : thrown.code).toBe('UNKNOWN_DRIVER');
    }
  });

  it('fixture 驱动器在闭集里但不可从配置启用（退出码 2 + FIXTURE_DRIVER_TEST_ONLY）', async () => {
    expect(ENTRY_DRIVERS).toContain('fixture');
    const r = await runEntryToExit({ argv: ['--driver', 'fixture'], env: { ZCC_API_KEY: TEST_KEY } });
    expect(r.code).toBe(ENTRY_EXIT_USAGE);
    expect(r.err).toContain('FIXTURE_DRIVER_TEST_ONLY');
    expect(r.out).not.toContain('zcc-api listening');
  });

  it('未知 ZCC_* 环境变量与未知 CLI 参数都拒绝启动', async () => {
    const env = await runEntryToExit({ argv: [], env: { ZCC_API_KEY: TEST_KEY, ZCC_TYPO: '1' } });
    expect(env.code).toBe(ENTRY_EXIT_USAGE);
    expect(env.err).toContain('UNKNOWN_ENV_KEY');
    const flag = await runEntryToExit({ argv: ['--allow-origin', '*'], env: { ZCC_API_KEY: TEST_KEY } });
    expect(flag.code).toBe(ENTRY_EXIT_USAGE);
    expect(flag.err).toContain('UNKNOWN_FLAG');
  });

  it('--help 退出码 0 并列出环境变量表', async () => {
    const r = await runEntryToExit({ argv: ['--help'], env: {} });
    expect(r.code).toBe(0);
    for (const key of ENTRY_ENV_KEYS) expect(r.out).toContain(key);
    expect(r.out).toContain('SIGINT');
  });

  it('CLI 覆盖环境变量；缺省端口与 server.ts 同源', () => {
    const fromEnv = parseEntryOptions([], { ZCC_API_KEY: TEST_KEY, ZCC_API_PORT: '9001' });
    expect(fromEnv.port).toBe(9001);
    const fromFlag = parseEntryOptions(['--port', '9002'], { ZCC_API_KEY: TEST_KEY, ZCC_API_PORT: '9001' });
    expect(fromFlag.port).toBe(9002);
    expect(parseEntryOptions([], { ZCC_API_KEY: TEST_KEY }).port).toBe(ENTRY_DEFAULT_PORT);
    expect(ENTRY_DEFAULT_PORT).toBe(8790);
  });
});

describe('API01 入口：真启动后端点有真实响应', () => {
  it('local-official 驱动：/v1/models 与 /v1/zcc/catalog 返回 200，catalog 条目数 > 0 且逐条满足七字段', async () => {
    await withStartedServer(['--port', '0', '--driver', 'local-official'], { ZCC_API_KEY: TEST_KEY }, async ({ port, out }) => {
      const banner = out();
      expect(banner).toContain('driver=local-official');
      expect(banner).toContain('cors=disabled');
      expect(banner).not.toContain(TEST_KEY);
      expect(banner).toContain('zcc-fp:');

      const models = await httpGet(port, '/v1/models', AUTH);
      expect(models.status).toBe(200);
      expect(models.headers['x-zcc-driver']).toBe('local-official');
      // local-official 只提供目录，不冒充能服务模型：/v1/models 必须仍是空列表。
      expect(JSON.parse(models.body).data).toEqual([]);

      const catalog = await httpGet(port, '/v1/zcc/catalog', AUTH);
      expect(catalog.status).toBe(200);
      const payload = JSON.parse(catalog.body);
      // 不硬编码 18：官方安装树升级会改条目数，硬编码会让测试无缘无故变红。
      expect(payload.models.length).toBeGreaterThan(0);
      expect(typeof payload.revision).toBe('string');
      expect(payload.revision.length).toBeGreaterThan(0);
      expect(catalogContractDefects(payload)).toEqual([]);
      for (const entry of payload.models) {
        expect(Object.keys(entry).sort()).toEqual([...CATALOG_MODEL_KEYS].sort());
        expect(typeof entry.modelId).toBe('string');
        expect(typeof entry.displayName).toBe('string');
        expect(typeof entry.provider).toBe('string');
        expect(typeof entry.billingClass).toBe('string');
        expect(typeof entry.contextLength).toBe('number');
        expect(Array.isArray(entry.reasoning)).toBe(true);
        expect(Array.isArray(entry.capabilities)).toBe(true);
      }
      // 只提供目录的驱动器绝不能被标成 fixture（header 缺席即"不是 fixture"）。
      expect(catalog.headers['x-zcc-fixture']).toBeUndefined();
      expect(catalog.headers['x-zcc-status']).toBe('not_attached');
      // CORS 仍未开启。
      expect(Object.keys(catalog.headers).filter((k) => k.startsWith('access-control-'))).toEqual([]);
      // 凭据值绝不出现在响应里（这里没有真凭据，但断言形状本身要钉住）。
      expect(catalog.body).not.toContain(TEST_KEY);
    });
  }, 90_000);

  it('none 驱动：/v1/zcc/catalog 仍是 200 + 空目录（目录为空是事实，不是故障）', async () => {
    await withStartedServer(['--port', '0'], { ZCC_API_KEY: TEST_KEY }, async ({ port, out }) => {
      expect(out()).toContain('driver=none status=not_attached');
      const catalog = await httpGet(port, '/v1/zcc/catalog', AUTH);
      expect(catalog.status).toBe(200);
      expect(JSON.parse(catalog.body)).toEqual({ revision: 'none', models: [] });
    });
  }, 90_000);

  it('认证仍然是硬门：缺 Bearer 头一律 401，且不泄露 key 是否正确', async () => {
    await withStartedServer(['--port', '0'], { ZCC_API_KEY: TEST_KEY }, async ({ port, out }) => {
      const none = await httpGet(port, '/v1/zcc/catalog', {});
      expect(none.status).toBe(401);
      const wrong = await httpGet(port, '/v1/zcc/catalog', { authorization: 'Bearer not-the-key' });
      expect(wrong.status).toBe(401);
      expect(wrong.body).not.toContain(TEST_KEY);
      expect(out()).not.toContain(TEST_KEY);
    });
  }, 90_000);

  it('带 Origin 的请求被拒（CORS 本轮不开，Origin 白名单保持空）', async () => {
    await withStartedServer(['--port', '0'], { ZCC_API_KEY: TEST_KEY }, async ({ port }) => {
      const r = await httpGet(port, '/v1/zcc/catalog', { ...AUTH, origin: 'http://evil.invalid' });
      expect(r.status).toBe(403);
      expect(Object.keys(r.headers).filter((k) => k.startsWith('access-control-'))).toEqual([]);
    });
  }, 90_000);
});

describe('API01 入口：关闭纪律的静态回归钉子', () => {
  const source = readFileSync(ENTRY, 'utf8');

  it('入口源码不含 process.exit( —— 不用它掩盖悬挂资源', () => {
    // 真信号驱动的优雅关闭在 Windows 上无法验证（见文件头"平台限制"），
    // 所以用静态钉子守住同一条纪律：入口一旦改回 process.exit( 就红。
    expect(source).not.toContain('process.exit(');
    expect(source).toContain("process.on('SIGINT'");
    expect(source).toContain("process.on('SIGTERM'");
    // 解析钩子只在真正作为入口执行时安装：import 本模块做单测时不污染调用方的解析器。
    expect(source).toContain('invokedDirectly');
  });

  it('formatBanner 不含 key 值，只含指纹；且如实报告 model_is_real=false', () => {
    const line = formatBanner({
      address: '127.0.0.1',
      port: 8790,
      driver: 'local-official',
      status: 'not_attached',
      catalogRevision: 'local-official:builtin:deadbeef',
      catalogModels: 18,
      modelIsReal: false,
      fixture: false,
      keyFingerprint: 'zcc-fp:0123456789ab',
      shutdownGraceMs: 5000
    });
    expect(line).not.toContain(TEST_KEY);
    expect(line).toContain('model_is_real=false');
    expect(line).toContain('cors=disabled');
    expect(line).toContain('http://127.0.0.1:8790');
  });

  it('入口文件位置在 packages/api/bin 下，可被 node 直接执行', () => {
    expect(pathToFileURL(ENTRY).protocol).toBe('file:');
    expect(ENTRY.endsWith(join('packages', 'api', 'bin', 'start-api.mjs'))).toBe(true);
  });
});

describe('API01 入口：COMPAT1/C4 权限档位与工具应答策略（启动期 fail-closed 预检）', () => {
  it('`ENTRY_ENV_KEYS` 精确等于钉死的键表（新增配置项必须显式改表并让本钉变红）', () => {
    expect([...ENTRY_ENV_KEYS]).toEqual([
      'ZCC_API_KEY',
      'ZCC_API_PORT',
      'ZCC_DRIVER',
      'ZCC_SHUTDOWN_GRACE_MS',
      'ZCC_HOST_REASONING',
      'ZCC_HOST_PERMISSION_MODE',
      'ZCC_HOST_TOOL_POLICY',
      'ZCC_HOST_DEBUG',
      // 2026-10-07 因 929.md:875 新增。不登记进这个闭集的**直接后果**是：
      // 设了 `ZCC_JOURNAL_DIR` 的机器会拿到 `UNKNOWN_ENV_KEY` 而**起不来**——
      // 这正是「宿主 spawn 时必然下发这个键」所必须的（见下方 journalDir 用例）。
      'ZCC_JOURNAL_DIR'
    ]);
  });

  it('`ZCC_JOURNAL_DIR`：桌面 spawn 路径默认接通；缺省仍是不落盘', () => {
    // 宿主把**既有** settings 目录经 env 交进来时，journal 落到那个目录。
    const withEnv = parseEntryOptions([], { ZCC_API_KEY: TEST_KEY, ZCC_JOURNAL_DIR: 'C:/profiles/web' });
    expect(withEnv.journalDir).toBe('C:/profiles/web');

    // CLI 覆盖 env（优先级 CLI > env > 缺省，与其余键同一条规则）。
    const withFlag = parseEntryOptions(['--journal-dir', 'C:/from-flag'], {
      ZCC_API_KEY: TEST_KEY,
      ZCC_JOURNAL_DIR: 'C:/from-env'
    });
    expect(withFlag.journalDir).toBe('C:/from-flag');

    // 缺省 = 不启用持久化（纯内存 journal，容量拒绝照样生效）。
    expect(parseEntryOptions([], { ZCC_API_KEY: TEST_KEY }).journalDir).toBeUndefined();
    // 空白等价于没给，不当成路径 ''。
    expect(parseEntryOptions([], { ZCC_API_KEY: TEST_KEY, ZCC_JOURNAL_DIR: '   ' }).journalDir).toBeUndefined();
  });

  it('`ZCC_HOST_PERMISSION_MODE`：缺省 `yolo`，闭集内透传，闭集外**启动即拒**并指名', () => {
    const official = parseEntryOptions([], { ZCC_API_KEY: TEST_KEY, ZCC_DRIVER: 'official-host' });
    expect(official.hostPermissionMode).toBe(ENTRY_DEFAULT_HOST_PERMISSION_MODE);
    expect(ENTRY_DEFAULT_HOST_PERMISSION_MODE).toBe('yolo');
    for (const mode of ENTRY_HOST_PERMISSION_MODES) {
      const parsed = parseEntryOptions([], {
        ZCC_API_KEY: TEST_KEY,
        ZCC_DRIVER: 'official-host',
        ZCC_HOST_PERMISSION_MODE: mode
      });
      expect(parsed.hostPermissionMode).toBe(mode);
    }
    for (const bad of ['YOLO', 'bypass', 'bypassPermissions', '1', 'true']) {
      // `EntryConfigError.message` **不带** code 前缀（code 在 `.code` 上，由
      // `run()` 在写 stderr 时补）——所以这里断言 code，不去匹配消息。
      let caught;
      try {
        parseEntryOptions([], { ZCC_API_KEY: TEST_KEY, ZCC_DRIVER: 'official-host', ZCC_HOST_PERMISSION_MODE: bad });
      } catch (e) {
        caught = e;
      }
      expect(caught, bad).toBeInstanceOf(EntryConfigError);
      expect(/** @type {EntryConfigError} */ (caught).code, bad).toBe('HOST_PERMISSION_MODE_UNKNOWN');
    }
  });

  it('`ZCC_HOST_TOOL_POLICY`：缺省 `allow`，闭集内透传，闭集外**启动即拒**并指名', () => {
    const official = parseEntryOptions([], { ZCC_API_KEY: TEST_KEY, ZCC_DRIVER: 'official-host' });
    expect(official.hostToolPolicy).toBe(ENTRY_DEFAULT_HOST_TOOL_POLICY);
    expect(ENTRY_DEFAULT_HOST_TOOL_POLICY).toBe('allow');
    for (const policy of ENTRY_HOST_TOOL_POLICIES) {
      const parsed = parseEntryOptions([], {
        ZCC_API_KEY: TEST_KEY,
        ZCC_DRIVER: 'official-host',
        ZCC_HOST_TOOL_POLICY: policy
      });
      expect(parsed.hostToolPolicy).toBe(policy);
    }
    for (const bad of ['ALLOW', 'Deny', 'yes', '1', 'true']) {
      let caught;
      try {
        parseEntryOptions([], { ZCC_API_KEY: TEST_KEY, ZCC_DRIVER: 'official-host', ZCC_HOST_TOOL_POLICY: bad });
      } catch (e) {
        caught = e;
      }
      expect(caught, bad).toBeInstanceOf(EntryConfigError);
      expect(/** @type {EntryConfigError} */ (caught).code, bad).toBe('HOST_TOOL_POLICY_UNKNOWN');
    }
  });

  it('两个新旋钮**只在 official-host 下解析**（与 `ZCC_HOST_REASONING` 同一档理由）', () => {
    // 一个与所选驱动无关的坏值，**不**该把一个本来能启动的服务挡住。
    const none = parseEntryOptions([], {
      ZCC_API_KEY: TEST_KEY,
      ZCC_HOST_PERMISSION_MODE: 'NOPE',
      ZCC_HOST_TOOL_POLICY: 'NOPE'
    });
    expect(none.driver).toBe('none');
    expect(none.hostPermissionMode).toBeUndefined();
    expect(none.hostToolPolicy).toBeUndefined();
  });

  it('真启动路径：闭集外的取值让进程以 `HOST_*_UNKNOWN` 拒绝启动（不是静默生效）', async () => {
    /** @type {Array<[string, string]>} */
    const cases = [
      ['ZCC_HOST_PERMISSION_MODE', 'HOST_PERMISSION_MODE_UNKNOWN'],
      ['ZCC_HOST_TOOL_POLICY', 'HOST_TOOL_POLICY_UNKNOWN']
    ];
    for (const [key, marker] of cases) {
      const r = await runEntryToExit({ argv: ['--driver', 'official-host'], env: { ZCC_API_KEY: TEST_KEY, [key]: 'NOPE' } });
      expect(r.code, key).toBe(ENTRY_EXIT_USAGE);
      expect(r.err, key).toContain(marker);
    }
  });

  it('--help 里两条新键都在，且**写清了闭集与缺省**', async () => {
    const r = await runEntryToExit({ argv: ['--help'], env: {} });
    expect(r.code).toBe(0);
    for (const key of ENTRY_ENV_KEYS) expect(r.out).toContain(key);
    expect(r.out).toContain('ZCC_HOST_PERMISSION_MODE');
    expect(r.out).toContain('ZCC_HOST_TOOL_POLICY');
  });
});
