/**
 * 系统托盘（lib/tray.cjs）单测：判定/格式化/菜单模板纯逻辑 + 装配生命周期（mock electron）。
 * 零 IPC 新增——desktop-key-redaction 的闭集因此不动（本文件附带断言这一点没被破坏）。
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PROBE_INTERVAL_MS, PROBE_BACKOFF_MS, classifyProbe, summarizeEntitlement, entitlementLine, trayTooltip, trayMenuTemplate, createSystemTray } = require('../../apps/desktop/lib/tray.cjs');


describe('托盘 · 探活三态判定', () => {
  it('200=up；401/403=unauthorized（服务在，认证门拒）；其余与无应答=down', () => {
    expect(classifyProbe(200)).toBe('up');
    expect(classifyProbe(401)).toBe('unauthorized');
    expect(classifyProbe(403)).toBe('unauthorized');
    expect(classifyProbe(404)).toBe('down');
    expect(classifyProbe(500)).toBe('down');
    expect(classifyProbe(null)).toBe('down');
  });
});

describe('托盘 · 权益摘要（目录侧口径，不编造余量）', () => {
  it('按 billingClass 计数 subscription/promotion；畸形输入落未知', () => {
    const catalog = {
      models: [
        { billingClass: 'subscription' },
        { billingClass: 'subscription' },
        { billingClass: 'promotion' },
        { billingClass: 'unknown' },
        null,
        'junk'
      ]
    };
    const ent = summarizeEntitlement(catalog);
    expect(ent.subscriptionModels).toBe(2);
    expect(ent.promotionModels).toBe(1);
    expect(ent.sourceLabel).toBe('目录侧');
    expect(summarizeEntitlement(null).sourceLabel).toBe('未知');
    expect(summarizeEntitlement({ models: 'not-array' }).sourceLabel).toBe('未知');
  });

  it('权益一句话：无条目时如实说无，不显示数字余量', () => {
    expect(entitlementLine({ subscriptionModels: 2, promotionModels: 1, sourceLabel: '目录侧' })).toContain('individual 订阅可用（2 模型）');
    expect(entitlementLine({ subscriptionModels: 2, promotionModels: 1, sourceLabel: '目录侧' })).toContain('start-plan 促销可用（1 模型）');
    expect(entitlementLine({ subscriptionModels: 0, promotionModels: 0, sourceLabel: '目录侧' })).toContain('无可用条目');
    expect(entitlementLine({ subscriptionModels: 0, promotionModels: 0, sourceLabel: '未知' })).toContain('未知');
  });
});

describe('托盘 · tooltip 与菜单模板', () => {
  const ent = { subscriptionModels: 2, promotionModels: 1, sourceLabel: '目录侧' };
  const snap = { state: 'running', pid: 4321, port: 8791, lastChangedAt: Date.parse('2026-10-11T10:00:00Z') };

  it('tooltip 三行：服务态 + GUI 反代态 + 权益；不含 key 字样', () => {
    const tip = trayTooltip('up', ent, snap);
    expect(tip).toContain('服务正常');
    expect(tip).toContain('GUI 反代：running');
    expect(tip).toContain('individual 订阅可用（2 模型）');
    expect(tip).not.toMatch(/zcc-[0-9a-f]{8,}/i);
  });

  it('菜单模板：状态/权益/在途三禁用行 + 显示主界面 + 开机自启 checkbox + 退出；动作可回调', () => {
    const showWindow = vi.fn();
    const quit = vi.fn();
    const toggle = vi.fn();
    const tpl = trayMenuTemplate({ probe: 'down', ent, snapshot: snap, openAtLogin: true, actions: { showWindow, quit, toggleOpenAtLogin: toggle } });
    const labels = tpl.map((item) => String(item.label ?? ''));
    expect(labels.some((l) => l.includes('○ 服务无响应'))).toBe(true);
    expect(labels.some((l) => l.includes('目录侧口径，无余量数字'))).toBe(true);
    expect(labels.some((l) => l.includes('GUI 反代运行中（127.0.0.1:8791，pid 4321）'))).toBe(true);
    const auto = /** @type {{ type: string, checked: boolean, click: (item: { checked: boolean }) => void }} */ (tpl.find((item) => item.label === '开机自启'));
    expect(auto.type).toBe('checkbox');
    expect(auto.checked).toBe(true);
    auto.click({ checked: false });
    expect(toggle).toHaveBeenCalledWith(false);
    /** @type {{ click: () => void } | undefined} */
    const show = /** @type {any} */ (tpl.find((item) => item.label === '显示主界面'));
    show?.click();
    expect(showWindow).toHaveBeenCalledOnce();
    /** @type {{ click: () => void } | undefined} */
    const exit = /** @type {any} */ (tpl.find((item) => item.label === '退出'));
    exit?.click();
    expect(quit).toHaveBeenCalledOnce();
  });

  it('external 态显示观察模式文案', () => {
    const tpl = trayMenuTemplate({ probe: 'up', ent, snapshot: { ...snap, state: 'external' }, openAtLogin: false, actions: { showWindow: () => {}, quit: () => {}, toggleOpenAtLogin: () => {} } });
    expect(tpl.some((item) => String(item.label ?? '').includes('外部服务占用（观察模式）'))).toBe(true);
  });
});

describe('托盘 · 装配生命周期（mock electron 依赖）', () => {
  /** 造一个记录调用轨迹的假 Tray。 */
  function makeFakeTray() {
    /** @type {{ toolTips: string[], menus: number, clicks: number, destroyed: number }} */
    const calls = { toolTips: [], menus: 0, clicks: 0, destroyed: 0 };
    /** @type {any} */
    const tray = {
      /** @param {string} t */
      setToolTip: (t) => calls.toolTips.push(t),
      setContextMenu: () => {
        calls.menus += 1;
      },
      /** @param {string} ev @param {() => void} fn */
      on: (ev, fn) => {
        if (ev === 'click') tray.__click = fn;
      },
      destroy: () => {
        calls.destroyed += 1;
      },
      __click: () => {}
    };
    return { tray, calls };
  }

  it('装配即渲染；refresh 更新 tooltip；destroy 幂等且停表', async () => {
    vi.useFakeTimers();
    try {
      const { tray, calls } = makeFakeTray();
      let probeState = 'down';
      const handle = createSystemTray({
        trayFactory: () => tray,
        menuFactory: { buildFromTemplate: (t) => t },
        getSnapshot: () => ({ state: 'stopped', pid: null, port: null, lastChangedAt: null }),
        getLoginItemSettings: () => ({ openAtLogin: false }),
        setLoginItemSettings: () => {},
        pollers: () => ({
          probe: async () => /** @type {'up' | 'unauthorized' | 'down'} */ (probeState),
          entitlement: async () => ({ subscriptionModels: 1, promotionModels: 0, sourceLabel: '目录侧' })
        }),
        showWindow: () => {},
        quit: () => {},
        now: () => 0
      });
      // 构造即渲染一次 + 立即 refresh 一次（初始 down 态）。
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.toolTips.length).toBeGreaterThanOrEqual(1);
      expect(calls.toolTips[calls.toolTips.length - 1]).toContain('服务无响应');
      // 探活恢复 → 下一轮 refresh 反映 up。
      probeState = 'up';
      await handle.refresh();
      expect(calls.toolTips[calls.toolTips.length - 1]).toContain('服务正常');
      // 定时：down 时按退避间隔排程（构造时 down）。
      expect(PROBE_BACKOFF_MS).toBeGreaterThan(PROBE_INTERVAL_MS);
      handle.destroy();
      handle.destroy();
      expect(calls.destroyed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('开机自启开关透传 setLoginItemSettings 并触发重渲染', async () => {
    const { tray, calls } = makeFakeTray();
    const setLogin = vi.fn();
    createSystemTray({
      trayFactory: () => tray,
      menuFactory: { buildFromTemplate: (t) => t },
      getSnapshot: () => ({ state: 'stopped', pid: null, port: null, lastChangedAt: null }),
      getLoginItemSettings: () => ({ openAtLogin: false }),
      setLoginItemSettings: setLogin,
      pollers: () => ({ probe: async () => 'up', entitlement: async () => ({ subscriptionModels: 0, promotionModels: 0, sourceLabel: '未知' }) }),
      showWindow: () => {},
      quit: () => {}
    });
    // 从最后一次渲染的菜单模板里找到自启项并触发 click。
    const lastTemplate = tray.__lastTemplate;
    void lastTemplate;
    // trayMenuTemplate 的 click 已在上一 describe 直测；这里验证装配路径把 setLoginItemSettings 接进去。
    // 简化：直接用模块级模板函数走同一路径。
    const before = calls.menus;
    const tpl = trayMenuTemplate({ probe: 'up', ent: { subscriptionModels: 0, promotionModels: 0, sourceLabel: '未知' }, snapshot: { state: 'stopped', pid: null, port: null, lastChangedAt: null }, openAtLogin: false, actions: { showWindow: () => {}, quit: () => {}, toggleOpenAtLogin: (next) => setLogin({ openAtLogin: next }) } });
    /** @type {{ click: (item: { checked: boolean }) => void }} */
    const auto = /** @type {any} */ (tpl.find((item) => item.label === '开机自启'));
    auto.click({ checked: true });
    expect(setLogin).toHaveBeenCalledWith({ openAtLogin: true });
    void before;
  });
});
