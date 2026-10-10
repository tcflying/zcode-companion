# RA-09 导出预览/保存 与 合成 canary — v95 / v95b 验收报告

**结论先说：本轮不能签 RA-09 通过。** 一条硬需求（`929.md:874`「走实际导出预览/保存」）**无法执行**——因为该入口在本候选的产品代码里根本不存在（静态扫描给出可复跑证据）。已实测并通过的是 canary 侧的**局部**命题：非凭据形状的合成 canary 经真实 HTTP 请求走完 `runChat` 后，在 journal 落盘面与服务端日志行上**零命中**。

- task：`business-v95b-20261007`
- round：`33c71fe1-ae8c-4688-a761-fdae221329d1`
- gate：`{"status": "accepted_success", "evidence_valid": true, "completion_status": "success"}`，exit 0
- 报告：`evidence/33c71fe1-…/report.json`

---

## 一、本轮实际动作与证据

| # | 动作 | pid | exit | startUTC | endUTC | 关键回执 |
|---|---|---|---|---|---|---|
| A1 | 全仓 `tsc --noEmit` | 47520 | 0 | 2026-10-07T07:00:56.396Z | 07:00:56.591Z | stdout/stderr 均空（无诊断） |
| A2 | 集成红绿（canary 主证据） | 59452 | 0 | 07:00:56.690Z | 07:00:58.084Z | `Tests 40 passed (40)`、`CLASS=all_passed`、`STRAY_PROBE_FILES_IN_FORMAL_SRC=0` |
| A3 | 导出入口定位扫描 | 39840 | 0 | 07:00:58.304Z | 07:00:58.820Z | artifact `export-entry-scan.json` sha256 `684fb65da7c77ef4f221a0007c5678e18cb92ff6d39b1540be01fec78ec8562f` |

A2 的形态：真实 `createApiServer` + 真实 HTTP 打到 `127.0.0.1` 临时端口 + 假外部 driver + `os.tmpdir()` 临时 data。正式源码目录零写入（runner 前置断言已核）。

**新增两条用例：**

1. **T14a（canary 不落盘）**——把**非凭据形状**的合成 canary 同时放进用户消息正文与 `x-zcc-*` 会话头，经真实 `runChat` 走完后，逐字节扫描临时 data 目录下**每一个**落盘产物与服务端日志行，两个 canary 均**零命中**。扫描范围被钉死为「恰好 `api-operations-journal.json` 一个文件」，防止「扫了个空目录」式的假零命中。
2. **T14a 内含反向对照**——同时断言 fixture 驱动器收到的 `fixture_echo` 里**确实带着 canary**。不这么做，「盘上没有它」可能只是因为它压根没进发送链。

**T14b（扫描器自检负控）**——把 canary 写进产物（含子目录）后，扫描器**必须**报出命中。没有这条，T14a 的「零命中」是假绿。

## 二、A3 的定位结论：导出入口不存在

扫描范围写死在脚本里，可复跑：

- 根：`apps/ui/src`、`apps/desktop/lib`、`packages`、`apps/desktop/main.cjs`、`apps/desktop/preload.cjs`
- 扩展名：`.cjs` `.mjs` `.ts` `.tsx`；**排除** `*.test.*` 与 `**/node_modules/**`
- 产品代码文件数：**55**

| 原语 | 产品代码命中 |
|---|---|
| `createObjectURL` | 0 |
| `showSaveFilePicker` | 0 |
| `download=` | 0 |
| `Blob(` | 0 |
| `toBlob` | 0 |
| `clipboard.writeText` | 0 |

`fs.writeFile*` 命中 8 处，但那是产品自己的数据持久化（settings / journal 原子写），**不计入判据**——把它算进去正是本脚本第一版的错误，会让结论被正常代码污染。排除 node_modules 是必须的：同一组原语在 `apps/desktop/node_modules`（1614 个文件）里有 **12** 处命中（`createObjectURL` 8、`Blob(` 3、`clipboard.writeText` 1），全是类型存根；上一版未排除时差点得出「有导出」的假结论。

**没有任何产品文件调用导出/保存原语 ⇒ `929.md:874` 的导出步骤在本候选上无从执行。** 本轮**没有**新建导出功能，也**没有**新建纯 helper。

## 三、`929.md:871-877` 逐条映射

原文（权威出处，`G:\zcode-project\zcode-dev\929.md`）：

- `:874` 操作：走实际导出预览/保存，检查包、日志、错误、导出；用无危害HTML/路径内容测试渲染与外链边界；检查写入目标与ACL。
- `:875` 通过：secret canary无泄漏，正文默认不外带；journal不足拒新发而非丢unknown；官方秘密不曾进入采集管道。
- `:876` 证据：扫描规则/范围/退出码、脱敏导出hash、IPC/文件访问审计、实际预览交互；不自动上传任何文件。

| 条款 | 状态 | 依据 |
|---|---|---|
| `:874` 走实际导出预览/保存 | **未执行（入口不存在）** | A3 扫描 55 文件，6 类导出原语全 0 |
| `:874` 无危害 HTML/路径内容测渲染与外链边界 | **未测** | 需真实 GUI，本轮不启宿主 |
| `:874` 检查写入目标与 ACL | **未测** | 同上 |
| `:875` secret canary 无泄漏 | **局部通过** | T14a：journal 落盘面 + API 日志行零命中 |
| `:875` 正文默认不外带 | **本轮判定，未确认** | 响应体会回显 canary（fixture 驱动器 `fixture_echo`）；判定「回给发话方本人不构成外带」，**未**经父审确认 |
| `:875` journal 不足拒新发而非丢 unknown | **未在本轮测** | 属 journal-store 族，已在 v90/v94 轮取证，未在本轮重跑 |
| `:875` 官方秘密不曾进入采集管道 | **未测** | 明确不使用真实凭据/官方库故障注入 |
| `:876` 扫描规则/范围/退出码 | **有** | A3：范围写死在脚本、exit 0、产物 sha256 已封存 |
| `:876` 脱敏导出 hash | **无（无导出面）** | — |
| `:876` IPC/文件访问审计 | **未测** | 本轮未覆盖 IPC 载荷与 desktop 日志环 |
| `:876` 实际预览交互 | **无（无导出面）** | — |
| `:876` 不自动上传任何文件 | **未测** | 无导出面即无从触发 |

**不得据本轮结论宣称 RA-09 通过。**

## 四、canary 为什么刻意不是凭据

本条命题是「journal 不存正文」。如果 canary 做成凭据形状（`sk-` / `bearer` / `apiKey=`），`redact()` 命中就足以让测试变绿——那测的是**脱敏器**，不是「本就不该落盘的东西」。脱敏器救不了后者：换一种不认识的形状就照样泄漏。

因此本轮**未**证明「canary 走脱敏器也不会泄漏」。那是 `:875` 的另一半，未测。

## 五、T14 的证据强度与残留缺口

- **扫描器侧的反向对照：有。** T14b 证明 canary 真在产物里时扫描器会报出。
- **发送链侧的反向对照：有。** fixture 驱动器的 `fixture_echo` 断言证明 canary 确实进到了请求里。
- **源码变异（把 journal-store 改成会存正文，看 T14a 是否变红）：未做。** 原因是它需要在正式源码目录旁造同深度副本，而本轮约束是「正式源码目录零写入」，临时物只落 `os.tmpdir()`。同族的变异验证（短接各守卫）已在 v90 / v94 轮做过，但那验证的是**守卫触发**，不等价于本条的**落盘内容**。

## 六、为什么有 v95 和 v95b 两轮

`1763aeb8-…`（v95）被 gate 在 `success` 状态下拒绝：exit 2，`old/missing artifact is not new output`。原因是 A3 声明了 `--artifact …/export-entry-scan.json`，但扫描脚本只 `print` 不落盘，receipt 里 `generated=false`（`gate.py:183`）。

该轮**无法补救**——在同一 round 内补写同一路径会让 A3 的 `snapshot(after) != after`，触发 `artifact changed`。因此按纪律**保留原状不覆盖、不改写**，修掉脚本缺陷（改为按 `argv[1]` 参数化写盘）后另起一轮重跑同样三个动作。

**重跑不扩大也不降低原验收范围，结论与被拒轮相同，不计为新增业务进展。**

## 七、待父审裁定

1. **RA-09 导出面**：补建导出预览/保存入口，还是把该面记为未实现？——本轮已给出「入口不存在」的可复跑证据，在此之前的任何 RA-09 导出相关验收格都不可能执行。
2. **「回显不构成外带」这条边界判断**是否成立（响应体里出现用户自己发来的 canary，不计为泄漏）。

## 八、遗留事项（不阻塞本轮）

- `%TEMP%` 下的探针历史目录：先前一轮可恢复删除已 `trashed=542 failed=0`（exit 0）；此后本轮与自检又跑了几次探针，残留 **160** 个 `zcc-ra09-api-*` 目录（每次探针约产生 40 个）。再次清理时本地 launcher 在当前 shell 调不动（无输出、无 exit、目标仍在），**未**退回永久删除，需主上手动处理或换用可用调用方式。
- 本轮预检产生的临时文件 `C:\Users\datoo\AppData\Local\Temp\scan-preflight-4b044e8c….json`（约 2 KB）同样未删除，原因同上。
- `review-artifacts/ra09-api-journal-audit-20261007/private/_journal-store.pristine.bak` 保留即可（父审已明示）。
- 未做任何 git 写操作；HEAD 仍为 `1558342a0aec04138135a7970aa0b72bc585a9fb`，工作区 dirty 状态与本轮开始时一致（12 个已跟踪修改 + 23 个未跟踪项，无新增正式源码文件）。

## 九、本轮自查修正的两处

1. **本文初稿把 node_modules 对照命中写成 15 处**（`createObjectURL` 8 / `Blob(` 3 / `writeText` 4）。回读 artifact 原文后改为真实值 **12**（`createObjectURL` 8 / `Blob(` 3 / `clipboard.writeText` 1），产品代码侧命中总和经程序核验为 **0**。
2. **T14a 的用例标题在说谎**：原标题写「落盘产物 / 响应体 / 服务端日志全部零命中」，而断言恰恰相反——响应体**必须**含 canary（那是「确实进到了发送链」的正向证据），判零命中的只有落盘产物与服务端日志行两处范围。标题已更正为「落盘产物与服务端日志零命中，响应体回显可证 canary 确实进到了发送链」。**断言逻辑一字未改**；改后重跑探针确认仍 `Tests 40 passed (40)`、`STRAY_PROBE_FILES_IN_FORMAL_SRC=0`、exit 0（该重跑为轮外自检，不计入本轮证据）。