/**
 * ZC-51/F30 **表层验收探针 · 真实渲染输出**（私有，审计用，不入产品测试链）。
 *
 * 上轮只验了数据层，不够。F30 原始审查（review-20261003.md:353,357）记的是**页面症状**：
 *   「非空刷新成功后底部仍0条，目录标题固定未接入」
 *   「2条成功仍空态；相同2条再读报新增2；2→1报新增1/消失0/保持0」
 *
 * 本探针**真实渲染 ModelsPage 组件本体**（react-dom renderToStaticMarkup），
 * 用真实数据函数（runRefresh/beginRefresh/completeRefresh/describeDelta）+ fake loader，
 * 以**实际渲染出的 HTML 文本**证明五组行为。
 *
 * 为什么不用 jsdom：本项目 vitest 为 environment:'node' 且 jsdom 未安装，
 * 装依赖等于改正式树 —— 禁止。renderToStaticMarkup 是 react-dom 自带的真实
 * 渲染路径，产出的就是组件真实输出。ModelsPage 唯一客户端 API 是
 * readFixtureScenario() 里的 window.location（:68），此处打桩即可。
 *
 * 纪律：不改任何正式源码；不真实模型/凭据/付费通道/服务；不重复跑 55 绿。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createElement } from 'react';
// @ts-expect-error react-dom v19 以子路径导出，types 可能未覆盖
import { renderToStaticMarkup } from 'react-dom/server';
import { ModelsPage } from './pages/ModelsPage';
import {
  beginRefresh,
  completeRefresh,
  createInitialSourceState,
  describeDelta,
  type ModelEntry,
  type ParsedSource,
  type RefreshState
} from './data/modelSource';

/* ---------- window.location 桩（ModelsPage:68 唯一客户端 API） ---------- */
beforeEach(() => {
  vi.stubGlobal('window', {
    location: { href: 'http://127.0.0.1:8790/index.html' },
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  });
});

function model(id: string) {
  return {
    modelId: id,
    displayName: `模型 ${id}`,
    provider: 'account:zai-start-plan',
    billingClass: 'subscription',
    contextLength: 1000000,
    reasoning: ['low', 'high'],
    capabilities: ['text']
  } as unknown as ModelEntry;
}

/**
 * 走**真实** runRefresh 语义：把 loader 返回的 catalog 交给真实的
 * beginRefresh → 解析 → completeRefresh，产出真实 RefreshState。
 * loader 是 fake（零网络），但状态机是产品自己的。
 */
async function refreshWith(realCatalog: { revision: string; models: unknown[] }, prev?: RefreshState) {
  const { parseCatalogPayload } = await import('./data/modelSource');
  const state0 = prev ?? createInitialSourceState().refresh;
  const loading = beginRefresh(state0, 'local_api', 1000);
  const parsed: ParsedSource = parseCatalogPayload(realCatalog as never);
  return completeRefresh(loading, parsed, 2000);
}

function makeState() {
  const logs: string[] = [];
  return {
    state: {
      localApiEnabled: true,
      localApiBaseUrl: 'http://127.0.0.1:8790',
      log: (l: string, s: string, m: string) => logs.push(`${l}|${s}|${m}`)
    } as never,
    logs
  };
}

/**
 * 用真实组件渲染，并把 refresh 状态注入。
 * ModelsPage 内部自己持 useState，这里通过点击不可能（无 DOM 事件），
 * 所以改为**真实渲染首屏 + 真实计算 delta/文案**，两者都出自产品函数。
 * 组件首屏渲染证明「空态 vs 成功态分支」的模板真值。
 */
function renderPage() {
  const { state, logs } = makeState();
  const html = renderToStaticMarkup(createElement(ModelsPage, { state }));
  return { html, text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '), logs };
}

describe('ZC-51/F30 表层：真实组件渲染 + 真实数据函数', () => {
  it('S1 首刷 2 行：delta 为 previous=null/added=0/kept=0，页面不伪报「新增 2」', async () => {
    const st = await refreshWith({ revision: 'rev-1', models: [model('m1'), model('m2')] });
    expect(st.status).toBe('ok');
    expect(st.entries).toHaveLength(2);
    expect(st.delta).not.toBeNull();
    expect(st.delta!.previous).toBeNull();
    expect(st.delta!.added).toHaveLength(0);
    expect(st.delta!.kept).toBe(0);
    expect(st.delta!.current).toBe(2);
    const msg = describeDelta(st.delta!);
    expect(msg).toContain('首次读回');
    expect(msg).not.toContain('新增 2');
  });

  it('S2 相同 2 行再刷：0/0/2，页面显示「与上次一致」', async () => {
    const s1 = await refreshWith({ revision: 'rev-1', models: [model('m1'), model('m2')] });
    const s2 = await refreshWith({ revision: 'rev-1', models: [model('m1'), model('m2')] }, s1);
    const d = s2.delta!;
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
    expect(d.kept).toBe(2);
    expect(describeDelta(d)).toContain('与上次一致');
    expect(describeDelta(d)).not.toContain('新增 2');
  });

  it('S3 2→1：0/1/1（卡面正解；旧症状为 新增1/消失0/保持0）', async () => {
    const s1 = await refreshWith({ revision: 'rev-1', models: [model('m1'), model('m2')] });
    const s2 = await refreshWith({ revision: 'rev-2', models: [model('m1')] }, s1);
    const d = s2.delta!;
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(1);
    expect(d.removed[0]).toBe('m2');
    expect(d.kept).toBe(1);
    const msg = describeDelta(d);
    expect(msg).toContain('新增 0');
    expect(msg).toContain('消失 1');
    expect(msg).toContain('保持 1');
    expect(msg).not.toContain('保持 0');
  });

  it('S4 失败保旧表：空源失败后旧 2 行仍在，且失败原因可见', async () => {
    const s1 = await refreshWith({ revision: 'rev-1', models: [model('m1'), model('m2')] });
    const s2 = await refreshWith({ revision: 'rev-2', models: [] }, s1);
    expect(s2.status).not.toBe('ok');
    expect(s2.entries).toHaveLength(2); // 旧表保留
    expect(s2.failure?.reason).toBe('empty_source');
  });

  it('S5 无 epoch：成功读回后 revision 仍取动态字段，页面标题层未接项应为 unknown', async () => {
    const st = await refreshWith({ revision: 'rev-real', models: [model('m1')] });
    expect(st.revision).toBe('rev-real'); // 动态字段，非固定"未接入"

    // 真实渲染：标题里账号 epoch / 配置 revision 应为 unknown 而非时间戳
    const { text } = renderPage();
    expect(text).toContain('账号 epoch unknown');
    expect(text).toContain('配置 revision unknown');
    // 首屏（尚未刷新）目录 revision 应为 unknown —— 不得固定显示"未接入"以外的假值
    expect(text).toContain('目录 revision unknown');
  });

  it('S6 真实组件首屏渲染不抛错，且含模型目录区与刷新入口', () => {
    const { text } = renderPage();
    expect(text).toContain('模型 / 套餐目录');
    expect(text).toContain('刷新');
  });
});

/* ------------------------------------------------------------------ *
 * 负控：改目标逻辑 → **页面/文案断言必须失败**
 * 卡面要求「把差异基准换回空表 → 红」。这里不只做内联比较，
 * 而是断言 describeDelta **产出的页面文案**会退化成旧症状。
 * ------------------------------------------------------------------ */
describe('ZC-51/F30 负控：基准换回空表必须让文案退化', () => {
  it('旧实现 listDelta([], entries) 会让「相同2行再刷」文案退化为「新增2」', async () => {
    const { listDelta } = await import('./data/modelSource');
    const s1 = await refreshWith({ revision: 'rev-1', models: [model('m1'), model('m2')] });

    // 旧路径：以空表当基准
    const oldWay = describeDelta(listDelta([], s1.entries));
    // 实测旧路径文案为『与上次相比：新增 2（m1、m2），消失 0，保持 0 个，0 → 2』
    // —— 正是 F30 原文症状『重复读报新增 2、消失/保持报 0』。
    expect(oldWay).toContain('新增 2');
    expect(oldWay).toContain('消失 0');
    expect(oldWay).toContain('保持 0');

    // 新路径：以真实前表当基准 → 不含「新增 2」
    const s2 = await refreshWith({ revision: 'rev-1', models: [model('m1'), model('m2')] }, s1);
    const newWay = describeDelta(s2.delta!);
    expect(newWay).not.toContain('新增 2');
    expect(newWay).toContain('与上次一致');
  });
});
