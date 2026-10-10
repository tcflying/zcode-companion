/**
 * 操作 journal：容量有界、落盘可重开、`unknown` 记录受保护。
 *
 * 需求出处：`G:/zcode-project/zcode-dev/929.md:875`
 *   「通过：secret canary无泄漏，正文默认不外带；**journal不足拒新发而非丢unknown**；……」
 *
 * 本模块要满足的正是那个被漏掉的通过条件：
 *   1. **容量不足时明确拒绝新发**，而不是悄悄丢掉旧条目让调用方误以为写成功了；
 *   2. **`unknown` 记录永不淘汰**——结果未知的操作是事实证据，丢了就等于伪造干净；
 *   3. **进程重开后仍在**——journal 必须落盘，且读取损坏时如实报告而不是静默清空。
 *
 * 约定（与 `settings.cjs` 同款范式，不引入新架构）：
 *  - 数据落在 `app.getPath('userData')` 下的 `journal.json`，与 `settings.json` 同根；
 *  - 写**先写临时文件再改名**（`settings.cjs:310-315` 同款），写到一半断电不留半份 JSON；
 *  - 文件权限 `0o600`，journal 里可能出现用户自己的提示词，不该是全局可读；
 *  - 读取失败**不覆盖原文件**，退回空表 + `problems[]` 如实报告。
 *
 * 明确不做的事：
 *  - 不记录任何凭据、token、邮箱或会话标识（`:875` 前半句要求 secret canary 无泄漏）；
 *  - 不调用宿主、不发起任何网络请求、不 spawn 子进程——纯本地文件操作。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** 与 `settings.cjs` 的 `settings.json` 同根同层。 */
const JOURNAL_FILE_NAME = 'journal.json';

/**
 * 条目数上限。
 *
 * 取一个**小到能测**的值：真实产品量级应由配置决定，但本轮验收需要在不写几千条
 * 的前提下触发容量边界，故默认取小值并在测试里显式传容量覆盖，不依赖默认值。
 */
const JOURNAL_MAX_ENTRIES = 512;

/**
 * 结果未知的记录状态。**这一类永不参与淘汰。**
 *
 * 依据 `packages/api/src/errors.ts:53` 的 `upstream_outcome_unknown`：驱动器在产出过程中
 * 抛错时结果不可知，「不允许被内部重试掩盖」（`errors.ts:121`）。journal 若把这类记录
 * 淘汰掉，界面就会呈现出「什么都没发生过」，那是把不可知伪装成干净。
 */
const JOURNAL_STATE_UNKNOWN = 'unknown';

/** 全部合法状态。新增状态必须同时补 `evictable()` 的判定，否则会静默改变淘汰语义。 */
const JOURNAL_STATES = Object.freeze(['in_flight', 'done', 'failed', JOURNAL_STATE_UNKNOWN]);

/**
 * @param {string} userDataDir `app.getPath('userData')`。
 * @returns {string}
 */
function journalFilePath(userDataDir) {
  return path.join(userDataDir, JOURNAL_FILE_NAME);
}

/**
 * 读 journal。文件缺失是正常首启；文件损坏**不静默吞掉**——退回空表并如实报告问题，
 * 且**不覆盖原文件**（与 `settings.cjs:270-278` 同款处理）。
 *
 * @param {string} file
 * @returns {{ entries: JournalEntry[], problems: string[] }}
 */
function loadJournal(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { entries: [], problems: [] };
  }

  /** @type {string[]} */
  const problems = [];

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      entries: [],
      problems: [
        `JOURNAL_FILE_UNREADABLE: ${err instanceof Error ? err.message : String(err)}（已退回空 journal，未覆盖原文件）`
      ]
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { entries: [], problems: ['JOURNAL_FILE_SHAPE: 顶层不是对象，已退回空 journal'] };
  }

  // 类型层收窄用，不改变任何运行行为。
  const container = /** @type {{ entries?: unknown }} */ (parsed);
  const rawEntries = Array.isArray(container.entries) ? /** @type {unknown[]} */ (container.entries) : null;
  if (rawEntries === null) {
    problems.push('JOURNAL_ENTRIES_MISSING: 缺少 entries 数组，已退回空 journal');
    return { entries: [], problems };
  }

  /** @type {JournalEntry[]} */
  const entries = [];
  rawEntries.forEach((item, index) => {
    const bad = validateEntry(item);
    if (bad !== null) {
      // 单条损坏就丢单条并记录，**不整份丢弃**：其余记录是仍然有效的事实证据。
      problems.push(`JOURNAL_ENTRY_DROPPED: [${index}] ${bad}`);
      return;
    }
    // validateEntry 通过即等价于 JournalEntry（它就是 JournalEntry 的运行时校验器）。
// 这里把这条**既有契约显式化**，让编译器知道 narrow 之后是什么；
// 不是把类型检查关掉——校验本身仍在 validateEntry 里逐字段做。
    entries.push(/** @type {JournalEntry} */ (item));
  });

  return { entries, problems };
}

/**
 * 校验单条记录。`unknown` 记录额外要求 `outcome` 非空——
 * 结果未知的记录必须留下「未知在哪个环节未知」这一事实，否则它和 `done` 没区别。
 *
 * @param {unknown} item
 * @returns {string | null} null = 合法
 */
function validateEntry(item) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return '不是对象';
  const o = /** @type {Record<string, unknown>} */ (item);
  const id = typeof o['operationId'] === 'string' ? o['operationId'] : '<无 id>';
  if (typeof o['operationId'] !== 'string' || o['operationId'].trim() === '') return '缺少 operationId';
  if (typeof o['state'] !== 'string' || !JOURNAL_STATES.includes(/** @type {any} */ (o['state']))) {
    return `${id}: state 非法：${String(o['state'])}`;
  }
  if (o['state'] === JOURNAL_STATE_UNKNOWN && (typeof o['outcome'] !== 'string' || o['outcome'].trim() === '')) {
    return `${id}: unknown 记录必须带 outcome（不可知也必须说明不可知在哪里）`;
  }
  return null;
}

/**
 * 该条目是否**允许**被淘汰。
 *
 * `unknown` 明确不可淘汰；`in_flight` 也不可淘汰——
 * 正在跑的登记消失后，同键重试会变成一次新的驱动调用，等于把同一次操作执行两次
 * （这正是 `server.ts:801-813` 记过的取舍）。只有已结算的 `done` / `failed` 可淘汰。
 *
 * @param {JournalEntry} entry
 * @returns {boolean}
 */
function evictable(entry) {
  return entry.state !== JOURNAL_STATE_UNKNOWN && entry.state !== 'in_flight';
}

/**
 * 创建 journal 实例。
 *
 * 写入一律走 `persist()`，**只有真正落盘成功**才更新 `committed`——
 * 内存态与落盘态分开记，是为了让「写失败」能被如实报告，而不是假装成功。
 *
 * @param {object} [options]
 * @param {string} [options.dir] 数据目录。测试传临时目录；生产传 `app.getPath('userData')`。
 * @param {number} [options.maxEntries] 容量上限。
 * @param {() => void} [options.onWriteError] 写失败时的通知（便于测试注入失败）。
 * @param {boolean} [options.failWrites] 注入写失败，用于验证写失败语义。
 */
function createJournal(options = {}) {
  // `dir` 归一为 `string | null`。此前它是 `string | undefined`，于是
  // `fs.mkdirSync(dir)` / `journalFilePath(dir)` 一路带着 `undefined` 走进类型系统，
  // checkJs 下报 4 处 TS18048/TS2345。**修法不是加断言压制**（那等于把类型检查关掉），
  // 而是在边界显式归一：缺目录时所有落盘动作如实返回 `journal_dir_missing`，
  // 而不是拿 undefined 去拼路径抛一个调用方看不懂的 TypeError。
  // 这条路径此前不可达（所有调用方都传了 dir），可观察差异仅限「抛 TypeError」→「结构化失败」。
  const dir = typeof options.dir === 'string' && options.dir !== '' ? options.dir : null;
  const maxEntries = typeof options.maxEntries === 'number' && Number.isInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries
    : JOURNAL_MAX_ENTRIES;
  const failWrites = options.failWrites === true;

  /** @type {JournalEntry[]} */
  let entries = [];
  /** @type {string[]} */
  let problems = [];

  return {
    /**
     * 从磁盘载入。损坏条目逐条报告并丢弃，**保留其余记录**。
     * @param {string | null} [dataDir]
     */
    load(dataDir = dir) {
      const target = typeof dataDir === 'string' ? dataDir : dir;
      if (target === null) {
        return {
          entries: [],
          problems: ['JOURNAL_DIR_MISSING: 未提供数据目录，已退回空 journal（未覆盖任何原文件）']
        };
      }
      const r = loadJournal(journalFilePath(target));
      entries = r.entries;
      problems = r.problems;
      return { entries: entries.slice(), problems: problems.slice() };
    },

    /**
     * 追加一条记录。
     *
     * **容量不足时明确拒绝新发**：先淘汰可淘汰的旧条目腾位置；腾不出位置就
     * 返回 `{ ok: false, reason: 'journal_capacity_exceeded' }`，
     * **既不丢旧条目、也不假装写入成功**。调用方据此拒绝这次新发。
     *
     * @param {{ operationId: string, state: string, outcome?: string, at?: number }} input
     * @returns {{ ok: boolean, reason: string | null, evicted: number, entry: JournalEntry | null, duplicate: boolean }}
     */
    append(input) {
      const bad = validateEntry({ ...input });
      if (bad !== null) {
        return { ok: false, reason: `journal_entry_invalid: ${bad}`, evicted: 0, entry: null, duplicate: false };
      }

      // 重复键幂等：同一 operationId 不产生第二条，返回既有条目。
      const existing = entries.find((e) => e.operationId === input.operationId);
      if (existing !== undefined) {
        return { ok: true, reason: null, evicted: 0, entry: { ...existing }, duplicate: true };
      }

      const entry = {
        operationId: input.operationId,
        state: input.state,
        outcome: input.state === JOURNAL_STATE_UNKNOWN ? input.outcome : undefined,
        at: typeof input.at === 'number' ? input.at : Date.now()
      };

      const next = [entry, ...entries];

      // 第一阶段：算需要腾出多少位。条目总数超容量时，要腾出 (总数 - 容量) 个位置。
      const overflow = next.length - maxEntries;
      if (overflow <= 0) {
        const wrote = persistWith(next);
        if (!wrote.ok) {
          return { ok: false, reason: wrote.reason, evicted: 0, entry: null, duplicate: false };
        }
        entries = next;
        return { ok: true, reason: null, evicted: 0, entry: { ...entry }, duplicate: false };
      }

      // 第二阶段：从最旧开始淘汰，**只淘汰旧的 evictable 条目**。
      // 新条目自身**不能**作为淘汰对象来给自己腾位——那等于「拒发」变成了「静默丢新发」。
      // 若可淘汰的**旧**条目不足以腾出空间 ⇒ 明确拒绝新发：
      // 既不丢事实证据（unknown / in_flight），也不假装写入成功。
      const oldEvictableCount = entries.filter((e) => evictable(e)).length;
      if (oldEvictableCount < overflow) {
        return {
          ok: false,
          reason: 'journal_capacity_exceeded',
          evicted: 0,
          entry: null,
          duplicate: false
        };
      }

      /** 先算出「保留哪些旧条目」，最后再拼成 [新, ...旧] 的统一方向。 */
      /** @type {JournalEntry[]} */
      const survivors = [];
      let evicted = 0;
      // entries 是「新 → 旧」排列（append 用 [新, ...旧]），所以**从末尾往前**才是最旧优先。
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const e = entries[i];
        // `noUncheckedIndexedAccess` 下索引访问是 `T | undefined`。用**显式跳过**处理越界，
        // 而不是 `!` 断言——断言等于把这一处的类型检查关掉。
        if (e === undefined) continue;
        if (evicted < overflow && evictable(e)) {
          evicted += 1;
          continue;
        }
        survivors.push(e);
      }
      survivors.reverse(); // 回到「新 → 旧」
      const kept = [entry, ...survivors];

      const wrote = persistWith(kept);
      if (!wrote.ok) {
        // 写失败：内存态保持原样（不假装成功），如实返回失败。
        return { ok: false, reason: wrote.reason, evicted: 0, entry: null, duplicate: false };
      }

      entries = kept;
      return { ok: true, reason: null, evicted, entry: { ...entry }, duplicate: false };
    },

    /**
     * 标记取消。
     *
     * 取消**不改写已有 `unknown`**：结果已不可知的记录不会因为客户端取消就变成 `failed`，
     * 那会把「不可知」洗成「已知失败」。取消只登记一条独立的取消事实。
     *
     * @param {string} operationId
     * @param {string} [reason]
     */
    cancel(operationId, reason = 'client_cancelled') {
      return this.append({ operationId: `${operationId}#cancel`, state: 'failed', outcome: reason });
    },

    /** @returns {JournalEntry[]} 当前记录副本。 */
    list() {
      return entries.slice();
    },

    /** @returns {number} */
    size() {
      return entries.length;
    },

    /** @returns {string[]} */
    listProblems() {
      return problems.slice();
    },

    /** @returns {number} */
    capacity() {
      return maxEntries;
    }
  };

  /**
   * 用指定内容落盘，避免 persist() 闭包只认 entries。
   * @param {JournalEntry[]} snapshot
   */
  function persistWith(snapshot) {
    if (failWrites) return { ok: false, reason: 'journal_write_failed' };
    if (dir === null) return { ok: false, reason: 'journal_dir_missing' };
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = journalFilePath(dir);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({ entries: snapshot }, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      });
      fs.renameSync(tmp, file);
      return { ok: true, reason: null };
    } catch (err) {
      return {
        ok: false,
        reason: `journal_write_failed: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  }
}

/**
 * journal 记录。`outcome` 只在 `unknown` 时有意义。
 *
 * @typedef {object} JournalEntry
 * @property {string} operationId
 * @property {string} state
 * @property {string | undefined} outcome
 * @property {number} at
 */

exports.JOURNAL_FILE_NAME = JOURNAL_FILE_NAME;
exports.JOURNAL_MAX_ENTRIES = JOURNAL_MAX_ENTRIES;
exports.JOURNAL_STATE_UNKNOWN = JOURNAL_STATE_UNKNOWN;
exports.JOURNAL_STATES = JOURNAL_STATES;
exports.journalFilePath = journalFilePath;
exports.loadJournal = loadJournal;
exports.validateEntry = validateEntry;
exports.evictable = evictable;
exports.createJournal = createJournal;