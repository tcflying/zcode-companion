# ZCode Companion 使用文档

> 把**本机已登录 ZCode 的订阅/套餐模型**，经一条 OpenAI 兼容 HTTP API 提供给其它 IDE 使用。
>
> 本文档面向使用者。每条命令、环境变量、请求字段、错误码都逐条与源码核对过；
> 凡本仓源码里没有写死的事实，一律指向源码位置而不是猜。

---

## 目录

1. [这是什么](#1-这是什么)
2. [前置要求](#2-前置要求)
3. [启动](#3-启动)
4. [端点](#4-端点)
5. [请求字段规则](#5-请求字段规则)
6. [接线：MiniMax Code 及其它 OpenAI 兼容客户端](#6-接线minimax-code-及其它-openai-兼容客户端)
7. [模型选择](#7-模型选择)
8. [成本与延迟形状（如实）](#8-成本与延迟形状如实)
9. [安全模型](#9-安全模型)
10. [已知边界](#10-已知边界)
11. [排障表](#11-排障表)
12. [测试](#12-测试)

---

## 1. 这是什么

**ZCode Companion** 是一个独立运行的软件（不装进 ZCode、不改 ZCode 安装目录）。它在本机起一条 OpenAI 兼容 HTTP API，把**你本机 ZCode 已经登录的那份订阅/套餐额度**（`account:*` 通道）暴露成任何 OpenAI 兼容客户端都能调的模型服务。

典型用途：在 MiniMax Code、其它 IDE 插件、脚本里，用你已经在 ZCode 里付费订阅的模型，而不必再单独买一份 API key。

**零��入**，具体指四件事：

| 承诺 | 落地方式 |
| --- | --- |
| 不改 `C:\ZCode` 下任何文件 | 全程只读引用官方 bundle 与配置资产；`git status` 与文件 mtime 不变 |
| 不重启 ZCode 桌面 | 驱动是"每请求 spawn 一个独立 app-server 子进程"，与桌面进程无生命周期耦合 |
| 凭据不落盘 | 凭据明文**只存在于子进程内存**，父进程连解都不解，明文**不经过父子管道** |
| 不污染你的会话 | 子宿主 `ZCODE_STORAGE_DIR` / 会话 DB / 日志目录全部重定向到隔离临时目录，model-io rollout 关闭 |

代价是**效率形态**（官方 agent 自带系统提示 + 每请求全新进程），见 [§8](#8-成本与延迟形状如实)。这是真实的、无法通过配置消除的开销，本文不粉饰。

### 概念速览

```
你的 IDE（mcode / curl / 任意 OpenAI 兼容客户端）
   │  HTTP  127.0.0.1:8790
   ▼
zcode-companion（Node 进程，本仓 packages/api）
   │  spawn 每请求一枚
   ▼
host-child.mjs（隔离层）
   │  node C:/ZCode/resources/glm/zcode.cjs app-server --stdio --surface desktop
   │  ↑ 凭据明文只在这一层内存里
   ▼
官方 provider registry  ──► 你的订阅/套餐额度
```

---

## 2. 前置要求

| 项 | 要求 | 核对来源 |
| --- | --- | --- |
| 操作系统 | **Windows**。官方 bundle 路径是 `C:/ZCode/resources/glm/zcode.cjs`，隔离目录走 `%TEMP%`，均为 Windows 形态 | `packages/official-host/src/host-driver.ts` 的 `DEFAULT_BUNDLE_PATH` / `DEFAULT_HOST_STORAGE_DIR_NAME` |
| Node | **>= 24.18.0**（用 Node 内置的 TypeScript 类型剥离直接跑 `packages/**` 的 `.ts` 源码，无需构建步骤） | `package.json` 的 `engines.node` |
| npm | **>= 11.16.0** | `package.json` 的 `engines.npm` |
| ZCode 已登录 | 本机凭据仓 `~/.zcode/v2/credentials.json` 里**要有对应套餐的条目**。没有登录 → 启动不报错，但第一次请求会 `CREDENTIAL_ENTRY_MISSING` | `packages/official-host/src/credentials.ts` |
| 官方安装 | `C:/ZCode/resources/glm/zcode.cjs` 存在。路径可用 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 间接定位 | `host-driver.ts` |
| 依赖 | 工程根 `npm install` **+** `apps/ui` 内再执行一次 `npm install`，两步都要做（见下） | 根 `package.json` **没有 `workspaces` 字段**，`apps/ui` 不在根安装覆盖范围内 |

### 2.1 安装依赖（两步，缺一不可）

```bash
# Git Bash
# 1) 工程根
npm install
# 2) 再进 apps/ui
cd apps/ui
npm install
cd ../..
```

```powershell
# PowerShell
# 1) 工程根
npm install
# 2) 再进 apps/ui
Push-Location apps/ui
npm install
Pop-Location
```

**为什么必须分两步：** `apps/ui` 有自己的 `package.json`（含 `@types/react` / `@types/react-dom`），而根 `package.json` 未声明 `workspaces`，所以根 `npm install` 不会替它装依赖。漏掉第二步时，`npm run ci` 的 `typecheck:apps`（`tsc --noEmit -p apps/ui/tsconfig.json`）会因为找不到 react 类型直接变红。

检查 ZCode 凭据是否就位（**只读**，不打印任何值）：

```powershell
# 只看条目键名，不看值
Get-Content "$env:USERPROFILE\.zcode\v2\credentials.json" -Raw | ConvertFrom-Json | Get-Member -MemberType NoteProperty | Select-Object -ExpandProperty Name
```

---

## 3. 启动

### 3.1 最小可用命令

在**工程根** `G:\zcode-project\zcode-companion` 执行：

```bash
# Git Bash
ZCC_API_KEY=<你的密钥> ZCC_HOST_REASONING=low npm run api:start -- --driver official-host
```

```powershell
# PowerShell
$env:ZCC_API_KEY = "<你的密钥>"
$env:ZCC_HOST_REASONING = "low"
npm run api:start -- --driver official-host
```

> `<你的密钥>` 是**你自己选的**本机 API key（不是 ZCode 的凭据，也不是 MiniMax 的 key）。它只用于本机回环端口的 Bearer 认证，与官方额度无关。

### 3.2 为什么 key 必须用环境变量而不是 `--api-key`

`--api-key` 这个 CLI flag 确实存在，但**不推荐**：命令行参数会进 shell 历史、也可能被 `tasklist`/进程列表看到。环境变量在同一个终端里设置后随进程继承，不进命令行。两者优先级见 `start-api.mjs` 的 `parseEntryOptions`：CLI 参数 > 环境变量 > 缺省。

### 3.3 端口与绑定

- 缺省端口 **8790**（`ENTRY_DEFAULT_PORT`，与 `server.ts` 的 `DEFAULT_API_PORT` 启动时校验同源，两处漂移会直接抛 `ENTRY_DEFAULT_PORT_DRIFT`）。
- 绑定地址**恒为 `127.0.0.1`**，不暴露为配置项。传入 `0.0.0.0` / `::` / 任何主机名会在**构造期**抛 `LOOPBACK_ONLY`，不是启动后才失败。
- 端口占用时进程以退出码 1 结束，打印 `zcc-api 启动失败 [LISTEN_FAILED] ...`。

### 3.4 完整环境变量表（闭集）

**这张表是闭集。** 任何不在表里的 `ZCC_*` 键都会让启动直接失败（错误码 `UNKNOWN_ENV_KEY`），不会"读了几个剩下的"。含换行的值也会被拒（`INVALID_ENV_VALUE`）。

| 变量 | 必填 | 缺省 | 取值闭集 | 说明 |
| --- | --- | --- | --- | --- |
| `ZCC_API_KEY` | **是** | 无 | 任意非空白串 | Bearer key 的值。**缺失或全空白即拒绝启动，进程绝不生成默认弱 key。** |
| `ZCC_API_PORT` | 否 | `8790` | 整数 | 监听端口。`0` = 由系统分配临时端口（启动横幅打印真实端口）。 |
| `ZCC_DRIVER` | 否 | `none` | `none` / `fixture` / `local-official` / `official-host` | 驱动器。`fixture` 虽在名字闭集里，但**从配置启用会报 `FIXTURE_DRIVER_TEST_ONLY`**（见下）。 |
| `ZCC_SHUTDOWN_GRACE_MS` | 否 | `5000` | 整数 | `SIGINT`/`SIGTERM` 时在途请求的收束上限。 |
| `ZCC_HOST_REASONING` | 否 | `high` | `low` \| `high` \| `max` | official-host 的推理档位。闭集外**启动即拒**（`HOST_REASONING_UNKNOWN`）。**只在 `--driver official-host` 下解析。** |
| `ZCC_HOST_PERMISSION_MODE` | 否 | `yolo` | `plan` \| `build` \| `edit` \| `yolo` \| `auto` | 下发给官方 `session/create` 的 `mode`。官方逐字注释：`"Yolo mode bypasses permission prompts"`。闭集外启动即拒。 |
| `ZCC_HOST_TOOL_POLICY` | 否 | `allow` | `allow` \| `deny` | official-host 收到 `interaction/requestPermission` 时的应答策略。`deny` 时如实回拒绝。闭集外启动即拒。 |
| `ZCC_HOST_DEBUG` | 否 | `0` | `0` \| `1` | official-host 诊断行开关。**只有这两个字面量**，`2` / `on` / `true` / 空串全部启动即拒。`1` 时子宿主把**零凭据**的会话摘要打到它自己的 stderr；父进程只对 stderr 计数，**内容从不读取、从不转发**。注意：这一项**一律解析**，不限于 official-host。 |

**驱动名逐个说明**（`start-api.mjs` 文件头第 2 条）：

- `none`（缺省）：不挂驱动器。目录为空、聊天路由 503。适合只想看服务起没起来的场合。
- `local-official`：只读三个官方本地文件拿目录，**零发送**，但 `status` 是 `not_attached`，所以 `model_is_real === false` 且没有任何模型产出通道。
- `official-host`：**本项目要用的那个。** 官方 bundle 作子进程宿主。显式 opt-in，不设则行为一字不变。
- `fixture`：**故意不可从配置启用。** 它是假模型产出（产出每一段都带 `[FIXTURE ...]` 标记，响应头 `x-zcc-fixture: true`）。生产配置报 `FIXTURE_DRIVER_TEST_ONLY` 拒绝启动；唯一合法路径是进程内 `import { FIXTURE_TEST_TOKEN }` 构造，symbol 跨不过进程边界——这是设计，不是缺陷。

### 3.5 CLI 参数

| 参数 | 对应环境变量 |
| --- | --- |
| `--port <n>` | `ZCC_API_PORT` |
| `--driver <name>` | `ZCC_DRIVER` |
| `--api-key <key>` | `ZCC_API_KEY` |
| `--shutdown-grace-ms <n>` | `ZCC_SHUTDOWN_GRACE_MS` |
| `--help` | 打印帮助，退出码 0 |

未知 flag 直接拒绝（`UNKNOWN_FLAG`），不静默忽略。

### 3.6 停止

向进程发 `SIGINT` 或 `SIGTERM`（PowerShell `Ctrl+C`，或 `taskkill /PID <pid>`）。收束是**有界**的：先停新连接 → 在途请求等到 `ZCC_SHUTDOWN_GRACE_MS` → 超时如实报 `timedOut` 并强拆 socket。

```text
zcc-api 收到 SIGINT，开始有界收束（≤ 5000ms）…
zcc-api 已关闭 closed=<bool> timedOut=<bool>
```

**没有 `process.exit`**：收束完成后无残留句柄，进程自然退出并带上退出码。用 `exit` 掐掉等于把"还有人在途"这件事藏起来。

### 3.7 ⚠️ 两个陷阱

1. **`ZCC_HOST_STORAGE_DIR` / `ZCC_HOST_WORKSPACE` 用了会起不来。**
   驱动器层确实读这两个键（`HOST_STORAGE_DIR_ENV_KEY` / `HOST_WORKSPACE_ENV_KEY`），但**它们不在入口的 `ENTRY_ENV_KEYS` 闭集里**，所以通过 `npm run api:start` 设它们会得到 `UNKNOWN_ENV_KEY` 拒绝启动。这是入口"不静默忽略未知配置"纪律的直接后果，不是 bug。
2. **同名的旧 `ZCC_*` 变量残留会挡路。** 上一轮实验留下的任何 `ZCC_` 变量都会让这次启动失败。先 `env | grep ZCC_` 确认干净。

---

## 4. 端点

三条路径，职责不混用（`server.ts` 文件头第 8 条）。**全部要求 `Authorization: Bearer <你的密钥>`。**

### 4.1 `GET /v1/zcc/catalog`

本产品界面的目录。响应**只有两个键**，不多不少：

```json
{
  "revision": "<目录修订号>",
  "models": [
    {
      "modelId": "account:bigmodel-individual-coding-plan::GLM-5.3-Flash",
      "displayName": "GLM-5.3-Flash · Zhipu Individual Coding Plan",
      "provider": "account:bigmodel-individual-coding-plan",
      "billingClass": "subscription",
      "contextLength": 1000000,
      "reasoning": ["low", "high", "max"],
      "capabilities": ["text", "image", "video", "pdf", "tool_call", "output_text"]
    }
  ]
}
```

- 七个条目键是**必填且仅此七个**（`CATALOG_MODEL_KEYS`）。服务端在发出前自检，驱动器一旦给出违规目录整份响应被拒，**绝不**部分采纳后当合法响应发出去。
- `contextLength` 为 `null` 表示来源显式声明未知，**不用 0 或猜测值占位**。
- 无上游时返回 `200` + `{"revision":"none","models":[]}`，`x-zcc-status` 头如实标注状态。

响应头：`x-zcc-catalog-count`、`x-zcc-status`、`x-zcc-driver`、`x-zcc-detail`、`x-zcc-ratelimit-limit`、`x-zcc-ratelimit-remaining`。

### 4.2 `GET /v1/models`

给外部 IDE 的**纯 OpenAI 形状**（不带 `zcc` 扩展块）：

```json
{ "object": "list", "data": [ { "id": "<modelId>", "object": "model", "created": 0, "owned_by": "<provider>" } ] }
```

响应头带 `x-zcc-model-count`。无驱动器时 200 + 空列表——空列表是**诚实**的：确实没有可服务的模型。

### 4.3 `POST /v1/chat/completions`

标准 OpenAI chat completions。`stream: false` 走单次 JSON 响应，`stream: true` 走 SSE（`[DONE]` 收尾）。两条路径的 `zcc` 块**同形**。

请求体大小上限 1 MiB（`REQUEST_BODY_MAX_BYTES`），超了 413 且**不缓冲**超限请求体。SSE 单帧上限 2 MiB / 单次流累计 4 MiB。

**最小可用请求：**

```json
{
  "model": "account:bigmodel-individual-coding-plan::GLM-5.3-Flash",
  "messages": [ { "role": "user", "content": "你好" } ],
  "reasoning_effort": "low"
}
```

### 4.4 `zcc` 扩展块

每个响应都带一个 `zcc` 块。它是本端点的**可机读事实披露**面——不读文档也能从响应里看出哪些参数没生效。当前 **15 个键**：

| 键 | 含义 |
| --- | --- |
| `fixture` | 产出是否来自 fixture。真实上游恒为 `false`。 |
| `driver` | 驱动器名。official-host 实例是 `official-host`。 |
| `model_is_real` | **由驱动器能力推导**，不硬编码。口径：fixture → `false`；无驱动器 → `false`；真实驱动器（`ready` + 非 fixture + 确实列出了模型）→ `true`。 |
| `status` | 上游状态。`not_attached` / `no_quota` / `ready`。 |
| `usage_method` | usage 的来源口径。official-host 为 `official_turn_complete_usage`；没有时是 `not_reported`（流式且没请求 usage）或 `unavailable`。 |
| `max_tokens_enforced` | **驱动器能不能真的强制执行上限**。official-host 是 `false`——官方 `session/create` 的 params schema 是 `.strict()` 且逐字没有上限槽位。`false` 时客户端实际发来的那个**键名**（`max_tokens` 或 `max_completion_tokens`）会被追加进 `parameters_not_forwarded`。 |
| `idempotency` | 恒为 `companion-operation-replay-not-upstream-exactly-once`。重放的是 Companion 侧 operation，**不代表上游只执行一次**。 |
| `auto_resend_allowed` | 恒为 `false`。失败与结果未知**不写入**幂等表，也**不自动重发**。 |
| `reasoning_effort_applied` | 实际采用的推理档位。`null` = 客户端没发，用驱动器缺省。 |
| `parameters_not_forwarded` | 收到、校验通过、但**没转发**的参数名。**恒在场**（可能是 `[]`）。输出序固定：A 类表键序 → `metadata` / `user` → `stream_options.include_obfuscation` → 上限键名。 |
| `roles_folded` | 本次被折叠进 prompt 上下文的指令 role（`system` / `developer`）。**恒在场**（可能是 `[]`），按首次出现序去重。 |
| `tools_received` | 客户端这次声明了几条工具。缺席 / `null` / `[]` 都是 `0`。**恒在场。** |
| `tools_forwarded` | **恒为 0**。这是**结构事实**不是可调策略：驱动器契约 `DriverRequest` 上根本没有工具槽位。 |
| `tool_choice_received` | 客户端实际发的 `tool_choice`。`null` = 没发。披露"发了什么"，**不是**"我们采用了什么"——这里永远没有"采用"这个动作。 |
| `host` | `{ "permission_mode": "...", "tool_policy": "..." }`。驱动器自报的实现事实。**缺省缺席** = 驱动器没有可披露的实现事实（fixture / 无驱动器）。值是闭集短码，不含路径、不含 prompt、零凭据。 |

**响应头**（非 fixture 时）：

`x-zcc-status`、`x-zcc-driver`、`x-zcc-detail`、`x-zcc-operation-id`、`x-zcc-idempotency`（值域 `original` / `replayed` / `none`，闭合）、`x-zcc-idempotency-scope`、`x-zcc-ratelimit-limit`、`x-zcc-ratelimit-remaining`。真 fixture 时额外有 `x-zcc-fixture: true`。

---

## 5. 请求字段规则

四分法（`chat.ts` 文件头第 3 条）。分界线是**如实披露能力**，不是字段新老：

- 能被 `parameters_not_forwarded` 完整披露的 → **A 类**（接受）
- 披露了也等于骗用户的（截断、多候选、结构化输出、logprobs…）→ **C 类**（拒）
- 其余未知字段 → **400 `unknown_field`**

### 5.1 接受且真的生效

| 字段 | 说明 |
| --- | --- |
| `model` | 目录里的 `modelId` 原文。非空字符串，≤200 字符，无控制字符。 |
| `messages` | 数组，1–256 条（超限 413）。见 §5.4。 |
| `stream` | 布尔。 |
| `stream_options.include_usage` | 布尔。流式下是否附带 usage 帧。 |
| `max_tokens` / `max_completion_tokens` | 两个键是同一件事的两个名字。**接受 + 校验 + 如实披露未转发**（official-host `enforcesMaxTokens: false`）。两个键**值不同**时 422 并指名两个键——静默挑一个就是替用户做决定。两个键都发且**相同**时按 `max_tokens`（旧名）记，披露给客户端它一定认得的那个。 |
| `reasoning_effort` | 闭集 `low` \| `high` \| `max`，映射到官方 `thoughtLevel`（`REASONING_TO_THOUGHT_LEVEL` 是**恒等映射**，键集合与 `KNOWN_REASONING_LEVELS` 契约测试逐字钉死）。 |
| `n` | **只接受 1**。其它值 422。 |

**`reasoning_effort` 为什么没有 `medium` / `minimal`：**
取值逐字等于官方 GLM-5.3 系列的 `config.optionSpecs.reasoningLevel.values`（官方 builtin config 里那条 `modelMatch: ".*glm-5\.3(?:-flash)?(?:[.\-:/\[].*)?"` 的 `values` 恰是 `["low","high","max"]`）。OpenAI 的 `medium` / `minimal` 是**官方会拒**的值，API 层提前 422 并列出合法值，好过让请求一路走到官方再失败。

### 5.2 A 类：接受、逐类型校验、披露未转发

全部进 `zcc.parameters_not_forwarded`，**恒在场**。值域校验失败一律 422 `unsupported_parameter` 并指名。

| 字段 | 值域 |
| --- | --- |
| `temperature` | number `[0, 2]` |
| `top_p` | number `[0, 1]` |
| `store` | boolean。我们**从不持久化**对话，所以 `store:false` 与实际行为逐字相符（不是妥协）。 |
| `seed` | integer `[0, 2147483647]`（OpenAI 官方只写 `number` 没给区间，本表自定边界并写进错误消息） |
| `presence_penalty` | number `[-2.0, 2.0]` |
| `frequency_penalty` | number `[-2.0, 2.0]` |
| `service_tier` | 闭集 `auto` \| `default` \| `flex` \| `scale` \| `priority` \| `fast`（我们只有一档、不分流） |
| `verbosity` | 闭集 `low` \| `medium` \| `high` |
| `prompt_cache_key` | string ≤64 字符 |
| `prompt_cache_retention` | 闭集 `in_memory` \| `24h`（OpenAI 已标 deprecated） |
| `safety_identifier` | string ≤64 字符 |
| `metadata` | 对象，≤16 键 |
| `user` | string ≤128 字符 |

判定口径：键存在且**不是 `null`** 就算"客户端发了"（`null` 在 OpenAI 形状里就是"没这个偏好"，披露它反而是噪声）。

**为什么 `store` 在表里：** mcode 的 `supportsStore` 缺省对自定义 baseURL 恒为 `true`，所以**每一个** BYOK 自定义 provider 请求都带 `store:false`。硬拒等于让 mcode 全线不可用。

**为什么 `prompt_cache_options` 不在表里而是 C 类：** 它的官方内层形状还在长（`ttl` 迟早不止一个取值）。收下它就得猜一个会漂移的闭集，而"本端点根本没有提示缓存可配置"用 422 说清楚更诚实。

### 5.3 接受但不转发 + 披露：工具声明

`chat.ts` 文件头第 3a 条 / COMPAT4 裁定：

| 输入 | 处置 |
| --- | --- |
| `tools: []` 或缺省 | 接受，`tools_received: 0` |
| `tools: [<非空合法形状>]` | **接受**，逐项**浅校验**（是对象，且**自有** `function` 或 `type` 字段；不深验 `type` 取值 / `function.name` / JSON Schema），计入 `tools_received` |
| `tools: null` 或非数组 | 422（`null` 不等于空数组） |
| 畸形项（`{}` / `null` / 字符串 / 数字 / 数组） | 422，指名具体下标 |
| `tool_choice: "none"` / `"auto"` / 缺省 | 接受，如实 no-op，披露 `tool_choice_received` |

**"接受的是声明，不是能力"** 由结构保证：驱动器契约 `DriverRequest` 上根本没有工具槽位（契约测试用静态钉证明），产出里**永远**不含 `tool_calls`。

> **实弹更正**：本机 mcode 的 `tool_call: false` **不阻止**它发送工具声明——端到端实测收到的是**非空 26 项**数组。所以"只有恢复旧会话才发空数组"是错的，非空必须接受。

### 5.4 接受并折叠：system / developer 角色

| role | 处置 |
| --- | --- |
| `user` / `assistant` | 对话轮，原样透传 |
| `system` / `developer` | **指令载体**，被 `foldMessagesToPrompt` 折叠进 prompt 上下文，在 `zcc.roles_folded` 里逐名披露 |
| `tool` / `function` / 其它 | **422 `unsupported_role`**，指名 `messages[i].role` |

折叠格式是 `${role}: ${content}`，换行连接——**与多轮折叠同一条机制、同一种行格式**。**保持原始顺序**（不把末尾的 system 轮偷偷提到前面）：顺序即语义，提序也是一种静默改写。

消息级被拒字段（422）：`name` / `tool_calls` / `tool_call_id` / `function_call` / `refusal` / `audio` / `reasoning_content`。

**披露的边界（别把它读大了）：** `roles_folded` 只说"折叠了哪些 role"。它**不**宣称折叠后的内容与官方 agent 自己的系统提示同优先级——官方 app-server 另有一套自己的系统提示，我们的 system/developer 行是**用户轮文本里的指令**，真实指令优先级由官方 agent 决定。

### 5.5 C 类：仍然拒绝（422 `unsupported_parameter`）

| 字段 | 拒绝理由（逐字） |
| --- | --- |
| `stop` | 本端点不实现 stop 序列（收下但忽略 = 静默丢掉截断语义） |
| `logprobs` | 本端点不返回 logprobs |
| `top_logprobs` | 本端点不返回 logprobs |
| `logit_bias` | 本端点不实现 logit_bias |
| `response_format` | 本端点不实现结构化输出 |
| `parallel_tool_calls` | 本端点不实现工具调用 |
| `functions` | 本端点不实现函数调用 |
| `function_call` | 本端点不实现函数调用 |
| `modalities` | 本端点只输出文本 |
| `prediction` | 本端点不实现预测续写 |
| `audio` | 本端点不实现音频 |
| `web_search_options` | 本端点不实现内置联网检索 |
| `prompt_cache_options` | 本端点没有提示缓存可配置 |
| `moderation` | 本端点不做按请求的输出审核旋钮 |
| `tool_choice: "required"` / `"any"` / 具名指定对象 | 要求必须调工具 → 会让客户端等一个**永远不会来的** `tool_calls` |
| `stream_options.<其它键>` | 本端点不实现（只接受 `include_usage` / `include_obfuscation`） |

> **`parallel_tool_calls` 为什么还留着：** 它是 `tools` 的从属开关，单独接受它等于宣称"支持并行工具调用开关但不支持工具调用"，自相矛盾；真客户端也不发它。

---

## 6. 接线：MiniMax Code 及其它 OpenAI 兼容客户端

### 6.1 通用通则

任何 OpenAI 兼容客户端，填三样：

| 项 | 值 |
| --- | --- |
| baseURL | `http://127.0.0.1:8790/v1` |
| API key | 你自己设的 `ZCC_API_KEY` |
| model | 目录里的 `modelId` 原文（含 `::`） |

**注意**：

- **不要带 `Origin` 头。** CORS 永不开启，`allowedOrigins` 缺省为空数组，**任何带 `Origin` 的请求都被拒**（403 `origin_not_allowed`）。浏览器发起的跨源请求因此读不到任何响应；IDE 扩展和 curl 这类非浏览器客户端不受影响。
- **`Host` 头必须是监听地址**，否则 403 `host_not_allowed`（防 DNS rebinding）。
- **不要发 `tool_choice: "required"`**（§5.5）。
- 浏览器里直连会失败；IDE 插件（非浏览器进程）可以。

### 6.2 MiniMax Code（真实用例，mcode@0.5.6）

配置文件：`C:\Users\<你的用户名>\.minimax\config.yaml`。

```yaml
custom_provider:
  zcc-companion:
    name: ZCC Companion
    kind: custom
    enabled: true
    api: openai-completions
    options:
      apiKey: <你的密钥>
      baseURL: http://127.0.0.1:8790/v1
      authMode: api-key
    models:
      account:bigmodel-individual-coding-plan::GLM-5.3-Flash:
        name: GLM-5.3-Flash (ZCC)
        limit:
          context: 1000000
        reasoning: true
        tool_call: false
        thinking:
          effortOptions:
            - low
            - high
            - max
          effort: low
          defaultEffort: low
        thinking_config:
          mode: switchable
          default_value: "true"
```

**逐项要点：**

| 字段 | 值 | 为什么 |
| --- | --- | --- |
| `api` | `openai-completions` | mcode 走 `@ai-sdk/openai-compatible`。**不能写 `openai-responses`**。 |
| `options.apiKey` | 明文 | **这是 mcode 唯一支持的落盘形态**（`--api-key-env` 只在 `add` 时读一次，之后不读）。要接受这一点，或换客户端。 |
| `models` 的键 | 完整 `modelId` 含 `::` | 目录 id 原文。YAML 里含 `:` 的 key 建议整体不加引号（本仓实跑配置如此）。 |
| `limit.context` | `1000000` | 客户端侧的上下文预算提示，需与目录 `contextLength` 一致。 |
| `tool_call` | `false` | 本端点是**纯对话形态**（`tools_forwarded` 恒 0）。写 `true` 只会让客户端等一个不来的 `tool_calls`。 |
| `thinking.effortOptions` | `[low, high, max]` | 必须与本端点 `reasoning_effort` 闭集逐字一致。 |
| **`thinking.defaultEffort`** | **`low`** | **← 这个是坑，见下。** |

### 6.3 ⚠️ `defaultEffort` 那个坑

**`effort: low` 不是真正钉住档位的字段，`defaultEffort: low` 才是。**

`defaultEffort` 缺失时，mcode 的真实回落是 `Math.floor(len/2)` 取中间项。对 `[low, high, max]` 即 **`high`**。

后果：**任何工具重写这个块时如果丢了 `defaultEffort`，实际档位会静默变 high，而且不报错。** 排查"为什么明明配了 low 却用高档位"时，先看 `defaultEffort` 在不在。

命令行也可以显式覆盖（已实跑通过）：

```bash
mcode exec --model custom_provider:zcc-companion/account:bigmodel-individual-coding-plan::GLM-5.3-Flash --effort low
```

### 6.4 mcode 实际会发哪些字段（来源逐条可查）

`chat.ts` 的 `MCODE_FIELD_SOURCES` 把真实客户端的请求体组装过程逐字记进了代码。实测字段集：

**恒发**：`model`、`messages`、`stream`（本通道恒为流式）、`stream_options: {include_usage: true}`、`store: false`（对自定义 baseURL 恒为 true）、`max_completion_tokens`（**不是** `max_tokens`——`maxTokensField` 缺省值）、`reasoning_effort`。
**条件发**：`tools`（本机实测非空 26 项）、`temperature`、`prompt_cache_key` / `prompt_cache_retention`（仅 `PI_CACHE_RETENTION=long`）。
**不发**：`tool_choice`、`max_tokens`（除非配了 `compat.maxTokensField: "max_tokens"`）。

mcode 的 `ke()` 逐字是 `e.reasoning && t.supportsDeveloperRole ? "developer" : "system"`——**只要客户端配了系统提示词就必然命中**（本机 `reasoning: true` + 缺省 `supportsDeveloperRole: true` ⇒ 恒发 `developer`）。这就是 §5.4 必须接受 `developer` 的原因。

---

## 7. 模型选择

### 7.1 id 形态

```
account:<plan>::<model>
```

`account:` 是**唯一允许的通道前缀**（订阅通道白名单）。`::` 分隔套餐维度与模型维度。

**一条目录条目 = 一个（套餐 × 模型）组合**，不是"去重后的模型"。同一个 `GLM-5.3` 在 Individual Coding Plan 下是 `subscription`、在 Start Plan 下是 `promotion`——按裸 modelId 去重就必须给同一个 id 塞一个计费类别，那等于替你在两种权益之间随便挑一个。

### 7.2 本机实测的 18 条目录

来源：`C:\ZCode\resources\config\provider\zcode-builtin.json` 的 `config.providerConfigRules.providerRules`（只读，8 个 providerRule × 各自的 `builtinModelIds`）。

| modelId | 套餐 | 计费类别 | 可服务 |
| --- | --- | --- | --- |
| `account:bigmodel-individual-coding-plan::GLM-5.3` | 个人订阅 | `subscription` | ✅ |
| `account:bigmodel-individual-coding-plan::GLM-5.3-Flash` | 个人订阅 | `subscription` | ✅ |
| `account:bigmodel-start-plan::GLM-5.3-Flash` | 免费额度 | `promotion` | ✅ |
| `account:bigmodel-start-plan::GLM-5.2` | 免费额度 | `promotion` | ✅ |
| `account:bigmodel-start-plan::GLM-5-Turbo` | 免费额度 | `promotion` | ✅ |
| `account:bigmodel-team-coding-plan::GLM-5.3` | 团队 | `subscription` | ❌ 如实不支持 |
| `account:bigmodel-team-coding-plan::GLM-5.3-Flash` | 团队 | `subscription` | ❌ 如实不支持 |
| `account:bigmodel-offpeak-idle-plan::GLM-5.3` | 错峰 | `unknown` | ❌ 无缓存键 |
| `account:bigmodel-offpeak-idle-plan::GLM-5.3-Flash` | 错峰 | `unknown` | ❌ 无缓存键 |
| `account:zai-individual-coding-plan::GLM-5.3` | 个人订阅 | `subscription` | ⚠️ fail-closed |
| `account:zai-individual-coding-plan::GLM-5.3-Flash` | 个人订阅 | `subscription` | ⚠️ fail-closed |
| `account:zai-team-coding-plan::GLM-5.3` | 团队 | `subscription` | ❌ 如实不支持 |
| `account:zai-team-coding-plan::GLM-5.3-Flash` | 团队 | `subscription` | ❌ 如实不支持 |
| `account:zai-start-plan::GLM-5.3-Flash` | 免费额度 | `promotion` | ✅（已实弹验证） |
| `account:zai-start-plan::GLM-5.2` | 免费额度 | `promotion` | ✅ |
| `account:zai-start-plan::GLM-5-Turbo` | 免费额度 | `promotion` | ✅ |
| `account:zai-offpeak-idle-plan::GLM-5.3` | 错峰 | `unknown` | ❌ 无缓存键 |
| `account:zai-offpeak-idle-plan::GLM-5.3-Flash` | 错峰 | `unknown` | ❌ 无缓存键 |

> 计费类别映射（`PLAN_ACCESS_MODE_BILLING`）：`individual-coding-plan` → `subscription`，`team-coding-plan` → `subscription`，`start-plan` → `promotion`，`off-peak` → `unknown`。
>
> **目录条数随官方 builtin 变化。** 18 是 2026-10-02 本机实测值，以 `GET /v1/zcc/catalog` 的实时返回为准。

### 7.2.1 `reasoning` / `contextLength` 逐模型不同

目录的 `reasoning` 是**官方 model rules 逐条解析**出来的，按模型不同：

| 模型 | contextLength | `reasoning` | `capabilities` |
| --- | --- | --- | --- |
| `GLM-5.3` | 1000000 | `low` / `high` / `max` | `text`, `tool_call`, `output_text` |
| `GLM-5.3-Flash` | 1000000 | `low` / `high` / `max` | `text`, `image`, `video`, `pdf`, `tool_call`, `output_text` |
| `GLM-5.2` | 1000000 | `disabled` / `high` / `max` | `text`, `tool_call`, `output_text` |
| `GLM-5-Turbo` | 200000 | `disabled` / `enabled` | `text`, `tool_call`, `output_text` |

**注意这里的口径差异**：目录的 `reasoning` 是**官方能力**的如实转写，**不等于**本端点 `reasoning_effort` 的合法闭集（§5.1 的 `low` / `high` / `max`）。给 `GLM-5.2` 发 `reasoning_effort: "low"` 会被 API 层 422——目录说官方支持 `disabled`/`high`/`max`，本端点只认 `low`/`high`/`max`，交集会误导。

选模型时**以 `reasoning` 含 `low` 的那几条为准**（`GLM-5.3` 与 `GLM-5.3-Flash`），这是本端点三档推理都能用的全集。

### 7.3 两条通道

| 通道 | 凭据真身 | 特点 |
| --- | --- | --- |
| `start-plan`（免费额度） | `zcodejwttoken`（JWT），**不是** `access_token` | 桌面 `AccountProviderRequestAuthService.resolveCurrent` 逐字：`planKind === 'start-plan'` → `loadOAuthTokenSet(family)`，取回的字段名是 `zcodeJwtToken`。**仓里没有 start-plan 的 api-key 条目是设计使然**，不是缺凭据。 |
| `individual-coding-plan`（订阅） | `account-provider:coding-plan:<providerId>:account:<encodeURIComponent(账号身份)>:api-key` | 账号身份真身 = `oauth:<oauthProviderId>:user_info` 的 `.id`。 |

**start-plan 与 individual-coding-plan 的真实差异**：`describe()` 拿 `status` 时 start-plan 通道**早在任何 selection / 逐 provider 凭据校验之前早退**（桌面 `Rp` @271378023 的 `mode === 'start-plan'` 早退分支）。两条通道都实弹跑通过（start-plan 15.2s / individual 首次真实跑通 34019 prompt tokens）。

### 7.4 zai 族：本机无凭据时 fail-closed

`account:zai-*` 族在**本机没有对应凭据条目**时**如实失败**，绝不硬推 `entitled: true` 去"试一发"。

失败形态：官方本地缓存未显示该套餐可用 → `503 upstream_unavailable`，消息里带 `entitlement_reason` 与 `observed_at`。

**这是设计。** 官方那份 coding-plan-cache 是**快照**：`availabilityObservedAt` 只证明"某时刻 refresh 返回 available"，不证明"现在仍然 available"。宁可如实失败，也不编造资格。

**解法**：在 ZCode 里登录对应账号，让凭据仓真的出现条目。

### 7.5 team 族：如实不支持

```
PLAN_KIND_UNSUPPORTED: team-coding-plan 需要官方 resolveTeamPlanApiKey 的实时应答，
本地凭据仓里没有对应条目；本版显式不支持，不猜键名。
```

团队套餐和 off-peak 套餐在官方 `builtin:*` 缓存键映射里**没有键**，所以可用性只能落 `unknown`——这就是"不外推"的具体含义。

---

## 8. 成本与延迟形状（如实）

**这一节全是真实消耗，没有优化空间可许诺。**

### 8.1 Prompt tokens

| 场景 | prompt tokens | 说明 |
| --- | --- | --- |
| 纯对话（无工具上下文） | **~20k – 27k** | 官方 agent **自带系统提示**的固有开销，**每轮都带** |
| 官方 agent 带工具上下文（真实编程任务） | **~34k – 41k** | 工具定义 + 沙箱上下文 |

实测样本：单轮中文 27209；订阅通道首次真实 34019；带工具建文件任务 40800。

**这 2 万 token 不是你写的 prompt，是你问的那句话之外，官方 agent 每次都带的那一整套系统提示。** 缩短你的 prompt 对它几乎没有影响。

### 8.2 延迟

| 环节 | 耗时 |
| --- | --- |
| 官方 app-server 进程启动（含 MCP 启动） | **~5s**（首个请求） |
| 单轮总延迟 | **11 – 21s** |
| 长生成（~400 字 / 327 completion tokens） | 21.3s |
| 单请求墙钟上限 | **300s**（见 §10） |

### 8.3 每请求全新进程

**没有进程池、没有跨请求状态复用。** 每次请求 spawn 一枚官方 app-server，用完即收。

- 好处：官方 bundle 任何崩溃（`process.exit` / 未捕获异常 / 段错误）都只是子进程的 `exit` 事件，API 服务进程继续服务；崩溃的一次请求不会污染下一次。
- 代价：每次付一次 ~5s 的进程 + MCP 启动。

**并发的现实含义**：两个并发请求 = 两个官方子进程同时跑。默认限流 `maxConcurrent: 4`、`requests: 60` / `windowMs: 60000`（每个 key 指纹独立计），超限直接 429 **不排队**（带 `retry-after` 与 `x-zcc-ratelimit-*` 头）。

---

## 9. 安全模型

### 9.1 网络面

| 措施 | 实现 |
| --- | --- |
| 只绑回环 | 绑定地址恒为 `127.0.0.1`，**不暴露为配置**。传 `0.0.0.0` / `::` / 主机名在**构造期**抛 `LOOPBACK_ONLY` |
| Bearer 必填 | 无 key 不启动；请求无 key 401 `unauthorized` + `www-authenticate: Bearer` |
| 错误不回显 key | 401 只说"需要有效的本机 API key"，绝不说"你给的 key 不对"、更不回显任何 key 片段。日志只出现 `zcc-fp:*` 指纹 |
| Host 闸门 | `Host` 头必须是监听地址，防 DNS rebinding |
| Origin 闸门 | 白名单**恒为空**，带 `Origin` 的请求全拒。CORS 永不开启，`OPTIONS` 一律 405 |
| 体积闸门 | 1 MiB 请求体上限，超限**不缓冲** |

### 9.2 凭据

**凭据明文只存在于子宿主进程内存。** 解密与 port 构造全在子进程内完成，明文**从不**经过父子之间的管道——因此连"父进程内存里存在过明文"这件事都不成立。

日志与诊断：

- `x-zcc-detail` 里的凭据位置信息经 `redactCredentialText` 擦除。
- `ZCC_HOST_DEBUG=1` 时子宿主把**零凭据**的会话摘要打到它自己的 stderr；父进程**只对 stderr 计数，内容从不读取、从不转发**。
- 启动横幅只打印 `keyFingerprint`（`zcc-fp:*` 形态），不打印 key 本身。

### 9.3 存储隔离

子宿主 env 被**无条件覆盖**以下键（每一行都有官方逐字依据）：

| 键 | 值 | 作用 |
| --- | --- | --- |
| `ZCODE_STORAGE_DIR` | `<隔离目录>` | CLI 存储根（settings / **会话 rollout** / plugins / skills） |
| `ZCODE_SESSION_DB_PATH` / `ZCODE_SESSION_DB` | `<隔离目录>/cli/db/db.sqlite` | 会话 SQLite |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | 官方真实 builtin 资产（**只读**） | 官方 registry 的硬前置条件 |
| `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` | `<隔离目录>/v2/provider_config.json` | 同上；隔离是因为官方会规范化回写它 |
| `ZCODE_LOG_DIR` | `<隔离目录>/cli/log` | 日志目录 |
| `ZCODE_RUNTIME_ENV` | `"test"` | **BL-4**：`recordModelIO` 关闭 → 不写 `~/.zcode/cli/rollout` |

隔离目录缺省 `%TEMP%\zcode-companion-official-host`，工作区在其下的 `workspace\`。

**安全闸门**：隔离目录一旦落在 ZCode 存储根内，抛 `STORAGE_ISOLATION_UNSAFE` 拒绝下发。

**刻意不设** `ZCODE_DATA_BASE_DIR`：它的消费点会把 `.zcode/v2/credentials.json`（凭据仓）一起搬离真实路径，而我们要读真实仓解 key。

### 9.4 幂等：显式 opt-in

**一个幂等头都没发的请求 = 不进幂等表**：不重放、不比对 bodyHash、不 409，响应头 `x-zcc-idempotency: none`。

| 你发的头 | 作用域 | 语义 |
| --- | --- | --- |
| `Idempotency-Key: <token>` | 该 token + key 指纹的规范化哈希 | **同一次操作重试** |
| `x-zcc-client-id` / `x-zcc-session-id` | 逐会话作用域 | 会话身份 |
| 都不发 | 无 | `x-zcc-idempotency: none` |

**只登记 2xx。** 失败与结果未知**不写入**幂等表，也**不自动重发**（`auto_resend_allowed` 恒 `false`）——无额度不是一次"已完成的操作"，登记下来会把临时状态固化成永久重放。超预算或失败的登记返回 `idempotency_replay_unavailable`（409）。

> **历史坑（已修）：** 旧实现缺头时回落到 `default-client` / `default-session`，让所有标准 OpenAI 兼容客户端落进同一作用域，首个成功请求后全线 409（实弹 0.003s 复现）。这是本 API 唯一的 CRITICAL 硬阻断，现已改为显式 opt-in。

### 9.5 付费通道硬拒

**唯一允许的通道前缀是 `account:`（订阅通道）。** 判定在**取键之前**完成，命中即拒且**不触网**。

付费/按量计费通道黑名单（闭集，用于让错误回执指名道姓；判定本身由 `account:` 前缀白名单完成）：

```
bigmodel-api
zai-api
zai-standard-api
builtin:bigmodel
builtin:zai
```

拒答形态：`CHANNEL_REFUSED: paid channel blocked`。这两个判据是**独立**的（白名单 + 黑名单），错误码区分 `channel_not_allowlisted` 与 `blocked_channel`。

### 9.6 配置面

- **入口环境变量是闭集**：任何未知 `ZCC_*` 键 → 拒绝启动（`UNKNOWN_ENV_KEY`），不静默忽略。
- **未知 CLI flag** → 拒绝启动（`UNKNOWN_FLAG`）。
- 未知 `ZCC_*` 值含 `\r` / `\n` → 拒绝（`INVALID_ENV_VALUE`）。
- 闭集取值一律 fail-closed：推理档位、权限档位、工具策略、调试开关**在服务还没起来时**就指名报错，而不是让运维以为配置生效了。

---

## 10. 已知边界

### 10.1 单请求 300s 墙钟

官方 session 驱动的会话超时是 `SESSION_TIMEOUT_MS = 300_000`。这是**硬顶**，对超长生成会撞上。

撞上后表现为：请求挂到 300s 才失败。**先查第四类反请求**（§10.4）。

### 10.2 外部客户端 = 纯对话形态

**不能回调客户端的工具。** 客户端声明的工具会被接受、计数、然后**一条也不转发**（`tools_forwarded` 恒 0），产出里永远不含 `tool_calls`。

这不是可调策略而是结构事实：驱动器契约 `DriverRequest` 上没有工具槽位，官方 `session/send` 也只收一条 `content` 文本。

### 10.3 官方 agent 自己的工具在隔离沙箱里自动允许

**这是与上一条完全不同的两件事，别混为一谈：**

- 客户端声明的工具 → **零转发**（§10.2）。
- 官方 agent **自己**的工具（读文件、写文件、跑命令）→ 在**隔离沙箱**（`<隔离目录>\workspace\`）里执行，权限档位由 `ZCC_HOST_PERMISSION_MODE`（缺省 `yolo`，官方逐字 `"Yolo mode bypasses permission prompts"`）与 `ZCC_HOST_TOOL_POLICY`（缺省 `allow`）控制。

实测：官方 agent 建文件成功，无挂死，文件落隔离沙箱。

**改 `ZCC_HOST_TOOL_POLICY=deny` 会如实回拒绝。** 缺省 `allow` 的理由是：工作区在隔离临时目录，且子宿主**没有**交互式用户通道——"不答"只会被官方的 `requestClient` 挂到 300s 墙钟上限（官方那条权限请求逐字**没有** `timeoutMs`）。

### 10.4 MCP 授权 / 浏览器执行两类反请求未接

官方会向宿主发**反向请求**。目前**未接**的两类：

1. `interactionRequestOfficialMcpAuthHeaders`（MCP 授权）
2. 浏览器执行（`browserExecute`）

**官方这两类请求逐字没有 `timeoutMs`**，不答就一直挂到 300s 墙钟。

> **排查口诀：任何"挂死到 300s"的问题，先查这两类反请求。** 其余原因排在这后面。

### 10.5 `max_tokens` 接受但不强制

official-host 的 `enforcesMaxTokens: false`。官方 `session/create` 的 params schema 是 `.strict()` 且逐字没有上限槽位（嵌套 `model` 的 schema 同样 `.strict()`、同样没有），把上限塞进去会被官方 `-32602 Invalid params` 拒掉。

所以上限走"接受 + 校验 + 如实披露未转发"：客户端发的是 `max_completion_tokens`，`parameters_not_forwarded` 里就会看到 `max_completion_tokens`（**逐字用客户端发来的键名**，报成别的名字等于告诉它一件与它无关的事）。

### 10.6 其它

| 边界 | 说明 |
| --- | --- |
| Windows only | 官方 bundle 路径与隔离目录都是 Windows 形态 |
| 每请求新进程 | 无进程池，~5s 固定开销/请求（§8.3） |
| 凭据落盘形态 | mcode 侧 API key 只能明文落 `config.yaml`（§6.2） |
| `ZCC_HOST_STORAGE_DIR` / `ZCC_HOST_WORKSPACE` | 驱动器读、入口拒（§3.7） |
| 团队/错峰套餐 | 如实不支持（§7.5） |
| 幂等重放 | 重放 Companion 侧 operation，**不代表上游 exactly-once**（`x-zcc-idempotency-scope` 头如实写明） |

---

## 11. 排障表

| 现象 | 状态码 / 错误码 | 含义与解法 |
| --- | --- | --- |
| **401** `unauthorized` | 401 | 缺 `Authorization: Bearer <你的密钥>`，或 key 与 `ZCC_API_KEY` 不一致。错误消息**不会**告诉你 key 哪一段错了。核对启动横幅里的 `zcc-fp:*` 指纹。 |
| **422** `unsupported_parameter` | 422 | 字段被拒。**错误消息自带解法**——它逐字写出这条为什么被拒、以及合法值域。照着改即可。常见：发 `tool_choice: "required"`（§5.5）、发 `stop` / `response_format`、A 类字段超值域。 |
| **422** `unsupported_role` | 422 | `messages[i].role` 用了 `tool` / `function` / 其它。错误里指名**具体下标**。工具结果轮压成 user 会静默改变语义，这条路在代码里不存在。 |
| **422** `unsupported_parameter`（reasoning） | 422 | `reasoning_effort` 用了闭集外的值（如 OpenAI 的 `medium`）。合法值只有 `low` / `high` / `max`。 |
| **400** `unknown_field` | 400 | 请求体里有既不接受也不在拒表里的字段。本端点**不静默丢弃**未识别字段。 |
| **409** | 409 | **只在你显式发了幂等头时发生**。`idempotency_conflict` / `idempotency_in_progress` / `idempotency_replay_unavailable`。**没发任何幂等头就不会有 409**（响应头是 `x-zcc-idempotency: none`）。解法：换一个新的 `Idempotency-Key`，或不发。 |
| **挂死到 300s** | — | **先查第四类反请求**：MCP 授权 / 浏览器执行未接（§10.4）。官方这两类请求无 `timeoutMs`，不答就一直挂。然后查 `ZCC_HOST_TOOL_POLICY=allow` 是否覆盖了你以为会挨问的那类工具。 |
| `CREDENTIAL_ENTRY_MISSING` | 凭据层 | 凭据仓里没有对应套餐的条目。错误消息**只报键名，不报任何值**。解法：在 ZCode 里登录对应账号。注意 `start-plan` 的凭据是 `zcodejwttoken` 而非 `access_token`——**仓里没有 start-plan 的 api-key 条目是设计使然**，别当缺凭据。 |
| `HOST_REASONING_UNKNOWN` | 启动期 | `ZCC_HOST_REASONING` 不在 `low` / `high` / `max` 内。**在服务启动前就报**，不会等到第一次请求。 |
| `PLAN_KIND_UNSUPPORTED` | 凭据层 | team 套餐。本版显式不支持（§7.5）。 |
| `PROVIDER_FAMILY_UNKNOWN` | 凭据层 | providerId 不在已核的 `account:z*` / `account:bigmodel*` 命名内。**不猜 family，也不默认成 zai**。 |
| `503 upstream_unavailable` | 503 | 上游不可用：驱动器没挂、没额度、或缓存未显示该套餐可用。看 `x-zcc-status` 头与响应 `zcc.status`。 |
| `404 model_not_found` | 404 | `model` 不在可服务集内。目录用 `GET /v1/zcc/catalog` 查，id 要含 `::`。 |
| `403 origin_not_allowed` | 403 | 请求带了 `Origin` 头。CORS 永不开启（§6.1）。 |
| `403 host_not_allowed` | 403 | `Host` 头不是监听地址。 |
| `429 rate_limited` | 429 | 超并发（默认 4）或速率（默认 60/分钟）。**直接拒绝不排队**，看 `retry-after` 头。 |
| `413 payload_too_large` | 413 | 请求体 >1 MiB，或 `messages` >256 条。 |
| `UNKNOWN_ENV_KEY` | 启动期，退出码 2 | 有不在入口闭集里的 `ZCC_*` 键。错误消息列出已知键。 |
| `FIXTURE_DRIVER_TEST_ONLY` | 启动期，退出码 2 | 试图用配置启用 fixture 驱动器。这是设计（§3.4）。 |
| `STORAGE_ISOLATION_UNSAFE` | 启动期 | 隔离目录落在 ZCode 存储根内，拒绝下发。 |
| `LISTEN_FAILED` | 启动期，退出码 1 | 端口占用。 |

**通用起手式：**

```bash
# 1. 看服务是否活着、健康状态如何（不需要 key 也知道状态头长什么样）
curl -sS -i http://127.0.0.1:8790/v1/models -H "Authorization: Bearer <你的密钥>" | head -20

# 2. 看目录
curl -sS http://127.0.0.1:8790/v1/zcc/catalog -H "Authorization: Bearer <你的密钥>"

# 3. 最小聊天请求（把请求体写文件，避免 shell 内联中文乱码）
```

> **方法学提醒**：中文请求体**一律走文件**（`--data-binary @body.json`），不要用 shell 内联。实测内联中文会产生乱码，那是传输层的问题不是产品的 bug，但会浪费一次排查。

---

## 12. 测试

```bash
npm run ci
```

`ci` = `typecheck` + `typecheck:checkjs` + `typecheck:apps` + `test`。

**当前状态（2026-10-02 实测）：20 个测试文件 / 765 个用例全绿。**

| 项 | 值 |
| --- | --- |
| 测试文件 | 20（`tests/unit/**` + `tests/contract/**`） |
| 用例 | 765 |
| 框架 | vitest 5.0.2 |
| 超时 | 15s / 用例 |

`vitest.config.ts` 里 `passWithNoTests: false` 是刻意的：**空测试目录必须以非零码退出**。`tests/integration` / `mutations` / `e2e` 三个类别**未接线**，它们的 npm 门经 `scripts/stage-gate.mjs` 以 `NOT_IMPLEMENTED` fail-closed。

测试保持 **provider-free**：不启动官方 app-server、不发模型请求、不碰生产服务或数据库。

**契约测试用静态钉守着几条关键不变式**，改代码时会立刻变红：

- `reasoning_effort` 闭集与 `KNOWN_REASONING_LEVELS` **逐字相等**（入口与驱动器两处都查同一张表）
- `tools_forwarded` 恒为 `0`
- `DriverRequest` 上**没有**工具槽位
- 付费通道黑名单闭集全集
- 断言只增不减（零 `skip` / `todo` / `only` / `fails`）

---

## 附：源码索引

本文档每条事实的核对来源：

| 主题 | 文件 |
| --- | --- |
| 环境变量闭集、CLI 参数、帮助文本、启动横幅 | `packages/api/bin/start-api.mjs` |
| 路由、`zcc` 块组装、网络门、限流、幂等头 | `packages/api/src/server.ts` |
| 请求字段接受/折叠/披露/拒绝全部规则 | `packages/api/src/chat.ts` |
| 错误码 → 状态码映射 | `packages/api/src/errors.ts` |
| Bearer 校验、限流参数、幂等 opt-in 解析 | `packages/api/src/auth.ts` |
| 子进程 spawn、存储隔离 env、推理档位映射、凭据取用 | `packages/official-host/src/host-driver.ts` |
| 凭据仓条目键构造、错误码闭集 | `packages/official-host/src/credentials.ts` |
| 付费通道白名单/黑名单 | `packages/official-host/src/headers-port.ts` |
| 套餐缓存键映射、`entitled` 推导 | `packages/official-host/src/entitlement.ts` |
| 目录构造、计费类别映射、offeringId 拆分 | `packages/plansrc/src/mapper.ts` |
| 官方本地文件路径解析 | `packages/plansrc/src/reader.ts` |
| npm 脚本、Node 版本要求 | `package.json` |
