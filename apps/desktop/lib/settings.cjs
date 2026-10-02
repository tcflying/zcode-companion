/**
 * 设置持久化与首启引导。
 *
 * 硬约束：
 *  1. **key 只落在 `userData/settings.json`，且只由本文件读写。** 任何离开本进程的
 *     出口（IPC 载荷、界面状态、日志、错误文本）拿到的都是 `apiKeySet` / 掩码 / 指纹，
 *     拿不到明文。指纹沿用 `packages/api/src/auth.ts` 的 `zcc-fp:<sha256 前 12 位>`
 *     约定，可用于「是哪一把 key」的证据，不含 key 任何片段。
 *  2. **闭集 fail-closed。** `driver` / `reasoning` / `apiPort` 越界时**拒绝保存**并
 *     指名已知取值，而不是悄悄回落到默认值——回落到默认值等于让用户以为自己配了
 *     别的通道。读取历史文件时同样按闭集校验，坏字段退回缺省并如实报告。
 *  3. **首启引导只读一个键。** `~/.minimax/config.yaml` 的
 *     `custom_provider.zcc-companion.options.apiKey` 是本产品自己生成、单一用途的
 *     凭据；读取按**缩进感知的路径匹配**实现，绝不做「全文搜 `apiKey:`」那种会
 *     命中别家 provider 的写法。读不到就保持空（不猜、不生成弱 key）。
 *
 * 纯 Node 实现，不依赖 Electron 与主进程状态，因此可被单测直接引用。
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

/** 可配置的驱动器闭集。`fixture` 故意不在表内：它是假模型产出，配置无法启用。 */
const DRIVER_CLOSED_SET = Object.freeze(['none', 'local-official', 'official-host']);
/** 推理档位闭集（与 `start-api.mjs` 的 `ENTRY_HOST_REASONING_LEVELS` 同源）。 */
const REASONING_CLOSED_SET = Object.freeze(['low', 'high', 'max']);

const DEFAULT_API_PORT = 8790;
const DEFAULT_DRIVER = 'official-host';
const DEFAULT_REASONING = 'low';

const SETTINGS_FILE_NAME = 'settings.json';

/**
 * 回给界面的 key 掩码。
 *
 * 它同时是**回提交时的哨兵值**：设置页拿到的是掩码，用户没动那一栏、原样提交回来的
 * 就是这个串。早期实现只处理了「空串 = 不改」，而掩码是个**非空串**，于是被当成
 * 「用户换了一把新 key」写进了 `settings.json`——一次无意的保存就把真 key 顶掉了。
 * 掩码必须被显式识别成「不改」，语义才与界面上的说明一致。
 */
const API_KEY_MASK = '••••••••';

/**
 * 设置的**完整**形态。这是本仓里唯一允许持有明文 key 的结构，
 * 也只允许存在于主进程内存与 `settings.json` 落盘这两处。
 * @typedef {{ apiKey: string, apiPort: number, driver: string, reasoning: string }} CompanionSettings
 */

/** 缺省设置。`apiKey` 故意为空：本产品**不生成**任何默认弱 key。 */
function defaultSettings() {
  return { apiKey: '', apiPort: DEFAULT_API_PORT, driver: DEFAULT_DRIVER, reasoning: DEFAULT_REASONING };
}

/**
 * 与 `packages/api/src/auth.ts` 的 `fingerprintApiKey` 逐字同源。
 * @param {string} key
 * @returns {string}
 */
function fingerprintApiKey(key) {
  return `zcc-fp:${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 12)}`;
}

/* -------------------------------------------------------------------------- */
/* 闭集校验                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * @param {unknown} value
 * @param {readonly string[]} closedSet
 * @returns {{ ok: true, value: string } | { ok: false, reason: string }}
 */
function validateEnum(value, closedSet) {  if (typeof value !== 'string' || !closedSet.includes(value)) {
    return { ok: false, reason: `取值不在闭集内（${closedSet.join(' | ')}）` };
  }
  return { ok: true, value };
}

/**
 * @param {unknown} value
 * @returns {{ ok: true, value: number } | { ok: false, reason: string }}
 */
function validatePort(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    return { ok: false, reason: '端口必须是 1..65535 的整数' };
  }
  return { ok: true, value };
}

/**
 * 校验并规范化一份提交上来的设置。
 *
 * `apiKey` 走「留空即保持原值」的语义：界面拿到的是掩码，回提交掩码或空串都表示
 * 「不改」。要换 key 必须提交一个**全新的非空串**。
 *
 * @param {unknown} input
 * @param {string} currentApiKey
 * @returns {{ ok: true, value: { apiKey: string, apiPort: number, driver: string, reasoning: string } }
 *          | { ok: false, reason: string }}
 */
function normalizeSettings(input, currentApiKey) {
  if (input === null || typeof input !== 'object') {
    return { ok: false, reason: '设置必须是对象' };
  }
  const raw = /** @type {Record<string, unknown>} */ (input);

  const apiKey = raw['apiKey'];
  if (apiKey !== undefined && apiKey !== null && typeof apiKey !== 'string') {
    return { ok: false, reason: 'apiKey 必须是字符串' };
  }
  // 掩码回提交 = 不改。这里比对的是「是否为当前 key 的明文」；掩码不是明文，
  // 因此不会误判成「用户在改 key」。全空白按「不改」处理，与空串同一语义。
  // **掩码本身也必须算「不改」**：它是非空串，只判空会把它当成一把新 key 存下去。
  const submitted = typeof apiKey === 'string' ? apiKey.trim() : '';
  const isMaskEcho = submitted === API_KEY_MASK;
  const nextApiKey = submitted !== '' && !isMaskEcho ? submitted : currentApiKey;

  const port = validatePort(raw['apiPort'] === undefined ? DEFAULT_API_PORT : raw['apiPort']);
  if (!port.ok) return { ok: false, reason: `apiPort ${port.reason}` };

  const driver = validateEnum(raw['driver'] === undefined ? DEFAULT_DRIVER : raw['driver'], DRIVER_CLOSED_SET);
  if (!driver.ok) return { ok: false, reason: `driver ${driver.reason}` };

  const reasoning = validateEnum(
    raw['reasoning'] === undefined ? DEFAULT_REASONING : raw['reasoning'],
    REASONING_CLOSED_SET
  );
  if (!reasoning.ok) return { ok: false, reason: `reasoning ${reasoning.reason}` };

  if (nextApiKey.trim() === '') {
    return { ok: false, reason: 'apiKey 不能为空：本产品不生成默认弱 key，请粘贴已有 key 或完成首启引导' };
  }
  if (/\r|\n/.test(nextApiKey)) {
    return { ok: false, reason: 'apiKey 含换行：拒绝写入' };
  }

  return {
    ok: true,
    value: { apiKey: nextApiKey.trim(), apiPort: port.value, driver: driver.value, reasoning: reasoning.value }
  };
}

/* -------------------------------------------------------------------------- */
/* ~/.minimax/config.yaml 引导                                                 */
/* -------------------------------------------------------------------------- */

/** 引导用的唯一路径。改动这里等于改动「我们读谁的那把 key」，必须显式。 */
const MINIMAX_KEY_PATH = Object.freeze(['custom_provider', 'zcc-companion', 'options', 'apiKey']);

/** 去掉行尾注释并解掉一层引号；不是标量（块、锚点、别名）时返回 null。 */
/**
 * @param {string} rawValue
 * @returns {string | null}
 */
function scalarOf(rawValue) {
  let value = rawValue.trim();
  if (value === '') return null;
  if (value.startsWith('#')) return null;
  if (value === '|' || value === '>' || value === '|-' || value === '>-') return null;
  if (value.startsWith('&') || value.startsWith('*')) return null;
  if (value.startsWith('"') || value.startsWith("'")) {
  const quote = value[0];
  if (quote === undefined) return null;
  const end = value.indexOf(quote, 1);
    // 引号没闭合：宁可读不到，也不把半截引号当成值写进设置。
    if (end < 0) return null;
    return value.slice(1, end);
  }
  // 无引号值的行尾注释（` #` 前有一个空格才算注释，值里的 `#` 不算）。
  const hash = value.indexOf(' #');
  if (hash >= 0) value = value.slice(0, hash).trim();
  return value === '' ? null : value;
}

/**
 * 缩进感知的 YAML 子集读取：只支持「嵌套映射 + 标量叶子」，
 * 按**完整路径**取值。列表项、块标量、多文档一律跳过。
 *
 * 之所以不用正则全文搜：同一份配置里有七八个 provider 各自的 `apiKey:`，
 * 只有路径匹配能保证我们读到的是**自己那把**。
 *
 * @param {string} text
 * @param {readonly string[]} keyPath
 * @returns {string | null}
 */
function readYamlScalarAtPath(text, keyPath) {
  /** @type {{ key: string, indent: number }[]} */
  const stack = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (/^\s*(---|\.\.\.)\s*$/.test(line)) continue;
    const match = /^(\s*)([^\s#][^:]*?)\s*:\s?(.*)$/.exec(line);
    if (!match) continue;
    const indent = /** @type {string} */ (match[1]).length;
    const key = /** @type {string} */ (match[2]).trim().replace(/^["']|["']$/g, '');
    const rest = /** @type {string} */ (match[3]);
    // 列表项不是映射键，本子集不读。
    if (key.startsWith('- ') || key === '-') continue;

    // 栈**只**由缩进维护。路径比对绝不允许顺手改栈：一旦在比对失败时 pop，
    // 后续行的父链就被写坏，同一个键会在别的分支上误命中。
    while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? -1) >= indent) stack.pop();
    stack.push({ key, indent });

    if (stack.length !== keyPath.length) continue;
    let matched = true;
    for (let i = 0; i < keyPath.length; i++) {
      if (stack[i]?.key !== keyPath[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return scalarOf(rest);
  }
  return null;
}

/**
 * 从 `~/.minimax/config.yaml` 读回本产品那把 key。
 * @param {string} [home] HOME 目录（测试注入合成配置用）。
 * @returns {{ ok: true, key: string, source: string } | { ok: false, reason: string }}
 */
function readMinimaxApiKey(home) {
  const file = path.join(home ?? os.homedir(), '.minimax', 'config.yaml');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, reason: `读取 ${file} 失败：${err instanceof Error ? err.message : String(err)}` };
  }
  const value = readYamlScalarAtPath(raw, MINIMAX_KEY_PATH);
  if (value === null) {
    return { ok: false, reason: `${file} 中没有 custom_provider.zcc-companion.options.apiKey` };
  }
  if (value.trim() === '') return { ok: false, reason: '引导读到的 apiKey 是空串：拒绝写入' };
  return { ok: true, key: value.trim(), source: file };
}

/* -------------------------------------------------------------------------- */
/* 持久化                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * @param {string} userDataDir `app.getPath('userData')`。
 * @returns {string}
 */
function settingsFilePath(userDataDir) {
  return path.join(userDataDir, SETTINGS_FILE_NAME);
}

/**
 * 读取设置。文件缺失是正常的首启；文件损坏**不静默吞掉**——退回缺省并如实报告问题。
 * @param {string} file
 * @returns {{ settings: ReturnType<typeof defaultSettings>, problems: string[] }}
 */
function loadSettings(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { settings: defaultSettings(), problems: [] };
  }
  /** @type {string[]} */
  const problems = [];
  /** @type {Record<string, unknown>} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      settings: defaultSettings(),
      problems: [`SETTINGS_FILE_UNREADABLE: ${err instanceof Error ? err.message : String(err)}（已退回缺省，未覆盖原文件）`]
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { settings: defaultSettings(), problems: ['SETTINGS_FILE_SHAPE: 顶层不是对象，已退回缺省'] };
  }

  const settings = defaultSettings();
  if (typeof parsed['apiKey'] === 'string' && parsed['apiKey'].trim() !== '') {
    settings.apiKey = parsed['apiKey'];
  } else if (parsed['apiKey'] !== undefined) {
    problems.push('SETTINGS_FIELD_DROPPED: apiKey 为空或非字符串，按缺省处理');
  }

  const port = validatePort(parsed['apiPort']);
  if (port.ok) settings.apiPort = port.value;
  else if (parsed['apiPort'] !== undefined) problems.push(`SETTINGS_FIELD_DROPPED: apiPort ${port.reason}`);

  const driver = validateEnum(parsed['driver'], DRIVER_CLOSED_SET);
  if (driver.ok) settings.driver = driver.value;
  else if (parsed['driver'] !== undefined) problems.push(`SETTINGS_FIELD_DROPPED: driver ${driver.reason}`);

  const reasoning = validateEnum(parsed['reasoning'], REASONING_CLOSED_SET);
  if (reasoning.ok) settings.reasoning = reasoning.value;
  else if (parsed['reasoning'] !== undefined) problems.push(`SETTINGS_FIELD_DROPPED: reasoning ${reasoning.reason}`);

  return { settings, problems };
}

/**
 * 写设置。**先写临时文件再改名**：写到一半断电不会留下半份 JSON。
 * @param {string} file
 * @param {{ apiKey: string, apiPort: number, driver: string, reasoning: string }} settings
 */
function saveSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * 首启引导：key 为空时从 `~/.minimax/config.yaml` 读回。读不到就保持空并如实报告。
 * @param {{ apiKey: string, apiPort: number, driver: string, reasoning: string }} settings
 * @param {string} [home]
 * @returns {{ settings: typeof settings, seeded: boolean, source: string | null, reason: string | null }}
 */
function seedApiKeyFromMinimax(settings, home) {
  if (settings.apiKey.trim() !== '') {
    return { settings, seeded: false, source: null, reason: null };
  }
  const read = readMinimaxApiKey(home);
  if (!read.ok) return { settings, seeded: false, source: null, reason: read.reason };
  return {
    settings: { ...settings, apiKey: read.key },
    seeded: true,
    source: read.source,
    reason: null
  };
}

/**
 * 交给渲染进程的**公开视图**：不含 key 明文，也不含 key 的任何片段。
 * @param {{ apiKey: string, apiPort: number, driver: string, reasoning: string }} settings
 */
function publicSettings(settings) {
  const hasKey = settings.apiKey.trim() !== '';
  return {
    apiKeySet: hasKey,
    apiKeyMasked: hasKey ? API_KEY_MASK : '',
    apiKeyFingerprint: hasKey ? fingerprintApiKey(settings.apiKey) : null,
    apiPort: settings.apiPort,
    driver: settings.driver,
    reasoning: settings.reasoning,
    driverClosedSet: DRIVER_CLOSED_SET,
    reasoningClosedSet: REASONING_CLOSED_SET
  };
}

exports.defaultSettings = defaultSettings;
exports.normalizeSettings = normalizeSettings;
exports.readYamlScalarAtPath = readYamlScalarAtPath;
exports.readMinimaxApiKey = readMinimaxApiKey;
exports.seedApiKeyFromMinimax = seedApiKeyFromMinimax;
exports.loadSettings = loadSettings;
exports.saveSettings = saveSettings;
exports.settingsFilePath = settingsFilePath;
exports.publicSettings = publicSettings;
exports.fingerprintApiKey = fingerprintApiKey;
exports.DRIVER_CLOSED_SET = DRIVER_CLOSED_SET;
exports.REASONING_CLOSED_SET = REASONING_CLOSED_SET;
exports.DEFAULT_API_PORT = DEFAULT_API_PORT;
exports.DEFAULT_DRIVER = DEFAULT_DRIVER;
exports.DEFAULT_REASONING = DEFAULT_REASONING;
exports.MINIMAX_KEY_PATH = MINIMAX_KEY_PATH;
exports.API_KEY_MASK = API_KEY_MASK;
