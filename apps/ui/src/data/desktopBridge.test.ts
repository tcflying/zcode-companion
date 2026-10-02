/**
 * I10 桌面桥的类型面与「无桥降级」契约。
 *
 * 环境是 node（见 apps/ui/vitest.config.ts），所以这里显式装一个最小的 `window`：
 * 桥存在 / 不存在两种形态都要被钉住——「不在桌面程序里也能渲染」是一条产品承诺，
 * 不是一个可以顺手的 fallback。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  UNAVAILABLE_SNAPSHOT,
  UNAVAILABLE_REASON,
  desktopAvailable,
  desktopBridge,
  readLogTail,
  readSettings,
  readSnapshot,
  restartProxy,
  saveSettings,
  startProxy,
  stopProxy,
  subscribeDesktop,
  type DesktopLogLine,
  type ProxySnapshot,
  type PublicSettings
} from './desktopBridge';

const SYNTHETIC_KEY = 'zcc_ui_bridge_test_synthetic_key_0007';

interface BridgeDouble {
  desktop: boolean;
  getSnapshot(): Promise<ProxySnapshot>;
  subscribe(handler: (payload: { snapshot: ProxySnapshot; logs: DesktopLogLine[] }) => void): () => void;
  start(): Promise<{ ok: boolean; code: string }>;
  stop(): Promise<{ ok: boolean; code: string }>;
  restart(): Promise<{ ok: boolean; code: string }>;
  getLogTail(limit?: number): Promise<DesktopLogLine[]>;
  getSettings(): Promise<unknown>;
  saveSettings(next: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }>;
}

function installBridge(bridge: unknown): void {
  (globalThis as unknown as { window: unknown }).window = { zccDesktop: bridge };
}

beforeEach(() => {
  installBridge(undefined);
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

function makeBridge(overrides: Partial<BridgeDouble> = {}): BridgeDouble {
  const base: BridgeDouble = {
    desktop: true,
    getSnapshot: async () => ({ ...UNAVAILABLE_SNAPSHOT, state: 'running', pid: 4242, port: 8791, owned: true }),
    subscribe: () => () => undefined,
    start: async () => ({ ok: true, code: 'STARTED' }),
    stop: async () => ({ ok: true, code: 'STOPPED' }),
    restart: async () => ({ ok: true, code: 'STARTED' }),
    getLogTail: async () => [],
    getSettings: async () => ({}),
    saveSettings: async () => ({ ok: true })
  };
  return { ...base, ...overrides };
}

describe('桌面桥缺席：不假装有桌面', () => {
  it('window 上没有桥时 available=false，快照如实是 stopped', async () => {
    expect(desktopAvailable()).toBe(false);
    expect(desktopBridge()).toBeNull();
    await expect(readSnapshot()).resolves.toEqual(UNAVAILABLE_SNAPSHOT);
  });

  it('缺席时所有动作都报 DESKTOP_UNAVAILABLE，而不是静默成功', async () => {
    await expect(startProxy()).resolves.toEqual({ ok: false, code: 'DESKTOP_UNAVAILABLE' });
    await expect(stopProxy()).resolves.toEqual({ ok: false, code: 'DESKTOP_UNAVAILABLE' });
    await expect(restartProxy()).resolves.toEqual({ ok: false, code: 'DESKTOP_UNAVAILABLE' });
    await expect(saveSettings({})).resolves.toEqual({ ok: false, reason: UNAVAILABLE_REASON });
  });

  it('缺席时读操作返回空值而不是抛错（界面必须还能渲染）', async () => {
    await expect(readLogTail()).resolves.toEqual([]);
    await expect(readSettings()).resolves.toBeNull();
    expect(typeof subscribeDesktop(() => undefined)).toBe('function');
    expect(() => subscribeDesktop(() => undefined)()).not.toThrow();
  });

  it('桥存在但 desktop !== true 时同样按缺席处理', () => {
    installBridge(makeBridge({ desktop: false }));
    expect(desktopAvailable()).toBe(false);
  });
});

describe('桌面桥在场：动作与快照透传', () => {
  it('getSnapshot 拿到主进程给的真实快照', async () => {
    installBridge(makeBridge());
    const snapshot = await readSnapshot();
    expect(snapshot).toMatchObject({ state: 'running', pid: 4242, port: 8791, owned: true });
  });

  it('start / stop / restart 原样转发，不在界面侧改写结果', async () => {
    const calls: string[] = [];
    installBridge(
      makeBridge({
        start: async () => {
          calls.push('start');
          return { ok: false, code: 'EXTERNAL_NOT_OWNED' };
        },
        stop: async () => {
          calls.push('stop');
          return { ok: true, code: 'STOPPED' };
        },
        restart: async () => {
          calls.push('restart');
          return { ok: true, code: 'STARTED' };
        }
      })
    );
    // external 的拒绝必须原样透出，界面据此把按钮显示成「被拒绝」而不是假装成功。
    await expect(startProxy()).resolves.toEqual({ ok: false, code: 'EXTERNAL_NOT_OWNED' });
    await expect(stopProxy()).resolves.toEqual({ ok: true, code: 'STOPPED' });
    await expect(restartProxy()).resolves.toEqual({ ok: true, code: 'STARTED' });
    expect(calls).toEqual(['start', 'stop', 'restart']);
  });

  it('subscribe 返回的退订函数可调用', () => {
    let unsubscribed = false;
    installBridge(
      makeBridge({
        subscribe: () => () => {
          unsubscribed = true;
        }
      })
    );
    subscribeDesktop(() => undefined)();
    expect(unsubscribed).toBe(true);
  });

  it('saveSettings 只提交界面上真正改了的字段', async () => {
    const seen: Record<string, unknown>[] = [];
    installBridge(
      makeBridge({
        saveSettings: async (next) => {
          seen.push(next);
          return { ok: true };
        }
      })
    );
    await saveSettings({ apiPort: 8791, driver: 'official-host', reasoning: 'low' });
    expect(seen[0]).toEqual({ apiPort: 8791, driver: 'official-host', reasoning: 'low' });
    // 载荷里没有 apiKey —— 界面没有、也不该有那把 key。
    expect('apiKey' in (seen[0] ?? {})).toBe(false);
  });
});

describe('公开设置类型：没有明文 key 的容身之处', () => {
  it('PublicSettings 只有掩码与指纹，没有 apiKey 字段', () => {
    const view: PublicSettings = {
      apiKeySet: true,
      apiKeyMasked: '••••••••',
      apiKeyFingerprint: 'zcc-fp:0123456789ab',
      apiPort: 8791,
      driver: 'official-host',
      reasoning: 'low',
      driverClosedSet: ['none', 'local-official', 'official-host'],
      reasoningClosedSet: ['low', 'high', 'max']
    };
    expect(Object.keys(view)).not.toContain('apiKey');
    expect(JSON.stringify(view)).not.toContain(SYNTHETIC_KEY);
  });
});
