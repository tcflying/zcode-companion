# RA-09 真实 `useAppState` 接线 · 补正轮报告

- task: `ra09-realhook` / project: `realhook`
- round: `f0038b70-39be-4981-be9b-022ff01d5273`（**一次通过，零失败 action**）
- validate: `accepted_blocked` / `evidence_valid=true` / exit 0
- 仓库 HEAD: `1558342a0aec04138135a7970aa0b72bc585a9fb`（未提交、未推送）

---

## 一、撤回上一轮的表述（主线程指出的实质错误）

上一轮 `ra09-loggate-audit-20261007` 的 `mountPage` 与 **L4 自定义了 `log`**，内部**自己**写了
`[makeLogEntry(...), ...entries].slice(0, 200)` —— 那是对 `useAppState.ts:40` 的**手工复刻**。

**用它断言 200 条上限属于「以复刻实现证明产品行为」，不成立。**

**撤回：**
1. 「真实 log() 通路连写 250 条，state 恰好截断到 200」——撤回，该 log 不是产品的。
2. 凡依赖该复刻 `log` 的上限结论——一并撤回。

**保留（上一轮仍成立，本轮不重复跑）：**
- LogsPage + **真实 `makeLogEntry`** 的 canary 脱敏结果（L1/L2）
- desktop unavailable 边界与 `refreshLogs` 计数正控（L5/L6/L7）

本轮**只补 L4 那一项**。

## 二、`apps/ui/src` 落盘事实的说明（主线程问项）

**是真实落盘，不是虚拟解析。**

上一轮 runner 用 `Copy-Item` 把探针**实际写入磁盘** `apps/ui/src/__ra09loggate.probe.test.ts`
（因为官方 include 只有 `src/**/*.test.ts`），vitest 跑完后 `Remove-Item` 删除。

**当前状态：已清理干净。** 三项核查：
- `apps/ui/src` 目录扫描 `__ra*` → **0 个**
- `git status --porcelain -- apps/ui` → **空（CLEAN）**
- `git log --all -- 'apps/ui/src/__ra*'` → **无任何提交记录**

即：**已清理但做法本身违规**。

**本轮彻底改掉**：`root` 设为仓库根，`include` 用**绝对路径**直接指向
`review-artifacts/.../private/**/*.probe.test.ts`；runner 每次**先断言
`STRAY_FILES_IN_APPS_UI_SRC=0` 再跑**。该行已随定案 stdout 封存为证据。

## 三、结论

**200 条上限与 `clearLogs` 幂等，确实由产品 `useAppState` hook 自己保证。**
探针只**触发**，不实现。未发现产品缺陷，无需修复候选。

## 四、行为证据（权威）

定案 `365ebc8b-1c7e-49da-9fed-1f2f56307a84`
- pid `632`，exit `0`，`2026-10-07T04:04:50Z → 04:04:52Z`，timeout false
- `STRAY_FILES_IN_APPS_UI_SRC=0`
- `VITEST_EXIT=0` / `CLASS=all_passed` / `Tests 2 passed (2)` / Duration 971ms

| 用例 | 断言要点 | 结果 |
|---|---|---|
| **L4R** | 组件内**直接调用真实 `useAppState()`**；先用真实 hook 自带引导日志（`useAppState.ts:50-61`，含「界面壳已加载」文案）证明**不是空替身**；调**真实** `log()` 连写 250 条 → `state.logs` 被 `useAppState.ts:40` 自己的 `slice(0,200)` 截断为**恰好 200**；保留条目均来自 `src.realhook`；最早那条含 canary 的**已被淘汰**；canary 不在真实 state 也不在 DOM；「界面缓冲 200 / 200」、DOM **200 行**；三通道零调用 | PASS |
| **L4R2** | 真实 `clearLogs()` 清空至 0、空态面板显示、**重复清空幂等不抛错**、零网络 | PASS |

## 五、静态对照：证明「只触发不复刻」（二阶佐证）

action `8bf8aa37-a08e-4a06-bf0c-cc88710ee9a1`，pid 28740，exit 0：

| 检查项 | 值 | 含义 |
|---|---|---|
| `PROBE_HAS_slice_200` | **False** | 探针没有 `slice(0,200)` |
| `PROBE_HAS_slice_any` | **False** | 探针**连任何 `.slice(` 都没有** |
| `PROBE_HAS_makeLogEntry_import` | **False** | 探针不自己造 LogEntry |
| `PROBE_SETS_log_manual` | **False** | 不手工赋 `log` |
| `PROBE_SETS_clearLogs_manual` | **False** | 不手工赋 `clearLogs` |
| `PROBE_IMPORTS_useAppState` | True | 直接 import 产品 hook |
| `PROBE_CALLS_useAppState_hook` | True | 组件内真实调用 |
| `APSTATE_log_slice_200` | **True** | 200 上限确实且仅在产品 hook |
| `APSTATE_clearLogs` | True | 清空也是 hook 原生 |

四个正式文件 hash 与本轮开始前逐字节一致：
`useAppState.ts` `9a1d110e…`、`LogsPage.tsx` `c6cd6d72…`、`logger.ts` `0a957bdd…`。

## 六、替身边界（如实标注）

**被替身的只有 4 项**，且与「log/clearLogs」无关：

1. **`DesktopState`** —— 外部 Electron 主进程依赖，本轮明令不启动 desktop 子进程。
   形状严格照 `useDesktopState.ts` 的接口。
2. `fetch` / 3. `XMLHttpRequest` / 4. `WebSocket` —— 网络替身，非真实网络。

**未被替身**：`useAppState`、`LogsPage`、`makeLogEntry`、`redact` —— 全部真实产品代码。

**IPC**：静态代码区零命中，**未动态验证**，且**未制造不存在的 IPC 接口**
（裁定产物标 `ipc_status: NOT_INSTRUMENTED_STATIC_ONLY`）。

## 七、本轮探针自身缺陷（预验证拦下）

1. **`.mts` 配置文件里的 block 注释**在本轮 root 设定下触发 esbuild
   `[PARSE_ERROR] Unexpected token` —— 改成只用行注释后解决。
   （前几轮 config 也有 block 注释却能过，差别在 root 变了导致加载路径不同。）

## 八、边界（未测项，如实标注）

- happy-dom 20.11.6 **非真实浏览器**
- DesktopState 是替身 ⇒ **真实 desktop 拉取行为未验**
- canary 是**公开合成常量** ⇒ 不能替代真实凭据在真实链路上的泄漏测试
- **不冒称 RA-09 整体通过**：journal 淘汰策略（`:873-876` 主体）、
  密钥 ACL、OS 级加密存储、后台自动上转链路**全部未测**

本轮**未使用 git 写操作、未启动服务、未调用记忆工具、未碰真实凭据与网络**。