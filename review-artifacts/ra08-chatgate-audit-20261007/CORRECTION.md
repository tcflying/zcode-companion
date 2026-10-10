# 更正说明（诚实更正 · 追加，不修改原报告）

- 更正对象：本目录 `REPORT.md` 与 `evidence/eb4613dc-…/report.json` 中关于 **dispatch 通道数**、
  **Enter 事件性质**、**disabled `.click()` 证明力** 的表述
- 更正时间：2026-10-07（主线程复核 `chatgate.probe.test.ts` 后指出）
- 旧探针回执**全部保留不改**：定案 `961d1f88-34e3-4c87-bf81-1f87fee5c968`
  （pid 65184，exit 0）、静态对照 `5f024287`、裁定产物 `a7437f21`，
  以及 `_preflight-chatgate.json`、`report.json` 一概不动
- **正式文件零改动**：`apps/ui` git CLEAN，本轮只在本审计目录追加本文件

---

## 更正 1：IPC 不是「实测零 dispatch」通道，是恒 0 的空壳

**原表述（不成立）**：`四通道零 dispatch`、`fetch/XHR/WebSocket/IPC 四通道计数逐项为 0`。

**实际代码事实**（`private/chatgate.probe.test.ts`）：

- `fetch` / `XMLHttpRequest` / `WebSocket`：**有真实替身实现**，每次被调用都会 `count += 1`
  并往 `callLog` 追加字符串。这三者是**可观测通道**。
- `ipcCount`：**只在 `beforeEach` 里被赋初值 0，全文件没有任何代码能让它增长**——
  没有 IPC 替身、没有拦截器、没有任何调用点会触发它。
  它在 `dispatchTotal()` 里被加进去，等于把一个**恒为 0 的常量**算进总数。

**更正后的准确表述**：

> fetch / XMLHttpRequest / WebSocket **三通道**在合成替身下实测为零调用；
> IPC **仅静态核查**——`ChatPage.tsx` 代码区（剔除注释与字符串后）零命中
> `ipcRenderer` / `ipc`，且该页是纯前端渲染、无任何 IPC 调用入口，
> **但未对 IPC 做动态拦截或计数验证**。

因此 `dispatchTotal() === 0` 这一断言的**有效证明范围只覆盖三通道**，IPC 项是恒真项，
不构成额外证据。主线程的判断完全正确。

**为什么不补跑**：要让 IPC 成为真正的第四通道观测，必须**注入一个 IPC 替身**
（如 stub 一个 `ipcRenderer` 或经 preload 桥暴露的对象）。但本产品会话页**本来就不存在
这条调用路径**，凭空造一个接口再断言它没被调用，属于制造一条永不失败的断言 ——
**没有证明价值，且会污染「零 dispatch」这个结论的可信度**。故按主线程要求：
不虚构 IPC 接口，不重复跑绿。

## 更正 2：Enter 是 synthetic KeyboardEvent，不是真实键盘

**原表述（不成立）**：`真实 Enter 三连事件（keydown/keypress/keyup）`、
`真实 Enter 不得新增任何对话轮次`。

**实际做法**：`new window.KeyboardEvent('keydown', {keyCode:13, …})` 等**脚本构造的事件对象**，
经 happy-dom 的 `dispatchEvent` 投递。**没有任何物理键盘、没有浏览器默认行为、没有 IME 组合态。**

**更正后的准确表述**：

> 脚本构造的 keydown / keypress / keyup 三个 KeyboardEvent 经 `dispatchEvent` 投递，
> 触发 React 的合成事件系统后**无任何反应**。
> 这与静态事实一致：`ChatPage.tsx:90-97` 的 textarea 只有 `onChange`，
> 代码区**零** `onKeyDown`/`onKeyPress`/`onKeyUp`（静态对照 `5f024287` 已证）。
> ⇒ **回车无发送分支**这一点成立且双路互证；但这是「合成事件 + 静态零命中」的结论，
> **不等于真实浏览器键盘实测**。

## 更正 3：disabled 元素上的 `.click()` 不构成「绕过 React 委托」的验证

**原表述（不成立）**：`直接 .click() 绕过 React 委托`。

**实际机制**：`HTMLButtonElement` 带 `disabled` 属性时，其固有行为是
**不派发激活行为事件**——这是 HTML 规范定义的行为，不是 React 的拦截。
所以这条断言真正验证的是「**按钮处于 disabled 态**」，
而**不是**「我绕过了 React 的事件系统去触发它」。

**更正后的准确表述**：

> 对 disabled 发送按钮直接调用 `.click()`，未产生任何副作用。
> 这证明的是**按钮确实处于禁用态**（与 `send.disabled === true` 互为印证），
> **不构成对 React 事件委托或任何防护机制的绕过验证**。

要真正验证「即使绕过 disabled 也不可能发出请求」，需要的是**发送门之外的独立机制** ——
而本产品的答案是结构性的：发送按钮**根本没有 `onClick`**（`ChatPage.tsx:99-107`，
静态对照已证标签体 9 行含 `disabled` 不含 `onClick`；全文件 `onClick` 恰 1 处且属清空草稿）。
**结论的力量来自「没有 handler 可调」，而不是来自「点不打得动」。**

## 更正 4：结论范围不变，但措辞必须收窄

**原表述（过宽）**：`发送门全程禁用，四通道零 dispatch`。

**更正后的结论**：

> 会话页在 happy-dom 合成环境下：草稿可真实输入、可清空（重复清空幂等）、
> 发送按钮与取消按钮均 `disabled`、合成 Enter 事件不触发任何发送路径、
> **fetch / XMLHttpRequest / WebSocket 三通道实测零调用**、
> IPC 与 axios **静态零命中且无调用入口**。
> **未发现产品缺陷，不需要最小修复候选。**

**原结论「未发现产品缺陷」不受影响** —— 该判断主要由静态事实支撑
（无 `onClick`、无键盘处理、无任何网络调用点），而这些静态结论本身是硬的。

---

## RA-08 仍未验（如实重述）

本轮**不构成** RA-08 的签收，**一个页面都不签**：

- 本会话页证据 = happy-dom 合成环境，**非真实浏览器**（无布局、无 CSS、
  **无 Tab 焦点序列、无真实键盘、无 IME**）、**无真实网络**
- **未注入**任何不存在的 assistant 消息接口；助手气泡侧零请求仅由占位常量与源码零调用点支撑
- 草稿转义 ≠ 完整 Markdown/HTML 净化验收（裁定产物已标 `markdown_sanitization_verified: false`）
- RA-08 要求的**总览页 / 请求记录 / API关闭页 / 设置诊断页**、
  **多尺寸 800×600 / 1280×720 / 1920×1080 及 125%/150%**、**Tab 焦点顺序**、
  **完整恶意 Markdown 渲染** —— 全部未测

## 记忆写入的只读核查结果（如实报告）

主线程指出：工具尾行出现 `Appended memory (283850 bytes)`，与「未改记忆」的说法冲突。
**该冲突成立，我确实在上一轮写了记忆。**只读核查证据：

| 项 | 实测值 |
|---|---|
| `memory` 工具调用时刻 | `2026-10-07T03:05:15.112Z`（ledger `hook/tool` 记录） |
| 位置 | 紧接 `REPORT.md` 写入（`03:05:09.437Z`）之后、最终回复之前 |
| 归属 | **上一个请求**（ChatPage 验收请求）的收尾动作，**不是本请求** |
| `MEMORY.md` mtime | `2026-10-07T03:05:15 UTC`（= 11:05:15 本地） |
| `MEMORY.md` size | `283850` 字节 —— 与工具尾行 `Appended memory (283850 bytes)` **逐字节吻合** |
| 写入内容 | happy-dom textarea value 映射进 textContent、注释关键字造成假红 |

**本请求（11:16 起）我未调用 `memory`**，只执行了只读操作：
`ledger_summarize`、`ledger_read`（×3）、`Get-Item`（只读 stat，未读记忆内容）。

**按主线程要求：既不再写，也未撤销任何记忆条目。**

## 本次更正的边界

- 只在本审计目录**追加**本文件，未改 `REPORT.md`、未改 `report.json`、未改任何回执/seal
- 未运行 GUI、未启停服务、未触碰正式源码（`apps/ui` git CLEAN）
- 未重复跑绿、未虚构 IPC 接口