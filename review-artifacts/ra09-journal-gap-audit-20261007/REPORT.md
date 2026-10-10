# RA-09 条款 875「journal 不足拒新发而非丢 unknown」· 缺口核证报告

- task: `ra09-journal-gap` / project: `journalgap`
- round: `5d652382-31a6-438c-86d7-e13f06826318`（**零失败动作**）
- validate: `accepted_blocked` / `evidence_valid=true` / exit 0
- 定案 `c3722bcb`：pid `3464`，exit `0`，`2026-10-07T05:09:33Z → 05:09:33Z`，timeout false

---

## 一、先纠正我上一轮的引用错误

上一轮我把 `929.md:875` 读成只讲「凭据不泄漏」，**漏引了后半句**。已按主线程指定的精确路径逐行复核，脚本**逐字**取原文并机器判定：

**`G:/zcode-project/zcode-dev/929.md:875`（SHA256 `13b3e59d…`，未改动）**
> `- 通过：secret canary无泄漏，正文默认不外带；**journal不足拒新发而非丢unknown**；官方秘密不曾进入采集管道。检测到泄漏立即FAIL，不把"导出后擦掉"当通过。`

封存输出 `SPEC_875_has_journal_clause=**True**` ⇒ **该通过条件确实存在于原文中**。

## 二、PART A：条款要求的三项机制 —— 均**业务未实现**

| 机制 | 源码证据 | 结论 |
|---|---|---|
| **journal 持久化** | 产品全树（`apps/ui/src` + `packages`，排除 node_modules）中 `journal` 字样**仅 1 处**：`apps/ui/src/data/snapshot.ts:270` `journal: NOT_CONNECTED as string`（其常量 `NOT_CONNECTED='未接入'` 定义于 `:10`）。`packages/api/src` 下命中 **0** | **无任何落盘实现**，`A2_journal_writer_apis=0`（`writeJournal`/`journalPath`/`journalStore`/`appendJournal`/`journalFile` 全树 0 命中）⇒ **「重开后仍在」无载体** |
| **容量不足拒新发** | `A3_reject_when_full_markers=0`（`journal_capacity_exceeded`/`journal_full`/`insufficient_journal`/`reject_new_operation`/`refuse_new` 在 `server.ts` 代码区全 0 命中） | **不存在**。现有 `server.ts:826-842` 在容量超限时执行的是 `evictReplayOverflow()` **逐出最旧可淘汰条目**，不是拒绝新发 |
| **unknown 记录保留** | `server.ts:201` `StoredOperation.state` 枚举为 `'in_flight' \| 'done' \| 'failed'`，**不含 `unknown`**（封存输出 `B3_stored_state_enum_has_unknown=**False**`） | **无 unknown 这一记录状态** |

**准确结论：条款 875 的 journal 三项要求在当前产品中业务未实现（未接线）——不是实现错误，也不是缺陷。**

## 三、PART B：真实存在但**语义相邻**的行为（**仅邻近行为，不算本条验收**）

按主线程指示，以下六项一律标注为邻近事实，**不用它们冒充条款验收**：

| 邻近行为 | 源码位置 | 封存判定 |
|---|---|---|
| 容量上限 512 | `server.ts:209` `MAX_IDEMPOTENCY_ENTRIES = 512` | `B1` |
| 淘汰判据 `done` + 持有正文 | `server.ts:815` `entry.state === 'done' && entry.replay !== null` | `B2=**True**` |
| 记录状态枚举**无 unknown** | `server.ts:201` | `B3=False` |
| **无候选即 break**（宁可暂时超限也不硬删在途登记） | `server.ts:836` `if (victimScope === null) break;` | `B4=**True**` |
| 结算先于淘汰 | `server.ts:855-862` `entry.state='done'` 后才 `evictReplayOverflow()` | `B5=**True**` |
| **`outcome_unknown` 不被自动重试掩盖** | `packages/api/src` 全树 `maxRetries`/`backoff`/`shouldRetry`/`retryCount` 命中 **0**；`chat.ts:841` 抛 `ApiError('upstream_outcome_unknown')`，`errors.ts:53` 已注册 | `B6=0`、`B7=True`、`B8=True` |

**`B4`（无候选即停、不硬删在途）与条款「不足则拒」的语义确有呼应，但仍不是 journal 机制本身**，不据以签收。

## 四、替身与边界（如实标注）

- 本轮是**只读源码事实盘点**，**未复刻任何产品逻辑**（脚本只做 `in` 判定与行号定位）
- **未启动宿主、未调用真实推理、未使用真实凭据、未做 IPC、未启动服务、未写记忆**
- PART B 只有源码级判定，**无运行时触发验证**（那属邻近事实，不属条款验收）
- 正式文件零改动：`server.ts` `66ebf153…`、`chat.ts` `effc6043…`、`errors.ts` `11a594e5…`、
  `snapshot.ts` `3f4600a2…`、`929.md` `13b3e59d…` 本轮前后逐字节一致
- `git status --porcelain -- packages apps` **空（CLEAN）**，HEAD 仍 `1558342`

## 五、本轮自身缺陷（预验证拦下）

`B2_isEvictableReplay` 判据初版写成 `state === 'done' && replay !== null`（漏 `entry.` 前缀）
⇒ 首跑报 `False`，会**误判产品没有该判据**。按行回溯读到 `:815` 原文后修正为
`entry.state === 'done' && entry.replay !== null`，重跑得 `True`。

另 `validate` 首次报 `blocker observation mismatch` —— 产物里 `journal_clause_accepted`
是 JSON 布尔 `false`，我错写成字符串 `"false"`。已改为布尔真值。

## 六、未测项

- 条款 875 的另一半「secret canary 无泄漏、正文默认不外带」「官方秘密未曾进入采集管道」
- 密钥 ACL、OS 级加密存储、后台自动上转链路
- **不冒称 RA-09 整体通过**

## 七、下一步

缺口证据已闭合（journal 持久化 / 拒新发 / unknown 保留三项均未实现，附精确行号）。
**等主上裁定是否立项实现**；若立项，本报告可直接作为实现前的边界说明。
按指示，不再用邻近 Map 测试推进本条。