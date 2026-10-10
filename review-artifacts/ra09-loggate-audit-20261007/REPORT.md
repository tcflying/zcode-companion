# RA-09 日志页脱敏 / 200 上限 / desktop unavailable · 私有挂载验收报告

- task: `ra09-loggate` / project: `loggate`
- round: `0ba6241f-ca01-4bae-a128-09df1e78831e`（**一次通过，零失败 action**）
- validate: `accepted_blocked` / `evidence_valid=true` / exit 0
- 仓库 HEAD: `1558342a0aec04138135a7970aa0b72bc585a9fb`（未提交、未推送）

## 正式源码零改动（五个 allowlist 文件本轮前后逐字节一致）

| 文件 | SHA256 |
|---|---|
| `apps/ui/src/pages/LogsPage.tsx` | `c6cd6d7214b0b7368c68809fe39ae6d94ed216043a7cf024a363bbc4eeb86804` |
| `apps/ui/src/lib/logger.ts` | `0a957bdd2bcd2fb8af0f3eb0d849d336b8fafff7bcb138a0c7c0a9ec86` |
| `apps/ui/src/lib/redact.ts` | `31beadca0bf54ced822c1741ccd48d29692fb9323bcd4df2aded6e5557ce12a9` |
| `apps/ui/src/app/useAppState.ts` | `9a1d110ee5e47a4307ef604020551a8e6e24bc52ec8fc9867fa70a6416254be8` |
| `apps/ui/src/app/useDesktopState.ts` | `5767d17fd1cdf82db212d48b9d760f8cce8f7589fcc0d9429a48b32794af3ab9` |

`git status --porcelain -- apps/ui` 空（CLEAN）。

## 需求出处

- `929.md:444` UI 日志不得出现 token/API-key/Authorization，**日志写入前脱敏**
- `929.md:373` 日志/操作历史不得无限增长
- `929.md:875` 通过**合成 secret canary** 验证不泄漏
- `LogsPage.tsx:38-42` `runSelfCheck` 把含凭据的 `SELF_CHECK_RAW` 交给 `state.log`
- `logger.ts:28-31` `makeLogEntry` 对 source 与 message 强制 `redact()`
- `useAppState.ts` `log()` 内 `slice(0, 200)` ⇒ 200 条上限
- `LogsPage.tsx:62` `refreshLogs` 按钮 `disabled={!desktop.available}`

## 是否重复旧证据

**否。** 既有 `review-artifacts/ui01/13-logs-redaction-selfcheck.png` 是**截图 + 人工看像素**，
不是程序化断言，且未覆盖 200 条上限与 desktop unavailable 的 dispatch 面。本轮全为新覆盖。

## 结论

**日志页脱敏自检、200 条上限、desktop unavailable 边界全部成立。未发现产品缺陷，无需修复候选。**

## 行为证据（权威）

定案 `5e6daa70-f642-431e-85bf-513f2f2d7743`
- pid `25624`，exit `0`，`2026-10-07T03:53:18Z → 03:53:20Z`，timeout false
- `VITEST_EXIT=0` / `CLASS=all_passed` / `Tests 7 passed (7)` / Duration 1.45s

| 用例 | 断言要点 | 结果 |
|---|---|---|
| **L1** 自检 canary 写前脱敏 | 走**真实 `makeLogEntry`** 写 3 条；state 的 JSON dump 与整页 DOM 均不含 apiKey / Bearer / credential 三个 canary 原值、不含 `Bearer eyJ` 片段、含 `[REDACTED]`；表确有 **3 行**（证明未被过滤掉） | PASS |
| **L2** 筛选/清空/重复清空一致 | 「仅 WARN/ERROR」剩 2 行且 canary 不现；回「全部」= 3 行；清空后 state 空、表空态文案「空状态：缓冲中还没有日志」；**重复清空两次幂等不抛错** | PASS |
| **L3** 预置 250 条 | 页面如实显示 **250 行**（未经 log() 截断），canary 仍不泄漏 | PASS |
| **L4** 真实 log() 连写 250 | state **恰好截断到 200**、页面显示「界面缓冲 200 / 200」、DOM **200 行**；最早那条带 canary 的**已被淘汰**，保留的 state 与 DOM 均不含 canary；零网络 | PASS |
| **L5** desktop unavailable | 「拉取最新」`disabled`、面板如实显示「桌面壳未接入」「没有子进程可跟随」；直接点该 disabled 按钮后 fetch/XHR/WS 仍为基线、`callLog` 空、`refreshLogsCalls` **为 0** | PASS |
| **L6** 自检与拉取并存 | 自检可用（写入 3 条）而拉取仍 disabled；自检**不触发** `refreshLogs`（计数 0） | PASS |
| **L7** 反向有效性正控 | `available=true` 时同一按钮可点，两次点击后 `refreshLogsCalls` **依次为 1、2** | PASS |

**L7 是本轮特意加的正控**：没有它，L5/L6 的「计数仍为 0」无法排除「计数器根本没接线」
这种恒真断言。加上之后，L5/L6 的零计数**才有区分力**。

## 静态对照（二阶佐证）

action `614377bb`，pid 57908，exit 0：

- 剔除注释与**脱敏规则说明文案**后，日志页代码区零 `fetch`/`XMLHttpRequest`/`WebSocket`/`ipcRenderer`
- `makeLogEntry_redacts_message=True`、`redacts_source=True`、`is_only_writer=True`
- 200 上限 `app_slice_200=True` —— 位于 **`useAppState.log` 的 `slice(0,200)`**，不在页面
- 页面 `/ 200` 字面与 `disabled={!desktop.available}` 均在

## 排除的缺陷形态

- canary 原值留在 React state — L1/L4 双重断言
- canary 原值出现在 DOM — L1/L2/L3/L4 每次交互后都断言
- 淘汰机制把含凭据的旧条目留到最后 — L4 显式验证最早那条被淘汰
- desktop 不可用时点拉取仍能触发 — L5（含 L7 正控保证断言非恒真）
- 自检按钮误触发拉取 — L6
- 日志页发网络请求 — L1–L6 全程计数恒 0

## 边界（如实标注，未测项）

- happy-dom 20.11.6 **非真实浏览器**（无布局/CSS/可见性）
- **不启动真实 desktop 子进程、不读取真实日志、不接触任何真实凭据**
- desktop 替身可用态点击 `refreshLogs` 后网络仍为零 ⇒ **未验证真实拉取行为**
- canary 为**公开合成常量**，不能替代真实凭据在真实链路上的泄漏测试
- **不冒称 RA-09 整体通过**：journal 淘汰策略（`:873-876` 主体）、密钥 ACL、
  OS 级加密存储、后台自动上转链路**全部未测**

## 本轮过程：预验证拦下 3 处探针自身缺陷（零失败 action）

1. **重叠 act()** — `clickButton → settle → rerender` 三次 `await` 各开一个 `act()`，
   React 19 报 `You seem to have overlapping act() calls`，渲染不提交 ⇒
   **7 用例全红、连按钮都找不到**。合并为 `clickAndSettle`（单 act 内完成点击+冲刷+重渲染）解决。
2. **漏写 await** — L1 的 `m.rerender()` 未 `await`，Promise 未落地就断言。
3. **静态检测假红** — 全文件搜 `apiKey`/`Bearer`/`sk-` 会命中 `LogsPage.tsx:10-15`
   与 `:224-236` 的**脱敏规则说明文案**，必须先剔除注释与字符串再搜。

另外按主线程「不把固定 0 当实测」的要求：初版写的 `refreshLogsCalls` **从未被任何断言消费**，
与上一轮 `ipcCount` 同属恒 0 空壳。本轮补 L7 正控使其可证增长，
并把裁定产物里 IPC 标为 `ipc_status: NOT_INSTRUMENTED_STATIC_ONLY` —— **不制造不存在的 IPC 接口**。