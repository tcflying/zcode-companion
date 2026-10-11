/**
 * 系统托盘（2026-10-11，主上令：功能完善——服务状态/权益摘要/在途概览/开机自启）。
 *
 * 设计约束：
 *  - **纯逻辑与 Electron 装配分离**：本文件导出的判定/格式化函数不 import electron，
 *    vitest 直接测（`tests/unit/desktop-tray.test.mjs`）；`createSystemTray` 接受
 *    依赖注入（`trayFactory`/`menuFactory`/`probe`），main.cjs 传真实现。
 *  - **零新增 IPC**：托盘全部数据在主进程取得（探活 8790、读 catalog、
 *    `manager.getSnapshot()`、`getLoginItemSettings`），不经过渲染进程，
 *    `desktop-key-redaction` 的 IPC 闭集因此一字不动。
 *  - **key 永不外显**：`settings.apiKey` 只用于主进程发出的请求头；tooltip、
 *    菜单、日志里只有状态与计数。
 *
 * 权益口径（与 GUI「账号与权益」页一致）：目录侧只有 entitlement 布尔
 * （`billingClass ∈ {subscription, promotion}`），**没有余量数字**——托盘如实
 * 显示「可用（N 模型）」，不编造余量。
 */

/**
 * 服务探活结果的三态。
 * @typedef {'up' | 'unauthorized' | 'down'} ServiceProbe
 */

/**
 * 权益摘要（catalog 侧口径）。
 * @typedef {Object} EntitlementSummary
 * @property {number} subscriptionModels billingClass=subscription 的可服务条目数
 * @property {number} promotionModels billingClass=promotion 的可服务条目数
 * @property {string} sourceLabel 摘要来源说明（如 '目录侧'）；探测失败时为 '未知'
 */

/** 探活间隔：正常 30s；上次失败退避 60s。 */
const PROBE_INTERVAL_MS = 30_000;
const PROBE_BACKOFF_MS = 60_000;

/**
 * 把探活 HTTP 结果归为三态。401 也算「活着」——那是没带 key 的探测请求被认证门
 * 正常拒绝，端口与服务都在。
 *
 * @param {number | null} statusCode HTTP 状态码；null = 请求没得到应答
 * @returns {ServiceProbe}
 */
function classifyProbe(statusCode) {
  if (statusCode === null) return 'down';
  if (statusCode === 200) return 'up';
  if (statusCode === 401 || statusCode === 403) return 'unauthorized';
  // 404/5xx 等：端口上有东西应答，但不是我们认识的那个服务——按无响应报，不装正常。
  return 'down';
}

/**
 * 从 /v1/zcc/catalog 响应体提炼权益摘要。畸形输入一律落「未知」，不让托盘炸。
 *
 * @param {unknown} body catalog 响应（已 JSON.parse 的任意形状）
 * @returns {EntitlementSummary}
 */
function summarizeEntitlement(body) {
  const empty = { subscriptionModels: 0, promotionModels: 0, sourceLabel: '未知' };
  if (body === null || typeof body !== 'object') return empty;
  const models = /** @type {Record<string, unknown>} */ (body)['models'];
  if (!Array.isArray(models)) return empty;
  let subscriptionModels = 0;
  let promotionModels = 0;
  for (const entry of models) {
    if (entry === null || typeof entry !== 'object') continue;
    const billingClass = /** @type {Record<string, unknown>} */ (entry)['billingClass'];
    if (billingClass === 'subscription') subscriptionModels += 1;
    else if (billingClass === 'promotion') promotionModels += 1;
  }
  return { subscriptionModels, promotionModels, sourceLabel: '目录侧' };
}

/**
 * @param {ServiceProbe} probe
 * @returns {string} 状态行文本（菜单禁用项用）
 */
function serviceStatusLabel(probe) {
  if (probe === 'up') return '● 服务正常 127.0.0.1:8790';
  if (probe === 'unauthorized') return '● 服务在运行（未带 key 探测：401）';
  return '○ 服务无响应 127.0.0.1:8790';
}

/**
 * @param {EntitlementSummary} ent
 * @returns {string} 权益一句话（tooltip 用）
 */
function entitlementLine(ent) {
  if (ent.sourceLabel === '未知') return '权益：未知（目录不可达）';
  const sub = ent.subscriptionModels > 0 ? `individual 订阅可用（${ent.subscriptionModels} 模型）` : 'individual 订阅：无可用条目';
  const promo = ent.promotionModels > 0 ? `start-plan 促销可用（${ent.promotionModels} 模型）` : 'start-plan 促销：无可用条目';
  return `权益：${sub}；${promo}`;
}

/**
 * tooltip 文本（Electron Windows 上限 127 字符，超会截断——两行紧凑）。
 *
 * @param {ServiceProbe} probe
 * @param {EntitlementSummary} ent
 * @param {{ state: string }} snapshot 反代子进程快照（state 即可）
 * @returns {string}
 */
function trayTooltip(probe, ent, snapshot) {
  const line1 = probe === 'up' ? 'ZCode Companion · 服务正常' : probe === 'unauthorized' ? 'ZCode Companion · 服务在运行（401）' : 'ZCode Companion · 服务无响应';
  const line2 = `GUI 反代：${snapshot.state}`;
  const line3 = entitlementLine(ent);
  return `${line1}\n${line2}\n${line3}`.slice(0, 250);
}

/**
 * 右键菜单模板（纯数据，可测）。回调经 `actions` 注入，测试传 spy。
 *
 * @param {Object} input
 * @param {ServiceProbe} input.probe
 * @param {EntitlementSummary} input.ent
 * @param {{ state: string, pid: number | null, port: number | null, lastChangedAt: number | null }} input.snapshot
 * @param {boolean} input.openAtLogin 当前开机自启状态（真源=系统 `getLoginItemSettings`）
 * @param {{ showWindow: () => void, quit: () => void, toggleOpenAtLogin: (next: boolean) => void }} input.actions
 * @returns {Array<Record<string, unknown>>} Menu.buildFromTemplate 的模板
 */
function trayMenuTemplate(input) {
  const { probe, ent, snapshot, openAtLogin, actions } = input;
  const stateText =
    snapshot.state === 'running'
      ? `GUI 反代运行中（127.0.0.1:${snapshot.port ?? '?'}，pid ${snapshot.pid ?? '?'}）`
      : snapshot.state === 'external'
        ? 'GUI 反代：端口被外部服务占用（观察模式）'
        : `GUI 反代：${snapshot.state}`;
  const changed = snapshot.lastChangedAt === null ? '' : `（${new Date(snapshot.lastChangedAt).toLocaleTimeString('zh-CN')}）`;
  return [
    { label: serviceStatusLabel(probe), enabled: false },
    { label: `${entitlementLine(ent)} · 目录侧口径，无余量数字`, enabled: false },
    { type: 'separator' },
    { label: `${stateText}${changed}`, enabled: false },
    { label: '显示主界面', click: () => actions.showWindow() },
    { label: '开机自启', type: 'checkbox', checked: openAtLogin, click: (/** @type {MenuItemImpl} */ item) => actions.toggleOpenAtLogin(item.checked) },
    { type: 'separator' },
    {
      label: '退出',
      click: () => actions.quit()
    }
  ];
}

/**
 * @typedef {Object} MenuItemImpl Electron 菜单项（click 回调参数）；只用到 checked。
 * @property {boolean} MenuItemImpl.checked
 */

/**
 * 装配真托盘。main.cjs 在 product 模式调用；依赖全部注入便于测试。
 *
 * @param {Object} deps
 * @param {(image: unknown) => { setToolTip: (t: string) => void, setContextMenu: (m: unknown) => void, on: (ev: string, fn: () => void) => void, destroy: () => void }} deps.trayFactory 工厂直调（非 new——测试传箭头函数）
 * @param {{ buildFromTemplate: (t: Array<Record<string, unknown>>) => unknown }} deps.menuFactory
 * @param {() => { state: string, pid: number | null, port: number | null, lastChangedAt: number | null }} deps.getSnapshot
 * @param {() => { openAtLogin: boolean }} deps.getLoginItemSettings
 * @param {(opts: { openAtLogin: boolean }) => void} deps.setLoginItemSettings
 * @param {() => { probe: () => Promise<ServiceProbe>, entitlement: () => Promise<EntitlementSummary> }} deps.pollers 探活/权益两个轮询源
 * @param {() => void} deps.showWindow
 * @param {() => void} deps.quit
 * @param {(line: string) => void} [deps.log]
 * @param {() => number} [deps.now] 测试用时钟
 * @returns {{ refresh: () => Promise<void>, destroy: () => void }} 托盘句柄：refresh 供测试/外部触发；destroy 幂等
 */
function createSystemTray(deps) {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  let lastProbe = /** @type {ServiceProbe} */ ('down');
  let lastEnt = { subscriptionModels: 0, promotionModels: 0, sourceLabel: '未知' };
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let destroyed = false;
  const tray = deps.trayFactory(undefined);

  const render = () => {
    const snapshot = deps.getSnapshot();
    tray.setToolTip(trayTooltip(lastProbe, lastEnt, snapshot));
    tray.setContextMenu(
      deps.menuFactory.buildFromTemplate(
        trayMenuTemplate({
          probe: lastProbe,
          ent: lastEnt,
          snapshot,
          openAtLogin: deps.getLoginItemSettings().openAtLogin,
          actions: {
            showWindow: deps.showWindow,
            quit: deps.quit,
            toggleOpenAtLogin: (next) => {
              deps.setLoginItemSettings({ openAtLogin: next });
              log(`tray: 开机自启 → ${next ? '开' : '关'}`);
              render();
            }
          }
        })
      )
    );
    tray.on('click', () => deps.showWindow());
  };

  const refresh = async () => {
    if (destroyed) return;
    const [probe, ent] = await Promise.all([
      deps.pollers().probe().catch(() => /** @type {ServiceProbe} */ ('down')),
      deps.pollers().entitlement().catch(() => lastEnt)
    ]);
    lastProbe = probe;
    lastEnt = ent;
    render();
  };

  render();
  const schedule = () => {
    if (destroyed) return;
    const interval = lastProbe === 'down' ? PROBE_BACKOFF_MS : PROBE_INTERVAL_MS;
    timer = setTimeout(() => {
      void refresh().finally(schedule);
    }, interval);
    if (timer !== null && typeof timer.unref === 'function') timer.unref();
  };
  schedule();
  void refresh();

  return {
    refresh,
    destroy: () => {
      if (destroyed) return; // 幂等：main.cjs 退出链与托盘自身可能各调一次。
      destroyed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      try {
        tray.destroy();
      } catch {
        /* 已销毁。 */
      }
    }
  };
}

module.exports = {
  PROBE_INTERVAL_MS,
  PROBE_BACKOFF_MS,
  classifyProbe,
  summarizeEntitlement,
  serviceStatusLabel,
  entitlementLine,
  trayTooltip,
  trayMenuTemplate,
  createSystemTray
};
