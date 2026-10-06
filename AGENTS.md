# 置顶工作铁律：每轮实际推进、证据与独立验收（2026-10-06）

本节落实本次项目接管的工作约定，适用于本项目后续开发、诊断、验收和交接；不改写下方历史阶段事实，也不扩大已有授权。

- 每轮围绕真实目标执行已授权的最小下一步，同时记录新增动作及验证；不得只用计划、排队、运行中、自报完成或旧绿测代替本轮推进。无需为了汇报重复已通过的验证。
- 每项记录 task/会话与项目、开始/结束 UTC、实际命令与范围、源码/输入/产物 hash、真实 exit、原始输出位置、能证明的结论、未测限制及下一步。历史缺失字段写未知，不以 mtime、冻结时间或推测补执行时间；工具拒绝且未启动进程时没有实际 exit。
- 局部阻塞只停止对应动作；继续其他已授权工作。明确区分用户限制、工具审批拒绝、环境失败与团队自行范围控制。真实失败或阻塞可以诚实结束，不要求每轮成功；不得凑证据、虚报或绕过拒绝。
- 实施者报告事实，不能自签独立验收。由协调者安排独立复核，并检查真实需求、关键流程、边界、取消/重复操作和适用测试；合成夹具、静态检查或证据校验通过，不等于真实产品/GUI/provider 验收。
- 保留既有 dirty，遵守文件单 writer 与集中 GUI 调度；写前核目标 hash，写后回读留证。特殊权限、凭据、部署、真实业务写入和服务操作仍需各自授权；本节不解除任何既有拒绝或安全边界。

统一入口（本机当前接管工作区）：

- [工作区 AGENTS](C:/Users/datoo/Documents/Codex/2026-10-03/task/AGENTS.md)：轮次和主线程交付要求。
- [工作习惯与项目规则](C:/Users/datoo/Documents/Codex/2026-10-03/task/PROJECT-WORK-RULES.md)：推进、阻塞和证据口径。
- [证据收集与验证](C:/Users/datoo/Documents/Codex/2026-10-03/task/evidence-gate/README.md)：新动作收集及主线程实际 validate；collector 退出 0 仅说明收集完成，必须另读子命令真实 exit，validate 通过也不是业务验收。

这些绝对链接只指向本机当前接管工作区，换机/迁移后由协调者确认对应入口；不可把路径失效当作规则已执行。项目 AGENTS 是支持该规范的客户端发现入口；现有 ZCode/MiniMax GUI 是否自动读取尚未实测，不声称当前会话已热加载或强制执行。项目 AGENTS 在支持它的会话启动时可被发现；现有会话需显式读取采用，不承诺热加载或跨目录全局生效。链接文档和证据 CLI 是约定/显式执行流程，未安装 Hook，也不更改模型、全局记忆或权限。更高优先级指令和当前用户授权始终优先。

---

## 本轮审查交付说明（2026-10-03，只读审查；结论全部未修复）

2026-10-03 对本仓库完成一次**只读**审查：终审未执行任何命令、测试或复现，未修改任何产品源码。审查报告全文已入库，路径 `review-artifacts/review-20261003/zcode-companion-review-20261003.md`；入库副本仅把本机 Windows 用户名做脱敏（`C:/Users/datoo` -> `C:/Users/someone`），与原始报告除该用户名外逐字节一致，其余字符、行序、编号、计数、结论与 CI 数字一律未改。

去重后计数：

| 分类 | 数量 | 状态 |
| --- | ---: | --- |
| 新增已确认缺陷/遗漏 | **42**（35 项中等、7 项低） | **全部未修复** |
| 新增可优化项 | **3**（均低优先级，不承诺未经测量的性能收益） | **全部未修复** |
| 已知问题（本轮已有复核） | **2**（I01 协作入口陈旧、既有墙钟断言波动） | **全部未修复** |

状态口径，严格区分已测 / 未测 / 根因未确认：

- **已测：**唯一一次完整 `npm run ci`，退出码 **0**（29 个测试文件、1006 个用例）。该结果只说明现有接线与断言当轮成立，**不代表缺陷清零**；新交错、失败分支、协议分块与门覆盖缺口仍可由专项反例成立。
- **已测且失败：**现存便携包 `release/desktop/ZCodeCompanion-0.1.0-win-x64-portable.exe` 的 `verify:package` 退出码 **1**，原始失败文本为 `verify:package FAIL: 产物在 180000ms 内没有自行退出（输出：）`；同构建未包装 exe 对照同样未自行退出。**该退出的根因未确认**，不以旧的一次成功抵消，也不靠加大超时掩盖。
- **未测：**真实人工 GUI/webui 点击与截图验收（本轮无可操作浏览器会话，未取得任何真实点击或截图证据）；另含新构建/新 pack、干净克隆重装、真实生产模型与额度、真实 mcode/ocx、真实 OS 单实例与窗口交互、视觉与可访问性、整机退出/重启、其它平台。

本文件正文中的阶段声明与旧门描述属 I01 已知问题范畴，本轮未改动，也未获授权改动。以下处理顺序按报告建议：先 F01–F12 的确定性完整性/生命周期/失败判据，再其余中等条目的可用性与状态接线，低风险文档与来源披露可局部修正，3 项优化独立排期。U01（验包退出）须保持根因未确认，后续诊断只能在另获单次产品运行授权后进行。

---

<!-- zcode-main-session-rule:start -->
# 主会话职责

主会话以及主agent不自己写代码，只负责思考规划，全程跟进，协调，解决问题，终审以及最后的真实gui或者webui上的实际测试验收。过程中派子代理审查，修改。优化，好了再派新的子代理复查。
<!-- zcode-main-session-rule:end -->

# AGENTS.md — ZCode Companion (工单 929)

本文件是 `G:/zcode-project/zcode-companion` 的**强制**协作与验收边界。任何在本仓库工作的人或代理都必须先读本文件，再读 `docs/decisions/929-toolchain.md`。本文件覆盖仓库内其他一切默认行为。

当前阶段：**I01 工程骨架与 provider-free 测试隔离**。本仓库**没有**聊天、模型、官方协议或打包能力，任何"已接入/已通过"的说法都是错的。

## 0. 权威来源

| 内容 | 位置 |
| --- | --- |
| 冻结计划 | `G:/zcode-project/zcode-dev/.superpowers/sdd/929/929.md` |
| 原始需求 | `G:/zcode-project/zcode-dev/.superpowers/sdd/929/task-I01-brief.md` |
| 收口增补 | `G:/zcode-project/zcode-dev/.superpowers/sdd/929/task-I01-recovery-brief.md` |
| 回炉清单 F01–F05 | `G:/zcode-project/zcode-dev/.superpowers/sdd/929/task-I01-interruption-review.md` |
| I00 输入（只读） | `docs/decisions/929-inputs.md`、`review-artifacts/929/baseline.json` |
| 工具链裁定 | `docs/decisions/929-toolchain.md` |

`docs/decisions/929-inputs.md` 与 `review-artifacts/929/baseline.json` 属 I00 成果：**只读，禁止修改**。

## 1. 不可逾越的安全边界

违反以下任意一条即视为工单失败，无例外、无"临时豁免"。

1. **安装范围**：所有 `npm` / 构建命令必须在 `G:/zcode-project/zcode-companion` 的绝对 cwd 下执行。禁止全局安装、禁止改全局 npm 配置、镜像、registry、Hook、MCP、`.npmrc`（用户级或项目级）。
2. **父仓库只读**：禁止修改 `G:/zcode-project/zcode-dev` 下的任何文件，**唯一例外**是工单明确要求写入的 `.superpowers/sdd/929/task-I01-report.md` 报告。父仓库的 git 状态、配置与产物一律不动。
3. **禁止启动官方运行时**：不启动官方 ZCode、app-server、Electron GUI、DSH、3188 端口服务、Servy。不做真实模型发送。Electron 的内嵌 Node ≠ 开发机 Node，两者不可互相替代作为证据。
4. **禁止生产数据与凭据**：不读写生产数据库、生产配置，不解密、不打印、不外传任何凭据、token、API key。本仓库的 `.env*`、`*.pem`、`*.key` 必须始终不存在。
5. **付费通道永封锁**：任何标记为 paid / metered / unknown 的模型或 API 通道**永不准入**。原生工具的 plan/deny 状态**不等于**禁用原生工具；应用入口的默认能力按 unknown 处理，即不可用。
6. **进程回收**：只允许回收**自己创建且身份可证**的 fixture 子进程（持有其 spawn handle）。禁止 `taskkill` 通配、禁止按进程名匹配、禁止按端口猜所有权。禁止用 `process.exit()` 掩盖悬挂的资源。
7. **未知结果不自动重发**：任何失败、超时、来源不明的调用结果不得自动重试重发。重新执行必须由人显式决定。
8. **禁止自签验收**：实施代理不得为自己签署 spec/quality 通过。独立审查必须由未参与实施的代理执行，由协调者派发。
9. **不越界执行**：实施代理只跑本工单范围内的专项（`npm ci`、`typecheck`、`unit`、`contract`、门自测、F01–F04 专项）。最终全链由协调者执行。
10. **不并行作者**：同一 `package.json` / `package-lock.json` 只有一个 owner。禁止另起并行作者改依赖锁。

## 2. 工程边界

- **独立仓库**：`G:/zcode-project/zcode-companion` 是独立 git 仓库，分支固定为 `dev/929-companion`。
- **禁止 commit / push / 部署**：本阶段所有文件保持未提交状态，由协调者统一处置。
- **不生成占位模块**：不得为了"看起来完整"批量生成空 `packages/`、`apps/` 模块。子包规则见第 4 节。
- **子包归属**：两个子包 A / B，每包最多 5 个**手写**文件。`package-lock.json` 是生成文件，不计入。需要超出时先向协调者申请拆包，不得自行膨胀。
- **不覆盖他人未交付实现**：`apps/` 由 UI01 工单拥有，拥有独立的 `package.json` 与 `tsconfig.json`。I01 不修改 `apps/` 下任何文件，也不把它并入根 TypeScript 工程（见 `docs/decisions/929-toolchain.md` 的 F05 裁定）。

## 3. 测试隔离与验收门

- **默认 provider-free**：`npm test` 只跑本仓库自带的 fixture 子进程。不允许出现官方 app-server、模型调用、生产服务、生产数据库。
- **门是 fail-closed**：`lint`、`test:integration`、`test:mutations`、`test:e2e`、`build`、`pack:win`、`verify:package` 在实现前必须返回 `NOT_IMPLEMENTED` 且非零退出。禁止写 console PASS 伪通过，禁止 `allowNoTests`。
- **退出码语义**（`scripts/stage-gate.mjs`）：`0` 通过；`1` 门已执行但失败；`2` USAGE / UNKNOWN_GATE / UNKNOWN_OPTION；`3` NOT_IMPLEMENTED 或 EMPTY_CATEGORY；`4` APPS_PROJECT_NOT_CREATED（`typecheck:apps` 依赖的 `apps/ui/tsconfig.json` 不存在——**阻断**，绝不静默跳过，也绝不与"通过"混淆）。
- **聚合门 `ci` 的构成**：`npm run typecheck`（根 `.ts`，`checkJs:false` 档）→ `npm run typecheck:checkjs`（`scripts/` 与 `tests/` 的全部 `.mjs`，`checkJs:true` 档）→ `npm run typecheck:apps`（`apps/ui` 独立工程）→ `npm test`。**任何一段缺失都必须让 `ci` 变红，禁止用"跳过"或"不接线"把后来模块移出 typecheck 视野**（Q1 裁定）。
- **真实 canary 未授权即非零**：真实模型 canary 必须有显式授权接口；接口未实现时直接非零。禁止用单个环境变量开关绕过真实预算。
- **先红后绿**：每个缺陷修复都要留下**真实**的红→绿证据（命令 + 退出码 + 失败信息）。没跑过的就写"未取得"，**严禁编造历史红绿记录**。
- **测试不能自我派生**（F01）：`tests/contract/` 下的文件是 `test:contract` / `test` 的 vitest 目标，**禁止**在这两个门内部再调用自身。需要断言它们的分类与目标选择时用 `--print-targets`；需要真实执行时用独立临时测试根。任何测试都不得通过删断言、skip、恒真或环境变量绕过门。
- **测试资源必须自清理**：每个测试创建的临时目录、临时文件、计时器、监听器、pending waiter、子进程都必须在 `finally` 中回收；超时与错误路径都必须能终结等待；子进程回收必须有界。

## 4. 文件与子包所有权

| 子包 | 文件 | 数量 |
| --- | --- | --- |
| A | `AGENTS.md`、`package.json`、`tsconfig.json`、`.gitignore`、`docs/decisions/929-toolchain.md` | 5 |
| B | `vitest.config.ts`、`scripts/stage-gate.mjs`、`tests/fixtures/fake-runtime.mjs`、`tests/unit/fake-runtime.test.mjs`、`tests/contract/gates.test.mjs` | 5 |
| 生成 | `package-lock.json` | 不计 |
| I00 | `docs/decisions/929-inputs.md`、`review-artifacts/929/baseline.json` | 只读 |

精确文件清单与每项 F01–F05 的处理方式见 `G:/zcode-project/zcode-dev/.superpowers/sdd/929/task-I01-report.md`。

## 5. fake-runtime 协议边界

`tests/fixtures/fake-runtime.mjs` 是 **fixture-only/1** 协议的自有 fixture，**不是**官方 ZCode RPC 的实现，也**不**声称与官方协议兼容。它的作用是为 I02/I05 提供可复用的传输机制（确定性握手、可观测 dispatch 计数、未知请求拒绝、非法帧拒绝、受控生命周期、自然退出）。

**禁止**把本 fixture 的帧结构、字段名或方法名当作官方协议的事实。官方协议必须由 I02 从官方出处重新确定，任何"照抄 fixture 即兼容官方"的推断都是错的。

## 6. 状态口径

汇报时必须区分：**已改**、**已测**、**未测**、**阻塞**、**风险**。

- 未运行过的命令写"未取得"，不补写、不推测。
- 未通过的门写 NOT_IMPLEMENTED，不称"该功能测试通过"。
- 有界扫描（如按命令行包含工程路径的进程扫描）只表述为有界扫描，不冒称全机进程审计。
- provider-free 夹具通过**不等于**真实产品验收通过。真实产品验收矩阵当前为 `NOT_RUN`。

<!-- companion-business-loop-20261006 -->
- 汇报展示名须读取对应 session 当前 title 并原样使用，禁止旧标签加截断 ID，也不把易过期标题固化在仓库；继续编号分段，用通俗的“做了什么＋实际证据＋正在做什么”表达，卡点写清已知原因、具体方案及是否已开始，已授权下一步立即执行。合并机械重复的未验项与免责声明，但失败、未知须如实保留；延续上轮复核，末尾先逐项目列小目标及有证据的整体百分比（分母未知写待核算），同一对话分开发送三类消息，不创建新聊天或新任务，不在报告末尾混排：第一条写工作进展、证据和当前处理；第二条逐项目写小目标、目标进度和总进度；有待批事项时，第三条独立写具体审批事项、范围和影响。已授权不重问，格式变更不视为审批通过。

## 每轮业务验收循环补充

每轮先复核上轮证据和未完项，说明当前新增动作、久停原因是否仍成立、未解问题的具体方案。按真实业务验收项等权列出 n/N 与百分比；分母未完整核定则写待核算，不以测试用例数或局部夹具通过替代项目进度。汇报前同步执行已授权且不受阻的最小目标，不为凑数重复旧绿测。区分用户明确限制、工具拒绝、环境失败与团队协调冻结；局部等待不能停止其它已授权诊断。需要真实决定时给出具体候选、有限操作和唯一决定点。

完整执行与证据口径继续引用 [工作区工作规则](C:/Users/datoo/Documents/Codex/2026-10-03/task/PROJECT-WORK-RULES.md)，不增加 Hook，不扩大既有运行或服务授权。
