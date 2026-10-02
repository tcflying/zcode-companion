/**
 * I10 凭据不泄漏不变式（横跨 `log-ring` / `app-protocol` / `settings` / `preload`）。
 *
 * 这条不变式是整个工单最不许退让的安全承诺：
 *
 *   > 明文 API key 只活在桌面主进程内存与 `userData/settings.json` 里。
 *   > 它不进渲染进程、不进任何 IPC 载荷、不进日志、不进转发响应。
 *
 * 本文件用一个**合成** key 走完整条链路，然后把每一处出口都翻一遍。
 * 为什么值得单独一个文件：前面三个文件各自钉住了自己那一段，但「每一段都合格」
 * 不等于「拼起来不漏」——跨模块的不变式必须有一个地方端到端地钉一次。
 *
 * 另外：这里对 `preload.cjs` 与 `main.cjs` 做**源码级**断言（不启动 Electron），
 * 因为「桥上暴露了什么」这件事的真相比「文件里写了什么注释」更值得钉。
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mustForward, mustValue } from '../helpers/desktop-harness.mjs';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { createLogRing, redactLine, REDACTED } = require('../../apps/desktop/lib/log-ring.cjs');
const { buildUpstreamRequest, buildResponseHeaders } = require('../../apps/desktop/lib/app-protocol.cjs');
const { defaultSettings, publicSettings, normalizeSettings, API_KEY_MASK } = require('../../apps/desktop/lib/settings.cjs');
const { buildChildEnv, createProxyManager } = require('../../apps/desktop/lib/proxy-manager.cjs');
const { buildSpawnSpec } = require('../../apps/desktop/lib/spawn-spec.cjs');
const { EventEmitter } = require('node:events');

const DESKTOP_DIR = resolve(import.meta.dirname, '..', '..', 'apps', 'desktop');
const MAIN_SRC = readFileSync(join(DESKTOP_DIR, 'main.cjs'), 'utf8');
const PRELOAD_SRC = readFileSync(join(DESKTOP_DIR, 'preload.cjs'), 'utf8');

/** 合成 key：不对应任何真实凭据，也不来自任何环境变量或文件。 */
const SYNTHETIC_KEY = 'zcc_leak_test_synthetic_key_000000000006';
const PORT = 8791;

/* -------------------------------------------------------------------------- */
/* 源码扫描器：本身先被测一遍                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 上面两条「源码级」断言原先是**永真**的：正则匹配 0 处，循环体一次都不执行。
 * 一条不执行任何断言的测试比没有测试更坏——它给人「这里守着」的错觉。
 * 因此把判定抽成纯函数，并**先测这个函数本身**：喂它一段已知违规的源码，
 * 它必须报出违规；再喂真实源码，它必须干净。两头都钉住，扫描器才可信。
 */

/**
 * 切出 `registerIpc()` 里每一个 `ipcMain.handle(...)` 的处理体。
 *
 * 切法：以 `ipcMain.handle(` 为界分块，每块再截到**行首的 `}`**（函数收尾那一行）。
 * `registerIpc` 的函数体是缩进的，所以行首 `}` 唯一且稳定。
 *
 * @param {string} src
 * @returns {Array<{ channel: string, body: string }>}
 */
function splitIpcHandlers(src) {
  const out = [];
  const parts = src.split('ipcMain.handle(');
  for (const part of parts.slice(1)) {
    const channel = /^\s*'([^']+)'/.exec(part)?.[1] ?? '<unparsed>';
    const end = part.indexOf('\n}');
    out.push({ channel, body: end === -1 ? part : part.slice(0, end) });
  }
  return out;
}

/**
 * 返回所有「把凭据或整个 settings 交给渲染进程」的出口。
 *
 * 判据分三类，覆盖箭头函数的**简写返回体**与块返回体两种形态——只认 `return` 关键字
 * 的话，`() => settings` 这种最朴素的漏法会整条绕过（这条自测就是在抓这个）。
 *
 * @param {string} src
 * @returns {string[]}
 */
function findIpcLeaks(src) {
  const findings = [];
  for (const { channel, body } of splitIpcHandlers(src)) {
    // 对象字面量里出现 `apiKey:` 字段 = 明文进了 IPC 载荷。
    if (/[{,]\s*apiKey\s*:/.test(body)) findings.push(`${channel}: 返回体带 apiKey 字段`);
    // `=> settings` / `return settings`：整个设置被当返回值交出去。
    if (/(?:=>|return)\s*\(?\s*settings\b(?![.\s])/.test(body)) findings.push(`${channel}: 直接返回裸 settings`);
    // `=> ({ settings, … })`：对象里塞进了整个 settings。
    if (/(?:=>|return)\s*\(?\s*\{[^}]*\bsettings\b\s*[,}]/.test(body)) findings.push(`${channel}: 返回体直接回传 settings`);
  }
  return findings;
}

/**
 * 返回所有「把设置/快照整块打进控制台」的出口。
 * @param {string} src
 * @returns {string[]}
 */
function findConsoleLeaks(src) {
  const findings = [];
  for (const line of src.split(/\r?\n/)) {
    if (!/console\.(log|error|warn|info|debug)\s*\(/.test(line)) continue;
    // 比原来宽得多：原来只认字面量 `apiKey`，`console.log(settings)` 这类整块
    // 打印能绕过去——而那恰恰是最常见的一种漏法。
    if (/\b(settings|snapshot|publicSettings|settingsFile|apiKey|seeded|loaded)\b/.test(line)) {
      findings.push(line.trim());
    }
  }
  return findings;
}

describe('不变式：明文 key 不出现在任何出口', () => {
  it('日志环形缓冲：注册过的 key、key=value 形态、Bearer 令牌全部替换', () => {
    const ring = createLogRing({ capacity: 20 });
    ring.addSecret(SYNTHETIC_KEY);
    ring.append('stdout', `listening with key=${SYNTHETIC_KEY}\n`, 1);
    ring.append('stderr', `Authorization: Bearer ${SYNTHETIC_KEY}\n`, 2);
    ring.append('stdout', 'apiKey: someOtherSecretValue123\n', 3);
    ring.append('stderr', 'token=abcdefgh12345678\n', 4);
    const dump = JSON.stringify(ring.tail(20));
    expect(dump).not.toContain(SYNTHETIC_KEY);
    expect(dump).not.toContain('someOtherSecretValue123');
    expect(dump).not.toContain('abcdefgh12345678');
    expect(dump).toContain(REDACTED);
  });

  it('未注册的短串不会被乱脱敏（脱敏不能把正常输出毁成不可读）', () => {
    expect(redactLine('event=listening port=8791', [])).toBe('event=listening port=8791');
  });

  it('注册动作本身不落日志：注册前后的 tail 都拿不到那把 key', () => {
    const ring = createLogRing({ capacity: 20 });
    ring.addSecret(SYNTHETIC_KEY);
    ring.addSecret(SYNTHETIC_KEY); // 重复注册也不该产生任何输出
    expect(JSON.stringify(ring.tail(20))).not.toContain(SYNTHETIC_KEY);
    expect(ring.size).toBe(0);
  });

  it('转发响应：响应头与正文都不含 key（上游从不回显 Authorization，我们也不加回）', () => {
    // 上游会把自己的请求头原样回显的那种最坏情况：过滤函数不许把它带回来。
    const echoed = new Headers({ authorization: `Bearer ${SYNTHETIC_KEY}`, 'x-echo': `Bearer ${SYNTHETIC_KEY}` });
    const filtered = buildResponseHeaders(echoed, [SYNTHETIC_KEY]);
    expect(JSON.stringify(filtered)).not.toContain(SYNTHETIC_KEY);
    expect(filtered['authorization']).toBeUndefined();
    // 第二道：名字不认识、但**值**里带 key 的头，也整个丢掉。
    expect(filtered['x-echo']).toBeUndefined();
  });

  it('转发响应：不传机密表时，authorization 仍然按名字丢掉', () => {
    const filtered = buildResponseHeaders(new Headers({ authorization: 'Bearer whatever-token' }));
    expect(filtered['authorization']).toBeUndefined();
  });

  it('转发请求：注入的 key 落在请求侧，不出现在任何会被回显的位置', () => {
    const built = mustForward(
      buildUpstreamRequest('/v1/chat/completions', {
        port: PORT,
        apiKey: SYNTHETIC_KEY,
        method: 'POST',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: '{"model":"x"}'
      })
    );
    const headers = /** @type {Record<string, string>} */ (built.init['headers']);
    expect(headers['authorization']).toBe(`Bearer ${SYNTHETIC_KEY}`);
    // 凭据不进 query：URL 会被日志、Referer、代理历史记录下来。
    expect(built.url).not.toContain(SYNTHETIC_KEY);
    expect(built.url).toBe(`http://127.0.0.1:${PORT}/v1/chat/completions`);
  });

  it('子进程 spawn 规格：key 只在 env，绝不进 argv（断言的是**真实产物**）', () => {
    // 这里断言的是产品代码真的交给 spawn 的那份规格，不再是测试自己手写的字面量——
    // 旧写法对一份与产品无关的数组断言，把 argv 改成 `--api-key <key>` 测试照样绿。
    const spec = buildSpawnSpec({
      runtime: { apiEntry: '/repo/packages/api/bin/start-api.mjs', runtimeRoot: '/repo' },
      settings: { apiKey: SYNTHETIC_KEY, apiPort: PORT, driver: 'official-host', reasoning: 'low' },
      node: { command: '/electron/exe', extra: { ELECTRON_RUN_AS_NODE: '1' } },
      parentEnv: {},
      shutdownGraceMs: 5000
    });
    // key 只能出现在 env 里。
    expect(spec.env['ZCC_API_KEY']).toBe(SYNTHETIC_KEY);
    // argv / command / cwd 三处都不许有 key：命令行参数对本机所有进程可见。
    expect(spec.args.join(' ')).not.toContain(SYNTHETIC_KEY);
    expect(spec.command).not.toContain(SYNTHETIC_KEY);
    expect(spec.cwd).not.toContain(SYNTHETIC_KEY);
    expect(spec.env['ELECTRON_RUN_AS_NODE']).toBe('1');
    // 「不弹独立 cmd 窗口」是产品承诺，逐字钉住。
    expect(spec.windowsHide).toBe(true);
    expect(spec.shell).toBe(false);
  });

  it('spawn 规格的 env 闭集：未知 ZCC_* 键进不去（start-api.mjs 对它 422 拒启动）', () => {
    const env = buildChildEnv({
      apiKey: SYNTHETIC_KEY,
      apiPort: PORT,
      reasoning: 'low',
      // 父进程里就算有别的 ZCC_* 键也不许顺流下去。
      parentEnv: { ZCC_SOME_UNKNOWN: 'boom', ZCC_API_KEY: 'parent-value' }
    });
    expect(env['ZCC_SOME_UNKNOWN']).toBeUndefined();
    expect(env['ZCC_API_KEY']).toBe(SYNTHETIC_KEY);
  });

  it('IPC 载荷：快照 / 日志尾 / 设置三样都不含 key', () => {
    const ring = createLogRing({ capacity: 20 });
    ring.addSecret(SYNTHETIC_KEY);
    const manager = createProxyManager({
      spawnChild: () => /** @type {any} */ (new EventEmitter()),
      probeApi: async () => false,
      logRing: ring,
      pollIntervalMs: 5,
      startTimeoutMs: 50
    });
    manager.configure({
      port: PORT,
      spawnSpec: { command: 'node', args: [], env: {}, cwd: '/x', windowsHide: true, shell: false }
    });
    const settings = { ...defaultSettings(), apiKey: SYNTHETIC_KEY, apiPort: PORT };
    const payloads = {
      state: manager.getSnapshot(),
      log: ring.tail(200),
      settings: publicSettings(settings),
      settingsGet: { settings: publicSettings(settings), settingsFile: '/tmp/settings.json', seededFrom: null, seedProblem: null, loadProblems: [] }
    };
    const dump = JSON.stringify(payloads);
    expect(dump).not.toContain(SYNTHETIC_KEY);
    expect(dump).not.toContain(SYNTHETIC_KEY.slice(0, 16));
  });

  it('保存设置的返回值同样只是掩码 + 指纹', () => {
    const normalized = mustValue(normalizeSettings({ apiKey: SYNTHETIC_KEY, apiPort: PORT, driver: 'none', reasoning: 'low' }, ''));
    const ack = { ok: true, settings: publicSettings(normalized.value) };
    expect(JSON.stringify(ack)).not.toContain(SYNTHETIC_KEY);
  });
});

describe('不变式：桥面上根本没有 key 这条路', () => {
  it('preload 暴露的方法里没有任何一个返回明文 key 的入口', () => {
    const exposed = PRELOAD_SRC.slice(PRELOAD_SRC.indexOf('const bridge = {'));
    expect(exposed).toContain('getSettings');
    // 桥面上不存在把设置原样回传给渲染进程的方法。
    expect(exposed).not.toMatch(/rawSettings|getApiKey|revealKey|exportKey/);
  });

  it('preload 仍然不暴露 ipcRenderer / require / fs', () => {
    const exposed = PRELOAD_SRC.slice(PRELOAD_SRC.indexOf('exposeInMainWorld'));
    expect(exposed).not.toMatch(/exposeInMainWorld\(\s*['"][^'"]+['"]\s*,\s*ipcRenderer\s*\)/);
    expect(exposed).not.toMatch(/exposeInMainWorld\(\s*['"][^'"]+['"]\s*,\s*require/);
    expect(exposed).not.toMatch(/exposeInMainWorld\(\s*['"][^'"]+['"]\s*,\s*process\b/);
  });

  it('扫描器自测①：已知违规的 IPC 返回体必须被报出来（否则下面的守卫是空转的）', () => {
    const bad = [
      "function r(){ ipcMain.handle('a:leak', () => ({ apiKey: settings.apiKey }));",
      "function r(){ ipcMain.handle('b:raw', () => settings);",
      "function r(){ ipcMain.handle('c:wrap', () => ({ settings, ok: true }));",
      '\n}'
    ].join('\n');
    expect(findIpcLeaks(bad).length).toBe(3);
    // 合法的出口不得被误报。
    const good = "function r(){ ipcMain.handle('d:ok', () => ({ settings: publicSettings(settings) }));\n}";
    expect(findIpcLeaks(good)).toEqual([]);
  });

  it('主进程里没有任何把 settings / apiKey 丢给渲染进程的 IPC 出口', () => {
    const findings = findIpcLeaks(MAIN_SRC);
    expect(findings, `IPC 泄漏：${findings.join(' | ')}`).toEqual([]);
    // 闭集：新增一个 handler 必须同时登记到这里，否则上面的扫描之外还要过人眼。
    expect(splitIpcHandlers(MAIN_SRC).map((h) => h.channel).sort()).toEqual([
      'zcc:desktop:log',
      'zcc:desktop:restart',
      'zcc:desktop:settings:get',
      'zcc:desktop:settings:save',
      'zcc:desktop:start',
      'zcc:desktop:state',
      'zcc:desktop:stop'
    ]);
    // 明确点名：唯一的出口是 publicSettings。
    expect(MAIN_SRC).toContain('publicSettings(settings)');
  });

  it('扫描器自测②：整块打印 settings 这类漏法必须被抓住', () => {
    // 旧断言只匹配字面量 `apiKey`，这三行全部能绕过去。
    const bad = ['console.log(settings);', 'console.error(snapshot);', 'console.log(JSON.stringify(settings))'].join('\n');
    expect(findConsoleLeaks(bad).length).toBe(3);
    // 正常日志不得被误报。
    expect(findConsoleLeaks("console.log('[verify] OK');\nconsole.error(`[startup] ${problem}`);")).toEqual([]);
  });

  it('主进程源码里不出现把 key / 设置整块写进 console 的形态', () => {
    const findings = findConsoleLeaks(MAIN_SRC);
    expect(findings, `疑似把凭据/设置打进控制台：${findings.join(' | ')}`).toEqual([]);
  });

  it('publicSettings 的返回值里连 apiKey 这个键都不存在（类型层就堵死）', () => {
    const pub = publicSettings({ ...defaultSettings(), apiKey: SYNTHETIC_KEY, apiPort: PORT });
    expect(Object.keys(pub)).not.toContain('apiKey');
    expect(Object.keys(pub)).toContain('apiKeyMasked');
    expect(pub['apiKeyMasked']).toBe(API_KEY_MASK);
  });

  it('掩码回提交 = 不改 key（否则一次无意的保存就把真 key 顶掉了）', () => {
    const current = `${SYNTHETIC_KEY}`;
    const normalized = mustValue(
      normalizeSettings({ apiKey: API_KEY_MASK, apiPort: PORT, driver: 'none', reasoning: 'low' }, current)
    );
    expect(normalized.value.apiKey).toBe(current);
    // 空串同样是「不改」。
    expect(mustValue(normalizeSettings({ apiKey: '', apiPort: PORT, driver: 'none', reasoning: 'low' }, current)).value.apiKey).toBe(
      current
    );
    // 提交一个**真正的**新串时必须换成新的。
    const rotated = 'zcc_brand_new_key_0000000000000000ab';
    expect(mustValue(normalizeSettings({ apiKey: rotated, apiPort: PORT, driver: 'none', reasoning: 'low' }, current)).value.apiKey).toBe(
      rotated
    );
  });

  it('smoke 形态不读任何真实凭据', () => {
    expect(MAIN_SRC).toContain("RUN_MODE === 'smoke'");
    // smoke 分支明确把 key 清空，而不是「读到就用」。
    expect(MAIN_SRC).toMatch(/'smoke'\s*\?\s*\{[^}]*apiKey: ''/);
  });
});
