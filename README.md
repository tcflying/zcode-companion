# ZCode Companion

**把本机已登录 ZCode 的订阅/套餐模型，经一条 OpenAI 兼容 HTTP API 提供给其它 IDE 使用。**

ZCode Companion 是一个**独立运行的软件**——不装进 ZCode、不改 ZCode 安装目录。它在本机起一条 OpenAI 兼容 HTTP API，把你 ZCode 里**已经付费订阅的那份额度**暴露成任何 OpenAI 兼容客户端都能调的模型服务。在 MiniMax Code、其它 IDE 插件、脚本里直接用已在 ZCode 订阅的模型，不必再单独买一份 API key。

> 本文是**索引与速览**。全部环境变量、请求字段规则、错误码与排障细节见 [`docs/USAGE.md`](docs/USAGE.md)。

---

## 三条核心特性

### 1. 零侵入

不碰你的 ZCode 安装：

| 承诺 | 落地方式 |
| --- | --- |
| 不改 `C:\ZCode` 下任何文件 | 全程只读引用官方 bundle 与配置资产；`git status` 与文件 mtime 不变 |
| 不重启 ZCode 桌面 | 每请求 spawn 一个独立 app-server 子进程，与桌面进程无生命周期耦合 |
| 凭据不落盘 | 凭据明文**只存在于子进程内存**，父进程连解都不解，明文**不经过父子管道** |
| 不污染你的会话 | 子宿主存储目录 / 会话 DB / 日志目录全部重定向到隔离临时目录，model-io rollout 关闭 |

代价是**效率形态**（官方 agent 自带系统提示 + 每请求全新进程），见 [成本与延迟](docs/USAGE.md#8-成本与延迟形状如实)。这是真实的开销，本文不粉饰。

### 2. 凭据不落盘

解密与 port 构造**全在子进程内**完成，凭据明文**从不**经过父子之间的管道——因此连"父进程内存里存在过明文"这件事都不成立。启动横幅只打印 key 指纹（`zcc-fp:*` 形态），不打印 key 本身。

### 3. 付费通道白名单

**唯一允许的通道前缀是 `account:`（订阅通道）。** 判定在**取键之前**完成，命中即拒且**不触网**。按量计费通道（`bigmodel-api` / `zai-api` / `builtin:*` 等）一律硬拒，错误码区分 `channel_not_allowlisted` 与 `blocked_channel`。

---

## 5 分钟速览

前置：**Windows**、Node **>= 24.18.0**、npm **>= 11.16.0**、ZCode 已登录。完整核对表见 [`docs/USAGE.md` §2](docs/USAGE.md#2-前置要求)。

### 步骤 1 — 安装依赖

在工程根执行，再进 `apps/ui` 执行一次：

```bash
npm install
cd apps/ui && npm install && cd ../..   # apps/ui 有独立 package.json，根 install 不覆盖
```

> 漏掉第二步时 `npm run ci` 的 `typecheck:apps` 会因缺 react 类型变红。PowerShell 写法见 [`docs/USAGE.md` §2.1](docs/USAGE.md#21-安装依赖两步缺一不可)。
>
> 只有要**打包 / 验包**（[`docs/USAGE.md` §13.6](docs/USAGE.md#136-打包)）时才需要第三步 `cd apps/desktop && npm install`：`apps/desktop` 同样有独立 `package.json`，根 install 一样不覆盖。缺它时 `pack:win` / `verify:package` 以 exit 4 `GATE_PREREQUISITE_MISSING` 硬失败；`npm run ci` 不含这两道门。

### 步骤 2 — 设密钥并启动

`ZCC_API_KEY` 是**你自己选的**本机 API key（不是 ZCode 凭据，也不是厂商 key），只用于本机回环端口的 Bearer 认证。

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

> 缺省端口 **8790**，绑定地址**恒为 `127.0.0.1`**、不暴露为配置项。`--api-key` flag 存在但不推荐（会进 shell 历史与进程列表），请用环境变量。完整环境变量闭集见 [`docs/USAGE.md` §3.4](docs/USAGE.md#34-完整环境变量表闭集)。

### 步骤 3 — curl 一发

中文请求体**一律走文件**，不要 shell 内联（内联会产生乱码，那是传输层的问题不是产品 bug）。把请求体写进 `body.json`：

```json
{
  "model": "account:bigmodel-individual-coding-plan::GLM-5.3-Flash",
  "messages": [ { "role": "user", "content": "你好" } ],
  "reasoning_effort": "low"
}
```

```bash
curl -sS http://127.0.0.1:8790/v1/zcc/catalog -H "Authorization: Bearer <你的密钥>"
curl -sS http://127.0.0.1:8790/v1/chat/completions -H "Authorization: Bearer <你的密钥>" --data-binary @body.json
```

### 步骤 4 — 接到 MiniMax Code

配置文件 `C:\Users\<你的用户名>\.minimax\config.yaml`，任何 OpenAI 兼容客户端填三样即可：

| 项 | 值 |
| --- | --- |
| baseURL | `http://127.0.0.1:8790/v1` |
| API key | 你自己设的 `ZCC_API_KEY` |
| model | 目录里的 `modelId` 原文（含 `::`） |

> **不要带 `Origin` 头**（CORS 永不开启，带 `Origin` 一律 403）；`Host` 头必须是监听地址。完整 `config.yaml` 片段与逐项要点见 [`docs/USAGE.md` §6](docs/USAGE.md#6-接线minimax-code-及其它-openai-兼容客户端)，其中 §6.3 记录了一个会让档位静默变 `high` 的坑（`defaultEffort` 缺失）。

---

## 端点一览

三条路径，职责不混用，**全部要求 `Authorization: Bearer <你的密钥>`**：

| 端点 | 用途 |
| --- | --- |
| `GET /v1/zcc/catalog` | 本产品界面的目录（`revision` + `models`，七键逐项校验） |
| `GET /v1/models` | 给外部 IDE 的**纯 OpenAI 形状**模型列表（不带 `zcc` 扩展块） |
| `POST /v1/chat/completions` | 标准 OpenAI chat completions，`stream: true` 走 SSE |

`POST /v1/chat/completions` 的每个响应都带一个 `zcc` 扩展块（`stream: true` 与 `stream: false` 两路同形；另两条路径不带这个块）——**不读文档也能从响应里看出哪些参数没生效**（`parameters_not_forwarded`、`roles_folded`、`tools_forwarded`、`model_is_real` 等 15 个键）。字段规则见 [`docs/USAGE.md` §4–§5](docs/USAGE.md#4-端点)。

---

## 模型通道

id 形态 `account:<plan>::<model>`，**一条目录条目 = 一个（套餐 × 模型）组合**。

| 通道 | 计费类别 | 凭据真身 |
| --- | --- | --- |
| `start-plan` | `promotion`（免费额度） | `zcodejwttoken`（JWT），**不是** `access_token` |
| `individual-coding-plan` | `subscription`（订阅） | `account-provider:coding-plan:<providerId>:account:<账号身份>:api-key` |

两条通道都已实弹跑通（start-plan 15.2s / individual 首次 34019 prompt tokens）。本机实测 18 条目录、**8 条可服务**；`team-coding-plan` 如实不支持（`PLAN_KIND_UNSUPPORTED`），`off-peak` 无缓存键落 `unknown`，`account:zai-*` 族在本机无凭据时 **fail-closed** 返回 503 而不硬推 `entitled: true`。目录条数随官方 builtin 变化，**以 `GET /v1/zcc/catalog` 实时返回为准**。详见 [`docs/USAGE.md` §7](docs/USAGE.md#7-模型选择)。

---

## 安全模型要点

1. **只绑回环**——绑定地址恒为 `127.0.0.1`，传 `0.0.0.0` / `::` / 主机名在**构造期**抛 `LOOPBACK_ONLY`。
2. **Bearer 必填且不回显**——无 key 不启动；401 只说"需要有效的本机 API key"，绝不说"你给的 key 不对"、不回显任何片段，日志只有 `zcc-fp:*` 指纹。
3. **Host / Origin 双闸门**——`Host` 防 DNS rebinding；Origin 白名单**恒为空**，CORS 永不开启，`OPTIONS` 一律 405。
4. **存储隔离**——子宿主 env 无条件重定向 `ZCODE_STORAGE_DIR` / 会话 DB / 日志目录 / provider config；隔离目录一旦落在 ZCode 存储根内抛 `STORAGE_ISOLATION_UNSAFE` 拒绝下发。
5. **配置 fail-closed**——入口环境变量是**闭集**，未知 `ZCC_*` 键 / 未知 CLI flag / 闭集外取值在服务还没起来时就指名报错，不静默忽略。

完整安全模型见 [`docs/USAGE.md` §9](docs/USAGE.md#9-安全模型)。

---

## 已知边界

1. **单请求 300s 墙钟**——官方 session 驱动硬顶（`SESSION_TIMEOUT_MS = 300_000`），超长生成会撞上。挂死到 300s 时**先查 MCP 授权 / 浏览器执行两类反请求**（它们逐字没有 `timeoutMs`）。
2. **每轮 ~2-4 万 prompt tokens**——官方 agent 自带系统提示的固有开销，**每轮都带**；纯对话约 20k–27k，带工具的编程任务约 34k–41k。缩短你的 prompt 对它几乎没影响。
3. **外部客户端 = 纯对话形态**——客户端声明的工具会被接受、计数，然后**一条也不转发**（`tools_forwarded` 恒 0），产出里永远不含 `tool_calls`。这是结构事实不是可调策略。（官方 agent **自己**的工具在隔离沙箱里跑，是另外两回事。）
4. **`zai` / `team` 族限制**——`team-coding-plan` 显式不支持、不猜键名；`account:zai-*` 族本机无凭据时如实 503 fail-closed。

完整边界与排障表见 [`docs/USAGE.md` §10–§11](docs/USAGE.md#10-已知边界)。

---

## 测试

```bash
npm run ci
```

`ci` = `typecheck` + `typecheck:checkjs` + `typecheck:apps` + `test:ui` + `test`。

**当前状态：29 个测试文件 / 1006 个用例全绿**（vitest 5.0.2）——根工程 25 文件 / 884 用例（`test`），`apps/ui` 4 文件 / 122 用例（`test:ui`，跑 `apps/ui` 自己的 vitest）。测试保持 **provider-free**：不启动官方 app-server、不发模型请求、不碰生产服务或数据库。`tests/integration` / `mutations` / `e2e` 三个类别**未接线**，其门经 `scripts/stage-gate.mjs` 以 `NOT_IMPLEMENTED` fail-closed。详见 [`docs/USAGE.md` §12](docs/USAGE.md#12-测试)。

---

## 详细文档

**[`docs/DEPLOY.md`](docs/DEPLOY.md)** —— 部署与使用指南：三种运行形态选型、从源码安装（嵌套依赖坑）、Windows 服务化分步（`C:\ZCode` 目录联接 / `ZCODE_DATA_BASE_DIR` / `ZCODE_CREDENTIAL_SECRET` 三个坑与服务化安全警告）、配置参考表、curl 速查、**客户端接入实战**（三要素 / MiniMax Code 与 opencodex 两个真实配置形状 / key 与端口同步纪律 / 本机实例现状 / 客户端侧排障）、验证清单与故障排查表。

**[`docs/USAGE.md`](docs/USAGE.md)** —— 使用文档全集：13 章，含完整环境变量闭集、端点与 `zcc` 扩展块、请求字段接受/折叠/披露/拒绝四分法、模型选择、真实成本与延迟、完整安全模型、已知边界、排障表、以及逐条事实的**源码索引**。

---

## 许可证

**Proprietary — 私有项目。** 本仓库未附 LICENSE 文件。
