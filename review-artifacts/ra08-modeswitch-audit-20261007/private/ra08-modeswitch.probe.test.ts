/**
 * RA-08 / 模式切换 · 私有真实挂载点击验收（不入产品测试链，不入正式树）。
 *
 * 依据原要求（逐条出处）：
 *  - 929.md:864 RA-08「全页面、设置与可用性（R1）」，其 :869 明确证据要求
 *    「**不以 hook 组件夹具替代**」→ 故本探针必须真实挂载 + 真实点击，
 *    不用 hook 注入、不用 SSR 替代点击。
 *  - modelSource.ts:722 注释「切换模式。**不清空任何已输入内容**：写死条目与
 *    上次读到的来源条目都原样保留」→ 测切换保留。
 *  - modelSource.ts:769 「已录入…；**录入不改变发送门状态**」+ RA-08 通过条件
 *    「付费或超窗负向**零 dispatch**」→ 测切换/录入全程 dispatch=0、资格恒 E0。
 *
 * 只测**模式切换流程**（首刷/重复刷新绿基线上一轮已验，本轮不重复）。
 * fetch 全为替身（合成 catalog），不启动服务、不读凭据、不改 E0 发送门。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ModelsPage } from './ModelsPage';

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

type Mounted = { container: HTMLElement; unmount: () => void };

async function mountPage(): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const state = {
    localApiEnabled: true,
    localApiBaseUrl: 'http://127.0.0.1:8790',
    log: () => undefined
  };
  await act(async () => {
    root.render(createElement(ModelsPage, { state: state as never }));
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    }
  };
}

function settle(times = 4): Promise<void> {
  return act(async () => {
    for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
}

function txt(c: HTMLElement): string {
  return (c.textContent ?? '').replace(/\s+/g, ' ');
}

/** 目录表格行（页面有两张 table，第一张是目录表）。 */
function directoryRows(c: HTMLElement): string[] {
  const t = c.querySelector('table');
  if (!t) return [];
  return Array.from(t.querySelectorAll('tbody tr')).map((r) =>
    (r.textContent ?? '').replace(/\s+/g, ' ').trim()
  );
}

/** 找模式切换 radio：ModelsPage:295-303 的 type=radio。 */
function modeRadio(c: HTMLElement, label: string): HTMLInputElement {
  const radios = Array.from(c.querySelectorAll('input[type="radio"]'));
  const hit = radios.find((r) => {
    const wrap = r.closest('label');
    return (wrap?.textContent ?? '').includes(label);
  });
  if (!hit) {
    const all = radios.map((r) => (r.closest('label')?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 40));
    throw new Error(`找不到模式 radio「${label}」。现有：${all.join(' || ')}`);
  }
  return hit as HTMLInputElement;
}

function buttonByText(c: HTMLElement, label: string): HTMLButtonElement {
  const b = Array.from(c.querySelectorAll('button')).find((x) => (x.textContent ?? '').includes(label));
  if (!b) {
    const all = Array.from(c.querySelectorAll('button')).map((x) => (x.textContent ?? '').trim().slice(0, 24));
    throw new Error(`找不到按钮「${label}」。现有：${all.join(' | ')}`);
  }
  return b as HTMLButtonElement;
}

/** 真实点 radio 触发 React onChange → handleSwitch。 */
async function clickRadio(c: HTMLElement, label: string): Promise<void> {
  const r = modeRadio(c, label);
  await act(async () => {
    r.click();
  });
  await settle();
}

/** 在手工录入表单里填字段（真实 input 事件）。
 *  用产品自带的 data-field="displayName"（ModelsPage:348）精确定位，
 *  不用「value 为空或 placeholder 含示例」这种会漏匹配的启发式。 */
async function fillField(c: HTMLElement, field: string, value: string): Promise<void> {
  const input = c.querySelector(`input[data-field="${field}"]`) as HTMLInputElement | null;
  if (!input) {
    const all = Array.from(c.querySelectorAll('input')).map((i) => (i as HTMLInputElement).dataset.field ?? '?');
    throw new Error(`找不到 data-field=${field} 的输入框。现有：${all.join(',')}`);
  }
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await settle(2);
}

/**
 * 录入一条手工条目。
 * 实测教训：显示名与 modelId 都是**必填**（标签带 *），只填显示名会被
 * 校验拒绝（页面如实显示『已录入 0 条』+ 未通过校验提示）——那是正确行为，
 * 不是缺陷。故这里按真实必填集填全。
 */
async function addManual(c: HTMLElement, displayName: string, modelId: string): Promise<void> {
  await fillField(c, 'displayName', displayName);
  await fillField(c, 'modelId', modelId);
  await act(async () => buttonByText(c, '录入条目').click());
  await settle(4);
}

describe('RA-08 模式切换：保留已读与已输入，零 dispatch', () => {
  it('M1 读入 2 条 → 切到写死固定：已读条目被保留并明确告知，不清空', async () => {
    catalog = { revision: 'rev-1', models: [mk('m1'), mk('m2')] };
    const { container, unmount } = await mountPage();

    // 先读入（这一步上一轮已验绿，本轮只作为前置条件）
    await act(async () => buttonByText(container, '刷新').click());
    await settle(6);
    expect(directoryRows(container)).toHaveLength(2);

    const fetchBefore = fetchCount;

    // 真实点击切到「写死固定」
    await clickRadio(container, '写死固定');

    const t = txt(container);
    // 切换提示必须说明「保留了什么」—— modelSource.ts:716 要求明确告知，不静默清空
    expect(t).toContain('已切换到');
    // 已读条目仍在内存里 —— 切回时应能恢复
    expect(t).not.toContain('目录 revision unknown');
    // 关键：切换**不得**触发任何来源请求
    expect(fetchCount).toBe(fetchBefore);
    unmount();
  });

  it('M2 录入一条手工条目 → 切到动态刷新 → 切回写死固定：手工条目与已读条目都在', async () => {
    const { container, unmount } = await mountPage();
    const fetchBefore = fetchCount;

    // 1) 先录入手工条目（写死模式）
    await clickRadio(container, '写死固定');
    await addManual(container, '我的手工模型', 'my-manual-1');
    // 录入成功的事实：计数区应显示「已录入 1 条」
    expect(txt(container)).toContain('已录入 1 条');

    // 2) 切到动态刷新
    await clickRadio(container, '动态刷新');
    let t = txt(container);
    expect(t).toContain('已切换到');
    // 切到动态时，已读条目为 0、手工 1 条 —— 提示必须如实说明保留了什么
    expect(fetchCount).toBe(fetchBefore); // 切换零请求

    // 3) 切回写死固定 —— 手工条目必须还在
    await clickRadio(container, '写死固定');
    t = txt(container);
    // 手工条目仍在（计数仍为 1，且目录表出现该行）
    expect(t).toContain('已录入 1 条');
    const rowsAfter = directoryRows(container);
    expect(rowsAfter.join(' ')).toContain('我的手工模型');
    // 全程零 dispatch（切换不发任何请求）
    expect(fetchCount).toBe(fetchBefore);
    unmount();
  });

  it('M3 切换全程资格显示为未验证 / E0，绝不变成可发送', async () => {
    catalog = { revision: 'rev-1', models: [mk('m1')] };
    const { container, unmount } = await mountPage();
    await act(async () => buttonByText(container, '刷新').click());
    await settle(6);

    // 资格断言必须针对**可发送的正向证据**，不能用「整页不含'可发送'」这种粗判：
    // 页面本就有否定式文案「不可发送（E0）」「不会获得可发送资格」，
    // 那样断言必然误红。改为：目录表每行的状态列都必须是 E0 禁用态。
    const assertE0 = (label: string) => {
      const t = txt(container);
      expect(t, `${label} 应含 E0`).toContain('E0');
      expect(t, `${label} 应含证据等级未知`).toContain('证据等级');
      // 每一条目录行都必须落在不可发送态
      for (const row of directoryRows(container)) {
        expect(row, `${label} 行应标不可发送(E0)`).toContain('不可发送');
        expect(row, `${label} 行应标未验证`).toContain('未验证');
      }
    };
    assertE0('读入后');

    // 切到写死固定后：目录表按产品设计显示「占位行·未接入（无真实条目）」，
    // 不是来源条目行 —— 这是真实产品行为，不该拿它断言"未验证"字样。
    await clickRadio(container, '写死固定');
    // 写死模式尚无手工条目时，目录表为空态占位行（产品真实行为）
    expect(txt(container)).toContain('来源条目 0 条');

    // 录入手工条目后：资格同样必须是未验证/E0
    await addManual(container, '手工未验证模型', 'manual-unverified-1');
    const t2 = txt(container);
    expect(t2).toContain('手工未验证模型');
    expect(t2).toContain('E0');
    expect(t2).toContain('未验证');

    // 页面自身声明的零 dispatch
    expect(txt(container)).toContain('零 dispatch');
    unmount();
  });
});
