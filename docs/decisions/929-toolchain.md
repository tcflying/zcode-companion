# 929 工具链与配置决策（I01）

状态：已实施并实测。裁定依据是 `docs/decisions/929-inputs.md`（I00，只读）与 `G:/zcode-project/zcode-dev/.superpowers/sdd/929/task-I01-brief.md` 的"技术决策"一节。协调者已裁定版本，无需向用户询问。

所有版本号与 metadata 均在 2026-09-29 由本机 `npm view`（registry `https://registry.npmjs.org/`）与 `node_modules/*/package.json` 双向核对，见第 6 节。

---

## 1. 运行时与包管理器

| 项 | 值 | 来源 |
| --- | --- | --- |
| Node（开发机） | `v24.18.0` | `node -v` |
| npm（开发机） | `11.16.0` | `npm -v` |
| registry | `https://registry.npmjs.org/` | `npm config get registry` |

`package.json` 的 `engines` 固定为 `node >=24.18.0`、`npm >=11.16.0`。

**Electron 内嵌 Node ≠ 开发机 Node。** 两者都存在但不可互相替代作为证据：开发机 Node 只用于运行构建与测试工具链；Electron 内嵌 Node 的行为（例如 `node:sqlite` 可用性、`utilityProcess` 行为）必须在真实 Electron 壳内验证，那属于 I10，本阶段**未测**。

## 2. 直接依赖版本锁

全部为 registry 当前 `dist-tags.latest`，engines 与本机 Node 24.18.0 兼容。

| 包 | 锁定版本 | registry latest | engines（registry / 实测安装一致） |
| --- | --- | --- | --- |
| `electron` | `44.4.5` | `44.4.5` | `>= 22.12.0` |
| `typescript` | `7.0.2` | `7.0.2` | `>=16.20.0` |
| `react` | `19.3.0` | `19.3.0` | `>=0.10.0` |
| `react-dom` | `19.3.0` | `19.3.0` | 未声明 |
| `vite` | `8.3.1` | `8.3.1` | `^20.19.0 \|\| >=22.12.0` |
| `vitest` | `5.0.2` | `5.0.2` | `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0` |
| `@types/node` | `24.19.0` | 不适用（类型包） | 未声明 |

`package.json` 声明版本与 `package-lock.json` 解析版本逐项一致；lockfileVersion 3；97 个带 `resolved` 的包**全部**来自 `registry.npmjs.org`，**全部**带 `integrity`，无第三方镜像。

### 关于 `react` / `react-dom` 的类型

React 运行时已锁，但 `@types/react` / `@types/react-dom` **故意未加入 I01 的依赖**：I01 自身没有任何 TSX 源码，引入类型包属于 UI01 的依赖决策。UI01 需要在自己的子包内锁定它们（见第 5 节移交项）。

## 3. TypeScript 配置裁定

`tsconfig.json` 采用 **Node / `nodenext`** 语义：`target ES2023`、`module nodenext`、`moduleResolution nodenext`、`types: ["node"]`、`strict`、`noUncheckedIndexedAccess`、`noEmit`。

- `allowJs: true` + `checkJs: false`：I01 的 `scripts/` 与 `tests/` 全部是 `.mjs`。`npm run typecheck`（即 `tsc --noEmit -p tsconfig.json`）**只**做这一档，`.mjs` 不在其中——**单看 `typecheck` 通过仍不等于这些文件被类型检查**。
- **`checkJs: true` 是独立且强制的一档**：`npm run typecheck:checkjs`（`tsc --noEmit -p tsconfig.json --checkJs true`）在同一 `strict` + `noUncheckedIndexedAccess` 配置下检查 `scripts/` 与 `tests/` 的全部 `.mjs`，并已接入 `npm run ci`。因此 `ci` 通过同时意味着"根 `.ts` 干净"与"全部 `.mjs` 干净"，`checkJs:false` 掩盖的类型缺陷会让主链变红。
- 该档不是把 `checkJs` 打开后放着不管：`.mjs` 侧的显式注解（JSDoc）已补齐，`fail()` 带 `@returns {never}`，`catch (e)` 一律以 `e instanceof Error ? e.message : String(e)` 收窄。JSON 解析结果显式标注为 `any`（`JSON.parse` 输出形状未知，由 fixture 自身的校验函数负责），除此之外没有用 `any` 掩盖真实分支。
- `include` 覆盖：`vitest.config.ts`、`scripts/**/*.mjs`、`tests/**/*.mjs`、`tests/**/*.ts`、**`packages/**/*.ts(x)`**。**不含** `apps/**`（见下）。
- `skipLibCheck: true`：避免上游 `@types` 与 TS 7.0.2 之间的噪声，不影响本仓库源码。

### F05 裁定：`packages/` 与 `apps/` 的类型检查归属

收口要求"不能让后来模块完全逃出 typecheck"。落地方式是**按工程边界分开，而不是全部塞进根工程**：

- **`packages/` → 并入根工程。** `packages/**` 已写入根 `tsconfig.json` 的 `include`。它目前不存在，因此对今天的 `typecheck` 零影响；一旦建立，源码立即进入严格检查。该结论由合同测试**实测**：`packages/i01-typecheck-probe.tmp.ts` 写入一个类型错误后，根 `tsc --noEmit -p tsconfig.json` 真实失败并点名该文件，删除后恢复 EXIT0。

- **`apps/` → 独立嵌套工程，用独立门 `typecheck:apps` 检查，不并入根工程。** 理由：
  1. `apps/ui/` 是 UI01 工单的在制品，拥有自己的 `package.json`（`@zcode-companion/ui`）与 `tsconfig.json`。它的编译语义（`moduleResolution: bundler`、`lib` 含 `DOM`/`DOM.Iterable`、`jsx: react-jsx`、`types: []`、`noUnusedLocals`）与根工程的 Node/`nodenext` 语义互斥，同一进程内无法同时成立。
  2. 并入根 `include` 会让 I01 的 `typecheck` 门依赖另一个工单尚未交付的源码，把 I01 的验收结果绑到别人的半成品上。
  3. I01 的边界禁止修改其他工单未交付的实现，因此不能通过改 `apps/ui/tsconfig.json`（例如加 `composite`）来用 project references 把它串进根工程。

  因此新增门 `typecheck:apps`（`npm run typecheck:apps`），由 `scripts/stage-gate.mjs` 用**根工程的 tsc** 执行 `tsc --noEmit -p apps/ui/tsconfig.json` 并**原样传播真实退出码**。它不并入 `npm run typecheck`（根工程语义不同），但**已进入 `npm run ci`**。合同测试实测该门：门退出码必须与直接调用 tsc 的退出码相等，且当 apps 存在错误时输出必须指向 `apps/ui/` 下的真实文件。

  **Q1 接线裁定（已实施，不再是移交项）**：`ci` 定义为 `npm run typecheck && npm run typecheck:checkjs && npm run typecheck:apps && npm run test`。此前该门游离在主链之外，一个真实的 UI 类型错误不会让任何主链门变红，这与"不能让后来模块完全逃出 typecheck"的收口要求相悖。选这个方案而不是另设 `ci:all`，理由是：`ci` 是本工程唯一的聚合门，另设一条不常用、不被调用的链等于把问题换个地方保留；把 `typecheck:apps` 排进 `ci` 也符合协调者"波动需要被 CI 暴露而不是被隐藏"的裁定。

  **"门不存在"与"门通过"必须可区分**：因为 `apps/` 由另一个工单在制品，`typecheck:apps` 在 `apps/ui/tsconfig.json` 缺失时**禁止静默跳过**。`scripts/stage-gate.mjs` 为此在启动 tsc **之前**显式检查该文件，缺失即以**独立退出码 4** + 标记 `APPS_PROJECT_NOT_CREATED` 阻断。因此三种结果互不混淆：

  | 结果 | 退出码 | 标记 |
  | --- | --- | --- |
  | `apps/` 类型检查通过 | 0（= 直接 tsc 的真实退出码） | — |
  | `apps/` 存在类型错误 | 1（= 直接 tsc 的真实退出码） | tsc 自身输出，指向 `apps/ui/...` |
  | `apps/` 工程尚未创建 | **4** | `APPS_PROJECT_NOT_CREATED` |

  该行为由合同测试 `gates.test.mjs` 的 "a missing apps/ project config fails the typecheck:apps gate loudly instead of skipping it" 实测：在临时根里放一个"必定返回 0"的 tsc 桩、但不放 `apps/ui/tsconfig.json`，门必须以 4 + 标记失败——桩若被执行则该测试失败，因此它不是恒真断言。

  **剩余移交项（UI01 / I04 负责，I01 不代做）**：
  1. UI01 在 `apps/ui` 内锁定 `@types/react`、`@types/react-dom`，使 `apps/ui` 自己的 `typecheck` 归零。
  2. `apps/ui` 必须在自己的依赖被清空后重装，否则 `typecheck:apps`（因而 `ci`）会因缺类型而失败。这是**真实的**波动态，`ci` 如实暴露它，而不是把它藏起来。
  3. 若后续决定把 `apps/` 改为 npm workspaces，必须同时决定根 `tsc` 的 project references 拓扑，不能让两套配置长期并存。

## 4. 测试运行器配置

`vitest.config.ts`：

- `environment: 'node'`，`include: ['tests/unit/**/*.test.mjs', 'tests/contract/**/*.test.mjs']`。
- `passWithNoTests: false` —— 空测试类别必须非零，禁止 `allowNoTests`。
- `testTimeout: 15000`；`scripts/stage-gate.mjs` 对未在 `test`/`ci` 链上的门另加显式超时。
- `integration` / `mutations` / `e2e` 类别**不接线**，其 npm 门由 `stage-gate.mjs` 以 `NOT_IMPLEMENTED`（EXIT3）fail-closed 阻断发布。

`tests/contract/gates.test.mjs` 自身是 `test:contract` / `test` 的 vitest 目标，因此**禁止**在这两个门内部再调用自身。分类与目标选择用 `--print-targets`（完整校验、不启动 vitest），真实执行用独立临时测试根的哨兵测试。详见 `scripts/stage-gate.mjs` 头部注释与该测试文件头部注释。

## 5. 暂不引入的依赖

- **不引入 `better-sqlite3` / `electron-rebuild`**：优先使用 Electron 内嵌 `node:sqlite`。真 `utilityProcess` + SQLite + fake stdio 三联验证属 I10。
- **不引入 linter**：`lint` 门为 `NOT_IMPLEMENTED`（EXIT3）。不用空脚本冒充 lint 通过。
- **不引入打包链**：`build` / `pack:win` / `verify:package` 均为 `NOT_IMPLEMENTED`（EXIT3）。最终打包方式由 I21 明确实施；在此之前 `pack`/`verify` 必须 fail-closed。

## 6. 复核记录（2026-09-29）

- `npm view <pkg> dist-tags.latest engines` × 6：全部返回上表 `latest`，engines 与实测 `node_modules` 一致。
- `node -e` 解析 `package-lock.json`：`lockfileVersion 3`，97 个 `resolved` 全部 `registry.npmjs.org`，`integrity` 缺失数 0。
- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → EXIT0（这是当前配置的**范围**内通过，不是"所有未来模块已覆盖"）。
- TS 7.0.2 的 `bin` 为 `{"tsc": "./bin/tsc"}`；`stage-gate.mjs` 因此通过解析 `vitest/package.json` 的 `bin` 字段取得 vitest CLI 路径，而不是硬编码 `node_modules/vitest/vitest.mjs`。
- 观察到 npm 报告未知用户配置键 `electron_mirror`（`npm warn Unknown user config`）。该键属于既有用户级配置，**本工单未读取、未修改、未新增**；禁止在本工单内"顺手修掉"，它属于全局配置变更边界之外。
- 前一位作者 `agent_78be20d6-9c75-4852-8979-9537f19964d4` 的安装日志**未取得**，本文件不重建任何历史安装记录。

### 6.1 独立审查 I-1 / Q1 返工后的复核记录（2026-09-29）

独立审查（`task-REV-UI01-I01-review.md`）实测 `tsc --noEmit -p tsconfig.json --checkJs true` 为 EXIT1、30+ 条错误，并指出 `stage-gate.mjs` 的 `fail()` 缺 `@returns {never}` 导致 `gate` 的 `possibly undefined` 级联。修复后复核：

| 命令 | 退出码 |
| --- | --- |
| `npm run typecheck`（`checkJs:false` 档） | 0 |
| `npx tsc --noEmit --checkJs true`（`checkJs:true` 档） | 0 |
| `npm run typecheck:checkjs` | 0 |
| `npm run typecheck:apps` | 0 |
| `npm test` | 0（2 files / 28 passed / 6.05s） |
| `npm run ci` | 0 |
| 7 个 `NOT_IMPLEMENTED` 门 | 各 3 |
| 缺 gate / 未知 gate / 未知选项 | 各 2 |
| `stage-gate.mjs typecheck:apps` 指向无 `apps/ui/tsconfig.json` 的临时根 | 4（`APPS_PROJECT_NOT_CREATED`） |

**未解决 / 风险（不得当作稳定保证）**：
- `typecheck:apps` 与 `ci` 的结果完全由 `apps/ui/src/**` 决定，而 `apps/` 由并发工单 UI01 持续改动。上述 0 是**采集时的单次观测值**；`apps/ui` 依赖被清空或存在一个类型错误都会让 `ci` 变红——这是有意的 fail-closed 行为。
- `.mjs` 的 `checkJs:true` 档依赖显式 JSDoc 注解。后续新增 `.mjs` 若不带注解，`npm run ci` 会立刻变红（这是该档的目的），但也可能让作者倾向于"少写注解"而不是"写对类型"。`lint` 门仍为 `NOT_IMPLEMENTED`，没有 `@typescript-eslint` 兜底。
- `apps/ui/tsconfig.json` 属于 UI01，I01 未修改 `apps/**` 任何文件。
