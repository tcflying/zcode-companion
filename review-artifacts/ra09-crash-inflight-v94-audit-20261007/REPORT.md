# RA-09 · 崩溃遗留 `in_flight` 的跨进程承接（父审 v94 指出的缺口）

- 条款出处：`929.md:845` `:853` `:854` `:875`（RA-06 / RA-09）
- 仓库：`G:\zcode-project\zcode-companion`（HEAD `1558342a…`，未提交未推送）
- 证据 round：`b69423dd-c2c3-4dca-9166-799bc4857640`
  · task `business-v94-20261007` · **validate `accepted_success` / `evidence_valid: true` / exit 0**
- 前两轮 round `44d9e426`、`c4a7e492` 原样保留，未被覆盖

> **措辞更正（父审 v95）**：本报告此前把 T13a 描述为「新进程…已测」，**不准确**。
> `startApi`（→`createApiServer`）与 `j2`（→`createOperationJournal`）的构造
> **全部发生在同一个测试进程内**，没有 `spawn`、没有 `kill`、没有真实 OS 冷启动。
> 准确表述是：**新实例重建 + 持久化故障现场模拟**。
> 下文所有「新进程」字样均已按此更正；结论范围不变。

---

## 一、主审的反驳成立，我上轮的理由站不住

我上一轮把 `in_flight` 排除在会话闸门外，理由是「别冻结正常并发」。那是**同进程**场景。
但崩溃 / 终止本应用子进程后遗留的 `in_flight`，在新进程里：

- 那个在途请求**根本不存在**；
- **没有任何代码路径**会把一条从磁盘载入的 `in_flight` 改成终态。

所以它的真实语义就是「已提交上游、结果不可知」。若仍按 `in_flight` 处理：不可淘汰（占死容量）、
会话闸门只看 `unknown` 判不到它 ⇒ 「终止本应用子进程后重开零重发」（`:853`）被直接穿透。

**并发契约与这条并不冲突**：同进程活着的 `in_flight` 仍不冻结并发（下面 T13c 钉住）。

## 二、最小修复：只在**载入时**承接

`journal-store.ts` 新增 `recoverInFlightFromPreviousProcess(entries)`，在 `loadJournal`
读盘后把上一进程遗留的 `in_flight` 改写为 `unknown`，并记 `outcome` 说明来源。

**只作用于载入** ⇒ 同进程 `reserve` 造出来的 `in_flight` 完全不受影响。

### 承接**绝不进 `problems`**（这是本轮最关键的细节）

`problems` 非空 ⇒ `poisoned` ⇒ **拒绝一切新发**。若把承接当「问题」上报，一次崩溃就把整个
发送功能永久冻死。承接是**正常语义**，因此单列 `recovered()` 返回，`problems()` 保持为空。
T13b 把这一点钉死。

### 语义后果（有意为之）

`in_flight → unknown` 后，该记录**永久不可淘汰**（`:854`「得不到则保留 unknown 及预算占用」）。
这是条款要求，不是副作用。

## 三、T13 四条用例（真实 HTTP + 假 driver + `os.tmpdir` 临时 data）

| 用例 | 断言 |
|---|---|
| **T13a** | 用产品自己的 `createOperationJournal` 真实持久 `reserve` 出 `in_flight`（**不 settle** = 崩溃现场），并先确认**盘上写的确实是 `in_flight`**（证明测的是「读回来」而非提前改好）；**在同一测试进程内**新建 server / journal 实例（`startApi` 与 `j2`），用**同会话 + 新幂等键**发请求 ⇒ 502 `session_locked:true`、`probe.calls.n=0`、`driverCalls=0` |
| **T13b** | `problems()` 为空、`poisoned()=false`、`recovered()` 有说明、状态变为 `unknown` |
| **T13c** | 反向对照：同一进程内活着的 `in_flight` **不**冻结并发（驱动器只挂住第一次调用），第二条同会话不同键正常 200，`calls` 由 1 涨到 2 |
| **T13d** | 边界：旧记录**没有** `sessionKey` ⇒ `lookupSessionUnknown` 返回 `undefined`，无法归属会话 |

### 连带修正的过时断言

T8-2 原本期望载入的 `in_flight` 给出 `operation_in_progress`。承接后它已是 `unknown`，
理由应是 `operation_outcome_unknown`；`operation_in_progress` 现在只适用于**同进程**活着的
在途。两种语义拆开分别覆盖——这是断言跟着**正确语义**改，不是把红改成绿。

## 四、证据

round `b69423dd`，全部 action 真实 exit 0：

| Action | 内容 | pid | exit | UTC |
|---|---|---|---|---|
| `730c27c1` | 全仓 typecheck | 52956 | 0 | 06:44:37Z |
| `feba725a` | **集成红绿 38 条** | 30016 | 0 | 06:44:37Z |
| `0daeecac` | 既有回归 7 文件 | 65644 | 0 | 06:44:39Z |

A2：`Tests 38 passed (38)` / `CLASS=all_passed` / `STRAY_PROBE_FILES_IN_FORMAL_SRC=0`
A3：`Test Files 7 passed (7)` / `Tests 250 passed (250)`

### 变异验证（区分力）

把 `recoverInFlightFromPreviousProcess` 短路为直接返回原 `entries`：

```
Tests  4 failed | 34 passed (38)
FAIL T8-2 / T13a / T13b / T13d
```

T13c 保持绿（它本就不依赖跨进程承接）。随后按 sha256 校验还原，`RESTORED_OK=True`。

## 五、完整 diff（含未跟踪文件，未做任何 git 写）

| 文件 | 行数 |
|---|---|
| `diff-1-tracked.patch` | 763（`packages/api` + `apps/desktop`，含 `auth.ts`） |
| `diff-2-tests.patch` | 152（5 处既有测试钉子） |
| `diff-3-new-journal-store.patch` | 437（**未跟踪**的 `packages/api/src/journal-store.ts`，`--no-index`） |

## 六、未验边界

1. **旧记录无 `sessionKey`**：引入 sessionKey 之前落盘的记录没有该字段，会话闸门无从归属。
   T13d 已把这一缺口钉成可复核事实。**因此不能声称会话级保护是完整保障**——只有新写入的记录具备会话维度。
   历史兼容补写需父审裁定是否另开一轮。
2. 客户端不发 `x-zcc-*` ⇒ 返回 `null`，闸门不判定（缺身份不假造），危害面未测。
3. **未做真实 desktop 冷启动、未终止真实子进程**：跨进程承接用「先 reserve 不 settle、再新开进程」
   模拟崩溃现场（遵 v92 不启 8791、不探无关进程、不动真实进程）。
4. T13c 的并发对照是同进程构造，不是真实多客户端并发压测。
5. 跨重启**原样重放正文未实现**；本轮保证的是不重复投递。
6. 全量套件未签收：8791 被**主上正在运行的 `ZCodeCompanion.exe`** 占用；**未 kill、未改端口**。
7. RA-09 `:875` 的 secret canary、官方秘密不入采集管道，`:876` 全套证据要求，
   以及 RA-06 的**精确取消 / 权威终态核销**（`:854` 明写「仅 unknown 保留正确是保护机制通过，
   **不是整个恢复/清场门通过**」）——**本轮全部未测**。

> 本轮不把 38/250 折算成业务进度：那是测试计数，不是条款完成度。