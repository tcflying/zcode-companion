/**
 * ZCC-ACCOUNT-EVIDENCE-20261009 · 总览页真实渲染测试（SSR，非 GUI 验收）。
 *
 * 沿用 `useAppState.test.ts` 的装配模式：`react-dom/server` 的 `renderToStaticMarkup`，
 * 无 jsdom、不触网。断言的是**渲染出的真实文本**，不是源码字符串。
 *
 * 覆盖：
 *  - 三组标签结构与页头徽章常驻；
 *  - 「账号与权益」标签在目录读回成功时显示真实 revision / 条目数 / 分布；
 *  - 失败态显示原因码、不闪旧数据；未开启时显示未接入原因；
 *  - 权威桶读数始终「未观测」（没有真实数据源就不假填）；
 *  - 读回有 entitled 条目时页头徽章显示 E1，且仍带「发送门仍关闭」。
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OverviewPage, type OverviewPageProps } from './OverviewPage';
import { UNAVAILABLE_SNAPSHOT } from '../data/desktopBridge';
import { INITIAL_ACCOUNT_CATALOG, summarizeEntries } from '../data/accountCatalog';
import type { AccountCatalogHandle } from '../app/useAccountCatalog';
import type { AppState } from '../app/useAppState';
import type { DesktopState } from '../app/useDesktopState';

const desktop: DesktopState = {
  available: false,
  snapshot: UNAVAILABLE_SNAPSHOT,
  logs: [],
  settings: null,
  settingsLoad: 'no-bridge',
  refresh: () => undefined,
  refreshLogs: () => undefined,
  refreshSettings: () => undefined
};

const state = (over: Partial<AppState> = {}): AppState => ({
  logs: [],
  log: () => undefined,
  clearLogs: () => undefined,
  bootedAt: 1000,
  now: Date.UTC(2026, 0, 1, 12, 0, 0),
  clockBroken: false,
  setClockBroken: () => undefined,
  localApiEnabled: true,
  setLocalApiEnabled: () => undefined,
  localApiBaseUrl: '',
  setLocalApiBaseUrl: () => undefined,
  readStatus: {
    phase: 'idle',
    snapshot: null,
    failure: null,
    loadedAt: null
  },
  refreshReadStatus: async () => undefined,
  ...over
});

const idleAccount: AccountCatalogHandle = {
  ...INITIAL_ACCOUNT_CATALOG,
  refresh: async () => undefined
};

function loadedAccount(): AccountCatalogHandle {
  const summary = summarizeEntries('rev-2026-10-09', [
    {
      key: 'source:a',
      displayName: 'A',
      provider: 'bigmodel',
      modelId: 'a',
      billingClass: 'subscription',
      contextLength: 200000,
      reasoning: [],
      capabilities: [],
      origin: 'source',
      availability: 'unverified',
      sendEligible: false,
      note: ''
    },
    {
      key: 'source:b',
      displayName: 'B',
      provider: 'bigmodel-start-plan',
      modelId: 'b',
      billingClass: 'promotion',
      contextLength: null,
      reasoning: [],
      capabilities: [],
      origin: 'source',
      availability: 'unverified',
      sendEligible: false,
      note: ''
    },
    {
      key: 'source:c',
      displayName: 'C',
      provider: 'zai',
      modelId: 'c',
      billingClass: 'metered_api',
      contextLength: null,
      reasoning: [],
      capabilities: [],
      origin: 'source',
      availability: 'unverified',
      sendEligible: false,
      note: ''
    }
  ]);
  return { phase: 'loaded', summary, failure: null, loadedAt: 1, refresh: async () => undefined };
}

function render(props: Partial<OverviewPageProps> = {}): string {
  return renderToStaticMarkup(
    createElement(OverviewPage, { state: state(), desktop, account: idleAccount, ...props })
  );
}

describe('总览页：三组标签结构', () => {
  it('页头标题与徽章在标签区外，三个标签齐备，默认停在「运行时」', () => {
    const html = render();
    expect(html).toContain('总览');
    expect(html).toContain('运行时');
    expect(html).toContain('账号与权益');
    expect(html).toContain('证据说明');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('本机反代');
    expect(html).toContain('启动时长与时钟');
    // 页头徽章常驻：任何标签下都能看到等级与未观测边界
    expect(html).toContain('证据等级');
    expect(html).toContain('当前官方进程 未观测');
  });

  it('运行时标签保留连接状态、时钟与 app-server 运行时字段', () => {
    const html = render({ initialTab: 'runtime' });
    expect(html).toContain('启动时长与时钟');
    expect(html).toContain('连接状态 · app-server 运行时');
    expect(html).toContain('账号握手未证明');
  });

  it('版本与指纹归入「证据说明」（证据链第一环），信息一条不少', () => {
    const html = render({ initialTab: 'evidence' });
    expect(html).toContain('版本与指纹');
    expect(html).toContain('本产品版本');
    expect(html).toContain('官方包 SHA-256');
    expect(html).toContain('0.1.0');
  });
});

describe('总览页：「账号与权益」接真实只读目录', () => {
  it('读回成功 → 显示真实 revision / 条目总数 / 分布 / entitled 口径', () => {
    const html = render({ initialTab: 'account', account: loadedAccount() });
    expect(html).toContain('rev-2026-10-09');
    expect(html).toContain('3 条');
    expect(html).toContain('bigmodel');
    expect(html).toContain('bigmodel-start-plan');
    expect(html).toContain('zai');
    expect(html).toContain('×1');
    expect(html).toContain('目录侧套餐/活动通道条目');
    expect(html).toContain('未观测'); // 权威桶仍如实显示未观测
    expect(html).toContain('不等同'); // 口径提示在页面上
  });

  it('读回成功且有 entitled 条目 → 页头徽章 E1，但仍标明发送门关闭', () => {
    const html = render({ account: loadedAccount() });
    expect(html).toContain('E1');
    expect(html).toContain('发送门仍关闭');
  });

  it('读取失败 → 显示原因码与原因，且不出现旧数据', () => {
    const account: AccountCatalogHandle = {
      phase: 'failed',
      summary: null,
      failure: { code: 'api_not_running', message: '本机 API 未启动', at: 1 },
      loadedAt: null,
      refresh: async () => undefined
    };
    const html = render({ initialTab: 'account', account });
    expect(html).toContain('api_not_running');
    expect(html).toContain('本机 API 未启动');
    expect(html).not.toContain('rev-2026-10-09');
    expect(html).toContain('E0');
  });

  it('未读回 → 如实显示未接入原因，不填占位数据', () => {
    const html = render({
      initialTab: 'account',
      // 设置页开关关闭也不影响总览读回：这条通道走桌面壳同源转发，与模型页外联守卫无关。
      state: state({ localApiEnabled: false }),
      account: { ...INITIAL_ACCOUNT_CATALOG, refresh: async () => undefined }
    });
    expect(html).toContain('未接入');
    expect(html).toContain('尚未读回目录');
    expect(html).not.toContain('已接入');
    expect(html).toContain('未观测'); // 权威桶仍不假填
  });

  it('加载中 → 明确显示读取中，不用上一次结果顶替', () => {
    const html = render({
      initialTab: 'account',
      account: { phase: 'loading', summary: null, failure: null, loadedAt: null, refresh: async () => undefined }
    });
    expect(html).toContain('读取中');
    expect(html).toContain('不用上一次结果顶替');
  });
});

describe('总览页：证据说明标签', () => {
  it('E0–E3 定义仍全在，且按计算值高亮当前等级', () => {
    const html = render({ initialTab: 'evidence', account: loadedAccount() });
    expect(html).toContain('E0');
    expect(html).toContain('E1');
    expect(html).toContain('E2');
    expect(html).toContain('E3');
    expect(html).toContain('evidence--current');
    expect(html).toContain('catalog_entitled_present');
  });

  it('E1 标注为「部分满足」，不得让四条件定义原文被读成四项全成立', () => {
    const html = render({ initialTab: 'evidence', account: loadedAccount() });
    // 定义原文仍在（不动 snapshot.ts 的登记口径）
    expect(html).toContain('目录/资格可用：官方登录、目录、套餐资格与实际选模读回成立');
    // 但当前态必须带部分满足标注 + 明确列出未证明的三项
    expect(html).toContain('当前 · 部分满足');
    expect(html).toContain('目录侧部分满足');
    expect(html).toContain('官方登录、套餐资格回执与实际选模均未证明');
    expect(html).toContain('不构成完整 E1');
    // 不允许出现裸的「当前」徽章（那会与四条件原文并列成误导）
    expect(html).not.toMatch(/>当前</);
  });

  it('E0 当前态仍是普通「当前」，不加部分满足噪声', () => {
    const html = render({ initialTab: 'evidence' });
    expect(html).toMatch(/>当前</);
    expect(html).not.toContain('当前 · 部分满足');
    expect(html).not.toContain('部分满足');
  });

  it('未读取时当前等级是 E0，并说明原因', () => {
    const html = render({ initialTab: 'evidence' });
    expect(html).toContain('catalog_not_read');
    expect(html).toContain('evidence--current');
  });
});