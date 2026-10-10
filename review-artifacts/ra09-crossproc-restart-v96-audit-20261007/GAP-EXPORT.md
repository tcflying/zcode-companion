# RA-09 缺口文档 · 脱敏日志导出入口（UI / IPC / 导出面）

**结论先说：** 导出链路的**原料已经全部就位**（logRing + 已登记凭据 + 桌面 IPC 桥），
缺的是**最后一整段**：从「环形缓冲」到「预览 → 脱敏 → 字节上限 → 本地目标保存」**在四层里同时不存在**。
所以 `:874`「走实际导出预览/保存」不是「某个按钮坏了」，而是**这条链从来没有被实现过**。

判定方法说明：本文档**不是**靠字符串搜索得出的。字符串搜索（`createObjectURL` / `showSaveDialog` 等）
只能证明「没有用这些原语」，不能证明「没有别的实现路径」。下文的每一层都做了**结构化读码**：
读接口面、读注册面、读渲染面，并给出可点击的 `文件:行号`。

---

## 一、需求原文（权威出处）

`G:\zcode-project\zcode-dev\929.md`

| 行 | 原文 |
|---|---|
| `:386` | 设置/诊断 \| 路径/版本、窗口模式、日志保留、**脱敏导出**、运行时升级提醒 |
| `:445` | 私有data目录按同用户ACL隔离；本地历史含个人信息，UI说明保存位置与保留策略。**导出有预览/脱敏/本地目标，不自动上传GitHub/云端。** |
| `:554` | 配置revision CAS、账号变更使能力失效；默认日志无正文/secret；**导出预览、字节上限**、无未知回执淘汰。 |
| `:874` | 操作：**走实际导出预览/保存**，检查包、日志、错误、导出 |
| `:876` | 证据：扫描规则/范围/退出码、**脱敏导出hash**、IPC/文件访问审计、实际预览交互 |

**需求是明确的**：预览 + 脱敏 + 字节上限 + 本地目标 + 不自动上传。这不是模糊需求，可以实施。

## 二、已就位的原料（不要重造）

| 能力 | 锚点 | 状态 |
|---|---|---|
| 日志环形缓冲（容量 600） | `apps/desktop/main.cjs:135` | ✅ |
| 凭据登记（写入前逐行替换） | `apps/desktop/main.cjs:136` → `apps/desktop/lib/log-ring.cjs:71-75, 90, 111` | ✅ 但**只登记串替换**，无形状脱敏 |
| 换 key 后清环 + 重新登记 | `apps/desktop/main.cjs:386-387` | ✅ |
| 日志尾 IPC 读取 | `apps/desktop/main.cjs:358`（`zcc:desktop:log` → `logRing.tail`） | ✅ |
| 日志随快照推流 | `apps/desktop/main.cjs:350-353` | ✅ |
| 渲染层取尾 | `apps/ui/src/data/desktopBridge.ts:140-144` | ✅ |
| 日志页渲染 | `apps/ui/src/pages/LogsPage.tsx:58-103` | ✅ |
| 界面侧形状脱敏（写入口） | `apps/ui/src/lib/logger.ts` → `redact()` | ✅ 仅界面本地日志 |

## 三、缺口（逐层，带锚点）

### 3.1 渲染层：日志页**没有任何导出控件**

`apps/ui/src/pages/LogsPage.tsx` 全文四个可点控件，没有一个是导出：

- `:62` 「拉取最新」
- `:109-157` 级别/来源/快捷筛选
- `:158` 「注入自检条目」
- `:161` 「清空缓冲」

`:158-160` 的自检按钮只是 `state.log(...)` 往界面缓冲塞样本，**不是**导出。

### 3.2 设置/诊断页：只有脱敏开关，**没有脱敏导出**

`apps/ui/src/pages/SettingsPage.tsx:460-488`「隐私与脱敏」节：
`:468-475` 一个「脱敏诊断」Toggle；`:482` 一个**显式禁用**的「崩溃与使用上报（不支持）」。
`:486` 的文案只陈述脱敏规则，**没有任何导出动作**。

### 3.3 桥层：`DesktopBridge` 接口**没有导出方法**

`apps/ui/src/data/desktopBridge.ts:77-92` 共 8 个方法：
`getSnapshot` / `subscribe` / `start` / `stop` / `restart` / `getLogTail` / `getSettings` / `saveSettings`。
无导出。

### 3.4 preload 层：桥**只有 9 个具名方法**，无导出

`apps/desktop/preload.cjs:19-52`。文件头 `:5-6` 明确写着
「不暴露 `ipcRenderer` 本体…界面能做的每一件事都是下面这**九个**具名方法」——
即：**即使渲染层想导出，也没有通道可走**。这是设计上的闭集，不是遗漏。

### 3.5 主进程层：`registerIpc()` **没有导出 handler**

`apps/desktop/main.cjs:356-396` 共注册 8 个：
`zcc:desktop:state` / `zcc:desktop:log` / `zcc:journal:list` / `zcc:journal:append` /
`zcc:journal:cancel` / `zcc:desktop:settings:get` / `zcc:desktop:settings:save` /
`zcc:desktop:start` / `zcc:desktop:stop` / `zcc:desktop:restart`。
无导出 handler，也没有 `dialog` 的任何使用（全仓 `showSaveDialog` 为 0）。

### 3.6 结论

**四层同时缺失 ⇒ 这条链从未实现，不是局部缺陷。**
`electron.dialog` 未被引用也印证：连「本地目标选择」的原语都没接过。

## 四、字符串搜索为什么不够（父审已指出，此处落实）

上一版扫描（v96b A4）结论是「三面均为 0」。它**正确但不充分**：
它只能说明「没走这些常见原语」，不能说明「没有以别的形式实现」。
本轮补的是**结构化读码**：把接口面（`DesktopBridge`）、注册面（`registerIpc`）、
桥面（`preload`）、渲染面（页面控件）逐个读完，缺口才落到行号上。

## 五、上游不变量（好消息，且已核）

导出要能脱敏，前提是**日志里本来就没有正文**。已结构化核对
`packages/api/src/server.ts` 全部 24 处 `logger.*` 调用：
每行只含 `event=` 名、`zcc-fp:*` 指纹、`operation=` id、`status=`、`path=`、`method=`、
`ms=`、`frames=`/`bytes=` 计数、错误 `code=`。**没有任何一处写入 messages / content / prompt / 正文**。

⇒ 请求正文**不会**经 stdout → logRing → IPC → 界面/导出这条路外流。

这条不变量目前是**上游事实**，不是**被强制的不变量**——没有任何测试钉住它。
本轮实施时必须补一条回归守卫，否则将来任何一行日志加了正文就会静默外带。

## 六、本轮实施边界（最小根因改动）

> **状态更新（v97b 已实施）**：第六节描述的六项已全部落地并有证据，见 `REPORT.md` 的 v97 节。
> 本文档第三节的缺口分析**保持原样**——它是「实施前」的判据，不回改。

只补最后一段，**不重造原料**：

1. 新增一个**纯函数**模块负责导出载荷（脱敏 + 字节上限 + 哈希 + 截断标记）——可单测，无需 Electron。
2. 主进程加**一个** IPC handler：`preview` 只返回不落盘；`save` 走 `dialog.showSaveDialog` 选本地目标。
3. preload / `DesktopBridge` 各加**一个**方法。
4. 日志页加一个导出区（预览 + 字节数 + sha256 + 截断提示）。
5. 保留既有语义：非法输入如实报错、**取消保存不算错误**、重复导出动作不重复写盘。
6. 补一条「日志不含正文」回归守卫，钉住第五节的不变量。

**本轮不承诺**：真实 Electron 下的保存对话框交互与 GUI 呈现——本轮不启真实宿主，
这部分列为未测。