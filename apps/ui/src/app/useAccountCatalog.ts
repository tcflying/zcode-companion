/**
 * ZCC-ACCOUNT-EVIDENCE-20261009 · 「账号与权益」的只读目录读取 hook。
 *
 * 网络出口**只有** `localApiSource.ts`（UI04 全产品唯一允许含网络原语的文件）。
 * 本文件不含任何网络原语，只负责生命周期：挂载读一次、切源失效、迟到丢弃。
 *
 * ## 与设置页「连接本机 API」开关的关系（纠偏后的口径）
 *
 * 设置页那个开关的本意是**模型页「动态刷新来源」的外联守卫**：动态刷新会把
 * 条目换成来源读回的列表，属于"选择来源"行为，需要用户显式同意才发生。
 *
 * 总览页的「账号与权益」不是那条路径，因此**不受该开关控制，默认启用**：
 * 它只做一次同源只读 `GET /v1/zcc/catalog`。桌面壳的 `app://` 协议把同源
 * `/v1/` 前缀转发给**壳自己 spawn 的本机 API**，由主进程注入 Bearer——
 * 不出回环、凭据不进浏览器、零模型请求。安全形态与模型页的外联刷新不同，
 * 复用那个开关会让默认态永远停在「未接入 / E0」，等于本轮功能没上线。
 *
 * ## 纪律
 *  1. **零模型请求**：只发 `GET /v1/zcc/catalog`，不请求 `/v1/chat/completions`，
 *     不带任何凭据（token 由桌面壳/本机反代注入，不进浏览器）。
 *  2. **加载中清旧事实**：`loading` 相位 `summary` 恒为 null，
 *     上一次读到的 entitled 不得冒充当前等级。
 *  3. **迟到即失效**：切源 / 卸载之后，在途响应一律丢弃。
 *  4. **失败静默降级**：不弹全局错误、不抛到 React，只把原因码写进状态，
 *     由界面如实显示「未接入 + 原因」。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createLocalApiSourceLoader,
  DEFAULT_LOCAL_API_BASE_URL
} from '../data/localApiSource';
import {
  INITIAL_ACCOUNT_CATALOG,
  loadAccountCatalog,
  type AccountCatalogState
} from '../data/accountCatalog';

export interface UseAccountCatalogOptions {
  /**
   * 是否启用只读读取。**缺省 true** —— 总览页「账号与权益」默认就读。
   *
   * 刻意**不**接设置页的「连接本机 API」开关：那个开关是模型页动态刷新
   * 来源的外联守卫，与总览这条同源只读通道不是一回事（见文件头）。
   * 保留该参数只为测试与未来可能的显式关闭路径。
   */
  enabled?: boolean;
  /** 本机 API base URL（同源或回环 origin）。只存在本机内存。 */
  baseUrl?: string;
}

export interface AccountCatalogHandle extends AccountCatalogState {
  /** 手动重读一次。失败即 `failed`，**不保留**旧 summary。 */
  refresh: () => Promise<void>;
}

export function useAccountCatalog({ enabled = true, baseUrl }: UseAccountCatalogOptions = {}): AccountCatalogHandle {
  const effectiveBaseUrl = baseUrl ?? DEFAULT_LOCAL_API_BASE_URL;
  const [catalog, setCatalog] = useState<AccountCatalogState>(INITIAL_ACCOUNT_CATALOG);

  /**
   * 迟到失效守卫：每次刷新、切源、关开关、卸载都会让当前 token 失效。
   * 在途响应回来时 token 已不匹配 → 直接丢弃，旧事实不得冒充当前。
   */
  const tokenRef = useRef(0);
  useEffect(() => () => { tokenRef.current += 1; }, []);

  // base URL 变化 = 换源：立即失效在途读取并清空事实。
  const sourceRef = useRef(effectiveBaseUrl);
  useEffect(() => {
    if (sourceRef.current === effectiveBaseUrl) return;
    sourceRef.current = effectiveBaseUrl;
    tokenRef.current += 1;
    setCatalog(INITIAL_ACCOUNT_CATALOG);
  }, [effectiveBaseUrl]);

  // 开关关闭 = 零网络：状态打回 disabled，不保留任何旧事实。
  const enabledRef = useRef(enabled);
  useEffect(() => {
    if (enabledRef.current === enabled) return;
    enabledRef.current = enabled;
    tokenRef.current += 1;
    setCatalog(INITIAL_ACCOUNT_CATALOG);
  }, [enabled]);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setCatalog(INITIAL_ACCOUNT_CATALOG);
      return;
    }
    const token = ++tokenRef.current;
    setCatalog({ phase: 'loading', summary: null, failure: null, loadedAt: null });
    const result = await loadAccountCatalog(createLocalApiSourceLoader({ baseUrl: effectiveBaseUrl }));
    if (token !== tokenRef.current) return; // 迟到：丢弃
    if (result.ok) {
      setCatalog({ phase: 'loaded', summary: result.summary, failure: null, loadedAt: Date.now() });
      return;
    }
    setCatalog({
      phase: 'failed',
      summary: null,
      failure: { code: result.code, message: result.message, at: Date.now() },
      loadedAt: null
    });
  }, [enabled, effectiveBaseUrl]);

  // 挂载即读一次（只读 GET，零模型请求），不依赖设置页的模型页外联开关。
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!enabled) {
      tokenRef.current += 1;
      setCatalog(INITIAL_ACCOUNT_CATALOG);
      return;
    }
    void refreshRef.current();
  }, [enabled, effectiveBaseUrl]);

  return useMemo(() => ({ ...catalog, refresh }), [catalog, refresh]);
}