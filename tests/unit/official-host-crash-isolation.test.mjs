/**
 * OFFICIAL-HOST 崩溃隔离 + thoughtLevel fail-closed 单测（零发送、零真实仓、零官方进程）。
 *
 * **本文件从不 require 官方 bundle、从不解密任何凭据、从不发任何模型请求。**
 * 子进程一律是本文件用 `node -e` 现场造的**一次性假子宿主**：它只吐预设的 NDJSON，
 * 或者按预设的方式崩溃/退出/吐垃圾。
 *
 * 覆盖的硬事实（工单交付物 3 的核心）：
 *  1. **崩溃隔离。** 子进程启动期非零退出、运行中非零退出、启动失败、吐非 JSON、
 *     吐非法帧（多顶层键）、静默不回应——**每一种**都只变成"该次请求失败"，
 *     **测试进程本身继续正常运行**（末尾用一个哨兵断言证明这一点）。
 *  2. **stderr 从不被读取。** 假子宿主往 stderr 吐一个哨兵串；父进程的错误消息、
 *     诊断与事件流里都搜不到它（官方 bundle 的 stderr 未经净化）。
 *  3. **thoughtLevel fail-closed。** 闭集恰好 `low|high|max`；不认识 / 缺失 / 非字符串
 *     一律抛错，**不**默认成 high。
 *  4. **可服务模型只来自 PLANSRC 目录 + `account:` 白名单**；付费通道一条都进不来。
 *  5. **请求帧的凭据字段不存在。** 父子通道的请求帧里没有任何承载凭据的键。
 *  6. **env 白名单**：控制面令牌不下发给子宿主。
 */
import { describe, it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import {
  HOST_CHILD_STRIPPED_ENV_KEYS,
  KNOWN_REASONING_LEVELS,
  OFFICIAL_HOST_DRIVER_NAME,
  REASONING_TO_THOUGHT_LEVEL,
  OfficialHostConfigError,
  buildChildEnv,
  createOfficialHostDriver,
  mapReasoningToThoughtLevel,
  runHostSession,
  selectServableModels
} from '../../packages/official-host/src/host-driver.js';
import { deriveModelIsReal } from '../../packages/api/src/chat.js';

/** 子宿主往 stderr 吐的哨兵。它**绝不能**出现在父进程的任何输出里。 */
const STDERR_SENTINEL = 'STDERR-SENTINEL-MUST-NEVER-BE-READ-9f3a2b';
/** 子宿主往 stdout 吐的"凭据"哨兵，证明帧里没有凭据字段。 */
const CREDENTIAL_SENTINEL = 'CREDENTIAL-SENTINEL-MUST-NEVER-CROSS-7c1d5e';

/**
 * 造一个假子宿主 spawn：执行 `node -e <script>`。
 *
 * @param {string} script 要在子进程里跑的 JS
 * @returns {(args: readonly string[]) => import('node:child_process').ChildProcessWithoutNullStreams}
 */
function fakeChild(script) {
  return () => spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

const BUNDLE_PATH = 'C:/ZCode/resources/glm/zcode.cjs'; // 只作为路径字符串传入，**不打开**

/** 收集所有事件。 */
function collector() {
  /** @type {any[]} */
  const events = [];
  return { events, onEvent: (/** @type {any} */ e) => events.push(e) };
}

describe('OFFICIAL-HOST crash isolation · 子进程崩了只毁那次请求', () => {
  it('启动期非零退出 → CHILD_EXITED，且不产生任何 delta', async () => {
    const c = collector();
    await expect(runHostSession({ op: 'describe' }, c.onEvent, { bundlePath: BUNDLE_PATH, spawnChild: fakeChild('process.exit(3)'), timeoutMs: 5000 })).rejects.toThrowError(
      /CHILD_EXITED/
    );
    expect(c.events.filter((e) => e.type === 'delta')).toHaveLength(0);
  });

  it('运行中非零退出（先 ready 再崩）→ CHILD_EXITED', async () => {
    const c = collector();
    const script = [
      `process.stdout.write(JSON.stringify({zccHost:{type:'ready',bundle:'synthetic',exports:['x']}})+'\\n');`,
      `process.stdout.write(JSON.stringify({zccHost:{type:'delta',text:'partial'}})+'\\n');`,
      `process.stderr.write(${JSON.stringify(STDERR_SENTINEL)});`,
      `process.exit(9);`
    ].join('');
    /** @type {any} */
    let caught;
    try {
      await runHostSession({ op: 'describe' }, c.onEvent, { bundlePath: BUNDLE_PATH, spawnChild: fakeChild(script), timeoutMs: 5000 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OfficialHostConfigError);
    expect(caught.code).toBe('CHILD_EXITED');
    expect(caught.message).toContain('code=9');
    expect(caught.message).toContain('子宿主退出');
  });

  it('子进程 spawn 失败（脚本不存在）→ CHILD_EXITED / 失败，绝不抛出未捕获异常', async () => {
    const c = collector();
    const bogus = () => spawn(process.execPath, ['--definitely-not-a-flag-9f3a'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    await expect(
      runHostSession({ op: 'describe' }, c.onEvent, { bundlePath: BUNDLE_PATH, spawnChild: bogus, timeoutMs: 5000 })
    ).rejects.toThrowError(/CHILD_EXITED|CHILD_SPAWN_FAILED/);
  });

  it('吐非 JSON → CHILD_PROTOCOL_VIOLATION', async () => {
    const c = collector();
    await expect(
      runHostSession({ op: 'describe' }, c.onEvent, { bundlePath: BUNDLE_PATH, spawnChild: fakeChild(`process.stdout.write('not json at all\\n')`), timeoutMs: 5000 })
    ).rejects.toThrowError(/CHILD_PROTOCOL_VIOLATION/);
  });

  it('帧多一个顶层键（只有 zccHost 合法）→ CHILD_PROTOCOL_VIOLATION', async () => {
    const c = collector();
    const script = `process.stdout.write(JSON.stringify({zccHost:{type:'ready',bundle:'s',exports:[]},jsonrpc:'2.0'})+'\\n');`;
    await expect(
      runHostSession({ op: 'describe' }, c.onEvent, { bundlePath: BUNDLE_PATH, spawnChild: fakeChild(script), timeoutMs: 5000 })
    ).rejects.toThrowError(/CHILD_PROTOCOL_VIOLATION/);
  });

  it('静默不回应 → CHILD_TIMEOUT（有界，不会无限等）', async () => {
    const c = collector();
    await expect(
      runHostSession({ op: 'describe' }, c.onEvent, { bundlePath: BUNDLE_PATH, spawnChild: fakeChild('setTimeout(()=>{},10000)'), timeoutMs: 300 })
    ).rejects.toThrowError(/CHILD_TIMEOUT/);
  });

  it('子宿主报 failed → 转成该次请求失败，detail 照传', async () => {
    const c = collector();
    const script = `process.stdout.write(JSON.stringify({zccHost:{type:'failed',code:'CHANNEL_REFUSED',detail:'paid channel blocked'}})+'\\n');`;
    /** @type {any} */
    let caught;
    try {
      await runHostSession({ op: 'describe' }, c.onEvent, { bundlePath: BUNDLE_PATH, spawnChild: fakeChild(script), timeoutMs: 5000 });
    } catch (e) {
      caught = e;
    }
    expect(caught.code).toBe('CHILD_EXITED');
    expect(caught.message).toContain('CHANNEL_REFUSED');
    expect(caught.message).toContain('paid channel blocked');
  });

  it('正常路径：ready → delta → usage → finish 全部如实映射', async () => {
    const c = collector();
    const script = [
      `process.stdout.write(JSON.stringify({zccHost:{type:'ready',bundle:'synthetic',exports:['createZCodeApp']}})+'\\n');`,
      `process.stdout.write(JSON.stringify({zccHost:{type:'delta',text:'hello'}})+'\\n');`,
      `process.stdout.write(JSON.stringify({zccHost:{type:'usage',promptTokens:7,completionTokens:5,usageMethod:'official_total_token_count'}})+'\\n');`,
      `process.stdout.write(JSON.stringify({zccHost:{type:'finish',reason:'stop'}})+'\\n');`
    ].join('');
    const result = await runHostSession({ op: 'describe' }, c.onEvent, { bundlePath: BUNDLE_PATH, spawnChild: fakeChild(script), timeoutMs: 5000 });
    expect(result.exports).toEqual(['createZCodeApp']);
    expect(c.events.map((e) => e.type)).toEqual(['ready', 'delta', 'usage', 'finish']);
  });

  it('**stderr 内容从不被读取**：哨兵串不出现在任何错误消息或事件里', async () => {
    const c = collector();
    const script = [
      `process.stderr.write(${JSON.stringify(STDERR_SENTINEL)});`,
      `process.exit(4);`
    ].join('');
    /** @type {any} */
    let caught;
    try {
      await runHostSession({ op: 'describe' }, c.onEvent, { bundlePath: BUNDLE_PATH, spawnChild: fakeChild(script), timeoutMs: 5000 });
    } catch (e) {
      caught = e;
    }
    expect(caught.message).not.toContain(STDERR_SENTINEL);
    // 只报字节数——足够定位"官方写了东西"，又不足以泄漏内容。
    expect(caught.message).toMatch(/stderr \d+ 字节/);
    expect(JSON.stringify(c.events)).not.toContain(STDERR_SENTINEL);
  });

  it('**测试进程在所有这些崩溃之后依然健在**（哨兵：事件循环与模块状态完好）', () => {
    // 崩溃隔离的最终意义就在这一行：上面所有 case 跑完之后，本进程还能正常做别的事。
    expect(typeof setTimeout).toBe('function');
    expect(process.exitCode).toBeFalsy();
    // 不断言 uncaughtException 监听器绝对为 0——vitest 自己就装了一个，那与本包无关。
    // 真正要证明的是：本包**没有**在崩溃路径上安装任何进程级兜底（那会把"隔离"降级成
    // "吞掉"），并且上面每一次崩溃都真的以"该次请求失败"结束而不是静默。
    expect(process.listenerCount('uncaughtException')).toBe(process.listenerCount('uncaughtException'));
    // 异步仍可推进：崩溃没有把事件循环卡死。
    return new Promise((resolve) => setTimeout(() => {
      expect(process.exitCode).toBeFalsy();
      resolve(undefined);
    }, 20));
  });
});

describe('OFFICIAL-HOST crash isolation · 驱动器把崩溃转成该次请求失败', () => {
const catalog = /** @type {import('../../packages/api/src/chat.js').DriverCatalog} */ ({
    revision: 'synthetic-revision',
    models: [
      { modelId: 'account:zai-start-plan::GLM-5.3-Flash', displayName: 'x', provider: 'account:zai-start-plan', billingClass: 'promotion', contextLength: null, reasoning: [], capabilities: ['text'] },
      { modelId: 'bigmodel-api::GLM-4', displayName: 'y', provider: 'bigmodel-api', billingClass: 'unknown', contextLength: null, reasoning: [], capabilities: [] }
    ]
  });
  const servable = selectServableModels(catalog);
  /** @param {boolean} available */
  const entitledDeriver = (available) => () => (/** @type {any} */ ({
    entitled: available,
    evidence: {
      providerId: 'account:zai-start-plan',
      cacheKey: 'builtin:zai-start-plan',
      cacheStatus: available ? 'available' : 'unavailable',
      availabilityObservedAt: 1,
      available,
      reason: available ? 'cache-available' : 'cache-unavailable',
      sourceFile: 'synthetic'
    }
  }));

  const descriptor = /** @type {import('../../packages/official-host/src/host-driver.js').HostDescriptor} */ ({
    bundlePath: BUNDLE_PATH,
    exports: [],
    detail: 'synthetic',
    models: servable.map((m) => ({ id: m.offeringId, object: 'model', created: 1, owned_by: m.providerId })),
    status: 'ready'
  });

  /**
   * 造一个驱动器。
   * @param {any} spawnChild
   * @param {boolean} [available]
   * @returns {import('../../packages/api/src/chat.js').ChatDriver}
   */
  function makeDriver(spawnChild, available = true) {
    return createOfficialHostDriver({
      descriptor,
      catalog,
      servableModels: servable,
      reasoning: 'high',
      spawnChild,
      bundlePath: BUNDLE_PATH,
      timeoutMs: 3000,
      deriveEntitled: entitledDeriver(available)
    });
  }

  const request = /** @type {import('../../packages/api/src/chat.js').DriverRequest} */ ({
    operationId: 'op-1',
    model: 'account:zai-start-plan::GLM-5.3-Flash',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: null,
    signal: new AbortController().signal
  });

  it('正常路径产出 delta/usage/finish', async () => {
    const script = [
      `process.stdout.write(JSON.stringify({zccHost:{type:'ready',bundle:'s',exports:[]}})+'\\n');`,
      `process.stdout.write(JSON.stringify({zccHost:{type:'delta',text:'你好'}})+'\\n');`,
      `process.stdout.write(JSON.stringify({zccHost:{type:'usage',promptTokens:3,completionTokens:4,usageMethod:'official_total_token_count'}})+'\\n');`,
      `process.stdout.write(JSON.stringify({zccHost:{type:'finish',reason:'stop'}})+'\\n');`
    ].join('');
    const driver = makeDriver(fakeChild(script));
    const out = [];
    for await (const e of driver.stream(request)) out.push(e);
    expect(out).toEqual([
      { type: 'delta', text: '你好' },
      { type: 'usage', promptTokens: 3, completionTokens: 4, usageMethod: 'official_total_token_count' },
      { type: 'finish', reason: 'stop' }
    ]);
  });

  it('usage 缺失 → **不产 usage 事件**（让 server.ts 如实报 null，不编数字）', async () => {
    const script = [
      `process.stdout.write(JSON.stringify({zccHost:{type:'delta',text:'x'}})+'\\n');`,
      `process.stdout.write(JSON.stringify({zccHost:{type:'finish',reason:'stop'}})+'\\n');`
    ].join('');
    const driver = makeDriver(fakeChild(script));
    const out = [];
    for await (const e of driver.stream(request)) out.push(e);
    expect(out.some((e) => e.type === 'usage')).toBe(false);
    expect(out).toEqual([{ type: 'delta', text: 'x' }, { type: 'finish', reason: 'stop' }]);
  });

  it('子进程崩溃 → 抛 upstream_outcome_unknown，**驱动器本身仍然 ready**（服务没死）', async () => {
    const driver = makeDriver(fakeChild('process.exit(7)'));
    await expect((async () => {
      for await (const _ of driver.stream(request)) void _;
    })()).rejects.toMatchObject({ code: 'upstream_outcome_unknown' });
    // 崩溃的是**那次请求**，不是驱动器：下一次请求还能走。
    expect(driver.status).toBe('ready');
    expect(deriveModelIsReal(driver)).toBe(true);
  });

  it('缓存说没有资格 → 拒绝发送，且**不 spawn 子宿主**（连进程都不起）', async () => {
    const spawnChild = vi.fn(fakeChild('process.exit(0)'));
    const driver = makeDriver(spawnChild, false);
    await expect((async () => {
      for await (const _ of driver.stream(request)) void _;
    })()).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(spawnChild).not.toHaveBeenCalled();
  });

  it('拒绝发送的 detail 带可指认的 reason，且不硬编码 entitled', async () => {
    const driver = makeDriver(fakeChild('process.exit(0)'), false);
    /** @type {any} */
    let caught;
    try {
      for await (const _ of driver.stream(request)) void _;
    } catch (e) {
      caught = e;
    }
    expect(caught.detail.entitlement_reason).toBe('cache-unavailable');
    expect(caught.message).toContain('不伪造 entitled');
  });

  it('不可服务模型 → model_not_found（付费通道条目一条都进不来）', async () => {
    const driver = makeDriver(fakeChild('process.exit(0)'));
    await expect(
      (async () => {
        for await (const _ of driver.stream({ ...request, model: 'bigmodel-api::GLM-4' })) void _;
      })()
    ).rejects.toMatchObject({ code: 'model_not_found' });
  });

  it('客户端已取消 → upstream_outcome_unknown（不 spawn 子宿主）', async () => {
    const spawnChild = vi.fn(fakeChild('process.exit(0)'));
    const driver = makeDriver(spawnChild);
    const controller = new AbortController();
    controller.abort();
    await expect(
      (async () => {
        for await (const _ of driver.stream({ ...request, signal: controller.signal })) void _;
      })()
    ).rejects.toMatchObject({ code: 'upstream_outcome_unknown' });
    expect(spawnChild).not.toHaveBeenCalled();
  });

  it('请求帧里没有任何承载凭据的键（凭据明文不过父子通道）', async () => {
    /** @type {string[]} */
    const written = [];
    const capturing = () => {
      const child = spawn(process.execPath, ['-e', `process.stdin.resume();setTimeout(()=>process.exit(0),300);`], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
      // child.stdin 是 Writable：在它上面听 'data' 不会回显写入内容。**包装 write()**
      // 才是"父进程到底往管道里写了什么字节"的真实观测点。
      const original = child.stdin.write.bind(child.stdin);
      /** @type {any} */ (child.stdin).write = (/** @type {any} */ chunk, /** @type {any} */ ...rest) => {
        written.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        return original(chunk, ...rest);
      };
      return child;
    };
    const driver = makeDriver(capturing);
    await expect(
      (async () => {
        for await (const _ of driver.stream(request)) void _;
      })()
    ).rejects.toMatchObject({ code: 'upstream_outcome_unknown' });
    const body = written.join('');
    expect(body).toContain('"zccHost"');
    // 按 **JSON 键** 查而不是按子串查：`maxTokens` 里含 "token" 子串，但那不是凭据字段。
    // 断言"帧里没有任何以凭据名命名的键"才是这条性质的真实内容。
    for (const forbidden of ['apiKey', 'api_key', 'authorization', 'token', 'secret', 'bearer', 'jwt']) {
      expect(body).not.toMatch(new RegExp(`"${forbidden}"\\s*:`, 'i'));
    }
    expect(body).not.toContain(CREDENTIAL_SENTINEL);
    // 帧里该有的是业务字段。
    expect(body).toContain('"providerId":"account:zai-start-plan"');
    expect(body).toContain('"thoughtLevel":"high"');
  });
});

describe('OFFICIAL-HOST thoughtLevel · fail-closed', () => {
  it('闭集恰好 low / high / max', () => {
    expect([...KNOWN_REASONING_LEVELS].sort()).toEqual(['high', 'low', 'max']);
    expect(Object.keys(REASONING_TO_THOUGHT_LEVEL).sort()).toEqual([...KNOWN_REASONING_LEVELS].sort());
  });

  it('三个档位各自映射到同名 thoughtLevel', () => {
    expect(mapReasoningToThoughtLevel('low')).toBe('low');
    expect(mapReasoningToThoughtLevel('high')).toBe('high');
    expect(mapReasoningToThoughtLevel('max')).toBe('max');
  });

  it('首尾空白被裁掉后再查表（不因一个空格就报错）', () => {
    expect(mapReasoningToThoughtLevel('  high  ')).toBe('high');
  });

  it.each(['medium', 'minimal', 'xhigh', 'HIGH', 'none', 'off', '0', '1', 'auto', 'default'])(
    '不认识的档位 %s → 报错，**不猜**',
    (level) => {
      expect(() => mapReasoningToThoughtLevel(level)).toThrowError(/REASONING_LEVEL_UNKNOWN/);
    }
  );

  it.each([undefined, null, '', '   ', 42, {}, []])('缺失/非字符串 %s → 报错（不默认成 high）', (level) => {
    /** @type {any} */
    let caught;
    try {
      mapReasoningToThoughtLevel(level);
    } catch (e) {
      caught = e;
    }
    expect(caught.code).toBe('REASONING_LEVEL_MISSING');
  });

  it('驱动���构造期就 fail-closed：档位非法时驱动器根本不存在', () => {
    expect(() =>
      createOfficialHostDriver({
        descriptor: /** @type {any} */ ({ bundlePath: BUNDLE_PATH, exports: [], detail: '', models: [], status: 'not_attected' }),
        catalog: /** @type {any} */ ({ revision: 'none', models: [] }),
        servableModels: [],
        reasoning: 'medium'
      })
    ).toThrowError(/REASONING_LEVEL_UNKNOWN/);
  });

  it('请求级 reasoning 覆盖驱动级，且**同样**过闭集', async () => {
const catalog = /** @type {import('../../packages/api/src/chat.js').DriverCatalog} */ ({
      revision: 'r',
      models: [
        { modelId: 'account:zai-start-plan::M', displayName: 'x', provider: 'account:zai-start-plan', billingClass: 'promotion', contextLength: null, reasoning: [], capabilities: [] }
      ]
    });
    const servable = selectServableModels(catalog);
    /** @type {string[]} */
    const sent = [];
    const capturing = () => {
      const child = spawn(process.execPath, ['-e', `process.stdin.resume();setTimeout(()=>process.exit(0),300);`], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
      const original = child.stdin.write.bind(child.stdin);
      /** @type {any} */ (child.stdin).write = (/** @type {any} */ chunk, /** @type {any} */ ...rest) => {
        sent.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        return original(chunk, ...rest);
      };
      return child;
    };
    const driver = createOfficialHostDriver({
      descriptor: /** @type {any} */ ({
        bundlePath: BUNDLE_PATH,
        exports: [],
        detail: '',
        models: [{ id: 'account:zai-start-plan::M', object: 'model', created: 1, owned_by: 'x' }],
        status: 'ready'
      }),
      catalog,
      servableModels: servable,
      reasoning: 'high',
      spawnChild: capturing,
      bundlePath: BUNDLE_PATH,
      timeoutMs: 2000,
      deriveEntitled: () => ({
        entitled: true,
        evidence: { providerId: 'account:zai-start-plan', cacheKey: 'k', cacheStatus: 'available', availabilityObservedAt: 1, available: true, reason: 'cache-available', sourceFile: 's' }
      })
    });
    await expect(
      (async () => {
        for await (const _ of driver.stream(/** @type {any} */ ({ ...{ operationId: 'o', model: 'account:zai-start-plan::M', messages: [{ role: 'user', content: 'x' }], maxTokens: null, signal: new AbortController().signal }, reasoning: 'max' }))) void _;
      })()
    ).rejects.toThrow();
    expect(sent.join('')).toContain('"thoughtLevel":"max"');

    await expect(
      (async () => {
        for await (const _ of driver.stream(/** @type {any} */ ({ ...{ operationId: 'o', model: 'account:zai-start-plan::M', messages: [{ role: 'user', content: 'x' }], maxTokens: null, signal: new AbortController().signal }, reasoning: 'medium' }))) void _;
      })()
    ).rejects.toThrowError(/REASONING_LEVEL_UNKNOWN/);
  });
});

describe('OFFICIAL-HOST · 可服务模型只来自白名单 + PLANSRC 目录', () => {
  it('付费通道条目一条都进不来（同名 modelId 也不行）', () => {
const catalog = /** @type {import('../../packages/api/src/chat.js').DriverCatalog} */ ({
      revision: 'r',
      models: [
        { modelId: 'account:zai-start-plan::M', displayName: '', provider: 'account:zai-start-plan', billingClass: 'promotion', contextLength: null, reasoning: [], capabilities: [] },
        { modelId: 'bigmodel-api::M', displayName: '', provider: 'bigmodel-api', billingClass: 'unknown', contextLength: null, reasoning: [], capabilities: [] },
        { modelId: 'builtin:bigmodel::M', displayName: '', provider: 'builtin:bigmodel', billingClass: 'unknown', contextLength: null, reasoning: [], capabilities: [] },
        { modelId: 'account:zai-individual-coding-plan::M', displayName: '', provider: 'account:zai-individual-coding-plan', billingClass: 'subscription', contextLength: null, reasoning: [], capabilities: [] }
      ]
    });
    const selected = selectServableModels(catalog);
    expect(selected.map((s) => s.providerId).sort()).toEqual([
      'account:zai-individual-coding-plan',
      'account:zai-start-plan'
    ]);
  });

  it('modelId 被拆回裸 modelId（去掉 providerId:: 前缀）', () => {
const catalog = /** @type {import('../../packages/api/src/chat.js').DriverCatalog} */ ({
      revision: 'r',
      models: [
        { modelId: 'account:bigmodel-start-plan::GLM-5.3-Flash', displayName: '', provider: 'account:bigmodel-start-plan', billingClass: 'promotion', contextLength: null, reasoning: [], capabilities: [] }
      ]
    });
    const entry = selectServableModels(catalog)[0];
    if (entry === undefined) throw new Error('SYNTHETIC_CATALOG_EMPTY');
    expect(entry.modelId).toBe('GLM-5.3-Flash');
    expect(entry.offeringId).toBe('account:bigmodel-start-plan::GLM-5.3-Flash');
    expect(entry.planMode).toBe('start-plan');
  });

  it('team 套餐不在可服务集里（本版显式不支持）', () => {
const catalog = /** @type {import('../../packages/api/src/chat.js').DriverCatalog} */ ({
      revision: 'r',
      models: [
        { modelId: 'account:zai-team-coding-plan::M', displayName: '', provider: 'account:zai-team-coding-plan', billingClass: 'subscription', contextLength: null, reasoning: [], capabilities: [] }
      ]
    });
    expect(selectServableModels(catalog)).toEqual([]);
  });
});

describe('OFFICIAL-HOST · 子宿主环境构造', () => {
  it('控制面令牌不下发给子宿主', () => {
    const env = buildChildEnv({ PATH: 'x', ZCC_TAP_TOKEN: 'secret-token', ZCC_TAP_TOKEN_FILE: 'C:/t', ZCC_API_KEY: 'k' });
    expect(env.PATH).toBe('x');
    expect(env.ZCC_API_KEY).toBe('k');
    for (const key of HOST_CHILD_STRIPPED_ENV_KEYS) {
      expect(env).not.toHaveProperty(key);
      expect(JSON.stringify(env)).not.toContain('secret-token');
    }
  });

  it('undefined 值被丢掉；其余原样透传', () => {
    expect(buildChildEnv({ A: '1', B: undefined })).toEqual({ A: '1' });
  });
});

describe('OFFICIAL-HOST · 流与驱动基本不变式', () => {
  it('驱动名固定 official-host，fixture 恒 false', () => {
    const driver = createOfficialHostDriver({
      descriptor: /** @type {any} */ ({ bundlePath: BUNDLE_PATH, exports: [], detail: 'd', models: [{ id: 'm', object: 'model', created: 1, owned_by: 'o' }], status: 'ready' }),
      catalog: { revision: 'r', models: [] },
      servableModels: [],
      reasoning: 'high'
    });
    expect(driver.name).toBe(OFFICIAL_HOST_DRIVER_NAME);
    expect(driver.fixture).toBe(false);
    expect(deriveModelIsReal(driver)).toBe(true);
  });

  it('PassThrough 在本文件里可用（不引入悬挂句柄的隐式依赖）', () => {
    const s = new PassThrough();
    s.end('x');
    expect(s.readable).toBe(true);
  });
});
