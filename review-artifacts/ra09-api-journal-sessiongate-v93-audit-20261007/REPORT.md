# RA-09 · 会话级闸门（父审 v93 指出的唯一原需求缺口）

- 条款出处：`929.md:345` `:347` `:853` `:916` `:875`
- 仓库：`G:\zcode-project\zcode-companion`（HEAD `1558342a…`，未提交未推送）
- 证据 round：`c4a7e492-f54d-4074-9536-ac26c543b990`
  · task `business-v93-20261007` · **validate `accepted_success` / `evidence_valid: true` / exit 0**
- 上一轮 round `44d9e426`（journal 联动本体）保持原样，未被本轮覆盖

---

## 一、缺口确认：主上说得对

`lookupScope` 只按**幂等作用域**查。而 `auth.ts:323-325` 的 `resolveIdempotencyOptIn`
在 `Idempotency-Key` 在场时**立刻 return `kind:'key'`**，两个 `x-zcc-*` 会话头
**根本没被读**。

于是外部客户端失联后的**默认**行为——换一个 `Idempotency-Key` 重试——换了一个作用域，
作用域级守卫打不中，同会话那条「结果不可知」被直接穿透，又发了一次上游。

条款原话：
- `:345`「不能…用新input绕同会话未决保护」
- `:347`「外部客户端默认新key重试也不能穿透同会话unknown保护」
- `:853`「尝试同key、新key和同session新输入，均不得新增dispatch」
- `:916`「同sessionunknown用新key发请求仍拒」

## 二、身份契约：**复用既有，不新造**

| 维度 | 来源 |
|---|---|
| 会话头 | `auth.ts:251-252` `x-zcc-client-id` / `x-zcc-session-id` |
| 形状闸门 | `auth.ts:274` `sanitizeIdempotencyToken`（`/^[A-Za-z0-9._:-]{1,128}$/`） |
| 缺省维度 | `default-client` / `default-session`（抽成常量，与 `resolveIdempotencyOptIn` 共用，杜绝两边漂移） |
| 会话键 | 复用 `auth.ts:236` `idempotencyScope(clientId, sessionId, keyFingerprint)`，**不含正文** |

新增 `auth.ts` `resolveSessionIdentity(headers, keyFingerprint)`：**独立于幂等 opt-in 解析**，
不读 `Idempotency-Key`。两个 `x-zcc-*` 头都没有 ⇒ 返回 `null`。

**缺身份就返回 `null`，绝不假造**：替它编一个会话号，会话锁定就变成全局冻结，
把所有互不相干的客户端一起冻住。`null` 的语义是「本端无从判断」，不是「没有风险」。

## 三、业务接线（最小根因修复）

```
auth.ts        + resolveSessionIdentity / SessionIdentity / DEFAULT_* 常量
journal-store  + JournalEntry.sessionKey
               + reserve({..., sessionKey})
               + lookupSessionUnknown(sessionKey)  ← 只看 unknown
server.ts      runChat：在**任何登记与发送之前**
                 const session = resolveSessionIdentity(req.headers, identity.keyFingerprint);
                 if (session !== null && journal.lookupSessionUnknown(session.sessionKey))
                    throw ApiError('upstream_outcome_unknown', …session_locked:true)
               被拒请求：不写幂等表、不写 journal、驱动器零调用
               reserve 时把 sessionKey 随记录落盘 ⇒ 跨重建同样生效
```

**只看 `unknown`、不看 `in_flight`**：条款的会话锁定针对「已发出、结果不可知」。
把在途也算进去会冻住同一会话的正常并发；同一键的并发重复另有 `idempotency_in_progress` 兜底。

**与上一轮守卫的分工**（两者都必要，不重复）：

| 守卫 | 维度 | 作用域键变化时 |
|---|---|---|
| 上一轮 `lookupScope` | 幂等作用域（key 维度） | 换键后**失效** |
| 本轮 `lookupSessionUnknown` | 会话身份 | 换键后**仍生效** |

## 四、证据

round `c4a7e492`，全部 action 真实 exit 0：

| Action | 内容 | pid | exit | UTC |
|---|---|---|---|---|
| `2753a9ad` | 全仓 typecheck | 41796 | 0 | 06:34:30Z → |
| `f437a0f4` | **集成红绿 34 条** | 64864 | 0 | 06:34:30Z |
| `4fb03fda` | 既有回归 7 文件 | 18916 | 0 | 06:34:32Z |

A2 stdout：`Tests 34 passed (34)`、`CLASS=all_passed`、`STRAY_PROBE_FILES_IN_FORMAL_SRC=0`。
A3 stdout：`Test Files 7 passed (7)`、`Tests 250 passed (250)`。

### T12 五条（新增）

| 用例 | 断言 |
|---|---|
| T12a | 同会话换新键 + 换输入 ⇒ 502 `session_locked:true`、`driver_called:false`、`driverCalls` **不增**；连拒三次 |
| T12b | 跨重建（同目录重开）后换新键仍 502、**驱动器零调用** |
| T12c | 全部 `done` 的正常会话换新键照常 **200** 且真发两次（防误伤） |
| T12d | 另一会话 `driverCalls` 由 1 涨到 2、detail 无 `session_locked` ⇒ **会话级而非全局冻结** |
| T12e | 缺 `x-zcc-*` ⇒ `null`；有会话头时与 identity 形态算出**同一个** `sessionKey` |

### 变异验证（区分力，非 gate action）

把 `server.ts` 的 `resolveSessionIdentity(...)` 短路为 `null` 后重跑：

```
Tests  2 failed | 32 passed (34)
FAIL  T12a 同会话换新键 …  AssertionError: expected 200 to be 502
FAIL  T12b 跨重建 …        AssertionError: expected 200 to be 502
```

红因正是「同会话换新键真的投递出去了」。T12c/T12d/T12e 保持绿——它们是对照，
本就不该对闸门敏感。随后按 sha256 校验还原，`RESTORED_OK=True`。

**这就是「测试绿」与「测试有区分力」的差别**：没有这次变异，34/34 只能证明没崩。

## 五、完整 diff（含未跟踪文件，未做任何 git 写）

| 文件 | 内容 |
|---|---|
| `diff-1-tracked.patch` | 763 行 · `packages/api` + `apps/desktop`（含 `auth.ts` 新增） |
| `diff-2-tests.patch` | 152 行 · 5 处既有测试钉子 |
| `diff-3-new-journal-store.patch` | 389 行 · **未跟踪的新文件** `packages/api/src/journal-store.ts` |

未跟踪文件用 `git diff --no-index -- /dev/null <file>` 取得（exit 1 = 两文件不同，属预期），
**没有用** `git add -N` 或任何其它 git 写操作。

## 六、未验边界

1. **未做真实 desktop 冷启动**。默认路径链是**源码接线**成立，非实机验证
   （父审 v92 明令不启 8791、不探无关进程）。
2. 跨重启**原样重放正文仍未实现**（需持久化正文，与「journal 不存正文」冲突）；
   本轮保证的是不重复投递，不是跨重启重放。
3. 会话闸门**不挡 `in_flight`**（有意取舍，见上）。
4. 客户端**不发** `x-zcc-*` 时拿不到会话级保护 —— **已知覆盖缺口**，危害面未测。
5. 全量既有套件未签收：`official-tap-fidelity` 要求 8791 无监听，该端口由主上正在运行的
   `ZCodeCompanion.exe` 占用；**未 kill 该进程、未改端口**。
6. RA-09 `:875` 的「secret canary 无泄漏」「官方秘密不曾进入采集管道」，
   及 `:876` 的扫描规则/退出码/脱敏导出 hash/IPC 文件访问审计/实际预览交互，
   **本轮全部未测。不得据本轮结论宣称 RA-09 通过。**

> 交付里不把「34 条 / 250 条」折算成业务进度：那是测试计数，不是 929.md 条款完成度。