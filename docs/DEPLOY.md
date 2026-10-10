# ZCode Companion 部署与使用指南

本文是**部署与使用指南**（含 Windows 服务化）。字段级细节、错误码全集与逐条源码索引在 [`USAGE.md`](USAGE.md)；本文只写「怎么装、怎么跑、怎么验、踩到坑怎么办」，深度细节一律指回 USAGE 对应章节，不复制大段。

**核实纪律**：本文每个环境变量名、脚本名、路径、端口、机制断言都标注了核实出处。三类标记：

- **源码核实** —— 在本仓某个文件某行读到的事实；
- **官方 bundle 核实** —— 在本机官方 `zcode.cjs` / `app.asar` 里 grep 到字符串名或逐字代码（**只核实名字与语义，不读取、不输出任何凭据值，不解密任何东西**）；
- **部署实测观察** —— 真实机器上跑出来的现象，**机制以官方实现为准**，本文不替官方背书。

凡本文没给出核实行号的断言，都属于第三类。

---

## 0. 这是什么 / 不是什么

**一句话**：一个跑在你本机的 OpenAI 兼容 HTTP 反代，把 ZCode 里你已经登录的订阅/套餐额度暴露给任意 OpenAI 兼容客户端（IDE、脚本、curl）。

| 它**是** | 它**不是** |
| --- | --- |
| 一个**独立进程**，在本机回环端口上起 HTTP API | **不是**公网服务。绑定地址恒为 `127.0.0.1`，传 `0.0.0.0` / `::` / 主机名在**构造期**就抛 `LOOPBACK_ONLY`（`packages/api/src/server.ts:222`） |
| 官方订阅通道（`account:*`）的**本地转发器** | **不是**官方 ZCode 产品的替代品。不装进 ZCode、不改 `C:\ZCode` 下任何文件 |
| 需要你自己设一把**本机 key** 做 Bearer 认证 | **不是**厂商 API key 代理。`ZCC_API_KEY` 是你自己选的串，与官方额度、与任何厂商凭据无关 |
| 按量计费通道**硬拒**（设计如此） | **不是**多账号聚合池、不是转发到第三方 API、不是流量镜像 |

---

## 1. 三种运行形态与选型

| 形态 | 怎么起 | 反代由谁拉起 | 选它当 |
| --- | --- | --- | --- |
| **A. 桌面应用（GUI）** | `cd apps/desktop && npm start`，或双击打包出的 portable exe | 桌面程序主进程（`windowsHide: true` + `shell: false`） | **日常默认**。唯一形态里"反代由 GUI 托管"的：不开第二个控制台、key 不进渲染进程 |
| **B. 独立 API（无 GUI）** | 工程根 `npm run api:start -- --driver official-host` | 你自己的终端 | 排障、脚本化、开发期 |
| **C. Windows 服务** | 服务包装器拉起 **B 的同一条命令** | 服务管理器（LocalSystem 等） | **无人值守常驻**，见 §4 |

三者的反代入口、env 闭集、错误码**完全同形**（`packages/api/bin/start-api.mjs`）。A 与 B/C 的差别只在"谁 spawn 它"和"日志去哪"。

> **⚠️ 服务化只能用 B 的命令行形态。** A（桌面程序）给子进程构造的 env 是一个**闭集**：`OS_ENV_PASSTHROUGH` 只放 9 个 Windows 运行必需键（`SystemRoot` / `ComSpec` / `TEMP` / `TMP` / `PATH` / `PATHEXT` / `WINDIR` 等，见 `apps/desktop/lib/proxy-manager.cjs:50-60`），再加 4 个 `ZCC_*`。**`ZCODE_DATA_BASE_DIR` / `ZCODE_CREDENTIAL_SECRET` 不会被带过去**——用 A 做服务化，§4 的坑二、坑三无解。

---

## 2. 从源码安装

### 2.1 前置

| 项 | 要求 | 核实出处 |
| --- | --- | --- |
| 操作系统 | **Windows** | 官方 bundle 路径 `C:/ZCode/resources/glm/zcode.cjs` 是 Windows 形态，见 `packages/official-host/src/host-driver.ts:292` |
| Node | **>= 24.18.0** | 根 `package.json` 的 `engines.node` |
| npm | **>= 11.16.0** | 根 `package.json` 的 `engines.npm` |
| ZCode 已登录 | 本机凭据仓 `~/.zcode/v2/credentials.json` 里有对应套餐条目 | `packages/official-host/src/credentials.ts:501-505` |
| 官方安装 | `C:/ZCode/resources/glm/zcode.cjs` 存在 | `packages/official-host/src/host-driver.ts:292` |

```bash
node -v && npm -v   # 先确认 >= 24.18.0 / >= 11.16.0
```

### 2.2 ⚠️ 嵌套依赖坑（最容易踩的一个）

**根 `npm install` 不覆盖 `apps/ui` 与 `apps/desktop`。** 根 `package.json` **没有 `workspaces` 字段**（源码核实），所以这两个子工程必须各自装。

```bash
# 1) 工程根（必做）
npm install
# 2) apps/ui（必做）—— 漏了它，npm run ci 的 typecheck:apps 会因缺 react 类型变红
cd apps/ui && npm install && cd ../..
# 3) apps/desktop（只有打包 / 验包才需要）—— 漏了它，pack:win / verify:package 以 exit 4 硬失败
cd apps/desktop && npm install && cd ../..
```

第 3 步只影响 `pack:win` / `verify:package`；`npm run ci` 不含这两道门，只用反代的人不必背这份安装量。依据：`scripts/stage-gate.mjs` 里 `pack:win` 的 `required` 含 `apps/desktop/node_modules/electron-builder/package.json`，`verify:package` 的 `required` 含 `apps/desktop/node_modules/@electron/asar/package.json`（`scripts/stage-gate.mjs:174-203`）。

### 2.3 构建与门

```bash
npm run ci            # typecheck + typecheck:checkjs + typecheck:apps + test:ui + test
npm run typecheck:desktop   # apps/desktop 独立 tsconfig，不并入根工程
```

`ci` 是**发车前必跑**的门。它**不含** `pack:win` / `verify:package`——那两道是出包门，单独跑。

### 2.4 打包（只在要出 exe 时）

```bash
npm run build:ui      # UI 产物补救入口（cwd=apps/ui，vite build）
npm run pack:win      # 出 portable exe，pre 阶段自动再跑一遍 build:ui
npm run verify:package # 从包外 cwd 启动 + 渲染 + /v1 转发
```

**`pack:win` 在 spawn electron-builder 之前有两道产物准入检查**（`scripts/stage-gate.mjs` 的 `verifyBuiltDist`，源码核实）。三条 exit 4 必须分得清：

| 退出码 / 原因码 | 判定 | 处置 |
| --- | --- | --- |
| exit 4 `GATE_PREREQUISITE_MISSING`（不带子码） | `required` 里任一路径不存在，**含 `apps/ui/dist/index.html` 整体缺失** | 补齐缺失路径。**dist 整体缺失时门不会替你构建**，先跑 `npm run build:ui` |
| exit 4 `GATE_PREREQUISITE_MISSING: STALE_UI_DIST` | 界面产物早于界面输入（`apps/ui` 下任一输入比 dist 里最旧的文件更新；扫描排除 `apps/ui/dist` 与 `apps/ui/node_modules`） | 改了源码没重 build。先 `npm run build:ui` 再跑本门 |
| exit 4 `GATE_PREREQUISITE_MISSING: INCOMPLETE_UI_DIST` | `dist/index.html` 没有引用任何本地构建产物，或它引用的本地资源有缺失 | 残缺产物。先 `npm run build:ui` 再跑本门 |

三道都过之后，门内的 `build:ui` 才作为前置串行执行（`vite build`）；它非零即整门失败、**退出码原样透传**，后面的 electron-builder **不会被 spawn**（`scripts/stage-gate.mjs:174-180`）。

产物落在 `release/desktop/ZCodeCompanion-<版本>-win-x64-portable.exe`。

`verify:package` 是 fail-closed 四检查：产物存在且 `release/desktop` 下**只有一个** `.exe`；体积不超 `ZCC_PACKAGE_MAX_BYTES`（缺省 260 MiB，`scripts/verify-package.mjs:34`）；把 exe 的 **cwd 设成 `%TEMP%` 下的新目录**再启动；以 `--zcc-verify` 用**包内**运行时（`driver=none`）拉起 API，让渲染进程经 `app://` 真发一次 `GET /v1/models`。自检端口由 `ZCC_VERIFY_PORT` 给出（缺省 **8899**，`scripts/verify-package.mjs:35`）——**这是隔离端口，与日常 8790 不冲突**，两者可以同时在跑。

---

## 3. 桌面形态使用

### 3.1 启动

```bash
cd apps/desktop && npm start     # 开发形态
```

打包形态直接双击 `release/desktop/ZCodeCompanion-<版本>-win-x64-portable.exe`。

**干净机器上没装 Node 也能用打包产物**：桌面程序用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 让 Electron 自带的 Node 跑反代入口，这条链在整棵进程树上成立（`apps/desktop/main.cjs:164-166`）。

### 3.2 设置与 key

设置落在 `app.getPath('userData')/settings.json`（Windows 上 `%APPDATA%\ZCodeCompanion\settings.json`）：

| 字段 | 缺省 | 说明 |
| --- | --- | --- |
| `apiKey` | **空** | 本机 API key。本产品**不生成**默认弱 key；首启若为空，从 `~/.minimax/config.yaml` 的 `custom_provider.zcc-companion.options.apiKey` 读回（该 key 由本产品自己生成、`zcc_` 前缀，单一用途） |
| `apiPort` | `8790` | 端口被占时进入 `external` 状态，**不会自动换端口** |
| `driver` | `official-host` | 传给反代的 `--driver` |
| `reasoning` | `low` | 映射到 `ZCC_HOST_REASONING` |

（默认值源码核实：`apps/desktop/lib/settings.cjs:32-34,56`）

**掩码语义**：界面拿到的是掩码与 `zcc-fp:*` 指纹，**不是 key 明文**。`apiKey` 走"留空即保持原值"——回提交掩码或空串都表示"不换 key"，一次无意的保存不会把真 key 顶掉（`apps/desktop/lib/settings.cjs:97-118`）。

**改完设置要点「重启」才生效**，运行中的子进程不会因为设置变了就自己换配置（`apps/desktop/main.cjs:185-195`）。

### 3.3 五种状态，其中 `external` 最该记住

| 状态 | 含义 | 启动 | 停止 |
| --- | --- | --- | --- |
| `stopped` | 没在跑 | 可用 | 不可用 |
| `starting` | 正在拉起并等 `/v1/models` 探通 | 不可用 | 不可用 |
| `running` | **子进程存活 且** `GET /v1/models` 探通，两条同时成立 | 不可用 | 可用 |
| `failed` | 拉起失败、超时，或子进程意外退出 | 可用 | 不可用 |
| `external` | **启动前探测到该端口已有服务** | 可用（重探） | **禁用** |

`external` 不是死状态：停止/重启一律禁用（主进程对 `stop()` 回 `EXTERNAL_NOT_OWNED`，绝不向不是自己拉起的进程发信号），但**端口空出来之后，再点一次「启动」就接管**。深度语义见 [`USAGE.md` §13.4](USAGE.md#134-五种状态以及-external-是什么)。

---

## 4. Windows 服务化部署（分步）

> **安全警告，先读这一段再动手。**
>
> 服务化意味着**服务账号能解密你 ZCode 的凭据**（§4 步骤 3 会把 `credentials.json` 的副本交给服务去读）。因此：
>
> 1. 凭据副本**只能放在完全可控的机器上**。放上去之前先问一句：这台机器谁能登、谁有管理员权限。
> 2. 服务环境配置（存 `ZCC_API_KEY` / `ZCODE_CREDENTIAL_SECRET` 的那个配置文件）**必须限制读取权限**到服务账号 + 管理员，其他本地用户读不到。
> 3. **不用时删除凭据副本**，并在 ZCode 桌面**重新登录**使 token 轮换——旧密文留着就是长期风险敞口。
> 4. **API 只绑回环，绝不暴露公网。** 绑定地址恒为 `127.0.0.1`，这不是配置项。想给别的机器用，走 SSH 端口转发之类的显式隧道，别改绑定。

### 4.1 步骤 0：先在交互式终端跑通 B 形态

服务化之前，**先用 §2 的命令在本机终端把反代跑通一次**。终端里的 `homedir` / `username` 就是你的用户，服务环境不是——先把"非服务环境能跑"这个基线立住，再排服务环境的差异。

### 4.2 步骤 1：坑一 —— 官方安装盘符不是 C 盘时的处理

**先说核实结果，避免把话说过头**：本机官方 `C:\ZCode\resources\glm\zcode.cjs` 与 `C:\ZCode\resources\app.asar` 里，`C:\ZCode` 字面量 grep **0 命中**；官方 bundle 里也不存在 `installRoot` 这个符号（`app.asar` 里的 `installRoot` 是 Computer Use Helper 的安装根，与 bundle 路径无关）。**所以"写死 `C:\ZCode`"的是本仓代码里的默认常量**，不是官方实现：

| 写死点 | 文件:行 |
| --- | --- |
| `DEFAULT_BUNDLE_PATH = 'C:/ZCode/resources/glm/zcode.cjs'` | `packages/official-host/src/host-driver.ts:292` |
| `DEFAULT_BUILTIN_PROVIDER_CONFIG_FILE = 'C:/ZCode/resources/config/provider/...'` | `packages/official-host/src/host-driver.ts:641` |
| `DEFAULT_BUILTIN_PROVIDER_FILE = 'C:/ZCode/resources/config/provider/zcode-builtin.json'` | `packages/plansrc/src/reader.ts:189` |
| `installRoot ?? 'C:/ZCode'`（运行时发现层） | `packages/runtime/src/discovery.ts:714` |

这四个都是**可注入的缺省值**（函数签名都带 `bundlePath` / `options` 参数），代码层面可以指到别处；但走 `npm run api:start` 这条默认路径时没有对应的 CLI flag 覆盖它。

**处置（部署实测观察）**：官方装在别的盘时，用目录联接把 `C:\ZCode` 指到真实安装目录，让上面四个默认常量落到正确位置：

```cmd
REM 以管理员身份开 cmd。目标路径换成你自己的实际安装目录。
mklink /J C:\ZCode D:\ZCode
```

验证（Git Bash）：

```bash
ls -l /c/ZCode/resources/glm/zcode.cjs
ls /c/ZCode/resources/config/provider/zcode-builtin.json
```

联接建好之前**不要**启动服务——`PROVIDER_CONFIG_NOT_FOUND` / `BUNDLE_NOT_FOUND` 会在启动期就报（`packages/official-host/src/host-driver.ts:1036-1037`、`:685-688`）。

> 若 `C:\ZCode` 已存在真实目录，**不要**直接建联接，先确认它到底是不是官方安装目录；本文不替你判断，只提示这一步不可逆。

### 4.3 步骤 2：坑二 —— 服务账号读不到用户 ZCode 数据（503 cache-file-absent）

Windows 服务以 **LocalSystem** 运行时，它的 `homedir` 不是你的用户目录，于是 `~/.zcode/v2/coding-plan-cache.json` 读不到 → 订阅资格 fail-closed → 通道 503，原因是 `cache-file-absent`（`packages/official-host/src/entitlement.ts:73-78,219`）。

**官方提供的覆盖口是 `ZCODE_DATA_BASE_DIR`**，本仓与官方两侧都认：

| 侧 | 消费点 | 逐字 / 行号 |
| --- | --- | --- |
| 官方 bundle | 凭据仓解析：`function n$s(e={}){…let n=e.baseDir??t[t$s]??(0,Cct.homedir)();return(0,XOe.join)(eYr(n),".zcode","v2","credentials.json")}`，其中 `t$s="ZCODE_DATA_BASE_DIR"` | 官方 bundle 核实（该字符串 4 处命中；本仓转写见 `packages/official-host/src/host-driver.ts:587-591`） |
| 本仓 | 凭据仓路径 `join(baseDir,'.zcode','v2','credentials.json')` | `packages/official-host/src/credentials.ts:501-505` |
| 本仓 | 套餐缓存路径 `join(dataBaseDir,'.zcode','v2','coding-plan-cache.json')` | `packages/official-host/src/entitlement.ts:92-97` |

**传递链（源码核实）**：`ZCODE_DATA_BASE_DIR` **不在** `HOST_CHILD_STORAGE_ENV_KEYS`（`host-driver.ts:593-603`）里，也不在 `HOST_CHILD_STRIPPED_ENV_KEYS`（`host-driver.ts:507`）里，因此 `buildChildEnv` 会把它**原样透传给官方子进程**（`host-driver.ts:509-520`）。同时入口的未知键检查**只拦 `ZCC_` 前缀**（`packages/api/bin/start-api.mjs:245`），所以 `ZCODE_*` 不会触发 `UNKNOWN_ENV_KEY`。

**处置**：

```cmd
REM 1) 复制用户 ZCode 数据目录到服务专用位置（只读用途，别指回原目录）
robocopy "%USERPROFILE%\.zcode" "D:\zcc-service-data\.zcode" /E /COPY:DAT /R:1 /W:1

REM 2) 限制读取权限：只有服务账号与 Administrators 能读
icacls "D:\zcc-service-data" /inheritance:r /grant "SYSTEM:(OI)(CI)F" /grant "Administrators:(OI)(CI)F"
```

至少要有 `v2/coding-plan-cache.json` 与 `v2/credentials.json` 两个文件。服务环境变量：

```cmd
setx /M ZCODE_DATA_BASE_DIR "D:\zcc-service-data"
```

验证（服务起来之后，见 §6）：

```bash
curl -sS http://127.0.0.1:8790/v1/zcc/catalog -H "Authorization: Bearer <你的本机key>"
```

响应里每条模型带 `x-zcc-status` 头与 `zcc.status`；仍是 `cache-file-absent` 就说明路径没生效或 ACL 把服务账号挡在外面。

### 4.4 步骤 3：坑三 —— 解密密钥推导依赖 homedir/username（502 Credential decrypt failed）

官方凭据信封用 AES-256-GCM，密钥来自"secret 推导"。**官方 bundle 里 `ZCODE_CREDENTIAL_SECRET` 存在且语义明确**：

```js
// 官方 bundle 核实（该字符串 1 处命中）
function Z7s(e){ let t=e[G7s]?.trim();
  if(t) return t;                       // G7s = "ZCODE_CREDENTIAL_SECRET"
  let n="unknown"; try{ n=(0,oge.userInfo)().username }catch{}
  return `zcode-credential-fallback:${(0,oge.platform)()}:${(0,oge.homedir)()}:${n}` }
```

**机制很清楚**：不设这个 env 时，密钥由 `platform + homedir + username` 三元组拼出来。LocalSystem 下 `homedir` / `username` 与交互式用户**不同** → 推出来的密钥与当初加密时的不同 → 解密失败。官方抛的错误文本是逐字的 `Credential decrypt failed: key mismatch or corrupted ciphertext`（官方 bundle 核实）。

本仓**完全同形**地实现了这条推导，所以设同一个 env 能同时修好两侧：

| 侧 | 常量 / 行号 |
| --- | --- |
| 官方 bundle | `G7s="ZCODE_CREDENTIAL_SECRET"`，消费函数 `resolveCredentialSecret`（bundle 核实） |
| 本仓 | `CREDENTIAL_SECRET_ENV_KEY = 'ZCODE_CREDENTIAL_SECRET'`，`packages/official-host/src/credentials.ts:162` |
| 本仓兜底串 | `zcode-credential-fallback:${platform}:${homeDir}:${username}`，`credentials.ts:226` |

**处置**：在交互式终端先算出**你用户下的**那条兜底串，然后把它作为 env 固定给服务。

```bash
# Git Bash：拼出与你交互式会话一致的兜底 secret
SECRET="zcode-credential-fallback:$(node -p 'require("os").platform()'):$(node -p 'require("os").homedir()'):$(node -p 'require("os").userInfo().username')"
echo "$SECRET"        # 确认形态对；不要 echo 到公共日志或截图里
```

```cmd
REM 服务环境：显式覆盖，值与上面算出来的一致
setx /M ZCODE_CREDENTIAL_SECRET "<上面那串>"
```

> `ZCODE_CREDENTIAL_SECRET` 一旦设置就**优先于**兜底串（官方与本仓都是 `env` 分支先判）。设成空白串会被**拒绝**而不是回落（`credentials.ts:206-212`）——本仓的设计是"显式清空"不能被误读成"未配置"，官方侧同理（`let t=e[G7s]?.trim(); if(t) return t;`）。
>
> 这条 env 出现在服务配置文件里时，它就是一把**等同于凭据明文的钥匙**。按 §0 的安全警告处理：限制文件读权限、不进版本库、不进日志。

### 4.5 步骤 4：注册服务

本仓**不含**任何服务包装器或安装脚本（`git ls-files` 中无 nssm / WinSW / 服务注册脚本，源码核实）。用你信任的服务包装器拉起 **B 形态的同一条命令**即可：

```
<node 可执行文件绝对路径> <仓库绝对路径>\packages\api\bin\start-api.mjs --driver official-host
```

服务环境变量（全部 `setx /M` 或服务管理器自己的环境配置）：

```cmd
setx /M ZCC_API_KEY "<你的本机key>"
setx /M ZCC_HOST_REASONING "low"
setx /M ZCODE_DATA_BASE_DIR "D:\zcc-service-data"
setx /M ZCODE_CREDENTIAL_SECRET "<上面算出的那串>"
```

注意：

- **必须用绝对路径**。服务的 `PATH` 与交互式会话不同，`node` 可能解析不到。
- **不要**设 `ZCC_HOST_STORAGE_DIR` / `ZCC_HOST_WORKSPACE`。它们**不在**入口的 `ENTRY_ENV_KEYS` 闭集里（`start-api.mjs:87-96`），设了会以 `UNKNOWN_ENV_KEY` 拒绝启动。这不是 bug，是"不静默忽略未知配置"的直接后果（[`USAGE.md` §3.7 两个陷阱](USAGE.md#3-启动)）。
- 监听端口**恒为回环**。服务也一样——这是构造期强制的，不是配置出来的。
- 服务的工作目录建议设为仓库根，反代会去 `%TEMP%` 建隔离目录，但 cwd 指向仓库根能减少相对路径意外。

### 4.6 每步验证

| 步骤 | 验证动作 | 期望 |
| --- | --- | --- |
| 步骤 1 后 | `ls -l /c/ZCode/resources/glm/zcode.cjs` | 文件可读 |
| 步骤 2 后 | 服务起来后打 catalog | 503 / `cache-file-absent` 消失 |
| 步骤 3 后 | 发一条最小聊天请求 | 不再是 502 `Credential decrypt failed` |
| 步骤 4 后 | **重启机器后**重打 §9 全部勾选项 | 全绿（验证自启配置真的生效） |

---

## 5. 配置参考表

### 5.1 本产品入口环境变量（**闭集**，8 键）

来源：`ENTRY_ENV_KEYS`，`packages/api/bin/start-api.mjs:87-96`。**任何不在表里的 `ZCC_*` 键都会让启动直接失败**（`UNKNOWN_ENV_KEY`，exit 2），不静默忽略（`start-api.mjs:245-249`）。

| 变量 | 必填 | 缺省 | 取值闭集 | 作用 | 核实出处 |
| --- | --- | --- | --- | --- | --- |
| `ZCC_API_KEY` | **是** | 无 | 任意非空白串 | Bearer key 的值。**缺失或全空白即拒绝启动，绝不生成默认弱 key** | `start-api.mjs` `ENTRY_ENV_KEYS` / 入口校验 |
| `ZCC_API_PORT` | 否 | `8790` | 整数 | 监听端口。`0` = 由系统分配（启动横幅打印真实端口） | `ENTRY_DEFAULT_PORT = 8790`，`start-api.mjs:68`；与 `server.ts:79` 同源，漂移即 `ENTRY_DEFAULT_PORT_DRIFT` |
| `ZCC_DRIVER` | 否 | `none` | `none` / `fixture` / `local-official` / `official-host` | 驱动器。**本产品要用的那个是 `official-host`**；`fixture` 从配置启用会报 `FIXTURE_DRIVER_TEST_ONLY` | `start-api.mjs` 驱动名闭集 |
| `ZCC_SHUTDOWN_GRACE_MS` | 否 | `5000` | 整数 | `SIGINT`/`SIGTERM` 时在途请求的收束上限 | `ENTRY_DEFAULT_SHUTDOWN_GRACE_MS = 5_000`，`start-api.mjs:71` |
| `ZCC_HOST_REASONING` | 否 | `high` | `low` \| `high` \| `max` | 推理档位。闭集外**启动即拒**（`HOST_REASONING_UNKNOWN`）。**只在 `--driver official-host` 下解析** | `ENTRY_HOST_REASONING_LEVELS`，`start-api.mjs:142,146` |
| `ZCC_HOST_PERMISSION_MODE` | 否 | `yolo` | `plan` \| `build` \| `edit` \| `yolo` \| `auto` | 下发给官方 `session/create` 的 `mode` | `start-api.mjs:103,106` |
| `ZCC_HOST_TOOL_POLICY` | 否 | `allow` | `allow` \| `deny` | 子宿主收到 `interaction/requestPermission` 时的应答策略 | `start-api.mjs:114,117` |
| `ZCC_HOST_DEBUG` | 否 | `0` | `0` \| `1` | 诊断行开关。**只有这两个字面量**，`2`/`on`/`true`/空串全部启动即拒。**一律解析**，不限 official-host | `ENTRY_DEFAULT_HOST_DEBUG = '0'`，`start-api.mjs:134,395` |

### 5.2 官方侧环境变量（**不是**本产品闭集，但反代会读）

| 变量 | 作用 | 缺省 | 核实出处 |
| --- | --- | --- | --- |
| `ZCODE_DATA_BASE_DIR` | 官方数据根。覆盖凭据仓与套餐缓存的解析基准 | 官方兜底 `homedir()` | 官方 bundle grep 4 处命中；本仓 `credentials.ts:501-505`、`entitlement.ts:92-97` |
| `ZCODE_CREDENTIAL_SECRET` | 凭据解密密钥的显式来源；不设则由 `platform:homedir:username` 推导 | 兜底串 `zcode-credential-fallback:<platform>:<homedir>:<username>` | 官方 bundle grep 1 处命中（`resolveCredentialSecret`）；本仓 `credentials.ts:162,226` |

> 入口的未知键检查**只拦 `ZCC_` 前缀**（`start-api.mjs:245`），所以这两个 `ZCODE_*` 能穿过入口并被子宿主继承（不在 `HOST_CHILD_STORAGE_ENV_KEYS` / `HOST_CHILD_STRIPPED_ENV_KEYS` 里，`host-driver.ts:507,593-603`）。

### 5.3 只读但可注入的路径（代码层可覆盖，入口无 flag）

| 常量 / env | 缺省 | 核实出处 |
| --- | --- | --- |
| 官方 bundle 路径 | `C:/ZCode/resources/glm/zcode.cjs` | `host-driver.ts:292` |
| 官方 builtin provider config | `C:/ZCode/resources/config/provider/zcode-builtin.json` | `host-driver.ts:641`、`plansrc/src/reader.ts:189` |
| `ZCC_HOST_BUILTIN_PROVIDER_CONFIG` | 覆盖上面那个 | `HOST_BUILTIN_PROVIDER_CONFIG_OVERRIDE_ENV_KEY`，`host-driver.ts:644` —— **注意：它是 `ZCC_` 前缀且不在入口闭集，设了会 `UNKNOWN_ENV_KEY`** |
| `ZCC_HOST_PERSONAL_PROVIDER_CONFIG` | 隔离目录下的 `v2/provider_config.json` | `HOST_PERSONAL_PROVIDER_CONFIG_OVERRIDE_ENV_KEY`，`host-driver.ts:647` —— 同上，不在入口闭集 |

### 5.4 打包 / 验包门的环境变量

| 变量 | 缺省 | 作用 | 核实出处 |
| --- | --- | --- | --- |
| `ZCC_VERIFY_PORT` | `8899` | `verify:package` 自检用的**隔离端口**，不碰 8790 | `scripts/verify-package.mjs:35` |
| `ZCC_PACKAGE_MAX_BYTES` | `260 MiB` | 产物体积上限；超了判失败 | `scripts/verify-package.mjs:34` |
| `ZCC_VERIFY_TIMEOUT_MS` | `180000` | 自检超时；超时一律算失败 | `scripts/verify-package.mjs:36` |

### 5.5 端口与网络闸门

| 项 | 值 | 核实出处 |
| --- | --- | --- |
| 默认端口 | `8790` | `start-api.mjs:68`、`server.ts:79` |
| 绑定地址 | **恒为 `127.0.0.1`**，非配置项；传其它值构造期抛 `LOOPBACK_ONLY` | `server.ts:222` |
| 允许的 `Host` 头 | `127.0.0.1`、`localhost` | `packages/api/src/auth.ts:34` |
| `Origin` | 白名单**恒为空**，CORS 永不开启；`OPTIONS` 一律 **405**，且不写任何 `access-control-*` 头 | `server.ts:374`、`server.ts:930-933` |
| 并发 / 速率 | 4 并发、60 请求 / 60 秒，**不排队**，超了直接 429 带 `retry-after` | `packages/api/src/auth.ts:134` |
| 请求体上限 | 1 MiB，超了 413 且不缓冲 | `packages/api/src/auth.ts:29` |

### 5.6 桌面设置文件

`%APPDATA%\ZCodeCompanion\settings.json`（= `app.getPath('userData')/settings.json`），字段见 §3.2，缺省值见 `apps/desktop/lib/settings.cjs:32-34,56`。

---

## 6. 接口速查与 curl

三条路径，职责不混用，**全部要求 `Authorization: Bearer <你的本机key>`**（路由源码核实：`server.ts:936` / `:96` / `:944`）。

| 端点 | 方法 | 用途 |
| --- | --- | --- |
| `/v1/models` | GET | 给外部 IDE 的**纯 OpenAI 形状**模型列表（不带 `zcc` 扩展块） |
| `/v1/zcc/catalog` | GET | 本产品界面的目录（`revision` + `models`，七键逐项校验） |
| `/v1/chat/completions` | POST | 标准 OpenAI chat completions，`stream: true` 走 SSE |

```bash
# ── 1) 目录
curl -sS http://127.0.0.1:8790/v1/zcc/catalog \
  -H "Authorization: Bearer <你的本机key>"

# ── 2) 模型列表
curl -sS http://127.0.0.1:8790/v1/models \
  -H "Authorization: Bearer <你的本机key>"

# ── 3) 最小聊天请求
#    中文/长请求体一律走文件，shell 内联会产生乱码（传输层问题，不是产品 bug）
cat > body.json <<'JSON'
{
  "model": "account:bigmodel-start-plan::GLM-5.3-Flash",
  "messages": [ { "role": "user", "content": "你好" } ],
  "reasoning_effort": "low"
}
JSON

curl -sS http://127.0.0.1:8790/v1/chat/completions \
  -H "Authorization: Bearer <你的本机key>" \
  -H "Content-Type: application/json" \
  --data-binary @body.json

# ── 4) 看状态头（诊断用）
curl -sS -i http://127.0.0.1:8790/v1/models \
  -H "Authorization: Bearer <你的本机key>" | head -20
```

> **不要带 `Origin` 头**（CORS 永不开启，带 `Origin` 一律 403 `origin_not_allowed`）；`Host` 头必须是监听地址（否则 403 `host_not_allowed`，防 DNS rebinding）。见 `server.ts:365,374`。

模型名用**目录原文**，形如 `account:<套餐>::<模型>`，**含 `::` 分隔符**。目录条数随官方 builtin 变化，**以 `GET /v1/zcc/catalog` 的实时返回为准**。

---

## 7. 客户端接入实战

本节写「反代跑起来之后，怎么把手上任意 OpenAI 兼容客户端接上去」。**字段级规则、`zcc` 扩展块与逐项踩坑在 [`USAGE.md` §6](USAGE.md#6-接线minimax-code-及其它-openai-兼容客户端) 与 §4–§5，本节不复制**，只写接线与排障时真正会栽跟头的东西：

- **§7.1–§7.3 配置形状**：两份本机客户端的逐字形状与必填键。
- **§7.4 key 与端口同步纪律**：换 key / 指错端口这两类"一半好一半坏"。
- **§7.5 本机实例现状**：本机实测的端口与形态。
- **§7.6–§7.8 排障**：客户端侧症状分诊（§7.6）、**服务端日志定位法**（§7.7，决定"客户端侧还是服务端侧"）、客户端 YAML 编码纪律（§7.8）。
- **§7.9 接口行为**：历史工具痕迹的兼容剥离，一条影响"旧会话能不能继续用"的端点行为。

### 7.1 三要素

任何 OpenAI 兼容客户端，接本反代只要填三样：

| 项 | 值 | 核实出处 |
| --- | --- | --- |
| baseURL | `http://127.0.0.1:8790/v1` | 本机两份真实客户端配置**逐字一致**：`~/.minimax/config.yaml` 的 `custom_provider.zcc-companion.options.baseURL`、`~/.opencodex/config.json` 的 `providers.zcc-bigmodel.baseUrl` 与 `providers.zcc-start-plan.baseUrl`（本机只读核对，值均为该 URL）。端口缺省见 §5.1 `ENTRY_DEFAULT_PORT = 8790` |
| apiKey | `<你的本机key>`（占位符）。**本文与所有示例一律不写真实值** | §5.1 `ZCC_API_KEY`：服务端只认这一把，客户端填别的必然 401 |
| model | **目录原文**，必须含 `account:` 前缀与 `::` 分隔符，形如 `account:bigmodel-start-plan::GLM-5.3-Flash` | §6 末段 + 本机两份真实配置的 `models` 键逐字形态；`account:` 是唯一白名单通道前缀（§8.3） |

**模型名不要自己拼。** 目录条目是「套餐 × 模型」组合：同一个模型在不同套餐下是**不同 id**（`account:bigmodel-start-plan::GLM-5.3-Flash` 与 `account:bigmodel-individual-coding-plan::GLM-5.3-Flash` 是两条独立条目，计费类别也不同）。先 `GET /v1/zcc/catalog` 查，再逐字抄 id。条数随官方 builtin 变化，**以实时返回为准**。

### 7.2 真实形状之一：MiniMax Code（`config.yaml`）

配置文件：`%USERPROFILE%\.minimax\config.yaml` 的 `custom_provider` 段。下面**逐字转录本机真实形状，值全部占位**：

```yaml
custom_provider:
  zcc-companion:
    name: "ZCC Companion"
    kind: custom
    enabled: true
    api: openai-completions
    options:
      apiKey: <你的本机key>
      baseURL: "http://127.0.0.1:8790/v1"
      authMode: api-key
    models:
      "account:bigmodel-start-plan::GLM-5.3-Flash":
        name: "GLM-5.3-Flash (ZCC Start Plan)"
        limit:
          context: 1000000
          output: 32768
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
        configuration_source: manual
        enabled: true
        attachment: true
        modalities:
          input:
            - text
          output:
            - text
```

| 字段 | 断言 | 核实出处 |
| --- | --- | --- |
| `options.apiKey` | **只能明文落盘**。这是本产品那把 key 在 mcode 侧的唯一落盘形态 | 本机 `~/.minimax/config.yaml` 逐字（值已打码核对）；同口径见 [`USAGE.md` §13.5](USAGE.md#135-设置与首启引导) |
| `options.baseURL` / `options.authMode` | 见 §7.1；`authMode` 为 `api-key` | 本机配置逐字 |
| `api` | `openai-completions`。**不能写 `openai-responses`** | 本机配置逐字；理由见 [`USAGE.md` §6.2](USAGE.md#62-minimax-code真实用例mcode056) |
| `models` 的键 | 完整目录 id，含 `account:` 与 `::`。**键整体加引号**——它含 `:`，不加引号的 YAML 解析结果不可靠 | 本机配置逐字（三条 id 均带引号） |
| `thinking.effortOptions` | **只能 `low` / `high` / `max` 三项**，与本端点 `reasoning_effort` 闭集逐字相等；多一项（如 `medium`）客户端就会发出一个 API 层 422 的值 | 本机配置逐字（三项）+ `packages/api/src/chat.ts:278` `REASONING_EFFORT_LEVELS = ['low','high','max']` + 闭集契约测试 |
| `thinking.effort` / **`thinking.defaultEffort`** | **两个都要写，缺一个都会让实际档位偏离**。缺 `defaultEffort` 时客户端回落取中间项 ⇒ `[low, high, max]` 落到 **`high`**，**不报错** | 本机配置逐字（两项均在）；回落机制见 [`USAGE.md` §6.3](USAGE.md#63--defaulteffort-那个坑) |
| `limit.output` | **`32768`**，不要写客户端自己的上下文数字（如 `128000`）。客户端把它当"输出预算"原样发出，见 §7.6 的 400 一行 | 本机配置逐字 `output: 32768` + `chat.ts:152` `MAX_MAX_TOKENS = 32_768` + `chat.ts:1267-1276` `assertMaxTokens` |
| `tool_call` | `false`。本端点是纯对话形态，`tools_forwarded` 恒 0 | 本机配置逐字；见 [`USAGE.md` §10.2](USAGE.md#102-外部客户端--纯对话形态) |
| `thinking_config.mode` / `default_value` | `switchable` / `"true"` | 本机配置逐字 |

> ### ⚠️ 两个必写的键：`thinking.defaultEffort` 与 `limit.output`
>
> **`thinking.effort: low` 不是钉住档位的字段，`thinking.defaultEffort: low` 才是。**
> 缺 `defaultEffort` 时 mcode 的回落是 `Math.floor(len/2)` 取中间项，对 `[low, high, max]` 即 **`high`**。**后果是静默的：不报错、不降级，只是实际跑高档位**，而每轮多花的 thinking token 是实打实的。
>
> **`limit.output` 必须 ≤ 32768。** 端点的硬上限是 `MAX_MAX_TOKENS = 32_768`；客户端把 `limit.output` 当作"生成预算"原样填进 `max_completion_tokens`（**不是** `max_tokens`——mcode 对自定义 provider 的 `maxTokensField` 缺省就是 `max_completion_tokens`）。写 `128000` 会直接吃到 **400 `invalid_request`**：`max_completion_tokens 必须是 0..32768 之间的整数`。这条不需要推理档位配合，是纯数值越界，见 §7.6。
>
> 排查"明明配了 low 却跑高档位"或"请求为什么发了个巨大的输出预算"时，**先看这两行在不在**，别去翻服务端日志。

### 7.3 真实形状之二：opencodex（`config.json`）

配置文件：`%USERPROFILE%\.opencodex\config.json`。**顶层段名是复数 `providers`**（不是 `provider`），反代相关的是两个段：`zcc-bigmodel`（订阅套餐）与 `zcc-start-plan`（活动额度）。逐字形状（值全占位）：

```json
{
  "providers": {
    "zcc-bigmodel": {
      "adapter": "openai-chat",
      "baseUrl": "http://127.0.0.1:8790/v1",
      "name": "zcc-bigmodel",
      "authMode": "key",
      "apiKey": "<你的本机key>",
      "allowPrivateNetwork": true,
      "liveModels": true,
      "contextWindow": 1000000,
      "models": [
        "account:bigmodel-individual-coding-plan::GLM-5.3",
        "account:bigmodel-individual-coding-plan::GLM-5.3-Flash"
      ],
      "selectedModels": [
        "account:bigmodel-individual-coding-plan::GLM-5.3",
        "account:bigmodel-individual-coding-plan::GLM-5.3-Flash"
      ],
      "defaultModel": "account:bigmodel-individual-coding-plan::GLM-5.3",
      "modelDisplayNames": {
        "account:bigmodel-individual-coding-plan::GLM-5.3": "GLM-5.3"
      },
      "modelContextWindows": {
        "account:bigmodel-individual-coding-plan::GLM-5.3": 1000000
      },
      "modelReasoningEfforts": {
        "account:bigmodel-individual-coding-plan::GLM-5.3": ["low", "high", "max"]
      },
      "modelDefaultReasoningEfforts": {
        "account:bigmodel-individual-coding-plan::GLM-5.3": "low"
      }
    },
    "zcc-start-plan": {
      "adapter": "openai-chat",
      "baseUrl": "http://127.0.0.1:8790/v1",
      "name": "zcc-start-plan",
      "authMode": "key",
      "apiKey": "<你的本机key>",
      "allowPrivateNetwork": true,
      "liveModels": true,
      "contextWindow": 1000000,
      "models": ["account:bigmodel-start-plan::GLM-5.3-Flash"],
      "selectedModels": ["account:bigmodel-start-plan::GLM-5.3-Flash"],
      "defaultModel": "account:bigmodel-start-plan::GLM-5.3-Flash",
      "modelContextWindows": {
        "account:bigmodel-start-plan::GLM-5.3-Flash": 1000000
      },
      "modelReasoningEfforts": {
        "account:bigmodel-start-plan::GLM-5.3-Flash": ["low", "high", "max"]
      },
      "modelDefaultReasoningEfforts": {
        "account:bigmodel-start-plan::GLM-5.3-Flash": "low"
      }
    }
  }
}
```

| 字段 | 断言 | 核实出处 |
| --- | --- | --- |
| `providers.<名>.baseUrl` | 与 §7.1 同一条 URL，**不带尾部 `/`**（`…/v1` 已是完整基址） | 本机 `~/.opencodex/config.json` 两段逐字一致 |
| `allowPrivateNetwork` | **必须为 `true`**。反代只绑回环，缺这一项客户端侧会先拦下回环地址 | 本机配置两段均为 `true` |
| `authMode` | `"key"`（**注意与 mcode 的 `api-key` 不是同一个字面量**） | 本机配置逐字 |
| `adapter` | `"openai-chat"` | 本机配置逐字 |
| `modelReasoningEfforts` | 值域同样只能是 `low` / `high` / `max` | 本机配置逐字 + `chat.ts:278` |
| `modelDefaultReasoningEfforts` | **钉住缺省档位，等价于 mcode 侧的 `defaultEffort`**，本机两段均实配 `"low"`。缺了同样是静默回落到中间档 `high` | 本机配置逐字；机制见 §7.2 的警告框 |
| `liveModels` | `true` 时按服务端实时返回刷新模型列表 | 本机配置逐字 |
| `note` | 自由文本备注，不参与请求 | 本机两段均有此键（内容为档位/套餐的口径说明） |

### 7.4 key 与端口的同步纪律（本轮真实踩坑）

**服务端换 key 之后，所有已配置的客户端必须同步更新，否则一律 401。** 本产品**不提供**「一把 key 管多处」的机制：每个客户端各存各的那份明文，服务端只认 `ZCC_API_KEY` 这一把（§5.1）。换 key 的正确顺序：

1. 改服务端。桌面形态在设置页改完**要点「重启」才生效**（§3.2）；服务形态改环境变量后重启服务。
2. 打开**所有**已配客户端，把 `apiKey` 换成新值。
3. 逐个发一条最小请求，确认不再是 401。

漏掉第 2 步的症状很有辨识度：**只有部分客户端 401，另一个照常工作**——因为它们各持一份旧值。看到这种"一半好一半坏"就直接查同步，不要去查服务端。

**端口也要盯死：常驻服务一律指 8790。**

| 反代实例 | 端口 | 生命周期 | 客户端该指谁 |
| --- | --- | --- | --- |
| 常驻服务（服务化形态，§4） | **8790** | 机器开机即在 | **客户端一律指这个** |
| 桌面 GUI 托管的那一份 | 由桌面设置 `apiPort` 决定（**可与 8790 不同**） | **跟着 GUI 进程走**：GUI 退出 → 这份一起退出 | **不要指它** |

客户端把 baseURL 指到 GUI 那一侧的症状**很有欺骗性**：GUI 开着的时候一切正常，**GUI 一关就全线失联**（连不上），而常驻服务其实一直在跑。排查顺序永远是**先确认 8790 的服务在不在**，再去看客户端的 baseURL 端口：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8790/v1/models
# 期望：401 —— 说明服务活着，且在要求 Bearer（不带 key 打过去必然 401）
# 得到 000 / 连接失败：服务没在跑，去 §4.6 验启动
```

### 7.5 本机实例现状

以下为本机实测（2026-10-10）：

| 实例 | 端口 | 形态与生命周期 | 实测依据 |
| --- | --- | --- | --- |
| 常驻服务 `zcode-companion` | **8790** | Windows 服务，包装器 `C:\ProgramData\Servy\Servy.Service.CLI.exe`，启动类型 **Automatic**，账号 LocalSystem，状态 Running | `Get-CimInstance Win32_Service`（`PathName` / `StartMode` / `StartName`）；`netstat -ano` 见 `127.0.0.1:8790` LISTENING；无 key 打 `/v1/models` 返回 **401** |
| 桌面 GUI 托管的那一份 | **8791**（本机 `settings.json` 的 `apiPort` 实配值） | 由 `ZCodeCompanion.exe` 拉起的 `start-api.mjs --driver official-host`；**GUI 进程退出即随之退出** | `netstat -ano` 见 `127.0.0.1:8791` LISTENING，占用进程为 `ZCodeCompanion.exe`；`%APPDATA%\ZCodeCompanion\settings.json` 实配 `apiPort: 8791` |

> 8791 是**本机 `settings.json` 的实配值**，不是产品缺省——缺省仍是 8790（§3.2）。

**两个实例并存、互不干扰**：各占各的端口、各自独立。GUI 侧只把「该端口已有服务」当 `external` 状态**观察**，不会去动不是自己拉起来的进程（§3.3、[`USAGE.md` §13.4](USAGE.md#134-五种状态以及-external-是什么)）。

**桌面 GUI 总览页的现状（一句话口径）**：页面挂载即同源读一次 `GET /v1/zcc/catalog`（壳注入 `Authorization`，**界面侧零模型请求**），据此计算证据等级——

> **E1 = 目录读回成功，且其中至少 1 条 `billingClass ∈ {subscription, promotion}` 的条目；否则一律 E0。**

具体地：未读取 / 读取中 / 读取失败 / 读回成功但 0 条条目 / 读回成功但 0 条订阅通道条目，五种情况全是 `E0`，**失败时显示原因码，不填任何占位值**。判定逻辑在 `apps/ui/src/data/evidence.ts` 的 `computeEvidenceLevel`，"entitled" 的口径在 `apps/ui/src/data/accountCatalog.ts`（**目录侧口径，不是账号握手已证明**）。

E1 在页面上标注「**当前 · 部分满足**」防误读：E1 的完整定义要求「官方登录 / 目录 / 套餐资格 / 实际选模」四项读回成立，而**权威桶读数仍保持未观测**、**发送门结构上关闭**（`dispatch = 0`）。E1 只是证据强度，**不是"可以发"**。

### 7.6 客户端侧排障

**先按状态码分家，再看消息文本。** 下表按客户端实际遇到的状态码排：

| 状态码 | 首查 | 判定与修法 |
| --- | --- | --- |
| **401** `unauthorized` | **先对 key**：客户端存的 `apiKey` 是否与服务端当前这把一致 | 服务端换过 key 就必然 401，§7.4 同步所有客户端。key 确认一致仍 401，才去对启动横幅的 `zcc-fp:*` 指纹。**错误消息永远不会告诉你 key 哪一段错了**（`server.ts:505` 的措辞逐字就是"需要有效的本机 API key：请求头 Authorization 使用 Bearer 方案"，不含任何 key 片段） |
| **连不上**（GUI 开着时正常、GUI 一关就断） | **再对 baseURL 端口**：常驻服务一律指 **8790** | 指到了 GUI 那一侧 → 改回 8790，§7.4。**注意 401/4xx 与"连不上"是两回事**：连不上说明请求根本没到服务端，日志里也不会有记录 |
| **400** `invalid_request`，消息形如 `max_completion_tokens 必须是 0..32768 之间的整数` | **对 `limit.output`**：客户端模型条目里的输出预算是否 ≤ 32768 | 端点硬上限 `MAX_MAX_TOKENS = 32_768`（`chat.ts:152`）。客户端把 `limit.output` 原样当输出预算发过来，写 `128000` 这类"按模型标称上下文推算"的值就是越界。**修法：把 `limit.output` 改成 32768 对齐端点上限**。注意字段名是 `max_completion_tokens` 不是 `max_tokens`（mcode 对自定义 provider 的 `maxTokensField` 缺省值） |
| **413** `payload_too_large` | **看会话长度**：请求体 > 1 MiB，或 `messages` > 256 条 | 上限是硬闸（`auth.ts:29` `REQUEST_BODY_MAX_BYTES = 1024*1024`；`chat.ts:148` `MAX_MESSAGES = 256`）。**长会话跑久了必然撞上，不是故障**。修法：**新起一个会话**，或裁掉早期历史——没有任何参数能调高这个上限 |
| **404** | **看路径**：`model_not_found` 还是未知路径 | `model_not_found` = 模型 id 不在可服务集（用目录原文，必须含 `::`）；**未知路径** = 客户端调了本端点没实现的端点，典型是 OpenAI Responses 系的 `/v1/responses/input_tokens`（客户端的 token 计数探针）。**无害，可忽略**——见 §7.9 |
| **422** | **看错误消息点名了哪个键**，三分叉见下 | 消息文本自带解法与合法值域，逐字读 |

#### 422 的三个来源（同一个状态码，三条完全不同的修法）

422 `unsupported_parameter` 在客户端场景里最常撞到的是**三种来源**，错误消息会**逐字点名被拒的键**，照着点名的那一条查，不要一上来就怀疑配置全错：

| 来源 | 错误消息点名 | 根因与修法 |
| --- | --- | --- |
| **① 推理档位在闭集外** | `reasoning_effort` | 客户端注入了一个 `low`/`high`/`max` 之外的值。**先查客户端模型条目的 `thinking`**：`effortOptions` 里是否混进了 `medium`（OpenAI 的档位，本端点不认），或**缺 `defaultEffort` 后回落/错配**。修法：`effortOptions` 钉死三项 + **补 `effort: low` 与 `defaultEffort: low`**（§7.2 警告框） |
| **② 历史里的工具痕迹** | `messages[i].tool_calls` | 旧会话历史里带着 `assistant.tool_calls` / `role:"tool"` 轮。**自 2026-10-10 版本起服务端已兼容剥离，见 §7.9**；仍报这一条说明客户端连的是旧版本服务端 |
| **③ `tools` 形状畸形** | `tools` 或 `tools[i]` | 顶层 `tools` 必须是数组，且每项须是带 `function` 或 `type` 的对象。**合法形状是被接受的**（计入 `tools_received`，一条也不转发），只有非数组（`null` 也不行）与畸形项才 422，错误消息会指名**具体下标** |

> **最快的一条捷径**：BYOK 客户端的错误里常带**上游原始信息**（形如 `upstream error: 422 …`）。**拿这段文本去服务端日志里对号入座**最快——它已经把"哪个键被拒"这层翻译好了，直接对照 §7.7 的日志行即可定位。

### 7.7 服务端日志定位法（决定性分叉）

**不要在客户端里猜。** 服务端有逐请求的结构化日志，能一刀把问题劈成"客户端侧"与"服务端侧"两半：

服务化形态由 Servy 包装器承接，**stdout / stderr 分表落盘**：

```bash
tail -f "C:/ProgramData/Servy/logs/<服务名>-out.log" \
         "C:/ProgramData/Servy/logs/<服务名>-err.log"
# 本机服务名为 zcode-companion：zcode-companion-out.log / zcode-companion-err.log
```

日志行是**单行 `key=value`**，两个文件各管一类事件（行格式见 `packages/api/src/server.ts:1323,1327`）：

```text
# -out.log：每个被处理的请求都有一行，含状态码
zcc-api event=request path=/v1/chat/completions method=POST status=422 ms=7 in_flight=1
# -err.log：被拒的请求有一行，含**机器可读的错误码**（比状态码信息量大）
zcc-api event=rejected path=/v1/chat/completions code=unsupported_parameter status=422
```

**决定性分叉，就问一个问题：这次失败的请求，出现在日志里了吗？**

| 日志里的现象 | 结论 | 下一步 |
| --- | --- | --- |
| **完全没有这次请求的记录** | **客户端侧**。请求压根没到服务端 | 查配置是否**真的生效**（改完有没有**重启客户端**）、baseURL 端口是不是指到了已退出的 GUI 实例（8791）。见 §7.4 |
| 有记录，看**状态码** | **服务端侧**，按码分家 | 见下表 |
| 401 但 `err.log` 里没有 `rejected` 行 | 正常：认证闸在日志之前 | 401 只在 `out.log` 留 `status=401` 一行（`out.log` 里 401 行数远多于 `err.log` 的 `unauthorized` 计数即此故）。按 §7.4 对 key |

**看到记录后，按状态码分家：**

| 状态码 | 含义 | 首查 |
| --- | --- | --- |
| **401** | key 不对 | §7.4 key 同步纪律 |
| **404** | 模型 id 或端点路径 | `model_not_found` → 目录原文；未知路径（如 `/v1/responses/input_tokens`）→ 无害忽略，§7.9 |
| **413** | 载荷太大 | 会话太长，新开会话，§7.6 |
| **422** | 参数被拒 | **看 `err.log` 的 `code=unsupported_parameter`，再按 §7.6 的三分叉定位** |
| **400** | 请求畸形（如输出预算越界） | `code=invalid_request`，对照 §7.6 的 400 一行 |
| **5xx** | 上游或内部 | 看 `out.log` 里同期的 `official-host entitled … reason=…` 行，`reason` 如实说明上游判定（缓存可用性 / 资格 / 凭据）；`502` 见 §10，`503` 见 §8.1 |

> **`entitled` 行怎么读**：`out.log` 里的 `official-host entitled account:<套餐> entitled=true|false reason=…` 是**上游资格的如实转写**。5xx 时先找这条——它回答"到底是上游没资格，还是缓存读不出来"这个分叉，比猜快得多。

### 7.8 客户端 YAML 编码纪律

客户端配置文件里的**中文显示名被写坏，会让整个模型列表显示为乱码**，而且**这个错误在服务端完全看不到**（请求照发、照回 200，坏的是客户端渲染）。

**根因是写入端的编码**，不是读取端：用非 UTF-8 的工具（PowerShell 5.1 的 `>` / `Out-File`、`Set-Content` 默认编码、部分编辑器自动检测失败）写含中文的 YAML，文件里存的是**双重编码后的字节**。症状形态是**一串读不通的 CJK 字符**（例如本机某次踩坑后模型名显示为 `濞戞搩浜欏Ч?` 这类）——注意它是**合法的 UTF-8**，所以文件能正常解析、YAML 结构也没坏，坏掉的只有那几行中文。

**修法与预防：**

| | 做法 |
| --- | --- |
| **修** | 用**可靠的 UTF-8 编辑器**（VS Code / Notepad++ 显式设 UTF-8）**直接改回 `name`**。结构没坏，只改那几行的文本即可 |
| **预防（改前必做）** | 动客户端 YAML 之前**先备份**：`copy "%USERPROFILE%\.minimax\config.yaml" "%USERPROFILE%\.minimax\config.yaml.bak-YYYYMMDD"`。本机已有 `config.yaml.bak-20261009` 这类先例 |
| **预防（写时必做）** | **只用 UTF-8 编辑器编辑客户端 YAML**；确需脚本改写时，显式指定 UTF-8（PowerShell 5.1 用 `-Encoding UTF8`，或 `pwsh` 7+ 的缺省 UTF-8）。**不要用 shell 重定向写含中文的 YAML** |
| **自检** | 改完打开客户端看模型列表：**名字是正常中文（或正常英文）才叫修好**。服务端日志对此**零信号**，别指望靠它验证 |

> 这条与 §6 提到的"中文请求体一律走文件、不要 shell 内联"是**同一条纪律的两面**：那一条防传输层乱码，这一条防**落盘**乱码。共同的根因都是"用不可靠的写入路径碰非 ASCII 文本"。

### 7.9 接口行为：历史工具痕迹的兼容剥离（自 2026-10-10 版本起）

**背景**：旧会话历史里会留着工具调用痕迹——assistant 轮带 `tool_calls` 字段，以及 `role:"tool"` 的工具结果轮。对一个**纯对话**端点，这两样都实现不了，早期版本一律 422，把 MiniMax Code 这类 BYOK 客户端对**任何带工具历史的会话**整个挡死。

**自 2026-10-10 版本起，服务端改为接受并剥离**（常量与逻辑见 `packages/api/src/chat.ts`）：

| 场景 | 处理 | 常量 |
| --- | --- | --- |
| `messages[i].tool_calls` / `tool_call_id` | **接受并剥离**，不进拒绝表也不进未知字段表 | `MESSAGE_TOOL_TRACE_FIELDS` |
| assistant 轮剥掉 `tool_calls` 后 **content 为空** | 填占位文本 **`[此前调用了工具，内容未纳入上下文]`** | `TOOL_TRACE_PLACEHOLDER_CONTENT` |
| `role:"tool"` 的轮 | **转成 `role:"user"`**，content 前缀 **`[工具结果] `**（含尾随空格）；非字符串 content 会 JSON 文本化，保证内容不丢 | `TOOL_RESULT_CONTENT_PREFIX` |

**两条关键性质（决定了它为什么不是"静默改写"）：**

- **消息条数与顺序不变。** 占位而不是删消息——删一条会改变 `messages` 条数与角色序列，那是比"改写 role"更重的一种语义变更。**痕迹留在原位、留在上下文里**。
- **改写在文本里可见。** 占位文本与 `[工具结果] ` 前缀都进了 prompt，**模型与客户端都看得见"这是一条工具结果 / 这条 assistant 只发了工具调用"**，不是凭空改写一条 user 轮。

**顶层 `tools` 的口径没变，仍然要分清两件事**：`tools` / `tool_choice` / `parallel_tool_calls` 是"**这一轮**要工具行为"的请求参数，与"**历史里**发生过工具调用"根本不是一回事。合法形状的 `tools`（非空数组、逐项浅校验）**被接受并如实计数**——响应 `zcc.tools_received > 0` 与 `zcc.tools_forwarded: 0` 成对出现；**畸形才 422**（`tools` 非数组含 `null`，或 `tools[i]` 缺 `function`/`type`，错误指名下标）。`tool_choice` 的 `required` / `any` / 具名指定**仍拒**——那几档要的是"这一轮必然产生一个工具调用"，本端点结构上做不到。

> **为什么"接受声明"不等于"支持工具"**：接受的是**声明**，不是**能力**。驱动器契约上没有工具槽位，`tools_forwarded` 恒为 0，产出里**永远**不含 `tool_calls`。披露这两个键是为了把"纯对话形态"变成一条**机器可读的事实**，而不是让客户端一直等一个不会来的 `tool_calls`。

---

### 7.10 接口行为：生成上限的超额钳制（自 2026-10-10 晚间版本起）

**背景**：真客户端 mcode 对 BYOK 模型条目**不读 `limit.output`**——抓包实测（2026-10-10）：条目里写 `output: 32000`，请求仍带 `max_completion_tokens: 128000`。mcode 按它自家对这些模型 ID 的认知构造上限，**在客户端界面改"最大输出"救不了**。早期版本对超 32768 的值一律 400，等于这条客户端线整个不可用。

**现行为（`packages/api/src/chat.ts` 的 `parseMaxTokens` / `assertMaxTokens`）**：

| 请求值 | 处理 |
| --- | --- |
| `max_completion_tokens`（或 `max_tokens`）**> 32768** | **钳到 32768 放行**；响应 `zcc.max_tokens_clamped_from`（客户端原值）+ `zcc.max_tokens_clamped_to`（32768）成对披露 |
| **负数 / 非整数 / 字符串** | 仍 400 `invalid_request`，错误文本带**实际收到值**（如 `…（实际收到 128000）`） |
| 两键同发且值不同 | 仍 422 `unsupported_parameter` |

**排障用法**：看到 400 错误里的"实际收到 X"，就是客户端真实发送的上限值——判断"改了配置为什么还错"时，先看这个数有没有变。钳制发生时 `zcc.max_tokens_clamped_from` 是唯一权威证据。

**另一个真客户端事实**：`limit.output` / 界面里的"最大输出"**不影响** mcode 实际发送的 `max_completion_tokens`（它发 128000 是常量级行为）；配置里的 `limit` 字段只影响客户端自己的展示与预估。

---

### 7.11 接口行为：附件分段占位 + 子宿主墙钟可配（2026-10-10 晚间版本）

**附件分段（真客户端 mmx 的 attachment 会话）**：mmx 里带图片的会话，历史**每轮**都带 `image_url` / `input_image` 分段。此前一律 422 `unsupported_content_type`，等于**整个会话死锁**（重发永远被拒）。现改为：非 text 分段替换为占位文本（如 `[image_url 未纳入上下文：本端点为纯文本，该分段已省略]`）放行——占位在 prompt 里可见，模型与客户端都知道图没进上下文；**分段原值（data URL 等）从不进 prompt**。非法形态（type 非字符串）仍 422。

**子宿主墙钟**：`ZCC_HOST_TURN_TIMEOUT_MS`（毫秒，1..86400000，缺省 300000）。此前写死 5 分钟，长编码任务到点被 SIGKILL，SSE 流拦腰截断，客户端报 `net::ERR_INCOMPLETE_CHUNKED_ENCODING`。长任务场景调大它（Servy 部署在 SERVY_ENVIRONMENT_VARIABLES 里加一条即可，改后重启服务）。

---

## 8. 通道与档位预期

### 8.1 通道

| 通道形态 | 计费类别 | 预期 |
| --- | --- | --- |
| `account:*start-plan*` | `promotion`（免费额度） | **按授权可用**。实测该通道返回 200 |
| `account:*coding-plan*` | `subscription`（订阅） | **可能 503**。原因是官方那份 coding-plan 缓存如实反映"当前未授权"（观察到的 reason 形如 `coding_plan_not_entitled` / `coding_plan_auth_failed`）。**这是官方缓存的如实反映，不是反代故障**——在 ZCode 桌面**重新激活 / 登录**后自愈 |
| `bigmodel-api` / `builtin:bigmodel` 等**按量付费**形态 | — | **产品设计上永不准入**。判定在**取键之前**完成，命中即拒且**不触网** |

> **关于 503 原因串的核实口径**：`coding_plan_not_entitled` / `coding_plan_auth_failed` 这两个串**在本仓源码与官方 bundle 内均未 grep 到**（本仓的资格原因闭集是 `packages/official-host/src/entitlement.ts:73-78` 的 `cache-available` / `cache-unavailable` / `cache-status-not-recognized` / `no-cache-entry-for-provider` / `cache-file-absent` / `cache-entries-absent`）。因此上表的两个串属于**部署实测观察到的上游 reason 文本**，机制以官方实现为准。

### 8.2 推理档位

**闭集只有三个：`low` / `high` / `max`**。**没有 `medium`** —— OpenAI 的 `medium` / `minimal` 是官方会拒的值，API 层直接 422 并列出合法值（`packages/api/src/chat.ts:1251-1283`；闭集与驱动器的 `KNOWN_REASONING_LEVELS` 逐字相等，有契约测试守着）。

另外两条容易踩的：

- 目录里的 `reasoning` 字段是**官方能力**的如实转写，**不等于**本端点的合法闭集。API 层**只查全局闭集**，不与目录按模型求交集。
- 目录里出现的 `disabled` / `enabled`（某些模型）才是会被 422 的值（闭集外）。

### 8.3 付费通道硬拒

唯一允许的通道前缀是 `account:`。按量计费通道一律硬拒，错误码区分 `channel_not_allowlisted` 与 `blocked_channel`。判定**在取键之前**、命中**不触网**。

---

## 9. 部署后验证清单

逐条打勾。**任何一条不过，就还没部署完。**

```bash
# 0) 确认环境变量干净：同名的旧 ZCC_* 残留会挡路（UNKNOWN_ENV_KEY）
env | grep ZCC_
```

- [ ] **`GET /v1/zcc/catalog` 返回 200**，响应体含 `revision` + `models`
- [ ] **`GET /v1/models` 返回 200**，`data[]` 里的 `id` 含 `::`
- [ ] **`POST /v1/chat/completions` 返回 200**，响应带 `zcc` 扩展块
- [ ] **响应头 `x-zcc-status` 不报不可用**；`zcc.status` 是 `ready`（不是 `not_attached` / `no_quota`）
- [ ] **把 `ZCC_API_KEY` 换成错的 → 拿到 401**，且错误消息**没有**回显任何 key 片段
- [ ] **带 `Origin` 头发一条 → 拿到 403 `origin_not_allowed`**（确认 CORS 确实关着）
- [ ] **`OPTIONS` 预检 → 405**
- [ ] **`reasoning_effort: "medium"` → 422**（确认闭集只有 low/high/max）
- [ ] **重启机器 / 重启服务后重打上面三条 200**（验证自启配置真的生效，不是手启动的假象）
- [ ] **桌面程序形态**：打开后状态是 `running` 而非 `external`；若端口已有服务显示 `external`，停掉外部那份再点启动能接管

### 错误码速查（详细排障见 [`USAGE.md` §11](USAGE.md#11-排障表)）

| 码 | 含义 | 首查 |
| --- | --- | --- |
| **400** `invalid_request` | 请求畸形。**客户端最高频的一条**：`max_completion_tokens 必须是 0..32768 之间的整数`（输出预算越界） | 把客户端模型条目的 `limit.output` 改到 ≤ 32768，见 §7.6 |
| **401** `unauthorized` | 缺 `Authorization: Bearer`，或 key 与 `ZCC_API_KEY` 不一致 | 核对启动横幅里的 `zcc-fp:*` 指纹。错误**不会**告诉你 key 哪一段错了。客户端场景见 §7.4 |
| **403** `origin_not_allowed` | 请求带了 `Origin` 头 | 去掉 `Origin` |
| **403** `host_not_allowed` | `Host` 头不是监听地址 | 用 `127.0.0.1:8790` |
| **404** `model_not_found` | `model` 不在可服务集内 | 目录查 id，**必须含 `::`** |
| **404** 未知路径 | 调了本端点未实现的端点（典型：OpenAI Responses 系的 `/v1/responses/input_tokens` 计数探针） | **无害，忽略即可**。本端点只提供 `/v1/models`、目录、readstatus 与 `/v1/chat/completions`（`server.ts`） |
| **413** `payload_too_large` | 请求体 > 1 MiB 或 `messages` > 256 条 | **长会话必然撞上**，新开会话或裁历史；上限不可调（`auth.ts` / `chat.ts`） |
| **422** `unsupported_parameter` | 字段被拒。**错误消息自带解法**，逐字写出为什么被拒与合法值域，照着改 | 客户端场景按 §7.6 的**三分叉**定位：推理档位 / 历史工具痕迹 / `tools` 畸形 |
| **422** `unsupported_role` | `messages[i].role` 用了 `function` 或其它非法 role。**注意 `role:"tool"` 自 2026-10-10 版本起已被接受并转写为 `user`**，见 §7.9 | 错误里指名具体下标 |
| **429** `rate_limited` | 超 4 并发或 60/分钟 | 看 `retry-after`。**不排队**，直接拒 |
| **502** `upstream_outcome_unknown` | 上游结果未知 | 若是 `Credential decrypt failed`，走 §4.4 |
| **503** `upstream_unavailable` | 上游不可用：驱动器没挂 / 没额度 / 缓存未显示可用 | 看 `x-zcc-status` 与 `zcc.status`。若是 `cache-file-absent`，走 §4.3 |
| **exit 4** `GATE_PREREQUISITE_MISSING` | 门的前置缺失 | 见 §2.4 三行表；区分带不带子码 |

> **一条日志把 4xx/5xx 全部对号入座**：服务端会为每次被拒的请求写一行 `code=<机器可读错误码>`，比状态码信息量大得多。定位方法见 §7.7。

---

## 10. 故障排查表

| 现象 | 首查命令 / 动作 | 定位 |
| --- | --- | --- |
| 启动报 `UNKNOWN_ENV_KEY` | `env \| grep ZCC_` | 有不在 8 键闭集里的 `ZCC_*` 残留（最常见是上一轮实验留下的 `ZCC_HOST_STORAGE_DIR` / `ZCC_HOST_WORKSPACE`） |
| 启动报 `HOST_REASONING_UNKNOWN` | 检查 `ZCC_HOST_REASONING` | 闭集只有 `low`/`high`/`max`。**启动期就报**，不会等到第一次请求 |
| 启动报 `LISTEN_FAILED`（exit 1） | `netstat -ano \| findstr :8790` | 端口被占 |
| 启动报 `STORAGE_ISOLATION_UNSAFE` | 检查 `ZCC_HOST_STORAGE_DIR` | 隔离目录落在 ZCode 存储根内，拒绝下发 |
| 401 但 key 看着没问题 | 核对启动横幅 `zcc-fp:*` | key 与运行中的进程不是同一把 |
| **只有客户端 401，curl 打 8790 正常** | **先对 key 是否与服务端一致，再对 baseURL 端口** | §7.4：各客户端各存各的明文 key，服务端换过 key 就会「一半客户端 401」；若是指到 GUI 托管的那一侧，则 GUI 一关全线失联。常驻服务一律指 8790 |
| **改完客户端配置，故障症状没变** | 确认**客户端进程已重启**、配置真的被读进去了 | 客户端大多在启动时读配置并缓存；热改文件不会自动生效 |
| **400** `invalid_request`（`max_completion_tokens 必须是 0..32768 之间的整数`） | 对客户端模型条目的 **`limit.output`** | 输出预算越界。端点上限 `MAX_MAX_TOKENS = 32_768`，把 `limit.output` 改到 ≤ 32768。**注意字段名是 `max_completion_tokens` 不是 `max_tokens`** |
| **413** `payload_too_large` | 看会话轮数与请求体大小 | 长会话跑久必然撞上（体 > 1 MiB 或 `messages` > 256 条）。**上限不可调**，新开会话或裁历史 |
| **422**，消息点名 `reasoning_effort` | 对客户端的 `thinking` 块 | 闭集只有 `low`/`high`/`max`。补 `effort: low` + **`defaultEffort: low`**，`effortOptions` 钉死三项，见 §7.2 警告框 |
| **422**，消息点名 `messages[i].tool_calls` | 确认服务端版本 | 自 2026-10-10 版本起历史工具痕迹会被兼容剥离（§7.9）；仍报说明服务端版本偏旧 |
| **422**，消息点名 `tools` / `tools[i]` | 对 `tools` 形状 | 合法形状（数组 + 每项带 `function`/`type`）**是被接受的**；非数组（含 `null`）或畸形项才 422 |
| **404**，消息是"未知路径" | 看路径本身 | 客户端调了本端点未实现的端点，典型是 OpenAI Responses 系的 `/v1/responses/input_tokens`。**无害，忽略** |
| **客户端模型列表显示为乱码**（一串读不通的 CJK） | 打开客户端 YAML 看 `name` 行字节 | 文件被**非 UTF-8 工具**写坏（双重编码）。用 UTF-8 编辑器改回 `name`；预防=编辑前备份、只用 UTF-8 编辑器写。见 §7.8 |
| **不知道该查客户端还是服务端** | `tail` Servy 日志，看请求在不在 | §7.7：**没出现 = 客户端侧**；出现看状态码分家。`out.log` 有 `status=`，`err.log` 有 `code=`（信息量更大） |
| 403 一律 | 去掉 `Origin`、确认 `Host` | CORS 恒关 + Host 防 rebinding，两道闸门都在 |
| 404 | `GET /v1/zcc/catalog` | id 必须含 `::`，用目录原文 |
| 挂死到 300s | 先查 MCP 授权 / 浏览器执行两类反请求 | 官方这两类请求**逐字没有** `timeoutMs`，不答就一直挂。单请求 300s 墙钟是官方 session 驱动硬顶 |
| **`pack:win` exit 4** | 看原因码带不带子码 | `STALE_UI_DIST` → `npm run build:ui`；`INCOMPLETE_UI_DIST` → 同上；不带子码 → 补 `required` 里缺的路径。**dist 整体缺失时门不会替你构建** |
| **`verify:package` exit 4** | `cd apps/desktop && npm install` | 缺 `@electron/asar`（`scripts/stage-gate.mjs:192-203`） |
| **`verify:package` 端口冲突** | `ZCC_VERIFY_PORT=<端口> npm run verify:package` | 自检端口缺省 8899，被占时换端口 |
| **服务起来但通道 503 `cache-file-absent`** | 检查 `ZCODE_DATA_BASE_DIR` 与 ACL | §4.3 坑二 |
| **服务起来但 502 `Credential decrypt failed`** | 检查 `ZCODE_CREDENTIAL_SECRET` | §4.4 坑三：LocalSystem 的 homedir/username 变了，推不出同一个密钥 |
| **官方装在 D 盘时启动报找不到 bundle** | `ls -l /c/ZCode/resources/glm/zcode.cjs` | §4.2 坑一：目录联接 |

---

## 11. 已知限制与当前状态（如实）

### 11.1 本文的核实边界

- 三个服务化坑是**部署实测观察**；其中 `ZCODE_DATA_BASE_DIR` 与 `ZCODE_CREDENTIAL_SECRET` 两个 env 名与其在官方 bundle 中的**推导语义**已 grep 核实，但**官方实现细节以官方为准**，本文不复述其内部算法之外的任何行为。
- `coding_plan_not_entitled` / `coding_plan_auth_failed` 两个 reason 串**在本仓与官方 bundle 内均未 grep 到**，属观察到的上游文本。
- 官方安装根写死 `C:\ZCode` 的是**本仓的默认常量**（§4.2 表），不是官方实现——官方 bundle 与 `app.asar` 内该字面量 0 命中。
- 本仓**不含**服务包装器、注册脚本或 systemd/服务单元。§4.5 的注册命令是**形态说明**，不是可直接复制的脚本。
- §7.6–§7.8 的客户端排障实录是**部署实测观察**（2026-10-09 / 2026-10-10 两轮真实踩坑）。它们描述的是**本机这两套客户端**的行为，不是对所有 OpenAI 兼容客户端的普遍承诺。
- **"自 2026-10-10 版本起"的表述指的是行为生效的日期，不是提交号**。§7.9 描述的历史工具痕迹兼容剥离、以及 §7.6 的 422 三分叉，其判定逻辑均在工作区源码 `packages/api/src/chat.ts` 中逐条 grep 核实（见文末附表）；本文**不引用提交号**，因为该改动在工作区尚未随本仓库发布。
- §7.8 的乱码实例（`濞戞搩浜欏Ч?`）是**当时实际观察到的显示文本**。它是合法的 UTF-8 字符序列（可正常解析、YAML 结构完好），**已尝试按 GBK/Big5 等常见误写编码反解无法还原原文**——因此本文只描述机制与修法，**不猜测原始中文是什么**。
- §7.7 的日志行格式取自 `packages/api/src/server.ts:1323,1327` 的 `logger.warn` / `logger.info` 字面量；`out.log` / `err.log` 的**文件名后缀**是 Servy 包装器的约定（stdout / stderr 分流），非本仓代码规定。

### 11.2 仓库状态

| 项 | 状态 |
| --- | --- |
| 许可证 | **无 LICENSE 文件**。私有项目，`README.md` 末尾声明 Proprietary |
| 治理文档 | `AGENTS.md` 内含**本机绝对路径**（如 `G:/zcode-project/zcode-companion` 与 `G:/zcode-project/zcode-dev/.superpowers/...`）。对外部署者不可直接照搬 |
| 文档分工 | 本文 = 部署与使用；[`USAGE.md`](USAGE.md) = 深度手册（13 章，含完整 env 闭集、字段四分法、源码索引）。两者互补，本文不复制 USAGE 的深度段落 |
| 对应基线 | 本文对应远端提交 **`ea2e9fe`**。按提交说明，该基线的能力范围 = **基础整改波1**（`8eafe91` 提交列出 ZC-01/01E/02/03/12/13/23/29/30/43/44/45/49/55 已签收卡），HEAD 另含一笔 `wip(zc-51)`（提交说明自述"接管会话工作，**未独立验收**"） |
| 未做 | **ZC-50 … ZC-56 与整体终验未做**。本文不宣称这些能力已具备 |
| 测试面 | `npm run ci`；`tests/integration` / `mutations` / `e2e` 三个类别**未接线**，其门经 `scripts/stage-gate.mjs` 以 `NOT_IMPLEMENTED` fail-closed（exit 3） |

### 11.3 其它限制（详见 [`USAGE.md` §10](USAGE.md#10-已知边界)）

- 单请求 **300s 墙钟**硬顶（官方 session 驱动）。
- 每轮 **~2-4 万 prompt tokens**（官方 agent 自带系统提示的固有开销，每轮都带）。
- 外部客户端 = **纯对话形态**：客户端声明的工具会被接受、计数，然后一条也不转发。
- **Windows only**；`pack:win` 名字里的 `win` 不是占位。
- 打包产物**不含官方运行时**（`C:/ZCode/resources/glm/zcode.cjs`），真发模型请求仍要求本机装了 ZCode。

---

## 附：本文每条断言的核对来源

| 主题 | 文件 / 命令 |
| --- | --- |
| 入口 env 闭集、缺省值、CLI、未知键检查、端口漂移校验 | `packages/api/bin/start-api.mjs` |
| 路由、`Origin`/`Host` 闸门、`OPTIONS` 405、绑定强制回环、限流装配 | `packages/api/src/server.ts` |
| `reasoning_effort` 闭集、422 行为 | `packages/api/src/chat.ts` |
| 错误码 → 状态码映射（401/403/404/413/429/502/503） | `packages/api/src/errors.ts` |
| 限流缺省值、请求体上限、允许的 Host 名 | `packages/api/src/auth.ts` |
| 官方 bundle 缺省路径、存储隔离 env、子宿主 env 透传与剥离 | `packages/official-host/src/host-driver.ts` |
| `ZCODE_CREDENTIAL_SECRET` 常量与兜底串推导 | `packages/official-host/src/credentials.ts` |
| 套餐缓存路径与资格原因闭集 | `packages/official-host/src/entitlement.ts` |
| builtin provider config 缺省路径 | `packages/plansrc/src/reader.ts` |
| npm 门、`required`、`verifyBuiltDist`、`NOT_IMPLEMENTED` | `scripts/stage-gate.mjs` |
| 验包端口 / 体积上限 / 超时 | `scripts/verify-package.mjs` |
| 桌面设置缺省值、掩码语义、userData 路径 | `apps/desktop/lib/settings.cjs` |
| 桌面子进程 env 闭集、`ELECTRON_RUN_AS_NODE` | `apps/desktop/lib/proxy-manager.cjs`、`apps/desktop/main.cjs` |
| §7.2 MiniMax Code 的 `custom_provider.zcc-companion` 段**字段形状**（值全部打码，不读取、不输出任何 key 值） | 只读核对：`%USERPROFILE%\.minimax\config.yaml` |
| §7.3 opencodex 的 `providers.zcc-bigmodel` / `providers.zcc-start-plan` 段**字段形状**（值全部打码） | 只读核对：`%USERPROFILE%\.opencodex\config.json` |
| §7.2/§7.3 的档位闭集断言（`low`/`high`/`max`，无 `medium`） | `packages/api/src/chat.ts:278` `REASONING_EFFORT_LEVELS` + 契约测试 |
| §7.2 的 `thinking.effort` / `defaultEffort` 必写、`limit.output: 32768` | 本机配置逐字（两项与 `output: 32768` 均在）+ `chat.ts:152` `MAX_MAX_TOKENS = 32_768` + `chat.ts:1267-1276` `assertMaxTokens`；缺 `defaultEffort` 回落 `high` 的机制见 [`USAGE.md` §6.3](USAGE.md#63--defaulteffort-那个坑) |
| §7.6 的 400 输出预算越界（`max_completion_tokens 必须是 0..32768 之间的整数`） | `chat.ts:1267-1276` 的错误文案逐字 + `packages/api/src/errors.ts:106` `invalid_request → 400`；`max_completion_tokens` 而非 `max_tokens` 见 `chat.ts:1203` |
| §7.6 的 413（体 > 1 MiB / `messages` > 256 条） | `packages/api/src/auth.ts:29` `REQUEST_BODY_MAX_BYTES = 1024*1024` + `chat.ts:148` `MAX_MESSAGES = 256` + `errors.ts:122` `payload_too_large → 413` |
| §7.6 / §9 的 404 未知路径（含 `/v1/responses/input_tokens`） | `packages/api/src/server.ts` 的路由分派：只提供 `/v1/models`、`CATALOG_PATH`、`READ_STATUS_PATH`、`/v1/chat/completions`，其余抛 `not_found`（`errors.ts:98` → 404）；本机 `zcode-companion-err.log` 中确有 `path=/v1/responses/input_tokens code=not_found status=404` 的实测行 |
| §7.6 的 422 三分叉（档位 / 历史工具痕迹 / `tools` 畸形） | `chat.ts:1318-1339` `parseReasoningEffort`（闭集外 422）+ `chat.ts:1443-1505` `parseMessage`（工具痕迹剥离）+ `chat.ts:1140-1193` `parseToolDeclarations`（`tools` 形状判定与 `toolsReceived` 计数） |
| §7.7 的日志行格式（`out.log` 的 `status=` / `err.log` 的 `code=`） | `packages/api/src/server.ts:1323`（`event=rejected … code=… status=…`）与 `server.ts:1327`（`event=request … status=… ms=… in_flight=…`）；两个文件名后缀是 Servy 包装器的 stdout/stderr 分流约定 |
| §7.7 的 `entitled … reason=…` 行 | `packages/official-host/src/host-driver.ts`（上游资格如实转写）+ 本机 `C:/ProgramData/Servy/logs/zcode-companion-out.log` 实测行 |
| §7.9 历史工具痕迹的剥离行为与两条常量 | `packages/api/src/chat.ts:557` `MESSAGE_TOOL_TRACE_FIELDS`、`:566` `TOOL_TRACE_PLACEHOLDER_CONTENT`、`:574` `TOOL_RESULT_CONTENT_PREFIX`、`:1498-1503`（占位，条数顺序不变）、`:1519-1536`（`tool` 转 `user` 加前缀）；顶层 `tools` 接受与计数见 `:1103-1192` |
| §7.8 客户端 YAML 编码纪律 | **部署实测观察**：本机 `~/.minimax/config.yaml` 被非 UTF-8 工具写坏后模型名显示为乱码；备份先例 `~/.minimax/config.yaml.bak-20261009` 存在 |
| §7.6/§7.7 的客户端排障实录（401 / 端口 / 422 / 400 / 413 / 404） | **部署实测观察**（2026-10-09 / 2026-10-10 两轮）+ 本机 Servy 日志逐条对号（`zcode-companion-out.log` / `-err.log` 中确有 `status=400/413/422` 与 `code=invalid_request / payload_too_large / unsupported_parameter / not_found` 的对应记录） |
| §7.5 证据等级 E0/E1 判定、`entitled` 目录侧口径、"部分满足"标注 | `apps/ui/src/data/evidence.ts`（`computeEvidenceLevel`）、`apps/ui/src/data/accountCatalog.ts`、`apps/ui/src/pages/OverviewPage.tsx` |
| §7.5 本机实例现状（8790 服务 / 8791 GUI、并存、探活 401） | **部署实测观察**：`Get-CimInstance Win32_Service`、`netstat -ano`、`curl http://127.0.0.1:8790/v1/models`（不带 key，期望 401） |
| 官方 `ZCODE_DATA_BASE_DIR` / `ZCODE_CREDENTIAL_SECRET` 字符串与语义 | 只读 grep：`LC_ALL=C grep -ao '<名字>' "/c/ZCode/resources/glm/zcode.cjs"`（**只取名字与上下文代码，不读取任何凭据值**） |
| 「官方未写死 `C:\ZCode`」的证伪 | 同上 grep，字面量命中数为 0 |