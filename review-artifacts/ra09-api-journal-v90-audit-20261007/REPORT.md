# RA-09 · `packages/api` 操作 journal 联动（父审 v90/v91/v92）

- 需求出处：`G:\zcode-project\zcode-dev\929.md:875`
  「journal不足拒新发而非丢unknown」
- 仓库：`G:\zcode-project\zcode-companion`
- 基线 HEAD：`1558342a0aec04138135a7970aa0b72bc585a9fb`（未提交、未推送）
- 证据 round：`evidence/44d9e426-11fd-4693-8094-e8565feb7bf0`
  · task `business-v90-20261007` · **validate `accepted_success` / `evidence_valid: true` / exit 0**

---

## 一、父审三条反例：核实结论与正解

父侧反例 action `dee2ff14-7284-4427-81c4-ce2d4cd7cb09`（pid 38752，exit 0，
UTC 05:52:59，快照 `38952d55…`，裁定 `companion-journal-diagnosis.json`
sha256 `b10c4d79…`）。我**逐条复核了源码**，三条全部成立，不是误报。

| # | 反例 | 根因（我方原实现） | 本轮正解 |
|---|---|---|---|
| 1 | 损坏 JSON 被 reserve 覆盖且 `ok:true` | `loadJournal` 返回 `problems[]`，但 `createOperationJournal` 只取 `.entries`，`problems` **被丢弃** → entries=[] → 下次 `persist()` 直接覆盖坏原件 | 载入期任一问题 ⇒ 实例进入 `poisoned`，`reserve` 一律返回 `journal_corrupt`；**原件一个字节都不动**。新增 ENOENT 豁免（首启不算损坏） |
| 2 | 同 operationId 的 unknown 再次 reserve 返回 `ok:true` | `reserve` 只做 `some()` 命中判断，**不看 state** | 按状态分流：`unknown` → 拒（`operation_outcome_unknown`）、`in_flight` → 拒（`operation_in_progress`）、仅 `done`/`failed` 走幂等返回 |
| 3 | 淘汰后写盘失败，内存旧 `done` 丢失而磁盘仍在 | `entries = [entry, ...survivors]` **先提交内存**，失败只 `filter` 掉新条目 | `persist(list)` 只写传入候选，**落盘成功后才 `entries = next`**；`settle` 同理 |

---

## 二、父审另外两条

**结算遗漏 `upstream_timeout`**：原写法 `err.code === 'upstream_outcome_unknown' ? 'unknown' : 'failed'`
只认一个码名，把同样属于 `outcome_unknown` 的 `upstream_timeout` 记成了 `failed`（可淘汰）——
那条本该永久保留的「结果不可知」会被容量压力静默清掉，正是条款禁止的事。
现改为读错误表的投递语义 `err.delivery === 'outcome_unknown'`，调用方不再维护码名名单。

**默认接线与跨重启幂等**：

```
app.getPath('userData')                       Electron 既有配置路径（main.cjs:102）
  └─ settingsFilePath() → <userData>/settings.json      settings.cjs:251
  └─ path.dirname(settingsFile) = journalDir             main.cjs:111   ← 既有路径，非新造
      ├─ 桌面主进程自用 journal.cjs → <userData>/journal.json
      └─ spawn-spec.cjs:53 → buildChildEnv → env['ZCC_JOURNAL_DIR']      proxy-manager.cjs
          └─ start-api.mjs parseEntryOptions → options.journalDir
              └─ createApiServer({journalDir}) → createOperationJournal
                  └─ <userData>/api-operations-journal.json             ← 文件名刻意不同
```

跨重启幂等：journal 额外记 `scope` + `bodyHash`（**只存哈希，不存正文**）。重启后同键：

| 持久状态 | 响应 | 驱动器 |
|---|---|---|
| `done` / `failed` | 409 `idempotency_replay_unavailable` | 0 次 |
| `unknown` / `in_flight` | 502 `upstream_outcome_unknown` | 0 次 |
| scope 相同但 `bodyHash` 不同 | 409 `idempotency_conflict` | 0 次 |
| 换键 | 200 正常发送 | 1 次（对照） |

---

## 三、本轮抓到的真实缺陷（含我自己造成的）

1. **客户端中途取消被结算成 `done`**（既有缺陷）。`writeSseStream` 在 `clientGone` 时
   **正常 return 不抛错**，`runChat` 于是继续 `settle('done')`——但驱动是被
   `events.return()` 中途掐断的，上游完没完成**不知道**。现返回 `'client_gone'`
   并结算 `unknown`（`outcome: client_disconnected_midstream`）。
2. **SSE 收尾期断开被漏判**（既有缺陷）。只判循环内的 `clientGone`，而客户端在
   「上一轮写完之后、驱动器产出收尾那段时间」断开时循环会**正常走完**，
   `clientGone` 始终 false ⇒ 对一个早已不存在的连接记 `status=200`。现循环结束后
   **复查** `res.destroyed`。
3. **`ZCC_JOURNAL_DIR` 未登记进入口闭集**（我上一轮引入）。`start-api.mjs` 对任何未登记的
   `ZCC_*` 键**拒绝启动**，所以「设了就起不来」。已登记。
4. **两份 journal 会互相抹掉**（我本轮引入）。宿主把 API 子进程指向 `<userData>` 后，
   桌面 `journal.json` 与 API journal 变成同目录同文件、两个独立进程各持全量列表整体
   覆盖 ⇒ **后写者静默抹掉先写者**。已拆分文件名为 `api-operations-journal.json`。
5. **跨重启守卫顶掉 F02 淘汰语义**（我本轮引入，且被既有测试抓到）。
   `tests/unit/api-replay-budget-inflight.test.mjs` 从 200 退化成 409。
   根因：守卫对**所有**持久状态都拦截，而 F02 明确要求「已结算条目被重放预算淘汰后，
   同键作为**全新操作**重新执行」。现用 `journal.persistent()` 把守卫限定在
   「确实落盘」时启用——没有 journalDir 就没有跨重启这回事，行为与加 journal 之前
   **逐字一致**。复测 204/204 绿。

---

## 四、证据

round `44d9e426`，全部 action 真实 exit 0：

| Action | 内容 | pid | exit | UTC 起止 |
|---|---|---|---|---|
| `fbc7b2d8` | 全仓 `tsc --noEmit` | 41048 | 0 | 2026-10-07T06:22:20Z → 06:22:21Z |
| `9f07b5ea` | **集成红绿（主证据）** | 12692 | 0 | 06:22:21Z → 06:22:22Z |
| `a3eb0d92` | 既有回归 6 文件 | 33240 | 0 | 06:22:22Z → 06:22:31Z |

集成证据形态：**真实 `createApiServer` + 真实 HTTP 打到 `127.0.0.1:<临时端口>` +
假外部 driver + `os.tmpdir()` 临时 data**。未启动宿主、未起 Electron、未做真实推理、
未碰真实 `userData`/凭据、未启停任何服务。
stdout：`Tests 29 passed (29)`、`CLASS=all_passed`、`STRAY_PROBE_FILES_IN_FORMAL_SRC=0`。

探针在 `review-artifacts/ra09-api-journal-audit-20261007/private/journal-api.probe.test.mjs`，
正式源码目录零写入。静态辅证脚本 18 条判据全过（`all_ok: true`，exit 0），
但**静态不是主证据**，主证据是上面那次实跑。

---

## 五、`929.md:871-877` 逐条映射

`:875` 通过条件三项：

| 条款 | 本轮结论 | 依据 |
|---|---|---|
| **journal不足拒新发** | ✅ 已实现并实测 | 容量不足 → 507 `journal_capacity_exceeded`；落盘失败 → 507 `journal_write_failed`；原件损坏 → 507 `journal_corrupt`。三者均 `driverCalls=0`、契约 `delivery=not_submitted` |
| **而非丢unknown** | ✅ 已实现并实测 | `unknown`/`in_flight` 不可淘汰；跨重启后仍在盘上；容量压力下拒新发而非丢它（T4）；写盘失败时内存淘汰完整回滚（T8-3） |
| **官方秘密不曾进入采集管道** | ⛔ **未测** | 本轮 journal 只写结构化字段，无凭据路径；但「官方秘密不入采集管道」是更大命题，本轮未触及 |
| **secret canary 无泄漏** | ⛔ **未测** | 同上，未做 canary 注入 |
| **正文默认不外带** | ⚠️ 部分 | journal 只存 `operationId`/`state`/`outcome`/`at`/`scope`/`bodyHash`，**不存正文/凭据**（T10a 断言 journal 文件内不含请求正文）。但整个导出管线的 canary 未测 |

`:876` 证据要求（扫描规则/退出码、脱敏导出 hash、IPC/文件访问审计、实际预览交互、
不自动上传）：⛔ **未测**。

`:873` 前提（专用测试 data、合成敏感金丝雀）：本轮用的是 `os.tmpdir()` 临时 data ✅；
合成金丝雀 ⛔ 未做。

**结论：不得据本轮结论宣称 RA-09 通过。** `:875` 三项中两项已实测落地，第三项未测。

---

## 六、未验边界（如实列出）

1. 跨重启**原样重放 2xx 正文未实现**——需持久化响应正文，与「journal 不存正文」硬要求冲突。
   本轮保证的是**不重复投递**（安全性），不是跨重启重放（便利性）。有意边界。
2. `--journal-dir` / `ZCC_JOURNAL_DIR` 只做了解析层与 spawn 层验证，
   **未真实拉起 api 进程**（父审 v92 明令不启 8791、不探无关进程）。
3. `journalMaxEntries` 默认 512 只在小值（1~3）实测容量拒绝，**未做 512 条规模压测**。
4. 桌面主进程 `journal.cjs` 的跨重启保留本轮未重测；双 journal 文件名分离只做了静态核对，
   未做双写者并发实测。
5. **全量既有套件未在本轮签收**：`tests/unit/official-tap-fidelity.test.mjs` 要求 8791 无监听，
   而该端口由主上正在运行的 `ZCodeCompanion.exe`（PID 15808，启动于 2026-10-06T22:01:58Z）
   占用；`tests/contract/gates.test.mjs` 是其级联。**未 kill 该进程、未改端口**——
   主上正在使用该实例。本次改动直接触及的 6 个文件已单独实跑 204/204 绿。

---

## 七、改动清单

新增：
- `packages/api/src/journal-store.ts`（352 行，sha256 `81cf2781…`）

修改（tracked diff 见 `business-diff-tracked.patch`，测试钉子见 `test-pin-diff.patch`）：
- `packages/api/src/server.ts` +233 · `packages/api/src/errors.ts` +60
- `packages/api/bin/start-api.mjs` +34
- `apps/desktop/main.cjs` +30 · `apps/desktop/lib/proxy-manager.cjs` +13
- `apps/desktop/lib/spawn-spec.cjs` +4
- 5 个既有测试钉子（`api-contract` / `api-start-entry` / `api-request-decode` /
  `desktop-key-redaction` / `desktop-proxy-manager`）

合计 11 个 tracked 文件，**+422 / −18**。未提交、未推送。

> 上一轮（v89 前）的 `apps/desktop/lib/journal.cjs` + `apps/desktop/lib/__tests__/`
> 为既有改动，本轮未重测其行为，仅静态核对了文件名不冲突。