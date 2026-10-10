/**
 * UI01 数据快照：全部数据源显式为"未接入"。
 *
 * 硬约束：
 * 1. 本文件不得出现任何看起来像真实套餐、真实额度、真实计费、真实凭据的值。
 * 2. 允许出现的是字段结构、栏目、单位、层级、状态标签与枚举取值域本身。
 * 3. 本文件不含任何 URL、endpoint、账号标识；UI 不发起网络请求。
 */

export const NOT_CONNECTED = '未接入' as const;
export const UNKNOWN = 'unknown' as const;

export const PRODUCT_NAME = 'ZCode Companion';
export const PRODUCT_DISCLAIMER = '独立软件 · 非 ZCode 官方';
export const PRODUCT_VERSION = '0.1.0';
export const BUILD_TAG = 'I10 桌面程序（主进程托管本机反代）';

/** 证据等级：来自 929 §11.4。 */
export type EvidenceLevel = 'E0' | 'E1' | 'E2' | 'E3';

export const EVIDENCE_SUMMARY: Record<EvidenceLevel, string> = {
  E0: '未知：无有效资格/用量证据 —— 权益未确认，暂不可发送',
  E1: '目录/资格可用：官方登录、目录、套餐资格与实际选模读回成立',
  E2: '成功且来源可证：当前 input 对应真实模型请求/终态，实际 provider 一致',
  E3: '消费/活动已观测：权威桶或账单、前后读数、时间与并行活动限制记录完整'
};

/**
 * **发送门基线等级（静态常量，恒为 E0）** —— 不是"当前证据强度"。
 *
 * ZCC-ACCOUNT-EVIDENCE-20261009 起，产品里有**两个**不同的问题，答案不同：
 *  1. "证据强度到几级了？" → **计算值**，见 `evidence.ts` 的
 *     `computeEvidenceLevel(catalogState)`。总览页页头徽章、「账号与权益」卡、
 *     证据等级说明与侧栏 chip 全部消费它。
 *  2. "发送门解开了吗？" → 本常量。它是**结构性关闭**的事实：本产品界面上
 *     不存在任何可点击的发送入口（dispatch = 0），会话页 / 模型页 / 写死条目
 *     的禁用标签统一引用它。目录读回成 E1 **不会**改变它，也不允许改变。
 *
 * 因此本常量保持 E0 是刻意的，不是没接上证据。改它等于宣称"可以发送了"，
 * 而那需要 E2/E3 的真实请求与权威桶证据，本轮都不存在。
 */
export const CURRENT_EVIDENCE: EvidenceLevel = 'E0';

/**
 * 发送门（唯一口径）。会话页与模型页必须引用同一份文案与同一个禁用标签，
 * 禁止同一产品出现两套发送门政策。
 */
export const SEND_GATE_CLOSED_NOTICE = `${EVIDENCE_SUMMARY[CURRENT_EVIDENCE]}。在取得 E1 及以上资格与计费证据之前，发送门保持关闭；本产品界面上不存在任何可点击的发送入口（dispatch = 0）。`;

export const SEND_GATE_UNLOCK_CONDITION =
  '解锁条件：取得 E1 及以上资格与计费证据（官方登录、目录、套餐资格与实际选模读回成立）后，界面才允许出现可用的发送控件。';

/** E0 下所有发送控件共用的禁用态标签（不可点击、不进入 Tab 序列）。 */
export const SEND_DISABLED_LABEL = `不可发送（${CURRENT_EVIDENCE}）`;

/**
 * 额度现状（UI02）。权威桶读数未观测，
 * 因此界面上任何"可用性"位置只能显示"未验证"，不得出现看起来像真实可用套餐的名称或数值。
 * 本常量是唯一口径：总览页字段说明、模型页额度卡与写死条目提示都引用它。
 */
/**
 * 额度现状标签。**不宣称用户没有额度** —— 我们没有权威桶读数，
 * 那是「未观测」而不是「为零」。读回口径见 readStatus.ts 的 usageWarnings。
 */
export const NO_CREDIT_LABEL = '未观测';

export const NO_CREDIT_NOTICE =
  '额度现状：**未观测**。本产品没有读到权威桶/账单读数，因此既不显示余额，也不宣称「没有额度」——' +
  '两者都不是事实。权威桶与消费记录属于 E3 观测项，未观测不阻塞 E1 资格判定。';

export type BillingClass = 'subscription' | 'promotion' | 'metered_api' | 'unknown';

export const BILLING_CLASSES: BillingClass[] = [
  'subscription',
  'promotion',
  'metered_api',
  'unknown'
];

export const BILLING_CLASS_LABEL: Record<BillingClass, string> = {
  subscription: 'subscription · 订阅扣桶',
  promotion: 'promotion · 活动优惠',
  metered_api: 'metered_api · 按量计费',
  unknown: 'unknown · 未知（保守拒发）'
};

/**
 * 发送准入规则（展示用）。口径取自 929 §2：
 * `BillingClass = subscription | promotion | metered_api | unknown`，
 * metered_api 与 unknown 永不准入；subscription 与 promotion 才是合法订阅通道
 * （promotion 是官方活动优惠，同样走套餐/订阅计费，不是按量计费）。
 * 注意：这是"通道级准入"，不是"当前可发"——E0 下两者都仍然不可发送。
 */
export const BILLING_CLASS_SENDABLE: Record<BillingClass, boolean> = {
  subscription: true,
  promotion: true,
  metered_api: false,
  unknown: false
};

export const BILLING_CLASS_RULE: Record<BillingClass, string> = {
  subscription: '需 E1 及以上资格证据，且窗口与配置检查通过',
  promotion: '属订阅通道（官方活动优惠，非按量计费）：需活动有效期证据独立成立，目录出现活动条目不等于允许立即发送',
  metered_api: '本产品不提供额外 API-key 计费通道，任何情况下不渲染为可点击发送',
  unknown: '证据不足即拒发，不猜测 provider，不换通道补发'
};

export type OperationState =
  | 'prepared'
  | 'queued'
  | 'dispatching'
  | 'accepted'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'not_submitted'
  | 'outcome_unknown';

export const OPERATION_STATE_LABEL: Record<OperationState, string> = {
  prepared: 'prepared · 已准备',
  queued: 'queued · 排队中',
  dispatching: 'dispatching · 派发中',
  accepted: 'accepted · 已被接受',
  running: 'running · 执行中',
  completed: 'completed · 已完成',
  failed: 'failed · 失败',
  cancelled: 'cancelled · 已取消',
  not_submitted: 'not_submitted · 未提交',
  outcome_unknown: 'outcome_unknown · 结果未知'
};

export type WindowMode = 'enforce' | 'advisory' | 'off';

export const WINDOW_MODES: WindowMode[] = ['enforce', 'advisory', 'off'];

export const WINDOW_MODE_LABEL: Record<WindowMode, string> = {
  enforce: 'enforce · 窗口外强制拒发',
  advisory: 'advisory · 窗口外提示可能扣套餐',
  off: 'off · 不展示窗口优化提示（安全校验不关闭）'
};

export const WINDOW_RULE = '窗口 23:00（含）— 09:00（不含），时区固定 Asia/Shanghai，不使用系统本地时区代替';

/** 总览页的连接状态字段结构。值全部为未接入占位。 */
export type FieldValue =
  | { kind: 'text'; value: string }
  | { kind: 'pending'; value: typeof NOT_CONNECTED }
  | { kind: 'nocredit'; value: typeof NO_CREDIT_LABEL }
  | { kind: 'unknown'; value: typeof UNKNOWN }
  | { kind: 'local'; value: string };

export interface FieldSpec {
  label: string;
  unit?: string;
  value: FieldValue;
  note?: string;
}

export interface SectionSpec {
  id: string;
  title: string;
  description: string;
  fields: FieldSpec[];
}

export const RUNTIME_SECTIONS: SectionSpec[] = [
  {
    id: 'runtime',
    title: '连接状态 · app-server 运行时',
    description: '历史驱动事实由只读状态提供；当前官方进程、监听与心跳未观测。',
    fields: [
      { label: '运行时状态', value: { kind: 'pending', value: NOT_CONNECTED } },
      { label: '进程 PID', value: { kind: 'pending', value: NOT_CONNECTED } },
      { label: '监听地址', value: { kind: 'pending', value: NOT_CONNECTED }, note: '此处未观测官方运行时监听；本机反代状态见上方独立卡片' },
      { label: '协议版本', value: { kind: 'pending', value: NOT_CONNECTED } },
      { label: '最近心跳', value: { kind: 'pending', value: NOT_CONNECTED } },
      { label: '模型发送', value: { kind: 'text', value: '发送门关闭（E0）' }, note: '不把手动只读 GET 统计成模型发送；历史驱动不解锁发送' }
    ]
  },
  {
    id: 'version',
    title: '版本与指纹',
    description: '仅本产品自报版本为真实值；官方包指纹本轮未读取，保持未接入。',
    fields: [
      { label: '本产品版本', value: { kind: 'text', value: PRODUCT_VERSION } },
      { label: '构建标识', value: { kind: 'text', value: BUILD_TAG } },
      { label: '界面壳（apps/ui）', value: { kind: 'text', value: 'React 19.3.0 + Vite 8.3.1 + TypeScript 7.0.2' } },
      { label: '官方桌面宿主版本', value: { kind: 'pending', value: NOT_CONNECTED } },
      { label: '官方 CLI 运行时版本', value: { kind: 'pending', value: NOT_CONNECTED } },
      { label: '官方包 SHA-256', value: { kind: 'pending', value: NOT_CONNECTED }, note: '本轮未读取任何官方安装包' }
    ]
  },
  {
    id: 'account',
    title: '账号与权益',
    description: '当前账号握手未证明；历史资格源不代表当前资格，额度为未观测而非为零。',
    fields: [
      { label: '账号状态', value: { kind: 'text', value: '当前账号握手未证明' } },
      { label: '套餐资格', value: { kind: 'pending', value: NOT_CONNECTED } },
      { label: '可用 provider', value: { kind: 'unknown', value: UNKNOWN } },
      { label: '权威桶读数', value: { kind: 'nocredit', value: NO_CREDIT_LABEL }, note: 'tokens 与积分/余额单位不可互换；未观测（不宣称为零）' },
      { label: '活动优惠', value: { kind: 'pending', value: NOT_CONNECTED }, note: '无活动资格不并入普通订阅；未观测（不宣称为零）' },
      { label: '证据等级', value: { kind: 'text', value: CURRENT_EVIDENCE }, note: EVIDENCE_SUMMARY[CURRENT_EVIDENCE] }
    ]
  }
];

/** 模型/套餐页的额度三源（必须分栏显示，单位不同不得合并）。 */
export interface UsageSource {
  id: string;
  title: string;
  unit: string;
  source: string;
  note: string;
}

export const USAGE_SOURCES: UsageSource[] = [
  {
    id: 'local-tokens',
    title: '本软件请求 token 统计',
    unit: 'token',
    source: '本软件自身计数',
    note: '仅统计由本软件发起的模型请求；当前 token 读数未观测'
  },
  {
    id: 'authoritative-bucket',
    title: '账号套餐权威桶',
    unit: '积分 / 余额（官方单位，未接入）',
    source: '官方账号侧读数',
    note: `${NO_CREDIT_LABEL}；读数延迟与其他会话并行消费会污染前后差值`
  },
  {
    id: 'promotion',
    title: '活动优惠说明',
    unit: '—',
    source: '官方活动资格',
    note: `${NO_CREDIT_LABEL}；活动时间落在窗口内不等于有资格`
  }
];

/** 模型表格列定义（结构，非数据）。 */
export interface ColumnSpec {
  key: string;
  title: string;
  unit: string;
  domain: string;
  emptyCell: string;
  width: string;
}

export const MODEL_COLUMNS: ColumnSpec[] = [
  { key: 'displayName', title: '显示名', unit: '—', domain: '官方目录提供的可读名称', emptyCell: '—', width: '1.4fr' },
  { key: 'provider', title: 'provider', unit: '—', domain: '官方返回的精确提供方标识', emptyCell: UNKNOWN, width: '1fr' },
  { key: 'modelId', title: 'modelId', unit: '—', domain: '官方目录精确 id，不得猜测或拼接', emptyCell: '—', width: '1.5fr' },
  { key: 'billingClass', title: '计费类别', unit: '—', domain: 'subscription | promotion | metered_api | unknown', emptyCell: UNKNOWN, width: '1.5fr' },
  { key: 'contextLength', title: '上下文长度', unit: 'token', domain: '官方目录声明值', emptyCell: NOT_CONNECTED, width: '0.9fr' },
  { key: 'reasoning', title: '推理档位', unit: '—', domain: '契约 string[]：官方目录声明的档位集合（可为空数组）', emptyCell: NOT_CONNECTED, width: '1fr' },
  { key: 'capabilities', title: '能力标签', unit: '—', domain: '契约 string[]：官方目录声明的能力集合（可为空数组）', emptyCell: NOT_CONNECTED, width: '1.2fr' },
  { key: 'status', title: '状态', unit: '—', domain: '未接入时统一 unknown', emptyCell: UNKNOWN, width: '0.8fr' },
  { key: 'action', title: '操作', unit: '—', domain: '仅 E1+ 且 subscription / promotion 通道可发送；metered_api 与 unknown 永不准入', emptyCell: SEND_DISABLED_LABEL, width: '1.1fr' }
];

export const CATALOG_STATE = {
  catalogRevision: NOT_CONNECTED as string,
  accountEpoch: NOT_CONNECTED as string,
  configRevision: NOT_CONNECTED as string,
  lastSyncedAt: NOT_CONNECTED as string,
  rowCount: 0
};

export const SETTINGS_SPEC = {
  localApi: {
    enabled: false,
    disabled: true,
    listen: NOT_CONNECTED as string,
    token: NOT_CONNECTED as string,
    reason: 'I14 未实现：未监听任何端口，未生成任何本机 token'
  },
  singleInstance: {
    status: NOT_CONNECTED as string,
    lockFile: NOT_CONNECTED as string,
    ipcDomain: NOT_CONNECTED as string,
    reason: '本轮壳未注册单实例锁；第二次启动行为未实现'
  },
  dataDir: {
    path: '%APPDATA%\\ZCode Companion\\（设计路径，未创建、未验证）',
    journal: NOT_CONNECTED as string,
    secrets: '不显示：本产品不展示任何凭据值',
    reason: '只读展示路径，不读取目录内容'
  }
} as const;
