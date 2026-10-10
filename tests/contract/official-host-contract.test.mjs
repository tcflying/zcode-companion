/**
 * OFFICIAL-HOST 契约测试：接线闭集 + `ChatDriver` 接口不变式。
 *
 * Provider-free：零网络外联、零官方进程、零数据库、零模型请求、零真实凭据读取。
 * 唯一被创建并回收的子进程是**本测试自己 spawn 的入口进程**（`packages/api/bin/start-api.mjs`，
 * 持有 spawn handle、身份可证、`finally` 里必回收），且只绑 `127.0.0.1` 的临时端口。
 *
 * 覆盖的硬事实：
 *  1. **`ENTRY_DRIVERS` 是闭集且新增了 `official-host`**，默认仍是 `none`（默认行为不变）。
 *  2. **显式 opt-in**：不显式启用时 `model_is_real` 仍为 false，既有驱动行为一字未改。
 *  3. **推理档位 fail-closed 在启动期**：闭集外 → `HOST_REASONING_UNKNOWN` 拒绝启动。
 *  4. **未知 `ZCC_*` 键仍拒绝启动**（新增键在闭集内，不放宽纪律）。
 *  5. **`ChatDriver` 接口不变式**：`deriveModelIsReal` 口径 + `catalogContractDefects`。
 *  6. **目录复用 PLANSRC，不重复造**：official-host 与 local-official 同源。
 *  7. **零发送的静态面**：无可执行代码里的 fetch/http/net，无写仓调用，**无硬编码
 *     `entitled: true`**，不导出 `credentialStore` 形状。
 *
 * 平台限制（与 api-start-entry.test.mjs 同一条）：Windows 上信号到不了目标的 JS 处理器，
 * 所以本文件用 SIGKILL 收束常驻入口进程；优雅关闭由那份测试以静态钉子 + 进程内收束证明。
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ENTRY_DEFAULT_HOST_PERMISSION_MODE,
  ENTRY_DEFAULT_HOST_REASONING,
  ENTRY_DEFAULT_HOST_TOOL_POLICY,
  ENTRY_DRIVERS,
  ENTRY_ENV_KEYS,
  ENTRY_HOST_PERMISSION_MODES,
  ENTRY_HOST_REASONING_LEVELS,
  ENTRY_HOST_TOOL_POLICIES,
  EntryConfigError,
  parseEntryOptions,
  parseHostReasoning
} from '../../packages/api/bin/start-api.mjs';
import {
  ACCEPTED_NOT_FORWARDED_BUILTINS,
  catalogContractDefects,
  createFixtureDriver,
  createUnavailableDriver,
  deriveModelIsReal,
  MCODE_FIELD_SOURCES,
  maxTokensNotForwarded,
  NOT_FORWARDED_SPECS,
  REASONING_EFFORT_LEVELS,
  TOP_LEVEL_ACCEPTED,
  TOP_LEVEL_REJECTED,
  SUPPORTED_ROLES,
  FOLDED_PROMPT_ROLES,
  ACCEPTED_TOOL_CHOICES,
  REQUIRED_TOOL_CHOICES,
  TOOLS_FORWARDED_NONE,
  foldMessagesToPrompt
} from '../../packages/api/src/chat.js';
import {
  DEFAULT_HOST_PERMISSION_MODE,
  DEFAULT_HOST_TOOL_POLICY,
  DEFAULT_HOST_TURN_TIMEOUT_MS,
  HOST_TOOL_POLICIES,
  HOST_TURN_TIMEOUT_ENV_KEY,
  KNOWN_REASONING_LEVELS,
  OFFICIAL_SESSION_MODES,
  REASONING_TO_THOUGHT_LEVEL,
  evaluateChannelPolicy,
  mapReasoningToThoughtLevel,
  resolveHostChildScript,
  resolveHostTurnTimeoutMs,
  selectServableModels
} from '../../packages/official-host/src/host-driver.js';
import { loadLocalOfficialDriver } from '../../packages/plansrc/src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(HERE, '..', '..');
const ENTRY = join(ROOT, 'packages', 'api', 'bin', 'start-api.mjs');

/**
 * 剥掉块注释与行注释。
 *
 * **静态扫描必须先剥注释**：否则本包自己写在源码里的"绝不用 writeFileSync"、
 * "不导出 credentialStore"这类**纪律说明**会被当成违规。那不是放宽断言，而是让断言
 * 对准它真正要管的东西：**可执行代码**。
 *
 * @param {string} source
 * @returns {string}
 */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * 读一个文件并剥掉注释。
 * @param {string} rel 相对工程根的路径
 * @returns {string}
 */
function code(rel) {
  return stripComments(readFileSync(join(ROOT, rel), 'utf8'));
}

/**
 * 真跑一次**常驻**入口：等横幅出现就收工，然后只 kill 我们自己 spawn、且持有 handle 的
 * 这个进程（身份可证），并 await 它的 close —— 不留悬挂句柄。
 *
 * 入口的 `run()` 返回 `new Promise(() => undefined)`，**不会自己退出**，所以断言的是
 * 它的输出而不是它的退出码。
 *
 * @param {readonly string[]} argv
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {Promise<{ readonly stdout: string, readonly stderr: string, readonly exitedEarly: boolean }>}
 */
function runEntryResident(argv, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, ...argv], {
      cwd: ROOT,
      env: {
        PATH: process.env['PATH'] ?? '',
        SystemRoot: process.env['SystemRoot'] ?? '',
        ZCC_API_KEY: 'synthetic-test-key',
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });

    const killer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经退了。 */
      }
    }, 25000);
    killer.unref();

    const reap = () => {
      clearTimeout(killer);
      clearInterval(poll);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      /** @type {Promise<void>} */
      const reaped = new Promise((r) => {
        if (child.exitCode !== null || child.signalCode !== null) r(undefined);
        else child.on('close', () => r(undefined));
      });
      return reaped.then(() => resolve({ stdout, stderr, exitedEarly: false }));
    };

    let settled = false;
    const poll = setInterval(() => {
      if (settled) return;
      if (stdout.includes('zcc-api driver=') || stderr.includes('拒绝启动')) {
        settled = true;
        setTimeout(reap, 120);
      }
    }, 40);

    child.once('error', (e) => {
      settled = true;
      clearTimeout(killer);
      clearInterval(poll);
      reject(e);
    });
    child.once('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      clearInterval(poll);
      resolve({ stdout, stderr, exitedEarly: true });
    });
  });
}

describe('OFFICIAL-HOST 契约 · ENTRY_DRIVERS 闭集', () => {
  it('闭集恰好四个成员，且新增 official-host', () => {
    expect([...ENTRY_DRIVERS]).toEqual(['none', 'fixture', 'local-official', 'official-host']);
  });

  it('**默认仍是 none** —— 默认行为一字未改', () => {
    const options = parseEntryOptions([], { ZCC_API_KEY: 'synthetic-test-key' });
    expect(options.driver).toBe('none');
    expect(options.hostReasoning).toBeUndefined();
  });

  it('未知驱动器仍 fail-closed（不静默回落到默认值）', () => {
    let caught;
    try {
      parseEntryOptions(['--driver', 'nope'], { ZCC_API_KEY: 'synthetic-test-key' });
    } catch (e) {
      caught = /** @type {any} */ (e);
    }
    // 稳定错误码在 `.code` 上，**不**在 message 里 —— 契约按码判，不匹配中文文案。
    expect(caught).toBeInstanceOf(EntryConfigError);
    expect(caught.code).toBe('UNKNOWN_DRIVER');
  });

  it('fixture 仍在闭集里（入口仍认识这个名字，只是不接受它启用）', () => {
    expect(ENTRY_DRIVERS).toContain('fixture');
  });

  it('新增的 ZCC_HOST_REASONING 在环境变量闭集内（不放宽"未知 ZCC_* 拒绝启动"）', () => {
    expect(ENTRY_ENV_KEYS).toContain('ZCC_HOST_REASONING');
    let caught;
    try {
      parseEntryOptions([], { ZCC_API_KEY: 'k', ZCC_HOST_REASONING_NOPE: 'x' });
    } catch (e) {
      caught = /** @type {any} */ (e);
    }
    expect(caught.code).toBe('UNKNOWN_ENV_KEY');
  });
});

describe('OFFICIAL-HOST 契约 · 推理档位 fail-closed（启动期）', () => {
  it('入口闭集与驱动器映射表键集合**逐字一致**（两处查同一张表）', () => {
    expect([...ENTRY_HOST_REASONING_LEVELS].sort()).toEqual([...Object.keys(REASONING_TO_THOUGHT_LEVEL)].sort());
  });

  it('闭集恰好 low / high / max', () => {
    expect([...ENTRY_HOST_REASONING_LEVELS].sort()).toEqual(['high', 'low', 'max']);
  });

  it('缺省是 high（写死的、启动横幅会如实报出来）', () => {
    expect(ENTRY_DEFAULT_HOST_REASONING).toBe('high');
    expect(parseHostReasoning(undefined)).toBe('high');
  });

  it('闭集外一律拒绝启动（报错而不是猜一档）', () => {
    for (const bad of ['medium', 'HIGH', '', '   ']) {
      let caught;
      try {
        parseHostReasoning(bad);
      } catch (e) {
        caught = /** @type {any} */ (e);
      }
      expect(caught.code).toBe('HOST_REASONING_UNKNOWN');
    }
  });

  it('只有 official-host 会读这个变量（别的驱动不被无关坏配置挡住）', () => {
    expect(parseEntryOptions(['--driver', 'none'], { ZCC_API_KEY: 'k', ZCC_HOST_REASONING: 'medium' }).driver).toBe('none');
    let caught;
    try {
      parseEntryOptions(['--driver', 'official-host'], { ZCC_API_KEY: 'k', ZCC_HOST_REASONING: 'medium' });
    } catch (e) {
      caught = /** @type {any} */ (e);
    }
    expect(caught.code).toBe('HOST_REASONING_UNKNOWN');
  });

  it('official-host + 闭集内 → 解析成功并带上档位', () => {
    const options = parseEntryOptions(['--driver', 'official-host'], { ZCC_API_KEY: 'k', ZCC_HOST_REASONING: 'max' });
    expect(options.driver).toBe('official-host');
    expect(options.hostReasoning).toBe('max');
  });
});

describe('OFFICIAL-HOST 契约 · 入口真启动（零发送）', () => {
  it('official-host + 闭集外档位 → 拒绝启动并指名，不监听任何端口', async () => {
    const result = await runEntryResident(['--port', '0', '--driver', 'official-host'], { ZCC_HOST_REASONING: 'medium' });
    expect(result.stderr).toContain('HOST_REASONING_UNKNOWN');
    expect(result.stdout).not.toContain('zcc-api listening');
  });

  it('缺省启动（driver=none）横幅仍然是 not_attached / model_is_real=false', async () => {
    const result = await runEntryResident(['--port', '0'], {});
    expect(result.exitedEarly).toBe(false);
    expect(result.stdout).toContain('driver=none');
    expect(result.stdout).toContain('status=not_attached');
    expect(result.stdout).toContain('model_is_real=false');
  });

  it('official-host 显式 opt-in 能真启动：横幅如实报告，且**不发任何模型请求**', async () => {
    const result = await runEntryResident(['--port', '0', '--driver', 'official-host'], { ZCC_HOST_REASONING: 'high' });
    expect(result.exitedEarly).toBe(false);
    expect(result.stdout).toContain('driver=official-host');
    expect(result.stdout).toContain('fixture=false');
    // 子进程隔离与白名单在横幅里被如实说明（不是藏在注释里）。
    expect(result.stdout).toContain('allowlist=account:');
    expect(result.stdout).toContain('明文不出子进程');
    expect(result.stdout).toMatch(/official-host reasoning=high/);
    // 凭据值永不打印
    expect(result.stdout).not.toMatch(/enc:v1:/);
    expect(result.stderr).not.toMatch(/enc:v1:/);
  });

  it('入口源码里没有 process.exit(（不以掐进程掩盖收束）', () => {
    expect(readFileSync(ENTRY, 'utf8')).not.toContain('process.exit(');
  });

  it('入口源码（剥注释后）里不含任何凭据值形态的字面量', () => {
    const source = code('packages/api/bin/start-api.mjs');
    expect(source).not.toMatch(/enc:v1:/);
    expect(source).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
  });

  it('子宿主脚本路径可解析，且只认 --bundle', () => {
    const script = resolveHostChildScript();
    expect(script.endsWith(join('scripts', 'official-host', 'host-child.mjs'))).toBe(true);
    const source = readFileSync(script, 'utf8');
    expect(source).toContain('--bundle');
    // 只认一个参数：命令行面越小，"从 argv 读出别的东西"的可能就越小。
    expect(source).toContain('ARG_UNKNOWN');
  });
});

describe('OFFICIAL-HOST 契约 · ChatDriver 接口不变式', () => {
  it('deriveModelIsReal 口径：ready + 非 fixture + 有模型', () => {
    /**
     * @param {import('../../packages/api/src/chat.js').DriverStatus} status
     * @param {boolean} fixture
     * @param {string[]} models
     */
    const make = (status, fixture, models) => deriveModelIsReal({ status, fixture, models });
    expect(make('ready', false, ['m'])).toBe(true);
    // 保守方向：任何一条不满足即为 false
    expect(make('not_attached', false, ['m'])).toBe(false);
    expect(make('no_quota', false, ['m'])).toBe(false);
    expect(make('ready', true, ['m'])).toBe(false);
    expect(make('ready', false, [])).toBe(false);
  });

  it('目录复用 PLANSRC：同一条 readPlanSources + mapBuiltinToCatalog 路径，不是另造一份', () => {
    const catalog = loadLocalOfficialDriver().catalog;
    expect(catalog.revision.startsWith('local-official:builtin:')).toBe(true);
    expect(catalog.models.length).toBeGreaterThan(0);
    expect(catalogContractDefects(catalog)).toEqual([]);
    // 官方安装树一升级条目数就会变，**不硬编码 18**：只断言"结构合法 + 有条目"。
    for (const entry of catalog.models) {
      expect(Object.keys(entry).sort()).toEqual([
        'billingClass',
        'capabilities',
        'contextLength',
        'displayName',
        'modelId',
        'provider',
        'reasoning'
      ]);
    }
  });

  it('可服务模型是目录的**子集**，且每条都过 account: 白名单并逐字来自目录', () => {
    const catalog = loadLocalOfficialDriver().catalog;
    const servable = selectServableModels(catalog);
    // 目录里有 8 条 providerRule（4 个已核有缓存键 + team×2 + offpeak×2）。
    // 可服务集只收"有缓存键且白名单放行"的那几条，因此必然是**真子集**。
    expect(servable.length).toBeGreaterThan(0);
    expect(servable.length).toBeLessThanOrEqual(catalog.models.length);
    const offeringIds = new Set(catalog.models.map((m) => m.modelId));
    const providers = new Set();
    for (const entry of servable) {
      // ServableModel 的字段名是 providerId（目录条目才叫 provider）。混用会拿到
      // undefined，然后被白名单判成"不可证明走订阅通道"——那是一个静默的空断言。
      expect(typeof entry.providerId).toBe('string');
      expect(evaluateChannelPolicy(entry.providerId).ok).toBe(true);
      expect(offeringIds.has(entry.offeringId)).toBe(true);
      // offeringId 必须是 `providerId::modelId` 两段，裸 modelId 能被拆回来
      expect(entry.offeringId.startsWith(`${entry.providerId}::`)).toBe(true);
      expect(entry.modelId).not.toContain('::');
      providers.add(entry.providerId);
    }
    // team 与 offpeak 官方没给缓存键，不进可服务集
    for (const p of providers) {
      expect(p.endsWith('-start-plan') || p.endsWith('-individual-coding-plan')).toBe(true);
      expect(p).not.toContain('team');
      expect(p).not.toContain('offpeak');
    }
  });

  it('目录条目逐条满足已公布的 catalog 契约（不部分采纳后当合法响应发出）', () => {
    const catalog = loadLocalOfficialDriver().catalog;
    expect(catalogContractDefects({ revision: catalog.revision, models: catalog.models })).toEqual([]);
  });
});

describe('OFFICIAL-HOST 契约 · 零发送的静态面（剥注释后只看可执行代码）', () => {
  const SOURCES = [
    'packages/official-host/src/credentials.ts',
    'packages/official-host/src/headers-port.ts',
    'packages/official-host/src/entitlement.ts',
    'packages/official-host/src/host-driver.ts',
    'packages/official-host/src/index.ts'
  ];

  it.each(SOURCES)('%s 里没有 fetch / http / net 直连', (rel) => {
    const source = code(rel);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/from 'node:http'/);
    expect(source).not.toMatch(/from 'node:net'/);
  });

  it('凭据仓只读：没有写入 / 删除 / 改名调用', () => {
    const source = code('packages/official-host/src/credentials.ts');
    expect(source).not.toMatch(/\bwriteFileSync\s*\(/);
    expect(source).not.toMatch(/\bunlinkSync\s*\(/);
    expect(source).not.toMatch(/\brenameSync\s*\(/);
    expect(source).toMatch(/\breadFileSync\s*\(/);
  });

  it('**没有任何硬编码的 entitled: true**（红线：不伪造 entitled）', () => {
    for (const rel of [
      ...SOURCES,
      'scripts/official-host/host-child.mjs',
      'scripts/official-host/session-drive.mjs'
    ]) {
      const source = code(rel);
      expect(source, rel).not.toMatch(/entitled\s*:\s*true/);
      expect(source, rel).not.toMatch(/entitled\s*=\s*true/);
      expect(source, rel).not.toMatch(/entitled\s*=\s*!0/);
    }
  });

  it('不导出 credentialStore 形状（不传 standalone 的结构化保证）', () => {
    // 传了它官方就会取 standalone.credentialStore，进而硬过滤 individual-coding-plan，
    // start-plan 永远 not entitled。所以本包**根本没有**产出它的函数。
    for (const rel of [
      'packages/official-host/src/index.ts',
      'packages/official-host/src/headers-port.ts',
      'packages/official-host/src/credentials.ts',
      'packages/official-host/src/host-driver.ts',
      'packages/official-host/src/entitlement.ts'
    ]) {
      expect(code(rel), rel).not.toContain('credentialStore');
    }
  });

  it('白名单常量硬编码在本包内（不靠调用方传进来）', () => {
    const source = code('packages/official-host/src/headers-port.ts');
    expect(source).toMatch(/ALLOWED_CHANNEL_PREFIX\s*=\s*'account:'/);
    expect(source).toContain('bigmodel-api');
    expect(source).toContain('zai-standard-api');
  });

  it('入口 URL 可被 import（本文件已经证明），且模块路径拼写正确', () => {
    expect(pathToFileURL(ENTRY).href).toContain('start-api.mjs');
  });
});

/* -------------------------------------------------------------------------- */
/* COMPAT1：三处闭集的**跨层一致性**（漂移会立刻变红）                          */
/* -------------------------------------------------------------------------- */

/**
 * ## 为什么要一份"跨层一致性"契约
 *
 * COMPAT1 之后，同一个闭集在**三个层**各出现一次：
 *  1. `packages/api/src/chat.ts` 的 `REASONING_EFFORT_LEVELS`（API 层请求体校验）；
 *  2. `packages/official-host/src/host-driver.ts` 的 `REASONING_TO_THOUGHT_LEVEL`
 *     （驱动器 → 官方 `thoughtLevel` 的映射）；
 *  3. `packages/api/bin/start-api.mjs` 的 `ENTRY_HOST_REASONING_LEVELS`（启动期预检）。
 *
 * 三层各写一份字面量，漂移的**表现**是"请求在某一层被接受、在另一层被拒"——
 * 实弹里那是一个只在上层请求才复现的 422/502，排查成本极高。所以这里逐条钉死。
 *
 * 权限那两个闭集同理：`OFFICIAL_SESSION_MODES`（官方 `$j` 逐字）与
 * `HOST_TOOL_POLICIES` 在 `host-driver.ts` 与 `start-api.mjs` 各有一份。
 */
describe('OFFICIAL-HOST 契约 · COMPAT1 跨层闭集一致性', () => {
  it('推理档位闭集三层**逐字相等**（API 校验 / 驱动器映射 / 入口预检）', () => {
    expect([...REASONING_EFFORT_LEVELS]).toEqual([...KNOWN_REASONING_LEVELS]);
    expect([...REASONING_EFFORT_LEVELS]).toEqual([...ENTRY_HOST_REASONING_LEVELS]);
    expect([...REASONING_EFFORT_LEVELS].sort()).toEqual([...Object.keys(REASONING_TO_THOUGHT_LEVEL)].sort());
    // 官方 GLM-5.3 系列的档位（官方 builtin config 里那条
    // `modelMatch: ".*glm-5\.3(?:-flash)?(?:[.\-:/\[].*)?"` 的
    // `optionSpecs.reasoningLevel.values` 恰是这三个）——**不含** OpenAI 的
    // `medium` / `minimal`，官方会以 `reasoning-level-not-supported` 拒掉。
    expect([...REASONING_EFFORT_LEVELS].sort()).toEqual(['high', 'low', 'max']);
  });

  it('`REASONING_TO_THOUGHT_LEVEL` 是**恒等**映射（不猜一档：键与值逐字相同）', () => {
    for (const level of REASONING_EFFORT_LEVELS) {
      expect(REASONING_TO_THOUGHT_LEVEL[level]).toBe(level);
    }
    // 闭集外一律抛（fail-closed），不回落成 `high`。
    for (const bad of ['medium', 'minimal', '', 'YOLO']) {
      expect(() => mapReasoningToThoughtLevel(bad), bad).toThrow(/REASONING_LEVEL_(UNKNOWN|MISSING)/);
    }
  });

  it('`mode` 闭集：官方 `$j` 逐字，入口预检与之**逐字相等**（不篡改官方闭集）', () => {
    expect([...OFFICIAL_SESSION_MODES]).toEqual([...ENTRY_HOST_PERMISSION_MODES]);
    // 官方 `$j=m.enum(["plan","build","edit","yolo","auto"])`（偏移 650957）
    expect([...OFFICIAL_SESSION_MODES].sort()).toEqual(['auto', 'build', 'edit', 'plan', 'yolo']);
    // 缺省必须是 `yolo` 而不是 `auto`——官方 `checkPermission` 逐字把 `auto` 判成
    // `deny`（"Auto mode is reserved but not implemented yet"）。
    expect(DEFAULT_HOST_PERMISSION_MODE).toBe('yolo');
    expect(ENTRY_DEFAULT_HOST_PERMISSION_MODE).toBe(DEFAULT_HOST_PERMISSION_MODE);
  });

  it('工具应答策略闭集：驱动器与入口**逐字相等**，缺省都是 `allow`', () => {
    expect([...HOST_TOOL_POLICIES]).toEqual([...ENTRY_HOST_TOOL_POLICIES]);
    expect([...HOST_TOOL_POLICIES].sort()).toEqual(['allow', 'deny']);
    expect(DEFAULT_HOST_TOOL_POLICY).toBe('allow');
    expect(ENTRY_DEFAULT_HOST_TOOL_POLICY).toBe(DEFAULT_HOST_TOOL_POLICY);
  });

  it('子宿主墙钟旋钮：缺省 300000，正整数生效，非法值抛错（2026-10-10 长任务截断修复）', () => {
    // 缺省：历史行为原值，一字不变。
    expect(DEFAULT_HOST_TURN_TIMEOUT_MS).toBe(300_000);
    expect(resolveHostTurnTimeoutMs({})).toBe(300_000);
    expect(resolveHostTurnTimeoutMs({ [HOST_TURN_TIMEOUT_ENV_KEY]: '  ' })).toBe(300_000);
    expect(resolveHostTurnTimeoutMs({ [HOST_TURN_TIMEOUT_ENV_KEY]: '1800000' })).toBe(1_800_000);
    // 非法：非整数 / 非正数 / 超一天上限——全部拒绝启动而不是猜一个超时。
    for (const bad of ['abc', '1.5', '0', '-1000', '86400001']) {
      expect(() => resolveHostTurnTimeoutMs({ [HOST_TURN_TIMEOUT_ENV_KEY]: bad }), `bad=${bad}`).toThrowError(/ZCC_HOST_TURN_TIMEOUT_MS/);
    }
    // 入口闭集登记了这个键（设了它不再 UNKNOWN_ENV_KEY 拒启）。
    expect(ENTRY_ENV_KEYS).toContain('ZCC_HOST_TURN_TIMEOUT_MS');
  });

  it('`api` 包**不 import** `official-host`（包边界单向：官方协议只由驱动器那一层碰）', () => {
    // `REASONING_EFFORT_LEVELS` 必须住在 `api` 里（API 层要独立校验），
    // 所以同一份闭集在两层各有一份 —— 代价就是**必须有**上面那条跨层钉。
    // 反过来，`api` 绝不能反向依赖 `official-host`，否则 `chat.ts` 会被拖进
    // 凭据仓 / 官方 bundle 那一整条依赖链。
    const source = readFileSync(join(ROOT, 'packages', 'api', 'src', 'chat.ts'), 'utf8');
    const stripped = stripComments(source);
    expect(stripped).not.toContain('official-host');
    const authSource = stripComments(readFileSync(join(ROOT, 'packages', 'api', 'src', 'auth.ts'), 'utf8'));
    expect(authSource).not.toContain('official-host');
  });

  it('`TOP_LEVEL_ACCEPTED` / `TOP_LEVEL_REJECTED` 精确钉死，且两者**互斥且并**是有意划的', () => {
    // **COMPAT2**：这是**真实客户端字段集**（mcode@0.5.6 已安装源码挖全 + OpenAI 官方
    // Chat Completions 全集）的封闭结果。少一个键 = 又一次"撞一个补一个"，
    // 多一个键 = 端点接受了它却没定义它。所以这里用**精确相等**钉死，不许增量漂移。
    expect([...TOP_LEVEL_ACCEPTED]).toEqual([
      'model',
      'messages',
      'stream',
      'max_tokens',
      'max_completion_tokens',
      'stream_options',
      'reasoning_effort',
      'temperature',
      'top_p',
      'store',
      'seed',
      'presence_penalty',
      'frequency_penalty',
      'service_tier',
      'verbosity',
      'prompt_cache_key',
      'prompt_cache_retention',
      'safety_identifier',
      'n',
      'metadata',
      'user',
      'tools',
      'tool_choice'
    ]);
    // 被拒的那一批**一条都不许**出现在已接受表里（互斥）。
    for (const key of Object.keys(TOP_LEVEL_REJECTED)) {
      expect([...TOP_LEVEL_ACCEPTED], key).not.toContain(key);
    }
    // COMPAT1 移出的三个键、COMPAT2 移出的十个键、**COMPAT3 移出的两个键**，
    // **必须**已经在接受表里。
    const moved = [
      'reasoning_effort',
      'temperature',
      'top_p',
      'store',
      'seed',
      'presence_penalty',
      'frequency_penalty',
      'service_tier',
      'max_completion_tokens',
      'tools',
      'tool_choice'
    ];
    for (const key of moved) {
      expect([...TOP_LEVEL_ACCEPTED], key).toContain(key);
      expect(Object.keys(TOP_LEVEL_REJECTED)).not.toContain(key);
    }
    // C 类逐条钉死：每一条都必须给出**为什么不能只披露**的理由，且非空。
    // `n` 是特例（走"只接受 1"那条专用规则），所以不在表里；
    // `tools` / `tool_choice` 是特例（走"只接受空形状"那条专用规则，见 `parseToolDeclarations`）。
    expect(Object.keys(TOP_LEVEL_REJECTED).sort()).toEqual([
      'audio',
      'function_call',
      'functions',
      'logit_bias',
      'logprobs',
      'modalities',
      'moderation',
      'parallel_tool_calls',
      'prediction',
      'prompt_cache_options',
      'response_format',
      'stop',
      'top_logprobs',
      'web_search_options'
    ]);
    for (const [key, reason] of Object.entries(TOP_LEVEL_REJECTED)) {
      expect(reason.trim().length, `${key} 必须有拒绝理由`).toBeGreaterThan(0);
    }
    // COMPAT2 移出 `n` 之后它进了接受表，但**不是** A 类：它必须由专用规则把守。
    expect([...TOP_LEVEL_ACCEPTED]).toContain('n');
    expect(Object.keys(NOT_FORWARDED_SPECS)).not.toContain('n');
  });

  it('`NOT_FORWARDED_SPECS` 是 A 类全表，值域与 OpenAI 官方逐条一致且互斥于拒绝表', () => {
    expect(Object.keys(NOT_FORWARDED_SPECS)).toEqual([
      'temperature',
      'top_p',
      'store',
      'seed',
      'presence_penalty',
      'frequency_penalty',
      'service_tier',
      'verbosity',
      'prompt_cache_key',
      'prompt_cache_retention',
      'safety_identifier'
    ]);
    // 逐条值域（OpenAI 官方 API reference，2026-10-02 核实）。
    expect(NOT_FORWARDED_SPECS['temperature']).toEqual({ kind: 'number', min: 0, max: 2 });
    expect(NOT_FORWARDED_SPECS['top_p']).toEqual({ kind: 'number', min: 0, max: 1 });
    expect(NOT_FORWARDED_SPECS['store']).toEqual({ kind: 'boolean' });
    expect(NOT_FORWARDED_SPECS['seed']).toEqual({ kind: 'integer', min: 0, max: 2_147_483_647 });
    expect(NOT_FORWARDED_SPECS['presence_penalty']).toEqual({ kind: 'number', min: -2, max: 2 });
    expect(NOT_FORWARDED_SPECS['frequency_penalty']).toEqual({ kind: 'number', min: -2, max: 2 });
    expect(NOT_FORWARDED_SPECS['service_tier']).toEqual({
      kind: 'enum',
      values: ['auto', 'default', 'flex', 'scale', 'priority', 'fast']
    });
    expect(NOT_FORWARDED_SPECS['verbosity']).toEqual({ kind: 'enum', values: ['low', 'medium', 'high'] });
    expect(NOT_FORWARDED_SPECS['prompt_cache_key']).toEqual({ kind: 'string', maxChars: 64 });
    expect(NOT_FORWARDED_SPECS['prompt_cache_retention']).toEqual({ kind: 'enum', values: ['in_memory', '24h'] });
    expect(NOT_FORWARDED_SPECS['safety_identifier']).toEqual({ kind: 'string', maxChars: 64 });
    // 这些键**不在** `TOP_LEVEL_REJECTED` 里——它们走"接受 + 标注未转发"那条路。
    for (const key of Object.keys(NOT_FORWARDED_SPECS)) {
      expect(Object.keys(TOP_LEVEL_REJECTED), key).not.toContain(key);
      expect([...TOP_LEVEL_ACCEPTED], key).toContain(key);
    }
    // 键序即响应 `zcc.parameters_not_forwarded` 的输出序（COMPAT1 钉死 temperature 在 top_p 前）。
    expect(Object.keys(NOT_FORWARDED_SPECS).indexOf('temperature')).toBeLessThan(
      Object.keys(NOT_FORWARDED_SPECS).indexOf('top_p')
    );
  });

  it('`ACCEPTED_NOT_FORWARDED_BUILTINS` 钉死那两个被静默丢弃过的内置键', () => {
    // **COMPAT2 发现的既有缺陷**：`metadata` / `user` 早就在接受表里、也解析了，
    // 但驱动器侧从来没有槽位，而披露表只列了 temperature / top_p —— 一直静默丢弃。
    expect([...ACCEPTED_NOT_FORWARDED_BUILTINS]).toEqual(['metadata', 'user']);
    for (const key of ACCEPTED_NOT_FORWARDED_BUILTINS) {
      expect([...TOP_LEVEL_ACCEPTED], key).toContain(key);
      expect(Object.keys(TOP_LEVEL_REJECTED)).not.toContain(key);
      expect(Object.keys(NOT_FORWARDED_SPECS)).not.toContain(key);
    }
  });

  it('COMPAT2：`maxTokens` **不进**官方 `session/create` params（真缺陷修复的静态钉）', () => {
    // 官方 `session/create` 的 params schema（`zcode.cjs` 偏移 757102 的 `nGt`）是
    // `.strict()` 且**逐字没有**上限槽位（嵌套 `model` 的 `Pu` 偏移 508944 同样
    // `.strict()`、同样没有），官方在偏移 14479993 逐字 `yl(nGt,t)`，而 `yl`
    // （偏移 14131416）= `e.parse(t)` + 失败即 `-32602 Invalid params`
    // → **任何带上限的请求都被官方拒掉**，而 `zcc.max_tokens_enforced` 还报 `true`。
    // 修法：上限不再进官方协议面，改由 API 层如实披露为"未转发"。
    // 这里用静态钉（**读生产源码本身**，不是读测试替身）：session/create 的 params
    // 对象里一旦有人再把 `maxTokens` 加回来，这条立刻变红。
    const src = stripComments(readFileSync(join(ROOT, 'scripts', 'official-host', 'session-drive.mjs'), 'utf8'));
    // params 对象的字面量起点（`model:` 之前的 `{`）到它闭合之间的那一段。
    const at = src.indexOf('thoughtLevel: request.thoughtLevel');
    expect(at, 'session/create params 里的 thoughtLevel 必须逐字在场').toBeGreaterThan(0);
    const window = src.slice(at, at + 400);
    expect(window, 'session/create params 不得再出现 maxTokens').not.toContain('maxTokens');
    expect(window).toContain('mode: permissionMode');
  });

  it('COMPAT2：`enforcesMaxTokens` 由**每个驱动器**自报，official-host 逐字为 `false`', () => {
    // 反向钉：唯一会真的截断的 fixture 驱动器必须报 `true`，否则响应会谎称
    // "上限没生效"而它其实生效了 —— 那是另一种假披露。
    expect(createFixtureDriver().enforcesMaxTokens).toBe(true);
    expect(createUnavailableDriver({ status: 'not_attached' }).enforcesMaxTokens).toBe(false);
    // official-host 逐字自报 `false`：用静态钉读驱动器源码的对象字面量
    // （构造真驱动器需要 descriptor + 目录 + 可服务模型三份合成输入，
    //  那些已由 `official-host-contract` 其它用例覆盖；这里只钉这一条事实）。
    const src = stripComments(readFileSync(join(ROOT, 'packages', 'official-host', 'src', 'host-driver.ts'), 'utf8'));
    const at = src.indexOf('fixture: false,');
    expect(at, 'official-host 的 `fixture:false` 必须逐字在场').toBeGreaterThan(0);
    const window = src.slice(at, at + 200);
    expect(window, 'official-host 必须自报 enforcesMaxTokens:false').toContain('enforcesMaxTokens: false');
    // 上限键**不在** A 类表里：它按**驱动器能力**决定披露与否，不是解析期就定的。
    expect(Object.keys(NOT_FORWARDED_SPECS)).not.toContain('max_tokens');
    expect(Object.keys(NOT_FORWARDED_SPECS)).not.toContain('max_completion_tokens');
    // 披露函数本身：逐字用客户端发来的键名；驱动器强制执行时不披露。
    expect(maxTokensNotForwarded({ maxTokensSource: 'max_completion_tokens' }, false)).toEqual(['max_completion_tokens']);
    expect(maxTokensNotForwarded({ maxTokensSource: 'max_tokens' }, false)).toEqual(['max_tokens']);
    expect(maxTokensNotForwarded({ maxTokensSource: 'max_completion_tokens' }, true)).toEqual([]);
    expect(maxTokensNotForwarded({ maxTokensSource: null }, false)).toEqual([]);
  });

  it('`MCODE_FIELD_SOURCES` 逐条给出真实客户端字段出处，且**不含**编造的键', () => {
    // 这张表是"字段从哪来"在代码里的**可查**载体。少了它，A 类的裁定就只剩报告口述。
    for (const [key, source] of Object.entries(MCODE_FIELD_SOURCES)) {
      expect(source, `${key} 必须有出处`).toMatch(/chunk-HVP63X6W\.js/);
    }
    // 逐字钉住几个**判定过归属**的键：接不接、接了说不说，都取决于这几条。
    const required = ['model', 'messages', 'stream', 'stream_options', 'store', 'max_completion_tokens', 'reasoning_effort', 'temperature', 'tools'];
    for (const key of required) {
      expect(Object.keys(MCODE_FIELD_SOURCES), key).toContain(key);
    }
    // `store` 的出处必须点明是**客户端自己**发的（不是 SDK 加的）——工单点名要查实这一条。
    expect(MCODE_FIELD_SOURCES['store']).toContain('ce()');
    expect(MCODE_FIELD_SOURCES['max_completion_tokens']).toContain('max_completion_tokens');
    // 表里的键必须**全部**是本端点已裁决的顶层名：要么接受（A/B 类），要么拒绝（C 类）。
    // 这样"客户端发了什么"与"我们怎么处置它"两张表就**互为闭集**——既不漏判，
    // 也不会凭空多出一个谁都没裁决过的字段。
    const vendorOnly = ['tool_stream', 'provider', 'providerOptions'];
    const acceptedNames = /** @type {readonly string[]} */ ([...TOP_LEVEL_ACCEPTED]);
    for (const key of Object.keys(MCODE_FIELD_SOURCES)) {
      const known = acceptedNames.includes(key) || Object.keys(TOP_LEVEL_REJECTED).includes(key) || vendorOnly.includes(key);
      expect(known, `${key} 必须是已裁决的顶层名或已点名的厂商私有键`).toBe(true);
    }
    // 厂商私有键那三个必须逐字列全——它们是"知道但不是 OpenAI 字段"的全部。
    for (const key of vendorOnly) {
      expect(Object.keys(MCODE_FIELD_SOURCES), key).toContain(key);
      expect(/** @type {readonly string[]} */ ([...TOP_LEVEL_ACCEPTED]), key).not.toContain(key);
    }
    // **COMPAT3**：`tools` 仍在真客户端字段表里（恢复旧会话时它**真的**会发 `tools:[]`），
    // 但它的**裁决**从"整键 422"变成"只接受空形状"。所以这里钉的是
    // "它在接受表里 + 出处必须点明那一条空数组分支"，而不是"它在拒绝表里"。
    expect([...TOP_LEVEL_ACCEPTED]).toContain('tools');
    expect(Object.keys(TOP_LEVEL_REJECTED)).not.toContain('tools');
    expect(MCODE_FIELD_SOURCES['tools']).toContain('tools:[]');
    // `messages` 的出处必须点明 role 是客户端**自己**决定的（`developer` vs `system`）
    // ——这正是 COMPAT3 接受那两个 role 的原因，钉住出处免得日后无声漂移。
    expect(MCODE_FIELD_SOURCES['messages']).toContain('developer');
    expect(MCODE_FIELD_SOURCES['messages']).toContain('system');
  });

  it('COMPAT3：`system` / `developer` 被接受并折叠，其余 role 仍然 422（闭集精确钉死）', () => {
    // 协调者 2026-10-02 裁定：接受这两个 role，折叠进 prompt 上下文并如实披露。
    // 它们的成因**不是**"分类没做完"，而是真客户端**必然**发：mcode 的 `ke()`
    // （`chunk-HVP63X6W.js` off 10416）逐字
    // `e.reasoning && t.supportsDeveloperRole ? "developer" : "system"`，
    // 而 `supportsDeveloperRole` 对自定义 baseURL 缺省 true（off 15435）。
    expect([...SUPPORTED_ROLES]).toEqual(['system', 'developer', 'user', 'assistant']);
    expect([...FOLDED_PROMPT_ROLES]).toEqual(['system', 'developer']);
    // 折叠集合 ⊂ 接受集合：对话轮（user/assistant）**不是**被折叠的指令轮。
    for (const role of FOLDED_PROMPT_ROLES) expect(SUPPORTED_ROLES).toContain(role);
    for (const role of ['user', 'assistant']) expect(FOLDED_PROMPT_ROLES).not.toContain(role);
    // **恰好两个**被折叠：多一个（把 user 也折了）或少一个（又变成 422）都立刻红。
    const folded = /** @type {readonly string[]} */ ([...FOLDED_PROMPT_ROLES]);
    expect(folded.filter((r) => r === 'user').length).toBe(0);
    // `tool` / `function` **不在**接受闭集里：把工具结果轮压成 user 会静默改变消息语义。
    // **COMPAT5 说明**：`tool` 之所以仍不在闭集里，是因为它**不走闭集**——它在
    // `parseMessage` 里被**单独**接住并转写成带 `[工具结果] ` 前缀的 `user` 轮，
    // 改写**在文本里可见**；而顶层 `SUPPORTED_ROLES` 描述的是"原样透传给驱动器的
    // role 闭集"，往里加 `tool` 会让驱动器**误以为**上游认这个 role（官方协议面没有）。
    // 因此本钉继续有效，且**顺带**钉住了"COMPAT5 没有偷偷扩闭集"这条边界。
    for (const role of ['tool', 'function', 'Tool', 'user ', '']) {
      expect(SUPPORTED_ROLES, role).not.toContain(role);
    }
  });

  it('COMPAT3：折叠是**共享实现**（official-host 与 fixture 走同一个函数、同一行格式）', () => {
    // 折叠格式必须是**唯一**的：两个驱动器各写一遍 `map().join()` 就是两份可能漂移的实现。
    // 静态钉（读生产源码本身）：official-host 一旦改回自己内联折叠，这条立刻红。
    const src = stripComments(readFileSync(join(ROOT, 'packages', 'official-host', 'src', 'host-driver.ts'), 'utf8'));
    expect(src, 'official-host 必须调用共享的 foldMessagesToPrompt').toContain('foldMessagesToPrompt(request.messages)');
    expect(src, 'official-host 不得内联第二份折叠实现').not.toContain('m.role}: ${m.content');
    // 行格式逐字钉死：`${role}: ${content}` + 换行连接（与既有**多轮**折叠同机制）。
    expect(foldMessagesToPrompt([{ role: 'user', content: 'a' }])).toBe('user: a');
    expect(foldMessagesToPrompt([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }])).toBe('system: S\nuser: U');
    expect(foldMessagesToPrompt([{ role: 'developer', content: 'D' }])).toBe('developer: D');
    expect(foldMessagesToPrompt([])).toBe('');
    // **顺序原样保留**：折叠不重排、不去重、不改写 role 标签。
    expect(
      foldMessagesToPrompt([
        { role: 'user', content: '1' },
        { role: 'system', content: '2' },
        { role: 'assistant', content: '3' }
      ])
    ).toBe('user: 1\nsystem: 2\nassistant: 3');
    // `api` 包不 import `official-host`（上面已钉），而 `official-host` 可以 import `api`：
    // 共享实现在 `api` 侧，所以包边界单向依然成立。
  });

  it('COMPAT3 建立 / COMPAT4 放宽：`tools` / `tool_choice` 走"接受 + 明示未转发"，`required` 仍拒（闭集层面逐条）', () => {
    // 移出拒绝表的**只有**这两个键（COMPAT3），COMPAT4 把**接受面**从"只有空形状"
    // 扩到"非空合法形状"，并**新增三个披露键**。判定本身在 api-contract 里逐条走过
    // HTTP（流式与非流式两条路径都有），这里钉的是**闭集层面**的形状事实。
    expect([...ACCEPTED_TOOL_CHOICES]).toEqual(['none', 'auto']);
    expect([...REQUIRED_TOOL_CHOICES]).toEqual(['required', 'any']);
    // **转发数恒为 0 是本端点的结构事实**，不是一个可调的量：暴露成常量让测试能
    // 逐字钉住"永远是 0"，避免有人日后把它改成"按需转发"却没有配套能力。
    expect(TOOLS_FORWARDED_NONE).toBe(0);
    // 接受闭集与"要求必须调工具"闭集**零交集**（`none`/`auto` 不蕴含 `required`）。
    for (const c of ACCEPTED_TOOL_CHOICES) expect(REQUIRED_TOOL_CHOICES).not.toContain(c);
    expect([...TOP_LEVEL_ACCEPTED]).toContain('tools');
    expect([...TOP_LEVEL_ACCEPTED]).toContain('tool_choice');
    // 工具声明**不进** A 类披露表：它有自己的两个键（`tools_received` /
    // `tools_forwarded`），混进 `parameters_not_forwarded` 会让"参数"和"声明"两套口径糊在一起。
    expect(Object.keys(NOT_FORWARDED_SPECS)).not.toContain('tools');
    expect(Object.keys(NOT_FORWARDED_SPECS)).not.toContain('tool_choice');
    expect([...ACCEPTED_NOT_FORWARDED_BUILTINS]).not.toContain('tools');
    // **没有外溢**：`tools` 的从属开关仍拒（宣称"支持并行工具调用开关但不支持工具调用"
    // 是自相矛盾的），且真客户端不发它（它不在真客户端字段表里）。
    expect(Object.keys(TOP_LEVEL_REJECTED)).toContain('parallel_tool_calls');
    expect(Object.keys(MCODE_FIELD_SOURCES)).not.toContain('parallel_tool_calls');
    // 同族的旧字段（已 deprecated 的函数调用）**一条都不许**跟着被接受。
    for (const key of ['functions', 'function_call']) {
      expect(Object.keys(TOP_LEVEL_REJECTED), key).toContain(key);
      expect([...TOP_LEVEL_ACCEPTED], key).not.toContain(key);
    }
  });

  it('COMPAT4：`tools_forwarded: 0` 在**驱动器契约上**可证（`DriverRequest` 没有工具槽位、驱动源码不读它）', () => {
    // 披露说"一条都没转发"必须能被独立复核。本条用**静态钉**证明两件事：
    //  1. 驱动器**收不到**工具声明（`DriverRequest` 上根本没有这两个字段），
    //     所以"转发"在结构上**无处发生**，不是"我们选择不转"这种自报；
    //  2. 驱动实现**没有**绕过契约私读 `request.tools` 的后门。
    const chatSrc = code('packages/api/src/chat.ts');
    const from = chatSrc.indexOf('export interface DriverRequest');
    expect(from, 'chat.ts 仍必须有 DriverRequest 接口').toBeGreaterThan(-1);
    const driverRequestBlock = chatSrc.slice(from, chatSrc.indexOf('export type DriverEvent', from));
    expect(driverRequestBlock, 'DriverRequest 不得有 tools 槽位').not.toMatch(/\btools\b/);
    expect(driverRequestBlock, 'DriverRequest 不得有 tool_choice 槽位').not.toMatch(/\btool_choice\b/);
    for (const rel of ['packages/api/src/chat.ts', 'packages/official-host/src/host-driver.ts']) {
      const src = code(rel);
      expect(src, `${rel} 不得从请求上读 tools`).not.toMatch(/request\s*\.\s*tools\b/);
      expect(src, `${rel} 不得从请求上读 tool_choice`).not.toMatch(/request\s*\.\s*tool_choice\b/);
    }
    // 官方 `session/send` 那一侧同样**不**带工具声明：真发出去的只有 `content` 文本。
    const drive = code('scripts/official-host/session-drive.mjs');
    expect(drive, 'session/send 不得携带 tools 声明').not.toMatch(/tools\s*:/);
  });
});
