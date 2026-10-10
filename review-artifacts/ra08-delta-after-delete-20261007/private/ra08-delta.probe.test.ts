/**
 * 私有真实挂载：删除手工条目后刷新源列表，delta 摘要**不得**把手工删除
 * 算作「源模型消失」。
 *
 * 正控（POS）：来源目录**确实**少了一条 → delta 必须计入「消失 1」。
 * 负控（NEG）：只删了**手工条目**，来源目录未变 → delta 必须**零增删**、
 *             摘要不得出现任何「消失」。
 *
 * 为什么需要正控：只验负控的话，一个「delta 恒为空/恒为零」的实现也能通过，
 * 证明不了它在真消失时仍会如实报告。正控把这条区分钉住。
 *
 * 静态线索（仅作对照，不当结论）：modelSource.ts:658-660 的
 * `listDelta(state.entries, parsed.entries)` 只比 refresh.entries，
 * manualEntries 不参与 ⇒ 负控在代码层应当成立。本轮用实测确认或推翻。
 *
 * 纪律：不改正式实现、不抢活动 writer、不真实模型/账户请求、
 * 不启停服务、不改历史证据；不重复上一轮那 4 条绿。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ModelsPage } from './ModelsPage';

let catalog: { revision: string; models: unknown[] } = { revision: '', models: [] };
let fetchCount = 0;
const fetchedUrls: string[] = [];

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
  fetchedUrls.length = 0;
  catalog = { revision: '', models: [] };
  vi.stubGlobal('fetch', async (url: unknown) => {
    fetchCount += 1;
    fetchedUrls.push(String(url));
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

function settle(times = 5): Promise<void> {
  return act(async () => {
    for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
}

function txt(c: HTMLElement): string {
  return (c.textContent ?? '').replace(/\s+/g, ' ');
}

/** 目录表 modelId 列（MODEL_COLUMNS 列序：显示名/provider/modelId → cells[2]）。 */
function visibleIds(c: HTMLElement): string[] {
  const table = c.querySelector('table');
  if (!table) return [];
  const out: string[] = [];
  for (const tr of Array.from(table.querySelectorAll('tbody tr'))) {
    const cells = Array.from(tr.querySelectorAll('td'));
    const raw = (cells[2]?.textContent ?? '').trim();
    if (!raw || raw === '—' || raw === 'unknown') continue;
    out.push(raw);
  }
  return out;
}

function modeRadio(c: HTMLElement, label: string): HTMLInputElement {
  const hit = Array.from(c.querySelectorAll('input[type="radio"]')).find((r) =>
    (r.closest('label')?.textContent ?? '').includes(label)
  );
  if (!hit) throw new Error(`找不到模式 radio「${label}」`);
  return hit as HTMLInputElement;
}

async function clickRadio(c: HTMLElement, label: string): Promise<void> {
  const r = modeRadio(c, label);
  await act(async () => {
    r.click();
  });
  await settle();
}

function buttonByText(c: HTMLElement, label: string): HTMLButtonElement {
  const b = Array.from(c.querySelectorAll('button')).find((x) => (x.textContent ?? '').includes(label));
  if (!b) {
    const all = Array.from(c.querySelectorAll('button')).map((x) => (x.textContent ?? '').trim().slice(0, 20));
    throw new Error(`找不到按钮「${label}」。现有：${all.join(' | ')}`);
  }
  return b as HTMLButtonElement;
}

async function clickRefresh(c: HTMLElement): Promise<void> {
  await act(async () => buttonByText(c, '刷新来源').click());
  await settle(6);
}

async function fillField(c: HTMLElement, field: string, value: string): Promise<void> {
  const input = c.querySelector(`input[data-field="${field}"]`) as HTMLInputElement | null;
  if (!input) throw new Error(`找不到 data-field=${field}`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await settle(2);
}

async function addManual(c: HTMLElement, displayName: string, modelId: string): Promise<void> {
  await fillField(c, 'displayName', displayName);
  await fillField(c, 'modelId', modelId);
  await act(async () => buttonByText(c, '录入条目').click());
  await settle(4);
}

async function clickDeleteOnRowContaining(c: HTMLElement, marker: string): Promise<void> {
  const rows = Array.from(c.querySelectorAll('tbody tr'));
  const target = rows.find((r) => (r.textContent ?? '').includes(marker));
  if (!target) throw new Error(`找不到含「${marker}」的行`);
  const btn = Array.from(target.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').trim() === '删除'
  );
  if (!btn) throw new Error(`含「${marker}」的行里没有删除按钮`);
  await act(async () => {
    (btn as HTMLButtonElement).click();
  });
  await settle(4);
}

describe('负控 NEG：只删手工条目 → 刷新后 delta 必须零增删', () => {
  it('NEG1 删手工条目后刷新动态来源：目录 ID 逐条不变，摘要无任何「消失」', async () => {
    catalog = { revision: 'rev-1', models: [mk('src-a'), mk('src-b')] };
    const { container, unmount } = await mountPage();
    await clickRefresh(container);
    expect(visibleIds(container).sort()).toEqual(['src-a', 'src-b']);

    // 切写死 + 录一条手工 + 删掉它
    await clickRadio(container, '写死固定');
    await addManual(container, '手工丙', 'man-ccc');
    await clickDeleteOnRowContaining(container, 'man-ccc');
    expect(txt(container)).toContain('已录入 0 条');

    // 切回动态并**再刷新一次** —— 这才产生新的 delta
    await clickRadio(container, '动态刷新');
    await clickRefresh(container);

    const t = txt(container);
    // 1) 来源 ID 逐条不变
    expect(visibleIds(container).sort()).toEqual(['src-a', 'src-b']);
    // 2) delta 必须是「与上次一致」——**零增删**
    expect(t).toContain('与上次一致');
    // 3) 不得出现任何「消失」计数
    expect(t).not.toContain('消失 1');
    expect(t).not.toContain('新增 1');
    // 4) 请求记录：确实是重新读了目录（证明 delta 是新算的，不是陈旧值）
    expect(fetchCount).toBe(2);
    expect(fetchedUrls.every((u) => u.includes('/v1/zcc/catalog'))).toBe(true);
    expect(fetchedUrls.some((u) => /chat\/completions|send|dispatch/i.test(u))).toBe(false);
    unmount();
  });
});

describe('正控 POS：来源确实少一条 → delta 必须计入消失', () => {
  it('POS1 来源从 2 条变 1 条：摘要必须报「消失 1 / 保持 1」', async () => {
    catalog = { revision: 'rev-1', models: [mk('src-a'), mk('src-b')] };
    const { container, unmount } = await mountPage();
    await clickRefresh(container);
    expect(visibleIds(container).sort()).toEqual(['src-a', 'src-b']);

    // 切写死 + 录一条手工（**不删**），只为把「手工侧有内容」这个变量也带进来
    await clickRadio(container, '写死固定');
    await addManual(container, '手工丁', 'man-ddd');
    expect(txt(container)).toContain('已录入 1 条');

    // 切回动态，来源真的少了一条
    await clickRadio(container, '动态刷新');
    catalog = { revision: 'rev-2', models: [mk('src-a')] };
    await clickRefresh(container);

    const t = txt(container);
    // 来源确实少了一条
    expect(visibleIds(container)).toEqual(['src-a']);
    // delta 必须如实计入消失 —— 这条是正控的意义
    expect(t).toContain('消失 1');
    expect(t).toContain('保持 1');
    expect(t).toContain('新增 0');
    // 正控不依赖手工侧状态：这里手工条目仍在
    await clickRadio(container, '写死固定');
    expect(txt(container)).toContain('手工丁');
    unmount();
  });
});
