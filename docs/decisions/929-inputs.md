# 929 输入冻结与来源审计（I00）

- 状态：已冻结（本文为输入快照，不是长期有效事实；任何复用前须按 `review-artifacts/929/baseline.json` 的观察时间重验哈希）
- 观察时间：2026-09-29T06:24:35Z（UTC）
- 执行者：I00 子任务（独立会话，未派子代理）
- 关联计划：`G:/zcode-project/zcode-dev/929.md`（SHA-256 `13b3e59d3f43054c757db13b95174c75ae8e135200dee3be600664b656d1af5f`，已实测核对一致）
- 机器可读清单：`G:/zcode-project/zcode-companion/review-artifacts/929/baseline.json`

## 1. 决策背景

用户目标是一个独立的单 ZCode 桌面软件（内部名 **ZCode Companion**），不是 DSH/CSB/Lingma 的 fork。
2026-09-29 之前的 DSH（`dsh-zcode-appserver`，即 "ZCode Flash" DSH 插件，package `dsh-zcode-appserver` 0.6.3）
是在第三方宿主 DeepSeek Harness 内以插件形态运行的探索线；其 W10 亲修验收（39 段 / 47 PASS / 94 文件零漂移）
证明了关键机制（发送门控、回执恢复、付费闸、文件身份）在树侧成立，但该线未部署、且其固定协作会话
`sess_8d48083f-425c-4ef9-9b59-31a48e2f9e72` 已推进至 sequence 2100 附近，正在重锚 3.14.4 相关测试。
因此新产品 **不能简单继承"DSH 无漂移"结论**，本轮以只读哈希重新冻结输入，并显式标记 current drift。

## 2. 目标与边界

- 目标：冻结新产品可借鉴/可依赖的全部输入来源（路径、版本、指纹、许可、"已测或仅参考"标签），形成可追溯基线。
- 边界：本任务只写文档，不写产品代码、不安装依赖、不初始化 git；不修改任何旧仓库源码、`C:/ZCode`、
  生产 SQLite、账号/供应商配置；不启停 3188/Servy/ZCode；不真实模型发送；不 commit/push。
- 新旧仓库完全隔离：旧项目（zcode-dev/dsh-zcode-appserver、codex-project/zcode-flash 等）没有本包写入。

## 3. 输入来源表

所有路径为观察时位置；"标签"= 已测（本任务或冻结验收实测）/ 仅参考（只读借鉴，未在新产品验证）。

| # | 来源 | 位置 | 版本/指纹（观察时） | 许可 | 标签 | 用途边界 |
|---|---|---|---|---|---|---|
| S1 | 官方桌面宿主（静态包） | `C:/ZCode/resources/app.asar` | `@zcode/desktop` 3.14.4（ASAR header 只读提取）；SHA-256 `172d6f333e61642ce3882250949fafe8180f75b5b8e5552244ca2c59ca05d14e`（326,915,059 B） | 未知（Z.ai 专有，未核官方分发条款） | 已测（只读哈希+版本提取） | 只读参照；禁改签名、禁重打包、禁分发 |
| S2 | 官方 CLI runtime | `C:/ZCode/resources/glm/zcode.cjs` | `--version` = 0.16.9，exit 0；SHA-256 `fad4c35c4c36ec210d8a06d3fa0e77de23c8545e2eb6ff90aea1eb38d1e6275f` | 未知（同上） | 已测（只读 --version + 哈希） | 新产品可作为 spawn 目标的参照；未验证 app-server 能力与存活宿主版本 |
| S3 | DSH 插件工程（"zcode-flash" 适配线） | `G:/zcode-project/zcode-dev/dsh-zcode-appserver` | package `dsh-zcode-appserver` 0.6.3；核心借鉴件 `lib/appserver.js` SHA-256 `772d19b2079eb8076562dd5ea5b06f73d2230497aa97eca136b15f843af8482d`、`lib/desktop-bridge.js` SHA-256 `cd18360567e2d8e62afa7632f940ac19f1ab886876c123e1961fa467bc16892d`（观察时） | 本地私有项目，无 LICENSE 文件（用户自有，可自由复用其经验） | 仅参考（机制经验） | 只借经验：付费闸 choke-point、journal 回执恢复、writer lease、文件身份精度；不整仓复制 |
| S4 | DSH W10 冻结验收证据 | `G:/zcode-project/zcode-dev/dsh-zcode-appserver/review-artifacts/w10-repair-20260929/` | `acceptance.md` SHA-256 `8741f164d1d3ab216c52fcb718367d20a9f4bb7810f5be81c4a4082e94d84a90`；`final-summary.json` SHA-256 `1ad0e9ce6354c7231c88da5186659d4e438efc6b0e5ab0c4718bbb532c705750`；`source-after.json`（94 文件清单）SHA-256 `643c779e8a2cb455eb37c368d47b37fd6905aa15b5a46122c712ad75ca4b33f0` | 同 S3 | 已测（哈希与冻结值逐项核对一致） | T1–T4 树侧修复的证据基线；见 §6 漂移声明 |
| S5 | 官方桌面源码快照仓（zcode-flash 目录） | `G:/codex-project/zcode-flash` | 根 package.json 为官方发行元数据 `@zcode/desktop`（SHA-256 `e8c283a704f82975301fcd6c3c6ae0255593133d08b600bb6952206610704b3e`）；web 监控面 `zcode-flash-monitor` 0.1.0（`web/package.json` SHA-256 `47fb07d1114011493567512a4f817b5ae51ef6e7216f1d08ef5333d1f4864abf`、`web/monitor-contract.md` SHA-256 `ff1c8a6b22be146c71b999dc2328be9dcdb7757893c918a74d66883e022bfa7d`） | 无 LICENSE/README/AGENTS（根级均不存在）→ 官方部分视为专有/未知 | 仅参考 | **根 package.json 禁用为新脚手架**；仅借 web/ 监控 UI 与契约文档的页面/路由/测试经验 |
| S6 | lingma-proxy 参考项目 | `G:/qoder-intl-project/lingma-proxy` | `AGENTS.md`（68 行）、`LICENSE`（35 行，MIT 限定原作者贡献）、`README.md`（1136 行） | LICENSE = MIT，**仅覆盖本仓 Tiancheng Lu 等人的 Original Contributions**；文件内明确上游 `coolxll/lingma-ipc-proxy` 无明确开源许可、本 LICENSE 不对第三方材料再授权 | 仅参考 | 只借产品页面/路由/测试经验；**零代码复制**（上游许可不明，仓内第三方材料同样不得复制） |
| S7 | 计划文档 | `G:/zcode-project/zcode-dev/929.md`（1004 行） | SHA-256 `13b3e59d3f43054c757db13b95174c75ae8e135200dee3be600664b656d1af5f` | 用户自有 | 已测（哈希核对一致） | 新产品唯一需求权威源 |
| S8 | 协作进度记录 | `G:/zcode-project/zcode-dev/collaboration.md`（830 行）+ 协调者 brief（固定会话 seq≈2100 重锚 3.14.4） | 文本快照，未单独哈希 | 用户自有 | 仅参考 | DSH 后续状态的二手记录；不能替代只读哈希复验 |

## 4. 许可与复用裁定

1. **官方载荷（S1/S2/S5 的 `@zcode/desktop` 部分）**：许可与再分发条款未知 → 一律只读参照；
   不修改签名、不解包再分发、不把官方 package.json 当脚手架。若未来需要分发新产品，须先取得官方许可结论（当前=未知）。
2. **DSH（S3/S4）**：用户自有本地项目，无 LICENSE 限制；机制与验收经验可自由进入新产品，但按计划仍以"借鉴经验、重写实现"为口径，不做整仓搬运。
3. **zcode-flash web 监控面（S5 的 `zcode-flash-monitor`）**：依附官方源码快照仓、无独立许可 → 仅经验参考，不复制代码。
4. **lingma-proxy（S6）**：MIT 仅限该仓原创贡献；上游无许可 → 产品/路由/测试思路可借鉴，代码零复制。
5. 裁定总则：不确定的一律标"未知"，不凭名称或记忆断言可分发。

## 5. 运行时分层（新产品目标形态）

```
┌─ L3 产品层：ZCode Companion（G:/zcode-project/zcode-companion，自有代码，独立 Electron/本地应用）
│    自有 UI、发送门控、journal 回执恢复、设置传递；借鉴 S3/S5/S6 的经验，不 fork 任何仓库
├─ L2 CLI 运行时：C:/ZCode/resources/glm/zcode.cjs（0.16.9）——被 spawn 的官方入口；只调用，不改写
├─ L1 桌面宿主：C:/ZCode（@zcode/desktop 3.14.4 静态 ASAR）——只读宿主；存活宿主版本未验证
└─ L0 生产数据：官方 SQLite/journal——只读；本任务未触碰
```

分层规则：L3 对 L1/L0 永远只读；对 L2 仅按官方 CLI 接口调用；任何写入只发生在 L3 自有目录。

## 6. 真实未证清单（截至观察时间）

1. **current drift（本任务实测）**：W10 冻结的 94 文件清单中 **5 个文件已漂移**：
   `lib/operations.js`、`package.json`、`test-offpeak-index-recovery.mjs`、`test-operation-disposition.mjs`、
   `test-task-index-recovery.mjs`（当前哈希见 baseline.json）。漂移方向与协作会话 seq≈2100 的 3.14.4 测试重锚一致，
   属预期工作面；本任务不改旧代码、不判定漂移质量。**"DSH 94 文件无漂移"自此不再是可继承结论。**
2. 存活宿主（正在运行的 ZCode 桌面进程）版本未验证；S1/S2 均为静态包观察。
3. 官方 CLI `--help` 的 disallowed-tools 仅证明 prompt/TUI 面，app-server 能力等同性未验证。
4. DSH W10 的 T1–T4 修复为树侧通过（39 段 / 47 PASS / exit 0），**未部署**（deployed=false）；未称独立第三方签收。
5. 官方桌面/CLI 的许可与再分发条款未知；lingma-proxy 上游 `coolxll/lingma-ipc-proxy` 许可未知。
6. 新产品尚未实现（implemented=false）：无代码、无依赖、无打包、无真实验收。
7. 本任务未做账号握手、未真实模型发送、未读取任何凭据值。
