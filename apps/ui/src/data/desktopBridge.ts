/**
 * I10 桌面桥（`window.zccDesktop`）的类型面与**无凭据**包装。
 *
 * 硬约束：
 *  1. **不新增网络原语。** 本文件**不含**任何网络调用形态——数据全部经 preload 暴露的
 *     IPC 方法进来。`apps/ui/src/data/modelSource.test.ts` 第 8 组把「唯一含网络原语
 *     的产品文件」收敛成 `localApiSource.ts` 一个，这里再加一个就等于把那条回归门打穿。
 *  2. **不在浏览器里假装有桌面。** `window.zccDesktop` 不存在时（vite dev / 直接开
 *     浏览器），`desktopAvailable` 为 false、快照恒为 `stopped`，界面据实显示
 *     「桌面壳未接入」而不是伪造一个 running。
 *  3. **这里没有任何凭据。** `getSettings` 的返回类型里根本没有 `apiKey` 字段，
 *     只有 `apiKeySet` / `apiKeyMasked` / `apiKeyFingerprint`；类型层就把「把明文 key
 *     读进界面」这条路堵死。
 */

/** 状态机五态。取值与 `apps/desktop/lib/proxy-manager.cjs` 的 `PROXY_STATES` 同源。 */
export type ProxyState = 'stopped' | 'starting' | 'running' | 'failed' | 'external';

export interface ProxySnapshot {
  state: ProxyState;
  /** 自己 spawn 的子进程 PID；`external` 态恒为 `null`（那不是我们的进程）。 */
  pid: number | null;
  /** 反代**真正在监听**的端口。运行中改设置不会改它——否则界面会指向一个没人监听的地址。 */
  port: number | null;
  /** 设置里配置的端口。与 `port` 不一致时表示「有改动待重启生效」。 */
  configuredPort: number | null;
  /** true = 有端口改动待「重启」生效。 */
  portChangePending: boolean;
  /** true = 端口上已有服务，本程序只观察、不接管。 */
  external: boolean;
  /** true = 本程序有权启停这个反代。`external` 态恒为 false。 */
  canControl: boolean;
  /** true = 当前这个子进程是本程序自己拉起来的。 */
  owned: boolean;
  lastError: string | null;
  lastChangedAt: number;
}

export interface DesktopLogLine {
  seq: number;
  at: number;
  stream: 'stdout' | 'stderr' | 'main';
  text: string;
}

export interface PublicSettings {
  apiKeySet: boolean;
  apiKeyMasked: string;
  apiKeyFingerprint: string | null;
  apiPort: number;
  driver: string;
  reasoning: string;
  driverClosedSet: readonly string[];
  reasoningClosedSet: readonly string[];
}

export interface SettingsBundle {
  settings: PublicSettings;
  settingsFile: string;
  seededFrom: string | null;
  seedProblem: string | null;
  loadProblems: string[];
  runtime: { kind: 'dev' | 'packaged'; runtimeRoot: string; apiEntry: string };
}

export interface DesktopActionResult {
  ok: boolean;
  code: string;
}

export interface SaveSettingsResult {
  ok: boolean;
  reason?: string;
  settings?: PublicSettings;
}

/**
 * 导出结果的统计面（`:876` 要的「脱敏导出 hash」就是 `sha256`）。
 * 无论 `preview` 还是 `save` 都带这份统计，界面据此显示字节数与截断提示。
 */
export interface LogExportSummary {
  bytes: number;
  sha256: string;
  totalLines: number;
  includedLines: number;
  droppedLines: number;
  truncated: boolean;
  redactedLines: number;
  /** 非白名单字段被丢弃的条数（计数是人能看到的唯一「有东西被过滤了」信号）。 */
  droppedFields: number;
  /** 白名单字段但取值不合文法、被丢弃的条数。 */
  droppedInvalid: number;
  maxBytes: number;
  generatedAt: string;
}

export interface LogExportResult extends LogExportSummary {
  ok: boolean;
  mode?: 'preview' | 'save';
  /** 仅 `preview` 返回：前若干字符，不是整篇。 */
  preview?: string;
  /** 仅 `save` 成功返回：用户自己选定的本地路径。 */
  path?: string;
  /** 失败码：`INVALID_INPUT` / `EXPORT_IN_PROGRESS` / `CANCELLED` / `SAVE_FAILED`。 */
  code?: string;
  reason?: string;
}

export interface LogExportInput {
  mode: 'preview' | 'save';
  maxBytes?: number;
}

interface DesktopBridge {
  desktop: boolean;
  getSnapshot(): Promise<ProxySnapshot>;
  subscribe(handler: (payload: { snapshot: ProxySnapshot; logs: DesktopLogLine[] }) => void): () => void;
  start(): Promise<DesktopActionResult>;
  stop(): Promise<DesktopActionResult>;
  restart(): Promise<DesktopActionResult>;
  getLogTail(limit?: number): Promise<DesktopLogLine[]>;
  getSettings(): Promise<SettingsBundle>;
  saveSettings(next: {
    apiKey?: string;
    apiPort?: number;
    driver?: string;
    reasoning?: string;
  }): Promise<SaveSettingsResult>;
  exportLogs(input: LogExportInput): Promise<LogExportResult>;
}

declare global {
  interface Window {
    zccDesktop?: DesktopBridge;
  }
}

/** 未接入桌面壳时的兜底快照：**如实说 stopped**，不伪造一个「在跑」。 */
export const UNAVAILABLE_SNAPSHOT: ProxySnapshot = Object.freeze({
  state: 'stopped',
  pid: null,
  port: null,
  configuredPort: null,
  portChangePending: false,
  external: false,
  canControl: false,
  owned: false,
  lastError: null,
  lastChangedAt: 0
});

export function desktopBridge(): DesktopBridge | null {
  const bridge = typeof window === 'undefined' ? undefined : window.zccDesktop;
  return bridge && bridge.desktop === true ? bridge : null;
}

export function desktopAvailable(): boolean {
  return desktopBridge() !== null;
}

/**
 * 桌面壳缺席时给出的原因码。界面上原样显示，不做美化也不静默。
 */
export const UNAVAILABLE_REASON = '桌面壳未接入（当前不是由 ZCode Companion 桌面程序加载的界面）';

const NOOP_UNSUBSCRIBE = () => {
  /* 没有桥可退订 */
};

/** 取快照。桌面壳缺席时返回兜底快照而不是抛错——界面必须还能渲染。 */
export async function readSnapshot(): Promise<ProxySnapshot> {
  const bridge = desktopBridge();
  if (bridge === null) return { ...UNAVAILABLE_SNAPSHOT };
  return bridge.getSnapshot();
}

/** 取子进程日志尾。 */
export async function readLogTail(limit = 200): Promise<DesktopLogLine[]> {
  const bridge = desktopBridge();
  if (bridge === null) return [];
  return bridge.getLogTail(limit);
}

/** 订阅状态与日志推流；缺席时返回一个空退订函数。 */
export function subscribeDesktop(
  handler: (payload: { snapshot: ProxySnapshot; logs: DesktopLogLine[] }) => void
): () => void {
  const bridge = desktopBridge();
  if (bridge === null) return NOOP_UNSUBSCRIBE;
  return bridge.subscribe(handler);
}

export async function startProxy(): Promise<DesktopActionResult> {
  const bridge = desktopBridge();
  if (bridge === null) return { ok: false, code: 'DESKTOP_UNAVAILABLE' };
  return bridge.start();
}

export async function stopProxy(): Promise<DesktopActionResult> {
  const bridge = desktopBridge();
  if (bridge === null) return { ok: false, code: 'DESKTOP_UNAVAILABLE' };
  return bridge.stop();
}

export async function restartProxy(): Promise<DesktopActionResult> {
  const bridge = desktopBridge();
  if (bridge === null) return { ok: false, code: 'DESKTOP_UNAVAILABLE' };
  return bridge.restart();
}

export async function readSettings(): Promise<SettingsBundle | null> {
  const bridge = desktopBridge();
  if (bridge === null) return null;
  return bridge.getSettings();
}

export async function saveSettings(next: {
  apiKey?: string;
  apiPort?: number;
  driver?: string;
  reasoning?: string;
}): Promise<SaveSettingsResult> {
  const bridge = desktopBridge();
  if (bridge === null) return { ok: false, reason: UNAVAILABLE_REASON };
  return bridge.saveSettings(next);
}

/**
 * 脱敏日志导出。桌面壳缺席时**不假装成功**——回 `DESKTOP_UNAVAILABLE`，
 * 界面据此显示「当前环境不支持导出」，而不是弹一个空预览。
 */
export async function exportLogs(input: LogExportInput): Promise<LogExportResult | { ok: false; code: string; reason: string }> {
  const bridge = desktopBridge();
  if (bridge === null) return { ok: false, code: 'DESKTOP_UNAVAILABLE', reason: UNAVAILABLE_REASON };
  return bridge.exportLogs(input);
}
