/**
 * 兼容性探针：happy-dom（只读复用 bbweb-2 的 node_modules）+ 本项目 react 19
 * 能否在本项目 vitest 5 下真正 createRoot 挂载并 act 触发重渲染。
 *
 * 若通过 → 后续可用同一环境做 ModelsPage 真实点击挂载验收。
 * 若不通过 → 如实报告技术缺口，不硬来。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, useState, act } from 'react';
import { createRoot } from 'react-dom/client';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

describe('happy-dom + React 19 + vitest5 兼容性', () => {
  it('DOM 全局存在（document/window/HTMLElement）', () => {
    expect(typeof document).toBe('object');
    expect(typeof window).toBe('object');
    expect(typeof HTMLElement).toBe('function');
    const d = document.createElement('div');
    expect(d.tagName).toBe('DIV');
    document.body.appendChild(d);
    expect(document.body.contains(d)).toBe(true);
  });

  it('react-dom/client 可 createRoot 并 act 触发真实重渲染', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    function Counter() {
      const [n, setN] = useState(0);
      return createElement(
        'button',
        { onClick: () => setN((v) => v + 1) },
        `count=${n}`
      );
    }

    await act(async () => {
      root.render(createElement(Counter));
    });
    const btn = container.querySelector('button') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(container.textContent).toBe('count=0');

    // 真实点击 → 真实重渲染
    await act(async () => {
      btn.click();
    });
    expect(container.textContent).toBe('count=1');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('支持 async act（await Promise 链）—— 刷新链路需要', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    function Async() {
      const [v, setV] = useState('pending');
      return createElement(
        'button',
        {
          onClick: async () => {
            await Promise.resolve();
            setV('done');
          }
        },
        v
      );
    }

    await act(async () => {
      root.render(createElement(Async));
    });
    const btn = container.querySelector('button') as HTMLButtonElement;
    await act(async () => {
      btn.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toBe('done');
    await act(async () => root.unmount());
    container.remove();
  });

  it('支持 window.location（ModelsPage:68 readFixtureScenario 需要）', () => {
    expect(typeof window.location).toBe('object');
    // 只读确认可访问 href，不改它
    expect(typeof window.location.href).toBe('string');
  });
});
