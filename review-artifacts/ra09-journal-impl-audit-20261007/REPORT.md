# RA-09 条款 875「journal 不足拒新发而非丢 unknown」· 实现与验收报告

- task: `ra09-journal-impl` / project: `impl`
- round: `3fa0162a-093f-4363-b2b7-9f87f3bce0bb`（**零失败 action**）
- validate: `accepted_blocked` / `evidence_valid=true` / exit 0
- HEAD 未变：`1558342a0aec04138135a7970aa0b72bc585a9fb`

## 一、现有存储/数据目录复用调查结论

| 事实 | 出处 |
|---|---|
| 已有原子写范式：`mkdirSync` → 写 `.tmp`（`mode 0o600`）→ `renameSync` | `settings.cjs:310-315` |
| 数据目录根：`app.getPath('userData')`，已用于 `settings.json` | `settings.cjs:251-252`、`main.cjs:102` |
| 写入损坏不静默吞：退回缺省 + `problems[]` 如实报告，**不覆盖原文件** | `settings.cjs:260-303` |
| UI 侧 `dataDir.journal` 全是 `NOT_CONNECTED` 占位，无任何写入实现 | `snapshot.ts:270`、前轮 `A2_journal_writer_apis=0` |

⇒ **journal 复用 `userData` 目录 + 同款原子写范式，未新建架构。**

## 二、改动范围（`git diff --stat`：26 insertions，**零删除**）

| 路径 | 性质 | 用途 |
|---|---|---|
| `apps/desktop/lib/journal.cjs` | **新增** | journal 持久化唯一实现 |
| `apps/desktop/lib/__tests__/journal.test.mjs` | **新增** | 私有临时 data 验收 |
| `apps/desktop/main.cjs` | **既有，+26 行** | `require` + 实例化 + 3 个 IPC handler |

未改动 `packages/**`、`apps/ui/**`、任何现有业务逻辑。无新架构、无无关重构、**保护既有 dirty**。

## 三、实现要点

1. **容量不足明确拒新发**：`oldEvictableCount < overflow` ⇒ 返回
   `{ ok:false, reason:'journal_capacity_exceeded', entry:null }`，**既不丢旧条目也不假装成功**
2. **不丢 unknown**：`evictable()` 明确排除 `unknown` 与 `in_flight`；
   `unknown` 记录**必须带 `outcome`**（不可知也须说明不可知在哪里）
3. **进程重开保留**：落盘 `userData/journal.json`，`load()` 读回
4. **取消 / 重复 / 写失败**：
   - 取消**不改写**已有 `unknown`（否则把「不可知」洗成「已知失败」），另记 `#cancel` 事实
   - 重复 `operationId` 幂等，返回既有条目，**不被后到者覆盖**
   - 写失败返回 `journal_write_failed`，**内存态不变、不留文件**

## 四、行为验收（权威）

`f4187197`：pid `65476`，exit `0`，`2026-10-07T05:22:07Z`，`node --test` → **tests 5 / pass 5 / fail 0 / 94ms**

| 用例 | 断言要点 |
|---|---|
| **J1** | 容量满且无可淘汰对象 ⇒ 拒新发、`entry:null`、条目数不变、被拒条目不落盘 |
| **J2** | 连续 12 次容量压力下 `unknown` 逐字保留（`state`/`outcome`/`at` 全等）、`evictable=false` |
| **J3** | 新实例 `load()`（模拟重开）后 `unknown` 与全部记录读回，`journal.json` 确已落盘 |
| **J4** | 取消不改写 `unknown`；重复键幂等且后到者不覆盖；写失败如实返回、内存态不变、不落盘 |
| **J5** | 读损坏逐条丢弃并报告，**不整份丢弃、不覆盖原文件** |

## 五、接线核证（`3fdf77d8`，pid 65860，exit 0）

**journal 进入真实业务入口，不是孤立新 helper**：

- `main` 真实 require ✓、实例化 ✓、目录取 `path.dirname(settingsFile)` 即**真实 userData** ✓、启动时 `load` ✓
- 三个 IPC handler 已注册（`zcc:journal:list` / `append` / `cancel`），`append` 结果**原样透出**，`journal_capacity_exceeded` 对渲染层可见
- 落盘范式与 `settings.cjs` **同款**（tmp+rename 原子写、`mode 0o600`）
- 测试隔离：只用 `os.tmpdir()` 私有目录，跑完 `rmSync` 清理，**不触碰真实 userData**

## 六、实现中发现并修掉的两个**真实产品 bug**

均由自写测试抓出，**不是测试自身问题**：

1. **新条目把自己淘汰**：淘汰循环遍历 `[新,...,旧]` 全数组，`append` 返回 `ok:true` 却实际没写入
   → 改为只遍历旧条目，新条目固定首位
2. **「拒新发」退化成「静默丢新发」**：容量判定把新条目自己算作可淘汰候选，
   于是无可淘汰对象时反而成功
   → 改为只统计**旧**条目，不足即 `journal_capacity_exceeded`

另修三处测试自身缺陷（臆测 `load` 顺序、子用例共用目录污染、越界字符）
与一处裁定脚本缺陷（node:test 的 TAP 行首符号前缀未剥、`tests/pass/fail` 是空格分隔非 `key=value`）。

## 七、边界（如实标注）

- **未启动宿主、未调用运行时 IPC、未调用真实推理、未使用真实凭据、未触碰真实 userData**
- IPC handler 仅**源码级注册核证**，运行时行为未验
- journal 与 `packages/api` 的 `in_flight` 幂等登记**尚未联动**，两套记录机制关系未梳理
- **不冒称 RA-09 整体通过**：`:875` 前半句（secret canary 导出无泄漏、官方秘密未入采集管道）、
  密钥 ACL、OS 级加密存储、后台自动上转链路**全未测**
- 未改 git、未写记忆

## 八、文件 hash

`main.cjs` `8f1abc22…`（已改）、`journal.cjs` `386b1bf5…`（新增）、
`journal.test.mjs` `907ce598…`（新增）、`settings.cjs` `c34b6bcc…`（**未改**）