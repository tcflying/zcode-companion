/**
 * I10 桌面模块的测试夹具助手。
 *
 * 为什么要有这么一个小文件：本仓的 `typecheck:checkjs` 门把 `tests/**` 里**每一个**
 * `.mjs` 都按 `checkJs: true` 编译。被测模块大量使用
 * `{ ok: true, ... } | { ok: false, reason: string }` 这种**判别联合**返回，
 * 断言它们必须先把联合窄化；而「窄化 + 失败时报出真实原因」这两件事每次重写一遍
 * 只会让断言变长、变松。所以收在这里，各测试文件统一用。
 *
 * 这里的每个助手都**只会让断言更严**：失败时抛出的是被测模块给出的原因码，
 * 而不是一句「expected undefined」。
 */

/**
 * 断言成功分支并窄化。失败时抛出被测模块自己的 `reason` / `code`。
 * @template T
 * @param {{ ok: true, value: T } | { ok: false, reason: string }} result
 * @returns {{ ok: true, value: T }}
 */
export function mustValue(result) {
  if (!result.ok) throw new Error(`期望成功分支，实际被拒：${result.reason}`);
  return result;
}

/**
 * 断言 `buildUpstreamRequest` 那类 `{ok:true,url,init} | {ok:false,status,reason}`。
 * @param {{ ok: true, url: string, init: Record<string, unknown> } | { ok: false, status: number, reason: string }} result
 * @returns {{ ok: true, url: string, init: Record<string, unknown> }}
 */
export function mustForward(result) {
  if (!result.ok) throw new Error(`期望转发，实际被拒：${result.reason}（status=${result.status}）`);
  return result;
}

/**
 * 断言失败分支并返回原因码。
 * @param {{ ok: boolean, reason?: string, code?: string, status?: number }} result
 * @returns {string}
 */
export function mustReject(result) {
  if (result.ok) throw new Error(`期望被拒，实际成功：${JSON.stringify(result)}`);
  return result.reason ?? result.code ?? 'UNKNOWN';
}

/**
 * 取路由判定的 `reason`；没有 reason 说明没被拒，这本身就是失败。
 * @param {{ kind: string, reason?: string }} decision
 * @returns {string}
 */
export function reasonOf(decision) {
  if (decision.reason === undefined) {
    throw new Error(`期望一条拒绝原因，实际判定为 kind=${decision.kind}`);
  }
  return decision.reason;
}

/**
 * 取静态分支解析出的绝对路径。
 * @param {{ kind: string, pathname?: string }} decision
 * @returns {string}
 */
export function pathnameOf(decision) {
  if (decision.pathname === undefined) {
    throw new Error(`期望一条静态路径，实际判定为 kind=${decision.kind}`);
  }
  return decision.pathname;
}

/**
 * 取数组第 n 项并在越界时给出可读失败（`noUncheckedIndexedAccess` 下的显式收口）。
 * @template T
 * @param {readonly T[]} items
 * @param {number} index
 * @returns {T}
 */
export function at(items, index) {
  const item = items[index];
  if (item === undefined) throw new Error(`下标 ${index} 越界（长度 ${items.length}）`);
  return item;
}
