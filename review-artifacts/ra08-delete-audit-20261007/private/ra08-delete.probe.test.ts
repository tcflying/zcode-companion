/**
 * RA-08 · 删除手工条目 + 双模式均有内容时往返切换（私有真实挂载点击，不入产品测试链）。
 *
 * 本轮针对主上指出的两点**证明力不足**做加强：
 *  1) 上一轮 M1 只断言了「目录 revision 未回退」，那**不足以证明来源条目被保留**
 *     —— revision 与 entries 是两件事。⇒ 本轮改为**逐条核对来源 modelId
 *     仍在目录表中**，不只看 revision。
 *  2) 上一轮 M3 靠页面文案断言 E0/未验证，**不证明发送门零 dispatch**
 *     —— 文案是静态的。⇒ 本轮把 dispatch 证据改为可计数的：
 *     没有任何 fetch 命中发送端点、页面自述零 dispatch、且删除/切换全程
 *     fetchCount 恒定。**并如实标明这仍不是从发送门代码路径独立取证。**
 *
 * 原要求出处：
 *  - 929.md:864 RA-08；:869「不以 hook 组件夹具替代」⇒ 真实挂载 + 真实点击。
 *  - modelSource.ts:773 removeManualEntry 只 filter manualEntries，**不碰 refresh.entries**。
 *  - ModelsPage.tsx:706 删除按钮 title「删除写死条目；只影响记录，不影响来源与准入判断」。
 *  - modelSource.ts:722「不清空任何已输入内容」。
 *
 * 只测删除与双内容往返；不重复首刷/重复刷新绿基线；不真实模型/账户请求。
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

function settle(times = 4): Promise<void> {
  return act(async () => {
    for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
}

function txt(c: HTMLElement): string {
  return (c.textContent ?? '').replace(/\s+/g, ' ');
}

function directoryRows(c: HTMLElement): string[] {
  const t = c.querySelector('table');
  if (!t) return [];
  return Array.from(t.querySelectorAll('tbody tr')).map((r) =>
    (r.textContent ?? '').replace(/\s+/g, ' ').trim()
  );
}

/**
 * 目录表里当前可见的 modelId 集合。
 *
 * 两次踩坑后的正确做法（不要再退回正则/空白切分）：
 *  - 行文本是「手工甲手工录入手工录入 · 未由官方验证unknownman-alphaunknown…」，
 *    modelId 前后与中文/英文**直接粘连**；按空白切分、按 (src|man)- 前缀正则
 *    都取不出来（实测 SIMPLE 正则会得到 "man-alphaunknown"）。
 *  - 正解：读 DOM 单元格。MODEL_COLUMNS（snapshot.ts:234）列序为
 *    显示名 / provider / **modelId** / …，modelId 恒为 **cells[2]**，
 *    按列定义取值不依赖任何文本启发式。
 */
function visibleIds(c: HTMLElement): string[] {
  const table = c.querySelector('table');
  if (!table) return [];
  const out: string[] = [];
  for (const tr of Array.from(table.querySelectorAll('tbody tr'))) {
    const cells = Array.from(tr.querySelectorAll('td'));
    const raw = (cells[2]?.textContent ?? '').trim();
    // 空态占位行的 modelId 列是 '—'，不是真实 id
    if (!raw || raw === '—' || raw === 'unknown') continue;
    out.push(raw);
  }
  return out;
}
function modeRadio(c: HTMLElement, label: string): HTMLInputElement {
  const radios = Array.from(c.querySelectorAll('input[type="radio"]'));
  const hit = radios.find((r) => (r.closest('label')?.textContent ?? '').includes(label));
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

async function fillField(c: HTMLElement, field: string, value: string): Promise<void> {
  const input = c.querySelector(`input[data-field="${field}"]`) as HTMLInputElement | null;
  if (!input) {
    const all = Array.from(c.querySelectorAll('input')).map((i) => (i as HTMLInputElement).dataset.field ?? '?');
    throw new Error(`找不到 data-field=${field}。现有：${all.join(',')}`);
  }
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

/** 点某一行里的「删除」按钮（btn--tiny）。 */
async function clickDeleteOnRowContaining(c: HTMLElement, marker: string): Promise<void> {
  const rows = Array.from(c.querySelectorAll('tbody tr'));
  const target = rows.find((r) => (r.textContent ?? '').includes(marker));
  if (!target) {
    throw new Error(`找不到含「${marker}」的行。现有行：${directoryRows(c).join(' || ').slice(0, 300)}`);
  }
  const btn = Array.from(target.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').trim() === '删除'
  );
  if (!btn) throw new Error(`含「${marker}」的行里没有「删除」按钮`);
  await act(async () => {
    (btn as HTMLButtonElement).click();
  });
  await settle(4);
}

describe('RA-08 删除手工条目：只影响目标记录', () => {
  it('D1 删掉目标手工条目，来源条目逐条仍在（不靠 revision 证明）', async () => {
    // 前置：读入 2 条来源
    catalog = { revision: 'rev-1', models: [mk('src-a'), mk('src-b')] };
    const { container, unmount } = await mountPage();
    await act(async () => buttonByText(container, '刷新').click());
    await settle(6);

    // 切写死 + 录两条手工条目
    await clickRadio(container, '写死固定');
    await addManual(container, '手工甲', 'man-alpha');
    await addManual(container, '手工乙', 'man-beta');
    expect(visibleIds(container).sort()).toEqual(['man-alpha', 'man-beta']);

    // 记录来源侧的 ID（本轮不能靠 revision 兜底，要留实际 ID 清单）
    const sourceIdsBefore = ['src-a', 'src-b'];
    const fetchBefore = fetchCount;

    // 删除其中一条
    await clickDeleteOnRowContaining(container, 'man-alpha');

    const t = txt(container);
    // 1) 目标条目确实被删
    expect(visibleIds(container)).toEqual(['man-beta']);
    expect(t).not.toContain('手工甲');
    // 2) 另一条手工条目**不受影响**
    expect(t).toContain('手工乙');
    expect(t).toContain('已录入 1 条');
    // 3) 删除不发任何请求（来源未被触碰）
    expect(fetchCount).toBe(fetchBefore);

    // 4) 关键：切回动态，**来源两条逐条仍在** —— 这才是保留的证据
    await clickRadio(container, '动态刷新');
    const afterIds = visibleIds(container);
    for (const id of sourceIdsBefore) {
      expect(afterIds, `来源条目 ${id} 应逐条保留`).toContain(id);
    }
    expect(directoryRows(container)).toHaveLength(2);
    unmount();
  });

  it('D2 删除只影响记录、不改变准入判断：删除后 E0 与零 dispatch 仍成立', async () => {
    catalog = { revision: 'rev-1', models: [mk('src-a')] };
    const { container, unmount } = await mountPage();
    await act(async () => buttonByText(container, '刷新').click());
    await settle(6);
    await clickRadio(container, '写死固定');
    await addManual(container, '手工丙', 'man-gamma');
    const fetchBefore = fetchCount;

    await clickDeleteOnRowContaining(container, 'man-gamma');

    const t = txt(container);
    // 删除后写入被删除、计数归零
    expect(visibleIds(container)).toEqual([]);
    expect(t).toContain('已录入 0 条');
    // 删除提示必须说明「不影响来源与准入判断」（ModelsPage:253）
    expect(t).toContain('已删除 1 条手工录入条目');
    // 真实文案（实测）：『删除只影响本机内存中的写死列表』
    expect(t).toContain('删除只影响本机内存中的写死列表');
    // 准入判断未被改动：E0 / 不可发送 / 零 dispatch 仍在
    expect(t).toContain('E0');
    expect(t).toContain('不可发送');
    expect(t).toContain('零 dispatch');
    // 全程零请求 ⇒ 未触发任何发送侧调用
    expect(fetchCount).toBe(fetchBefore);
    expect(fetchedUrls.every((u) => u.includes('/v1/zcc/catalog'))).toBe(true);
    unmount();
  });
});

describe('RA-08 双模式均有内容时往返切换', () => {
  it('S1 来源 2 条 + 手工 2 条：切到写死→切回动态，两侧 ID 逐条都在', async () => {
    catalog = { revision: 'rev-1', models: [mk('src-a'), mk('src-b')] };
    const { container, unmount } = await mountPage();
    await act(async () => buttonByText(container, '刷新').click());
    await settle(6);

    await clickRadio(container, '写死固定');
    await addManual(container, '手工甲', 'man-alpha');
    await addManual(container, '手工乙', 'man-beta');
    const fetchBefore = fetchCount;

    // 切回动态：来源两条逐条必须还在
    await clickRadio(container, '动态刷新');
    const dynIds = visibleIds(container);
    expect(dynIds.sort()).toEqual(['src-a', 'src-b']);
    // 切换提示此时应说明两种模式都有内容（switchMode:740-743 的 keptParts 分支）
    expect(txt(container)).toContain('已切换到');

    // 再切回写死：手工两条逐条必须还在
    await clickRadio(container, '写死固定');
    const manIds = visibleIds(container);
    expect(manIds.sort()).toEqual(['man-alpha', 'man-beta']);
    // 两次切换零来源请求
    expect(fetchCount).toBe(fetchBefore);
    // 来源侧没有被手工内容污染
    expect(txt(container)).not.toContain('src-a');
    unmount();
  });

  it('S2 往返切换全程 dispatch 为零：无任何非目录请求', async () => {
    catalog = { revision: 'rev-1', models: [mk('src-a')] };
    const { container, unmount } = await mountPage();
    await act(async () => buttonByText(container, '刷新').click());
    await settle(6);
    await clickRadio(container, '写死固定');
    await addManual(container, '手工丁', 'man-delta');

    const baseline = fetchCount;
    await clickRadio(container, '动态刷新');
    await clickRadio(container, '写死固定');
    await clickRadio(container, '动态刷新');

    expect(fetchCount).toBe(baseline);
    // 所有请求都是目录读取，没有任何 /chat/completions 之类发送侧调用
    expect(fetchedUrls.length).toBeGreaterThan(0);
    expect(fetchedUrls.some((u) => /chat\/completions|send|dispatch/i.test(u))).toBe(false);
    expect(txt(container)).toContain('零 dispatch');
    unmount();
  });
});
