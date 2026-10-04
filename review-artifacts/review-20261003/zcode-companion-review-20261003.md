# ZCode Companion 本轮只读审查终审报告

## 一、结论与计数

审查根：`G:/zcode-project/zcode-companion`。基线及终态 HEAD 均为 `d70ff6eb0c4ea8609fbad9f7d10d5b0e9687f11c`。

| 分类 | 去重后数量 | 口径 |
| --- | ---: | --- |
| 新增已确认缺陷/遗漏 | **42** | 35项中等、7项低；包括运行缺陷、界面读模型错误及交付门覆盖遗漏，不混为同一种产品故障 |
| 新增可优化项 | **3** | 均低优先级，不承诺未经测量的性能收益 |
| 已知问题、本轮已有复核 | **2** | I01协作入口陈旧、既有墙钟断言波动；不计新增 |
| 新增验包失败信号 | **1组** | 便携包与未包装exe对照；失败事实成立，底层根因未确认，单列而不扩充已确认bug数 |

**没有保留原候选的high定级。** 独立复核将其影响校准到有证据支持的本机可用性、响应完整性、配置生效、诊断或验收契约；这不表示可以忽略这些缺陷。

去重合并：三个域的“运行中保存→转发失配→重启仍旧配置”合为F05；两域的畸形路径崩溃合为F01；两域的运行中取消合为F04；两域的缺宿主误报ready合为F21；三个域的I01入口陈旧合为K01。其余条目保留不同触发条件及修正位置，例如预探期配置错位F13不是运行态待配置生效F05，三类日志问题F17/F18/F27也分别发生在拼行、完整记录入口和推送环节。

### 证据归属

- **本终审未执行任何命令、测试或复现，未修改文件。** 只用Read读取要求的入口/协议，以及精确生命周期、验包源码和本轮失败日志、报告，校正汇总口径。
- 下文“运行证据”的命令和输出，均是**本次任务提供的已完成审查及独立复核材料**，不是本终审重新执行的结果。每条引用独立复核的有效证据，不以发现者摘要或历史I10全绿替代。
- 源码证明、合成/依赖注入复现、真实自建Node进程/HTTP检查、协调者制品检查、人工GUI验收分别表述。`VM执行原文`、`executeJavaScript`或静态React渲染**不等于人工点击验收**。
- 已确认均为**未修复**。用户本轮没有授权实现、改测试/配置/台账、提交、推送或部署。

以下相对源码路径均以审查根为基准。

## 二、本轮门结果、源码与制品身份

### 2.1 本轮CI：通过，但不是缺陷清零证明

证据来源：任务提供的协调者完整输出；执行命令为产品根下的 `npm run ci`，**exit=0**。

执行链：

`typecheck → typecheck:checkjs → typecheck:apps → test:ui → test`

- 三段类型检查均退出0。
- UI：**4个文件、122个用例通过**。
- 根unit/contract聚合：**25个文件、884个用例通过**。
- 合计：**29个不同测试文件、1006个用例**。合同用例内部重复执行unit套件，不额外加进这个计数。
- 本轮stderr包含 `npm warn Unknown user config "electron_mirror"` 和 `npm warn Unknown env config "electron-mirror"`。这是本次警告，不是CI失败；未读取或修改全局npm配置。

CI通过证明的是现有接线和断言在本轮通过；新交错、失败分支、协议分块及门覆盖缺口仍可由专项反例成立。F33也说明桌面main/preload并未被这三段类型工程覆盖。

### 2.2 源码身份及未触碰声明

任务提供的开工、终态 `git rev-parse HEAD` 都是上述HEAD；`git status --porcelain`始终仅：

```text
 M AGENTS.md
?? AGENTS.md.bak-mainrule-20260303
```

最终身份复核：173个受控文件中，只有开工前已有的AGENTS.md六行主会话职责变化；其余172个与index blob相同。`git diff --check`成功，只有AGENTS.md的LF将被Git转换为CRLF的提示。现存AGENTS修改及备份未触碰。

各专项和独立复核材料另有目标源码blob/SHA一致性记录、临时资源finally清理记录。本终审没有将临时夹具的失败误记为产品测试失败或成功。

### 2.3 现存制品身份及比对限制

制品：`release/desktop/ZCodeCompanion-0.1.0-win-x64-portable.exe`

- 大小：**100264045 B**。
- SHA256：**`f19863014c186d2d7464c218f9c543d149cab0f32a132d81da893d0922632443`**。
- 协调者比对旁置`win-unpacked/app.asar`的10个桌面实现文件与树一致，`resources/runtime`的23个可比源码也一致；package.json因构建改写未作逐字判据。
- 退出失败的独立复核另外比对其中9个CJS文件，得到`allIdentical=true`，并独立取得相同便携包大小与SHA。

**限制：**这些证据不能自动证明便携exe内层payload与旁置win-unpacked完全绑定，也未独立证明UI dist与当前HEAD、全部依赖或Electron内嵌Node逐项一致。本轮未重新打包、未进行干净克隆安装；不能将开发机Node专项等同于发布exe行为。

## 三、必须单列的新验包失败：事实确认，根因未确认

### U01：业务自检成功与退出验收失败同时存在

**本次便携包验包exit=1，不以旧成功抵消。**

协调者在绝对产品cwd中用`process.execPath`直接运行`stage-gate verify:package`，`ZCC_VERIFY_PORT=3323`。原始日志：

`C:/Users/someone/.zcode/cli/exec/sess_4870b5b5-e455-4785-a199-9649fb36f873/call_PaSD3cX04mO9YoxTSmAgvVyK-stdout.log:1-4`

通过制品体积及两项asar-contains后，失败文本为：

```text
verify:package FAIL: 产物在 180000ms 内没有自行退出（输出：）
```

同次报告：`C:/Users/someone/AppData/Local/Temp/zcc-verify-out-NL3hCA/verify.json:1-19`，实际是：

- `ok=true`；
- `spawn-runtime=STARTED/running/pid29920/port3323`；
- `app-forward-models=200/apiKeyLeaked=false`；
- **没有dispose字段**。

同构建未包装`win-unpacked/ZCodeCompanion.exe`对照由协调者直接spawn `--zcc-verify`，端口48288：150016ms时`exited=false/closed=false`，stdout却已打印`[verify] OK dispose={"ok":true,"code":"STOPPED"}`；报告仍`ok=true`，API子进程20472、自检GUI23560。其后只对持有的child句柄发送SIGKILL并销毁自有管道。日志后来追加的回执是`code=null, signal=SIGKILL, elapsedMs=556034`，**不是正常自行退出0**。

对照日志：

`C:/Users/someone/.zcode/cli/exec/sess_4870b5b5-e455-4785-a199-9649fb36f873/call_OXjPnfSK0C2uVdOqKj0SyIV6-stdout.log:1-2`。

最终精确核对23560、20472、29920均不存在，隔离端口无监听，8790仍由原PID52656监听且未操作。最初tasklist残影不能作为继续杀进程的依据，也不支持“收尾仍有活孤儿”。

首次误用npm exec导致node@22.23.3临时包解析，且未设隔离端口，8899已有HTTP200而被拒绝exit1；这是**预期拒绝及操作失误，不是产品bug**。

### 可确认的判据限制，不等于真实根因

1. `scripts/verify-package.mjs:62-100`的`runExe`只等待`close/error`；180s计时器在`:81-89`设置timedOut并发SIGKILL，**没有超时后独立终结期限**。因此“close未在期限内完成”不能直接等同“OS进程未退出”。Node的exit与close不是同一事件。
2. `apps/desktop/main.cjs:450-458`是先写报告、后dispose、最后app.exit。磁盘`ok=true`不含收束结果，也不证明OS退出；缺dispose字段不等于本次没有调用dispose。该报告缺口已计入F10，不重复计数。
3. `apps/desktop/lib/proxy-manager.cjs:375-400`即使强杀后始终没有exit，也会清空句柄、返回`STOPPED`。这个管理器回执不是独立的OS退出证明。
4. 未包装exe对照也没有及时收到exit/close，所以“仅portable包装器”或“仅stdio拖延close”不能充分解释全部新信号；Electron迟退、事件通知、句柄或其它路径仍待证。

独立复核在任务中给出的结论为`unconfirmed`。其受控事件fixture证明原始runExe可在先收到exit(0)后仍等待close并进入timedOut；另外真实Node共享stdio实验出现断言失败，**没有成功复现Windows共享句柄根因**。不据此宣布GUI损坏、环境故障或活孤儿。

**处理建议仅限方向：**记录带单调时间戳的spawn、stdout/stderr end/close/error、child exit/close/error、信号发送及返回值，分离“业务报告写出、dispose回执、已请求app.exit、OS结束、管道关闭”。未来若授权修门，超时后应真正有界结束等待并保留未知终态；不能只加长超时、把close替换为exit便宣告通过。本轮未再启动产品诊断。

## 四、新增已确认：优先闭环的完整性、生命周期及验收缺陷

本节F01—F12均为**中等严重性、较高处理优先级**，不是high安全评级。

### F01 非法路径解码可在认证前终止API

- **触发/影响：**API显式开启且监听回环端口后，本机连接者发`/%`或`/%ZZ`；解码先于Host/Origin/Bearer门及请求try，未持key也能触发URIError，API进程退出。只有查询串含`%`不触发；没有证据支持公网可达或桌面主进程必崩。
- **源码：**`packages/api/src/server.ts:829-843,896-904`；已有`clientError`不包住listener同步异常。`apps/desktop/lib/app-protocol.cjs:131-151`的解码防护仍有效，直连HTTP绕开的是另一入口。
- **运行证据〔任务提供・独立复核〕：**`rtk proxy node C:/Users/someone/AppData/Local/Temp/zcc-uri-independent-review-20261003-69b71.mjs`。自建driver=none API、单次请求，得到`ECONNRESET`、`exit.code=1`，栈指`server.ts:841`；正常无认证401、Host/Origin拒绝403及查询串对照成立。
- **最小建议：**将解码置于请求错误边界，URIError明确映射400；不要用全局吞异常兜底。回归应断言非法请求后进程仍能处理正常请求。

### F02 重放预算可淘汰仍执行的幂等登记

- **触发/影响：**最早的合法显式幂等请求仍执行，其它成功响应触及32MiB重放预算后，淘汰会删除该in_flight登记；在限流余量内再提交同键同体会进入第二次驱动而不是409。潜在重复额度消耗未做真实模型实测。
- **源码：**`packages/api/src/server.ts:546-559,587-606,797-815`，淘汰不检查state；`current===entry`只保护提交，不保护在途登记。
- **运行证据：**`rtk proxy node C:/Users/someone/AppData/Local/Temp/zcc-independent-inflight-budget-20261003-6ac70.mjs`。默认预算与限流、最多两路并发；八条4000000字符响应后同键仍409，九条后`entries=8/replayBytes=32004896`，重复进入驱动，`blockedCalls=2`，两次200/original且`sameOperation=false`。
- **最小建议：**只淘汰已结算且可释放的重放条目，保留在途登记至结算；注意当前commitReplay先于state=done，不能只加state过滤而忽略顺序。补预算压力下在途同键仍409的回归。

### F03 官方stdout跨块拼行缺失，可成功终态却缺正文

- **触发/影响：**official-host内层已有一条delta，后续NDJSON正文跨data块，成功终态仍完整到达；残片被分别解析丢弃，全文兜底因已有delta跳过，finish成功但正文缺段。零delta时全文兜底仍可恢复，不能描述为所有分块都丢文本。
- **源码：**`scripts/official-host/session-drive.mjs:974-995,1150-1152,1608-1617`；外层`host-driver.ts:1132-1145`的正确缓冲不修复内层。
- **运行证据：**`rtk proxy node C:/Users/someone/AppData/Local/Temp/zcc-independent-ndjson-bcd3-review.mjs`。合成管道输入同样字节：完整ASCII`alpha beta`，分割JSON后`alpha `，均finish=true；UTF-8完整`前缀:中文`，字内切块后`前缀:`；零delta全文对照恢复`beta`。没有官方进程。
- **最小建议：**内层stdout用setEncoding或StringDecoder，连续缓冲至换行再消费、保留尾残片。回归逐字比较整块/分块/多行尾残片/UTF-8切块结果。

### F04 请求启动后的取消未贯穿两层宿主

- **触发/影响：**入口预取消有效，但会话启动后abort/iterator.return不停止runHostSession。无后续事件的SSE断连仍占并发槽；若后来有事件，SSE可以释放槽，但子会话仍运行。非流式断连也可持续占槽至终态/失败/超时，不能统称所有断流都占到终态。
- **源码：**`packages/api/src/server.ts:593-606,744-760`；`packages/official-host/src/host-driver.ts:991-995,1309-1312,1355-1438`；`scripts/official-host/host-child.mjs:458,495-498`只在会话结束后回收内层。
- **运行证据：**`rtk proxy node C:/Users/someone/AppData/Local/Temp/zcc-cancel-independent-dw13-20261003.mjs`：预取消spawn=0；首delta后return仍`childRunning=true/stdinEnded=false`；abort且无新事件120ms后next未结算，HTTP只读请求429；追加事件后GET恢复200但子进程仍活。另一独立命令`rtk proxy node C:/Users/someone/AppData/Local/Temp/zcc-host-cancel-recheck-20261003.mjs`覆盖JSON断连，终态前429、终态后200。均为自有合成Node子宿主。
- **最小建议：**signal进入会话，abort唤醒事件等待，生成器finally/return共用幂等、有界收束，并到达两层自有句柄；不自动重发未知请求。真实模型继续扣额只是风险，未实测。

### F05 运行中保存后转发先错位，“重启”仍旧规格

- **触发/影响：**自有反代running时保存端口/key/driver/reasoning；configure只记configuredPort，旧spawnSpec被保留。转发立即读新settings，改端口可502、改key可401；重启stop→start仍旧规格。仅driver/reasoning变化不必然造成寻址/认证失败，但不生效。
- **源码：**`apps/desktop/main.cjs:172-178,230-237,312-326`；`apps/desktop/lib/proxy-manager.cjs:421-427,457-465`；`apps/ui/src/pages/SettingsPage.tsx:55-66`提示点重启。前次运行端口快照修复仍有效。
- **运行证据：**`node C:/Users/someone/AppData/Local/Temp/zcc-restart-independent-d70ff6-20261003-72c4.cjs`。VM完整原文+真实lib、模拟IO；五种running保存均落盘成功且restart=STARTED，实际规格仍`8806/official-host/low/旧key`；端口/key转发分别502/401。停机保存及新main对照正确使用新规格。不是实际Electron网络检查。
- **最小建议：**分开已保存与当前生效配置，转发继续使用活动实例端口/key；旧实例停妥后成对applySettings再start。key不加入公开快照。

### F06 在途启动不被停止/销毁取消，重复dispose提前放行退出

- **触发/影响：**首次probe挂起时stop/dispose可回ALREADY_STOPPED/NOT_OWNED，释放probe后仍spawn；dispose已经置位，之后无法再实际收束。另首次dispose未结束时第二次立即DISPOSED，before-quit可提前放行。未证明Windows最终持续孤儿。
- **源码：**`apps/desktop/lib/proxy-manager.cjs:295-333,407-440`；`apps/desktop/main.cjs:566-578`。start→start同步闸仍有效，UI启动busy时停止按钮也已禁用；退出不受该按钮限制。
- **运行证据：**`node C:/Users/someone/AppData/Local/Temp/zcc-independent-lifecycle-d70ff6-20261003-2b731e.cjs`。独立原文fixture：预探dispose后仍STARTED、spawn=1/signals=[]；并发dispose的second已结算而first未结算；main重复quit在child未exit时allowedQuits=1。正常并发start对照第二次BUSY、仅spawn一次。
- **最小建议：**停止/销毁同步使本次启动失效；await后重查代次/disposed。dispose复用同一收束Promise，main只在其完成后放行。

### F07 晚到probe成功覆盖已退出状态，形成running空句柄

- **触发/影响：**spawn后probe挂起，其间child退出/stop完成，随后probe=true；failed/stopped被覆盖running，pid=null/owned=false、错误清空，start/stop/restart均BUSY。
- **源码：**`apps/desktop/lib/proxy-manager.cjs:264-283,338-342`，身份检查只在await前。验包纯函数仍拒绝null PID，不能扩大为验包必假通过。
- **运行证据：**`node C:/Users/someone/AppData/Local/Temp/zcc-lateprobe-verify-QTcxiZ/verify.cjs`，真实自有Node child及受控probe：退出后晚true返回STARTED，坏快照及三种BUSY均复现；晚false保留CHILD_EXITED，存活true正常。
- **最小建议：**每次probe返回后采纳true前复核child身份、取消/销毁状态，不覆盖已落定失败原因。保留同步启动闸。

### F08 设置写盘失败后内存半生效，UI一直保存中

- **触发/影响：**校验通过后mkdir/write/rename异常；内存settings/key先替换、日志先清空，磁盘和manager仍旧，转发可能先用新值。IPC拒绝未catch/finally，当前设置页持续挂载时按钮一直禁用；离页重挂可重置UI，不是永久不可恢复。
- **源码：**`apps/desktop/main.cjs:312-322`；`apps/desktop/lib/settings.cjs:310-314`；`apps/ui/src/pages/SettingsPage.tsx:52-69,103-106`。
- **运行证据：**`node C:/Users/someone/AppData/Local/Temp/zcc-setting-recheck-d70ff6-20261003-9bf143c2.cjs`。真实TEMP写入用目录占用settings.json.tmp产生EISDIR：diskUnchanged=true、memoryPort=9981、managerPort=8790、logs=0、saving=true、label=保存中、feedback=null；校验拒绝/成功写盘对照正常。
- **最小建议：**局部候选成功持久化后才提交内存/日志/manager；主进程收敛文件错误为ok:false，页面catch展示、finally复位。

### F09 损坏设置的解析错误可把本机key送到渲染端

- **触发/影响：**settings.json语法错误位于会被解析器引用的apiKey附近；JSON.parse.message进入loadProblems、经IPC与设置页展示。开发机Node可完整回显短合成key、长值前缀；不是所有坏JSON泄漏，也不是provider凭据或远程窃密已证实。
- **源码：**`apps/desktop/lib/settings.cjs:272-276`→`apps/desktop/main.cjs:304-310`→`apps/ui/src/app/useDesktopState.ts:79-82`→`apps/ui/src/pages/SettingsPage.tsx:211-214`。publicSettings/日志脱敏不保护此字符串出口。
- **运行证据：**`node C:/Users/someone/AppData/Local/Temp/zcc-settings-ipc-review-6bc89e43.cjs`。合成设置+原始IPC函数/包装：8字符无引号值`stubbedIpcUiBundleContainsFullKey=true`；36字符值只泄前缀；正常JSON及尾逗号对照未泄。未测真实Electron跨进程或截图。
- **最小建议：**catch返回稳定错误码和固定说明，不透传解析器原文/输入片段；若定位，只输出约束后的数字行列。

### F10 验包报告先写后收束，失败不改变通过结论

- **触发/影响：**自检业务步骤通过后dispose拒绝或ok:false；磁盘报告没有dispose、仍ok=true，退出码仍0，读取端不要求收束成功。正常路径确实await dispose，不能重报“根本没有调用清理”。
- **源码：**`apps/desktop/main.cjs:450-458`；`scripts/verify-package.mjs:219-234`；历史承诺见`review-artifacts/i10/evidence.md:185-188`。
- **运行证据：**`rtk proxy node --experimental-vm-modules C:/Users/someone/AppData/Local/Temp/zcc-independent-dispose-report-d70ff6-20261003.cjs`。正常、拒绝、ok:false均`persistedOk=true/persistedHasDispose=false/exit=0`，门均通过；含明确失败dispose的报告也被接受。external/502对照仍失败。U01真实报告缺字段与此一致，但不证明那次真实dispose失败。
- **最小建议：**先有界取得收束结果再统一落盘；失败令总体ok=false、非零退出，读取端也要求该字段通过。

### F11 P4相关错误/错误能力值仍被判验收成功

- **触发/影响：**两项ack已给、请求ID匹配且控制帧计数合规；能力false、相关error_response或额外顶层键仍outcome=ok/exit0，违反CLI自己的精确回读计划。不是旧“不相关错误满足waiter”问题复发。
- **源码：**`scripts/verify-runtime.mjs:283-301,447-523,579-592`；`packages/runtime/src/capability-probe.ts:2678-2700`的传输ok合理，但不能等于语义验收ok。
- **运行证据：**`rtk proxy node C:/Users/someone/AppData/Local/Temp/zcc-independent-p4-d70ff6-20261003-actor32.cjs`，调用真实CLI probe与两ack、临时stdio fixture：false/相关错误/额外jsonrpc均exit0；正确对照exit0；只有不相关错误exit1/TIMEOUT，不相关错误后正确响应仍通过，modelDispatch=0。
- **最小建议：**CLI边界要求仅id/result且result精确为independentPlanState:true；错误能力/协议错误/形状不符必须非零，保留传输取证与相关性保护。

### F12 验包“渲染成功”未要求真实UI挂载和桌面桥就绪

- **触发/影响：**index.html仍在、文档完成导航、注入fetch及自有API转发正常；入口JS缺失或preload桥不可用仍可能通过。不是缺HTML/非自有进程也能通过，不能断言现存exe已经空白。
- **源码：**`apps/desktop/main.cjs:473-488,535-538`只注入fetch；`scripts/verify-package.mjs:221-234`未要求ui-ready，甚至未独立要求app-forward步骤。
- **运行证据：**`rtk proxy node --experimental-vm-modules C:/Users/someone/AppData/Local/Temp/zcc-independent-ui-ready-d70ff6-20261003.cjs`。原文逻辑+模拟Electron、自有NodeHTTP fixture：module404、uiMounted=false、bridge=false，报告ok=true/exit0，原始读取门打印PASS；缺HTML/external对照失败。不是实际Electron导航。
- **最小建议：**真实UI挂载且桥调用成功后提供最小就绪信号；主进程限时验证并记录ui-ready，门要求ui-ready与app-forward两步骤均存在且通过。

## 五、新增已确认：其余中等严重性运行/状态/覆盖缺口

### F13 预探期间保存使spawn新端口、probe旧端口

首次probe未返回、state仍stopped/external时configure可替换port/spawnSpec；start捕获旧targetPort却在await后读取新spawnSpec。仅新端口就绪会误超时，旧端口后来可达会误报成功。

源码：`apps/desktop/lib/proxy-manager.cjs:303-323,339,457-465`；保存入口`apps/desktop/main.cjs:312-324`。运行证据：`rtk proxy node C:/Users/someone/AppData/Local/Temp/zcc-preprobe-independent-d70ff6-20261003-4.cjs`，probePorts=[28061,28061]、spawnedPorts=[28062]；新端口模拟就绪→START_TIMEOUT，旧端口模拟就绪→STARTED。starting后configure拒绝、重复start BUSY对照仍正常。

**建议：**configure同时检查startInFlight，活动配置在第一次await前成对固定，预探保存只记录待生效配置。端口就绪是受控模拟，不是真实网络探通。

### F14 异步spawn error未进入管理器失败路径

可执行文件/cwd失效时Node异步emit error，当前只catch同步throw、只订阅exit。纯Node无全局处理器会退出；锁定Electron有默认uncaughtException处理，**不能保留“桌面必崩”断言**，其管理器仍可超时并丢失ENOENT原因。

源码：`apps/desktop/lib/proxy-manager.cjs:319-333`；`apps/desktop/main.cjs:180-194`。运行证据：`node C:/Users/someone/AppData/Local/Temp/zcc-independent-spawn-global-observation-d70ff6-20261003-r5k3.cjs`，有效exe/无效cwd得到uncaughtException ENOENT、errorListeners=0、state=starting，随后START_TIMEOUT而非SPAWN_FAILED。官方Electron44.4.5 `lib/browser/init.ts:17-33`明确Don't quit on fatal error。

**建议：**自有ChildProcess立即监听error，与exit/停止共用一次性完成保护，及时保存真实原因并结算等待；有效exe+缺cwd回归保留同步throw对照。

### F15 Windows停止链未使用API优雅关闭入口

桌面stop/restart停止阶段/dispose首先kill(SIGINT)，Windows是强制终止，不执行API JS SIGINT回调，server.stop的在途宽限收束不可达。进程确实可被停掉，未证明真实请求/孙进程残留。平台事实已见仓内测试，本轮新增是桌面集成未处理它。

源码：`apps/desktop/lib/proxy-manager.cjs:380-392`；`apps/desktop/main.cjs:182-188`的stdio无IPC；`packages/api/bin/start-api.mjs:586-598`；`packages/api/src/server.ts:948-968`。运行证据：`node C:/Users/someone/AppData/Local/Temp/zcc-independent-win-stop-d70ff6-20261003-a6.cjs`，真实WindowsNode stop/dispose均STOPPED、handlerRan=false、6/7ms退出；显式JS事件阳性对照handlerRan=true。

**建议：**自有父子IPC/管道发协作关闭命令进入现有server.stop，超期才持句柄强杀；不要简单改成SIGTERM或按名/端口清理。

### F16 启动超时预算不能终结未完成的probe

首次预探不在deadline内，轮询也先await再查deadline；main net.fetch无请求取消上限。悬挂probe使start/busy等待超过配置预算，迟到true还能STARTED。没有查到面向使用者“30秒必结束”的文档承诺，不应这样引用。

源码：`apps/desktop/main.cjs:132-139,181-194`；`apps/desktop/lib/proxy-manager.cjs:301-304,335-357`。运行证据：`node C:/Users/someone/AppData/Local/Temp/zcc-independent-probe-deadline-7-d70ff6-20261003.cjs`，20ms预算下预探113ms仍pending、未spawn；轮询108ms仍pending，释放false后才超时，106ms迟true直接成功。即时probe对照超时有效。

**建议：**预探和轮询共用启动deadline，底层探测在剩余预算耗尽时实际取消并清理；只有Promise.race而不取消底层不够。Electron网络栈时限未实测。

### F17 日志残片已消费却未删除，污染后续日志

同一流先半行、后补齐且rest为空，旧partial仍在；下个chunk首行再带旧前缀，flush多加残片。完整行块不触发，不是每种分块都立刻污染所有行。

源码：`apps/desktop/lib/log-ring.cjs:84-91,101-108`；真实接线`apps/desktop/lib/proxy-manager.cjs:237-245,264-267`。运行证据：`rtk proxy node C:/Users/someone/AppData/Local/Temp/zcc-log-ring-verify-independent-8-d70ff6-20261003.cjs`，语义断言exit1：输入connect半行→ready换行→done换行，实际[connect ready,connect done,connect ]；整块对照正确，manager Buffer/exit链同样污染。

**建议：**每次append完整更新partial，rest空则delete；覆盖stdout/stderr后续行与flush。此exit1是已复现日志违约，不是CI失败。

### F18 主进程完整诊断无换行，读取和推送都看不到

logMain把完整记录当半行交给append，无key首启等记录留在partial；无自有child的dispose不flush。日后flush多条拼成一条，保存clear又可丢弃。设置页已有缺key提示和请求方错误响应，不是所有错误信息消失。

源码：`apps/desktop/main.cjs:122-124,294-303,401-405`；`apps/desktop/lib/log-ring.cjs:82-95,118-121`。运行证据：`rtk proxy node C:/Users/someone/AppData/Local/Temp/zcc-review-main-diag-9-d70ff6-20261003.cjs`，可见性断言exit1：no-key-start、push、主动读取均空；人工flush才得到两条拼接；补换行对照可见。

**建议：**完整记录入口补行结束符，继续现有脱敏；不要每次全局flush以免提前落stdout半行。推送接线见F27。

### F19 SSE写入false后仍继续消费，未遵守背压

认证且连接仍存活，但慢写端返回false，API继续消费/写后续帧。4MiB预算和断连保护有效，所以是有界额外缓冲，不是无限内存增长。

源码：`packages/api/src/server.ts:734-760,782-789`。运行证据：`rtk proxy node C:/Users/someone/AppData/Local/Temp/zcc-sse-independent-verify-20261003-4.mjs`，真实Writable高水位65536、暂停callback：第3写false后仍20个delta/23写、drain=0、实际队列669258 B、response.end已调用；正常写端/断连/4MiB控制成立。不是实际网络慢客户端测试。

**建议：**false后等待drain或close/error/abort，再取下一事件；首帧至[DONE]统一处理。false表示已接受当前帧，不得重写。

### F20 自由路径进入独立CLI日志，绕过响应脱敏

客户端先把本机key误放URL路径，未知路径无需Authorization便将解码值写stderr rejected及stdout request；响应过滤有效，桌面后置日志脱敏不能保护独立CLI。没有从服务端获取未知key的能力。

源码：`packages/api/src/server.ts:841,872,876`；`packages/api/bin/start-api.mjs:538-540,609-612`；文档承诺`docs/USAGE.md:612`。

运行证据：`rtk proxy node C:/Users/someone/AppData/Local/Temp/zcc-pathlog-review-5-20261003-c14d.mjs`，真实自有CLI、原文/百分号编码未知路径均404、响应不含key，stdout/stderr含完整随机合成key；认证头/查询串对照不泄。

**建议：**未知路径记固定unknown，已知路由记闭集标识；若必须保留路径，先按配置值及凭据形态脱敏，再处理控制字符/长度。

### F21 必需bundle缺失时仍宣称official-host ready

builtin仍含至少一个可服务模型，但实际bundle已缺失，load仅据模型数标ready，启动横幅model_is_real=true，模型列表非空；请求层BUNDLE_NOT_FOUND仍能阻止spawn。新机连builtin也缺失时不是这个反例，桌面running只表示HTTP存活也不是另一bug。

源码：`packages/official-host/src/host-driver.ts:1036-1038,1470-1496`；`packages/api/src/chat.ts:764`；`packages/api/bin/start-api.mjs:573`。运行证据：`rtk proxy node C:/Users/someone/AppData/Local/Temp/zcc-readonly-host-boundary-7-second-e36c0.mjs`，bundle=false/status=ready/models=1/spawn=0；/models200 ready，资格合成可用时首chat502/BUNDLE_NOT_FOUND，错误头仍ready；空目录对照not_attached。

**建议：**装配时至少检查实际bundle，缺失拒绝启动或not_attached且不列可服务模型；协议探测若没有实施，删除“已describe验证”注释。无需改变portable不携官方依赖边界。

### F22 合法Bearer方案大小写被误拒

正确key、网络门通过时，bearer/BEARER/混合方案401，规范Bearer200；key仍精确比较，非认证绕过。

源码：`packages/api/src/auth.ts:66-70`；`packages/api/src/server.ts:389-398`。运行证据：`rtk proxy node C:/Users/someone/AppData/Local/Temp/zcc-bearer-recheck-8-975d7ca1.mjs`，生产纯函数及两个GET路由均复现大小写误拒，driverCalls=0；RFC9110 §11.1认证scheme大小写不敏感。

**建议：**只让scheme比较大小写不敏感，key原字节比对不变；保留错误key/Basic阴性对照。

### F23 chunked已超1MiB仍等EOF，持有业务槽

有效认证、无Content-Length，读到超限后只清缓存继续等待；请求不end时尚无413、槽未释放。内容未继续缓冲、未调用驱动；默认Node整请求300s超时限制它，不是永久或无认证公网阻断。

源码：`packages/api/src/server.ts:503-530,1040-1075`；`packages/api/src/auth.ts:180-202`。运行证据：`rtk proxy node C:/Users/someone/AppData/Local/Temp/zcc-review-chunked-9-d70ff6e-20261003.mjs`，单槽内存流1048577 B，100ms未end无响应/inFlight=1、只读请求429；end后413、槽0、GET200；声明超限立即413且槽0。默认四槽耗尽仅源码推导，未做耗尽实验。

**建议：**首次超限结束业务等待并返回413/释放槽，连接收尾独立有界排空或flush后关闭，不等任意EOF。

### F24 普通主导航静默丢弃录入成果及页面草稿

条件路由卸载页面，手工录入模型、聊天草稿、已读目录、筛选和未保存设置局部状态重置；不需要整页刷新。App级配置、已保存磁盘设置不丢，当前聊天禁发，不是持久化会话记录损坏。

源码：`apps/ui/src/app/App.tsx:75-79`；`apps/ui/src/pages/ModelsPage.tsx:160-168,239-248,751`；`apps/ui/src/pages/ChatPage.tsx:35,90-96`。

运行证据：`node C:/Users/someone/AppData/Local/Temp/zcc-route-independent-20261003-d70ff6.cjs`，真实React reconciliation+合成DOM：manual1→0、draft43→0、catalog2→0、未保存端口9901→8790，reload/confirm=0；页内模式切换与App共享配置保留。

**建议：**需保留的非敏感会话状态提升App层；设置草稿可离页提示丢弃，不为保草稿持久化新key或引入存储系统。

### F25 旧读取回包可覆盖新推送，UI状态倒退

读取取得旧值但交付晚于changed，hook直接落旧状态/日志；main没倒退，renderer却从running变starting、日志被清空，按钮错误禁用至下一有效更新。

源码：`apps/ui/src/app/useDesktopState.ts:48-58,72-88`；`apps/desktop/main.cjs:293-303`。运行证据：`node C:/Users/someone/AppData/Local/Temp/zcc-review-stale-ipc-independent-20261003-4e18.cjs`，原始同步读取handler、只延迟交付：初读和刷新两场景running/at30/1行→starting/at20/0行；正常顺序不倒退。真实Electron发生频率未测。

**建议：**快照/日志各用更新代次和读取序号拒绝过期结果，卸载令在途结果失效；不能仅靠状态lastChangedAt防日志覆盖。

### F26 读取失败混为缺桥，并可用默认草稿覆盖未知配置

桥在场但settings:get拒绝/尚未返回，settings=null被写成“桌面壳未接入”，保存仍可用。首次未加载设置、有现存key、保存可用时默认8790/official-host/low可覆盖旧三字段；key保护仍有效。日志刷新失败只删React旧列表，不删主进程日志。

源码：`apps/ui/src/app/useDesktopState.ts:39-41,54-87`；`apps/ui/src/pages/SettingsPage.tsx:34-59,103-112`。

运行证据：`node C:/Users/someone/AppData/Local/Temp/zcc-independent-gui-read-failure-d70ff6-20261003-r2.cjs`，在场桥初读失败保持stopped/空/无错；settings-only失败仍saveDisabled=false，实际合成保存把12345/none/max改成默认，keyPreserved=true；显式snapshot刷新已有错误提示，不能概括所有错误静默。

**建议：**保存按钮和函数要求成功加载；区分缺桥/读取中/失败，失败保留最后有效数据并标陈旧。先阻断默认覆盖，不需新抽象。

### F27 running稳态的新子进程日志没有推送

完整stdout/stderr已入ring，但data handler不通知，UI应用层hook不因切到日志页重挂；手动拉取/后续状态变化可以补回仍在环内日志，与每行实时出现承诺矛盾。

源码：`apps/desktop/lib/proxy-manager.cjs:237-245`；`apps/desktop/main.cjs:194,293-303`；`apps/ui/src/pages/LogsPage.tsx:60,73`。

运行证据：`node C:/Users/someone/AppData/Local/Temp/zcc-live-log-verify-d70ff6-7-20261003.cjs`，running两完整行后ringRows=2，pushes仍3、subscriberRows=0；手读2行、exit通知后订阅2行。无真实Electron。

**建议：**日志完整记录追加后独立轻量通知，复用已脱敏tail、可合并推送，不为日志改进程状态/时间戳。

### F28 目录HTTP头返回后撤销超时，正文等待无应用上限

显式联网、无fixture覆盖，2xx头及时返回但正文不结束；fetch finally清掉唯一计时器，res.text不受5000ms预算，loading/busy持续。正常本产品目录一次end，不是正常API必现。

源码：`apps/ui/src/data/localApiSource.ts:219-271`；`apps/ui/src/data/modelSource.ts:829-853`；`apps/ui/src/pages/ModelsPage.tsx:206-224,467`。

运行证据：`node --experimental-vm-modules C:/Users/someone/AppData/Local/Temp/zcc-catalog-independent-d70ff6-20261003-recheck8-4f82.cjs`，原生fetch自有HTTP：31ms得头，5295ms后仍pending、aborted=false、productTimers=0，人工结束才ok；头部超时对照timeout并保留旧列表。

**建议：**同一定时器覆盖fetch及完整正文，外层finally清理；正文超时映射timeout。仅busy finally不解决等待不结算。

### F29 文件来源选择没有被HTTP执行器尊重

动态模式、API开关开、无sourceFixture、合法同源/回环URL，选择local_config_file仍GET目录并可成功替换旧列表；文案明确该通道未接线。已有网络提示，不能写成完全隐蔽外联；发送门未变。

源码：`apps/ui/src/data/localApiSource.ts:203,310-314`；`apps/ui/src/data/modelSource.ts:796,817-837`；`apps/ui/src/pages/ModelsPage.tsx:176-184,446-468`。

运行证据：`node C:/Users/someone/AppData/Local/Temp/zcc-file-transport-review-20261003-b3e4176a.cjs`，fetch替身记录文件选择下GET /v1/zcc/catalog、status=ok/旧表被替；关API文件通道failed/transport_not_wired/零请求，fixture优先仍零请求。

**建议：**HTTP loader请求前检查transport，文件选择走现有offline拒绝并保旧表；无需本轮实现文件读取。

### F30 动态目录摘要与真实列表/revision互相矛盾

非空刷新成功后底部仍0条，目录标题固定未接入；同挂载连续刷新差异始终空表作前表，把当前全报新增、消失/保持报0，完成提示反复首次。表格及另一事实区revision/成功时间正确，不是整个页没读到数据。

源码：`apps/ui/src/pages/ModelsPage.tsx:234-236,270-276,596,760-783`；`apps/ui/src/data/modelSource.ts:586-604,656-665`。

运行证据：`node C:/Users/someone/AppData/Local/Temp/zcc-model-summary-recheck-20261003-62b7a9.cjs`，真实组件/loader逻辑+hook/fetch替身：2条成功仍空态；相同2条再读报新增2；2→1报新增1/消失0/保持0，而正确差异0/1/1。空源失败保旧表对照成立。

**建议：**刷新前后真实entries算一次delta供提示/日志/摘要共用；ok非空显示成功，目录revision/时间取动态字段，未接epoch仍未知。

### F31 历史缺额度被写成实时、跨来源统一读数

未读权威桶或资格时，固定“普通套餐与Start Plan当前都无额度”，三栏连本软件token统计也“无可用额度”。2026-09-29原始指令确有双订阅缺额度来源，**不能说完全无历史依据**；但不能支持全部账号/时点/读数。

源码：`apps/ui/src/data/snapshot.ts:20-28,42-50,179-185`；`apps/ui/src/pages/ModelsPage.tsx:555-586,687-699`。

运行证据：`node C:/Users/someone/AppData/Local/Temp/zcc-quota-recheck-d70ff6-20261003-11.cjs`，静态React真实渲染，开关false/true均三栏无额度；E0及发送禁用仍在，fetchCalls=0。没有实际余额读取。

**建议：**未接读数写未读取/未确认，token统计按自身语义；历史额度限制带日期/来源/范围。保持禁发，不推断现在有余额。

### F32 独立pack门只认index存在，可纳入陈旧/残缺dist

忘按文档重build，或build后JS删除但index仍在，前提满足即可进builder并复制现存dist。文档已要求build→pack→verify，属于手工步骤失守时防护缺口，不是完整流程必然打坏包。

源码：`scripts/stage-gate.mjs:107-115,245-264`；`apps/desktop/package.json:48-50`；`docs/USAGE.md:908-925`。

运行证据：`rtk proxy node C:/Users/someone/AppData/Local/Temp/zcc-pack-review3-sRhdcZ/reproduce.cjs`，真实门--root隔离根：缺index exit4；旧但完整dist及新但缺JS dist均BUILDER_ADMITTED/exit0、uiBuildRan=false；实际打包没有执行。

**建议：**pack前串现有UI vite build，失败停止；不是调用仍未实现的根build门。若保留手工契约，至少查来源一致性/引用资源，不只exists(index)。

### F33 发布桌面main/preload未进入任何CI类型工程

当前根include不含desktop入口，typecheck:apps只UI；七个desktop/lib因测试import纳入，main/preload只被字符串扫描。不是桌面完全无测试，也没有由此证明现存类型错误。

源码：`tsconfig.json:20-26`；`scripts/stage-gate.mjs:87-93`；`apps/ui/tsconfig.json:20`；`tests/unit/desktop-key-redaction.test.mjs:31-32`。

运行证据：`rtk proxy node C:/Users/someone/AppData/Local/Temp/zcc-readonly-desktop-gate-4-20261003.mjs`，真实工程listFilesOnly main/preload=false；临时同构工程两入口已知类型错仍三门exit0，显式加入desktop后两个TS2322/exit1，UI错对照apps门exit1。listFilesOnly本身不是typecheck通过证明。

**建议：**显式纳入Node/checkJs，必要时小桌面工程接CI；保留泄漏扫描，覆盖不依赖测试碰巧import。

### F34 ready驱动的流式前置拒绝退化为连接重置

stream=true先写200/role再首次next；未知模型/不可用资格在生成器入口拒绝时，本可404/503且not_submitted，却已headersSent只能destroy。中途失败也无结构化原因；断连接防假成功仍在，不能推断客户端把它当成功。

源码：`packages/api/src/server.ts:598,627-633,725-745`；`packages/official-host/src/host-driver.ts:1309-1335`；文档`docs/USAGE.md:475,552,755-756`。

运行证据：独立有效命令 `rtk proxy node --input-type=module -e "const hold=setTimeout(()=>{},15000); try { await import('file:///C:/Users/someone/AppData/Local/Temp/zcc-stream-independent-20261003-a214.mjs'); } finally { clearTimeout(hold); }"`。同模型错误JSON404、资格错误JSON503并带原因；stream均ECONNRESET/无错误体；delta后异常200/aborted/无error无DONE。spawn=0，non-ready/schema前置对照仍JSON受控。

**建议：**成功头前等首次next并保留该事件，让前置拒绝走sendError；中途用脱敏可解析SSE error而非正常stop/[DONE]。实际mcode/ocx行为未测。

### F35 ReadPlanSourcesOptions.env被声明却未传到路径解析

程序化传与process.env不同env且未给完整paths，读取仍回落当前进程来源；部分paths只明确文件正确，其余错源。完整paths和直接改process.env的CLI不受此触发影响；实际凭据读取/泄漏未证。

源码：`packages/plansrc/src/reader.ts:223-237,258-265,370-372`；`packages/plansrc/src/index.ts:48-58`；`packages/official-host/src/host-driver.ts:1471`。

运行证据：`rtk proxy node C:/Users/someone/AppData/Local/Temp/zcc-env-recheck-20261003-6c091.mjs`，读取桩仅合成Buffer：directResolverUsesInjectedEnv=true、readerUsesInjectedEnv=false；两加载器读ambient路径，local返回paths亦ambient；完整paths优先对照有效。没有打开生产文件。

**建议：**env与paths一起交解析器，返回paths用相同输入；补env-only/部分/完整paths及两装配路径回归。

## 六、新增已确认：低严重性兼容、披露及维护缺陷

### F36 error.param旁路凭据形态脱敏

已认证客户端把疑似凭据放未知字段名，message已过滤但param原样回显自身键/嵌套路径。不是读取服务端秘密或跨用户泄漏。

源码：`packages/api/src/chat.ts:952-957,991-993,1397-1407,1468-1470`；`packages/api/src/errors.ts:184,209`。运行证据：`rtk proxy node C:/Users/someone/AppData/Local/Temp/zcc-param-independent-recheck-20261003-6.mjs`，五组字段位置400/422均message不含合成串、param含；无认证401/param=null、普通字段/值对照不泄、driver=0。

**建议：**param疑似凭据用现有检测返回null、约束长度，普通安全字段路径保诊断。

### F37 端口文本经parseInt被截断为合法整数

输入8791junk或8790.75可成功保存8791/8790；主进程整数范围校验未失效，只是已看不到原文。

源码：`apps/ui/src/pages/SettingsPage.tsx:57,157-163`；`apps/desktop/lib/settings.cjs:87-91,122-123`。运行证据：`node C:/Users/someone/AppData/Local/Temp/zcc-port-independent-d70ff6-20261003-6f27.cjs`，直接raw拒绝、经renderer则saveOk/persistedPort为截断值；0/65536仍拒。文件只写TEMP。

**建议：**trim完整十进制格式先校验再Number/范围判断，非法文本不调用保存；主进程校验保留。

### F38 HTTP成功目录丢弃fixture来源头

无sourceFixture参数、显式联网且收到2xx/x-zcc-fixture:true时，独立测试态告警缺失。真实内置fixture名称/revision仍可见、不可发送、配置入口拒绝fixture，不是完全无标识冒充或发送绕过。

源码：`apps/ui/src/data/localApiSource.ts:178-186,253-275`；`apps/ui/src/pages/ModelsPage.tsx:476-512,630-634`；`packages/api/src/server.ts:260-286`。

运行证据：`node C:/Users/someone/AppData/Local/Temp/zcc-provenance-recheck-d70ff6-20261003-12.cjs`，真实内存API响应及UI刷新：fixtureHeader=true、headersRead=[]、告警false、名称可见/sendDisabled=true；URL fixture对照告警true/零fetch。

**建议：**保留HTTP fixture provenance随目录状态，提示“HTTP读回测试目录”；不要复用URL场景“零网络”的整段文案。

### F39 单实例页面仍无条件声称未实现

product main已执行requestSingleInstanceLock/second-instance，设置页却固定未注册/第二次未实现，桌面/浏览器区块相同。真实OS锁未验收，本项仅文案过期。

源码：`apps/ui/src/data/snapshot.ts:262-266`；`apps/ui/src/pages/SettingsPage.tsx:317-332`；`apps/desktop/main.cjs:514-520`。

运行证据：`node --experimental-vm-modules C:/Users/someone/AppData/Local/Temp/zcc-single-instance-render-review-13-20261003.cjs`，真实静态渲染两模式区块identical、pendingFields=3、未注册原因相同；main桩支持锁成功/失败分支，但不算真机持锁。

**建议：**先删未实现断言，写产品模式已实现、本页未读实时锁；不能仅凭bridge在场宣称已持锁，smoke/verify有桥却跳过锁。

### F40 一次性验包报告/userData目录无回收链

验包前提通过创建zcc-verify-out后，成功/错误退出均只删cwd；verify/smoke scratch也没记录清理所有权。是TEMP残留，不是活进程或正常product故障，实际Electron缓存体积未测。

源码：`scripts/verify-package.mjs:92,97,198-234`；`apps/desktop/main.cjs:68-72,502-508`。

运行证据：`rtk proxy node --experimental-vm-modules C:/Users/someone/AppData/Local/Temp/zcc-independent-review-tempcleanup-d70ff6-20261003.cjs`，6组原始门模拟结果剩6报告目录、cwd剩0；`rtk proxy node C:/Users/someone/AppData/Local/Temp/zcc-independent-review-desktop-scratch-d70ff6-20261003.cjs`，缺UI的verify/smoke exit2、scratch仍在。独立fixture最终已自行删掉这些自有残留。

**建议：**先走顶层finally再真正退出；给自建目录持所有权，确认自有Electron/进程结束后清理，显式选择保留证据。process.exit外套finally本身不够。

### F41 /v1/models.created输出毫秒而非Unix秒

正常official-host非空模型目录将builtin.readAt=Date.now毫秒直接作created，标准秒解释得到数万年日期；未证明具体IDE因此拒绝。

源码：`packages/plansrc/src/reader.ts:358,371-374`；`packages/official-host/src/host-driver.ts:1475-1480`；`packages/api/src/server.ts:428`。

运行证据：`rtk proxy node C:/Users/someone/AppData/Local/Temp/zcc-created-review-5-20261003-7fbc23.mjs`，固定1800000123456，经真实内存route仍该值，按秒为+059009年；默认时钟亦落Date.now毫秒区间。官方OpenAI Model.created定义为seconds，spawn=0。

**建议：**模型装配边界floor(readAt/1000)，PLANSRC内部毫秒不改；明确本地观察时刻不是官方模型创建日期。

### F42 USAGE两条输入/档位说明与现行契约相反

`tools:null`被§4.4写成收到0条，但实际422，§5.3又已写正确；GLM-5.2/low被写成API422，但通用层只查全局low/high/max，不查该模型交集。不是已证明上游支持low。

源码/文档：`docs/USAGE.md:277,345,535`；`packages/api/src/chat.ts:1025,1093-1103,1267-1287`。

任务提供的精确纯函数命令：

```text
rtk proxy node --input-type=module -e "import{registerHooks}from'node:module';import{existsSync}from'node:fs';registerHooks({resolve(s,c,n){if(s.startsWith('.')&&s.endsWith('.js')&&c.parentURL){const t=new URL(s.slice(0,-3)+'.ts',c.parentURL);if(existsSync(t))return n(t.href,c);}return n(s,c);}});const{parseChatRequest:p}=await import('file:///G:/zcode-project/zcode-companion/packages/api/src/chat.ts');const b={model:'account:bigmodel-start-plan::GLM-5.2',messages:[{role:'user',content:'synthetic'}]};console.log(JSON.stringify({glm52Low:p({...b,reasoning_effort:'low'}).reasoning}));try{p({...b,tools:null});}catch(e){console.log(JSON.stringify({toolsNull:e.code,status:e.status}));}"
```

输出`glm52Low=low`、`toolsNull=unsupported_parameter/status422`，exit0。另有真实API+本地fixture对照：目录只列disabled/high/max，API仍把low交驱动；不算真实GLM调用。

**建议：**只纠正文档：缺席/[]为0条，null非法；low不在当前通用API层按模型拒绝，后续行为未验证。不要为了迁就旧文档扩大实现。

## 七、可优化：与产品bug分开

以下3项均为**新增、低优先级**；确定存在重复工作，不代表已测生产性能瓶颈。

### O01 聚合test会把unit整套再执行一次

源码：`scripts/stage-gate.mjs:77-82,288-294`；`tests/contract/gates.test.mjs:136-139,155-178`。合同内test:unit是前次修复后有意保留的集成覆盖，不是无限递归。

独立命令：`rtk proxy node C:/Users/someone/AppData/Local/Temp/zcc-ro-unit-7-d70ff6-ebc143.mjs`，逐字源码复制到TEMP、只选一个合同及unit哨兵，control unitExecutions=1，aggregate=2/distinctPID=2。真实根有18个unit文件；协调者CI日志该嵌套执行约94.5s，但未测替换后的节省量。

**最小建议：**若接受取消“单跑contract顺带证明真实unit全通过”的约定，真实根改print-targets精确分类断言，保留隔离根真实三门/退出码/哨兵，由聚合只跑unit一次；若要保留该约定，保留现状合理。不能把这说成完全等价删测试。

### O02 无显式幂等的SSE仍收集全流并join，指纹也白算

源码：`packages/api/src/server.ts:540-545,724-738,783-785`；`packages/api/src/chat.ts:1531-1541`。无头不登记重放表的前次修复仍有效，暂存受4MiB预算约束。

独立命令：`rtk proxy node C:/Users/someone/AppData/Local/Temp/zcc-verify-no-idempotent-stream-8-d70ff6e.mjs`，无头响应259412 B，23帧仍push/join，requestBodyHashCalls有sha256，idempotencyEntries/replayBytes=0；显式头对照同串进入重放表。未测heap/吞吐。

**最小建议：**有scope才算指纹、有stored才收集join；无头直接转发，保留SseBudget计数/上限及断连保护，日志计数用已有budget.frames。

### O03 每次资格推导重读两份不参与决策的来源

源码：`packages/official-host/src/host-driver.ts:1323,1442-1447`；`packages/plansrc/src/reader.ts:290-305,325-381`。父进程默认资格判断只消费cache，却每次同步读/哈希/解析/擦除builtin、setting、cache；不代表所有builtin读取可删除。

独立命令：`rtk proxy node C:/Users/someone/AppData/Local/Temp/zcc-entitlement-verifier-9-d94321.mjs`，同驱动连续两请求均读合成builtin414 B/setting44 B/cache118 B；setting坏JSON可提前PLANSRC_JSON_INVALID，而专用cache读取仍entitled；cache改unavailable仍拒，零权限绕过。

**最小建议：**请求级资格只读cache，保留逐请求刷新、fail-closed、严格UTF-8/形状和错误证据；不是复用装配时资格或新增跨请求缓存。与已知数万系统token成本无关，未测生产收益。

## 八、已知遗留及有意边界：不重包成新增bug

### K01 I01强制入口陈旧——已知、低严重性

本终审实际Read确认`AGENTS.md:9-11,42-54`仍把I01称当前、否认能力、旧CI不含test:ui；`docs/decisions/929-toolchain.md:1,4,63,95,97-125`有明确历史阶段/日期，历史ADR本身可以保留。已提供独立复核还确认`package.json:6`骨架描述陈旧，实际`:12`包含UI门。

**建议：**owner仅更新现行入口/包描述与权威链接，将旧阶段规则归档，保留有效安全、凭据、provider-free、所有权及未知结果不重发边界。没有改动现存AGENTS或备份，实际CI没有漏UI。

### K02 3s/2s墙钟断言仍可能受观察线程调度影响——已知优化、低优先级

源码：`tests/unit/official-host-stub-bundle.test.mjs:1610-1638,2861-2909`，两谓词`:1633,2909`。后者测父进程观察finish的时间，不是实际exit耗时。

独立命令：`powershell -NoProfile -Command "Set-Location -LiteralPath 'G:/zcode-project/zcode-companion'; & node 'C:/Users/someone/AppData/Local/Temp/zcc-review-9-wallclock-20261003-6f4209.mjs'; exit $LASTEXITCODE"`，受控暂停观察线程后3332ms/CHILD_TIMEOUT、2205ms/自然退出0均触发等价时间谓词失败；语义检查及自有回收成立。没有重现自然负载flake概率，也未运行原测试套件；本轮CI里原测试通过。

**建议：**保留错误码、自然退出、无强杀和有界回收承重断言，以阶段事件分离启动/观察延迟，端到端性能预算另列；不单纯放宽数字或删断言。

### 其它已披露事项，仅继承披露、不计新增或本终审重验

- 无LICENSE、无GitHub Actions；本机绝对路径遗留。来源为任务“前次已知”及完成审查gaps，未在本终审重新做仓库全面存在性扫描。
- portable不携官方ZCode bundle，安装/依赖边界见`docs/USAGE.md:940`；F21只指出缺依赖却报ready，不否认这个部署前提。
- 纯文本兼容、`tools_forwarded=0`、工具声明统计不等于执行、GUI模型发送门关闭/目录未验证；不把有意能力限制算缺陷。
- low/high/max闭集、ultra被拒；team/zai有限支持；Start Plan不足、两套餐三模型的生产配置事实来自任务，未读真实客户端配置或生产额度。
- 每请求系统token开销、默认约300s宿主超时、上游不保证exactly-once等已披露限制。本轮F02是Companion自己的在途登记淘汰，F04是取消未进入现有收束，不是重复命名这些边界。
- lint/integration/mutations/e2e/根build目前的NOT_IMPLEMENTED边界按现有材料保留，不把非零占位门当测试通过。

## 九、被证伪/收窄的说法，以及仍未确认的线索

### 已被证伪或明确不能沿用

1. **异步spawn error必然崩溃整个Electron桌面：不成立。** Electron44.4.5默认异常处理器不退出；F14保留真实的管理器事件遗漏/超时误诊断，不保留必崩high。
2. **晚到probe会让验包空PID也通过：不成立。** 真实verify-contract拒绝null PID；F07是管理器/UI状态及恢复操作错误。
3. **普通套餐无额度完全没有历史来源：不成立。** 2026-09-29原始指令确有来源；F31只认定历史状态被当实时读数及跨来源错误复用，不推断实际余额。
4. **所有断流都占槽到终态：过强。** 独立F04对照追加事件后SSE释放槽，但子宿主仍继续；无新事件及JSON路径的槽持有分别保留。
5. **chunked槽可以永久占用或未认证触发：不成立。** 实际在认证后，Node默认整请求超时存在；F23限定拒绝延迟窗口。
6. **HTTP fixture完全无标识冒充正式目录/解锁发送：不成立。** 内置名称/revision仍可见、发送禁用、配置入口拒fixture；F38只保留来源头及独立提示遗漏。
7. **本轮CI漏跑UI或旧UI接线修复失效：不成立。** 真实122个UI用例已经运行；陈旧入口说明与真实CI必须分开。
8. **本轮收尾还有活孤儿：不被最终PID/端口核对支持。** 延迟SIGKILL回执不是自然退出；也不能由最终不存在反推超时当时状态。
9. **仅portable包装器足够解释新失败：被未包装exe对照排除为充分解释。** 不等于证明包装器毫无影响。

### 未确认，不追加bug计数

- U01的精确底层根因：Electron退出路径、Windows/Node通知、stdio持有者、launcher或其它原因尚未区分。
- 真实权限/工具workspace是否等于OS沙箱、符号链接/junction隔离、异步stdin EPIPE、更多超大协议行、旧exe与旁置资源混入等，完成审查只有部分静态线索或未完成专项，不定性。
- 运行时发现路径大小写/help失败采纳/SSE额外披露专项曾被取消，没有运行输出，不算通过。
- 两层Windows合成回收实验未观察到孙进程残留，不扩成孤儿bug，也不代表其它OS已验证。
- 实际mcode/ocx对中途SSE错误的呈现/重试、真实GLM档位、真实额度与扣费、生产文件大小/性能未测。

夹具自身曾出现语法、模块解析、TS参数、作用域、时序及未settle错误；这些在给定材料中已如实区分，只有后来有效对照支撑相应结论。F17/F18的预期语义断言exit1则是缺陷复现，不冒充套件通过。

## 十、覆盖、已测/未测与验收限制

### 已完成覆盖——来源为本次已完成五域审查及独立复核

- 桌面：main/preload、proxy-manager、settings、spawn-spec、runtime-paths、log-ring、app-protocol、verify-contract，启停/退出/配置/日志/IPC消费者及相关测试。
- HTTP与官方协议：server/auth/chat/errors，host-driver/credentials/headers/entitlement，host-child/session-drive/reverse-responder及请求/错误/取消/分帧链。
- UI：App/router/shared hooks、desktopBridge/localApiSource/modelSource/snapshot，模型/设置/聊天/日志/总览及相关组件/测试，来源及状态展示。
- 交付门：stage-gate、verify-runtime、verify-package、桌面打包配置、类型范围及gate/contracts测试；测试类别盘点为18 unit、7 contract、4 UI，非全部测试逐行审读。
- 客户端：OpenAI字段/错误/SSE/幂等、PLANSRC mapper/reader/装配和资格刷新；两套餐三模型仅合成数据验证，不是生产配置验收。

### 本终审实际执行的只读范围

Read了pua核心/展示协议、产品AGENTS、929-toolchain；精确读`proxy-manager.cjs:260-469`、`main.cjs:439-580`、`verify-package.mjs:60-100,190-234`，以及U01两份原始日志和`zcc-verify-out-NL3hCA/verify.json`。没有进行第三次全局复审，没有执行测试/命令。

### 本轮实际门/制品检查与限制

- **已测〔协调者〕：**唯一一次完整CI，exit0/29文件1006用例；源码身份与diff检查；现存制品大小/SHA及可比源码；便携verify:package **exit1**及未包装exe退出对照失败。
- **已测〔完成审查/独立复核〕：**上列provider-free专项、真实自有Node/HTTP/Windows信号对照、合成事件/VM/组件/临时同构工程。资源清理记录来自对应实际执行者，不冒充本终审创建/回收过这些资源。
- **未测：**本轮新构建/新pack、干净克隆重装、真实生产模型/额度、实际mcode/ocx、真实OS单实例/窗口交互、视觉与可访问性、整机退出/重启、其它平台。

### 没有真实人工GUI/webui验收

协调者浏览器首次建隔离会话aswc后导航报`session not registered`，session list=[]；受限重试`no_browser_connected`，清理确认session未注册。其官方browser-use/computer-use所需`mcp__node_repl__js`当时工具面缺席，所以没有新的人工点击验收。此为协调者本轮执行环境限制，不据当前子代理工具列表反推其当时工具可用。

协调者补充：随后只读 `bsk doctor` 显示 daemon/IPC/protocol 正常且有浏览器连接；基于这条新证据受限重试，仍得到 `session creation timed out waiting for extension`，再查 `session list=[]`。没有留下可操作会话，没有取得真实点击或截图验收；未重启浏览器/daemon或操作用户标签页。

`renderer executeJavaScript`只证明页面上下文能发API请求，不证明React挂载、桥完整、按钮操作或完整GUI已验收；这一限制也正是F12。

## 十一、最小处理原则与授权状态

建议先处理F01—F12的确定性完整性/生命周期/失败判据，再处理其余中等条目的可用性与状态接线；低风险文档与来源披露可局部修正，三项优化独立排期。U01须保持根因未确认，不靠增加超时或旧成功掩盖；后续诊断只能在另获单次产品运行授权后进行。

所有建议均是评审建议：**本轮没有修代码、改测试/配置/评分器/台账/记忆，没有安装依赖、提交、推送或部署，没有读取/解密生产凭据，没有操作8790原实例、3188或Servy。** CI通过、专项反例和当前制品失败分别保留，不能互相抵消，也不宣布项目无bug或产品验收完成。