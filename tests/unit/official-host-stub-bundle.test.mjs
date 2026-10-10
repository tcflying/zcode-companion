/**
 * OFFICIAL-HOST · 替身 app-server 集成测试（**真实 spawn 路径**）。
 *
 * ## 这份文件存在的唯一理由
 *
 * `scripts/official-host/session-drive.mjs` 的**流接线**（请求写 `input`、应答读
 * `output`）接反过一次，那是一个 100% 失败的真 bug：官方传输层 `fTt` 把 `handleMessage`
 * 挂在 `input` 上、把应答写到 `output`，而驱动当时恰好相反。
 *
 * **静态单测抓不到它**，纯函数单测在**原理上**也抓不到——那些路径根本不碰流。
 * 只有让一个**同形替身**经真实 spawn 路径被拉起、并让它同时观测**两个方向**，才能把
 * "接反"变成一条 CI 恒红的断言。
 *
 * ## HOSTFIX5：替身从"被 require 的模块"变成"被 spawn 的进程"
 *
 * 上一版替身伪装的是一个**被 `createRequire` 加载的 CommonJS 模块**（导出
 * `createZCodeApp` / `startProcessProviderRegistryRuntime` / `runZCodeProtocolAgent`）。
 * **实弹首战（2026-10-01 09:34）证明这条路不存在**：官方 `zcode.cjs` 没有任何具名导出，
 * `BUNDLE_EXPORTS_INCOMPLETE` 是必然失败。现在替身与生产路径**同形态**：
 * `node <this> app-server --stdio --surface desktop`，从 **stdin** 读请求、往 **stdout** 写应答。
 *
 * **B1 接反防护在 stdio 形态下的等价表达**（**这里有一条设计错误被更正，如实记在下面**）：
 * 旧形态（内存 `PassThrough`）下"接反"能被替身**从自己那条应答流上看到**——因为那是双向
 * 流对象，别人往它写，本进程就收得到 `data`。**stdio 形态下做不到**：替身的 stdout 是
 * **只写**的管道，别人往这条管道写，字节流向 host-child，替身自己收不到。所以
 * `readFromOutput`（及其改名 `readFromStdout`）在 stdio 形态下是一条**恒真的空断言**，
 * 已**整条删除**（留着一个恒真的断言比没有断言更糟）。
 *
 * **接反在 stdio 形态下真正可观测的形状**是：
 * > 请求写进子进程 stdout、应答从子进程 stdin 读 ⟹ **替身的 stdin 一个字节都收不到**。
 * 也就是说接反**退化成"子进程什么都没收到"**。现在钉住的就是这一条：
 * `readFromStdin` 非空 + `parsedMethodsFromStdin` 的完整有序方法序列 + 会话真的收束。
 * 已用变异体实测（把 `input`/`output` 对调）：该用例**立刻红**。
 *
 * 因此本文件用 `tests/fixtures/official-host-stub-bundle.cjs`：
 *  - **零真实 bundle 启动**（替身不 require 任何官方代码，只被 spawn）
 *  - **零模型请求**（替身只吐预设 NDJSON）
 *  - **零真实凭据仓读取**（`ZCODE_DATA_BASE_DIR` 指向 `%TEMP%` 下的合成目录，
 *    凭据文件是沙箱里那份**自己加密自己解**的合成信封）
 *  - **不修改 `C:\ZCode`**（全程只读它做静态核对，测试里不碰）
 *
 * 覆盖的硬事实：
 *  1. **B1 方向**：`session/create` 真的进了 stub 的 **input** 流；
 *     stub 的 **output** 流真的被驱动读到（回读成功、拿到 sessionId）。
 *  2. **B1 反向断言**：`readFromOutput` 为空——若有人把请求改写回 `output`，这条立刻红。
 *  3. **B3 注入面**：账号快照经 `provider/updateAccountConfig` 这**一帧**流到 stub，
 *     形状逐字对齐官方 `CGt`（`revision` / `basedOnZCodeBuiltinRevision` / `providers` / `states`），
 *     且 `providers[id].access.entitled` 为真时 `states[id].current` 必填布尔（官方 `FHo` 的硬要求）。
 *  4. **B3 反向断言**：`startProcessProviderRegistryRuntime` 与 `createZCodeApp` 的
 *     options **不含**任何账号快照键（官方逐字不读它们），且 `runZCodeProtocolAgent`
 *     **不再**收到被官方忽略的 `app` / `providerRegistry`。
 *  5. **B2 存储隔离**：真实 spawn 出的子宿主 env 里，`ZCODE_STORAGE_DIR` /
 *     `ZCODE_SESSION_DB_PATH` 指向 companion 专属目录，**不含** `ZCODE_DATA_BASE_DIR`
 *     （设了它会把真实凭据仓一起搬走）。
 *  6. **B4 回收**：会话正常收束后子进程真的退出了（`exitCode !== null`），不留孤儿。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CREDENTIAL_SECRET_ENV_KEY,
  ENVELOPE_IV_BYTES,
  ENVELOPE_PREFIX,
  START_PLAN_ENTRY_KEY
} from '../../packages/official-host/src/credentials.js';
import {
  buildIsolatedChildEnv,
  createOfficialHostDriver,
  resolveHostChildScript,
  resolveHostWorkspaceRoot,
  runHostSession,
  sanitizeChildDetail,
  selectServableModels
} from '../../packages/official-host/src/host-driver.js';
// HOSTFIX4：`ZCC_HOST_DEBUG` 这个开关的字面量从**生产代码**里取，测试不硬写一份。
import { HOST_DEBUG_ENV_KEY } from '../../scripts/official-host/session-drive.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const STUB_BUNDLE = resolvePath(HERE, '..', 'fixtures', 'official-host-stub-bundle.cjs');

/* -------------------------------------------------------------------------- */
/* 合成凭据（HOSTFIX3：让"我们的 port 真的被调用"可被观测）                    */
/* -------------------------------------------------------------------------- */

/**
 * 测试私钥。**不是**任何真实 secret，也只在本文件内。
 * 它会经 `ZCODE_CREDENTIAL_SECRET` 下发给子宿主，由官方形状的
 * `deriveCredentialSecret`（`sha256(secret)`）派生出 32 字节密钥。
 */
const STUB_CREDENTIAL_SECRET = 'zcc-stub-bundle-synthetic-secret-not-a-real-credential';
const STUB_CREDENTIAL_KEY = createHash('sha256').update(STUB_CREDENTIAL_SECRET, 'utf8').digest();

/**
 * 合成明文。它会**明文进过**官方应答帧（`requestAuth.apiKey`），
 * 所以下面每条端到端断言都额外断言"观测文件里搜不到它"——
 * 替身的记录通道在落盘前把它换成了占位符。
 */
const STUB_CREDENTIAL_PLAINTEXT = 'zcc-stub-synthetic-jwt-do-not-use-anywhere';

/**
 * 造一个合成信封 `enc:v1:<iv>.<tag>.<ct>`（自己加密，形状对齐官方 `ZZr.encrypt`）。
 * @param {string} plaintext
 * @returns {string}
 */
function stubEnvelope(plaintext) {
  const iv = randomBytes(ENVELOPE_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', STUB_CREDENTIAL_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${ENVELOPE_PREFIX}${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

/**
 * 往沙箱里写一份**合成**凭据仓。
 *
 * 路径逐字对应官方 `resolveSharedZCodeCredentialsPath`（`n$s`，偏移 4298550）：
 * `join(e.baseDir ?? t.ZCODE_DATA_BASE_DIR ?? homedir(), ".zcode","v2","credentials.json")`。
 * 本测试把 `ZCODE_DATA_BASE_DIR` 强制指向沙箱，所以它落在
 * `<sandbox>/.zcode/v2/credentials.json` —— **零真实凭据仓读取**。
 *
 * @param {string} dataRoot
 */
function writeSyntheticCredentialStore(dataRoot) {
  const v2 = join(dataRoot, '.zcode', 'v2');
  mkdirSync(v2, { recursive: true });
  writeFileSync(
    join(v2, 'credentials.json'),
    JSON.stringify({ [START_PLAN_ENTRY_KEY]: stubEnvelope(STUB_CREDENTIAL_PLAINTEXT) }),
    'utf8'
  );
}

/** 一次测试的临时沙箱（观测文件 + 合成数据根）。 */
let sandbox = '';
/** 观测文件路径。 */
let observationFile = '';
/** @type {any} stub 观测到的整体内容（替身写出来的 JSON 观测文件）。 */
let observed = null;

/** 读观测文件。替身是异步写的，所以轮询到它出现或超时。 */
function readObservation() {
  if (!existsSync(observationFile)) return null;
  try {
    return JSON.parse(readFileSync(observationFile, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 等观测文件落盘并达到**期望状态**。
 *
 * **不能只等"文件存在"或"读到过东西"**：替身每收到一帧就重写整个观测文件，而驱动
 * 是流式推进的——`session/close` 往往在 `waitForObservation` 返回**之后**才被记录。
 * 那会让断言依赖调度顺序（实测会偶发红）。所以这里等的是"要断言的那件事真的发生了"。
 *
 * @param {(value: any) => boolean} ready 谓词
 * @param {number} ms 上限
 * @returns {Promise<any>}
 */
async function waitForObservation(ready, ms = 8000, isOver = () => false) {
  const deadline = Date.now() + ms;
  let last = null;
  for (;;) {
    last = readObservation();
    if (last !== null && ready(last)) return last;
    // **会话已经彻底结束**（子宿主以失败告终）时不再空等：那种情况下子进程不会再写任何
    // 观测，再等 8 s 只会把一条本该**立刻红**的断言拖成**超时红**。
    // 这不是放宽：返回的仍是最后一次真实读到的观测，断言照样会红。
    if (isOver()) return last;
    if (Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** 谓词：至少读到过 input 上的东西（描述握手完成）。 */
const sawInput = (/** @type {any} */ v) => Array.isArray(v.readFromStdin) && v.readFromStdin.length > 0;

/** 谓词：input 上已经出现过某个 method。 */
const sawMethod = (/** @type {string} */ method) => (/** @type {any} */ v) =>
  Array.isArray(v.parsedMethodsFromStdin) && v.parsedMethodsFromStdin.includes(method);

/**
 * 从观测里取出解析过的全部帧。
 * @param {readonly string[]} lines
 * @returns {any[]}
 */
function framesOf(lines) {
  return lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((v) => v !== null);
}

/* -------------------------------------------------------------------------- */
/* HOSTFIX7：实弹逐字的事件流断言                                              */
/* -------------------------------------------------------------------------- */

/**
 * 实弹正文逐字（56 字符）。
 *
 * 出处：官方隔离存储目录 `%TEMP%\zcode-companion-hostfix6-20261001` 下
 * app-server 自己的 SQLite `part` 表 `data` 列。与官方日志
 * `model.sdk.stream.completed` 的 `textDeltaChars = 56` 逐字相符。
 */
const REAL_SHOT_RESPONSE_TEXT =
  '主上，我是 ZCode，一个交互式编程助手，可以读写文件、执行命令、搜索代码与联网调研，帮助您完成软件工程任务。';

/** 实弹增量段数（官方逐字 `chunkCounts.textDelta = 33`）。 */
const REAL_SHOT_DELTA_CHUNKS = 33;

/**
 * 实弹 usage 事件逐字。
 *
 * `inputTokens` / `outputTokens` 取自官方 `model_usage.raw_usage_json`
 * （`query_source = "main_turn"`，`finish_reason = "stop"`）。
 * `usageMethod` 是**我们自己的**闭集短码（官方字段名不是这个——它是我们标口径的方式）。
 */
const REAL_SHOT_USAGE_EVENT = Object.freeze({
  type: 'usage',
  promptTokens: 27285,
  completionTokens: 35,
  usageMethod: 'official_turn_complete_usage'
});

/**
 * 断言一条**实弹逐字形状**的 DriverEvent 流：`ready` → 33 段 `delta` → `usage` → `finish`。
 *
 * 这条断言是 HOSTFIX7 的核心锁：它同时钉住
 *  - 正文**逐字**到达（33 段拼起来逐字等于实弹正文，不是"有个 delta 就算过"）；
 *  - usage **数字正确**（不是 `null`，也不是编出来的）；
 *  - `finish` 在**最后**（流终止）。
 *
 * @param {readonly { type: string }[]} events
 */
function expectRealShotStream(events) {
  const types = events.map((e) => e.type);
  expect(types[0]).toBe('ready');
  expect(types.slice(1, 1 + REAL_SHOT_DELTA_CHUNKS)).toEqual(Array(REAL_SHOT_DELTA_CHUNKS).fill('delta'));
  expect(types.slice(1 + REAL_SHOT_DELTA_CHUNKS)).toEqual(['usage', 'finish']);
  // **正文逐字**：逐段拼起来逐字等于实弹正文。段数也钉死（官方那轮就是 33 段）。
  const body = events
    .filter((e) => e.type === 'delta')
    .map((e) => /** @type {{ text?: string }} */ (/** @type {unknown} */ (e)).text ?? '')
    .join('');
  expect(body).toBe(REAL_SHOT_RESPONSE_TEXT);
  // **usage 数字逐字**。
  expect(events.find((e) => e.type === 'usage')).toEqual(REAL_SHOT_USAGE_EVENT);
  // **finish 后流终止**：最后一条就是 `finish`，其后什么都没有。
  expect(events[events.length - 1]).toEqual({ type: 'finish', reason: 'stop' });
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'zcc-stub-'));
  observationFile = join(sandbox, 'observation.json');
  observed = null;
});

afterEach(() => {
  if (sandbox === '') return;
  // 子进程可能刚好还在收尾（Windows 上文件句柄会短暂占住目录）。**重试到确实删掉为止**。
  //
  // **刻意不在重试耗尽后静默吞掉**：上一版这里 5 次重试之后就 `return` 了，于是
  // `%TEMP%\zcc-stub-*` 会在 Windows 文件句柄竞争下持续堆积，而"临时物已清"这句话
  // **在设计上就不可能成立**（复审 §9 实测 4 个残留目录）。现在删不掉就**抛**——
  // 让清理失败可见，而不是留一个谁也不会看的残留。
  let lastError = null;
  for (let i = 0; i < 20; i += 1) {
    try {
      rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      if (!existsSync(sandbox)) return;
      lastError = new Error('rmSync 报告成功但目录仍在');
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(
    `CLEANUP_FAILED: 沙箱 ${sandbox} 删不掉（重试 20 次，约 2 s）：${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
});

/**
 * 剥掉块注释与行注释。**静态扫描必须先剥注释**（纪律同
 * `tests/contract/official-host-contract.test.mjs` 的 `code()`）：源码里那些
 * "我们不再做 X"的纪律说明里**逐字写着** X 的名字，不剥就会把它们当成违规。
 *
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * 一条合法的 `op:'run'` 请求帧。`workspacePath` 用沙箱，绝不是 `process.cwd()`。
 * @param {string} workspacePath
 * @param {Record<string, unknown>} [extra] 额外字段（如 `zcodeBuiltinRevision`）
 * @returns {import('../../packages/official-host/src/host-driver.js').HostChannelRequest}
 */
function runRequest(workspacePath, extra = {}) {
  return {
    op: 'run',
    workspacePath,
    providerId: 'account:zai-start-plan',
    modelId: 'GLM-5.3-Flash',
    planMode: 'start-plan',
    entitled: true,
    thoughtLevel: 'high',
    prompt: '合成提示词，不触网',
    maxTokens: null,
    operationId: 'op-stub-1',
    ...extra
  };
}

/**
 * 经**真实 spawn 路径**跑一次会话。返回事件流与子进程终态。
 *
 * **B2 的 env 观测走的是生产函数本身**：子宿主 env 由 `buildIsolatedChildEnv` 构造
 * （`defaultSpawnHostChild` 内部调的就是它），本测试在它之上只**额外**加观测文件键
 * `ZCC_STUB_OBSERVATION_FILE`。三个存储重定向键由生产代码决定，不由测试代劳——
 * 否则"生产 env 是否被隔离"就成了自证。
 *
 * `envOverrides` 改的是**本测试进程**的 env，因此 `buildIsolatedChildEnv` 会真的读到它
 * （它就是从 `process.env` 起步的），这让 `ZCC_HOST_STORAGE_DIR` 覆盖这条路径也被覆盖到。
 *
 * **缺省强制 `ZCODE_DATA_BASE_DIR` 指向沙箱**：这样 `deriveEntitledSnapshot` 读的是
 * 沙箱里那份合成缓存，而**不是**本机真实的 `~/.zcode/v2/coding-plan-cache.json`。
 * 纪律要求零真实凭据仓读取，而"读到本机真缓存"会让断言随机器状态漂移
 * （本机真缓存说 available，于是 entitled=true，与断言里的 false 打架）。
 * 需要断言 entitled=true 时，测试自己往沙箱里写一份 `status:"available"` 的合成缓存。
 *
 * **合成凭据仓（HOSTFIX3）**：替身现在在 `session/send` 之后**先**发一条
 * `interaction/requestProviderRuntimeHeaders`，只有收到合格应答才放行 turn 事件。
 * 所以缺了合成凭据，整条端到端路径就**拿不到** delta/usage/finish —— 换句话说，
 * 这不是"为了测试而加的道具"，它就是 HOSTFIX3 收口判据本身。
 * 合成 secret 经 `ZCODE_CREDENTIAL_SECRET` 下发（`buildChildEnv` 只剔除
 * `HOST_CHILD_STRIPPED_ENV_KEYS` 与存储重定向键，这个键不在其中）。
 *
 * @param {import('../../packages/official-host/src/host-driver.js').HostChannelRequest} request
 * @param {Record<string, string | undefined>} envOverrides 覆盖本测试进程的 env
 * @param {number} timeoutMs 超时
 * @param {(value: any) => boolean} [ready] 观测就绪谓词
 * @param {boolean} [withSyntheticCredential] 是否往数据根写合成凭据仓（缺省写）
 */
async function spawnThroughRealChild(
  request,
  envOverrides = {},
  timeoutMs = 12000,
  ready = sawInput,
  withSyntheticCredential = true
) {
  /** @type {any[]} */
  const events = [];
  /** @type {Array<[string, string | undefined]>} */
  const saved = [];
  // 合成数据根优先（调用方可以显式覆盖它来证明注入得进去）。
  /** @type {Record<string, string | undefined>} */
  const merged = { ZCODE_DATA_BASE_DIR: sandbox, ...envOverrides };
  const dataRoot = merged['ZCODE_DATA_BASE_DIR'] ?? sandbox;
  if (withSyntheticCredential && typeof dataRoot === 'string') writeSyntheticCredentialStore(dataRoot);
  merged[CREDENTIAL_SECRET_ENV_KEY] = STUB_CREDENTIAL_SECRET;
  for (const [k, v] of Object.entries(merged)) {
    saved.push([k, process.env[k]]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  /**
   * 子宿主 stderr 的**逐字内容**（HOSTFIX4 的 `ZCC_HOST_DEBUG` 诊断行就在这里）。
   *
   * 生产 `host-driver.ts` 对 stderr 只做 `stderrBytes += chunk.length` 的计数，
   * **从不**把内容读进变量。**只有这份测试**读它——这正是"生产面没变"的证明：
   * 能读到内容是因为测试自己挂了 `data` 监听器，而不是生产代码放行的。
   *
   * @type {string[]}
   */
  const stderrChunks = [];
  const run = runHostSession(request, (e) => events.push(e), {
    bundlePath: STUB_BUNDLE,
    timeoutMs,
    spawnChild: (args) => {
      const [script, ...rest] = args;
      if (script === undefined) throw new Error('SYNTHETIC_ARGS_EMPTY');
      // 生产 env 构造 + 唯一一个测试专用键。
      const env = buildIsolatedChildEnv(process.env);
      env['ZCC_STUB_OBSERVATION_FILE'] = observationFile;
      const child = spawn(process.execPath, [script, ...rest], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk) => {
        stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      });
      return child;
    }
  });
  let childError = null;
  try {
    await run;
  } catch (e) {
    childError = e;
  }
  observed = await waitForObservation(ready, 8000, () => childError !== null);
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return { events, childError, stderr: stderrChunks.join(''), stderrChunks };
}

/**
 * 等子宿主 stderr 到达某个状态。
 *
 * **必须等**：`runHostSession` 在子进程的 `exit` 事件上 resolve，而 stderr 的 `data`
 * 事件是**另一条流**——它可能在 `exit` 之后才被父进程的事件循环派发。
 * 不等就会偶发读到空串（实测过一次）。
 *
 * @param {string[]} chunks
 * @param {(text: string) => boolean} ready
 * @param {number} ms 上限
 * @returns {Promise<string>}
 */
async function waitForStderrText(chunks, ready, ms = 2000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const text = chunks.join('');
    if (ready(text)) return text;
    if (Date.now() > deadline) return text;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * **无条件**等一段固定时长再读 stderr。
 *
 * 断言"**没有**某段输出"时**必须**用它，不能用 {@link waitForStderrText} 配一个
 * 恒真的谓词——那样第一轮循环就返回，读到的是"还没派发"的空串，
 * 断言恒真、**什么也证明不了**（实测：把生产里的开关改成永远开，这条断言照样绿）。
 *
 * @param {string[]} chunks
 * @param {number} ms 沉降时长
 * @returns {Promise<string>}
 */
async function settleStderr(chunks, ms = 400) {
  await new Promise((r) => setTimeout(r, ms));
  return chunks.join('');
}

describe('OFFICIAL-HOST · B1 流方向（替身 bundle 实跑，真实 spawn 路径）', () => {
  it('`session/create` 进了 stub 的 **input** 流，**output** 流的应答被回读成功', async () => {
    const workspace = join(sandbox, 'workspace');
    const { events, childError } = await spawnThroughRealChild(
      runRequest(workspace, { zcodeBuiltinRevision: 'zcode-builtin:5:synthetic' }),
      {},
      12000,
      // 等 `session/close` 真的进了 input 才断言 —— 不依赖调度顺序。
      sawMethod('session/close')
    );

    // 观测文件必须落盘——替身真的被加载并跑过。
    expect(observed).not.toBeNull();
    // **B1 核心断言**：请求帧进了 input。
    const inputFrames = framesOf(observed.readFromStdin);
    const createFrame = inputFrames.find((f) => f.method === 'session/create');
    expect(createFrame).toBeDefined();
    expect(observed.parsedMethodsFromStdin).toContain('session/create');
    // 官方请求 schema 是 `.strict()`，顶层只有 {id, method, params, trace}。
    expect(Object.keys(createFrame).sort()).toEqual(['id', 'method', 'params']);
    // workspace 落点是我们给的沙箱，**不是** `process.cwd()`（B2）。
    expect(createFrame.params.workspace.workspacePath).toBe(workspace);
    expect(createFrame.params.workspace.workspaceKey).toBe(workspace);
    // model / thoughtLevel 的位置逐字对齐官方 schema。
    // **HOSTFIX6：`options.reasoningLevel` 必填**（实弹逐字
    // `ModelProtocolError: Reasoning level is required for account:zai-start-plan/GLM-5.3-Flash`）。
    // 官方 `Pu` 逐字 `{providerId, modelId, options:{reasoningLevel}.strict().optional()}.strict()`，
    // 官方 `bpe` 逐字 `options?.reasoningLevel === undefined ⟹ reasoning-level-missing`。
    expect(createFrame.params.model).toEqual({
      providerId: 'account:zai-start-plan',
      modelId: 'GLM-5.3-Flash',
      options: { reasoningLevel: 'high' }
    });
    expect(createFrame.params.thoughtLevel).toBe('high');

    // **B1 反向断言（HOSTFIX5 更正后的等价面）**：请求**没有**出现在替身的 stdout 上。
    // 见文件头——stdio 形态下替身**看不到**别人往它 stdout 写的东西，所以这条只能改成
    // "接反的**后果**必须在替身这侧看得见"：**一个字节都没进 stdin**。
    expect(observed.readFromStdin.length).toBeGreaterThan(0);

    // **回读成功**：会话没失败，且拿到了官方回报的 sessionId（走到了 session/send）。
    expect(childError).toBeNull();
    expect(observed.didReceiveSessionCreate).toBe(true);
    const sentFrame = inputFrames.find((f) => f.method === 'session/send');
    expect(sentFrame).toBeDefined();
    expect(sentFrame.params.sessionId).toBe('stub-session-0001');
    expect(sentFrame.params.content).toBe('合成提示词，不触网');

    // 驱动产出的事件流如实映射（增量 + usage + finish）。
    // **实弹逐字**：33 段正文增量拼起来逐字等于实弹正文，usage 数字逐字，finish 收尾。
    expectRealShotStream(events);
  });

  it('`session/close` 也走 input 流（收尾帧方向一致）', async () => {
    await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace'), { zcodeBuiltinRevision: 'zcode-builtin:7:synthetic' }),
      {},
      12000,
      // 显式等 `session/close` 真的进了 input —— 不依赖调度顺序。
      sawMethod('session/close')
    );
    const methods = observed.parsedMethodsFromStdin;
    expect(methods).toContain('session/close');
    // 顺序：账号配置 → 创建 → 发送 → 关闭。
    expect(methods.indexOf('provider/updateAccountConfig')).toBeLessThan(methods.indexOf('session/create'));
    expect(methods.indexOf('session/create')).toBeLessThan(methods.indexOf('session/send'));
    expect(methods.indexOf('session/send')).toBeLessThan(methods.indexOf('session/close'));
  });
});

describe('OFFICIAL-HOST · B3 账号/entitled 的真实注入面', () => {
  it('知道 builtin revision 时，快照经 `provider/updateAccountConfig` 流到 stub，形状对齐官方 CGt', async () => {
    const { childError } = await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace'), { zcodeBuiltinRevision: 'zcode-builtin:4242:synthetic-hash' }),
      {},
      12000,
      sawMethod('provider/updateAccountConfig')
    );
    expect(childError).toBeNull();

    const inputFrames = framesOf(observed.readFromStdin);
    const acct = inputFrames.find((f) => f.method === 'provider/updateAccountConfig');
    // **真实注入面**：官方 `va.providerUpdateAccountConfig`（枚举偏移 785128，
    // 字面量 `provider/updateAccountConfig`）→ `XZo`（偏移 14548296）。
    expect(acct).toBeDefined();

    const params = acct.params;
    // 官方 `CGt`（偏移 766126）四个必填键，全部是字符串/记录，**没有 null**。
    expect(Object.keys(params).sort()).toEqual(['basedOnZCodeBuiltinRevision', 'providers', 'revision', 'states']);
    expect(typeof params.revision).toBe('string');
    expect(params.revision.length).toBeGreaterThan(0);
    expect(params.basedOnZCodeBuiltinRevision).toBe('zcode-builtin:4242:synthetic-hash');

    // `providers[id].access` 逐字对齐官方**账号快照通道**上真正生效的那张表。
    //
    // **HOSTFIX6 更正**：这一条原来断言的是 `sAe`（偏移 534982，
    // `{type, accountType, mode, entitled}`），**那张表不是这条通道用的**。
    // 实弹（2026-10-01，官方逐字回执）证明官方 `Qtr` = `parseAccountProviderConfigMap`
    // 逐字 `m.record(m.string().min(1), s3i).parse(e)`，而
    // `s3i = kz.pick({builtinModelIds:!0}).extend({access: fWt.pick({type:!0, entitled:!0}).nullable().optional()})`
    // ——**`access` 只认 `type` 与 `entitled`**，多写 `accountType` / `mode`
    // 会被 `.strict()` 整帧拒收（ZodError `unrecognized_keys`），账号快照进不去，
    // 官方随后抛 `Provider Registry 中不存在 Model`。
    // 交叉印证：官方自己的 fail-closed 空快照 `HKe` 逐字 `new zj({entitled:!1})`
    // ——**也只带 `entitled`**，官方在这条通道上从来不传那两个键。
    // 所以这是把断言**改准**（钉住真实 schema），不是放宽。
    const providerId = 'account:zai-start-plan';
    expect(params.providers[providerId].access).toEqual({
      type: 'zhipu-account',
      entitled: false
    });
    // 反向锁：那两个键一旦被加回来，这条立刻红。
    expect(Object.keys(params.providers[providerId].access).sort()).toEqual(['entitled', 'type']);
    // 整条 provider 也只允许 `builtinModelIds` 与 `access`（`kz.pick({builtinModelIds:!0})`）。
    expect(Object.keys(params.providers[providerId]).sort()).toEqual(['access']);
    // `states[id]` 对齐官方 `{availability, entitled, current?}`（偏移 766306）；
    // `availability` 是闭集，值必须取自其中。
    expect(['available', 'pending', 'unavailable', 'unknown']).toContain(params.states[providerId].availability);
    expect(typeof params.states[providerId].entitled).toBe('boolean');
    // **官方 `FHo` 的硬要求**：`access.entitled` 为真时 `states[id].current` 必填布尔。
    // 这里 entitled 是 false（沙箱里没有真实 coding-plan 缓存 → fail-closed），
    // 但 `current` 仍然必填布尔，否则官方 `.strict()` 拒收整帧。
    expect(typeof params.states[providerId].current).toBe('boolean');
  });

  it('**生产路径：请求帧不带 revision 也照样发出，且值就是官方运行时算出的那一个**（BL-2）', async () => {
    // 上一轮这条断言的前提是"revision 是外部输入，生产恒 undefined → 整帧不发"。
    // **BL-1 修好后那个前提没了**：两个 env 键一设上，官方 `Ykt` 起得来，而它自己算出的
    // revision 就挂在返回对象上（`accountSource.read().basedOnZCodeBuiltinRevision` /
    // `configService.read().zcodeBuiltinRevision`，逐字见 session-drive.mjs 文件头）。
    // 所以本用例**不传** `zcodeBuiltinRevision`，只靠子进程内从运行时读到的真值。
    const { childError } = await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      {},
      12000,
      sawMethod('provider/updateAccountConfig')
    );
    // 替身按官方 `ymr` 的语义校验过 env，所以走到这里就意味着 `Ykt` 的前置检查过了。
    expect(observed.ymrError).toBeNull();
    expect(childError).toBeNull();

    const acct = framesOf(observed.readFromStdin).find((f) => f.method === 'provider/updateAccountConfig');
    expect(acct).toBeDefined();
    // 官方 `FHo`（偏移 14128144）逐字：`revision.trim()` 与 `basedOnZCodeBuiltinRevision.trim()`
    // 都要非空，`Dn` 是非空字符串且 schema 是 `.strict()`——**空/null 会被整帧拒收**。
    const basedOn = acct.params.basedOnZCodeBuiltinRevision;
    expect(typeof basedOn).toBe('string');
    expect(basedOn.trim()).not.toBe('');
    // 形状对齐官方 `T3i`（偏移 587002）逐字 `` `zcode-builtin:${e.revision}:${t}` ``，
    // 其中 `t` 是 `UO` 构造器算的 `sha256(resolve(activeFilePath))`（64 位小写 hex）。
    expect(basedOn).toMatch(/^zcode-builtin:\d+:[0-9a-f]{64}$/);
    // **值必须就是官方运行时自己算出来的那个**（不是我们另算的、不是写死的）。
    expect(basedOn).toBe(observed.builtinRevision);
    expect(observed.builtinRevision).toMatch(/^zcode-builtin:\d+:[0-9a-f]{64}$/);
    // 请求帧的四个键与 `CGt` 逐字一致，没有 null。
    expect(Object.keys(acct.params).sort()).toEqual(['basedOnZCodeBuiltinRevision', 'providers', 'revision', 'states']);
  });

  it('**官方运行时读不到 revision 时才不发这一帧**（fail-closed：猜错会被官方整份丢弃）', async () => {
    // 直接打 `buildAccountConfigPatch`：替身路径下运行时总能算出 revision，
    // 所以"拿不到"这条只能对**函数本身**断言。`uninitialized` 是官方空快照的哨兵值
    // （`c3i` 逐字 `basedOnZCodeBuiltinRevision:"uninitialized"`），**不算**真值。
    const { buildAccountConfigPatch } = await import('../../scripts/official-host/session-drive.mjs');
    const req = { providerId: 'account:zai-start-plan', planMode: 'start-plan' };
    expect(await buildAccountConfigPatch(req, null)).toBeNull();
    expect(await buildAccountConfigPatch(req, '')).toBeNull();
    expect(await buildAccountConfigPatch(req, '   ')).toBeNull();
    expect(await buildAccountConfigPatch(req, 'uninitialized')).toBeNull();
    // 请求帧上带了值时优先用它（显式输入路径仍然有效）。
    const withReq = await buildAccountConfigPatch({ ...req, zcodeBuiltinRevision: 'zcode-builtin:3:deadbeef' }, null);
    expect(withReq).not.toBeNull();
    expect(withReq?.basedOnZCodeBuiltinRevision).toBe('zcode-builtin:3:deadbeef');
  });

  it('**自己起的官方 app-server 被自然收场**（关 stdin 就退，不靠父进程来收）', async () => {
    const { events, childError } = await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      {},
      12000,
      // **就绪谓词必须覆盖本用例断言的那件事**：`stdinClosed` 由 stdin 的 `end` 事件置真，
      // 它**严格晚于**最后一行 `session/close` 被记账。只等 `session/close` 会在
      // "帧已记、end 还没到"的那个瞬间读文件 → `stdinClosed` 仍是 false → 偶发红
      // （实测过一次，CI 第 2 轮）。等"两件都发生"才是这条断言真正要的等待。
      (v) => sawMethod('session/close')(v) && v.stdinClosed === true
    );
    expect(childError).toBeNull();
    // **实弹逐字**：33 段正文增量 + usage + finish（见 expectRealShotStream）。
    expectRealShotStream(events);
    // **HOSTFIX5 的等价面**：上一版这条断言的是"我们 dispose 了自己起的那份同进程运行时"
    // （`runtimeDisposeCalled`）。HOSTFIX5 起**同进程运行时根本不存在了**（不再 require
    // bundle），所以义务变成"**我们自己 spawn 的官方 app-server** 收得掉"。
    //
    // 官方逐字行为：stdin 收到 `end` 之后走完自己的 shutdown 链、`exit 0`
    // （I02 E-PROBE-R3-P4 与本轮 `%TEMP%` 零发送冒烟都观察到 exit 0 / stderr 0 字节）。
    // 替身照这条语义：`stdinClosed === true` 就是"官方进程确实收到了关闭信号"。
    expect(observed.stdinClosed).toBe(true);
  });

  it('**默认 fail-closed**：没有真实缓存时 entitled=false，绝不硬写 true', async () => {
    await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace'), { zcodeBuiltinRevision: 'zcode-builtin:1:synthetic' }),
      {},
      12000,
      sawMethod('provider/updateAccountConfig')
    );
    const acct = framesOf(observed.readFromStdin).find((f) => f.method === 'provider/updateAccountConfig');
    expect(acct).not.toBeUndefined();
    expect(acct.params.providers['account:zai-start-plan'].access.entitled).toBe(false);
    expect(acct.params.states['account:zai-start-plan'].entitled).toBe(false);
    expect(acct.params.states['account:zai-start-plan'].current).toBe(false);
  });

  it('**entitled=true 真的流过去**（合成缓存说 available 时）——证明值不是被写死的 false', async () => {
    // 写一份**合成**的 coding-plan 缓存到沙箱：`status:"available"`。
    // 路径逐字对应官方 `resolveCodingPlanCachePath`：
    // `join(dataBaseDir, ".zcode","v2","coding-plan-cache.json")`。
    const v2 = join(sandbox, '.zcode', 'v2');
    mkdirSync(v2, { recursive: true });
    writeFileSync(
      join(v2, 'coding-plan-cache.json'),
      JSON.stringify({
        entryStatus: {
          updatedAt: 1700000000000,
          items: { 'builtin:zai-start-plan': { status: 'available', reason: 'synthetic' } }
        }
      }),
      'utf8'
    );
    const { childError } = await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace'), { zcodeBuiltinRevision: 'zcode-builtin:9:synthetic' }),
      {},
      12000,
      sawMethod('provider/updateAccountConfig')
    );
    expect(childError).toBeNull();
    const acct = framesOf(observed.readFromStdin).find((f) => f.method === 'provider/updateAccountConfig');
    expect(acct).not.toBeUndefined();
    // 值随真实来源翻转 —— 注入面确实在承载数据。
    expect(acct.params.providers['account:zai-start-plan'].access.entitled).toBe(true);
    expect(acct.params.states['account:zai-start-plan'].availability).toBe('available');
    // 官方 `FHo` 硬要求：access.entitled 为真时 `states[id].current` 必填布尔。
    expect(acct.params.states['account:zai-start-plan'].current).toBe(true);
  });

  it('**HOSTFIX5：替身是被 spawn 起来跑的程序，不是一个被 require 的模块**', async () => {
    await spawnThroughRealChild(runRequest(join(sandbox, 'workspace')), {}, 12000, sawInput);
    // 上一版这条断言的是"传给官方函数的 options 里没有 `app` / `providerRegistry`"与
    // "`createZCodeApp` 的调用计数为 0"。HOSTFIX5 起**那些调用点在本进程里不存在了**
    // （app 由**官方 app-server 进程自己**建），所以"计数为 0"变成一句平凡真。
    //
    // 替代断言是**结构性的形态判据**，而且更强：替身自己读 `process.argv[1]` 与
    // `module.exports`，因此**父进程改不了**它。
    //  - `invokedAs === 'program'`：我是 `node <this> app-server --stdio ...` 的入口；
    //  - `moduleExports` 为空：我**不导出任何东西**，所以生产代码不可能从 bundle 取到导出
    //    （这正是实弹 `BUNDLE_EXPORTS_INCOMPLETE` 的根因，现在从结构上不存在了）。
    expect(observed.invokedAs).toBe('program');
    expect(observed.moduleExports).toEqual([]);
  });

  it('**不往官方不读的 options 里注入**：`standalone` 一个都不出现（stdio 形态的等价面）', async () => {
    await spawnThroughRealChild(runRequest(join(sandbox, 'workspace')), {}, 12000, sawInput);
    // 官方 `Ykt`（偏移 14124467）的第二参 `t` **只**认 `t.standalone`；传了它官方会去取
    // `standalone.credentialStore`，进而硬过滤 `mode === "individual-coding-plan"`，
    // start-plan 永远 not entitled。
    //
    // **HOSTFIX5 的等价面**：stdio 形态下没有"传 options"这个动作了，注入只可能表现为
    // 某个 env 键。替身把**自己真实收到的**、键名像 standalone 的 env 键全列出来。
    expect(observed.standaloneEnvKeys).toEqual([]);
  });

  it('**spawn argv 逐字钉死**（`OFFICIAL_APP_SERVER_ARGV`，测试不硬写第二份）', async () => {
    await spawnThroughRealChild(runRequest(join(sandbox, 'workspace')), {}, 12000, sawInput);
    // 由**子进程自己**读 `process.argv` —— 父进程传错了这里就会红。
    const { OFFICIAL_APP_SERVER_ARGV } = await import('../../scripts/official-host/host-child.mjs');
    expect(observed.argv).toEqual([...OFFICIAL_APP_SERVER_ARGV]);
    // 逐字依据见 host-child.mjs 的常量注释：`app-server` 是官方 help 逐字的子命令
    // （"Run the ZCode Protocol stdio app server"），`--stdio` 把"走 stdio"写进命令行，
    // `--surface desktop` 逐字保持上一版 `presentationSurface: 'desktop'` 的同一个值。
    expect(observed.argv[0]).toBe('app-server');
    expect(observed.argv).toContain('--stdio');
    expect(observed.argv).toContain('--surface');
  });
});

describe('OFFICIAL-HOST · HOSTFIX3 出站凭据闸门真的接进了跑会话的 app', () => {
  it('官方反向请求进了 **output**，我们用它作答，替身**因此**才放行 turn', async () => {
    const workspace = join(sandbox, 'workspace');
    const { events, childError } = await spawnThroughRealChild(
      runRequest(workspace, { zcodeBuiltinRevision: 'zcode-builtin:5:synthetic' }),
      {},
      12000,
      // 等 `turn.completed` 真的进了 input 才断言 —— 那是闸门放行之后才会发生的事。
      sawMethod('session/close')
    );
    expect(childError).toBeNull();

    // (1) 官方确实向客户端要了凭据。`pTt.requestClient` 逐字把帧写到 `output`，
    //     而 `output` 是驱动读的那条流——**不是**驱动自己发的。
    expect(observed.providerRuntimeHeadersRequestSent).toBe(true);
    // 请求帧是官方 `qir`（`{id, method, params?, trace?}`，`.strict()`）+ `fUi`（`.strict()`）。
    // （HOSTFIX5：旧版这里是 `readFromOutput === []`；stdio 形态下那条恒真，已换成
    // "反向应答确实走的是 stdin" —— 下面 (2) 就是它。）
    // 官方只有 start-plan 才来问（`$0e.claim` 逐字 `accountAccess?.mode !== "start-plan"`）。
    expect(observed.providerRuntimeHeadersRequestReason).toBe('model-request');
    expect(observed.providerRuntimeHeadersRequestProviderId).toBe('account:zai-start-plan');
    expect(observed.providerRuntimeHeadersRequestParamKeys).toEqual(
      expect.arrayContaining(['modelSelection', 'providerId', 'reason', 'requestId', 'sessionId', 'workspace'])
    );

    // (2) 我们确实答了，答的形状逐字对齐官方 `DGt`。
    expect(observed.providerRuntimeHeadersResponseSeen).toBe(true);
    expect(observed.providerRuntimeHeadersResponseHeadersApplied).toBe(true);
    // `DGt` 的 `requestAuth` 是 `.strict()` 的 `{apiKey?, headers?}` —— 只带 apiKey。
    expect(observed.providerRuntimeHeadersResponseRequestAuthKeys).toEqual(['apiKey']);
    expect(observed.providerRuntimeHeadersResponseSawApiKeyField).toBe(true);

    // (3) **收口判据**：turn 事件只在合格应答之后才发。所以"事件出现了"
    //     等价于"真正执行会话的 app 是拿着我们的 port 拿到 requestAuth 的"。
    expect(observed.turnProceededAfterAuth).toBe(true);
    expect(observed.gateHeldForAuth).toBe(false);
    // **实弹逐字**：33 段正文增量 + usage + finish（见 expectRealShotStream）。
    expectRealShotStream(events);
  });

  it('应答帧**只有** `{id, result}` 两个键（官方 `Vir` 是 `.strict()`，多一个键整帧被拒）', async () => {
    await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      {},
      12000,
      sawMethod('session/close')
    );
    const responses = framesOf(observed.readFromStdin).filter((f) => 'result' in f);
    // **HOSTFIX4 升级**：反向应答现在是**两帧**——官方每次 `session/create` 先要一条
    // `session/requestRuntimePreferences`（`CKo`），之后每次模型请求前再要一条
    // `interaction/requestProviderRuntimeHeaders`（`ZJo`）。旧断言"恰好一帧"在
    // HOSTFIX4 之后不再是事实；**这里升级为更强的一条**：两帧、且各自 id 必须
    // 原样回官方发出来的那一个。
    expect(responses).toHaveLength(2);
    // 官方 `pTt.requestClient` 用**同一个**单调计数器发 id（逐字
    // `nextClientRequestId=1` @14654573 / `id: \`server-${this.nextClientRequestId++}\`` @14668384），
    // 所以偏好那条拿到 `server-1`、凭据那条拿到 `server-2`。**顺序也被钉住。**
    expect(responses.map((f) => f.id)).toEqual([observed.runtimePreferencesRequestIds[0], observed.providerRuntimeHeadersRequestId]);
    expect(responses.map((f) => f.id)).toEqual(['server-1', 'server-2']);
    for (const response of responses) {
      // 逐字 `Vir = m.object({ id: yYe, result: m.unknown() }).strict()`。
      expect(Object.keys(response).sort()).toEqual(['id', 'result']);
      // 官方 `resolveClientRequest` 逐字 `String(t)` 查表，所以 id 必须原样回。
      expect(typeof response.id).toBe('string');
      expect(response.id).toMatch(/^server-\d+$/);
    }
  });

  it('**观测通道自己脱敏**：合成明文既不在帧里、也不在落盘的观测文件里', async () => {
    await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      {},
      12000,
      sawMethod('session/close')
    );
    const raw = readFileSync(observationFile, 'utf8');
    expect(raw).not.toContain(STUB_CREDENTIAL_PLAINTEXT);
    expect(raw).not.toContain(STUB_CREDENTIAL_SECRET);
    // **HOSTFIX4 升级**：现在有**两**帧反向应答，原来的 `.find(f => 'result' in f)`
    // 会捞到偏好那条（它没有 `requestAuth`）。改为**按官方发出去的 id 精确定位**凭据那条。
    const response = framesOf(observed.readFromStdin).find((f) => f.id === observed.providerRuntimeHeadersRequestId);
    expect(response).not.toBeUndefined();
    // 帧里那个 apiKey 位置上是占位符——形状还在，值不在。
    expect(response.result.requestAuth.apiKey).not.toBe(STUB_CREDENTIAL_PLAINTEXT);
    expect(typeof response.result.requestAuth.apiKey).toBe('string');
  });

  it('**跨通道挪用**：官方为别的 providerId 来要凭据 → 拒答 → turn 不放行', async () => {
    const { childError } = await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      // 替身照这个 env 造一条"别的 providerId"的反向请求。
      { ZCC_STUB_AUTH_REQUEST_PROVIDER_ID: 'account:bigmodel-start-plan' },
      5000,
      (v) => v?.providerRuntimeHeadersResponseSeen === true
    );
    // 会话必然失败：闸门不放行 → 没有终态事件 → 子宿主到墙钟上限后退出。
    expect(childError).not.toBeNull();
    expect(observed.providerRuntimeHeadersRequestProviderId).toBe('account:bigmodel-start-plan');
    expect(observed.providerRuntimeHeadersResponseSeen).toBe(true);
    // 官方 `DGt` 的拒答分支：`{headersApplied:false, errorMessage}`。
    expect(observed.providerRuntimeHeadersResponseHeadersApplied).toBe(false);
    expect(observed.providerRuntimeHeadersResponseRequestAuthKeys).toEqual([]);
    // **没有 requestAuth = 没有凭据出网**。
    expect(observed.turnProceededAfterAuth).toBe(false);
    expect(observed.gateHeldForAuth).toBe(true);
  });

  it('**fail-closed**：取键失败（仓里没有）→ 拒答 → turn 不放行，绝不空口放行', async () => {
    const { childError } = await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      // 数据根指向一个**空**目录：凭据仓不存在。
      { ZCODE_DATA_BASE_DIR: join(sandbox, 'empty-data-root') },
      5000,
      (v) => v?.providerRuntimeHeadersResponseSeen === true,
      false
    );
    expect(childError).not.toBeNull();
    expect(observed.providerRuntimeHeadersRequestSent).toBe(true);
    expect(observed.providerRuntimeHeadersResponseSeen).toBe(true);
    expect(observed.providerRuntimeHeadersResponseHeadersApplied).toBe(false);
    expect(observed.turnProceededAfterAuth).toBe(false);
    expect(observed.gateHeldForAuth).toBe(true);
  });
});

/**
 * HOSTFIX4 · `session/requestRuntimePreferences`（复审 §10.1 的 CRITICAL 阻塞项）。
 *
 * 官方逐字链路（`C:\ZCode\resources\glm\zcode.cjs`，只读）：
 * `jKo @14479718 → UKo @14479962 → ERn @14511145 → CXa @14510354 → CKo @14509003`，
 * `CKo` 逐字 `await e.requestClient(va.sessionRequestRuntimePreferences, {sessionId, scope},
 * pGt, {timeoutMs: dGt})` 且 `dGt = 15e3`；它的 catch **只**对 `-32601` / `-32020`
 * 返回默认对象，`-32022` 走 `throw l`。而 `await ERn(...)` 在 `UKo` 的 `try` **之外**
 * ——所以不答就是 `session/create` 抛掉、不回 sessionId。
 *
 * 替身把这条时序逐字复刻：**收到 `session/create` 后先不回执**，拿到合格应答才补发。
 * 于是这些用例里 "turn 事件出现了" 就等于 "两道闸门都过了"。
 */
describe('OFFICIAL-HOST · HOSTFIX4 `session/requestRuntimePreferences` 闸门（实弹硬阻塞）', () => {
  it('官方先发偏好请求，**我们答了它**才拿到 sessionId，turn 才放行', async () => {
    const { events, childError } = await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace'), { zcodeBuiltinRevision: 'zcode-builtin:5:synthetic' }),
      {},
      12000,
      sawMethod('session/close')
    );
    expect(childError).toBeNull();

    // (1) 官方确实发了这条。逐字 `G5i=m.object({sessionId:Dn,scope:jsr}).strict()`。
    expect(observed.runtimePreferencesRequestsSent).toBe(1);
    expect(observed.runtimePreferencesRequestIds).toEqual(['server-1']);
    expect(observed.runtimePreferencesRequestParamKeys).toEqual([['scope', 'sessionId']]);
    // `CXa` 在 `session/create` 关键路径上发的那一条 scope 是 `runtime-materialization`
    // （`user-execution` 那条是 lazy thunk，只在解析初始 bash shell 时发）。
    expect(observed.runtimePreferencesRequestScopes).toEqual(['runtime-materialization']);
    expect(observed.runtimePreferencesRequestSessionIds).toEqual(['stub-session-0001']);
    // **时序被钉住**：`session/create` 的回执是在偏好应答之后才补发的。
    expect(observed.sessionCreateResponseHeldForPreferences).toBe(true);
    expect(observed.sessionCreateResponseSent).toBe(true);

    // (2) 我们确实答了，且**帧形状逐字对齐官方 `Vir`**（偏移 735705）。
    expect(observed.runtimePreferencesResponseSeen).toBe(true);
    expect(observed.runtimePreferencesResponseFrameKeys).toEqual(['id', 'result']);
    expect(observed.runtimePreferencesResponseShapeValid).toBe(true);
    expect(observed.runtimePreferencesResponseSatisfiedScopes).toEqual(['runtime-materialization']);

    // (3) **收口判据**：两道闸门都过才放行 turn。
    expect(observed.gateHeldForRuntimePreferences).toBe(false);
    expect(observed.turnProceededAfterAuth).toBe(true);
    // **实弹逐字**：33 段正文增量 + usage + finish（见 expectRealShotStream）。
    expectRealShotStream(events);
  });

  it('**应答帧逐字段对齐官方 `pGt`**（偏移 759339，`.strict()`）', async () => {
    await spawnThroughRealChild(runRequest(join(sandbox, 'workspace')), {}, 12000, sawMethod('session/close'));
    // 官方 `pGt` 逐字：
    //   nativeSearchEnhancementsEnabled: m.boolean()                       ← 唯一必填
    //   memoryEnabled:                     m.boolean().default(!1)
    //   askUserQuestionAutoResolutionEnabled: m.boolean().default(!0)       ← 缺省是宽松的 true
    //   integratedTerminalShell:            aYe.optional()
    //   modelContextBudgetStrategy:         Bsr.default("preflight-v1")
    // }.strict()
    //
    // 我们**只**回前三个，且全 `false`（fail-closed）。**不多一个键**——`.strict()` 之下
    // 未知键会让整条 `pGt.parse` 失败，也就是整个 `session/create` 失败。
    expect(observed.runtimePreferencesResponseResultKeys).toEqual([
      'askUserQuestionAutoResolutionEnabled',
      'memoryEnabled',
      'nativeSearchEnhancementsEnabled'
    ]);
    expect(observed.runtimePreferencesResponseResult).toEqual({
      nativeSearchEnhancementsEnabled: false,
      memoryEnabled: false,
      askUserQuestionAutoResolutionEnabled: false
    });
    // **刻意不构造**这两个字段（理由见 reverse-responder.mjs 的字段表）：
    //  - `integratedTerminalShell`：省略 → 官方 `TXa` 逐字 `if(!(!e||e.mode==="auto")) return {…}`
    //    直接返回 `undefined`，即"不覆盖用户配置"，回落官方默认 shell。
    //  - `modelContextBudgetStrategy`：官方 `CXa` 逐字**丢弃**它（恒用 `WO`），写了也白写。
    expect(observed.runtimePreferencesResponseResult).not.toHaveProperty('integratedTerminalShell');
    expect(observed.runtimePreferencesResponseResult).not.toHaveProperty('modelContextBudgetStrategy');
    // 零凭据：这条应答里不可能出现任何凭据面。
    expect(Object.keys(observed.runtimePreferencesResponseResult).sort()).toEqual(
      ['askUserQuestionAutoResolutionEnabled', 'memoryEnabled', 'nativeSearchEnhancementsEnabled']
    );
  });

  it('**两个 scope 都应答**（`user-execution` 那条 lazy 的也走同一条分支）', async () => {
    await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      // 替身按这个 env 追加 `CXa` 里那条 lazy 的 `user-execution` 请求。
      { ZCC_STUB_RUNTIME_PREFERENCES_SCOPES: 'runtime-materialization,user-execution' },
      12000,
      sawMethod('session/close')
    );
    expect(observed.runtimePreferencesRequestsSent).toBe(2);
    expect(observed.runtimePreferencesRequestScopes).toEqual(['runtime-materialization', 'user-execution']);
    // 官方**同一个**单调计数器（`nextClientRequestId=1` @14654573）→ `server-1` / `server-2`。
    expect(observed.runtimePreferencesRequestIds).toEqual(['server-1', 'server-2']);
    expect(observed.runtimePreferencesResponseSatisfiedScopes).toEqual(['runtime-materialization', 'user-execution']);
    // 凭据那条顺延到 `server-3`。
    expect(observed.providerRuntimeHeadersRequestId).toBe('server-3');
    expect(observed.turnProceededAfterAuth).toBe(true);
  });

  it('**形状不合格就不放行**（替身按官方 `pGt` 逐字判定，绝不空口放行）', async () => {
    // 两种不合法的形态各钉一条：
    //  - `missing-required`：删掉唯一必填的 `nativeSearchEnhancementsEnabled`。
    //  - `extra-key`：三个键全对，只多加一个 `pGt` 之外的键 → **只有 `.strict()` 能抓**。
    for (const shape of ['missing-required', 'extra-key']) {
      const { childError } = await spawnThroughRealChild(
        runRequest(join(sandbox, 'workspace')),
        {
          ZCC_STUB_RUNTIME_PREFERENCES_SCOPES: 'runtime-materialization',
          ZCC_STUB_FORCE_PREFERENCES_SHAPE: shape
        },
        5000,
        (v) => v?.runtimePreferencesResponseSeen === true
      );
      expect(childError, `shape=${shape} 会话必须失败`).not.toBeNull();
      // 请求发过、应答也收到了——但**形状不合格**。
      expect(observed.runtimePreferencesRequestsSent).toBe(1);
      expect(observed.runtimePreferencesResponseSeen).toBe(true);
      expect(observed.runtimePreferencesResponseShapeValid).toBe(false);
      expect(observed.runtimePreferencesResponseSatisfiedScopes).toEqual([]);
      // 官方 `ERn` 返回不了 → `session/create` 抛掉 → **不回 sessionId**。
      expect(observed.sessionCreateResponseSent).toBe(false);
      expect(observed.gateHeldForRuntimePreferences).toBe(true);
      // 后面的一切都没发生：没 `session/send`、没凭据请求、没 turn 事件。
      expect(observed.providerRuntimeHeadersRequestSent).toBe(false);
      expect(observed.turnProceededAfterAuth).toBe(false);
    }
  });

  it('**不答就拿不到 sessionId**（这正是实弹会挂 300 秒的那个形状）', async () => {
    // 替身经 env **只**把偏好请求发出去、然后把驱动那一侧的应答**丢掉**——
    // 等价于"HOSTFIX3 之前的行为"（一条反向请求都不答）。
    const { childError } = await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      { ZCC_STUB_SWALLOW_RUNTIME_PREFERENCES_RESPONSE: '1' },
      5000,
      (v) => v?.gateHeldForRuntimePreferences === true
    );
    expect(childError).not.toBeNull();
    expect(observed.runtimePreferencesRequestsSent).toBe(1);
    // **官方侧回执永远没发出去**——这与 `CKo` 抛 `-32022`、`UKo` 不回 sessionId 同形。
    expect(observed.sessionCreateResponseSent).toBe(false);
    expect(observed.gateHeldForRuntimePreferences).toBe(true);
    expect(observed.turnProceededAfterAuth).toBe(false);
    // 观测到的 input 帧里，**没有** `session/send`：驱动根本没走到那一步。
    expect(observed.parsedMethodsFromStdin).not.toContain('session/send');
  });
});

describe('OFFICIAL-HOST · HOSTFIX4 `ZCC_HOST_DEBUG=1` 诊断开关（零凭据、只在 stderr）', () => {
  it('**缺省关闭**：不设开关时 stderr 里没有任何诊断行', async () => {
    const { stderrChunks, childError } = await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      {},
      12000,
      sawMethod('session/close')
    );
    expect(childError).toBeNull();
    // **必须沉降后再断言"没有"**——见 settleStderr 的注释：不等就是恒真断言。
    const stderr = await settleStderr(stderrChunks);
    expect(stderr).not.toContain('ZCC_HOST_DEBUG');
  });

  it('**只有精确的 `1` 才打开**：`0` / `true` / 空串都关着', async () => {
    for (const value of ['0', 'true', '', 'yes']) {
      const { stderrChunks } = await spawnThroughRealChild(
        runRequest(join(sandbox, 'workspace')),
        { [HOST_DEBUG_ENV_KEY]: value },
        12000,
        sawMethod('session/close')
      );
      // 只认精确的 '1'：这样"被什么环境变量顺手打开"这件事在设计上不可能发生。
      const stderr = await settleStderr(stderrChunks);
      expect(stderr).not.toContain('ZCC_HOST_DEBUG');
    }
  });

  it('`ZCC_HOST_DEBUG=1` 时把零凭据摘要打到 stderr，**父通道帧结构一个字不动**', async () => {
    const { stderrChunks, events, childError } = await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      { [HOST_DEBUG_ENV_KEY]: '1' },
      12000,
      sawMethod('session/close')
    );
    expect(childError).toBeNull();
    // **父通道事件序列与缺省完全一致**——诊断行只走 stderr，不走通道。
    // **实弹逐字**：33 段正文增量 + usage + finish（见 expectRealShotStream）。
    expectRealShotStream(events);
    const stderr = await waitForStderrText(stderrChunks, (t) => t.includes('ZCC_HOST_DEBUG '));
    const line = stderr.split('\n').find((l) => l.startsWith('ZCC_HOST_DEBUG '));
    expect(line).toBeDefined();
    const summary = JSON.parse(String(line).slice('ZCC_HOST_DEBUG '.length));
    // 按 method 分组的应答计数：复审 §10.4 的"官方到底发了几条"从此是一条可断言的事实。
    expect(summary.reverseRequestsAnswered).toBe(2);
    expect(summary.reverseRequestsByMethod).toEqual({
      'session/requestRuntimePreferences': 1,
      'interaction/requestProviderRuntimeHeaders': 1
    });
    // 闭集短码。
    expect(summary.lastReverse.refusalCode).toBeNull();
    expect(summary.lastReverse.headersApplied).toBe(true);
    expect(summary.lastRuntimePreferences).toEqual({
      id: 'server-1',
      method: 'session/requestRuntimePreferences',
      scope: 'runtime-materialization',
      requestShapeValid: true,
      answered: true
    });
    // 各阶段耗时。`sessionCreate` 必须是**毫秒级**——官方 `CKo` 的 `timeoutMs` 是 15 s，
    // 所以这一个数字就能一眼分辨"HOSTFIX4 修没修好"。
    expect(summary.phaseDurationsMs.sessionCreate).toBeGreaterThanOrEqual(0);
    expect(summary.phaseDurationsMs.sessionCreate).toBeLessThan(15000);
    expect(summary.phaseDurationsMs.accountConfig).not.toBeNull();
    expect(summary.phaseDurationsMs.turn).toBeGreaterThanOrEqual(0);
    expect(summary.phaseDurationsMs.total).toBeGreaterThanOrEqual(0);
    // **零凭据**：整条诊断行里搜不到合成明文、测试 secret、apiKey 形态。
    expect(stderr).not.toContain(STUB_CREDENTIAL_PLAINTEXT);
    expect(stderr).not.toContain(STUB_CREDENTIAL_SECRET);
    expect(stderr).not.toContain('apiKey');
    expect(stderr).not.toContain('entryKey');
  });
});

describe('OFFICIAL-HOST · B2 存储隔离（真实 spawn 观测子进程 env）', () => {
  it('`ZCODE_STORAGE_DIR` 与 `ZCODE_SESSION_DB_PATH` 指向 companion 专属目录', async () => {
    const storageDir = join(sandbox, 'isolated-storage');
    await spawnThroughRealChild(runRequest(join(sandbox, 'workspace')), { ZCC_HOST_STORAGE_DIR: storageDir }, 12000);
    // 替身在 `startProcessProviderRegistryRuntime` 里记录的是**子进程真实 env**
    // （官方 `Ykt(e, …)` 的第一参就是 `e.env`），不是我们传进去的假值。
    expect(observed.childEnv.ZCODE_STORAGE_DIR).toBe(storageDir);
    // 两个 session DB 键都设（官方是 `l==="SESSION_DB_PATH"||l==="SESSION_DB"` 的或关系）。
    expect(observed.childEnv.ZCODE_SESSION_DB_PATH).toBe(join(storageDir, 'cli', 'db', 'db.sqlite'));
    expect(observed.childEnv.ZCODE_SESSION_DB).toBe(join(storageDir, 'cli', 'db', 'db.sqlite'));
  });

  it('默认（未设置覆盖）也绝不落回 ZCode 存储根', async () => {
    // 生产缺省：`%TEMP%/zcode-companion-official-host`（见 `resolveHostStorageRoot`）。
    await spawnThroughRealChild(runRequest(join(sandbox, 'workspace')), { ZCC_HOST_STORAGE_DIR: undefined }, 12000);
    const dir = observed.childEnv.ZCODE_STORAGE_DIR;
    expect(dir).not.toBeNull();
    // 归一后逐段比：任一段都不得是 `.zcode` / `.zcode-beta`。
    expect(dir.replace(/[\\/]+$/, '').toLowerCase().split(/[\\/]/)).not.toContain('.zcode');
    expect(dir.replace(/[\\/]+$/, '').toLowerCase().split(/[\\/]/)).not.toContain('.zcode-beta');
    // 更强的断言：它必须与用户主目录**不相等**（工单要求的"绝不等于用户主目录路径"）。
    expect(dir.replace(/[\\/]+$/, '').toLowerCase()).not.toBe(homedir().replace(/[\\/]+$/, '').toLowerCase());
  });

  it('**绝不设 `ZCODE_DATA_BASE_DIR`**：那会把真实凭据仓一起搬走', async () => {
    // 官方 `n$s`（`resolveSharedZCodeCredentialsPath`，偏移 4298550）逐字：
    // `let n=e.baseDir??t[t$s]??homedir(); return join(resolveUserPath(n),".zcode","v2","credentials.json")`，
    // 其中 `t$s="ZCODE_DATA_BASE_DIR"`。设了它凭据仓就跟着搬走 —— 我们要读**真实**仓解 key。
    //
    // 本测试自己把它设成沙箱（只为证明注入得进去、观测得到），生产路径不设。
    await spawnThroughRealChild(runRequest(join(sandbox, 'workspace')), { ZCODE_DATA_BASE_DIR: sandbox }, 12000);
    // 证明这个键确实能进子进程 env（否则"我们没设它"就是靠运气而不是靠设计）。
    expect(observed.childEnv.ZCODE_DATA_BASE_DIR).toBe(sandbox);
    // 而生产 env 构造里没有它：断言生产函数在**不**受污染的 env 上的输出。
    const clean = buildIsolatedChildEnv({ PATH: 'x', SystemRoot: 'y' });
    expect(clean).not.toHaveProperty('ZCODE_DATA_BASE_DIR');
  });

  it('父进程 env 里预置的同名键**不被继承**（隔离不由环境变量决定）', () => {
    // 否则"是否隔离"就取决于一个我们不掌控的父进程变量。
    const dirty = buildIsolatedChildEnv({
      PATH: 'x',
      ZCODE_STORAGE_DIR: 'C:/attacker-chosen',
      ZCODE_SESSION_DB_PATH: 'C:/attacker-chosen/db.sqlite',
      ZCODE_SESSION_DB: 'C:/attacker-chosen/db.sqlite'
    });
    expect(dirty['ZCODE_STORAGE_DIR']).not.toBe('C:/attacker-chosen');
    expect(dirty['ZCODE_SESSION_DB_PATH']).not.toBe('C:/attacker-chosen/db.sqlite');
    expect(dirty['ZCODE_SESSION_DB']).not.toBe('C:/attacker-chosen/db.sqlite');
  });

  it('隔离目录落进 ZCode 存储根 → 抛错而不是照发', () => {
    for (const bad of [join(homedir(), '.zcode'), join(homedir(), '.zcode', 'cli', 'db'), 'C:/x/.zcode/anything']) {
      expect(() => buildIsolatedChildEnv({ PATH: 'x' }, bad)).toThrowError(/STORAGE_ISOLATION_UNSAFE/);
    }
  });

  it('**驱动器不用 `process.cwd()` 当 workspace**（否则会落进用户桌面会话列表）', () => {
    const catalog = /** @type {any} */ ({
      revision: 'synthetic',
      models: [
        { modelId: 'account:zai-start-plan::GLM-5.3-Flash', displayName: '', provider: 'account:zai-start-plan', billingClass: 'promotion', contextLength: null, reasoning: [], capabilities: [] }
      ]
    });
    const servable = selectServableModels(catalog);
    /** @type {string[]} */
    const sent = [];
    const driver = createOfficialHostDriver({
      descriptor: /** @type {any} */ ({
        bundlePath: STUB_BUNDLE,
        exports: [],
        detail: 'synthetic',
        models: [{ id: 'account:zai-start-plan::GLM-5.3-Flash', object: 'model', created: 1, owned_by: 'x' }],
        status: 'ready'
      }),
      catalog,
      servableModels: servable,
      reasoning: 'high',
      bundlePath: STUB_BUNDLE,
      timeoutMs: 400,
      deriveEntitled: () => ({
        entitled: true,
        evidence: {
          providerId: 'account:zai-start-plan',
          cacheKey: 'k',
          cacheStatus: 'available',
          availabilityObservedAt: 1,
          available: true,
          reason: 'cache-available',
          sourceFile: 's'
        }
      }),
      spawnChild: () => {
        const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        });
        const original = child.stdin.write.bind(child.stdin);
        /** @type {any} */ (child.stdin).write = (/** @type {any} */ chunk, /** @type {any} */ ...rest) => {
          sent.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
          return original(chunk, ...rest);
        };
        return /** @type {any} */ (child);
      }
    });
    // 驱动器会失败（假子宿主不回话），但请求帧已经写出去了。
    return (async () => {
      try {
        for await (const _ of driver.stream(/** @type {any} */ ({
          operationId: 'op-ws',
          model: 'account:zai-start-plan::GLM-5.3-Flash',
          messages: [{ role: 'user', content: 'x' }],
          maxTokens: null,
          signal: new AbortController().signal
        }))) void _;
      } catch {
        /* 预期失败：只关心它写出去的 workspacePath。 */
      }
      const body = sent.join('');
      const frame = framesOf([body])[0];
      expect(frame).toBeDefined();
      const workspacePath = /** @type {any} */ (frame).zccHost.workspacePath;
      expect(workspacePath).not.toBe(process.cwd());
      // 它是受控的 companion 目录：归一后逐段都不含 ZCode 存储根名。
      const segments = workspacePath.replace(/[\\/]+$/, '').toLowerCase().split(/[\\/]/);
      expect(segments).not.toContain('.zcode');
      expect(segments).not.toContain('.zcode-beta');
      expect(segments).toContain('zcode-companion-official-host');
    })();
  });

  it('显式 `workspacePath` 优先，且仍过 ZCode 存储根闸门', () => {
    const chosen = join(sandbox, 'explicit-workspace');
    expect(resolveHostWorkspaceRoot(process.env, chosen)).toBe(resolvePath(chosen));
    expect(() => resolveHostWorkspaceRoot(process.env, join(homedir(), '.zcode', 'ws'))).toThrowError(
      /STORAGE_ISOLATION_UNSAFE/
    );
  });
});

describe('OFFICIAL-HOST · BL-1 Provider Registry 的两个必填 env（真实 spawn + 替身按官方 ymr 语义抛）', () => {
  it('两个键都下发，且 builtin 指向**真实存在**的官方资产、personal 落在隔离目录里', async () => {
    const storageDir = join(sandbox, 'isolated-storage');
    await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      { ZCC_HOST_STORAGE_DIR: storageDir },
      12000,
      sawMethod('session/close')
    );
    // 替身 `startProcessProviderRegistryRuntime` 记录的是**子进程真实 env**
    // （官方 `Ykt(e, …)` 的第一参就是 `e.env`），不是我们传进去的假值。
    const builtin = observed.childEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
    const personal = observed.childEnv.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
    expect(typeof builtin).toBe('string');
    expect(builtin).not.toBe('');
    // **必须真实存在**：官方 `UO.read()` 的 catch 分支是
    // `t = bnr(await MWt(this.#e), null)`，而 `bnr` 在两份都读不出来时抛 AggregateError。
    expect(existsSync(builtin)).toBe(true);
    // 官方安装布局的资产：`C:\ZCode\resources\config\provider\zcode-builtin.json`。
    expect(builtin.replace(/\\/g, '/')).toBe('C:/ZCode/resources/config/provider/zcode-builtin.json');
    // personal 落在**隔离目录**下（不读不改用户真实 `~/.zcode/v2/provider_config.json`——
    // 官方 `Cpe.#p()` 会把不规范的 personal config **规范化回写**，那正是红线）。
    expect(personal).toBe(join(storageDir, 'v2', 'provider_config.json'));
  });

  it('`Ykt` 的前置检查（`ymr`：两个键必须**同时**非空）在真实 spawn 路径上过得去', async () => {
    const { childError } = await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      {},
      12000,
      sawMethod('session/close')
    );
    // 替身逐字复刻官方 `ymr`（偏移 1067031）：缺键 / 只给一个键就抛
    // `缺少进程 Provider Registry 的 ZCode Built-in / Personal Config 路径`，
    // 与官方 `Ykt` 首句的抛错一致。所以 `ymrError === null` **只**在两个键都设上时成立。
    expect(observed.ymrError).toBeNull();
    expect(childError).toBeNull();
    expect(observed.didReceiveSessionCreate).toBe(true);
    // 官方 protocol agent 内部**自己也会** `Ykt(e.env ?? process.env)` 再起一份运行时
    // （`NXo` 逐字 `create: r(() => Ykt(z))`），所以键必须落在**子进程 env** 上，
    // 只在我们自己这一份运行时上补是不够的 —— 观测到的正是子进程 env。
    expect(observed.childEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE).not.toBeNull();
    expect(observed.childEnv.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE).not.toBeNull();
  });

  it('父进程 env 里预置的同名字段**不被继承**（是否合规不由环境变量决定）', () => {
    const dirty = buildIsolatedChildEnv({
      PATH: 'x',
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: 'C:/attacker-chosen/nope.json',
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: 'C:/attacker-chosen/nope.json',
      ZCODE_LOG_DIR: 'C:/attacker-chosen/log',
      ZCODE_RUNTIME_ENV: 'development'
    });
    expect(dirty['ZCODE_BUILTIN_PROVIDER_CONFIG_FILE']).not.toBe('C:/attacker-chosen/nope.json');
    expect(dirty['ZCODE_PERSONAL_PROVIDER_CONFIG_FILE']).not.toBe('C:/attacker-chosen/nope.json');
    expect(dirty['ZCODE_LOG_DIR']).not.toBe('C:/attacker-chosen/log');
    expect(dirty['ZCODE_RUNTIME_ENV']).toBe('test');
  });

  it('builtin 配置找不到 → 抛 `PROVIDER_CONFIG_NOT_FOUND` 而不是照发', () => {
    // 覆盖键指向不存在的路径，bundle 路径也推不出候选 → 必须在 env 构造期就拒。
    // 注意：只有当 `bundlePath` **不是**本机缺省那份时才会走到这一步——
    // 指向别处的 bundle 时静默回落到另一个安装的资产比报错更糟（见 resolver 注释）。
    expect(() =>
      buildIsolatedChildEnv(
        { ZCC_HOST_BUILTIN_PROVIDER_CONFIG: join(sandbox, 'no-such-file.json') },
        join(sandbox, 'isolated'),
        join(sandbox, 'no-such-bundle.cjs')
      )
    ).toThrowError(/PROVIDER_CONFIG_NOT_FOUND/);
  });

  it('坏覆盖键**不生效**：回落到真实存在的官方资产（而不是把子进程指到一个不存在的文件上）', () => {
    const env = buildIsolatedChildEnv({ ZCC_HOST_BUILTIN_PROVIDER_CONFIG: join(sandbox, 'no-such-file.json') });
    const chosen = env['ZCODE_BUILTIN_PROVIDER_CONFIG_FILE'] ?? '';
    expect(chosen).not.toContain('no-such-file');
    expect(existsSync(chosen)).toBe(true);
  });

  it('运维覆盖键生效（`ZCC_HOST_BUILTIN_PROVIDER_CONFIG` / `ZCC_HOST_PERSONAL_PROVIDER_CONFIG`）', () => {
    const built = join(sandbox, 'custom-builtin.json');
    const personal = join(sandbox, 'custom-personal.json');
    writeFileSync(built, JSON.stringify({ schemaVersion: 1, revision: 1, config: {} }), 'utf8');
    const env = buildIsolatedChildEnv(
      {
        ZCC_HOST_BUILTIN_PROVIDER_CONFIG: built,
        ZCC_HOST_PERSONAL_PROVIDER_CONFIG: personal
      },
      join(sandbox, 'isolated')
    );
    expect(env['ZCODE_BUILTIN_PROVIDER_CONFIG_FILE']).toBe(resolvePath(built));
    expect(env['ZCODE_PERSONAL_PROVIDER_CONFIG_FILE']).toBe(resolvePath(personal));
  });
});

describe('OFFICIAL-HOST · BL-4 日志目录与 model-io rollout 的隔离', () => {
  it('`ZCODE_LOG_DIR` 指向隔离目录（官方 `rB` 逐字 `e.logDir ?? e.env?.ZCODE_LOG_DIR ?? N6s()`）', async () => {
    const storageDir = join(sandbox, 'isolated-storage');
    await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      { ZCC_HOST_STORAGE_DIR: storageDir },
      12000,
      sawMethod('session/close')
    );
    // `N6s()` 逐字 `join(homedir(), ".zcode","cli","log")` —— 不设它就写进用户真实目录。
    expect(observed.childEnv.ZCODE_LOG_DIR).toBe(join(storageDir, 'cli', 'log'));
    // 归一后逐段都不得是 ZCode 存储根名。
    const segments = observed.childEnv.ZCODE_LOG_DIR.replace(/[\\/]+$/, '').toLowerCase().split(/[\\/]/);
    expect(segments).not.toContain('.zcode');
    expect(segments).not.toContain('.zcode-beta');
  });

  it('`ZCODE_RUNTIME_ENV=test`：官方 `Kst` 变 false → `recordModelIO` 关闭 → 不写 `~/.zcode/cli/rollout`', async () => {
    await spawnThroughRealChild(runRequest(join(sandbox, 'workspace')), {}, 12000, sawMethod('session/close'));
    expect(observed.childEnv.ZCODE_RUNTIME_ENV).toBe('test');
  });

  it('model-io rollout **不可重定向**、只能关（口径镜像，不是官方代码执行）', () => {
    // 官方逐字（见 host-driver.ts 里 HOST_RUNTIME_ENV_KEY 的注释）：
    //   `function e4s(e){ return join(homedir(), ".zcode","cli", e?"debug":"rollout") }`
    //   `function JWr(e,t,n,o=false){ … let l = t ?? e4s(n ?? false); mkdirSync(l,{recursive:true}); … }`
    // 两个调用点都只传 1 个实参 → `t`/`n` 恒 undefined → 恒落 `~/.zcode/cli/rollout`。
    // 唯一的关闭开关是 `Kst(e) = GWr(e) !== "test"`，`GWr(e) = XW(e["ZCODE_RUNTIME_ENV"])`。
    //
    // **这里是口径镜像，不是官方代码实跑**（纪律：零真实 bundle 启动）。它证明的是
    // "我们选的取值确实是那个唯一能关掉它的取值"，不是"官方一定照我们想的执行"。
    const XW = (/** @type {unknown} */ v) => {
      const t = typeof v === 'string' ? v.trim().toLowerCase() : '';
      return t === 'development' || t === 'production' || t === 'test' ? t : undefined;
    };
    const recordModelIO = (/** @type {Record<string, string|undefined>} */ env) => XW(env['ZCODE_RUNTIME_ENV']) !== 'test';
    expect(recordModelIO({})).toBe(true); // 官方 CLI 自己的缺省：不设就是会写盘
    expect(recordModelIO({ ZCODE_RUNTIME_ENV: 'production' })).toBe(true);
    expect(recordModelIO({ ZCODE_RUNTIME_ENV: 'development' })).toBe(true);
    expect(recordModelIO({ ZCODE_RUNTIME_ENV: 'test' })).toBe(false);
    // 我们下发的值必须正好是那一个。
    expect(buildIsolatedChildEnv({ PATH: 'x' })['ZCODE_RUNTIME_ENV']).toBe('test');
  });

  it('会话 rollout（与 model-io 是两条路）已经由 `ZCODE_STORAGE_DIR` 覆盖', async () => {
    // 官方会话 rollout 走 `Zzo(e, t) = join(e, t ? "debug" : "rollout")`，`e` 来自
    // `config.storage.dir`（偏移 14088745 逐字 `let E = zg(l.config.storage.dir), R = k8(E), L = Zzo(R, OCe(...) === "development")`），
    // 所以它**已经在** B2 的隔离范围内。本用例只钉住"会话 rollout 的根确实在隔离目录下"。
    const storageDir = join(sandbox, 'isolated-storage');
    await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      { ZCC_HOST_STORAGE_DIR: storageDir },
      12000,
      sawMethod('session/close')
    );
    // `k8(e) = basename(e)==="cli" ? e : join(e, "cli")` —— 会话 rollout 的目录是 <storageDir>/cli/rollout。
    expect(join(observed.childEnv.ZCODE_STORAGE_DIR, 'cli', 'rollout').startsWith(storageDir)).toBe(true);
  });
});

/**
 * HOSTFIX5 · 实弹首战（2026-10-01 09:34）暴露的四个问题，在这一段钉死。
 *
 * 1. 传输拓扑：从 require bundle 换成 spawn `app-server --stdio`。
 * 2. 流方向（B1）：接反防护在 stdio 形态下必须有**等价**测试。
 * 3. 启动通告：官方自发 5–27 条无 `id` 的 `startup/storageState` 通知，**必须被容忍**。
 * 4. 失败码闭集：`BUNDLE_EXPORTS_INCOMPLETE` / `BUNDLE_LOAD_FAILED` **整条消失**。
 */
describe('OFFICIAL-HOST · HOSTFIX5 传输拓扑与启动通告', () => {
  it('**B1 方向（等价防护）**：请求进子进程 **stdin**，应答从 **stdout** 回读，两条方向都被钉住', async () => {
    const workspace = join(sandbox, 'workspace');
    const { events, childError } = await spawnThroughRealChild(
      runRequest(workspace, { zcodeBuiltinRevision: 'zcode-builtin:5:synthetic' }),
      {},
      // **刻意用 6 s 而不是 12 s**：方向被接反时替身一个字节都收不到，会话会走完
      // `runHostSession` 的超时而失败；`waitForObservation` 的 `isOver` 逃生口会在那一刻
      // 立刻返回，让下面**第一条断言**就红——而不是先烧满超时再红成一条"超时"，
      // 更不是烧 8 s 才红。实测：接反变体下本用例在 6 s 内以
      // `expect(observed).not.toBeNull()` 失败。
      6000,
      // 等 `session/close` 真的进了 stdin 才断言 —— 不依赖调度顺序。
      sawMethod('session/close')
    );
    // **方向判据（接反的真实可观测形状）**：请求进的是子进程的 stdin。
    // 接反（写 stdout 读 stdin）会让替身**一个字节都收不到**，这里就红。
    // 这条断言放在最前面，让接反在**第一秒**就红。
    expect(observed).not.toBeNull();
    expect(observed.readFromStdin.length).toBeGreaterThan(0);
    // 有序方法序列：账号注入 → 创建 → **订阅** → 发送 → 收尾。五条都在，方向就对。
    //
    // **HOSTFIX7**：`session/subscribe` 必须在 `session/create` 之后、`session/send`
    // **之前**——官方 `kXa` 逐字 `…, !t.deliveryKind) return;`，不订阅就一条事件都不发；
    // 而官方**不补发**订阅之前产生的事件，所以晚订阅会**永久丢事件**。
    // 这条有序断言把"订阅在正确的位置"钉死（只钉"调用过 subscribe"抓不住放错位置）。
    expect(observed.parsedMethodsFromStdin).toEqual([
      'provider/updateAccountConfig',
      'session/create',
      'session/subscribe',
      'session/send',
      'session/close'
    ]);

    expect(childError).toBeNull();

    // **方向第一半**：每一帧请求都进了 stdin，而且**形状逐字对齐官方 `.strict()`**。
    const stdinFrames = framesOf(observed.readFromStdin);
    const createFrame = stdinFrames.find((f) => f.method === 'session/create');
    expect(createFrame).toBeDefined();
    expect(observed.parsedMethodsFromStdin).toContain('session/create');
    // 官方请求 schema 是 `.strict()`，顶层只有 {id, method, params, trace}。
    expect(Object.keys(createFrame).sort()).toEqual(['id', 'method', 'params']);
    // workspace 落点是我们给的沙箱，**不是** `process.cwd()`（B2）。
    expect(createFrame.params.workspace.workspacePath).toBe(workspace);
    expect(createFrame.params.workspace.workspaceKey).toBe(workspace);
    // model / thoughtLevel 的位置逐字对齐官方 schema。
    // **HOSTFIX6：`options.reasoningLevel` 必填**（实弹逐字
    // `ModelProtocolError: Reasoning level is required for account:zai-start-plan/GLM-5.3-Flash`）。
    // 官方 `Pu` 逐字 `{providerId, modelId, options:{reasoningLevel}.strict().optional()}.strict()`，
    // 官方 `bpe` 逐字 `options?.reasoningLevel === undefined ⟹ reasoning-level-missing`。
    expect(createFrame.params.model).toEqual({
      providerId: 'account:zai-start-plan',
      modelId: 'GLM-5.3-Flash',
      options: { reasoningLevel: 'high' }
    });
    expect(createFrame.params.thoughtLevel).toBe('high');

    // **方向第二半**：帧**没有**出现在替身的 stdout 上（断言已提到本用例最前面）。

    // **回读成功**：拿到了官方回报的 sessionId，走到了 session/send 与 session/close。
    expect(observed.didReceiveSessionCreate).toBe(true);
    const sentFrame = stdinFrames.find((f) => f.method === 'session/send');
    expect(sentFrame).toBeDefined();
    expect(sentFrame.params.sessionId).toBe('stub-session-0001');
    expect(observed.parsedMethodsFromStdin).toContain('session/close');

    // 产出如实映射（增量 + usage + finish）。
    // **实弹逐字**：33 段正文增量拼起来逐字等于实弹正文，usage 数字逐字，finish 收尾。
    expectRealShotStream(events);
  });

  it('**官方自发的启动通告被容忍**：数一下、丢掉，既不答也不混进事件流', async () => {
    const { events, childError, stderrChunks } = await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      { [HOST_DEBUG_ENV_KEY]: '1' },
      12000,
      sawMethod('session/close')
    );
    expect(childError).toBeNull();
    // 替身照官方 E-PROBE-R3-P4 的形状自发吐了无 `id` 的 `startup/storageState` 通知。
    expect(observed.startupNotificationsSent).toBeGreaterThan(0);
    expect(observed.startupNotificationMethods).toEqual(
      Array.from({ length: observed.startupNotificationsSent }, () => 'startup/storageState')
    );
    // **它没有被当成反向请求**（那会走 `answerSessionRuntimePreferences`，
    // 把 `server-*` 之类的 id 写回 stdin）：观测到的反向请求仍然只有官方那两条。
    const responseIds = framesOf(observed.readFromStdin)
      .filter((f) => 'result' in f)
      .map((f) => f.id);
    expect(responseIds).toEqual([observed.runtimePreferencesRequestIds[0], observed.providerRuntimeHeadersRequestId]);
    // **它也没有混进事件流**：`sessionId` 只可能来自 `session/create` 的回执。
    const sessionIdSources = framesOf(observed.readFromStdin).filter((f) => f.sessionId !== undefined);
    expect(sessionIdSources).toEqual([]);
    // 事件序列一字不多一字不少（启动通告没变成 `delta`）。
    // **实弹逐字**：33 段正文增量 + usage + finish（见 expectRealShotStream）。
    expectRealShotStream(events);
    // 计数进了零凭据诊断行（`unsolicitedNotificationsIgnored`）。
    const stderr = await waitForStderrText(stderrChunks, (t) => t.includes('ZCC_HOST_DEBUG '));
    const line = stderr.split('\n').find((l) => l.startsWith('ZCC_HOST_DEBUG '));
    expect(line).toBeDefined();
    const summary = JSON.parse(String(line).slice('ZCC_HOST_DEBUG '.length));
    expect(summary.unsolicitedNotificationsIgnored).toBe(observed.startupNotificationsSent);
  });

  it('**失败码闭集**：`BUNDLE_EXPORTS_INCOMPLETE` / `BUNDLE_LOAD_FAILED` 整条消失，`BUNDLE_SPAWN_FAILED` 顶替', async () => {
    const { HOST_CHILD_FAILURE_CODES } = await import('../../scripts/official-host/host-child.mjs');
    // 不再 require，就不再有"导出面"这两个失败模式——机器可核，不是靠注释。
    expect(HOST_CHILD_FAILURE_CODES).not.toContain('BUNDLE_EXPORTS_INCOMPLETE');
    expect(HOST_CHILD_FAILURE_CODES).not.toContain('BUNDLE_LOAD_FAILED');
    expect(HOST_CHILD_FAILURE_CODES).toContain('BUNDLE_SPAWN_FAILED');
    expect([...HOST_CHILD_FAILURE_CODES]).toEqual([
      'ARG_INVALID',
      'BUNDLE_NOT_FOUND',
      'BUNDLE_SPAWN_FAILED',
      'CHILD_PROTOCOL_VIOLATION',
      'CHANNEL_REFUSED',
      'SESSION_FAILED',
      'CHILD_UNCAUGHT'
    ]);
    // 生产代码里**可执行代码**不该再出现那两个码（防止它们从别处复活）。
    //
    // **必须先剥注释**（与 `tests/contract/official-host-contract.test.mjs` 的 `code()`
    // 同一纪律）：文件头里 HOSTFIX5 的说明**逐字引用**了 `BUNDLE_EXPORTS_INCOMPLETE`
    // 这个名字来说明它为什么消失，不剥注释就会把那段说明当成违规——那不是放宽断言，
    // 是让断言对准它真正要管的东西。
    const hostChildCode = stripComments(readFileSync(resolveHostChildScript(), 'utf8'));
    expect(hostChildCode).not.toContain('BUNDLE_EXPORTS_INCOMPLETE');
    expect(hostChildCode).not.toContain('BUNDLE_LOAD_FAILED');
    // 同一条纪律的另一半：我们**不再 require** 官方 bundle，所以 `createRequire` 也不该在。
    expect(hostChildCode).not.toContain('createRequire');
    // 而 spawn 那一行必须在（这是替代 require 的新入口）。
    expect(hostChildCode).toContain('spawn(process.execPath');
    expect(hostChildCode).toContain('OFFICIAL_APP_SERVER_ARGV');
  });

  it('**bundle 起不来时失败化**（spawn 出来的进程起不来 = `BUNDLE_SPAWN_FAILED`）', async () => {
    // 一个"存在但不是 app-server"的文件：被 spawn 后立刻退非 0，官方 app-server 起不来。
    const fake = join(sandbox, 'not-an-app-server.cjs');
    writeFileSync(fake, 'process.exit(3);\n', 'utf8');
    /** @type {any} */
    let caught;
    try {
      await runHostSession({ op: 'run', workspacePath: join(sandbox, 'workspace'), providerId: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash', planMode: 'start-plan', entitled: true, thoughtLevel: 'high', prompt: 'x', maxTokens: null, operationId: 'op-fake' }, () => undefined, {
        bundlePath: fake,
        timeoutMs: 8000,
        spawnChild: (args) => spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: buildIsolatedChildEnv(process.env) })
      });
    } catch (e) {
      caught = e;
    }
    // 无论落在"子宿主报 failed"还是"子宿主自己退出"哪一条上，**都必须是一次可见的失败**，
    // 绝不允许静默成功——那正是"导出预检"曾经承担、现在必须由协议层承担的那道闸门。
    expect(caught).not.toBeUndefined();
    expect(String(caught.message)).toMatch(/BUNDLE_SPAWN_FAILED|CHILD_EXITED|CHILD_TIMEOUT/);
  });
});

describe('OFFICIAL-HOST · B4 子进程回收（三条路径都不留孤儿）', () => {
  /**
   * 等一个由本测试 spawn 的子进程**真的**退出，并回报它的终态。
   *
   * @param {import('node:child_process').ChildProcess} child
   * @param {number} ms 上限
   * @returns {Promise<{ exited: boolean, exitCode: number | null, signalCode: NodeJS.Signals | null, aliveAfter: boolean }>}
   */
  function waitForExit(child, ms = 4000) {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve({ exited: true, exitCode: child.exitCode, signalCode: child.signalCode, aliveAfter: false });
        return;
      }
      const timer = setTimeout(() => {
        let aliveAfter = false;
        if (typeof child.pid === 'number') {
          try {
            // Windows 上 `process.kill(pid, 0)` 走 OpenProcess 存在性检查（tap 同一手法）。
            process.kill(child.pid, 0);
            aliveAfter = true;
          } catch {
            aliveAfter = false;
          }
        }
        resolve({ exited: false, exitCode: child.exitCode, signalCode: child.signalCode, aliveAfter });
      }, ms);
      child.on('exit', () => {
        clearTimeout(timer);
        setTimeout(() => {
          let aliveAfter = false;
          if (typeof child.pid === 'number') {
            try {
              process.kill(child.pid, 0);
              aliveAfter = true;
            } catch {
              aliveAfter = false;
            }
          }
          resolve({ exited: true, exitCode: child.exitCode, signalCode: child.signalCode, aliveAfter });
        }, 50);
      });
    });
  }

  it('**超时路径**：子进程被 kill，exitCode 不再是 null，无孤儿', async () => {
    // 假子宿主：吐一帧 ready 之后**永久挂起**（模拟官方卡死），不响应 stdin 关闭。
    const hangScript = [
      `process.stdout.write(JSON.stringify({zccHost:{type:'ready',bundle:'synthetic',exports:[]}})+'\\n');`,
      `setInterval(()=>{},1000);`
    ].join('');
    /** @type {import('node:child_process').ChildProcess | null} */
    let held = null;
    /** @type {any} */
    let caught;
    const started = Date.now();
    try {
      await runHostSession(
        { op: 'describe' },
        () => undefined,
        {
          bundlePath: STUB_BUNDLE,
          timeoutMs: 400,
          // 不用 host-child：这里测的是**回收**语义，用一个最直接的挂起进程最干净。
          spawnChild: () => {
            held = spawn(process.execPath, ['-e', hangScript], {
              stdio: ['pipe', 'pipe', 'pipe'],
              windowsHide: true
            });
            return /** @type {any} */ (held);
          }
        }
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ code: 'CHILD_TIMEOUT' });
    // 请求本身**不**被 kill 宽限窗拖住（kill 兜底是异步的，不阻塞 settle）。
    expect(Date.now() - started).toBeLessThan(3000);
    // 关键断言：`exitCode` 曾经是 `null`（复审实测的孤儿形态），现在必须不再是。
    const state = await waitForExit(/** @type {any} */ (held), 5000);
    expect(state.exited).toBe(true);
    expect(state.exitCode !== null || state.signalCode !== null).toBe(true);
    expect(state.aliveAfter).toBe(false);
  });

  it('**正常路径**：会话收束后子进程自然退出（不 kill 也能干净收场）', async () => {
    /** @type {import('node:child_process').ChildProcess | null} */
    let held = null;
    /** @type {any[]} */
    const events = [];
    const run = runHostSession({ op: 'describe' }, (e) => events.push(e), {
      bundlePath: STUB_BUNDLE,
      timeoutMs: 12000,
      spawnChild: (args) => {
        const [script, ...rest] = args;
        if (script === undefined) throw new Error('SYNTHETIC_ARGS_EMPTY');
        held = spawn(process.execPath, [script, ...rest], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: { ...buildIsolatedChildEnv(process.env), ZCC_STUB_OBSERVATION_FILE: observationFile }
        });
        return /** @type {any} */ (held);
      }
    });
    await run;
    expect(events.map((e) => e.type)).toEqual(['ready', 'finish']);
    // describe 路径不建会话，替身从 input 读到 end 之后自己返回。
    const state = await waitForExit(/** @type {any} */ (held), 4000);
    expect(state.exited).toBe(true);
    expect(state.exitCode !== null || state.signalCode !== null).toBe(true);
    expect(state.aliveAfter).toBe(false);
  });

  it('**失败路径**：子宿主报 failed 后子进程同样被收束', async () => {
    // 吐一帧 failed 之后**挂起**：模拟"报了失败但自己不退"的最坏情况。
    const failScript = [
      `process.stdout.write(JSON.stringify({zccHost:{type:'failed',code:'SESSION_FAILED',detail:'synthetic failure'}})+'\\n');`,
      `setInterval(()=>{},1000);`
    ].join('');
    /** @type {import('node:child_process').ChildProcess | null} */
    let held = null;
    /** @type {any} */
    let caught;
    try {
      await runHostSession(
        { op: 'describe' },
        () => undefined,
        {
          bundlePath: STUB_BUNDLE,
          timeoutMs: 8000,
          spawnChild: () => {
            held = spawn(process.execPath, ['-e', failScript], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
            return /** @type {any} */ (held);
          }
        }
      );
    } catch (e) {
      caught = e;
    }
    expect(caught.code).toBe('CHILD_EXITED');
    expect(caught.message).toContain('SESSION_FAILED');
    // 失败路径与超时路径共用同一个 finish/reap：挂着的子进程也必须被收束。
    const state = await waitForExit(/** @type {any} */ (held), 5000);
    expect(state.exited).toBe(true);
    expect(state.exitCode !== null || state.signalCode !== null).toBe(true);
    expect(state.aliveAfter).toBe(false);
  });
});

describe('OFFICIAL-HOST · B5 子进程异常文本脱敏', () => {
  it('**49 字符非 sk- 前缀**的 coding-plan api-key 形态被脱敏', () => {
    // CREDDECRYPT §2.3 确证的形态：49 字符、非 sk- 前缀、含一个 `.`。
    const fakeKey = 'Kx7pQm2Zr9TvB4nL8wYcH1dJfS6gA0eU3iO5uXqZ.a1b2';
    const text = `SESSION_FAILED: upstream rejected request, apiKey=${fakeKey} (status 401)`;
    const clean = sanitizeChildDetail(text);
    expect(clean).not.toContain(fakeKey);
    expect(clean).not.toContain('Kx7pQm2Zr9TvB4nL8wYcH1dJfS6gA0eU3iO5uXqZ');
    // 句子其余部分保留，可运维。
    expect(clean).toContain('upstream rejected request');
    expect(clean).toContain('status 401');
  });

  it('`eyJ` JWT 形态（含被截断的单段）被脱敏', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(sanitizeChildDetail(`AUTH: token ${jwt} rejected`)).not.toContain(jwt);
    // 被子宿主 400 字符上限截断的裸 eyJ 段也要拦。
    const truncated = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    expect(sanitizeChildDetail(`AUTH: header began ${truncated}…`)).not.toContain(truncated);
  });

  it('**长随机段**（≥32 位无分隔连续段）被脱敏，但 64 位 hex 指纹不误伤', () => {
    const long = 'A1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvWxYz0123456789_-';
    expect(sanitizeChildDetail(`BOOM: token ${long} expired`)).not.toContain(long);
    // 既有契约：64 位纯 hex 是证据指纹，不是凭据。
    const fingerprint = 'a'.repeat(64);
    expect(sanitizeChildDetail(`PROBE: fingerprint ${fingerprint} recorded`)).toContain(fingerprint);
  });

  it('**sk- 前缀**、Bearer、Authorization 三种老形态仍被脱敏（口径不倒退）', () => {
    expect(sanitizeChildDetail('X: sk-abcdefghijklmnopqrstuvwx')).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(sanitizeChildDetail('X: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
    expect(sanitizeChildDetail('X: Authorization: ZZZZZZZZZZZZZZZZZZZ')).not.toContain('ZZZZZZZZZZZZZZZZZZ');
  });

  it('**不含凭据形态的正常失败原因原样保留**（净化不是一刀切丢弃）', () => {
    expect(sanitizeChildDetail('CHANNEL_REFUSED: paid channel blocked')).toContain('paid channel blocked');
    expect(sanitizeChildDetail('SESSION_TIMEOUT: 会话在墙钟上限内没有收到终态事件')).toContain('墙钟上限');
  });

  it('超长文本被截断（且截断发生在脱敏之后）', () => {
    const long = `${'word '.repeat(200)}`;
    const clean = sanitizeChildDetail(`X: ${long}`);
    expect(clean.length).toBeLessThan(long.length);
    expect(clean).toContain('已截断');
  });

  it('**43 字符「30+1+12」形态的 key 不再进错误消息**（BL-3：上一版逐段判定，这一形态原样泄漏）', () => {
    // 复审 §6.2 的决定性样本：43 字符 = 30 段 + `.` + 12 段，两段都 < 32。
    // 上一版规则 `\b(?![0-9a-fA-F]{64}\b)[A-Za-z0-9_-]{32,}\b` **逐段**判定，漏拦。
    const head = 'Kx7pQr2Zm9TvB4nL8wYcH1dJfS6gA0';
    const fakeKey = `${head}.a1b2c3d4e5f6`;
    expect(head.length).toBe(30);
    expect(fakeKey.length).toBe(43);
    const clean = sanitizeChildDetail(`SESSION_FAILED: upstream 401 apiKey=${fakeKey} status=403`);
    expect(clean).not.toContain(fakeKey);
    expect(clean).not.toContain(head);
    // 句子其余部分保留，可运维。
    expect(clean).toContain('upstream 401');
    expect(clean).toContain('status=403');
  });

  it('**UUID 形态不被误伤**（BL-3 反向：`chatcmpl-<uuid>` 上一版被当成凭据）', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    // 本仓 `operationId = \`chatcmpl-${randomUUID()}\``（packages/api/src/server.ts）就是这个形态。
    const operationId = `chatcmpl-${uuid}`;
    expect(operationId.length).toBe(45);
    expect(sanitizeChildDetail(`SESSION_FAILED: op ${operationId} failed`)).toContain(operationId);
    // 裸 UUID 也一样（36 字符 ≥ 32，上一版会命中）。
    expect(sanitizeChildDetail(`X: ${uuid}`)).toContain(uuid);
    // 既有契约：64-hex 指纹仍然不误伤。
    expect(sanitizeChildDetail(`PROBE: ${'a'.repeat(64)}`)).toContain('a'.repeat(64));
  });

  it('**端到端**：经真实子宿主通道，含假 key 的 detail 到达 API 错误消息时已被脱敏', async () => {
    for (const fakeKey of [
      'Kx7pQm2Zr9TvB4nL8wYcH1dJfS6gA0eU3iO5uXqZ.a1b2',
      `${'Kx7pQr2Zm9TvB4nL8wYcH1dJfS6gA0'}.a1b2c3d4e5f6`
    ]) {
      const script = `process.stdout.write(JSON.stringify({zccHost:{type:'failed',code:'SESSION_FAILED',detail:'upstream 401 apiKey=${fakeKey}'}})+'\\n');`;
      /** @type {any} */
      let caught;
      try {
        await runHostSession({ op: 'describe' }, () => undefined, {
          bundlePath: STUB_BUNDLE,
          timeoutMs: 8000,
          spawnChild: () => spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
        });
      } catch (e) {
        caught = e;
      }
      expect(caught.message).toContain('SESSION_FAILED');
      expect(caught.message).not.toContain(fakeKey);
      // 点号前段也不能残留。
      expect(caught.message).not.toContain(fakeKey.split('.')[0]);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* HOSTFIX6 · B-1：官方 app-server 的 stderr 必须被 drain                        */
/* -------------------------------------------------------------------------- */

/**
 * ## 这段测的是什么
 *
 * 复审（HOSTFIX5 §3.4）在 `%TEMP%` 上做过一组 A/B 实测，发现 HOSTFIX5 换轨引入的
 * **第二层**管道（host-child → 官方 app-server）**没有**对应上一层的 stderr 处理：
 * `host-driver.ts:887-890` 对**子宿主**的 stderr 是显式 drain 且只计数的，而
 * `host-child.mjs` 的 `spawnAppServer` 原来**从不碰** `child.stderr`。
 *
 * `stdio: ['pipe','pipe','pipe']` 造出来的是**真实匿名管道**：读端没人读 ⇒ 写端
 * 写满缓冲（Windows 典型 64 KB）就**永久阻塞**。复审实测的曲线是
 * 8/32/64 KB 首帧照样到达、200/1000 KB **永不到达**。症状在 `run` 路径上就是
 * "挂满 300 s 墙钟上限报 `SESSION_TIMEOUT`"——与 2026-10-01 实弹第二轮
 * （300041 ms 后 502 `upstream_outcome_unknown`，无崩溃无错误码）**同形**。
 *
 * ## 三条断言各自的分工
 *
 *  1. **A/B 曲线**（替身端）：`stderrFloodWrittenBytes` 证明替身**真的写出去**了
 *     那么多字节——没有这一条，"会话跑通了"就可能只是因为洪流压根没发生。
 *  2. **不挂死**（生产端）：整条会话正常收束、终态事件齐全。这条在**没有** drain
 *     时是红的（`runHostSession` 超时 → `CHILD_TIMEOUT`），已用变异体实测。
 *  3. **只计数不转发**（边界）：父通道帧**一条 stderr 内容都不许出现**，
 *     且 `attachAppServerStderrDrain` 返回的计数器**不保留**任何内容。
 */
describe('OFFICIAL-HOST · HOSTFIX6 B-1：官方 app-server 的 stderr 被 drain（≥256 KB 不挂死）', () => {
  /** 复审实测的阻塞阈值在 64–200 KB 之间；这里取 256 KB，落在"必然阻塞"那一侧。 */
  const FLOOD_BYTES = 256 * 1024;

  it('**describe 路径**：替身先往 stderr 灌 256 KB，`ready` + `finish` 仍然到达、exit 0', async () => {
    /** @type {any[]} */
    const events = [];
    /** @type {Array<[string, string | undefined]>} */
    const saved = [];
    const merged = { ZCC_STUB_STDERR_BYTES: String(FLOOD_BYTES) };
    for (const [k, v] of Object.entries(merged)) {
      saved.push([k, process.env[k]]);
      process.env[k] = v;
    }
    /** @type {any} */
    let caught = null;
    let result = null;
    try {
      result = await runHostSession({ op: 'describe' }, (e) => events.push(e), {
        bundlePath: STUB_BUNDLE,
        timeoutMs: 20000,
        spawnChild: (args) => {
          const [script, ...rest] = args;
          if (script === undefined) throw new Error('SYNTHETIC_ARGS_EMPTY');
          const env = buildIsolatedChildEnv(process.env);
          env['ZCC_STUB_OBSERVATION_FILE'] = observationFile;
          return spawn(process.execPath, [script, ...rest], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
        }
      });
    } catch (e) {
      caught = e;
    }
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // 断言 1：洪流真的发生了（否则这条用例是空转）。
    // `describe` 路径下替身的 stdin **一个字节都收不到**（零发送），所以这里的
    // 就绪谓词是"洪流字节数 > 0"，不是 `sawInput`。
    const observedHere = await waitForObservation((v) => Number(v?.stderrFloodWrittenBytes) > 0, 8000, () => caught !== null);
    expect(observedHere.stderrFloodRequestedBytes).toBe(FLOOD_BYTES);
    expect(observedHere.stderrFloodWrittenBytes).toBe(FLOOD_BYTES);
    // 断言 2：**没有**因为 stderr 堵死而失败。没有 drain 时这里是
    // `BUNDLE_SPAWN_FAILED`（5 s 内没有首帧）。
    expect(caught, `stderr 灌了 ${FLOOD_BYTES} 字节仍必须拿到首帧`).toBeNull();
    expect(result).not.toBeNull();
    expect(events.map((e) => e.type)).toEqual(['ready', 'finish']);
  });

  it('**run 路径（实弹同形的那条）**：256 KB stderr 洪流下整条会话正常收束', async () => {
    const { events, childError } = await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      { ZCC_STUB_STDERR_BYTES: String(FLOOD_BYTES) },
      25000
    );
    // 断言 1：洪流真的发生了。
    expect(observed.stderrFloodWrittenBytes).toBe(FLOOD_BYTES);
    // 断言 2：会话没被堵死，且**完整收束**。没有 drain 时这里会挂在 300 s
    // 墙钟上限（测试里表现为 `CHILD_TIMEOUT`），或者拿不到 sessionId。
    expect(childError).toBeNull();
    // **实弹逐字**：33 段正文增量 + usage + finish（见 expectRealShotStream）。
    expectRealShotStream(events);
    // 断言 3：**stderr 内容一条都不许进父通道**。洪流是 256 KB 纯 'a'；
    // 父通道帧里出现它就等于我们把官方 stderr 转发/记录了。
    const wire = events.map((e) => JSON.stringify(e));
    for (const line of wire) {
      expect(line.length, '父通道帧长度必须与洪流规模无关').toBeLessThan(FLOOD_BYTES);
      expect(line).not.toContain('aaaa');
    }
  });

  it('**drain 只计数、不保留内容**：`attachAppServerStderrDrain` 返回的只有字节数', async () => {
    const { attachAppServerStderrDrain } = await import('../../scripts/official-host/host-child.mjs');
    const { Readable } = await import('node:stream');
    // 一个**最小的假 child**：只有 `stderr` 一条流。生产函数对它只挂监听器 + resume。
    const stderr = new Readable({ read() {} });
    const child = /** @type {any} */ ({ stderr, on: () => undefined });
    const stderrBytes = attachAppServerStderrDrain(child);
    expect(stderrBytes()).toBe(0);
    // 流是 flowing 的（这才是 "drain" 的实质：不读就不 drain）。
    expect(stderr.readableFlowing).toBe(true);
    stderr.push(Buffer.alloc(1024, 0x61));
    stderr.push('bc');
    await new Promise((r) => setImmediate(r));
    expect(stderrBytes()).toBe(1026);
    // 计数器是**唯一**的出口：返回值是个函数，不带任何内容字段。
    expect(typeof stderrBytes).toBe('function');
    expect(Object.keys(stderrBytes())).toEqual([]);
    // 监听器确实挂上去了（data / error 两件事各自可查；resume 由 flowing 证明）。
    expect(stderr.listenerCount('data')).toBe(1);
    expect(stderr.listenerCount('error')).toBe(1);
    // 静态面：生产代码里**不许**出现把 stderr 内容收集起来的写法。
    const code = stripComments(readFileSync(resolveHostChildScript(), 'utf8'));
    expect(code).toContain('attachAppServerStderrDrain');
    expect(code).toContain('child.stderr?.resume()');
    expect(code).not.toMatch(/stderr\?\.on\('data',\s*\(chunk\)\s*=>\s*\{\s*return/);
  });

  it('**spawn 之后立刻接上 drain**（不是挂在调用方——`describe` 与 `run` 共用同一个 spawn 点）', async () => {
    const code = stripComments(readFileSync(resolveHostChildScript(), 'utf8'));
    const spawnFn = code.slice(code.indexOf('function spawnAppServer('));
    const body = spawnFn.slice(0, spawnFn.indexOf('\n}'));
    expect(body).toContain('attachAppServerStderrDrain(child)');
    // drain 必须在 `return child` **之前**。
    expect(body.indexOf('attachAppServerStderrDrain(child)')).toBeLessThan(body.indexOf('return child'));
  });
});

/* -------------------------------------------------------------------------- */
/* HOSTFIX6 · 诊断开关接通（入口闭集 → 透传 → 失败路径也有诊断行）                  */
/* -------------------------------------------------------------------------- */

/**
 * ## 这段测的是工单 D1 与"失败路径打不出诊断行"那条盲区
 *
 * HOSTFIX4 立了 `ZCC_HOST_DEBUG` 开关，但两处让它在实弹里**用不起来**：
 *  1. **入口闭集不认识它**（`start-api.mjs` 的 `ENTRY_ENV_KEYS` 里没有 `ZCC_HOST_DEBUG`），
 *     设了就是 `UNKNOWN_ENV_KEY` **拒绝启动**——实测过；
 *  2. **只在成功路径打**。`driveSession` 抛错时摘要压根没被构造，于是
 *     `SESSION_TIMEOUT` / `SESSION_CREATE_NO_SESSION_ID` 这两类**最需要诊断**的失败
 *     一行都打不出来。2026-10-01 实弹第二轮挂满 300 s 就是这么没有线索的。
 */
describe('OFFICIAL-HOST · HOSTFIX6 诊断开关接通到入口与失败路径', () => {
  it('**`buildIsolatedChildEnv` 透传 `ZCC_HOST_DEBUG=1`**（它不在被剥掉的键里）', () => {
    expect(HOST_DEBUG_ENV_KEY).toBe('ZCC_HOST_DEBUG');
    // 显式给 1 → 下发。
    expect(buildIsolatedChildEnv({ [HOST_DEBUG_ENV_KEY]: '1' })[HOST_DEBUG_ENV_KEY]).toBe('1');
    // **缺省不新增这个键**：默认配置下子宿主 env 与 HOSTFIX5 逐字一致。
    // （"悄悄塞一个 ZCC_HOST_DEBUG=0 进去"不是等价改动——那会让官方 app-server
    //  也看见一个它不需要的键。）
    expect(Object.keys(buildIsolatedChildEnv({}))).not.toContain(HOST_DEBUG_ENV_KEY);
    // 显式给 0 时**值就是 '0'**：`buildChildEnv` 本来就全量透传（它不在被剥掉的键里），
    // 显式分支只把 '1' 那一条从"碰巧成立"变成"被断言的事实"。
    expect(buildIsolatedChildEnv({ [HOST_DEBUG_ENV_KEY]: '0' })[HOST_DEBUG_ENV_KEY]).toBe('0');
  });

  it('**失败路径也打出诊断行**，且带 `failed: true` 与阶段定位', async () => {
    // 让替身在**收到 `session/create` 之后立刻非零退出**：于是驱动等的是一个
    // 永远不会来的回执，`outboundDone` 落定后立刻抛 `SESSION_CREATE_NO_SESSION_ID`。
    // 走的分支与实弹"挂满 300 s"**完全同一条**，只是不花 300 s。
    const { stderrChunks, events, childError } = await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      {
        [HOST_DEBUG_ENV_KEY]: '1',
        ZCC_STUB_EXIT_AFTER_METHOD: 'session/create'
      },
      12000,
      sawMethod('session/create')
    );
    // 这次是真的失败了（否则下面那条"失败时打诊断行"就是恒真断言）。
    expect(childError).not.toBeNull();
    expect(String(/** @type {any} */ (childError).message)).toContain('SESSION_CREATE_NO_SESSION_ID');
    expect(observed.exitedAfterMethod).toBe('session/create');
    // 父通道事件序列**没有**多出任何东西：诊断行只走 stderr。
    expect(events.map((e) => e.type)).toEqual(['ready']);
    const stderr = await waitForStderrText(stderrChunks, (t) => t.includes('ZCC_HOST_DEBUG '));
    const line = stderr.split('\n').find((l) => l.startsWith('ZCC_HOST_DEBUG '));
    expect(line).toBeDefined();
    const summary = JSON.parse(String(line).slice('ZCC_HOST_DEBUG '.length));
    // **这就是实弹第二轮缺的那一行**：`failed: true` + 阶段定位。
    expect(summary.failed).toBe(true);
    // 挂在 `session/create`：**没拿到 sessionId**，所以 `sessionCreate` 是 `null`
    // 而 `total` 已经不小——这一对数值就是"挂在哪一段"的答案。
    expect(summary.phaseDurationsMs.sessionCreate).toBeNull();
    expect(summary.phaseDurationsMs.turn).toBeNull();
    expect(summary.phaseDurationsMs.total).toBeGreaterThanOrEqual(0);
    // 偏好请求**还没来得及发**（`session/create` 的应答是在拿到偏好应答之后才发的），
    // 所以这里两条反向请求计数都应是 0。凭据闸门与偏好闸门**都没被触达过**——
    // 这正是"挂在 create 阶段"与"挂在 turn 阶段"的可观测差别。
    expect(summary.reverseRequestsAnswered).toBe(0);
    expect(summary.reverseRequestsByMethod).toEqual({});
    expect(summary.lastRuntimePreferences).toBeNull();
    expect(summary.lastReverse).toBeNull();
    // 零凭据：失败诊断行同样不得含凭据形态。
    expect(stderr).not.toContain(STUB_CREDENTIAL_PLAINTEXT);
    expect(stderr).not.toContain(STUB_CREDENTIAL_SECRET);
    expect(stderr).not.toContain('apiKey');
  });

  it('**缺省关闭时失败路径也不打诊断行**（开关的守卫对两条路径都成立）', async () => {
    const { stderrChunks, childError } = await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      { ZCC_STUB_EXIT_AFTER_METHOD: 'session/create' },
      12000,
      sawMethod('session/create')
    );
    expect(childError).not.toBeNull();
    expect(String(/** @type {any} */ (childError).message)).toContain('SESSION_CREATE_NO_SESSION_ID');
    const stderr = await settleStderr(stderrChunks);
    expect(stderr).not.toContain('ZCC_HOST_DEBUG');
  });

  it('**字面量只有一份**：入口闭集、host-driver 常量、session-drive 重导出三处同值', async () => {
    const entry = await import('../../packages/api/bin/start-api.mjs');
    const driver = await import('../../packages/official-host/src/host-driver.js');
    const drive = await import('../../scripts/official-host/session-drive.mjs');
    // 入口的闭集里**必须有**这个键（否则设了就 `UNKNOWN_ENV_KEY` 拒绝启动）。
    expect(entry.ENTRY_ENV_KEYS).toContain(HOST_DEBUG_ENV_KEY);
    // 取值闭集与缺省。
    expect(entry.ENTRY_HOST_DEBUG_VALUES).toEqual(['0', '1']);
    expect(entry.ENTRY_DEFAULT_HOST_DEBUG).toBe('0');
    // 纯函数解析：缺省 0；精确 0/1 通过；其余一律 `HOST_DEBUG_UNKNOWN`。
    expect(entry.parseHostDebug(undefined)).toBe('0');
    expect(entry.parseHostDebug('0')).toBe('0');
    expect(entry.parseHostDebug('1')).toBe('1');
    expect(entry.parseHostDebug(' 1 ')).toBe('1');
    for (const bad of ['2', 'true', 'yes', 'on', 'off', '']) {
      /** @type {any} */
      let thrown = null;
      try {
        entry.parseHostDebug(bad);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, `ZCC_HOST_DEBUG=${JSON.stringify(bad)} 必须被拒`).not.toBeNull();
      expect(thrown.code).toBe('HOST_DEBUG_UNKNOWN');
    }
    // 三处常量同值（不硬写第二份字面量——那是"两处漂移"那种缺陷）。
    expect(driver.HOST_DEBUG_ENV_KEY).toBe(HOST_DEBUG_ENV_KEY);
    expect(drive.HOST_DEBUG_ENV_KEY).toBe(HOST_DEBUG_ENV_KEY);
    // 入口解析器**不**因为选了别的驱动就放行拼错值：调试开关一律校验。
    for (const driverName of ['none', 'local-official', 'official-host']) {
      /** @type {any} */
      let thrown = null;
      try {
        entry.parseEntryOptions([], { ZCC_API_KEY: 'x'.repeat(16), ZCC_DRIVER: driverName, ZCC_HOST_DEBUG: '2' });
      } catch (e) {
        thrown = e;
      }
      expect(thrown, `driver=${driverName} 时 ZCC_HOST_DEBUG=2 也必须被拒`).not.toBeNull();
      expect(thrown.code).toBe('HOST_DEBUG_UNKNOWN');
    }
    // 合法值在任一驱动下都**不**被拦（缺省 0 / 显式 1）。
    for (const driverName of ['none', 'local-official', 'official-host']) {
      expect(entry.parseEntryOptions([], { ZCC_API_KEY: 'x'.repeat(16), ZCC_DRIVER: driverName }).hostDebug).toBe('0');
      expect(
        entry.parseEntryOptions([], { ZCC_API_KEY: 'x'.repeat(16), ZCC_DRIVER: driverName, ZCC_HOST_DEBUG: '1' }).hostDebug
      ).toBe('1');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* HOSTFIX6 · 300 s 挂死的两条根因（账号帧形状 + 错误应答被丢弃）                  */
/* -------------------------------------------------------------------------- */

/**
 * ## 这两条是 2026-10-01 实弹第二轮"挂满 300 s"的**根因**，不是猜测
 *
 * 协调者亲跑那一轮的现象是 `300041 ms` 后 `502 upstream_outcome_unknown`，无崩溃无错误码。
 * 本轮用 `%TEMP%` **直连探针**（绕过 host-child、自己当协议客户端、**零模型发送**）
 * 拿到了官方逐字回执：
 *
 * ```
 * 错误应答 id=<我们发的账号帧> code=-32603
 *   data.name = "ZodError"
 *   issues    = [{ code:"unrecognized_keys",
 *                  keys:["accountType","mode"],
 *                  path:["account:zai-start-plan","access"],
 *                  message:'Unrecognized keys: "accountType", "mode"' }]
 * ```
 *
 * 官方 `Qtr`（= `parseAccountProviderConfigMap`）逐字
 * `m.record(m.string().min(1), s3i).parse(e)`，其中
 * `s3i = kz.pick({builtinModelIds:!0}).extend({access: fWt.pick({type:!0, entitled:!0}).nullable().optional()})`
 * ——**`access` 只认 `type` 与 `entitled`**。于是：
 *
 * 1. 账号快照整份没进去 → Provider Registry 里没有 `account:zai-start-plan`
 *    → 官方 `session/create` 在 **482 ms** 就抛
 *    `Provider Registry 中不存在 Model: account:zai-start-plan/GLM-5.3-Flash`；
 * 2. 而驱动**把这条错误应答当普通行塞进 `pending`**（没有 sessionId），
 *    然后空转到 `SESSION_TIMEOUT_MS = 300_000` → `SESSION_CREATE_NO_SESSION_ID`。
 *
 * 也就是说：**"挂死"是第二条**（错误应答被丢弃），**"为什么被拒"是第一条**。
 * 两条都要修：只修第一条，剩下的官方错误还是会伪装成 300 s 挂死。
 */
describe('OFFICIAL-HOST · HOSTFIX6 300 s 挂死的两条根因', () => {
  it('**账号快照的 `access` 只有 `type` 与 `entitled`**（官方 `s3i` 逐字形状）', async () => {
    const { buildAccountConfigPatch } = await import('../../scripts/official-host/session-drive.mjs');
    const patch = await buildAccountConfigPatch(
      { providerId: 'account:zai-start-plan', planMode: 'start-plan', entitled: true, operationId: 'x' },
      'zcode-builtin:30:deadbeef'
    );
    expect(patch).not.toBeNull();
    const provider = /** @type {any} */ (patch)['providers']['account:zai-start-plan'];
    // **官方 `.strict()` 之下多一个键就整帧被拒**——这两个键是本轮实测的根因。
    expect(Object.keys(provider.access).sort()).toEqual(['entitled', 'type']);
    expect(provider.access.type).toBe('zhipu-account');
    expect(typeof provider.access.entitled).toBe('boolean');
    // 整条 provider 也只允许 `builtinModelIds` 与 `access`（`kz.pick({builtinModelIds:!0})`）。
    expect(Object.keys(provider).sort()).toEqual(['access']);
    // 反向锁：把那两个键加回去，本用例必须红。
    expect(Object.keys(provider.access)).not.toContain('accountType');
    expect(Object.keys(provider.access)).not.toContain('mode');
    // `states` 那一侧不变（官方 `CGt` 逐字允许 `current`）。
    expect(Object.keys(/** @type {any} */ (patch)['states']['account:zai-start-plan']).sort()).toEqual([
      'availability',
      'current',
      'entitled'
    ]);
  });

  it('`describeOfficialError` 只取 `code` + `message`，**不取** `data.stack`', async () => {
    const { describeOfficialError } = await import('../../scripts/official-host/session-drive.mjs');
    // 实弹那条逐字形状（含 `data.stack` 里的绝对路径与产物内部符号名）。
    const zod = {
      id: 'acct-1',
      error: {
        code: -32603,
        data: {
          name: 'ZodError',
          stack:
            'ZodError: [\n  {\n    "code": "unrecognized_keys",\n    "keys": [\n      "accountType"\n    ]\n  }\n]\n    at parseAccountProviderConfigMap (C:\ZCode\resources\glm\zcode.cjs:71:26784)'
        },
        message:
          '[\n  {\n    "code": "unrecognized_keys",\n    "keys": [\n      "accountType",\n      "mode"\n    ],\n    "path": [\n      "account:zai-start-plan",\n      "access"\n    ],\n    "message": "Unrecognized keys: \\"accountType\\", \\"mode\\""\n  }\n]'
      }
    };
    const text = describeOfficialError(zod);
    expect(text).not.toBeNull();
    expect(String(text)).toContain('code=-32603');
    // actionable 的那部分在 `message` 里：zod 的 issues JSON。
    expect(String(text)).toContain('unrecognized_keys');
    expect(String(text)).toContain('accountType');
    // **绝对路径与内部符号名一律不许出现**（`data.stack` 不得被转发）。
    expect(String(text)).not.toContain('C:\ZCode');
    expect(String(text)).not.toContain('parseAccountProviderConfigMap');
    expect(String(text)).not.toContain('zcode.cjs');
    // 其它形态。
    expect(describeOfficialError({ id: 1, error: { code: -32022, message: 'Client request timed out' } })).toBe(
      'code=-32022 message=Client request timed out'
    );
    expect(describeOfficialError({ id: 1, result: {} })).toBeNull();
    expect(describeOfficialError({ id: 1 })).toBeNull();
    expect(describeOfficialError(null)).toBeNull();
    expect(describeOfficialError([])).toBeNull();
    // 超长 message 必须被截断（`fail()` 与 `sanitizeChildDetail` 之后还有两道上限）。
    expect(String(describeOfficialError({ id: 1, error: { code: -1, message: 'x'.repeat(1000) } })).length)
      .toBeLessThan(300);
  });

  it('`findOfficialErrorFor` **只认 id 精确相等**（不误伤别的请求的错误）', async () => {
    const { findOfficialErrorFor } = await import('../../scripts/official-host/session-drive.mjs');
    const lines = [
      JSON.stringify({ method: 'startup/storageState', params: { sessionId: 'not-a-frame-id' } }),
      JSON.stringify({ id: 'server-1', result: { independentPlanState: true } }),
      JSON.stringify({ id: 'other-request', error: { code: -32018, message: '别的请求失败' } })
    ];
    expect(findOfficialErrorFor(lines, 'acct-1')).toBeNull();
    expect(findOfficialErrorFor(lines, 'other-request')).toBe('code=-32018 message=别的请求失败');
    // id 的类型宽松（官方 id 可能是数字）。
    expect(findOfficialErrorFor([JSON.stringify({ id: 7, error: { code: -1, message: 'm' } })], '7')).toBe('code=-1 message=m');
    expect(findOfficialErrorFor(['(非 JSON)'], 'acct-1')).toBeNull();
  });

  it('**官方拒了账号帧 → 毫秒级 `ACCOUNT_CONFIG_REJECTED`，不再空转 300 s**', async () => {
    const { stderrChunks, childError } = await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      { ZCC_STUB_REJECT_ACCOUNT_CONFIG: 'zod' },
      12000,
      sawMethod('provider/updateAccountConfig')
    );
    // **毫秒级失败**：替身收到账号帧就回错误应答，驱动必须立刻失败化。
    // 没有这条检查时，驱动会把这条错误应答当普通行丢掉，一路空转到 300 s
    // 墙钟上限（测试里表现为 `CHILD_TIMEOUT`）。
    expect(childError).not.toBeNull();
    expect(String(/** @type {any} */ (childError).message)).toContain('ACCOUNT_CONFIG_REJECTED');
    // 逐字钉住**实弹那条** ZodError 短描述：官方拒了什么、拒在哪，一眼可见。
    const message = String(/** @type {any} */ (childError).message);
    expect(message).toContain('ACCOUNT_CONFIG_REJECTED: code=-32603');
    expect(message).toContain('unrecognized_keys');
    expect(message).toContain('accountType');
    // 官方 `data.stack` 里的绝对路径与内部符号名**不得**被转发。
    expect(message).not.toContain('C:\ZCode');
    expect(message).not.toContain('zcode.cjs');
    // **根本没走到 session/create**：父通道帧只有 `ready`。
    // （观测文件里 `didReceiveSessionCreate` 为 false 就是这条断言的替身证据。）
    expect(observed.didReceiveSessionCreate).toBe(false);
    // 失败诊断行照旧能打出来（阶段标记落在 accountConfig 之前 → 全为 null）。
    const stderr = stderrChunks.join('');
    expect(stderr).not.toContain('ZCC_HOST_DEBUG');
  });

  it('**官方拒了 `session/create` → 毫秒级 `SESSION_CREATE_REJECTED`**', async () => {
    const { stderrChunks, childError } = await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      { [HOST_DEBUG_ENV_KEY]: '1', ZCC_STUB_REJECT_SESSION_CREATE: '1' },
      12000,
      sawMethod('session/create')
    );
    expect(childError).not.toBeNull();
    const message = String(/** @type {any} */ (childError).message);
    expect(message).toContain('SESSION_CREATE_REJECTED');
    expect(message).toContain('code=-32018');
    // 失败诊断行这一条**必须**有：它就是"挂在哪个阶段"的答案。
    const line = stderrChunks.join('').split('\n').find((l) => l.startsWith('ZCC_HOST_DEBUG '));
    expect(line).toBeDefined();
    const summary = JSON.parse(String(line).slice('ZCC_HOST_DEBUG '.length));
    expect(summary.failed).toBe(true);
    expect(summary.phaseDurationsMs.sessionCreate).toBeNull();
    expect(summary.phaseDurationsMs.turn).toBeNull();
    // 账号帧**过了**（所以 accountConfig 有值）——这正是"被拒的是 create 不是账号"的可观测差别。
    expect(summary.phaseDurationsMs.accountConfig).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* HOSTFIX6 · 第三、四条根因：session/create 的 model 形状与应答形状               */
/* -------------------------------------------------------------------------- */

/**
 * ## 这两条是被**实弹逐字帧**钉出来的，不是推断
 *
 * 2026-10-01 直连探针（绕过 host-child、自己当协议客户端、**零模型发送**）拿到的官方
 * `session/create` 成功应答逐字：
 *
 * ```
 * {"id":"probe-create-2","result":{
 *    "messages":[], "projection":{…,"sessionId":"unknown",…},
 *    "protocol":{…}, "runtime":{…},
 *    "session":{…,"sessionId":"sess_55bc17d1-…",…}, "settings":{…}}}
 * ```
 *
 * 真 sessionId 在 **`result.session.sessionId`（四层深）**；而
 * `projection.sessionId` 是字面量 **`"unknown"`** 的**诱饵**。
 * 上一版 `extractSessionId` 只查三处更浅的路径，**一处都不命中** ⟹ 恒 `null` ⟹
 * 驱动在 `session/create` 上空转到 300 s，而官方 `session_create.completed`
 * 早就成功（实测 643 ms）。**这就是"官方成功了、我们还在等"的那 300 秒。**
 *
 * 前一条（model 形状）见上面 `createFrame.params.model` 的断言注释：
 * `ModelProtocolError: Reasoning level is required for …`。
 */
describe('OFFICIAL-HOST · HOSTFIX6 session/create 的 model 与应答形状（实弹逐字）', () => {
  it('`extractSessionId` 认得出**实弹那份四层深**的 `result.session.sessionId`', async () => {
    const { extractSessionId } = await import('../../scripts/official-host/session-drive.mjs');
    // 实弹逐字（裁剪到与本断言相关的字段；其余字段不影响 sessionId 的定位）。
    const real = JSON.stringify({
      id: 'zcc-host-op-1',
      result: {
        messages: [],
        projection: { mode: 'build', sessionId: 'unknown', status: 'idle', totalTokenCount: 0, turnCount: 0 },
        protocol: { name: 'ZCode Protocol', version: 1 },
        runtime: { eventSeq: 0, stateRevision: 2 },
        session: {
          createdAt: 1790856922143,
          mode: 'build',
          model: { providerId: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash' },
          sessionId: 'sess_55bc17d1-54a8-4e51-87a6-aad6a4736407',
          sessionKind: 'interactive',
          status: 'idle'
        },
        settings: { mode: { current: 'build' } }
      }
    });
    expect(extractSessionId([real])).toBe('sess_55bc17d1-54a8-4e51-87a6-aad6a4736407');
    // **绝不能认 `projection.sessionId` 那个 `"unknown"` 诱饵。**
    const onlyDecoy = JSON.stringify({ id: 'x', result: { projection: { sessionId: 'unknown' } } });
    expect(extractSessionId([onlyDecoy])).toBeNull();
    // 更浅的三条路径**仍然**认（兼容旧形状与裸形态），且都不接受 "unknown"。
    expect(extractSessionId([JSON.stringify({ sessionId: 's1' })])).toBe('s1');
    expect(extractSessionId([JSON.stringify({ result: { sessionId: 's2' } })])).toBe('s2');
    expect(extractSessionId([JSON.stringify({ session: { sessionId: 's3' } })])).toBe('s3');
    expect(extractSessionId([JSON.stringify({ sessionId: 'unknown' })])).toBeNull();
    expect(extractSessionId([JSON.stringify({ result: { sessionId: 'unknown' } })])).toBeNull();
    expect(extractSessionId([JSON.stringify({ session: { sessionId: 'unknown' } })])).toBeNull();
    // 噪音不影响定位。
    expect(extractSessionId(['(非 JSON)', JSON.stringify({ method: 'session/event', params: {} }), real])).toBe(
      'sess_55bc17d1-54a8-4e51-87a6-aad6a4736407'
    );
  });

  it('**未映射事件类型被逐字计数**（"官方答完了、我们没接住"那条失败的唯一可观测点）', async () => {
    // **HOSTFIX7 更正 HOSTFIX6 第五根因的前提。**
    //
    // HOSTFIX6 读的是官方**日志 / SQLite** 里的内部枚举 `lt`（下划线：
    // `turn_started` / `model_complete` / `turn_complete` / …）并据此判定
    // "官方线上事件是下划线闭集，我们的点号表全错"。**那个判定是错的**——
    // 逐字见官方产物：`mapSessionEvent`（`$xt`，偏移 14416723）逐字
    // `type: jZa(e.type)`，而 `jZa`（偏移 14430066）把
    // `lt.TurnComplete` → `"turn.completed"`、`lt.TurnError` → `"turn.failed"`、
    // `lt.ModelStreaming` → `"model.streaming"`，`default` → `"session.updated"`。
    // 导出的线上闭集（`zcodeSessionEventEnvelopeSchema` = `eGt`，偏移 755406）是 **25 项点号**。
    //
    // 下划线闭集**不上线**：它只出现在官方自己的日志与 SQLite 里
    // （实弹逐字 `"sessionEventType":"turn_complete"`）。把点号表换成下划线表，
    // 会让每一条事件都不被认——**比现在更糟**。
    const drive = await import('../../scripts/official-host/session-drive.mjs');
    // 闭集逐字：25 项、全点号、顺序与官方 `eGt` 逐字一致。
    expect(drive.OFFICIAL_SESSION_EVENT_TYPES).toEqual([
      'session.created',
      'session.resumed',
      'session.updated',
      'session.titleUpdated',
      'session.closed',
      'turn.started',
      'turn.steerQueued',
      'turn.steerDrained',
      'turn.completed',
      'turn.failed',
      'message.upserted',
      'message.removed',
      'part.started',
      'part.delta',
      'part.upserted',
      'part.removed',
      'model.streaming',
      'tool.updated',
      'permission.requested',
      'permission.resolved',
      'userInput.requested',
      'userInput.resolved',
      'checkpoint.created',
      'rewind.triggered',
      'streamRecovery.updated'
    ]);
    expect(drive.OFFICIAL_SESSION_EVENT_TYPES).toHaveLength(25);
    // 闭集里**没有**任何下划线项——把"下划线闭集"这个已被证伪的假设钉死。
    expect(drive.OFFICIAL_SESSION_EVENT_TYPES.filter((t) => t.includes('_'))).toEqual([]);
    // 下划线字面量映射不出任何东西（它们**不是**线上类型）。
    for (const internalType of ['turn_started', 'model_request', 'model_complete', 'turn_complete', 'turn_error']) {
      expect(drive.mapOfficialEventToChannel({ method: 'session/event', params: { type: internalType, payload: {} } })).toEqual([]);
    }
    // 键数封顶常量在，且是正整数（诊断行不会无界增长）。
    expect(drive.UNMAPPED_EVENT_TYPE_CAP).toBeGreaterThan(0);
    // 端到端：替身只发它认得的那两种（`model.streaming` / `turn.completed`），
    // 所以表是空的——**不是恒真断言**：下面两条证明"非空时会真的被记下来"。
    const { childError, stderrChunks } = await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      { [HOST_DEBUG_ENV_KEY]: '1' },
      12000,
      sawMethod('session/close')
    );
    expect(childError).toBeNull();
    // **必须等**：子进程的 `exit` 与 stderr 的 `data` 是两条流（见 waitForStderrText 的注释）。
    const stderr = await waitForStderrText(stderrChunks, (t) => t.includes('ZCC_HOST_DEBUG '));
    const line = stderr.split('\n').find((l) => l.startsWith('ZCC_HOST_DEBUG '));
    expect(line).toBeDefined();
    const summary = JSON.parse(String(line).slice('ZCC_HOST_DEBUG '.length));
    // 替身的事件是**被认得**的两种（`model.streaming` / `turn.completed`），
    // 所以表为空——unmapped 计数**精确为零**。
    expect(summary.unmappedOfficialEventTypes).toEqual({});
  });

  it('**非空的未映射表会被记下来**（用替身"官方线上字面量"开关制造一次真实的未映射）', async () => {
    // 让替身额外发一条**官方线上闭集里、但我们不接**的事件类型。
    // `tool.updated` 是官方 `jZa` 对**六种** tool 事件（`tool_call_scheduled` /
    // `started` / `progress` / `result` / `error` / `tool_batch_complete`）逐字合并后的
    // 线上类型（偏移 14430360）——我们不接工具调用，所以它必然落进这张表。
    const { childError, stderrChunks } = await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      { [HOST_DEBUG_ENV_KEY]: '1', ZCC_STUB_EMIT_OFFICIAL_EVENT_TYPE: 'tool.updated' },
      12000,
      sawMethod('session/close')
    );
    expect(childError).toBeNull();
    // **必须等**：子进程的 `exit` 与 stderr 的 `data` 是两条流（见 waitForStderrText 的注释）。
    const stderr = await waitForStderrText(stderrChunks, (t) => t.includes('ZCC_HOST_DEBUG '));
    const line = stderr.split('\n').find((l) => l.startsWith('ZCC_HOST_DEBUG '));
    expect(line).toBeDefined();
    const summary = JSON.parse(String(line).slice('ZCC_HOST_DEBUG '.length));
    // **这条就是"官方发了、我们没接住"的可观测形状**：键是**线上点号字面量**。
    expect(summary.unmappedOfficialEventTypes['tool.updated']).toBeGreaterThan(0);
    // 反向锁：键**不得**是下划线形式（那是被证伪的旧假设）。
    expect(Object.keys(summary.unmappedOfficialEventTypes).filter((k) => k.includes('_'))).toEqual([]);
  });

  it('**端到端**：替身回的是实弹那份形状，驱动照样把真 sessionId 交给 `session/send`', async () => {
    const { events, childError } = await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      {},
      12000,
      // 等 `session/close`（收尾帧）而不是 `session/send`：**整条**事件流要跑完，
      // 否则 33 段正文增量会被截断在半路，断言就变成了"截断也过"。
      sawMethod('session/close')
    );
    expect(childError).toBeNull();
    // **实弹逐字**：33 段正文增量 + usage + finish（见 expectRealShotStream）。
    expectRealShotStream(events);
    // 替身确实回的是**四层深**那份形状（不是旧的 `{result:{sessionId}}`）。
    const frames = framesOf(observed.readFromStdin);
    const sentFrame = frames.find((f) => f.method === 'session/send');
    expect(sentFrame).toBeDefined();
    expect(sentFrame.params.sessionId).toBe('stub-session-0001');
    // 诱饵也在场——这条断言的价值就在于证明**它没被选中**。
    expect(observed.sessionCreateResponseShapeIsReal).toBe(true);
  });
});


/* ========================================================================== */
/* HOSTFIX7：官方事件闭集映射、session/subscribe 闸门、usage 透传             */
/* ========================================================================== */

describe('OFFICIAL-HOST · HOSTFIX7 官方事件映射与订阅闸门（实弹逐字取证）', () => {
  /** @type {any} */
  let drive;
  beforeAll(async () => {
    drive = await import('../../scripts/official-host/session-drive.mjs');
  });
  /** 造一帧官方线上 `session/event` 信封。 @param {string} type @param {Record<string, unknown>} payload */
  const wireEvent = (type, payload) => ({
    method: 'session/event',
    params: { deliveryKind: 'desktop-continuous', eventId: 'e1', payload, seq: 1, sessionId: 's', timestamp: 1, type }
  });

  describe('线上事件类型闭集是**点号**（官方 `eGt` / `L5i` 逐字 25 项）', () => {
    it('闭集 25 项、全点号、无下划线；我们只接其中三种', () => {
      const set = /** @type {string[]} */ (drive.OFFICIAL_SESSION_EVENT_TYPES);
      expect(set).toHaveLength(25);
      expect(set.filter((t) => t.includes('_'))).toEqual([]);
      const mapped = set.filter((/** @type {string} */ t) => {
        const payload =
          t === 'model.streaming'
            ? { kind: 'text_delta', delta: 'x' }
            : t === 'turn.completed'
              ? { response: 'x', tokenCount: 0, toolCallCount: 0, duration: 0, resultType: 'success' }
              : t === 'turn.failed'
                ? { error: { type: 'E', message: 'm' }, turnPhase: 'p' }
                : {};
        return drive.mapOfficialEventToChannel(wireEvent(t, payload)).length > 0;
      });
      expect(mapped).toEqual(['turn.completed', 'turn.failed', 'model.streaming']);
    });

    it('**HOSTFIX6 的下划线前提被证伪**：内部枚举字面量映射不出任何东西', () => {
      for (const internal of [
        'turn_started',
        'turn_complete',
        'turn_error',
        'model_request',
        'model_complete',
        'model_streaming',
        'session_title_updated'
      ]) {
        expect(drive.mapOfficialEventToChannel(wireEvent(internal, { delta: 'x', tokenCount: 1 }))).toEqual([]);
      }
    });
  });

  describe('正文增量：`model.streaming` + `kind === "text_delta"` + `payload.delta`', () => {
    it('逐字到达', () => {
      expect(drive.mapOfficialEventToChannel(wireEvent('model.streaming', { kind: 'text_delta', delta: 'abc' }))).toEqual([
        { type: 'delta', text: 'abc' }
      ]);
    });

    it('`part.delta` **不产**正文（官方 `jZa` 从不产出它，只是导出 schema 里的遗留类型）', () => {
      expect(drive.mapOfficialEventToChannel(wireEvent('part.delta', { delta: 'abc' }))).toEqual([]);
    });

    it('非 `text_delta` 的 kind 不产正文；`reasoning_delta` 例外产思考流（`msr` 闭集逐字 13 项）', () => {
      expect(drive.OFFICIAL_MODEL_STREAMING_KINDS).toHaveLength(13);
      for (const kind of /** @type {string[]} */ (drive.OFFICIAL_MODEL_STREAMING_KINDS)) {
        if (kind === 'text_delta' || kind === 'reasoning_delta') continue;
        expect(drive.mapOfficialEventToChannel(wireEvent('model.streaming', { kind, delta: 'abc' }))).toEqual([]);
      }
      // 2026-10-10：reasoning_delta 外发成 reasoning 事件（思考期零字节曾让真客户端判
      // 停滞断开）；空 delta 仍丢弃（与官方 C3e 过滤同判）。
      expect(drive.mapOfficialEventToChannel(wireEvent('model.streaming', { kind: 'reasoning_delta', delta: 'abc' }))).toEqual([{ type: 'reasoning', text: 'abc' }]);
      expect(drive.mapOfficialEventToChannel(wireEvent('model.streaming', { kind: 'reasoning_delta', delta: '' }))).toEqual([]);
    });

    it('缺 `kind` / `delta` 非字符串 / 空串：都不产（官方 `C3e` 对 `text_delta` 要求 `!!delta`）', () => {
      expect(drive.mapOfficialEventToChannel(wireEvent('model.streaming', { delta: 'abc' }))).toEqual([]);
      expect(drive.mapOfficialEventToChannel(wireEvent('model.streaming', { kind: 'text_delta', delta: '' }))).toEqual([]);
      expect(drive.mapOfficialEventToChannel(wireEvent('model.streaming', { kind: 'text_delta' }))).toEqual([]);
      expect(drive.mapOfficialEventToChannel(wireEvent('model.streaming', { kind: 'text_delta', delta: 7 }))).toEqual([]);
    });

    it('**裸事件**（无 `method` 信封）与带信封的映射结果逐字相同', () => {
      const bare = { type: 'model.streaming', payload: { kind: 'text_delta', delta: 'abc' } };
      expect(drive.mapOfficialEventToChannel(bare)).toEqual(
        drive.mapOfficialEventToChannel(wireEvent('model.streaming', { kind: 'text_delta', delta: 'abc' }))
      );
    });
  });

  describe('usage：逐字来自 `turn.completed.payload.usage`（官方 `Jgr` 聚合形状）', () => {
    it('实弹数字逐字透传', () => {
      const usage = {
        source: 'provider',
        modelRequestCount: 1,
        inputTokens: 27285,
        outputTokens: 35,
        totalTokens: 27320,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        webFetchRequests: 0,
        webSearchRequests: 0
      };
      expect(
        drive.mapOfficialEventToChannel(
          wireEvent('turn.completed', { response: 'r', tokenCount: 27320, usage, toolCallCount: 0, duration: 1, resultType: 'success' })
        )
      ).toEqual([
        { type: 'turn_completed_body', text: 'r' },
        { type: 'usage', promptTokens: 27285, completionTokens: 35, usageMethod: 'official_turn_complete_usage' },
        { type: 'finish', reason: 'stop' }
      ]);
    });

    it('`totalTokenCount` 那个键**在 `turn.completed` 上不存在**（它在投影 reducer 上）', () => {
      const mapped = drive.mapOfficialEventToChannel(
        wireEvent('turn.completed', { response: 'r', totalTokenCount: 7, toolCallCount: 0, duration: 1, resultType: 'success' })
      );
      expect(mapped.filter((/** @type {any} */ e) => e['type'] === 'usage')).toEqual([]);
      expect(mapped[mapped.length - 1]).toEqual({ type: 'finish', reason: 'stop' });
    });

    it('usage 缺失 / 非对象 / 任一计数缺失或非法：都不产 usage（缺失报 null，不编造）', () => {
      const base = { response: 'r', tokenCount: 5, toolCallCount: 0, duration: 1, resultType: 'success' };
      for (const bad of [
        undefined,
        null,
        'nope',
        [],
        {},
        { inputTokens: 1 },
        { outputTokens: 1 },
        { inputTokens: -1, outputTokens: 1 },
        { inputTokens: 1, outputTokens: 1.5 },
        { inputTokens: '1', outputTokens: 2 },
        { inputTokens: Number.NaN, outputTokens: 2 }
      ]) {
        const mapped = drive.mapOfficialEventToChannel(wireEvent('turn.completed', { ...base, usage: bad }));
        expect(mapped.filter((/** @type {any} */ e) => e['type'] === 'usage')).toEqual([]);
        expect(mapped[mapped.length - 1]).toEqual({ type: 'finish', reason: 'stop' });
      }
    });

    it('`mapOfficialUsage` 逐字：0 是合法值', () => {
      expect(drive.mapOfficialUsage({ inputTokens: 0, outputTokens: 0 })).toEqual({
        type: 'usage',
        promptTokens: 0,
        completionTokens: 0,
        usageMethod: 'official_turn_complete_usage'
      });
    });
  });

  describe('终态诚实性：`resultType` 只有 `success` 是成功（官方 `ksr` 闭集 6 项）', () => {
    it('闭集逐字 6 项', () => {
      expect(drive.OFFICIAL_TURN_RESULT_TYPES).toEqual([
        'success',
        'cancelled',
        'error_max_turns',
        'error_max_budget',
        'error_during_execution',
        'error_max_tool_calls'
      ]);
    });

    it('**非 `success` 的五个一律失败化**，绝不当成 `finish`（那会是假成功）', () => {
      for (const resultType of /** @type {string[]} */ (drive.OFFICIAL_TURN_RESULT_TYPES).filter((/** @type {string} */ t) => t !== 'success')) {
        const mapped = drive.mapOfficialEventToChannel(
          wireEvent('turn.completed', { response: 'r', tokenCount: 0, toolCallCount: 0, duration: 1, resultType })
        );
        expect(mapped).toHaveLength(1);
        expect(mapped[0]?.['type']).toBe('failed');
        expect(String(mapped[0]?.['code'])).toBe(`TURN_${resultType.toUpperCase()}`);
        expect(mapped.filter((/** @type {any} */ e) => e['type'] === 'usage' || e['type'] === 'finish')).toEqual([]);
      }
    });

    it('`resultType` 缺失或不在闭集：失败化，且**不转发**那个值（只报类型与长度）', () => {
      for (const bad of [undefined, null, 'SUCCESS', 'weird-value', 7]) {
        const mapped = drive.mapOfficialEventToChannel(
          wireEvent('turn.completed', { response: 'r', tokenCount: 0, toolCallCount: 0, duration: 1, resultType: bad })
        );
        expect(mapped).toHaveLength(1);
        expect(mapped[0]?.['code']).toBe('TURN_COMPLETED_UNRECOGNIZED');
        expect(String(mapped[0]?.['detail'])).not.toContain('weird-value');
      }
    });
  });

  describe('`turn.failed`：逐字取 `payload.error` 的 code / type / message，**不取 stack**', () => {
    it('code 优先，其次 type，都没有就是 UNSPECIFIED', () => {
      expect(drive.mapOfficialEventToChannel(wireEvent('turn.failed', { error: { code: -32000, type: 'T', message: 'boom' }, turnPhase: 'p' }))[0]).toEqual({
        type: 'failed',
        code: 'TURN_FAILED_-32000',
        detail: 'boom'
      });
      expect(drive.mapOfficialEventToChannel(wireEvent('turn.failed', { error: { type: 'CancelledError', message: 'x' }, turnPhase: 'p' }))[0]['code']).toBe(
        'TURN_FAILED_CancelledError'
      );
      expect(drive.mapOfficialEventToChannel(wireEvent('turn.failed', { error: {}, turnPhase: 'p' }))[0]).toEqual({
        type: 'failed',
        code: 'TURN_FAILED_UNSPECIFIED',
        detail: '官方 turn 失败且未给 message'
      });
    });

    it('**反向锁**：`error.stack` 里的绝对路径绝不进 detail', () => {
      const mapped = drive.mapOfficialEventToChannel(
        wireEvent('turn.failed', {
          error: { type: 'E', message: 'm', stack: 'Error: m at parse (C:\\ZCode\\resources\\glm\\zcode.cjs:71:26784)' },
          turnPhase: 'p'
        })
      );
      expect(String(mapped[0]?.['detail'])).not.toContain('ZCode');
      expect(String(mapped[0]?.['detail'])).not.toContain('zcode.cjs');
    });

    it('`payload.error` 整个缺失也失败化（不抛、不静默）', () => {
      expect(drive.mapOfficialEventToChannel(wireEvent('turn.failed', {}))[0]['code']).toBe('TURN_FAILED_UNSPECIFIED');
    });
  });

  describe('`session/subscribe` 闸门：官方没有 `deliveryKind` 就不发事件', () => {
    it('`deliveryKind` 闭集与取值逐字对齐官方 `kV`', () => {
      expect(drive.OFFICIAL_DELIVERY_KINDS).toEqual(['desktop-continuous', 'web-remote-replayable']);
      expect(drive.OFFICIAL_DELIVERY_KIND).toBe('desktop-continuous');
      // 订阅等待上限必须是墙钟上限的一个零头——超时必须失败化，不能空转到 300 s。
      expect(drive.SUBSCRIBE_RESPONSE_TIMEOUT_MS).toBeGreaterThan(0);
      expect(drive.SUBSCRIBE_RESPONSE_TIMEOUT_MS).toBeLessThanOrEqual(drive.SESSION_TIMEOUT_MS / 10);
    });

    it('驱动**真的**先订阅（闭集内 `deliveryKind`）再发 turn', async () => {
      const { childError } = await spawnThroughRealChild(
        runRequest(join(sandbox, 'workspace')),
        {},
        12000,
        sawMethod('session/close')
      );
      expect(childError).toBeNull();
      const frames = framesOf(observed.readFromStdin);
      const subscribe = frames.find((f) => f.method === 'session/subscribe');
      expect(subscribe).toBeDefined();
      // 逐字对齐官方 `tGt`（偏移 756181）：`{sessionId, deliveryKind, afterSeq?, includeSnapshot?}`。
      expect(subscribe.params).toEqual({ deliveryKind: 'desktop-continuous', sessionId: 'stub-session-0001' });
      // 替身确实认了这条订阅（官方 `HKo` 逐字 `o.deliveryKind = n.deliveryKind`）。
      expect(observed.subscribeRequests).toBe(1);
      expect(observed.subscribeAccepted).toBe(true);
    });

    it('**反向证明闸门是真的**：替身按官方 `kXa` 的 `!t.deliveryKind → return` 扣住事件时，一条都不发', async () => {
      // 造一次"闸门不放行"：先让订阅被拒（闭集外的 deliveryKind 走替身那条反向开关）。
      // 观测上必须看到"事件被扣住"，否则"闸门是真的"这句就是空断言。
      const { childError, stderrChunks } = await spawnThroughRealChild(
        runRequest(join(sandbox, 'workspace')),
        { [HOST_DEBUG_ENV_KEY]: '1', ZCC_STUB_REJECT_SUBSCRIBE: '1' },
        12000,
        sawMethod('session/close')
      );
      // 订阅被拒 ⟹ 毫秒级 `SESSION_SUBSCRIBE_REJECTED`，**不**空转到 300 s。
      expect(String(childError)).toContain('SESSION_SUBSCRIBE_REJECTED');
      // 零凭据：诊断行里没有 prompt / 正文 / 凭据形态。
      const stderr = await waitForStderrText(stderrChunks, (t) => t.includes('ZCC_HOST_DEBUG '));
      const line = stderr.split('\n').find((l) => l.startsWith('ZCC_HOST_DEBUG '));
      expect(line).toBeDefined();
      const summary = JSON.parse(String(line).slice('ZCC_HOST_DEBUG '.length));
      expect(summary.failed).toBe(true);
      expect(String(line)).not.toContain(REAL_SHOT_RESPONSE_TEXT);
    });

    it('**对照组**：闸门放行时（正常路径）整条实弹事件流一条不少', async () => {
      const { events, childError } = await spawnThroughRealChild(
        runRequest(join(sandbox, 'workspace')),
        {},
        12000,
        sawMethod('session/close')
      );
      expect(childError).toBeNull();
      expectRealShotStream(events);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* HARDEN1 · 改进清单 #1：未映射事件类型的**键长**上界（终审 §3.3）              */
/* -------------------------------------------------------------------------- */

/**
 * ## 这条补的是终审 §3.3 那个低危开口
 *
 * 终审实测：喂一个 200 000 字符的 `type` 进去，`mapOfficialEventToChannel` 返回 `[]`，
 * 于是那个字符串**逐字**成为 `unmappedOfficialEventTypes` 的一个键。
 * `UNMAPPED_EVENT_TYPE_CAP = 32` 封的是**键的个数**，**不是键的长度**。
 *
 * 为什么不能只当"低危"放过：这份 `ZCC_HOST_DEBUG` 诊断行是本项目**实弹期唯一的
 * 可观测面**。官方一次异常的 `type` 就能把它撑成几 MB，把真正有用的那几行淹没——
 * 而排障时"看不到那几行"与"那件事没发生"**无法区分**。
 *
 * 这是全仓**唯一**一处"官方自由文本逐字进诊断行"的面，所以单独封一道。
 */
describe('OFFICIAL-HOST · HARDEN1 未映射事件类型的键长上界（终审 §3.3）', () => {
  it('闭集内的官方字面量**逐字不变**（钳制不得改动正常观测值）', async () => {
    const drive = /** @type {any} */ (await import('../../scripts/official-host/session-drive.mjs'));
    // 25 项线上点号闭集里**每一项**都必须逐字穿过钳制器。
    // 这一条是**反向锁**：把钳制写成"一律截断到 N 字符"的话这里立刻红。
    expect(drive.OFFICIAL_SESSION_EVENT_TYPES).toHaveLength(25);
    for (const type of drive.OFFICIAL_SESSION_EVENT_TYPES) {
      expect(drive.clampUnmappedEventTypeKey(type)).toBe(type);
    }
    // 键长上限必须给闭集留出余量：最长的那一项远在上限之内。
    const longest = drive.OFFICIAL_SESSION_EVENT_TYPES.map((/** @type {string} */ t) => t.length).reduce(
      (/** @type {number} */ a, /** @type {number} */ b) => Math.max(a, b),
      0
    );
    expect(longest).toBeLessThan(drive.UNMAPPED_EVENT_TYPE_MAX_KEY_CHARS);
    // 边界值：恰好等于上限的**原样返回**，超一字符就走截断形态。
    const atCap = 'a'.repeat(drive.UNMAPPED_EVENT_TYPE_MAX_KEY_CHARS);
    expect(drive.clampUnmappedEventTypeKey(atCap)).toBe(atCap);
    expect(drive.clampUnmappedEventTypeKey(`${atCap}a`)).not.toBe(`${atCap}a`);
  });

  it('**超长 `type` 进诊断表的是截断形态，不是原文**（且带长度标记）', async () => {
    const drive = /** @type {any} */ (await import('../../scripts/official-host/session-drive.mjs'));
    // 终审 §3.3 实测的那个量级。**不逐字断言原文**（那正是缺陷本身），
    // 断言的是"截断形态 + 长度标记 + 长度与原长无关"。
    const huge = `session.weird.${'x'.repeat(200_000)}`;
    const key = drive.clampUnmappedEventTypeKey(huge);
    expect(key).not.toBe(huge);
    // 头部逐字保留（排障时还能认出"这是哪一族类型"）。
    expect(key.startsWith(huge.slice(0, drive.UNMAPPED_EVENT_TYPE_KEY_PREFIX_CHARS))).toBe(true);
    // 截断标记 + **原长度**。没有长度标记就分不清"官方真发了这么长的键"与
    // "我们把它截了"，而那正是排障时要分辨的两件事。
    expect(key).toContain('…');
    expect(key).toContain(`len=${String(huge.length)}`);
    // 键长有界：与原长度**无关**（20 000 000 字符也只多几位数字）。
    for (const n of [65, 1000, 200_000, 20_000_000]) {
      expect(drive.clampUnmappedEventTypeKey('y'.repeat(n)).length).toBeLessThan(
        drive.UNMAPPED_EVENT_TYPE_MAX_KEY_CHARS
      );
    }
  });

  it('**端到端**：替身发一条超长未映射类型，诊断行里是**截断形态**（变异体必红）', async () => {
    // 让替身发一条**闭集外**且**超长**的事件类型。长度取 4096：
    // 远超 64 字符的键长上限，又在 Windows 单个环境变量 32 767 字符的上限之内。
    const drive = /** @type {any} */ (await import('../../scripts/official-host/session-drive.mjs'));
    const hugeType = `weird.${'z'.repeat(4096)}`;
    const { childError, stderrChunks } = await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      { [HOST_DEBUG_ENV_KEY]: '1', ZCC_STUB_EMIT_OFFICIAL_EVENT_TYPE: hugeType },
      12000,
      sawMethod('session/close')
    );
    expect(childError).toBeNull();
    // **必须等**：子进程的 `exit` 与 stderr 的 `data` 是两条流。
    const stderr = await waitForStderrText(stderrChunks, (t) => t.includes('ZCC_HOST_DEBUG '));
    const line = stderr.split('\n').find((l) => l.startsWith('ZCC_HOST_DEBUG '));
    expect(line).toBeDefined();
    const summary = JSON.parse(String(line).slice('ZCC_HOST_DEBUG '.length));
    const keys = Object.keys(summary.unmappedOfficialEventTypes);
    // 替身确实发了那一条（**不是**空表：这条断言不是恒真的）。
    expect(keys).toHaveLength(1);
    const key = String(keys[0]);
    // **核心断言**：诊断行里存的是**截断形态**，不是那 4 102 字符的原文。
    expect(key).not.toBe(hugeType);
    expect(key.startsWith('weird.z')).toBe(true);
    expect(key).toContain('…');
    expect(key).toContain(`len=${String(hugeType.length)}`);
    expect(key.length).toBeLessThan(drive.UNMAPPED_EVENT_TYPE_MAX_KEY_CHARS);
    // **整行诊断行有界**：未被映射的键**不得**把这一行撑大。
    expect(String(line).length).toBeLessThan(2000);
    // 计数照旧（钳制只动**键**，不动**值**）。
    expect(summary.unmappedOfficialEventTypes[key]).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* HARDEN1 · 改进清单 #2：`pause()+unref()` 的回归保护（终审 §5-c，变异体 M9 存活） */
/* -------------------------------------------------------------------------- */

/**
 * ## 这条补的是终审 §5-c 那个"未修、也未登记"的零覆盖遗留
 *
 * `host-child.mjs` 的 `readRequest()` 里，摘掉 stdin 读句柄那两行
 * （`process.stdin.pause?.()` + `process.stdin.unref?.()`）是子宿主
 * "**一次一枚、用完即杀**"这个模型的**全部理由**所在。删掉它：
 *  - 进程在 `main()` 返回后**仍然不退**（Node 里挂了 `data` 监听器的 stdin 是 ref 的）；
 *  - 于是每一次请求都要靠父进程 `runHostSession.reap()` 的
 *    `HOST_CHILD_EXIT_GRACE_MS`（400 ms）宽限窗 + 一次 **SIGKILL** 才收场。
 *
 * 终审复现的变异体 M9（删掉那两行）：**95/95 全绿，变异体完全存活**。
 * 为什么存活：B4 段那三条断言的是"子进程**最终**退出了"，而被 SIGKILL 收掉的进程
 * **也**退出了——`exitCode !== null || signalCode !== null` 照样成立。
 * 这就是"断言强度不够"的典型形态：它测的是**结果**，不是**机制**。
 *
 * 本段把判据改成两件**只有自然退出才满足**的事：
 *  1. **本测试自己是唯一的收割者**——不经 `runHostSession`，直接 spawn `host-child.mjs`，
 *     于是**没有任何生产代码**会替它兜底 kill。"自然退出"没法再被兜底伪装成"退出了"。
 *  2. **退出码是 0**、**没有信号**——被 kill 的进程给不出这个组合。
 */
describe('OFFICIAL-HOST · HARDEN1 子宿主"用完即杀"（`pause()+unref()` 的回归保护）', () => {
  /**
   * 等一个由本测试 spawn 的子进程退出，并回报终态。**不复用 B4 段那个内嵌版**——
   * 那三个函数的 `waitForExit` 只断言"退出了"，正是本段要补强的那个洞。
   *
   * @param {import('node:child_process').ChildProcess} child
   * @param {number} ms 上限
   * @returns {Promise<{ exited: boolean, exitCode: number | null, signalCode: NodeJS.Signals | null, aliveAfter: boolean }>}
   */
  function waitForTerminalState(child, ms = 6000) {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve({ exited: true, exitCode: child.exitCode, signalCode: child.signalCode, aliveAfter: false });
        return;
      }
      const timer = setTimeout(() => {
        let aliveAfter = false;
        if (typeof child.pid === 'number') {
          try {
            process.kill(child.pid, 0);
            aliveAfter = true;
          } catch {
            aliveAfter = false;
          }
        }
        resolve({ exited: false, exitCode: child.exitCode, signalCode: child.signalCode, aliveAfter });
      }, ms);
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        let aliveAfter = false;
        if (typeof child.pid === 'number') {
          try {
            process.kill(child.pid, 0);
            aliveAfter = true;
          } catch {
            aliveAfter = false;
          }
        }
        resolve({ exited: true, exitCode: code, signalCode: signal, aliveAfter });
      });
    });
  }

  it('**自然退出**：子宿主在 `main()` 返回后自己退（无任何 kill 兜底，退出码 0）', async () => {
    // **刻意不经 `runHostSession`**：那条路上有 `reap()` 的 400 ms 宽限窗 + SIGKILL 兜底，
    // 兜底一旦接管，"退出了"就不再证明"自然退出"（这正是 M9 存活的原因）。
    // 这里**没有任何人**替它兜底——本测试自己不 kill，它就永远挂着。
    const child = spawn(process.execPath, [resolveHostChildScript(), '--bundle', STUB_BUNDLE], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...buildIsolatedChildEnv(process.env), ZCC_STUB_OBSERVATION_FILE: observationFile }
    });
    /** @type {any[]} */
    const frames = [];
    let buffer = '';
    /** @type {number | null} */
    let finishedAt = null;
    const started = Date.now();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (;;) {
        const at = buffer.indexOf('\n');
        if (at < 0) break;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        for (const f of framesOf([line])) {
          frames.push(f);
          if (f.zccHost?.type === 'finish') finishedAt = Date.now();
        }
      }
    });
    let state = null;
    try {
      // **只喂一帧**——这正是"一次一枚、用完即杀"的那个"一枚"。
      child.stdin.write(`${JSON.stringify({ zccHost: { op: 'describe' } })}\n`);
      state = await waitForTerminalState(child, 6000);
    } finally {
      // 孤儿防线：**只有**在断言已经注定要红的时候才会真的动手。
      // 正常路径下它早就退了，这里是空转；变异体路径下它就是唯一的收割者。
      // 只对**我们自己 spawn、句柄在手**的那个进程动手（AGENTS §1.6）。
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    // **先钉形状**：`describe` 路径一个字节不写地收掉子宿主，只吐两帧。
    expect(frames.map((f) => f.zccHost.type)).toEqual(['ready', 'finish']);
    // **核心断言 1：时限内真的退出了。** 删掉 `pause()+unref()` 时它**永远**不退，
    // 于是这里必然红（本测试自己的 6 s 上限就是判据，不需要任何生产代码参与）。
    expect(state?.exited).toBe(true);
    // **核心断言 2：退出码 0 且无信号**——被 SIGKILL 收掉的进程给不出这个组合。
    // 换句话说：这条断言证明"生产上的 400 ms 宽限窗 + SIGKILL 兜底**用不上**"，
    // "用完即杀"不是名不副实。
    expect(state?.exitCode).toBe(0);
    expect(state?.signalCode).toBeNull();
    // 时延是**毫秒级**的（不是"反正最后退了"）。
    expect(finishedAt).not.toBeNull();
    expect((finishedAt ?? Number.POSITIVE_INFINITY) - started).toBeLessThan(2000);
  });

  it('**经生产 reap 路径同样收在自然退出上**（不是 400 ms 宽限窗之后的 SIGKILL）', async () => {
    // 上一条证明"没人兜底时它自己会退"；这一条证明"**有**生产兜底时也用不上兜底"——
    // 也就是 `runHostSession.reap()` 的 `HOST_CHILD_EXIT_GRACE_MS` 宽限窗走完之前
    // 子宿主**已经**退了，`killTimer` 被 `child.on('exit')` 清掉。
    // 判据仍是**退出码**：自然退出 `code === 0`；被 SIGKILL 收掉则给不出 0。
    /** @type {import('node:child_process').ChildProcess | null} */
    let held = null;
    /** @type {any[]} */
    const events = [];
    await runHostSession({ op: 'describe' }, (e) => events.push(e), {
      bundlePath: STUB_BUNDLE,
      timeoutMs: 12000,
      spawnChild: (args) => {
        const [script, ...rest] = args;
        if (script === undefined) throw new Error('SYNTHETIC_ARGS_EMPTY');
        held = spawn(process.execPath, [script, ...rest], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: { ...buildIsolatedChildEnv(process.env), ZCC_STUB_OBSERVATION_FILE: observationFile }
        });
        return /** @type {any} */ (held);
      }
    });
    expect(events.map((e) => e.type)).toEqual(['ready', 'finish']);
    const state = await waitForTerminalState(/** @type {any} */ (held), 6000);
    expect(state.exited).toBe(true);
    // **这一位就是与终审 M9 变异体的分水岭**：既有 B4 段只断言
    // `exitCode !== null || signalCode !== null`（被 kill 也满足），这里要求**退出码 0**。
    expect(state.exitCode).toBe(0);
    expect(state.signalCode).toBeNull();
    expect(state.aliveAfter).toBe(false);
  });

  it('**静态面**：那两行摘句柄的调用必须与 `readRequest` 的解引用同在', async () => {
    // 端到端那两条是**行为**锁；这一条是**结构**锁，防止有人把两行挪到一个
    // 永远走不到的分支里（例如挪进 `op === 'run'` 的专属路径）。
    const code = stripComments(readFileSync(resolveHostChildScript(), 'utf8'));
    const fn = code.slice(code.indexOf('function readRequest()'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain('process.stdin.pause?.()');
    expect(body).toContain('process.stdin.unref?.()');
    // 两行必须**晚于** `off('data', …)`——即"只取一帧"的那一刻，而不是读帧之前。
    const offAt = body.indexOf("process.stdin.off('data', onData)");
    expect(offAt).toBeGreaterThanOrEqual(0);
    expect(body.indexOf('process.stdin.pause?.()')).toBeGreaterThan(offAt);
    expect(body.indexOf('process.stdin.unref?.()')).toBeGreaterThan(offAt);
  });
});

/* -------------------------------------------------------------------------- */
/* HARDEN1 · 改进清单 #3：根因 2+3 的**第二钉**（会话中途的错误应答）            */
/* -------------------------------------------------------------------------- */

/**
 * ## 为什么既有那一条撑不住
 *
 * 终审 §2.1 记的是：把"根因 2 + 3（官方错误应答被丢弃 / `settle` 唤醒条件错）"
 * 整条链一起回退（变异体 M12），**只 1 条红**——`官方拒了账号帧 → 毫秒级
 * ACCOUNT_CONFIG_REJECTED`。也就是说这条链上**只有一根钉子**，回退时信号极弱。
 *
 * ## 本段钉的是同一条链的**另一半**：会话**中途**的错误应答
 *
 * 既有那几条只覆盖**请求应答**（账号帧 / `session/create` / `session/subscribe` /
 * `session/send` 的**受理回执**阶段）。本段覆盖的是**另一段代码路径**：turn 消费循环里
 * 的两处 `findOfficialErrorFor([line], id)`（`pending` 批 + `settle` 之后抽干），
 * 也就是**根因 3 说的"缓冲空了 vs 有应答了"那条 `settle`** 真正生效的地方。
 *
 * 替身在**已订阅、`session/send` 已受理、已经产出 2 段真实正文增量之后**才回
 * `{id, error}`，并且**刻意不发** `turn.completed`。于是：
 *  - 正确行为：**毫秒级** `SESSION_SEND_REJECTED`，错误码与消息如实透出；
 *  - 回退行为（那条帧被当普通行丢掉）：等不到终态 ⟹ 空转到墙钟上限 ⟹
 *    `SESSION_TIMEOUT`（或测试上限）。**"毫秒级拒绝"被伪装成"慢响应"**——
 *    这就是 HOSTFIX6 那次 300 s 挂死的同构形状。
 */
describe('OFFICIAL-HOST · HARDEN1 根因 2+3 的第二钉：会话中途的错误应答', () => {
  it('**中途 `{id,error}` → 毫秒级 `SESSION_SEND_REJECTED`，不是墙钟超时**', async () => {
    const started = Date.now();
    const { events, childError } = await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      { ZCC_STUB_REJECT_SESSION_SEND_LATE: '-32603' },
      12000,
      // 等**中途那条错误应答**真的发了，而不是等 `session/close`——
      // 走失败路径时 `session/close` 根本不会被发出去。
      (v) => v.sessionSendLateRejected !== null
    );
    const elapsed = Date.now() - started;
    // 替身确实在中途发了那一条（**不是**恒真断言）。
    expect(observed.sessionSendLateRejected).toBe('-32603');
    // 错误帧挂在 `session/send` 那个 id 上——**按 id 精确认领**（根因 2）。
    expect(observed.sessionSendRequestId).not.toBeNull();
    const sentFrame = framesOf(observed.readFromStdin).find((f) => f.method === 'session/send');
    expect(sentFrame).toBeDefined();
    expect(observed.sessionSendRequestId).toBe(sentFrame.id);
    // **失败化，而不是超时化**：失败码与官方错误码逐字。
    expect(childError).not.toBeNull();
    const message = String(/** @type {any} */ (childError).message);
    expect(message).toContain('SESSION_SEND_REJECTED');
    // **官方错误码与消息如实透出**（`describeOfficialError` 只取 code + message）。
    expect(message).toContain('code=-32603');
    expect(message).toContain('回合中途被上游中止');
    // **不得**是墙钟超时——那正是这条链回退后的形态。
    expect(message).not.toContain('SESSION_TIMEOUT');
    expect(message).not.toContain('CHILD_TIMEOUT');
    // **秒级**：远小于 12 s 的测试上限，也远小于生产的 300 s 墙钟上限。
    expect(elapsed).toBeLessThan(8000);
    // **已经产出的真实内容不撤回，也不被当成成功**：流里有 delta，**没有** finish。
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('ready');
    expect(types.filter((t) => t === 'delta').length).toBeGreaterThan(0);
    expect(types).not.toContain('finish');
    expect(types).not.toContain('usage');
  });

  it('**对照组**：开关关着时同一条链路照样正常收束（证明失败化不是被开关逼出来的）', async () => {
    const { events, childError } = await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      {},
      12000,
      sawMethod('session/close')
    );
    expect(childError).toBeNull();
    expect(observed.sessionSendLateRejected).toBeNull();
    // 逐字不变：实弹那条完整事件流一条不少。
    expectRealShotStream(events);
  });

  it('**结构面**：`SESSION_SEND_REJECTED` 在 turn 段被抛**两次**（`settle` 两侧各一）', async () => {
    // 根因 3 修的正是"`settle` 醒来之后能不能看见那条应答"。turn 段有**两处**
    // 抽干点（`pending` 批 + `settle` 之后抽干），两处都判；删掉任何一处
    // 都会让那条应答在另一条路径上被漏掉。这一条把"两处都在"钉成数字。
    const code = stripComments(
      readFileSync(resolvePath(HERE, '..', '..', 'scripts', 'official-host', 'session-drive.mjs'), 'utf8')
    );
    // 四个失败码是**四条不同的路径**（账号帧 / create / subscribe / turn 段），
    // 一条都不许少。
    for (const marker of [
      'ACCOUNT_CONFIG_REJECTED',
      'SESSION_CREATE_REJECTED',
      'SESSION_SUBSCRIBE_REJECTED',
      'SESSION_SEND_REJECTED'
    ]) {
      expect(code).toContain(marker);
    }
    expect(code.split('SESSION_SEND_REJECTED:').length - 1).toBe(2);
  });

  it('**错误码/消息如实透出到 API 错误路径**（`ApiError.upstream_outcome_unknown`）', async () => {
    // 上一条断在 `runHostSession` 那一层。这一条再往**上**走一层，
    // 证明"如实透出"在**真正的 API 错误路径**上也成立：
    // 子宿主 `failed` 帧 → `sanitizeChildDetail` → `runHostSession` 失败 →
    // 驱动器生成器 → `ApiError('upstream_outcome_unknown', …)`。
    const catalogEntry = {
      modelId: 'account:zai-start-plan::GLM-5.3-Flash',
      displayName: '',
      provider: 'account:zai-start-plan',
      billingClass: 'promotion',
      contextLength: null,
      reasoning: [],
      capabilities: []
    };
    const catalog = /** @type {any} */ ({ revision: 'synthetic', models: [catalogEntry] });
    // 合成数据根 + 合成凭据仓（HOSTFIX3 闸门）：**零真实凭据仓读取**。
    writeSyntheticCredentialStore(sandbox);
    const savedDataRoot = process.env['ZCODE_DATA_BASE_DIR'];
    const savedSecret = process.env[CREDENTIAL_SECRET_ENV_KEY];
    process.env['ZCODE_DATA_BASE_DIR'] = sandbox;
    process.env[CREDENTIAL_SECRET_ENV_KEY] = STUB_CREDENTIAL_SECRET;
    let caught = null;
    /** @type {any[]} */
    const produced = [];
    try {
      const driver = createOfficialHostDriver({
        descriptor: /** @type {any} */ ({
          bundlePath: STUB_BUNDLE,
          exports: [],
          detail: 'synthetic',
          models: [{ id: 'account:zai-start-plan::GLM-5.3-Flash', object: 'model', created: 1, owned_by: 'x' }],
          status: 'ready'
        }),
        catalog,
        servableModels: selectServableModels(catalog),
        reasoning: 'high',
        bundlePath: STUB_BUNDLE,
        timeoutMs: 12000,
        workspacePath: join(sandbox, 'workspace'),
        deriveEntitled: () => ({
          entitled: true,
          evidence: {
            providerId: 'account:zai-start-plan',
            cacheKey: 'k',
            cacheStatus: 'available',
            availabilityObservedAt: 1,
            available: true,
            reason: 'cache-available',
            sourceFile: 's'
          }
        }),
        spawnChild: (args) => {
          const [script, ...rest] = args;
          if (script === undefined) throw new Error('SYNTHETIC_ARGS_EMPTY');
          const env = buildIsolatedChildEnv(process.env);
          env['ZCC_STUB_OBSERVATION_FILE'] = observationFile;
          env['ZCC_STUB_REJECT_SESSION_SEND_LATE'] = '-32603';
          return /** @type {any} */ (
            spawn(process.execPath, [script, ...rest], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env })
          );
        }
      });
      for await (const e of driver.stream(/** @type {any} */ ({
        operationId: 'op-harden1-late-reject',
        model: 'account:zai-start-plan::GLM-5.3-Flash',
        messages: [{ role: 'user', content: '合成提示词，不触网' }],
        maxTokens: null,
        signal: new AbortController().signal
      }))) {
        produced.push(e);
      }
    } catch (e) {
      caught = e;
    } finally {
      if (savedDataRoot === undefined) delete process.env['ZCODE_DATA_BASE_DIR'];
      else process.env['ZCODE_DATA_BASE_DIR'] = savedDataRoot;
      if (savedSecret === undefined) delete process.env[CREDENTIAL_SECRET_ENV_KEY];
      else process.env[CREDENTIAL_SECRET_ENV_KEY] = savedSecret;
    }
    // **必须失败**，且失败码是 API 层那一个。
    expect(caught).not.toBeNull();
    expect(/** @type {any} */ (caught).code).toBe('upstream_outcome_unknown');
    const message = String(/** @type {any} */ (caught).message);
    // **端到端透出**：驱动器的 `*_REJECTED` 短码、官方错误码、官方错误消息
    // 全部穿过 `sanitizeChildDetail` 到达 API 错误消息。
    expect(message).toContain('SESSION_SEND_REJECTED');
    expect(message).toContain('code=-32603');
    expect(message).toContain('回合中途被上游中止');
    // **不得**被伪装成慢响应，也不得出现墙钟超时的失败码。
    expect(message).not.toContain('SESSION_TIMEOUT');
    expect(message).not.toContain('CHILD_TIMEOUT');
    // **没有假成功**：流**没有**走到 `finish`。
    //
    // 刻意**不**在这里断言"产出过 delta"：驱动器那个 `while (… || queue.length > 0)`
    // 循环**先**判 `failure` 再抽队列，所以 `runHostSession` 的拒绝与增量事件的
    // 派发之间存在一个**真实的竞态**——"产出过 delta"取决于谁先跑。
    // 那条断言改成读**替身侧**的观测（确定性事实）：
    // 会话**确实**跑到了"两道闸门都过、turn 事件开发"那一刻。
    expect(produced.some((e) => e.type === 'finish')).toBe(false);
    observed = await waitForObservation((v) => v.sessionSendLateRejected !== null, 4000);
    expect(observed.turnProceededAfterAuth).toBe(true);
    expect(observed.sessionSendLateRejected).toBe('-32603');
  });
});
/* -------------------------------------------------------------------------- */
/* COMPAT1/C4：工具权限 / 用户输入的端到端闸门（真实 spawn 路径）                */
/* -------------------------------------------------------------------------- */

/**
 * ## 为什么这些用例必须走**真实 spawn** 路径
 *
 * 与 HOSTFIX3/HOSTFIX4 两段同一档理由：纯函数单测抓不到"驱动到底有没有**认出**那条帧"。
 * 反向请求的完整路径是
 * `官方 stdout → 驱动 flushBuffered → 判别器 → 应答写回子进程 stdin → 官方 resolveClientRequest`，
 * 其中**任何一环**接错，纯函数测试都照样绿。
 *
 * 替身按官方 `.strict()` 的 `JL` / `CYe` 逐字校验我们的应答，并**闸门化**：
 * 不答（或答得形状不合格）就**永远不放行 turn 事件**。于是"我们答了它"从推断
 * 变成一条可观测的时序，而"没答"这条缺陷会**真的**复现成与实弹同构的形状
 * （turn 事件永不发 → 驱动空转到墙钟上限）。
 */
describe('OFFICIAL-HOST · COMPAT1/C4 工具权限 / 用户输入闸门（真实 spawn）', () => {
  it('`session/create` 带 `mode:"yolo"`，且 params 键表逐字不越官方 `nGt` 的 `.strict()`', async () => {
    await spawnThroughRealChild(runRequest(join(sandbox, 'workspace')), {}, 12000, sawMethod('session/close'));
    // 官方 `checkPermission` 逐字 `this.allow(t,a,"mode.yolo","Yolo mode bypasses permission prompts")`
    // ——这是闭集里唯一逐字写着 "bypasses permission prompts" 的取值。
    expect(observed.sessionCreateMode).toBe('yolo');
    // 官方 `nGt`（偏移 757102）是 `.strict()` 的：**多一个键整帧作废**。
    // 逐字钉死我们发的那几个键，一个不多一个不少。
    // **COMPAT2**：`maxTokens` **任何取值下都不在这张表里**（下一条单独钉非空的情形）。
    expect(observed.sessionCreateParamKeys).toEqual(['mode', 'model', 'thoughtLevel', 'workspace']);
  });

  it('COMPAT2：即使 `maxTokens` **非空**，`session/create` 的 params 键表仍逐字不越官方 `nGt`', async () => {
    // 这条钉的是 2026-10-02 D3 实弹挖出的真缺陷：`session/create` 此前把 `maxTokens`
    // 无条件塞进 params，而官方 `nGt`（`zcode.cjs` 偏移 757102）是 `.strict()` 且逐字
    // **没有**这个键（嵌套 `model` 的 `Pu` 偏移 508944 同样 `.strict()`、同样没有），
    // 官方在偏移 14479993 逐字 `yl(nGt,t)`，而 `yl`（偏移 14131416）逐字是
    // `e.parse(t)` + 失败即 `-32602 Invalid params`
    // → **任何带上限的请求都被官方拒掉**，而 `zcc.max_tokens_enforced` 还报 `true`。
    // 修法：上限不再进官方协议面，改由 API 层如实披露为"未转发"。
    // 钉法：让 `maxTokens` 非空，键表**必须与空值时逐字相等**。
    await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace'), { maxTokens: 16384 }),
      {},
      12000,
      sawMethod('session/close')
    );
    expect(observed.sessionCreateParamKeys).toEqual(['mode', 'model', 'thoughtLevel', 'workspace']);
    expect(observed.sessionCreateParamKeys).not.toContain('maxTokens');
  });

  it('官方发 `interaction/requestPermission`，我们按 `allow` 答，turn 才放行', async () => {
    const { childError, events } = await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      { ZCC_STUB_ASK_TOOL_PERMISSION: '1' },
      12000,
      sawMethod('session/close')
    );
    expect(childError).toBeNull();

    // (1) 官方确实发了这条，params 逐字对齐官方 `dUi`（偏移 767390）的必填集。
    expect(observed.toolPermissionRequestsSent).toBe(1);
    // 官方**同一个**单调计数器：偏好 `server-1` → 凭据 `server-2` → 权限 `server-3`。
    expect(observed.toolPermissionRequestIds).toEqual(['server-3']);
    for (const key of ['input', 'options', 'reason', 'requestId', 'riskLevel', 'sessionId', 'toolCallId', 'toolName']) {
      expect(observed.toolPermissionRequestParamKeys[0], key).toContain(key);
    }

    // (2) 我们答了，且**形状逐字对齐官方 `JL`**（`.strict()`）。
    expect(observed.toolPermissionResponseSeen).toBe(true);
    expect(observed.toolPermissionResponseFrameKeys).toEqual(['id', 'result']);
    expect(observed.toolPermissionResponseShapeValid).toBe(true);
    // **只有** `decision` + `reason`：多一个键官方 `resultSchema.parse` 就抛。
    expect(observed.toolPermissionResponseResultKeys).toEqual(['decision', 'reason']);
    expect(observed.toolPermissionResponseResult.decision).toBe('allow');
    // 刻意**不**构造的两个键，逐条钉住。
    expect(observed.toolPermissionResponseResult).not.toHaveProperty('modifiedInput');
    expect(observed.toolPermissionResponseResult).not.toHaveProperty('permissionUpdates');

    // (3) 收口判据：闸门过 → turn 事件真的出来了。
    expect(observed.gateHeldForToolInteraction).toBe(false);
    expect(observed.turnProceededAfterAuth).toBe(true);
    expectRealShotStream(events);
  });

  it('`ZCC_HOST_TOOL_POLICY=deny` → **如实回 deny**（不假装放行），但闸门仍放行 turn', async () => {
    await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      { ZCC_STUB_ASK_TOOL_PERMISSION: '1', ZCC_HOST_TOOL_POLICY: 'deny' },
      12000,
      sawMethod('session/close')
    );
    expect(observed.toolPermissionRequestsSent).toBe(1);
    expect(observed.toolPermissionResponseSeen).toBe(true);
    expect(observed.toolPermissionResponseShapeValid).toBe(true);
    // 官方 `JL` 的 `decision` 闭集（逐字 `jZe`）里 `deny` 是合法值：
    // 答"拒绝"是一个**形状合格**的应答，官方据此**如实**拒掉那次工具调用，
    // 然后继续本轮 turn —— 这正是"不假装放行"的正确形态。
    expect(observed.toolPermissionResponseResult.decision).toBe('deny');
    expect(observed.gateHeldForToolInteraction).toBe(false);
    expect(observed.turnProceededAfterAuth).toBe(true);
  });

  it('**不答就挂死**（这正是实弹会挂 300 秒的那个形状）：替身吞掉应答 → turn 永不放行', async () => {
    const { childError } = await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      { ZCC_STUB_ASK_TOOL_PERMISSION: '1', ZCC_STUB_SWALLOW_TOOL_INTERACTION_RESPONSE: '1' },
      6000,
      (v) => v?.gateHeldForToolInteraction === true
    );
    expect(childError).not.toBeNull();
    // 官方那边"应答帧从没到"与"超时"是**完全一样**的：`pendingClientRequests` 里那条
    // 一直挂着。而官方那条 `requestClient` 对权限**没有** `timeoutMs`（`dRn` 逐字只给
    // `{sessionId, kind, …}`）——所以真实挂死是**无限**的，替身用 3 s 判。
    expect(observed.toolPermissionRequestsSent).toBe(1);
    // 连"应答已看到"都不记：观测口径与官方一致。
    expect(observed.toolPermissionResponseSeen).toBe(false);
    expect(observed.gateHeldForToolInteraction).toBe(true);
    // 后面的一切都没发生：没 turn 事件。
    expect(observed.turnProceededAfterAuth).toBe(false);
  });

  it('**形状不合格就不放行**（替身按官方 `JL` 的 `.strict()` 逐字判定）', async () => {
    for (const shape of ['missing-decision', 'extra-key']) {
      const { childError } = await spawnThroughRealChild(
        runRequest(join(sandbox, 'workspace')),
        { ZCC_STUB_ASK_TOOL_PERMISSION: '1', ZCC_STUB_FORCE_PERMISSION_SHAPE: shape },
        6000,
        (v) => v?.toolPermissionResponseSeen === true
      );
      expect(childError, `shape=${shape} 会话必须失败`).not.toBeNull();
      // 请求发过、应答也收到了——但**形状不合格**。
      expect(observed.toolPermissionResponseSeen).toBe(true);
      expect(observed.toolPermissionResponseShapeValid).toBe(false);
      expect(observed.gateHeldForToolInteraction).toBe(true);
      expect(observed.turnProceededAfterAuth).toBe(false);
    }
  });

  it('官方发 `interaction/requestUserInput`，我们恒回 `action:"cancel"` 且不构造 `content`', async () => {
    const { childError } = await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      { ZCC_STUB_ASK_USER_INPUT: '1' },
      12000,
      sawMethod('session/close')
    );
    expect(childError).toBeNull();
    expect(observed.userInputRequestsSent).toBe(1);
    expect(observed.userInputRequestParamKeys[0]).toEqual(
      expect.arrayContaining(['input', 'prompt', 'questions', 'requestId', 'schema', 'sessionId', 'toolCallId', 'toolName'])
    );
    // 官方 `CYe`（偏移 768638）逐字 `m.object({action:m.enum(["accept","decline","cancel"]),content:…optional(),reason:…optional()}).strict()`
    expect(observed.userInputResponseSeen).toBe(true);
    expect(observed.userInputResponseFrameKeys).toEqual(['id', 'result']);
    expect(observed.userInputResponseShapeValid).toBe(true);
    // 官方 `GZa` 逐字：非 accept 路径**根本不读** `content` —— 省略是官方支持的形态。
    expect(observed.userInputResponseResultKeys).toEqual(['action', 'reason']);
    expect(observed.userInputResponseResult.action).toBe('cancel');
    expect(observed.userInputResponseResult).not.toHaveProperty('content');
    expect(observed.gateHeldForToolInteraction).toBe(false);
    expect(observed.turnProceededAfterAuth).toBe(true);
  });

  it('`requestUserInput` **形状不合格也不放行**（`CYe` 同样 `.strict()`）', async () => {
    for (const shape of ['missing-action', 'extra-key']) {
      const { childError } = await spawnThroughRealChild(
        runRequest(join(sandbox, 'workspace')),
        { ZCC_STUB_ASK_USER_INPUT: '1', ZCC_STUB_FORCE_USER_INPUT_SHAPE: shape },
        6000,
        (v) => v?.userInputResponseSeen === true
      );
      expect(childError, `shape=${shape} 会话必须失败`).not.toBeNull();
      expect(observed.userInputResponseShapeValid).toBe(false);
      expect(observed.gateHeldForToolInteraction).toBe(true);
      expect(observed.turnProceededAfterAuth).toBe(false);
    }
  });

  it('**两条同时来**（权限 + 用户输入）时两条都被答、顺序与 id 都被钉死', async () => {
    await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      { ZCC_STUB_ASK_TOOL_PERMISSION: '1', ZCC_STUB_ASK_USER_INPUT: '1' },
      12000,
      sawMethod('session/close')
    );
    // 官方**同一个**单调计数器（`server-${nextClientRequestId++}`）——偏好 `server-1`、
    // 凭据 `server-2`，于是这两条是 `server-3` / `server-4`。
    expect(observed.toolPermissionRequestIds).toEqual(['server-3']);
    expect(observed.userInputRequestIds).toEqual(['server-4']);
    expect(observed.toolPermissionResponseShapeValid).toBe(true);
    expect(observed.userInputResponseShapeValid).toBe(true);
    expect(observed.gateHeldForToolInteraction).toBe(false);
    expect(observed.turnProceededAfterAuth).toBe(true);
  });

  it('`ZCC_HOST_PERMISSION_MODE` 能把 `mode` 改成闭集里的另一个值（闸门可测，不是恒 `yolo`）', async () => {
    await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      { ZCC_HOST_PERMISSION_MODE: 'build' },
      12000,
      sawMethod('session/close')
    );
    // 这一条钉住"我们真的按 env 下发，不是写死一个 `yolo` 字面量"——
    // 一条恒真的断言等于没有断言。
    expect(observed.sessionCreateMode).toBe('build');
  });

  it('**闭集外的 `ZCC_HOST_PERMISSION_MODE` 让会话立刻失败化**（不猜一档权限）', async () => {
    const { childError } = await spawnThroughRealChild(
      runRequest(join(sandbox, 'workspace')),
      { ZCC_HOST_PERMISSION_MODE: 'YOLO' },
      8000,
      () => false
    );
    // 官方 `$j=m.enum([...])` 是 `.strict()` 的枚举，闭集外的 `mode` 会被官方
    // 整帧拒掉；我们在**发出之前**就失败化，错误信息指名合法取值。
    expect(childError).not.toBeNull();
    expect(String(/** @type {Error | null} */ (childError)?.message ?? '')).toMatch(/PERMISSION_MODE_UNSUPPORTED/);
    // 失败发生在**发出任何官方帧之前**（`driveSession` 开头就解析 env），所以替身
    // 连观测文件都还没来得及写 —— 观测为 `null` 恰恰是"官方侧压根没被碰到"的可观测点。
    // 官方那边这条的表现是 `session/create` 整帧被 `.strict()` 的枚举拒掉。
    expect(observed).toBeNull();
  });
});
