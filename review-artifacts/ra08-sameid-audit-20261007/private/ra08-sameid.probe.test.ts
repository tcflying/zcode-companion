/**
 * RA-08 · 同 ID 冲突：手工 modelId 与来源 modelId **完全同名**时的两域物理隔离
 * （私有真实挂载 + 真实点击，不入产品测试链）。
 *
 * 本轮补的是此前**从未覆盖**的场景：所有历史轮次都用 `src-` / `man-` 不同前缀，
 * 因此「两域同名时会不会互相合并 / 覆盖 / 误删 / 污染 delta」**从未被实测过**。
 * 静态只能说明「应该隔离」，本轮用挂载证明。
 *
 * 原要求出处：
 *  - 929.md:864 RA-08；:869「不以 hook 组件夹具替代」⇒ 真实 createRoot + act + 真实点击。
 *  - 1005.md ZC-51/F30（:2376-2389）要求 delta 摘要必须如实反映**来源**列表变化。
 *  - modelSource.ts:779 activeEntries 按 mode 二选一 ⇒ 两域物理隔离的设计意图。
 *  - modelSource.ts:658-660 listDelta(state.entries, parsed.entries) 只比**来源域**。
 *  - modelSource.ts:773-775 removeManualEntry 只 filter manualEntries。
 *  - modelSource.ts:181 key=`manual:m{n}` vs :535 key=`source:{modelId}` ⇒ key 命名空间分离。
 *
 * 假想的缺陷形态（本轮逐条排除，不预设结论）：
 *   D-a 同名时来源行被手工行覆盖（渲染层串了）
 *   D-b 删除同名手工条目时误删来源条目
 *   D-c 同名手工条目的存在/删除被算进来源 delta（多报「新增 1」或「消失 1」）
 *   D-d 删除手工后刷新来源，来源行的 origin / provider / 状态被手工侧污染
 *
 * 边界（如实标注）：
 *   - happy-dom 20.11.6 私有挂载，**非真实浏览器**：无布局、无 CSS、无可见性计算。
 *   - fetch 全替身：**无真实 8790 服务、无回环守卫、无真实上游目录**，catalog 为合成数据。
 *   - 故本轮只能证明**逻辑隔离与请求面**，不能证明真实网络下的行为。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
// 探针被挂到 apps/ui/src/ 下运行，故相对路径是 ./pages/ModelsPage
import { ModelsPage } from './pages/ModelsPage';

let catalog: { revision: string; models: unknown[] } = { revision: '', models: [] };
let fetchCount = 0;
const fetchedUrls: string[] = [];

/** 来源条目的 provider 刻意与手工侧区分：手工不填 provider → 'unknown'。 */
const SOURCE_PROVIDER = 'account:zai-start-plan';

function mk(id: string) {
  return {
    modelId: id,
    displayName: `目录 ${id}`,
    provider: SOURCE_PROVIDER,
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

type RowInfo = { displayName: string; origin: string; provider: string; modelId: string };

/**
 * 按 DOM 单元格解析行，**不依赖行文本的空白切分或前缀正则**。
 *
 * MODEL_COLUMNS（snapshot.ts:234）列序为 displayName / provider / modelId / …，
 * modelId 恒为 cells[2]。origin 徽标在 cells[0] 内（手工录入 / 来源读回），
 * provider 在 cells[1]。行文本里 modelId 与中文**直接粘连**，切分取不出。
 */
function rows(c: HTMLElement): RowInfo[] {
  const table = c.querySelector('table');
  if (!table) return [];
  const out: RowInfo[] = [];
  for (const tr of Array.from(table.querySelectorAll('tbody tr'))) {
    const cells = Array.from(tr.querySelectorAll('td'));
    if (cells.length < 3) continue;
    const first = (cells[0].textContent ?? '').replace(/\s+/g, ' ');
    const rawId = (cells[2].textContent ?? '').trim();
    if (!rawId || rawId === '—') continue; // 空态占位行
    out.push({
      displayName: first.split(' ')[0] ?? '',
      origin: first.includes('手工录入') ? '手工录入' : first.includes('来源读回') ? '来源读回' : '未识别',
      provider: (cells[1].textContent ?? '').trim(),
      modelId: rawId
    });
  }
  return out;
}

function ids(c: HTMLElement): string[] {
  return rows(c).map((r) => r.modelId);
}

function radio(c: HTMLElement, label: string): HTMLInputElement {
  const hit = Array.from(c.querySelectorAll('input[type="radio"]')).find(
    (r) => (r.closest('label')?.textContent ?? '').includes(label)
  );
  if (!hit) throw new Error(`找不到模式 radio「${label}」`);
  return hit as HTMLInputElement;
}

async function clickRadio(c: HTMLElement, label: string): Promise<void> {
  await act(async () => radio(c, label).click());
  await settle();
}

function buttonByText(c: HTMLElement, label: string): HTMLButtonElement {
  const b = Array.from(c.querySelectorAll('button')).find((x) => (x.textContent ?? '').includes(label));
  if (!b) {
    const all = Array.from(c.querySelectorAll('button')).map((x) => (x.textContent ?? '').trim().slice(0, 24));
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

/** 录入手工条目。**只填显示名与 modelId**（两者均必填，带 *）。provider 留空 → 'unknown'。 */
async function addManual(c: HTMLElement, displayName: string, modelId: string): Promise<void> {
  await fillField(c, 'displayName', displayName);
  await fillField(c, 'modelId', modelId);
  await act(async () => buttonByText(c, '录入条目').click());
  await settle(4);
}

async function refreshSource(c: HTMLElement): Promise<void> {
  await act(async () => buttonByText(c, '刷新来源').click());
  await settle(6);
}

/**
 * 点「删除」按钮，**按 (modelId + origin) 双条件定位行**。
 *
 * 本轮同名，手工行与来源行的 modelId 完全一致 ⇒ 只按 modelId 找行会歧义，
 * 必须靠 origin 徽标区分。这正是本轮要证明的隔离点。
 */
async function clickDelete(c: HTMLElement, modelId: string, origin: string): Promise<void> {
  const trs = Array.from(c.querySelectorAll('tbody tr'));
  const target = trs.find((tr) => {
    const cells = Array.from(tr.querySelectorAll('td'));
    const id = (cells[2]?.textContent ?? '').trim();
    const first = (cells[0]?.textContent ?? '').replace(/\s+/g, ' ');
    return id === modelId && (origin === '手工录入' ? first.includes('手工录入') : first.includes('来源读回'));
  });
  if (!target) {
    const dump = trs
      .map((tr) => {
        const cs = Array.from(tr.querySelectorAll('td'));
        return `[${(cs[0]?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 30)}|${(cs[2]?.textContent ?? '').trim()}]`;
      })
      .join(' ');
    throw new Error(`找不到 origin=${origin} 且 modelId=${modelId} 的行。现有行：${dump}`);
  }
  const btn = Array.from(target.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').trim() === '删除'
  );
  if (!btn) throw new Error(`目标行没有「删除」按钮（origin=${origin}, modelId=${modelId}）`);
  await act(async () => (btn as HTMLButtonElement).click());
  await settle(4);
}

describe('RA-08 同 ID 冲突：手工与来源 modelId 完全同名', () => {
  it('K1 同名两域各自独立：写死只见手工那条，动态只见来源两条，互不合并', async () => {
    catalog = { revision: 'rev-1', models: [mk('src-a'), mk('src-b')] };
    const { container, unmount } = await mountPage();
    await refreshSource(container);
    expect(ids(container)).toEqual(['src-a', 'src-b']);

    // 录入手工条目，modelId 与来源 src-a **完全同名**（provider 不填 → 'unknown'）
    await clickRadio(container, '写死固定');
    await addManual(container, '手工同名', 'src-a');

    // 写死模式：只有 1 行，就是手工那条，且 origin 徽标为「手工录入」
    const manualRows = rows(container);
    expect(manualRows).toHaveLength(1);
    expect(manualRows[0].modelId).toBe('src-a');
    expect(manualRows[0].origin).toBe('手工录入');
    expect(manualRows[0].provider).toBe('unknown');
    // 同名没有让来源的两条混进来
    expect(ids(container)).not.toContain('src-b');
    expect(txt(container)).toContain('已录入 1 条');

    // 切回动态：来源两条逐条都在，同名的 src-a 仍是「来源读回」且 provider 未被手工污染
    await clickRadio(container, '动态刷新');
    const dynRows = rows(container);
    expect(dynRows.map((r) => r.modelId)).toEqual(['src-a', 'src-b']);
    const sameIdRow = dynRows.find((r) => r.modelId === 'src-a');
    expect(sameIdRow?.origin, '同名来源行的 origin 不应变成手工录入').toBe('来源读回');
    expect(sameIdRow?.provider, '同名来源行的 provider 不应被手工的 unknown 覆盖').toBe(SOURCE_PROVIDER);
    unmount();
  });

  it('K2 删同名手工条目后刷新来源：来源 ID/状态/摘要不被污染，delta 保持一致', async () => {
    catalog = { revision: 'rev-1', models: [mk('src-a'), mk('src-b')] };
    const { container, unmount } = await mountPage();
    await refreshSource(container);
    await clickRadio(container, '写死固定');
    await addManual(container, '手工同名', 'src-a');

    // 删除**手工那条**同名条目（按 origin 定位，不误碰来源行）
    await clickDelete(container, 'src-a', '手工录入');
    expect(ids(container)).toEqual([]); // 写死域已空
    expect(txt(container)).toContain('已录入 0 条');
    // 摘要是 deleteManual 的提示，不是来源 delta
    expect(txt(container)).toContain('已删除 1 条手工录入条目');

    // 切回动态并**真实刷新来源**：这才是「不被污染」的关键一步
    await clickRadio(container, '动态刷新');
    const fetchBefore = fetchCount;
    await refreshSource(container);
    expect(fetchCount, '刷新必须真实打到 fetch 替身').toBeGreaterThan(fetchBefore);
    expect(fetchedUrls.every((u) => u.includes('/v1/zcc/catalog')), '只允许目录读取').toBe(true);

    // 1) 来源两条逐条仍在（同名的 src-a 没被误删）
    const afterRows = rows(container);
    expect(afterRows.map((r) => r.modelId).sort()).toEqual(['src-a', 'src-b']);
    // 2) 同名来源行的 origin / provider / 状态未被手工侧污染
    const sameIdRow = afterRows.find((r) => r.modelId === 'src-a');
    expect(sameIdRow?.origin).toBe('来源读回');
    expect(sameIdRow?.provider).toBe(SOURCE_PROVIDER);
    // 3) 成功态摘要仍在，且 delta **不得**把同名手工的录入/删除算成来源变化
    const t = txt(container);
    expect(t).toContain('来源读取成功');
    // 锚点依源码定：
    //  ModelsPage:628 `来源条目 {active.length} 条`（手工侧 active=manualEntries）
    //  ModelsPage:540-541 <dt>当前列表条目</dt><dd>{refresh.entries.length}</dd>
    //    ⇒ dt/dd 之间**无空格**，实测文本是「当前列表条目2」，不是「当前列表条目 2」
    //  ModelsPage:544 <dt>列表变化</dt> + describeDelta 文案
    expect(t).toContain('来源条目 2 条');
    expect(t).toContain('当前列表条目2');
    expect(t).toContain('列表变化');
    expect(t, '同名手工录入不得被算成来源新增').not.toContain('新增 1');
    expect(t, '同名手工删除不得被算成来源消失').not.toContain('消失 1');
    expect(t).toContain('与上次一致');
    unmount();
  });

  it('K3 正控：同名手工仍在时来源真消失，delta 仍如实计入消失', async () => {
    catalog = { revision: 'rev-1', models: [mk('src-a'), mk('src-b')] };
    const { container, unmount } = await mountPage();
    await refreshSource(container);
    await clickRadio(container, '写死固定');
    await addManual(container, '手工同名', 'src-a'); // 手工域仍持有同名 src-a
    await clickRadio(container, '动态刷新');

    // 来源真的少一条：src-b 消失
    catalog = { revision: 'rev-2', models: [mk('src-a')] };
    await refreshSource(container);

    // delta 必须计入这次真实消失（正控：排除「delta 恒零」这类假绿实现）
    const t = txt(container);
    expect(t).toContain('来源条目 1 条');
    expect(t).toContain('当前列表条目1'); // dt/dd 无空格，见 K2 注释
    expect(t).toContain('消失 1');
    expect(t).toContain('src-b');
    expect(t).toContain('保持 1');
    // 同名手工 src-a 的存在不应让来源的 src-a 被误判为新增
    expect(t).not.toContain('新增 1');
    expect(ids(container)).toEqual(['src-a']);
    unmount();
  });
});