# RA-08 同 ID 冲突 · 私有挂载验收报告

- task: `ra08-sameid3` / project: `sameid3`
- 定案 round: `4b8bcc04-efb5-4fbb-91d9-e8d1b6f01e5b`（第三轮，前两轮如实作废）
- 作废 round: `88c6eb46-…` 与 `1eaddd76-…`（artifact 路径复用，永久无法自证，证据全部保留）
- 仓库 HEAD: `1558342a0aec04138135a7970aa0b72bc585a9fb`（未提交、未推送）
- 正式源码**零改动**：`modelSource.ts` SHA256 `78acdb7a2266a3dca4f36543bf7cab0b0cfe57cc888f01abc815269a39642e43`
  与 `ModelsPage.tsx` SHA256 `B04524FE6B7CE99093701760CE2F1971534E763949974C15A7A2AC2007F38CCE`
  本轮前后逐字节一致；`git status --porcelain -- apps/ui/**` 空（CLEAN）。

## 主上要补的缺口

此前所有轮次的合成数据都用 `src-` / `man-` **不同前缀**，所以「手工 modelId 与来源
modelId 完全同名」这一场景**从未被实测过**。同名会不会互相合并 / 覆盖 / 误删 /
污染 delta，只能靠静态推断——本轮用真实挂载把它测出来。

## 结论

**两条域物理隔离成立。**同名不合并、不覆盖、不误删、delta 不被污染，来源真消失仍如实计入。

## 行为证据（权威）

定案 action `b293ea06-80d7-4f88-b9f5-989b972edfcc`
- pid `1732`，exit `0`，`2026-10-07T01:36:44Z → 01:36:47Z`，timeout/interrupted 均 false
- 测试进程真实退出码 `VITEST_EXIT=0`，`CLASS=all_passed`
- `Tests 3 passed (3)`，Duration 2.00s

| 用例 | 断言要点 | 结果 |
|---|---|---|
| K1 | 同名两域各自独立：写死只见手工 1 行（origin=手工录入、provider=unknown），动态只见来源 2 行；同名来源行 origin 仍为「来源读回」、provider 未被 unknown 覆盖 | PASS |
| K2 | 删**同名**手工条目后刷新来源：`来源条目 2 条`、`当前列表条目2`、origin/provider 未污染、摘要「与上次一致」，且**不含**「新增 1」「消失 1」；fetch 次数增加且全部为 `/v1/zcc/catalog` | PASS |
| K3 | 正控：同名手工仍在时来源真由 2→1 → 「消失 1（src-b），保持 1 个，2 → 1」，证明 delta 非恒零 | PASS |

K3 是**正负成对**的正控：只验负控无法排除「delta 恒零」这类实现。

## 实现依据（静态对照，二阶佐证）

action `9d219699-95ad-4ea7-80c1-db17c1efe2cb`
- `HAS_manual_key=True` / `HAS_source_key=True` ⇒ key 双命名空间（`modelSource.ts:181` `manual:m{n}` vs `:535` `source:{modelId}`），行 `key={e.key}`（`ModelsPage.tsx:665`）不会 React 键冲突
- `HAS_activeEntries_ternary=True` ⇒ `:779` 按 mode 二选一
- `HAS_merged_domains=False` ⇒ 全文件**无任何** `concat` 合并两域
- `HAS_delta_only_source=True` ⇒ `:658-660` 只比 `refresh.entries`
- `HAS_remove_filter_manual_only=True` / `HAS_remove_touches_refresh=False` ⇒ `:773-775` 删除只 filter 手工域

## 排除的缺陷形态

- **D-a 同名来源行被手工覆盖** — K1 origin/provider 断言排除
- **D-b 删同名手工误删来源** — K2 按 (modelId + origin) 双条件定位删除，来源两条逐条仍在
- **D-c 同名手工计入来源 delta** — K2 摘要无「新增 1」「消失 1」，delta 为「与上次一致」
- **D-d 删除后刷新污染来源状态** — K2 origin/provider/条目数/摘要四项全查

## 边界（如实标注，未测项）

- happy-dom 20.11.6 私有挂载，**非真实浏览器**：无布局、无 CSS、无可见性计算、无 Tab 焦点
- fetch **全替身**：无真实 8790 服务、无回环守卫、无真实上游目录；catalog 为合成数据
- 故本轮只证明**逻辑隔离与请求面**，不证明真实网络下的行为
- 未覆盖：来源侧同名重复 key、手工侧同名重复 key（`listDelta` 按 modelId 比对，同域内重复 id 的语义未验）
- **RA-08 整体仍未签收**：总览/聊天/请求记录/API关闭页/设置诊断页、多尺寸缩放、恶意 Markdown 均未测

## 本轮失败留证（全部为探针/环境自身缺陷，非产品缺陷）

| action | exit | 原因 |
|---|---|---|
| `c1d8741e` | 1 | runner 指向 `apps/ui/node_modules/vitest`（该目录无 vitest，实为仓库根 `node_modules`）→ `MODULE_NOT_FOUND`。**探针环境缺陷** |
| `8b76b772` | 1 | 探针挂到 `src/` 下，`./ModelsPage` 相对路径不存在 → `ERR_MODULE_NOT_FOUND`，`Tests no tests`，分类器正确判 `import_failed`。**探针自身缺陷** |
| `44d4afb0` | 1 | K1 绿、K2/K3 红于**断言锚点写错**：用了「当前读取 N 个条目」，实际不存在。**探针自身缺陷** |
| `c6aa26ea` | 1 | 锚点二次修正仍错：用了「当前列表条目 2」（带空格），源码 `:540-541` 是 `<dt>/<dd>`，实测无空格 ⇒「当前列表条目2」。**探针自身缺陷** |
| `877ca142` | 1 | 静态核脚本经 `python -c` 传参时 PowerShell 吃掉了反引号，且 cwd 为 round 目录 ⇒ `FileNotFoundError`。**工具调用缺陷**，改用脚本文件重跑为 `9d219699` |

四次红全部源自探针自身；**K1 在第一次运行即绿**，K2/K3 的红与产品行为无关——
原始 stdout 里产品真实渲染的 delta 文案（`与上次一致：2 个条目，无增删` /
`新增 0，消失 1（src-b），保持 1 个，2 → 1`）本来就正确。

## 未改动的既有封存证据

`b1719705` / `ea12ae1c` 及此前各轮目录一概未动。
