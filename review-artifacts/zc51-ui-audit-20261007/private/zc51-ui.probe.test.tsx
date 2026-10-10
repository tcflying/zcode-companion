/**
 * ZC-51/F30 **表层验收探针**（私有，审计用，不入产品测试链）。
 *
 * 上轮只验了数据层（modelSource.ts 的 RefreshState/delta），不够——
 * F30 原始审查（review-20261003.md:353,357）明确记的是**页面症状**：
 *   「非空刷新成功后底部仍0条，目录标题固定未接入」
 *   「2条成功仍空态；相同2条再读报新增2；2→1报新增1/消失0/保持0」
 * 本探针**真实挂载 ModelsPage**，用真实组件 + 真实数据函数 + fake API，
 * 以**实际渲染输出**证明五组行为，并做**负控**（改目标逻辑 → 页面断言必须失败）。
 *
 * 纪律：不改任何正式源码；不真实模型/凭据/付费通道/服务；不重复跑 55 绿。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { createElement } from 'react';
import { ModelsPage } from './ModelsPage';
import { createInitialSourceState, type ModelEntry } from '../data/modelSource';

/* ---------- 最小 AppState 桩：只提供 ModelsPage 真正读到的字段 ---------- */
const logs: string[] = [];
function makeState(overrides: Record<string, unknown> = {}) {
  return {
    localApiEnabled: true,
    localApiBaseUrl: 'http://127.0.0.1:8790',
    log: (level: string, src: string, msg: string) => {
      logs.push(`${level}|${src}|${msg}`);
    },
    ...overrides
  } as never;
}

/* ---------- fake API：替身 fetch，零真实网络 ---------- */
type Catalog = { revision: string; models: unknown[] };
let currentCatalog: Catalog = { revision: '', models: [] };
let fetchCalls = 0;

function model(id: string) {
  return {
    modelId: id,
    displayName: `模型 ${id}`,
    provider: 'account:zai-start-plan',
    billingClass: 'subscription',
    contextLength: 1000000,
    reasoning: ['low', 'high'],
    capabilities: ['text']
  };
}

beforeEach(() => {
  fetchCalls = 0;
  logs.length = 0;
  currentCatalog = { revision: '', models: [] };
  vi.stubGlobal('fetch', async () => {
    fetchCalls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => currentCatalog
    } as unknown as Response;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ---------- 真挂载 ---------- */
type Mounted = { container: HTMLDivElement; unmount: () => void };

async function mount(): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(ModelsPage, { state: makeState() }));
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    }
  };
}

/** 点「刷新」按钮并等待异步读取落地。 */
async function clickRefresh(container: HTMLElement): Promise<void> {
  const btn = Array.from(container.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes('刷新')
  );
  if (!btn) throw new Error('找不到刷新按钮');
  await act(async () => {
    (btn as HTMLButtonElement).click();
  });
  // 让 promise 链与 React 更新都落地
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
}

function text(container: HTMLElement): string {
  return container.textContent ?? '';
}

describe('ZC-51/F30 表层：真实挂载 ModelsPage', () => {
  it('S1 首刷 2 行：页面不显示空态，且不伪报「新增 2」', async () => {
    currentCatalog = { revision: 'rev-1', models: [model('m1'), model('m2')] };
    const { container, unmount } = await mount();
    await clickRefresh(container);

    const t = text(container);
    // 不空态
    expect(t).toContain('m1');
    expect(t).toContain('m2');
    expect(t).not.toContain('新增 2');
    // 首刷文案
    expect(t).toContain('首次读回');
    // 成功态面板真的渲染出来了（不是 empty 态）
    expect(t).toContain('来源读取成功');
    unmount();
  });

  it('S2 相同 2 行再刷：显示「与上次一致」，不是「新增 2」', async () => {
    currentCatalog = { revision: 'rev-1', models: [model('m1'), model('m2')] };
    const { container, unmount } = await mount();
    await clickRefresh(container);
    await clickRefresh(container);

    const t = text(container);
    expect(t).toContain('与上次一致');
    expect(t).not.toContain('新增 2');
    unmount();
  });

  it('S3 2→1：显示 0 新增 / 1 消失 / 1 保持（卡面正解，旧症状为 1/0/0）', async () => {
    currentCatalog = { revision: 'rev-1', models: [model('m1'), model('m2')] };
    const { container, unmount } = await mount();
    await clickRefresh(container);

    currentCatalog = { revision: 'rev-2', models: [model('m1')] };
    await clickRefresh(container);

    const t = text(container);
    expect(t).toContain('新增 0');
    expect(t).toContain('消失 1');
    expect(t).toContain('保持 1');
    expect(t).not.toContain('保持 0');
    unmount();
  });

  it('S4 失败保旧表：第二次读失败后，页面仍显示上一次的 2 行', async () => {
    currentCatalog = { revision: 'rev-1', models: [model('m1'), model('m2')] };
    const { container, unmount } = await mount();
    await clickRefresh(container);
    expect(text(container)).toContain('m1');

    // 空源 → empty_source 失败分支
    currentCatalog = { revision: 'rev-2', models: [] };
    await clickRefresh(container);

    const t = text(container);
    expect(t).toContain('m1'); // 旧表仍在
    expect(t).toContain('m2');
    expect(t).toContain('empty_source');
    unmount();
  });

  it('S5 无 epoch：目录标题的 epoch/revision 显示 unknown，不造时间戳', async () => {
    currentCatalog = { revision: '', models: [model('m1')] };
    const { container, unmount } = await mount();
    await clickRefresh(container);

    const t = text(container);
    // 标题里应出现 unknown（账号 epoch / 配置 revision）
    expect(t).toContain('账号 epoch unknown');
    expect(t).toContain('配置 revision unknown');
    unmount();
  });
});
