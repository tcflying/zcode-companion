/**
 * UI02 —— 模型 / 套餐来源的两种模式（动态刷新 / 写死固定）。
 *
 * 硬约束：
 * 1. 刷新**只读取来源**，不发送任何模型请求；本文件不含 fetch/XHR/网络代码，也不做 endpoint 拼接。
 *    契约路径只作为**字符串常量**出现（用于与 API01 对齐形状），运行期不会据此发起任何请求。
 * 2. 写死条目一律 `availability = 'unverified'`（手工录入、未由官方验证），
 *    且 `sendEligible` 在类型层面就是字面量 `false`——录入再多也不会获得可发送资格。
 * 3. 额度现状如实呈现：普通套餐与 Start Plan 当前都没有额度，界面只能显示 `无可用额度`，
 *    不得出现任何看起来像真实可用套餐的名称、数值或剩余量。
 * 4. 刷新失败必须保留明确的失败原因与时间戳，并**保留刷新前读到的旧列表**，
 *    不得静默回退到空列表或假数据。
 *
 * 数据源契约（协调者裁定，照抄不另造，UI02-F1）：
 *   `GET /v1/zcc/catalog` →
 *     { revision: string,
 *       models: [ { modelId: string, displayName: string, provider: string,
 *                    billingClass: 'subscription'|'promotion'|'metered_api'|'unknown',
 *                    contextLength: number|null, reasoning: string[], capabilities: string[] } ] }
 * 外部 IDE 用的标准 `/v1/models`（id/object/created/owned_by）**不是**本来源，
 * 解析层会显式拒绝该形状（defect `payload_foreign_shape`），不解析、不部分采纳。
 *
 * 解析层策略：字段缺失 / 类型错 / 非法枚举 / 重复 modelId → **整体拒绝**，
 * 一次都不采纳，缺陷逐条列出并进入 UI 错误面板（失败原因 `malformed_payload`）。
 *
 * 本文件**不 import `packages/api/**` 或 `packages/contracts/**` 的任何代码**；
 * 契约形状只在此处被假定，测试用本地 fixture 模拟。
 */

import {
  BILLING_CLASSES,
  CURRENT_EVIDENCE,
  SEND_DISABLED_LABEL,
  type BillingClass
} from './snapshot';

/* ------------------------------------------------------------------ *
 * 模式
 * ------------------------------------------------------------------ */

export type SourceMode = 'dynamic' | 'manual';

export const SOURCE_MODES: SourceMode[] = ['dynamic', 'manual'];

export const SOURCE_MODE_LABEL: Record<SourceMode, string> = {
  dynamic: 'dynamic · 动态刷新（手动点刷新重新读取来源）',
  manual: 'manual · 写死固定（主上手工录入条目）'
};

export const SOURCE_MODE_DESC: Record<SourceMode, string> = {
  dynamic: '来源由本机读取，手动点「刷新来源」重新读一次。刷新只读取目录，不发送任何模型请求。',
  manual: '由主上手工录入条目。录入内容不会被官方验证，也不会因此获得可发送资格。'
};

/**
 * 契约路径常量。相对路径常量，**不是**完整 URL。
 * 本文件本身不发起任何请求；UI04 起由 `localApiSource.ts` 把它拼到被回环守卫放行的
 * base URL 后面（同源即直接用本常量）。
 */
export const SOURCE_ENDPOINT = '/v1/zcc/catalog';

/** 动态模式的来源通道。UI04 起 `local_api` 有真实执行器（回环守卫 + fetch），`local_config_file` 仍未接线。 */
export type SourceTransport = 'local_api' | 'local_config_file';

export const SOURCE_TRANSPORTS: SourceTransport[] = ['local_api', 'local_config_file'];

export const SOURCE_TRANSPORT_LABEL: Record<SourceTransport, string> = {
  local_api: '本机 companion API（读取模型目录）',
  local_config_file: '本地配置文件（读取模型目录）'
};

export const SOURCE_TRANSPORT_DESC: Record<SourceTransport, string> = {
  local_api:
    `契约：${SOURCE_ENDPOINT}。UI04 起本通道有真实执行器：设置页显式开启「连接本机 API」后，` +
    '只向本机回环（或同源反代）发起 GET 请求，只读取目录、不发任何模型请求；未开启时按未接线失败并显示原因。',
  local_config_file: '契约：读取本产品数据目录下的模型目录 JSON，形状同 GET /v1/zcc/catalog。本轮未接线，刷新会失败并显示原因。'
};

/** 契约形状说明（同时展示在界面上，便于 API01 并行实现时对齐）。 */
export const SOURCE_CONTRACT_NOTE =
  `契约（协调者裁定，照此实现）：来源读取端点 ${SOURCE_ENDPOINT}，返回 ` +
  '{ revision: string, models: [{ modelId, displayName, provider, ' +
  "billingClass: 'subscription'|'promotion'|'metered_api'|'unknown', " +
  'contextLength: number|null, reasoning: string[], capabilities: string[] }] }。' +
  '外部 IDE 用的标准 /v1/models（id/object/created/owned_by）不是本来源，解析层会整体拒绝。' +
  '字段缺失 / 类型错 / 非法枚举一律整体拒绝并进错误面板，不部分采纳、不静默降级。' +
  'UI04 起：开启「连接本机 API」后真实 fetch 该端点（仅回环 / 同源，仍不发送任何模型请求）；未开启则按未接线失败。';

/* ------------------------------------------------------------------ *
 * 条目
 * ------------------------------------------------------------------ */

/** 来源可读性 / 资格状态。两种模式的条目在 E0 下都只能是 unverified。 */
export type Availability = 'unverified';

/** 写死条目的固定标记。 */
export const MANUAL_ENTRY_BADGE = '手工录入 · 未由官方验证';
export const UNVERIFIED_LABEL = '未验证';

export interface ModelEntry {
  /** 行内唯一键。动态来源用 `source:${modelId}`，写死条目用 `manual:<id>`。 */
  key: string;
  displayName: string;
  provider: string;
  modelId: string;
  billingClass: BillingClass;
  /** token 数；null = 来源显式声明为 null。 */
  contextLength: number | null;
  /** 推理档位数组（契约 string[]）；空数组 = 来源声明无档位。 */
  reasoning: string[];
  /** 能力标签数组（契约 string[]）；空数组 = 来源声明无能力。 */
  capabilities: string[];
  origin: 'source' | 'manual';
  availability: Availability;
  /** 恒为 false：无论计费类别、无论录入多少条，发送门都因 E0 关闭。 */
  sendEligible: false;
  note: string;
}

export interface ManualDraft {
  displayName: string;
  provider: string;
  modelId: string;
  billingClass: BillingClass;
  contextLength: string;
  /** 录入用逗号/空格分隔文本，构造条目时切成数组（与契约的 string[] 对齐）。 */
  reasoning: string;
  capabilities: string;
  note: string;
}

export const EMPTY_MANUAL_DRAFT: ManualDraft = {
  displayName: '',
  provider: '',
  modelId: '',
  billingClass: 'unknown',
  contextLength: '',
  reasoning: '',
  capabilities: '',
  note: ''
};

export interface ManualValidation {
  ok: boolean;
  errors: string[];
}

function splitTags(raw: string): string[] {
  return raw
    .split(/[,，;；\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 录入校验：必填项 + 上下文长度必须是正整数（或留空表示来源未提供）。 */
export function validateManualDraft(draft: ManualDraft): ManualValidation {
  const errors: string[] = [];
  if (!draft.displayName.trim()) errors.push('显示名不能为空');
  if (!draft.modelId.trim()) errors.push('modelId 不能为空');
  if (!BILLING_CLASSES.includes(draft.billingClass)) errors.push(`计费类别必须是 ${BILLING_CLASSES.join(' | ')}`);
  if (draft.contextLength.trim()) {
    const n = Number(draft.contextLength.trim());
    if (!Number.isInteger(n) || n <= 0) errors.push('上下文长度必须是正整数（留空表示来源未提供）');
  }
  return { ok: errors.length === 0, errors };
}

export function parseContextLength(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n > 0 ? n : null;
}

let manualSeq = 0;

/** 由草稿构造一条写死条目。恒为未验证、恒不可发送。 */
export function buildManualEntry(draft: ManualDraft): ModelEntry {
  manualSeq += 1;
  return {
    key: `manual:m${manualSeq}`,
    displayName: draft.displayName.trim(),
    provider: draft.provider.trim() || 'unknown',
    modelId: draft.modelId.trim(),
    billingClass: draft.billingClass,
    contextLength: parseContextLength(draft.contextLength),
    reasoning: splitTags(draft.reasoning),
    capabilities: splitTags(draft.capabilities),
    origin: 'manual',
    availability: 'unverified',
    sendEligible: false,
    note: draft.note.trim() || MANUAL_ENTRY_BADGE
  };
}

/* ------------------------------------------------------------------ *
 * 发送资格：E0 下恒定拒绝，与来源模式无关
 * ------------------------------------------------------------------ */

export interface SendEligibility {
  eligible: false;
  label: string;
  reason: string;
}

export function sendEligibilityFor(entry: ModelEntry): SendEligibility {
  return {
    eligible: false,
    label: SEND_DISABLED_LABEL,
    reason:
      `${entry.origin === 'manual' ? MANUAL_ENTRY_BADGE : '来源读回（资格未验证）'}；` +
      `可用性：${UNVERIFIED_LABEL}。当前证据等级 ${CURRENT_EVIDENCE}，发送门关闭。` +
      `写死录入或来源刷新都不会解锁发送。`
  };
}

/** 计费类别层面的通道准入（与 snapshot.BILLING_CLASS_SENDABLE 同源，勿分叉）。 */
export function channelAccepted(billingClass: BillingClass): boolean {
  return billingClass === 'subscription' || billingClass === 'promotion';
}

/* ------------------------------------------------------------------ *
 * 失败原因：单一来源（UI 错误面板只从这里取文案）
 * ------------------------------------------------------------------ */

export type RefreshFailureReason =
  | 'api_not_running'
  | 'connection_failed'
  | 'timeout'
  | 'transport_not_wired'
  | 'malformed_payload'
  | 'empty_source';

/** 失败原因码清单（顺序即界面登记顺序）。新增原因必须同时补 REFRESH_FAILURE_INFO。 */
export const REFRESH_FAILURE_REASONS: RefreshFailureReason[] = [
  'api_not_running',
  'connection_failed',
  'timeout',
  'transport_not_wired',
  'malformed_payload',
  'empty_source'
];

/**
 * 失败原因的**唯一**文案来源。
 * 标题 / 人读说明 / 处理建议三者对**所有**已登记原因都必须非空；
 * 未知原因码走 {@link UNKNOWN_FAILURE_INFO} 兜底，不空白、不吞掉。
 */
export interface RefreshFailureInfo {
  title: string;
  human: string;
  remedy: string;
  /**
   * 该原因下界面是否保留刷新前读到的列表。
   * 写成数据而不是靠调用方自觉：六种原因**全部**为 true（硬保证），
   * 状态机另有测试守 `entries` 字段不被覆盖。
   */
  keepsPreviousList: boolean;
}

export const REFRESH_FAILURE_INFO: Record<RefreshFailureReason, RefreshFailureInfo> = {
  api_not_running: {
    title: '本机 API 未启动',
    human:
      '来源通道选的是本机 companion API，但本机没有正在监听该端口的进程。' +
      '这不是"来源为空"，而是来源根本没能被读取。',
    remedy:
      '先启动本机 companion API 进程并确认它在监听，再点刷新。' +
      '在此之前界面保留刷新前读到的列表，不回退到空列表，也不填入任何替代数据。',
    keepsPreviousList: true
  },
  connection_failed: {
    title: '连接失败',
    human:
      '尝试连接来源端口时被拒绝或不可达（典型如 ECONNREFUSED / 端口未开放）。' +
      '连接没有建立，因此没有任何目录内容被读回。',
    remedy:
      '核对来源端口与本机 API 的实际监听地址是否一致、进程是否仍在运行，再点刷新。' +
      '界面保留刷新前读到的列表，不清空、不填假数据。',
    keepsPreviousList: true
  },
  timeout: {
    title: '读取超时',
    human: '来源已接受连接但在约定时间内没有返回完整的目录响应，读到的内容不完整。',
    remedy:
      '确认来源侧没有卡死或被长时间占用，稍后重试刷新。' +
      '超时不做部分采纳：界面保留刷新前读到的列表，不用半截数据覆盖。',
    keepsPreviousList: true
  },
  transport_not_wired: {
    title: '来源通道未接线',
    human:
      '这条来源通道本轮还没有真实执行器（UI 不发起任何网络请求、也不读任何磁盘文件），' +
      '因此刷新按失败呈现，而不是假装成功。',
    remedy:
      '等真实执行器由后续工单接线之后再点刷新。' +
      '在此之前刷新一律按失败呈现，保留刷新前读到的列表，不回退到空列表或假数据。',
    keepsPreviousList: true
  },
  malformed_payload: {
    title: '来源响应不符合契约',
    human:
      `来源返回的响应与 ${SOURCE_ENDPOINT} 契约不一致：字段缺失、类型不符、枚举值非法或 modelId 重复。` +
      '解析层按"整体拒绝"处理，一条都不采纳，也不降级成 unknown 之后继续显示。',
    remedy:
      '按错误面板逐条列出的字段路径修正来源侧（契约字段一个都不能省），再点刷新。' +
      '界面保留刷新前读到的列表，不用不合规内容覆盖。',
    keepsPreviousList: true
  },
  empty_source: {
    title: '来源返回 0 个条目',
    human: `来源读取成功，但 ${SOURCE_ENDPOINT} 的 models 是空数组，当前没有可展示的目录条目。`,
    remedy:
      '确认账号侧是否真的没有任何目录条目；空来源按失败呈现而不是"成功的空列表"，' +
      '界面保留刷新前读到的列表，不用空数组覆盖。',
    keepsPreviousList: true
  }
};

/** 未知原因码的通用兜底文案。不是空白，也不是静默吞掉。 */
export const UNKNOWN_FAILURE_INFO: RefreshFailureInfo = {
  title: '未登记的失败原因',
  human:
    '来源读取失败，但返回的原因码不在本版本已登记的失败原因表内。' +
    '界面不猜测它的含义、也不静默吞掉：原始原因码照原样显示在下方的「失败原因」一行里。',
  remedy:
    '把该原因码连同发生时间一起反馈给本产品；在拿到正式定义之前一律按未知处理，' +
    '保留刷新前读到的列表，不回退到空列表，也不填入任何替代数据。',
  keepsPreviousList: true
};

export function isRefreshFailureReason(v: string): v is RefreshFailureReason {
  return (REFRESH_FAILURE_REASONS as string[]).includes(v);
}

export interface RefreshFailureView {
  /** 原始原因码，原样显示（未知码也不替换、不隐藏）。 */
  code: string;
  /** true = 命中已登记映射；false = 走通用兜底。 */
  known: boolean;
  info: RefreshFailureInfo;
}

/** 失败原因 → 渲染视图。**所有**码都返回非空文案，未知码走兜底。 */
export function describeRefreshFailure(reason: string): RefreshFailureView {
  if (isRefreshFailureReason(reason)) {
    return { code: reason, known: true, info: REFRESH_FAILURE_INFO[reason] };
  }
  const info: RefreshFailureInfo = {
    ...UNKNOWN_FAILURE_INFO,
    human: `${UNKNOWN_FAILURE_INFO.human}（本次原因码：${reason || '（空）'}）`
  };
  return { code: reason, known: false, info };
}

export interface RefreshFailure {
  /** 已登记原因码，或未登记的原始码（未知码由 describeRefreshFailure 兜底渲染）。 */
  reason: RefreshFailureReason | (string & {});
  /** 人读标题。与 describeRefreshFailure(...).info.title 同源，由构造方填。 */
  title: string;
  /** 本次失败的具体技术说明（错误文本 / 缺陷逐条）。 */
  detail: string;
  /** 界面上原样显示的建议动作。与 info.remedy 同源时由构造方填。 */
  hint: string;
  /** 解析失败时的逐条契约缺陷（可选）。 */
  defects?: ParseDefect[];
}

/* ------------------------------------------------------------------ *
 * 来源契约解析（GET /v1/zcc/catalog，离线 fixture 测试用）
 * ------------------------------------------------------------------ */

export type ParseDefectCode =
  | 'payload_not_object'
  | 'payload_foreign_shape'
  | 'revision_missing'
  | 'revision_type'
  | 'models_missing'
  | 'models_type'
  | 'entry_not_object'
  | 'field_missing'
  | 'field_empty'
  | 'field_type'
  | 'enum_invalid'
  | 'duplicate_model_id';

export interface ParseDefect {
  code: ParseDefectCode;
  /** JSON 风格定位，如 `$.models[1].billingClass`。 */
  path: string;
  message: string;
}

export interface ParsedSource {
  ok: boolean;
  revision: string;
  /** ok=true 时才有值；ok=false 时**恒为空数组**（整体拒绝，绝不部分采纳）。 */
  entries: ModelEntry[];
  defects: ParseDefect[];
}

/** 把缺陷列表拼成错误面板里的 detail 文本。 */
export function formatDefects(defects: ParseDefect[]): string {
  if (defects.length === 0) return '';
  return defects.map((d) => `${d.code} @ ${d.path}：${d.message}`).join('；');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** 契约里 string[] 字段的严格校验：必须是数组，且每个元素都是非空字符串。 */
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => nonEmptyString(x));
}

/**
 * 把 `GET /v1/zcc/catalog` 契约响应投影成条目列表。
 *
 * 严格策略（UI02-F1 裁定）：字段缺失 / 类型错 / 非法枚举 / 重复 modelId
 * → **整体拒绝**（ok=false、entries=[]），并逐条给出缺陷。
 * 不部分采纳、不猜测 provider、不补齐 modelId、不把非法枚举降级成 unknown。
 */
export function parseCatalogPayload(raw: unknown): ParsedSource {
  const defects: ParseDefect[] = [];
  const add = (code: ParseDefectCode, path: string, message: string) => {
    defects.push({ code, path, message });
  };

  if (!isPlainObject(raw)) {
    add(
      'payload_not_object',
      '$',
      `契约要求顶层是对象，实际是 ${Array.isArray(raw) ? '数组' : raw === null ? 'null' : typeof raw}。`
    );
    return { ok: false, revision: '未接入', entries: [], defects };
  }

  // 外部 IDE 用的标准 /v1/models 形状不是本来源的数据源：显式拒绝，不解析。
  if (Array.isArray(raw['data']) || raw['object'] === 'list' || ('owned_by' in raw && 'id' in raw)) {
    add(
      'payload_foreign_shape',
      '$',
      '这是外部 IDE 用的标准 /v1/models 形状（object/data/id/owned_by），不是本来源；本产品只解析 ' +
        `${SOURCE_ENDPOINT} 的 { revision, models[] }，不做字段猜测。`
    );
    return { ok: false, revision: '未接入', entries: [], defects };
  }

  if (!('revision' in raw)) {
    add('revision_missing', '$.revision', '缺少 revision 字段。');
  } else if (!nonEmptyString(raw['revision'])) {
    add('revision_type', '$.revision', 'revision 必须是非空字符串。');
  }
  const revision = nonEmptyString(raw['revision']) ? raw['revision'].trim() : '未接入';

  if (!('models' in raw)) {
    add('models_missing', '$.models', '缺少 models 数组。');
    return { ok: false, revision, entries: [], defects };
  }
  if (!Array.isArray(raw['models'])) {
    add('models_type', '$.models', `models 必须是数组，实际是 ${typeof raw['models']}。`);
    return { ok: false, revision, entries: [], defects };
  }
  const models = raw['models'] as unknown[];

  const entries: ModelEntry[] = [];
  const seen = new Set<string>();
  models.forEach((m, i) => {
    const at = `$.models[${i}]`;
    if (!isPlainObject(m)) {
      add('entry_not_object', at, `条目必须是对象，实际是 ${Array.isArray(m) ? '数组' : m === null ? 'null' : typeof m}。`);
      return;
    }
    // 必填非空字符串字段
    for (const field of ['modelId', 'displayName', 'provider'] as const) {
      if (!(field in m)) add('field_missing', `${at}.${field}`, `缺少 ${field} 字段。`);
      else if (typeof m[field] !== 'string') {
        add('field_type', `${at}.${field}`, `${field} 必须是字符串，实际是 ${typeof m[field]}。`);
      } else if (!(m[field] as string).trim()) {
        add('field_empty', `${at}.${field}`, `${field} 是空字符串；不允许用空值占位。`);
      }
    }
    // 必填计费类别（枚举）
    if (!('billingClass' in m)) {
      add('field_missing', `${at}.billingClass`, '缺少 billingClass 字段。');
    } else if (!BILLING_CLASSES.includes(m['billingClass'] as BillingClass)) {
      add(
        'enum_invalid',
        `${at}.billingClass`,
        `billingClass 必须是 ${BILLING_CLASSES.join(' | ')}，实际是 ${JSON.stringify(m['billingClass'])}；` +
          '非法枚举一律整体拒绝，不降级成 unknown 后继续显示。'
      );
    }
    // 必填 contextLength：number|null
    if (!('contextLength' in m)) {
      add('field_missing', `${at}.contextLength`, '缺少 contextLength 字段（契约要求 number|null）。');
    } else {
      const ctx = m['contextLength'];
      const okNull = ctx === null;
      const okNum = typeof ctx === 'number' && Number.isInteger(ctx) && ctx > 0;
      if (!okNull && !okNum) {
        add(
          'field_type',
          `${at}.contextLength`,
          `contextLength 必须是正整数或 null，实际是 ${JSON.stringify(ctx)}。`
        );
      }
    }
    // 必填 string[] 字段
    for (const field of ['reasoning', 'capabilities'] as const) {
      if (!(field in m)) {
        add('field_missing', `${at}.${field}`, `缺少 ${field} 字段（契约要求 string[]，可为空数组）。`);
      } else if (!isStringArray(m[field])) {
        add(
          'field_type',
          `${at}.${field}`,
          `${field} 必须是字符串数组（可为空数组），实际是 ${JSON.stringify(m[field])}。`
        );
      }
    }
    const modelId = nonEmptyString(m['modelId']) ? m['modelId'].trim() : null;
    if (modelId === null) return;
    if (seen.has(modelId)) {
      add('duplicate_model_id', `${at}.modelId`, `modelId 重复：${modelId}；不做静默去重，整体拒绝。`);
      return;
    }
    seen.add(modelId);
    const ctx = m['contextLength'];
    entries.push({
      key: `source:${modelId}`,
      displayName: nonEmptyString(m['displayName']) ? m['displayName'].trim() : modelId,
      provider: nonEmptyString(m['provider']) ? m['provider'].trim() : 'unknown',
      modelId,
      billingClass: BILLING_CLASSES.includes(m['billingClass'] as BillingClass)
        ? (m['billingClass'] as BillingClass)
        : 'unknown',
      contextLength: typeof ctx === 'number' && Number.isInteger(ctx) && ctx > 0 ? ctx : null,
      reasoning: isStringArray(m['reasoning']) ? [...(m['reasoning'] as string[])] : [],
      capabilities: isStringArray(m['capabilities']) ? [...(m['capabilities'] as string[])] : [],
      origin: 'source',
      availability: 'unverified',
      sendEligible: false,
      note: '来源读回（资格未验证）'
    });
  });

  if (defects.length > 0) {
    // 整体拒绝：任何一条缺陷都不允许部分采纳。
    return { ok: false, revision, entries: [], defects };
  }
  return { ok: true, revision, entries, defects: [] };
}

/* ------------------------------------------------------------------ *
 * 刷新
 * ------------------------------------------------------------------ */

export type RefreshStatus = 'idle' | 'loading' | 'ok' | 'failed';

export interface RefreshState {
  status: RefreshStatus;
  transport: SourceTransport;
  attemptCount: number;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  revision: string;
  entries: ModelEntry[];
  failure: RefreshFailure | null;
  /** 上一次成功读到的条目数，用于呈现"来源列表变化"。 */
  previousEntryCount: number | null;
}

export interface ListDelta {
  added: string[];
  removed: string[];
  kept: number;
  previous: number | null;
  current: number;
}

export function listDelta(before: ModelEntry[], after: ModelEntry[]): ListDelta {
  const beforeIds = new Set(before.map((e) => e.modelId));
  const afterIds = new Set(after.map((e) => e.modelId));
  const added = after.filter((e) => !beforeIds.has(e.modelId)).map((e) => e.modelId);
  const removed = before.filter((e) => !afterIds.has(e.modelId)).map((e) => e.modelId);
  const kept = after.filter((e) => beforeIds.has(e.modelId)).length;
  return { added, removed, kept, previous: before.length, current: after.length };
}

export function describeDelta(d: ListDelta): string {
  if (d.previous === null || d.previous === 0) {
    return `首次读回：${d.current} 个条目（新增 ${d.added.length}，此前没有可对比的列表）`;
  }
  if (d.added.length === 0 && d.removed.length === 0) return `与上次一致：${d.current} 个条目，无增删`;
  return (
    `与上次相比：新增 ${d.added.length}${d.added.length ? `（${d.added.join('、')}）` : ''}，` +
    `消失 ${d.removed.length}${d.removed.length ? `（${d.removed.join('、')}）` : ''}，` +
    `保持 ${d.kept} 个，${d.previous} → ${d.current}`
  );
}

export function beginRefresh(state: RefreshState, transport: SourceTransport, at: number): RefreshState {
  return {
    ...state,
    status: 'loading',
    transport,
    attemptCount: state.attemptCount + 1,
    lastAttemptAt: at,
    failure: null
  };
}

export function completeRefresh(
  state: RefreshState,
  parsed: ParsedSource,
  at: number
): RefreshState {
  if (!parsed.ok) {
    // 解析失败 → 整体拒绝并进错误面板；旧列表由 failRefresh 原样保留。
    const info = REFRESH_FAILURE_INFO.malformed_payload;
    return failRefresh(
      state,
      {
        reason: 'malformed_payload',
        title: info.title,
        detail:
          formatDefects(parsed.defects) ||
          `来源响应与 ${SOURCE_ENDPOINT} 契约不一致，无法解析。`,
        hint: info.remedy,
        defects: parsed.defects
      },
      at
    );
  }
  if (parsed.entries.length === 0) {
    const info = REFRESH_FAILURE_INFO.empty_source;
    return {
      ...state,
      status: 'failed',
      lastAttemptAt: at,
      previousEntryCount: state.entries.length,
      entries: state.entries,
      failure: {
        reason: 'empty_source',
        title: info.title,
        detail: `来源 revision ${parsed.revision} 返回了空的 models 数组。`,
        hint: info.remedy
      }
    };
  }
  return {
    ...state,
    status: 'ok',
    lastAttemptAt: at,
    lastSuccessAt: at,
    previousEntryCount: state.entries.length,
    revision: parsed.revision,
    entries: parsed.entries,
    failure: null
  };
}

export function failRefresh(state: RefreshState, failure: RefreshFailure, at: number): RefreshState {
  return {
    ...state,
    status: 'failed',
    lastAttemptAt: at,
    previousEntryCount: state.entries.length,
    // entries 原样展开保留：刷新失败绝不回退到空列表或假数据
    failure
  };
}

/* ------------------------------------------------------------------ *
 * 整体来源状态
 * ------------------------------------------------------------------ */

export interface ModelSourceState {
  mode: SourceMode;
  refresh: RefreshState;
  manualEntries: ModelEntry[];
}

export function createInitialSourceState(): ModelSourceState {
  return {
    mode: 'dynamic',
    refresh: {
      status: 'idle',
      transport: 'local_api',
      attemptCount: 0,
      lastAttemptAt: null,
      lastSuccessAt: null,
      revision: '未接入',
      entries: [],
      failure: null,
      previousEntryCount: null
    },
    manualEntries: []
  };
}

export interface SwitchResult {
  state: ModelSourceState;
  /** 切换提示：必须明确告知主上"什么被保留、什么被隐藏"，不静默清空。 */
  notice: string;
  /** true = 两种模式都还有内容，本次切换只是换了展示面。 */
  preserved: boolean;
}

/** 切换模式。**不清空任何已输入内容**：写死条目与上次读到的来源条目都原样保留。 */
export function switchMode(state: ModelSourceState, mode: SourceMode): SwitchResult {
  const next: ModelSourceState = { ...state, mode };
  const srcCount = state.refresh.entries.length;
  const manCount = state.manualEntries.length;
  if (mode === state.mode) {
    return {
      state: next,
      notice: `已处于「${SOURCE_MODE_LABEL[mode]}」，未发生切换。`,
      preserved: srcCount + manCount > 0
    };
  }
  const keptParts: string[] = [];
  if (srcCount > 0) keptParts.push(`动态来源上次读到的 ${srcCount} 个条目`);
  if (manCount > 0) keptParts.push(`已手工录入的 ${manCount} 个条目`);
  const kept = keptParts.length
    ? `已保留：${keptParts.join('；')}。切回原模式即恢复显示，未清空任何内容。`
    : '两种模式当前都没有内容，切换不会清空任何已输入内容。';
  return {
    state: next,
    notice: `已切换到「${SOURCE_MODE_LABEL[mode]}」。${kept}`,
    preserved: keptParts.length > 0
  };
}

export interface AddResult {
  state: ModelSourceState;
  entry: ModelEntry | null;
  errors: string[];
  notice: string;
}

export function addManualEntry(state: ModelSourceState, draft: ManualDraft): AddResult {
  const validation = validateManualDraft(draft);
  if (!validation.ok) {
    return {
      state,
      entry: null,
      errors: validation.errors,
      notice: `录入未通过校验：${validation.errors.join('；')}`
    };
  }
  const entry = buildManualEntry(draft);
  return {
    state: { ...state, manualEntries: [...state.manualEntries, entry] },
    entry,
    errors: [],
    notice: `已录入「${entry.displayName}」（${MANUAL_ENTRY_BADGE}；${UNVERIFIED_LABEL}；${SEND_DISABLED_LABEL}）。录入不改变发送门状态。`
  };
}

export function removeManualEntry(state: ModelSourceState, key: string): ModelSourceState {
  return { ...state, manualEntries: state.manualEntries.filter((e) => e.key !== key) };
}

/** 当前模式下应当展示的条目（尚未做任何筛选）。 */
export function activeEntries(state: ModelSourceState): ModelEntry[] {
  return state.mode === 'manual' ? state.manualEntries : state.refresh.entries;
}

export function filterEntries(
  entries: ModelEntry[],
  query: string,
  billingFilter: 'all' | BillingClass
): ModelEntry[] {
  const q = query.trim().toLowerCase();
  return entries.filter((e) => {
    if (billingFilter !== 'all' && e.billingClass !== billingFilter) return false;
    if (!q) return true;
    return (
      e.displayName.toLowerCase().includes(q) ||
      e.provider.toLowerCase().includes(q) ||
      e.modelId.toLowerCase().includes(q)
    );
  });
}

/* ------------------------------------------------------------------ *
 * 刷新执行器（UI 用）
 * ------------------------------------------------------------------ */

export type SourceLoader = (transport: SourceTransport) => Promise<unknown>;

export class SourceUnavailableError extends Error {
  /** 已登记原因码，或未登记的原始码（未知码由 describeRefreshFailure 兜底渲染）。 */
  reason: RefreshFailureReason | (string & {});
  hint: string;
  constructor(reason: RefreshFailureReason | (string & {}), message: string, hint: string) {
    super(message);
    this.name = 'SourceUnavailableError';
    this.reason = reason;
    this.hint = hint;
  }
}

/**
 * UI02 内置的离线来源执行器：**不发起任何网络请求，也不读任何文件**。
 * 因此刷新一定失败，并按失败原因如实显示，不回退到空列表或假数据。
 *
 * UI04 起这仍是**默认**执行器：设置页没打开「连接本机 API」时选中的就是它。
 * 打开开关后由 `localApiSource.ts` 的回环 fetch 执行器接管。
 */
export const offlineSourceLoader: SourceLoader = (transport) =>
  Promise.reject(
    new SourceUnavailableError(
      'transport_not_wired',
      transport === 'local_api'
        ? `尚未在设置页开启「连接本机 API」，UI 保持完全零网络。契约端点：${SOURCE_ENDPOINT}。`
        : '本地配置文件读取尚未接线，UI 本轮不读取任何磁盘文件。',
      REFRESH_FAILURE_INFO.transport_not_wired.remedy
    )
  );

/** 把执行器的成功/失败统一收敛成 RefreshState。所有失败文案都从单一来源取。 */
export async function runRefresh(
  state: RefreshState,
  loader: SourceLoader,
  now: () => number
): Promise<RefreshState> {
  const started = beginRefresh(state, state.transport, now());
  let raw: unknown;
  try {
    raw = await loader(started.transport);
  } catch (err) {
    const at = now();
    const code = err instanceof SourceUnavailableError ? String(err.reason) : 'connection_failed';
    const info = describeRefreshFailure(code).info;
    return failRefresh(
      started,
      {
        reason: code,
        title: info.title,
        detail: err instanceof Error ? err.message : String(err),
        hint: err instanceof SourceUnavailableError ? err.hint : info.remedy
      },
      at
    );
  }
  return completeRefresh(started, parseCatalogPayload(raw), now());
}

/* ------------------------------------------------------------------ *
 * 离线 fixture（测试与截图取证用；界面上必须显式标注"测试态"）
 * ------------------------------------------------------------------ */

const FIXTURE_MODEL_A = {
  modelId: 'fixture-model-a',
  displayName: '目录条目甲',
  provider: 'fixture-provider',
  billingClass: 'subscription' as const,
  contextLength: 200000,
  reasoning: ['high'],
  capabilities: ['工具调用']
};

const FIXTURE_MODEL_B = {
  modelId: 'fixture-model-b',
  displayName: '目录条目乙',
  provider: 'fixture-provider',
  billingClass: 'metered_api' as const,
  contextLength: null,
  reasoning: [],
  capabilities: []
};

const FIXTURE_MODEL_C = {
  modelId: 'fixture-model-c',
  displayName: '目录条目丙',
  provider: 'fixture-provider-2',
  billingClass: 'promotion' as const,
  contextLength: 128000,
  reasoning: ['high', 'low'],
  capabilities: ['工具调用', '长上下文']
};

/** fixture 目录 v1：2 条。全部带 `fixture-` 前缀，界面上不得被误读为真实模型。 */
export const CATALOG_FIXTURE_V1 = {
  revision: 'fixture-rev-1',
  models: [FIXTURE_MODEL_A, FIXTURE_MODEL_B]
};

/** fixture 目录 v2：3 条（新增丙），revision 变化。 */
export const CATALOG_FIXTURE_V2 = {
  revision: 'fixture-rev-2',
  models: [FIXTURE_MODEL_A, FIXTURE_MODEL_B, FIXTURE_MODEL_C]
};

/** 违反契约的响应：billingClass 非法 + 缺 capabilities。解析层必须整体拒绝。 */
export const CATALOG_FIXTURE_MALFORMED = {
  revision: 'fixture-rev-bad',
  models: [
    {
      modelId: 'fixture-model-bad',
      displayName: '目录条目（非法类别）',
      provider: 'fixture-provider',
      billingClass: 'freemium',
      contextLength: 1000,
      reasoning: []
    }
  ]
};

export type SourceLoaderStep =
  | { kind: 'resolve'; payload: unknown }
  | { kind: 'reject'; error: Error };

export interface FixtureScenario {
  /** 界面 chip 上显示的场景名。 */
  label: string;
  steps: SourceLoaderStep[];
}

/**
 * fixture 场景表。**只用于离线单测与截图取证**，界面必须以「测试态」chip 显式标注。
 * 没有任何一条路径把这些 fixture 当成真实来源，也没有任何一条路径发起网络请求。
 */
export const FIXTURE_SCENARIOS: Record<string, FixtureScenario> = {
  catalog2_then_conn_fail: {
    label: 'catalog2_then_conn_fail（先读回 2 条，再连接失败）',
    steps: [
      { kind: 'resolve', payload: CATALOG_FIXTURE_V1 },
      {
        kind: 'reject',
        error: new SourceUnavailableError(
          'connection_failed',
          'fixture 测试态：模拟 ECONNREFUSED 127.0.0.1:4318（本轮不发起任何真实网络请求）。',
          REFRESH_FAILURE_INFO.connection_failed.remedy
        )
      }
    ]
  },
  catalog2_then_malformed: {
    label: 'catalog2_then_malformed（先读回 2 条，再返回违反契约的响应）',
    steps: [
      { kind: 'resolve', payload: CATALOG_FIXTURE_V1 },
      { kind: 'resolve', payload: CATALOG_FIXTURE_MALFORMED }
    ]
  },
  empty: {
    label: 'empty（来源返回 0 个条目）',
    steps: [{ kind: 'resolve', payload: { revision: 'fixture-rev-empty', models: [] } }]
  },
  timeout: {
    label: 'timeout（读取超时）',
    steps: [
      {
        kind: 'reject',
        error: new SourceUnavailableError(
          'timeout',
          'fixture 测试态：模拟来源已接受连接但 3000ms 内没有返回完整响应。',
          REFRESH_FAILURE_INFO.timeout.remedy
        )
      }
    ]
  },
  api_not_running: {
    label: 'api_not_running（本机 API 未启动）',
    steps: [
      {
        kind: 'reject',
        error: new SourceUnavailableError(
          'api_not_running',
          'fixture 测试态：模拟本机 companion API 进程不在运行，没有任何目录被读回。',
          REFRESH_FAILURE_INFO.api_not_running.remedy
        )
      }
    ]
  }
};

export function isFixtureScenario(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(FIXTURE_SCENARIOS, name);
}

export function fixtureScenarioLabel(name: string): string {
  return FIXTURE_SCENARIOS[name]?.label ?? name;
}

/**
 * 选定来源执行器 —— **C1(b)「默认路径零网络」的唯一决策点**。
 *
 * 规则只有两条：
 * 1. `scenario` 为空（`null` / `undefined` / 空串）或**未登记** → 一律 `offlineSourceLoader`（不发起任何网络请求）；
 * 2. `scenario` 是已登记的 fixture 场景名 → 换成本地 fixture 执行器。
 *
 * ModelsPage 调用的就是本函数，单元测试也对本函数做**对象同一性**断言并沿默认路径跑一次
 * 带网络探针的完整刷新（见 `modelSource.test.ts` 的「C1(b) 默认路径零网络」组），
 * 所以把默认值改掉、或往 `offlineSourceLoader` 里塞任何网络原语，测试都会变红，
 * 而不是悄悄变成会发请求的执行器。
 */
export function resolveSourceLoader(scenario: string | null | undefined): SourceLoader {
  return scenario && isFixtureScenario(scenario)
    ? createFixtureSourceLoader(scenario)
    : offlineSourceLoader;
}

/**
 * 按脚本依次返回结果的执行器：脚本用尽后按 `transport_not_wired` 失败，
 * **不会**继续返回成功，也不返回任何目录。
 * 未知场景名直接按未接线失败，不猜、不回退。
 */
export function createFixtureSourceLoader(scenario: string): SourceLoader {
  const script = FIXTURE_SCENARIOS[scenario];
  let i = 0;
  return () => {
    if (!script) {
      return Promise.reject(
        new SourceUnavailableError(
          'transport_not_wired',
          `fixture 场景「${scenario}」不存在；按未接线失败，不返回任何目录。`,
          REFRESH_FAILURE_INFO.transport_not_wired.remedy
        )
      );
    }
    const step = script.steps[Math.min(i, script.steps.length - 1)];
    i += 1;
    if (i > script.steps.length) {
      return Promise.reject(
        new SourceUnavailableError(
          'transport_not_wired',
          `fixture 场景「${scenario}」的脚本已用尽；按未接线失败，不重复返回目录。`,
          REFRESH_FAILURE_INFO.transport_not_wired.remedy
        )
      );
    }
    if (!step) {
      return Promise.reject(
        new SourceUnavailableError(
          'transport_not_wired',
          `fixture 场景「${scenario}」没有可执行的步骤。`,
          REFRESH_FAILURE_INFO.transport_not_wired.remedy
        )
      );
    }
    return step.kind === 'resolve' ? Promise.resolve(step.payload) : Promise.reject(step.error);
  };
}
