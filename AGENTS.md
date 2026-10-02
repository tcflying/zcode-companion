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
