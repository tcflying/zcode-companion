/**
 * ZC-51/F30 **真实挂载 · 真实点击**验收探针（私有，审计用，不入产品测试链）。
 *
 * 主线程要求：不签收静态 SSR；数据函数文案 ≠ ModelsPage 交互。
 * 本探针满足：
 *   - react-dom/client **createRoot 真实挂载** 原组件 ModelsPage（未改一字节）
 *   - **fake API 触发真实刷新点击**（点页面上的「刷新」按钮，不是 stub 状态）
 *   - **等待真实重渲染**后断言 DOM 表格 / 摘要 / notice / revision
 *   - 不 stub useState、不设初始 refresh 冒充点击
 *
 * DOM 环境：happy-dom 20.11.6（只读复用 G:/mmx-project/bbweb-2/frontend/node_modules）
 *   + 本项目 react 19.3.0 + vitest 5.0.2，经私有 setupFiles 注入。
 *   兼容性已单独实测通过（4/4）。
 *
 * 纪律：不改正式源、不装依赖、零真实模型/凭据/付费通道/服务。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ModelsPage } from './ModelsPage';

/* ---------------- fake API：只替 fetch，零真实网络 ---------------- */
let catalog: { revision: string; models: unknown[] } = { revision: '', models: [] };
let fetchCount = 0;

function mk(id: string) {
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
  fetchCount = 0;
  catalog = { revision: '', models: [] };
  vi.stubGlobal('fetch', async () => {
    fetchCount += 1;
    // 实测教训：只给 json() 不够 —— 真实 loader 会先调 res.text() 读正文，
    // 缺了它页面会显示「connection_failed：返回 2xx 但正文读不出来」，
    // 那正是 F30 卡面描述的失败路径，不是被测行为。
    const body = JSON.stringify(catalog);
    return {
      ok: true,
      status: 200,
      text: async () => body,
      json: async () => JSON.parse(body)
    } as unknown as Response;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ---------------- 真实挂载 ---------------- */
type Mounted = { root: Root; container: HTMLElement; unmount: () => void };

async function mountPage(): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const logs: string[] = [];
  const state = {
    localApiEnabled: true,
    localApiBaseUrl: 'http://127.0.0.1:8790',
    log: (l: string, s: string, m: string) => {
      logs.push(`${l}|${s}|${m}`);
    }
  };
  await act(async () => {
    root.render(createElement(ModelsPage, { state: state as never }));
  });
  return {
    root,
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    }
  };
}

/** 找到文本匹配的那个按钮（真实点击，不是直接调 handler）。 */
function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const btns = Array.from(container.querySelectorAll('button'));
  const hit = btns.find((b) => (b.textContent ?? '').includes(label));
  if (!hit) {
    const all = btns.map((b) => (b.textContent ?? '').trim()).join(' | ');
    throw new Error(`找不到按钮「${label}」。现有按钮：${all}`);
  }
  return hit as HTMLButtonElement;
}

/** 点按钮并等待异步刷新 + 重渲染彻底落地。 */
async function clickAndSettle(container: HTMLElement, label: string): Promise<void> {
  const btn = findButton(container, label);
  await act(async () => {
    btn.click();
  });
  // 冲刷 runRefresh 的 promise 链与随后的 setState 重渲染
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function txt(container: HTMLElement): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ');
}

/**
 * 取**目录表格**的行文本。
 * 页面里有两张 table（目录表 + 契约列结构说明表），目录表是第一张，
 * 实测其 tbody 行数 = 条目数（实测 2 行 = 2 个条目，占位行不计入）。
 */
function directoryRows(container: HTMLElement): string[] {
  const table = container.querySelector('table');
  if (!table) return [];
  return Array.from(table.querySelectorAll('tbody tr')).map((r) =>
    (r.textContent ?? '').replace(/\s+/g, ' ').trim()
  );
}

describe('ZC-51/F30 真实挂载 · 真实点击', () => {
  it('S1 首刷 2 行：表格出现两行、摘要说「首次读回」而非「新增 2」、notice 非空', async () => {
    catalog = { revision: 'rev-1', models: [mk('m1'), mk('m2')] };
    const { container, unmount } = await mountPage();
    await clickAndSettle(container, '刷新');

    const t = txt(container);
    // 1) 目录表格真的渲染出两行（不是空态）
    const rows = directoryRows(container);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('m1');
    expect(rows[1]).toContain('m2');
    // 2) 成功态面板（ModelsPage:768 StatePanel「来源读取成功」）
    expect(t).toContain('来源读取成功');
    // 实测真实文案是「已读取 2 个条目」（不是"已读到"）—— 按真实输出断言
    expect(t).toContain('已读取 2 个条目');
    // 占位行在成功态必须消失（ModelsPage:768 成功分支取代 empty 占位）
    expect(t).not.toContain('占位行');
    // 3) 首刷摘要不是「新增 2」
    expect(t).toContain('首次读回');
    expect(t).not.toContain('新增 2');
    // 4) revision 走动态字段 rev-1
    expect(t).toContain('目录 revision rev-1');
    // 5) 确实打了一次 fake API
    expect(fetchCount).toBe(1);
    unmount();
  });

  it('S2 相同 2 行再刷：摘要变「与上次一致」，仍不出现「新增 2」', async () => {
    catalog = { revision: 'rev-1', models: [mk('m1'), mk('m2')] };
    const { container, unmount } = await mountPage();
    await clickAndSettle(container, '刷新');
    await clickAndSettle(container, '刷新');

    const t = txt(container);
    expect(t).toContain('与上次一致');
    expect(t).not.toContain('新增 2');
    expect(t).toContain('来源读取成功');
    expect(fetchCount).toBe(2);
    unmount();
  });

  it('S3 2→1：页面摘要出现 0 新增 / 1 消失 / 1 保持', async () => {
    catalog = { revision: 'rev-1', models: [mk('m1'), mk('m2')] };
    const { container, unmount } = await mountPage();
    await clickAndSettle(container, '刷新');

    catalog = { revision: 'rev-2', models: [mk('m1')] };
    await clickAndSettle(container, '刷新');

    const t = txt(container);
    expect(t).toContain('新增 0');
    expect(t).toContain('消失 1');
    expect(t).toContain('保持 1');
    expect(t).not.toContain('保持 0');
    // 表格作用域断言：m2 必须从**目录表格行**里消失。
    // 注意不能对整个 container.textContent 断言 not.toContain('m2')——
    // 摘要文案「消失 1（m2）」本身就含 m2，那是正确的差异披露。
    const rows = directoryRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('m1');
    expect(rows.join(' ')).not.toContain('m2');
    expect(fetchCount).toBe(2);
    unmount();
  });

  it('S4 失败保留旧表：第二次读空源失败后，表格仍保留上一次的 2 行', async () => {
    catalog = { revision: 'rev-1', models: [mk('m1'), mk('m2')] };
    const { container, unmount } = await mountPage();
    await clickAndSettle(container, '刷新');
    expect(container.textContent).toContain('m1');

    catalog = { revision: 'rev-2', models: [] };
    await clickAndSettle(container, '刷新');

    // 卡面负例(a)：空源失败仍保旧表 —— 表格里两行都还在
    const rows = directoryRows(container);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('m1');
    expect(rows[1]).toContain('m2');
    // 失败原因诚实可见
    const t = txt(container);
    expect(t).toContain('empty_source');
    expect(t).toContain('来源返回 0 个条目');
    unmount();
  });

  it('S5 未接 epoch：标题里账号/配置 revision 为 unknown，首刷前目录 revision 亦为 unknown', async () => {
    const { container, unmount } = await mountPage();

    // 首屏（还没点刷新）：目录 revision 应为 unknown，不造时间戳
    let t = txt(container);
    expect(t).toContain('目录 revision unknown');
    expect(t).toContain('账号 epoch unknown');
    expect(t).toContain('配置 revision unknown');

    // 点一次刷新，动态字段到位，但 epoch/配置 revision 仍是 unknown
    catalog = { revision: 'rev-x', models: [mk('m1')] };
    await clickAndSettle(container, '刷新');
    t = txt(container);
    expect(t).toContain('目录 revision rev-x');
    expect(t).toContain('账号 epoch unknown');
    expect(t).toContain('配置 revision unknown');
    unmount();
  });
});
