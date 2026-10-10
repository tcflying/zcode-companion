'use strict';

/**
 * 脱敏日志导出（RA-09，`929.md:386/445/554/876`）。
 *
 * 需求原文：
 *  - `:386` 设置/诊断含**脱敏导出**
 *  - `:445` **导出有预览/脱敏/本地目标，不自动上传 GitHub/云端**
 *  - `:554` **导出预览、字节上限**
 *  - `:876` 证据含**脱敏导出 hash**
 *
 * ## 设计核心：**显式字段白名单**，不是「对任意原文做脱敏」
 *
 * 上一版把日志行**原文**脱敏后写进导出。那是不够的：脱敏只能识别「长得像凭据」的东西，
 * 一旦将来某行日志把用户正文拼进自由文本，正文就会**原样通过**脱敏。
 * 所以这一版改成**只导出白名单里的字段**，且每个字段还有**取值文法**：
 *  - 字段名不在白名单 ⇒ **丢弃**（并计数）；
 *  - 取值不符合该字段文法 ⇒ **丢弃**（不是替换，替换等于把原文留在文件里）；
 *  - 日志行里的**自由文本**（正文就住在这里）**根本不进导出格式**。
 *  脱敏仍保留，但降级为**第二道**防线，而不是唯一防线。
 *
 * ## 能力边界（不假装解决）
 *
 * 一个 canary 若被塞进**白名单字段**且**恰好符合该字段文法**（例如混在 `event=` 里），
 * 本模块认不出来。这是已知边界，写在测试里如实钉住，不靠猜。
 *
 * ## 分层
 *
 * 本文件**不碰**文件系统、不弹对话框、不发网络，所以能被完整单测；
 * 落盘与「本地目标选择」由 `createLogExporter` 的注入依赖完成，
 * 于是**取消 / 在途 / 写失败**三条语义也能被真实驱动，而不是只靠代码审读。
 */

const crypto = require('node:crypto');

const REDACTED = '[REDACTED]';
const OMITTED = '[OMITTED]';

const DEFAULT_MAX_BYTES = 256 * 1024;
const MIN_MAX_BYTES = 1024;
const HARD_MAX_BYTES = 8 * 1024 * 1024;
/** 预览只回前 N 个字符：预览本身不该变成一次无意的全量外带。 */
const DEFAULT_PREVIEW_CHARS = 4096;

/* -------------------------------------------------------------------------- */
/* 字段白名单与取值文法                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 白名单：`字段名 -> 取值文法`。
 *
 * 每条文法都**刻意收紧**：宁可把合法值误判为丢弃（那只是少一行证据、且计数可见），
 * 也不能让一个正文片段混进来。
 */
/** @type {Record<string, RegExp>} */
const EXPORT_FIELD_ALLOWLIST = {
  event: /^[a-z][a-z0-9_]*$/,
  operation: /^chatcmpl-[0-9a-fA-F-]{36}$/,
  pending_operation: /^chatcmpl-[0-9a-fA-F-]{36}$/,
  key: /^zcc-fp:[0-9a-f]{12}$/,
  session_key: /^[0-9a-f]{64}$/,
  status: /^(\d{3}|[a-z][a-z0-9_]*)$/,
  code: /^[A-Za-z][A-Za-z0-9_]{0,63}$/,
  state: /^[a-z][a-z0-9_]*$/,
  kind: /^[a-z][a-z0-9_]*$/,
  new_key: /^[a-z][a-z0-9_]*$/,
  idempotency: /^[a-z][a-z0-9_]*$/,
  fixture: /^(true|false)$/,
  stream: /^(true|false|sse)$/,
  bytes: /^\d{1,12}$/,
  frames: /^\d{1,12}$/,
  ms: /^\d{1,12}$/,
  in_flight: /^(true|false)$/,
  timed_out: /^(true|false)$/,
  port: /^\d{1,5}$/,
  limit: /^\d{1,12}$/,
  grace_ms: /^\d{1,12}$/,
  method: /^[A-Z]{3,10}$/,
  address: /^127\.0\.0\.1$/,
  driver: /^[a-z][a-z0-9_-]{0,31}$/,
  path: /^\/[A-Za-z0-9/._-]{0,128}$/,
  reason: /^(|[a-z][a-z0-9_]{0,63})$/,
  defects: /^(|[A-Za-z0-9_]{1,32}(,[A-Za-z0-9_]{1,32}){0,7})$/
};

const ALLOWLISTED_FIELDS = Object.keys(EXPORT_FIELD_ALLOWLIST);

/* -------------------------------------------------------------------------- */
/* 形状脱敏（第二道防线）                                                       */
/* -------------------------------------------------------------------------- */

const KEY_VALUE_RE =
  /\b(apiKey|access_token|refresh_token|id_token|token|credential|password|secret|client_secret|authorization|private_key)(\s*[:=]\s*)("?)([^\s"',;]+)\3/gi;
const PREFIX_RE = /\b(?:sk|pk|rk|ak)-[A-Za-z0-9._-]{6,}/g;
/** Bearer/JWT/前缀必须**先于**键值规则：否则 `Authorization: Bearer x` 会变成 `Authorization: [REDACTED] x`，令牌幸存。 */
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;

/**
 * @param {string} value
 * @param {readonly string[]} secrets
 * @returns {string}
 */
function redactValue(value, secrets) {
  let out = value;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8 && out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  out = out.replace(BEARER_RE, `Bearer ${REDACTED}`);
  out = out.replace(JWT_RE, REDACTED);
  out = out.replace(PREFIX_RE, REDACTED);
  out = out.replace(KEY_VALUE_RE, (_m, key, sep) => `${key}${sep}${REDACTED}`);
  return out;
}

/* -------------------------------------------------------------------------- */
/* 行 -> 白名单字段                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 把一行 `k=v k=v ...` 解析成**白名单字段**序列。
 * 非白名单字段、非法取值、以及**所有自由文本**都不进结果。
 *
 * @param {string} line
 * @param {readonly string[]} secrets
 * @returns {{ kept: {key: string, value: string}[], droppedFields: number, droppedInvalid: number }}
 */
function selectAllowlistedFields(line, secrets) {
  /** @type {{ key: string, value: string }[]} */
  const kept = [];
  let droppedFields = 0;
  let droppedInvalid = 0;

  // 字段名**必须**包含连字符：像 `x-zcc-session-id=` 这种带横线的名字，
// 若只按 `[A-Za-z0-9_]` 匹配就会整段看不见——它不会被导出（安全），但**丢弃计数会少报**，
// 而计数是人能看到的唯一信号（"有东西被过滤了"）。踩过一次：`1 !== 2`。
for (const match of String(line).matchAll(/(?:^|\s)([a-zA-Z_][a-zA-Z0-9_-]*)=(\S*)/g)) {
    const key = match[1];
    if (key === undefined) continue;
    const rawValue = match[2] ?? '';
    // 必须判**自有属性**，不能判 `=== undefined`。
    // `EXPORT_FIELD_ALLOWLIST` 是普通对象字面量，原型链上挂着 Object.prototype，
    // 于是 `['constructor']` 取到 `Object` 这个**函数**、`['toString']` 取到函数、
    // `['__proto__']` 取到原型对象——它们**都不是 undefined**，会穿过下面那道检查，
    // 紧接着 `grammar.test(...)` 抛 `grammar.test is not a function`
    // （父审 08:34:17 UTC 实跑：`event=done constructor=x`，PID 5260，exit 1）。
    //
    // 先用 `hasOwnProperty` 把**取值**本身关进三元里，再由 `=== undefined` 收窄类型：
    // 这样运行时语义与直接 `hasOwnProperty` 判否**完全相同**（非自有 ⇒ 取到 undefined ⇒ 丢弃），
    // 而 `checkJs` 也能把 `grammar` 收窄成 `RegExp`，不需要 `!` 也不用 `@ts-ignore`。
    const grammar = Object.prototype.hasOwnProperty.call(EXPORT_FIELD_ALLOWLIST, key)
      ? EXPORT_FIELD_ALLOWLIST[key]
      : undefined;
    if (grammar === undefined) {
      droppedFields += 1;
      continue;
    }
    const redacted = redactValue(rawValue, secrets);
    if (!grammar.test(redacted)) {
      droppedInvalid += 1;
      continue;
    }
    kept.push({ key, value: redacted });
  }

  return { kept, droppedFields, droppedInvalid };
}

/* -------------------------------------------------------------------------- */
/* 载荷构建                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {object} ExportOk
 * @property {true} ok
 * @property {string} text
 * @property {number} bytes
 * @property {string} sha256
 * @property {number} totalLines
 * @property {number} includedLines
 * @property {number} droppedLines
 * @property {boolean} truncated
 * @property {number} redactedLines
 * @property {number} droppedFields
 * @property {number} droppedInvalid
 * @property {number} maxBytes
 * @property {string} generatedAt
 *
 * @typedef {object} ExportErr
 * @property {false} ok
 * @property {string} code
 * @property {string} reason
 */

/**
 * @param {unknown} input
 * @returns {{ ok: true, mode: 'preview'|'save', maxBytes: number } | ExportErr}
 */
function planLogExport(input) {
  if (input === null || typeof input !== 'object') {
    return { ok: false, code: 'INVALID_INPUT', reason: '导出参数不是对象' };
  }
  // 上面刚确认它是对象，这里把形状显式化让属性访问有类型；
  // 这是**既有运行时事实**的类型投影，不是关闭检查。
  const raw = /** @type {Record<string, unknown>} */ (input);
  const mode = raw.mode ?? 'preview';
  if (mode !== 'preview' && mode !== 'save') {
    return { ok: false, code: 'INVALID_INPUT', reason: `未知导出模式：${String(mode)}` };
  }
  const requested = raw.maxBytes ?? DEFAULT_MAX_BYTES;
  if (typeof requested !== 'number' || !Number.isInteger(requested) || requested <= 0) {
    return { ok: false, code: 'INVALID_INPUT', reason: `字节上限非法：${String(requested)}` };
  }
  const maxBytes = Math.min(HARD_MAX_BYTES, Math.max(MIN_MAX_BYTES, requested));
  return { ok: true, mode, maxBytes };
}

/**
 * 构建导出文本。**只读**：不改传入的 lines，不动全局状态。
 *
 * @param {object} input
 * @param {readonly {stream?: string, at?: number, text?: string}[]} [input.lines]
 * @param {readonly string[]} [input.secrets]
 * @param {number} [input.maxBytes]
 * @param {() => number} [input.now]
 * @returns {ExportOk | ExportErr}
 */
function buildLogExport(input) {
  const plan = planLogExport(input);
  if (plan.ok === false) return plan;

  const raw = input ?? {};
  const lines = raw.lines ?? [];
  if (!Array.isArray(lines)) return { ok: false, code: 'INVALID_INPUT', reason: 'lines 不是数组' };
  const secrets = Array.isArray(raw.secrets) ? raw.secrets : [];
  const now = typeof raw.now === 'function' ? raw.now : Date.now;
  const maxBytes = plan.maxBytes;
  const encoder = new TextEncoder();

  const totalLines = lines.length;
  const generatedAt = new Date(now()).toISOString();
  let droppedFields = 0;
  let droppedInvalid = 0;
  let redactedLines = 0;

  const prepared = [];
  for (const entry of lines) {
    if (entry === null || typeof entry !== 'object') {
      return { ok: false, code: 'INVALID_INPUT', reason: '日志行不是对象' };
    }
    const text = typeof entry.text === 'string' ? entry.text : '';
    const stream = typeof entry.stream === 'string' ? entry.stream : 'main';
    const at = typeof entry.at === 'number' ? entry.at : null;
    const selected = selectAllowlistedFields(text, secrets);
    droppedFields += selected.droppedFields;
    droppedInvalid += selected.droppedInvalid;
    if (redactValue(text, secrets) !== text) redactedLines += 1;
    const stamp = at === null ? '-' : new Date(at).toISOString();
    const body = selected.kept.map((f) => `${f.key}=${f.value}`).join(' ');
    prepared.push(`${stamp} stream=${stream} ${body}`.trimEnd());
  }

  const header = [
    '# ZCode Companion 脱敏日志导出',
    `# generated_at=${generatedAt}`,
    `# line_total=${totalLines}`,
    `# byte_cap=${maxBytes}`,
    `# allowlist_fields=${ALLOWLISTED_FIELDS.join(',')}`,
    `# dropped_fields=${droppedFields} dropped_invalid_values=${droppedInvalid}`,
    '# 自由文本（用户正文所在处）不导出；仅保留白名单字段且取值须符合文法。',
    '# 程序不会自动上传；保存位置由用户在系统对话框中自行选择。'
  ];

  const head = `${header.join('\n')}\n`;
  let bytes = encoder.encode(head).byteLength;
  const body = [];
  const bodyBytes = [];
  let includedLines = 0;

  for (const line of prepared) {
    const candidate = `${line}\n`;
    const candidateBytes = encoder.encode(candidate).byteLength;
    if (bytes + candidateBytes > maxBytes) break;
    body.push(candidate);
    bodyBytes.push(candidateBytes);
    bytes += candidateBytes;
    includedLines += 1;
  }

  let marker = null;
  if (includedLines < totalLines) {
    // 标记文本里含丢弃行数，而丢弃行数取决于回退了几行 ⇒ 互相依赖，跑定点迭代。
    for (;;) {
      const dropped = totalLines - includedLines;
      const candidate = `# ... 截断：因字节上限 ${maxBytes} 未导出 ${dropped} 行（共 ${totalLines} 行）\n`;
      const candidateBytes = encoder.encode(candidate).byteLength;
      if (bytes + candidateBytes <= maxBytes || includedLines === 0) {
        marker = candidate;
        bytes += candidateBytes;
        break;
      }
      const freed = bodyBytes.pop();
      body.pop();
      includedLines -= 1;
      bytes -= freed === undefined ? 0 : freed;
    }
    body.push(marker);
  }

  let text = head + body.join('');
  // 无条件终钳：即使定点迭代因未来改动失准，最终文本也一定不超上限。
  if (encoder.encode(text).byteLength > maxBytes) {
    text = head + '# ... 截断：已达字节上限\n';
    includedLines = 0;
    marker = text;
  }

  const droppedLines = totalLines - includedLines;
  return {
    ok: true,
    text,
    bytes: encoder.encode(text).byteLength,
    sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    totalLines,
    includedLines,
    droppedLines,
    truncated: droppedLines > 0,
    redactedLines,
    droppedFields,
    droppedInvalid,
    maxBytes,
    generatedAt
  };
}

/* -------------------------------------------------------------------------- */
/* 可实测的导出执行器                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 造一个导出执行器。**依赖全部注入**，所以取消 / 在途 / 写失败三条语义
 * 可以在没有 Electron 的地方被真实驱动，而不是只靠代码审读。
 *
 * @param {object} deps
 * @param {() => readonly {stream?: string, at?: number, text?: string}[]} deps.getLines
 * @param {() => readonly string[]} deps.getSecrets
 * @param {(options: {generatedAt: string}) => Promise<{canceled?: boolean, filePath?: string}>} deps.saveAs
 * @param {(filePath: string, text: string) => void} deps.writeFile
 * @param {() => number} [deps.now]
 * @param {number} [deps.previewChars]
 */
function createLogExporter(deps) {
  let inFlight = false;

  /**
   * @param {unknown} input
   * @returns {Promise<object>}
   */
  return async function run(input) {
    const plan = planLogExport(input);
    if (plan.ok === false) return plan;
    if (inFlight) {
      return { ok: false, code: 'EXPORT_IN_PROGRESS', reason: '已有一个导出保存正在进行，请先完成或取消。' };
    }

    const built = buildLogExport({
      lines: deps.getLines(),
      secrets: deps.getSecrets(),
      maxBytes: plan.maxBytes,
      now: deps.now
    });
    if (built.ok === false) return built;

    const summary = {
      bytes: built.bytes,
      sha256: built.sha256,
      totalLines: built.totalLines,
      includedLines: built.includedLines,
      droppedLines: built.droppedLines,
      truncated: built.truncated,
      redactedLines: built.redactedLines,
      droppedFields: built.droppedFields,
      droppedInvalid: built.droppedInvalid,
      maxBytes: built.maxBytes,
      generatedAt: built.generatedAt
    };

    if (plan.mode === 'preview') {
      const limit = typeof deps.previewChars === 'number' ? deps.previewChars : DEFAULT_PREVIEW_CHARS;
      return { ok: true, mode: 'preview', preview: built.text.slice(0, limit), ...summary };
    }

    inFlight = true;
    try {
      const chosen = await deps.saveAs({ generatedAt: built.generatedAt });
      // 取消是**正常结局**：不写文件、不报错、不留半截文件。
      if (chosen === null || chosen === undefined || chosen.canceled === true) {
        return { ok: false, code: 'CANCELLED', reason: '用户取消了保存，未写入任何文件。', ...summary };
      }
      if (typeof chosen.filePath !== 'string' || chosen.filePath === '') {
        return { ok: false, code: 'CANCELLED', reason: '未选定保存路径，未写入任何文件。', ...summary };
      }
      deps.writeFile(chosen.filePath, built.text);
      return { ok: true, mode: 'save', path: chosen.filePath, ...summary };
    } catch (error) {
      return {
        ok: false,
        code: 'SAVE_FAILED',
        reason: error instanceof Error ? error.message : String(error),
        ...summary
      };
    } finally {
      inFlight = false;
    }
  };
}

module.exports = {
  REDACTED,
  OMITTED,
  DEFAULT_MAX_BYTES,
  MIN_MAX_BYTES,
  HARD_MAX_BYTES,
  DEFAULT_PREVIEW_CHARS,
  EXPORT_FIELD_ALLOWLIST,
  ALLOWLISTED_FIELDS,
  redactValue,
  selectAllowlistedFields,
  planLogExport,
  buildLogExport,
  createLogExporter
};