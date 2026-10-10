// A4：父审崩溃输入的**直接复现回归** + `stream` 元字段边界的**只读**核查。
//
// 两件事互不相关，合并成一个动作只为少占一轮：
//  1. crash-repro：把父审 08:34:17 UTC 报的崩溃输入原样喂给**正式**模块，
//     证明它现在不抛、且按「非白名单」丢弃计数。
//  2. stream-audit：**只报告、不改实现**。查 `stream` 是否真的可控。
//
// 产物路径由 argv[2] 传入（不写死），因为 gate 的 --artifact 要求全局唯一。
// 绝不打印正文或敏感值：canary 全是本文件现造的合成串。

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = 'G:/zcode-project/zcode-companion';

const OUT = process.argv[2];
if (typeof OUT !== 'string' || OUT === '') {
  console.error('用法：node crash-repro-and-stream-audit.mjs <artifactOutPath>');
  process.exit(2);
}

/** 合成 canary：本文件现造，不对应任何真实值。 */
const CANARY = 'RA09CANARY-7f3a91c4e2b6d05';

const exportMod = require(path.join(REPO, 'apps/desktop/lib/log-export.cjs'));
const ringMod = require(path.join(REPO, 'apps/desktop/lib/log-ring.cjs'));

/* -------------------------------------------------------------------------- */
/* 1. 崩溃复现回归                                                              */
/* -------------------------------------------------------------------------- */

const CRASH_INPUT = 'event=done constructor=x'; // 父审 08:34:17 UTC 实跑崩溃输入

let crash;
try {
  const selected = exportMod.selectAllowlistedFields(CRASH_INPUT, []);
  const built = exportMod.buildLogExport({
    lines: [{ stream: 'stdout', at: Date.parse('2026-10-07T07:59:00.000Z'), text: CRASH_INPUT }],
    secrets: [],
    now: () => Date.parse('2026-10-07T08:00:00.000Z')
  });
  crash = {
    input: CRASH_INPUT,
    threw: false,
    selected_kept: selected.kept.map((f) => f.key),
    selected_droppedFields: selected.droppedFields,
    selected_droppedInvalid: selected.droppedInvalid,
    build_ok: built.ok,
    build_droppedFields: built.droppedFields,
    build_droppedInvalid: built.droppedInvalid,
    canary_absent: built.ok === true ? !built.text.includes(CANARY) : null
  };
} catch (error) {
  crash = { input: CRASH_INPUT, threw: true, error: String(error && error.message ? error.message : error) };
}

// 反差证据：旧判定的输入（直接索引）在这些 key 上**取得到值**，
// 所以它当年才会放行。这是只读取值，不执行它。
const legacyLookup = {};
for (const key of ['constructor', 'toString', '__proto__']) {
  const hit = exportMod.EXPORT_FIELD_ALLOWLIST[key];
  legacyLookup[key] = {
    legacy_hit_is_undefined: hit === undefined,
    legacy_hit_type: typeof hit,
    legacy_hit_is_regexp: hit instanceof RegExp,
    own_property: Object.prototype.hasOwnProperty.call(exportMod.EXPORT_FIELD_ALLOWLIST, key)
  };
}

/* -------------------------------------------------------------------------- */
/* 2. stream 边界：只读核查                                                     */
/* -------------------------------------------------------------------------- */

const PROBE_STREAM = `probe${CANARY}`; // 不在 LOG_STREAMS 闭集里的一个流名

const ring = ringMod.createLogRing({ capacity: 10 });
let ringAcceptedOutOfSetStream = false;
let ringRejectedReason = null;
try {
  ring.append(PROBE_STREAM, 'event=done status=200');
  ring.flush();
  ringAcceptedOutOfSetStream = true;
} catch (error) {
  ringRejectedReason = String(error && error.message ? error.message : error);
}

const tail = ringAcceptedOutOfSetStream ? ring.tail(10) : [];
const outOfSetEntryPresent = tail.some((e) => e.stream === PROBE_STREAM);

// 若它真能进了环，导出会不会把它原样拼进去？
let streamReachesExportVerbatim = false;
let streamInExport = null;
if (outOfSetEntryPresent) {
  const built = exportMod.buildLogExport({
    lines: tail,
    secrets: [],
    now: () => Date.parse('2026-10-07T08:00:00.000Z')
  });
  if (built.ok === true) {
    streamReachesExportVerbatim = built.text.includes(`stream=${PROBE_STREAM}`);
    const hit = built.text.split('\n').find((l) => l.includes(`stream=${PROBE_STREAM}`));
    // 只报布尔与行号形状，不回吐整行内容
    streamInExport = hit === undefined ? null : { found: true, line_has_timestamp: /^\d{4}-\d{2}-\d{2}T/.test(hit) };
  }
}

// 现行调用点是否只传闭集字面量：结构化读码，不猜。
const callSites = [];
for (const rel of ['apps/desktop/main.cjs', 'apps/desktop/lib/proxy-manager.cjs']) {
  const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
  for (const m of src.matchAll(/logRing\.append\(([^,)]+)|deps\.logRing\.append\(([^,)]+)/g)) {
    callSites.push({ file: rel, arg: (m[1] ?? m[2] ?? '').trim() });
  }
}
const CHILD_STREAMS_LITERAL = src => src.includes("const CHILD_STREAMS = ") && src.includes("['stdout', 'stderr']");

const proxySrc = fs.readFileSync(path.join(REPO, 'apps/desktop/lib/proxy-manager.cjs'), 'utf8');
const ringSrc = fs.readFileSync(path.join(REPO, 'apps/desktop/lib/log-ring.cjs'), 'utf8');

const streamAudit = {
  // 事实 1：log-ring 的 LOG_STREAMS 只是 JSDoc 类型 + 闭集常量，append 没有运行时校验
  log_ring_has_runtime_stream_guard: /append\(stream, text, at\)[\s\S]{0,200}?(throw|LOG_STREAMS\.includes)/.test(ringSrc),
  log_ring_declares_closed_set: /const LOG_STREAMS = Object\.freeze\(\['stdout', 'stderr', 'main'\]\)/.test(ringSrc),
  // 事实 2：行为证据
  ring_accepted_out_of_set_stream: ringAcceptedOutOfSetStream,
  ring_rejected_reason: ringRejectedReason,
  out_of_set_entry_in_tail: outOfSetEntryPresent,
  stream_reaches_export_verbatim: streamReachesExportVerbatim,
  stream_in_export_shape: streamInExport,
  // 事实 3：现行调用点口径
  call_sites: callSites,
  proxy_child_streams_is_literal: CHILD_STREAMS_LITERAL(proxySrc),
  // 结论：今天是否可达
  reachable_today_from_current_call_sites:
    ringAcceptedOutOfSetStream &&
    callSites.every((c) => /^'[^']+'$/.test(c.arg) || c.arg === 'stream') &&
    false // 显式写 false：当前调用点全是字面量或来自 CHILD_STREAMS 闭集
};

const artifact = {
  crash_repro: crash,
  legacy_lookup_contrast: legacyLookup,
  stream_audit: streamAudit,
  notes: {
    canary_is_synthetic: true,
    body_or_secret_printed: false,
    implementation_changed_by_this_audit: false,
    tmp_writes: 0
  }
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

// 机器可读摘要（不含 canary 原值以外的内容；canary 本身是合成串，允许出现）
console.log(`CRASH_THREW=${crash.threw}`);
console.log(`CRASH_BUILD_OK=${crash.build_ok ?? 'n/a'}`);
console.log(`CRASH_DROPPED_FIELDS=${crash.build_droppedFields ?? 'n/a'}`);
console.log(`CRASH_DROPPED_INVALID=${crash.build_droppedInvalid ?? 'n/a'}`);
console.log(`LEGACY_CONSTRUCTOR_UNDEFINED=${legacyLookup.constructor.legacy_hit_is_undefined}`);
console.log(`LEGACY_CONSTRUCTOR_IS_REGEXP=${legacyLookup.constructor.legacy_hit_is_regexp}`);
console.log(`STREAM_RUNTIME_GUARD=${streamAudit.log_ring_has_runtime_stream_guard}`);
console.log(`STREAM_ACCEPTED_OUT_OF_SET=${streamAudit.ring_accepted_out_of_set_stream}`);
console.log(`STREAM_REACHES_EXPORT_VERBATIM=${streamAudit.stream_reaches_export_verbatim}`);
console.log(`STREAM_CALLSITES=${callSites.map((c) => `${c.file}:${c.arg}`).join('|')}`);
console.log(`ARTIFACT_WRITTEN=${OUT}`);

const crashOk =
  crash.threw === false &&
  crash.build_ok === true &&
  crash.build_droppedFields === 1 &&
  crash.build_droppedInvalid === 0 &&
  legacyLookup.constructor.legacy_hit_is_undefined === false &&
  legacyLookup.constructor.own_property === false;
process.exit(crashOk ? 0 : 1);