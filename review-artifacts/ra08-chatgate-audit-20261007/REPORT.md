# RA-08 会话页（ChatPage）E0 发送门 · 私有挂载验收报告

- task: `ra08-chatgate` / project: `chatgate`
- round: `eb4613dc-d4ee-4a05-aef1-2b4abdcdc2f0`（**一次通过，零失败 action**）
- validate: `accepted_blocked` / `evidence_valid=true` / exit 0
- 仓库 HEAD: `1558342a0aec04138135a7970aa0b72bc585a9fb`（未提交、未推送）
- 正式源码**零改动**：`ChatPage.tsx` SHA256 `a09b9d89fe67fd2c644edfa56039ada1f18f839a7a9bc63faf7d1f61b7639db4`、
  `snapshot.ts` SHA256 `3f4600a22e90963ee224e17ba0e62d8a51cfa888520a390f073e621906b4cfb8`、
  `useAppState.ts` SHA256 `9a1d110ee5e47a4307ef604020551a8e6e24bc52ec8fc9867fa70a6416254be8`
  本轮前后逐字节一致；`git status --porcelain -- apps/ui` 空（CLEAN）。

## 开工前确认

- 无后台任务在跑（`task_query` 返回空）；`apps/ui` 无 `.lock` 文件 ⇒ **无 writer 占用**
- 既有 dirty 只有 10 条 `?? review-artifacts/*`（本会话审计目录），未碰历史台账
- allowlist：只写 `review-artifacts/ra08-chatgate-audit-20261007/`，未改产品/父仓库/记忆

## 需求出处

- `929.md:240` E0「未知：无有效资格/用量证据 —— 权益未确认，暂不可发送」
- `929.md:868` 禁用态/fixture 必须显著标注，且「零 dispatch」
- `929.md:869` 证据必须来自真实挂载与真实交互，**禁止 hook 或夹具替代**

## 是否重复旧证据

**否。** 此前只有 `review-20261003:299` 在**路由切换**场景里观察过 `draft 43→0`，
从未在真实挂载下测过：长中文草稿、恶意 HTML/Markdown 草稿、真实 input 事件 + Enter、
重复清空、以及 fetch/XHR/WebSocket 四通道 dispatch 计数。本轮全为新覆盖。

## 结论

**E0 发送门在合成环境下成立：草稿可输入可清空，发送门全程禁用，四通道零 dispatch。**
未发现产品缺陷，**不需要最小修复候选**。

## 行为证据（权威）

定案 action `961d1f88-34e3-4c87-bf81-1f87fee5c968`
- pid `65184`，exit `0`，`2026-10-07T03:02:59Z → 03:03:01Z`，timeout false
- `VITEST_EXIT=0` / `CLASS=all_passed` / `Tests 5 passed (5)`

| 用例 | 断言要点 | 结果 |
|---|---|---|
| **G1 空草稿正控** | `value=''`、字数 0、发送按钮 `disabled`、E0 文案「权益未确认，暂不可发送」与 `dispatch = 0` 在页、四通道计数全 0、`callLog` 空数组 | PASS |
| **G2 长中文草稿 + Enter** | 122 字草稿原样保留、字数 122、`.turn` 恒为 5、5 个 `.bubble` 无一含草稿文本、门仍 disabled、零 dispatch | PASS |
| **G3 恶意 HTML/Markdown** | 不产生真实 `script`/`iframe` 元素、`window.__pwned`/`__pwned2` 均 undefined、连续两次 Enter 草稿与字数不变、零 dispatch | PASS |
| **G4 清空草稿** | 清空前长度 > 0 且 `value` 与字数一致 → 清空后 `value=''`、字数 0；留下「草稿已清空…dispatch = 0」日志；**重复清空两次幂等不抛错**；全程零 dispatch、门仍 disabled | PASS |
| **G5 disabled 无法触发发送** | 对 disabled 的「不可发送（E0）」与 disabled 的「取消」**直接 `.click()` 绕过 React 委托** + 真实 Enter → `.turn` 数不变、草稿与字数不变、fetch/XHR/WebSocket/IPC **逐项为 0**、`callLog` 空 | PASS |

Enter 用**真实三连事件**（`keydown` + `keypress` + `keyup`，`keyCode:13`），
输入走 React `onChange` 链路（原生 value setter + `input` 事件）。

## 静态对照（二阶佐证）

action `5f024287`，pid 24848，exit 0：

- 剔除注释与字符串字面量后的**代码区**：`fetch`/`XMLHttpRequest`/`WebSocket`/`ipc`/`axios`/`chat_completions` **全部零命中**
- 无 `onKeyDown`/`onKeyPress`/`onKeyUp` ⇒ 回车**在源码层就没有发送分支**
- 发送按钮标签体 9 行：**含 `disabled`，不含 `onClick`**
- 全文件 `onClick` 恰为 **1 处**，且属 `handleClearDraft`（`ChatPage.tsx:111`）

## 排除的缺陷形态

- **E0 下草稿能触发发送** — G2/G5 三种触发方式（真实 Enter、disabled 按钮直点、取消按钮直点）全部零副作用
- **清空草稿产生请求** — G4 计数恒定
- **重复清空报错** — G4 幂等
- **恶意草稿产生真实元素或请求** — G3
- **草稿字数控件与实际值脱节** — G2/G3/G4 用 `LONG_CN.length` / `evil.length` 精确比对

## 边界（如实标注，未测项）

- happy-dom 20.11.6 **非真浏览器**：无布局、无 CSS、**无 Tab 焦点序列、无真实键盘处理**
- fetch / XMLHttpRequest / WebSocket **全替身**，本轮**不存在真实网络**
- ChatPage **本身不引用 assistant 消息接口**，本探针**未注入任何不存在的接口**
- 草稿仅验证「作为文本不产生真实元素与请求」，**不构成完整 Markdown/HTML 净化验收**
  （裁定产物中 `markdown_sanitization_verified: false`）
- **RA-08 整体仍未签收**：总览页/请求记录/API关闭页/设置诊断页、
  多尺寸缩放 800×600 / 1280×720 / 1920×1080 及 125%/150%、Tab 焦点顺序、完整恶意 Markdown 渲染全未测

## 本轮过程：预验证拦下 5 处探针/检测器自身缺陷（**零失败 action**）

吸取上一轮「artifact 路径复用导致两个 round 作废」的教训，本轮**开 round 前先在工作区
预验证全部三个脚本**，因此没有产生任何失败 action。预验证拦下：

1. `.turn` 轮数误写 4 —— 实为 5（`PLACEHOLDER_TURNS` 4 条 + `:70` 结果未知占位 1 条）
2. `.bubble` 检查误用整页 `text()` —— **happy-dom 会把 textarea 的 `value` 映进 `textContent`**，
   草稿必然「出现」在页面文本里；改查 `.bubble` 集合才准确
3. 静态检测按固定子串切片切错位置，把下一个按钮的 `onClick` 误算进发送按钮标签
4. 改按行定位后找 `/>` 越界 —— `ChatPage.tsx:99-107` 按钮标签跨 9 行且收尾是 `</button>`
5. 全文件搜 `WebSocket` 命中 `:95` placeholder 文案「没有 fetch/XHR/WebSocket」
   ⇒ **假红**，改为先剔除注释与字符串字面量再搜标识符

第 2 条和第 5 条都是「检测手段本身会制造假红/假绿」的坑，不是产品缺陷。

## 附带事项（如实报告）

- `mavis-trash.cmd` 本轮报「launcher 不可用」，**未删除任何文件**。
  预验证残留 `_preflight-chatgate.json` 保留在 round 目录内，**未在 gate 声明**，不影响证据链。
  需要清理请主上手动删除，或等 launcher 恢复。