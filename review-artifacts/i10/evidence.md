# I10 验收证据

桌面程序：反代的启动 / 显示 / 操作全部收进 GUI，不弹独立 cmd 窗口。

**脱敏声明**：本目录下所有文件都不含 API key 明文。自检与 UI 一律只出现
`[REDACTED]:a814504c4c9d` 形态的指纹，以及 `zcc_verify_local_only_*` /
`zcc_probe_local_only_*` 两个**合成** key（非任何真实凭据）。

## 命令 → 退出码

| # | 命令（cwd = 仓库根，除注明外） | exit | 说明 |
| --- | --- | --- | --- |
| 1 | `npm run ci` | 0 | 25 文件 / 863 用例（基线 20/765，只增不减） |
| 2 | `cd apps/ui && npx vite build` | 0 | 界面产物 `apps/ui/dist` |
| 3 | `cd apps/desktop && npm run smoke` | 0 | 渲染截图 → `20-smoke-render.png`；smoke **不** spawn 反代 |
| 4 | `node review-artifacts/i10/e2e/dev-e2e.mjs` | 0 | 开发形态端到端，见 `31-dev-e2e-log.txt` |
| 5 | `npm run pack:win` | 0 | 产出 `release/desktop/ZCodeCompanion-0.1.0-win-x64-portable.exe`（100,262,530 B） |
| 6 | `ZCC_VERIFY_PORT=8897 npm run verify:package` | 0 | 包外 cwd 启动 + 渲染 + `/v1` 转发 |
| 7 | `npm run verify:package`（默认端口 8899） | **1** | 8899 被**本机无关进程**占用 → 预检 fail-closed（见下「反取证」） |

## 开发形态端到端（#4）要点

- 反代由**主进程**拉起：快照 `state=running pid=39664 port=8791`，未占用 8790 上那个在跑的实例。
- 界面经 `app://` 取目录：**200，18 条**（与直连回环同数）。
- 真发一条 `POST /v1/chat/completions`（`account:bigmodel-individual-coding-plan::GLM-5.3-Flash`，
  `reasoning_effort: low`）→ **200**，回复 `就绪，主上。`
- 「停止」按钮真点（`found=true disabled=false`）→ 状态转 `stopped`，原 pid **已确认退出**。
- 「启动」按钮真点 → 重新就绪，`GET /v1/models` → 200。
- 日志页有子进程 stdout/stderr（13 行），key 呈 `[REDACTED]:a814504c4c9d`。

结构化结果见 `30-dev-e2e-summary.json`，逐步日志见 `31-dev-e2e-log.txt`。

## 包外自足性（#6）

- exe 的 cwd 落在 `%TEMP%` 下的新目录（`zcc-verify-cwd-*`）——还依赖仓库相对路径的产物在这里就起不来。
- 产物**自己**拉起包内运行时：`state=running pid=35084 port=8897`（`code=STARTED`）。
- 渲染进程经 `app://` 真发 `GET /v1/models` → **200**。
- `apiKeyLeaked: false`。
- `21-package-render.png` 是同一次自检（端口 8896）从 `%TEMP%` 启动时拍的渲染截图。
  该帧界面侧快照仍显示「启动中 / PID —」——**画面不是判据**，机器可读的真相在
  `verify.json` 的 `state=running`。

## 反取证：本轮真正抓到的两个假通过

这两条是本工单里**先红后绿**的实证，不是复述。

### 1. `app://` 转发全线 502（`net::ERR_INVALID_ARGUMENT`）

- **红**：开发形态端到端里「界面经 `app://` 取目录」返回 **502 `upstream_unreachable`**，
  而同一时刻 Node `fetch` 直连回环是 200。
- **定位**：`apps/desktop/lib/app-protocol.cjs` 在转发时显式写 `host` 头。
  Electron 44.4.5 的 `net.fetch` 走 Chromium 网络栈，显式 `host` 被判非法参数。
  官方 `net` 文档未记载该限制，故以实测取证：`e2e/netfetch-probe.cjs`（`net.fetch`→回环 = 通）、
  `e2e/forward-probe.cjs`（`protocol.handle`→`net.fetch`→回环 = 通）、
  `e2e/header-bisect.cjs`（逐个头减 bisect，`只带 host → ERR_INVALID_ARGUMENT`）。
- **绿**：删掉显式 `host`；Host 由 Chromium 按上游 URL 生成。修复后回环实测收到
  `host=127.0.0.1:8791`、`authorization=Bearer …`，端到端 200 / 18 条。
- **回归**：`tests/unit/desktop-app-protocol.test.mjs` 断言转发头表里**不存在** `host`。

### 2. `verify:package` 的假通过（exit 0 但什么都没证明）

- **红**：首次 `verify:package` 返回 **exit 0**，但报告是
  `code=EXTERNAL state=external pid=null`——产物发现 8899 上已有服务，于是进入
  `external` 态**一个进程都没 spawn**，随后的 `/v1` 转发打的是**别人的服务**。
  整道门用一个不是本包拉起的进程给本包的自足性签了字。
  （占着 8899 的是本机无关进程 `node.exe gateway.mjs`，**未触碰**。）
- **定位**：判据在主进程与门脚本里各写了一份，且**漂了**——主进程把 `EXTERNAL` 当启动成功。
- **绿**：判据收敛成唯一一份纯函数 `apps/desktop/lib/verify-contract.cjs`，
  两边共用；门脚本另加起飞前端口体检。重跑：`state=running pid=35084` 才是真通过。
- **回归**：`tests/unit/desktop-verify-contract.test.mjs`（7 例）钉死
  `EXTERNAL` / `state≠running` / `pid` 非数字 / 各失败返回码 全部 fail-closed。
- **红→绿留痕**：默认端口 8899 被占的那次运行现在 **exit 1** 并点名端口与修法
  （`ZCC_VERIFY_PORT=<空闲端口>`），见上表 #7。

## 未做 / 已知边界

- 官方运行时 `C:\ZCode\resources\glm\zcode.cjs` **不在包内**：包自足的是反代运行时与界面。
  真发模型请求仍要求本机装了 ZCode。故 `verify:package` 只验「渲染 + `/v1` 转发」，
  真实模型调用的证据取自开发形态（#4）。
- `verify:package` 缺省端口 8899 在本机被无关进程占用，需显式指定空闲端口（见 #7）。
- 开发形态端到端是**取证脚本**而非 vitest 用例：它依赖真实凭据与网络，
  混进 `npm test` 会让默认测试面变成依赖真实配额的链。

---

# 第二轮：独立审查裁定后的修复

独立审查裁定 1 CRITICAL + 3 HIGH + 4 MEDIUM + 1 LOW + 1 保留意见，全部修复并留下
**变异红→绿**证据。修复后全部重新出包、重新验包。

## 命令 → 退出码（修复后重跑）

| # | 命令 | exit | 说明 |
| --- | --- | --- | --- |
| 1 | `npm run ci` | 0 | 25 文件 / 884 用例（根） + 4 文件 / 122 用例（`test:ui`） |
| 2 | `npm run test:ui` | 0 | 新增门：4 文件 / 122 用例 |
| 3 | `cd apps/desktop && npm run smoke` | 0 | 渲染 1583x922，smoke 不 spawn 反代 |
| 4 | `npm run pack:win` | 0 | exe 100,264,045 B（100,264,045 bytes），修复全部进 asar |
| 5 | `ZCC_VERIFY_PORT=8794 npm run verify:package` | 0 | 含新增的 asar 存在性检查 |

## 逐条修复与红→绿证据

### CRITICAL-1｜并发 `start()` 泄漏孤儿进程

**修法**：`start()` 入口加**同步**在途闸（`startInFlight`，任何 `await` 之前置位、
`finally` 复位）；`stopOwned()` / `dispose()` 遇「状态说在跑、手上没句柄」显式报
`INCONSISTENT_OWNERSHIP`，不再静默回 `NOT_OWNED`。

**变异探针**（把守卫里的 `startInFlight ||` 去掉，即退回修复前）：

```
× 双击「启动」并发两次：只有一个子进程，且它被管理器牢牢持有
  AssertionError: expected [ 'EXTERNAL', 'STARTED' ] to deeply equal [ 'BUSY', 'STARTED' ]
× 三连击并发：仍然只 spawn 一个，其余两个拿到 BUSY
  AssertionError: expected [] to have a length of 2 but got +0
× 并发 start 之后 dispose 收得干净：唯一那个子进程真的收到了信号
  AssertionError: 自己 spawn 的子进程必须收到停止信号: expected [] to include 'SIGINT'
Tests  3 failed | 26 passed
```

第三条正是审查描述的症状本身：**先 spawn 的那个子进程收到 0 个信号**，`dispose()`
碰不到它。恢复修复后 `29 passed`。

### HIGH-1｜`external` 不可逆死状态

**修法**：`start()` 去掉 `external` 的早退，每次都重新探端口——活着就继续只观察，
端口空出就正常接管。「只观察」约束的是**发信号**，不是「永远不许接管空端口」。
`restart()` 在 `external` 下也走同一条重探路径。界面同步放开「启动」按钮
（停止/重启仍结构性禁用），并在状态卡写明接管路径。

**变异探针**（把 `external` 早退加回去）：

```
× external 下再点启动 = 重新探一次：还在就继续只观察
  AssertionError: expected { ok: false, … } to deeply equal { ok: true, code: 'EXTERNAL' }
× external 不是死状态：外部进程消失、端口空出后，再点启动即可接管（I10 HIGH-1）
  AssertionError: expected { ok: false, … } to deeply equal { ok: true, code: 'STARTED' }
× restart 在 external 下也会重新探测
  AssertionError: expected { ok: false, … } to deeply equal { ok: true, code: 'EXTERNAL' }
Tests  3 failed | 26 passed
```

恢复后 `29 passed`。

### HIGH-2｜三条恒真 / 空转断言

**修法**：把源码扫描抽成纯函数 `findIpcLeaks` / `findConsoleLeaks`，并**先测扫描器本身**
（喂已知违规源码必须报出来、喂合法源码不得误报），再拿它扫真实 `main.cjs`；
`buildSpawnSpec` 抽成可注入纯函数 `lib/spawn-spec.cjs`，断言**真实产物**；
另加 IPC channel 闭集断言与 `publicSettings` 键级断言。

**变异探针**（把 key 塞进 argv，即审查点名的盲区）：

```
× 子进程 spawn 规格：key 只在 env，绝不进 argv（断言的是**真实产物**）
  AssertionError: expected '/repo/packages/api/bin/start-api.mjs …' not to contain 'zcc_leak_test_synthetic_key_000…'
Tests  1 failed | 18 passed
```

修复前这个变异**不会**让任何用例变红（原断言对象是测试自己手写的字面量数组）。

> 附带发现：扫描器自测当场抓出**我自己第一版扫描器**的漏洞——只认 `return` 关键字，
> `() => settings` 这种简写返回体能整条绕过。已修（判据改为 `=>|return` 两种形态都认）。

### HIGH-3｜`apps/ui` 测试不在任何门内

**修法**：`scripts/stage-gate.mjs` 新增 `test:ui` 门（`vitest run --root apps/ui`，
`apps/ui/vitest.config.ts` 进 `required`），并接入 `ci` 链。根 `vitest.config.ts` 不动
（UI01 有意隔离的既有裁定保持原样）。实跑 `4 文件 / 122 用例`，exit 0。

### MEDIUM-1｜掩码回提交摧毁真 key

**修法**：`normalizeSettings` 显式识别掩码回声（`API_KEY_MASK`）为「不改」。
用例覆盖掩码回提交 / 空串 / 真换新串三种情形。

### MEDIUM-2｜运行中改端口快照说谎

**修法**：`configure()` 在 `running` / `starting` 下**拒绝**改 port 与 spawn 规格，
返回 `{applied:false, reason:'PROXY_RUNNING'}`；新端口记进新增的 `configuredPort`，
快照新增 `portChangePending`。`snapshot.port` 恒为子进程真正在监听的那个。
界面在两者不一致时显示「待重启端口」。

### MEDIUM-3｜verify 模式退出无 dispose

**修法**：`runVerify` 的 `finish()` 改为 async，先 `await manager.dispose()` 再
`app.exit()`，并把收束结果写进报告。取证见 `e2e/dispose-probe.cjs`：
真子进程下 `dispose → {"ok":true,"code":"STOPPED"} after 34ms`，子进程确认已死，
探针进程 exit 0。verify 模式实跑输出 `[verify] OK dispose={"ok":true,"code":"STOPPED"}`。

### MEDIUM-4｜USAGE §13.3 补 Node 来源

**修法**：§13.3 加一段说明 `<node>` 是 **Electron 自带的 Node**（`process.execPath` +
`ELECTRON_RUN_AS_NODE=1`，见 `main.cjs` 的 `nodeCommand()`），干净机器无需预装 Node。
§13.4 的 `external` 语义同步改写（启动可重探接管 / 停止重启仍禁用）。

### LOW-1｜`isBodylessStatus` 含 101/103

**修法**：`BODYLESS_STATUSES` 收窄为 `{204,205,304}`；新增 `classifyUpstreamStatus`
把 `<200`（含 1xx 与非法值）判为 `invalid`，`main.cjs` 在**进 `Response` 构造器之前**
拦下并回 `upstream_status_not_representable`，不再被 catch 吞成假的
`upstream_unreachable`。用例含「`new Response(null,{status:101})` 确实抛 RangeError」的实证。

### 保留意见｜asar 内存在性检查

**修法**：`verify-package.mjs` 新增 `assertAsarContains()`，用 `@electron/asar`
的 `listPackage(asar, {isPack:false})` 断言产物 asar 里真的有
`lib/verify-contract.cjs` 与 `lib/spawn-spec.cjs`。理由：门脚本 require 的是**仓库副本**，
若 `files` 规则日后收窄，产物会缺文件而门仍然绿——那是一道自说自话的门。
实跑输出：`verify:package asar-contains lib/verify-contract.cjs` /
`verify:package asar-contains lib/spawn-spec.cjs`。

## 本轮过程中的一个假警报（如实记录）

中途 `verify:package` 曾报 `产物在 180000ms 内没有自行退出（输出：）`。用
`timeout N <exe> … | grep` 复现时输出全空，看起来像主进程挂死。改用后台起进程、
`ps` 判存活、并把 stdout 落文件后确认：产物**正常退出**，`[verify] OK dispose=…`
如实打印。根因是那层 `timeout | grep` 管道——孙进程继承了 stdout 句柄，管道不关，
`timeout` 一直等。**是取证姿势的问题，不是产品缺陷**；`dispose-probe.cjs`
（纯 Node + 真子进程，不经 Electron）单独验证了 `dispose()` 本身有界且干净。
