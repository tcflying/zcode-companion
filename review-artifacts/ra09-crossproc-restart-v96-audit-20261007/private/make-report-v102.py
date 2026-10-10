# -*- coding: utf-8 -*-
"""生成本轮 report.json（UTF-8 无 BOM）。

用 Python 写而不是 PowerShell `ConvertTo-Json`：中文在 PowerShell 7 控制台往返会被
重新编码成乱码（v101 的 report 就出现过乱码段），且 PS 的 JSON 深度/转义不好控。
"""
import json
import sys
from pathlib import Path

ROUND = Path(
    r"G:\zcode-project\zcode-companion\review-artifacts\ra09-crossproc-restart-v96-audit-20261007"
    r"\evidence\0e17f3c0-9432-4edd-aa61-c3d5b1a903db"
)

EXPLANATION = """\
本轮只闭环一件事：父审 08:34:17 UTC 实跑报的崩溃
`event=done constructor=x` -> `grammar.test is not a function`（PID 5260 exit 1，回执 0ba6c18e）
的**最小自有属性白名单修复**。不重复 v101 已验收的 28 条，也不扩大实现范围。

根因（已由 A4 用正式模块实测坐实，不是推断）：`EXPORT_FIELD_ALLOWLIST` 是普通对象字面量，
直接索引时 `['constructor']` 取到 `Object` 这个**函数**、`['toString']` 取到函数、
`['__proto__']` 取到原型对象，三者都**不是 undefined**，于是穿过旧的 `=== undefined` 检查，
紧接着 `grammar.test(...)` 抛 TypeError。A4 实测 LEGACY_CONSTRUCTOR_UNDEFINED=false、
LEGACY_CONSTRUCTOR_IS_REGEXP=false，两条都证明旧路径确实会放行。

修复（`apps/desktop/lib/log-export.cjs` 的 `selectAllowlistedFields`，单处）：
先用 `Object.prototype.hasOwnProperty.call` 把**取值本身**关进三元，再用 `=== undefined` 收窄类型。
运行时语义与「hasOwnProperty 判否即丢弃」**完全相同**（非自有 -> 取到 undefined -> 计入
droppedFields）。**刻意不写成 `if (!hasOwnProperty(...)) continue;`**：该写法在 checkJs 下
`hasOwnProperty` 不做类型收窄，typecheck:desktop 实测报 TS18048 `'grammar' is possibly 'undefined'`；
而本仓禁止用 `!` / `@ts-ignore` / 放宽 tsconfig。三元 + `=== undefined` 同时满足运行时语义与类型收窄。

A1 typecheck:desktop（pid=56304, exit=0）：STAGE_GATE_SUB=typecheck:desktop / STAGE_GATE_EXIT=0，
原始未过滤命令 exit 0，stdout 无 `error TS`。这是本轮**必须重跑**的原因：修复第一次落地后 typecheck
确实红过（TS18048），三元重写后转绿，不是拿上一轮结果充数。
A5 typecheck:desktop 第二次（pid=45348, exit=0）：第一次动作其实执行了，只是我读错回执字段名
（真实结构是 `{action, exit, timeout, interrupted, receipt}`，不是 `{action:{id,exit_code}}`）没抓到 ID，
重跑一次取回执；两次行为一致，stdout 同为 STAGE_GATE_EXIT=0。

A2 导出单测（pid=61184, exit=0）：TESTS_TOTAL=34 / TESTS_PASSED=34 / TESTS_FAILED=0 / CLASS=all_passed。
**新增 6 条，只测本次影响面**：① 回归钉死父审崩溃输入（不抛 + droppedFields=1 + droppedInvalid=0）；
② 8 个原型链字段名（constructor/toString/valueOf/hasOwnProperty/isPrototypeOf/propertyIsEnumerable/
toLocaleString/__proto__）全部丢弃且计数；③ **承重性对照**（`EXPORT_FIELD_ALLOWLIST['constructor']`
非 undefined、不是 RegExp，且 hasOwnProperty 为 false）——没有这条就说不清「新代码不崩」归功于谁；
④ 未知字段丢弃计数；⑤ **正控**：7 个已知合法字段 0 丢弃 0 脱敏且原样保留；
⑥ **真实驱动回归**：带原型链字段名的行，preview（零落盘、不回吐 canary）/
save（真写 os.tmpdir() 私有目录，落盘内容 sha256 与回执 sha256 复算一致）/
cancel（回 CANCELLED 且 writeFile 未被调用）三条路径都真跑通。
原有 28 条本轮**只作「不回归」判定，不计入新增覆盖**。

A3 变异验证（pid=67240, exit=0）：MUTATION_SUMMARY confirmed=7 failed=0 total=7。
本轮新增两个针对修复点的变异体：**F1**（退回成直接索引 `EXPORT_FIELD_ALLOWLIST[key]`）与
**F2**（用 `key in EXPORT_FIELD_ALLOWLIST` 代替自有属性判定）——两者都 fail=3 / redMode=assertion，
说明 `hasOwnProperty` 确为承重项，且关键是「**自有**」而不是「换一个看起来能用的检查」；
`in` 一样能把崩溃放回来。既有 E1 fail=5、E2 fail=2、E3 fail=1、E4 fail=8 全部 assertion 转红，
E5 仍是 fail=0 / redMode=**timeout**（在途闸门被短接后用例挂在永不 resolve 的 await 上，
靠 `--test-timeout` 才转成红，单独标注不算断言红）。E1 的锚点随本轮改动同步更新过：
原先只把 `if` 改成 `if (false)` 会让非白名单字段取到 undefined 然后**崩**，红因不对
（那是崩不是漏），所以改成连取值一起放宽。

A4 崩溃复现 + stream 边界只读核查（pid=46892, exit=0）：
CRASH_THREW=false / CRASH_BUILD_OK=true / CRASH_DROPPED_FIELDS=1 / CRASH_DROPPED_INVALID=0。
产物 `crash-stream-audit-v102.json`，generated=true，sha256 be0e8e49ac2ecedd07532afa328be17b9fa876c58070b191b9afc82322be48c5。

**stream 元字段边界（父审要求只报告、不扩大实现，结论如下）**：
- `log-ring.cjs` 的 `LOG_STREAMS = Object.freeze(['stdout','stderr','main'])` 只是 JSDoc 类型 + 闭集常量，
  `append(stream, text, at)` **没有运行时校验**（实测 STREAM_RUNTIME_GUARD=false）。
- 行为级证据（非代码审读）：往环里塞一个闭集外的流名，**被接受**（STREAM_ACCEPTED_OUT_OF_SET=true），
  该条目出现在 `tail()`，且导出文本里**原样出现** `stream=<闭集外流名>`（STREAM_REACHES_EXPORT_VERBATIM=true）。
  原因是 `buildLogExport` 直接 `prepared.push(`${stamp} stream=${stream} ${body}`)`，不过白名单、不过 redactValue。
- 现行调用点全部传闭集字面量：`main.cjs:181 'main'`、`proxy-manager.cjs:298 'main'`、
  `proxy-manager.cjs:363 stream`（该 `stream` 来自 `CHILD_STREAMS = ['stdout','stderr']` 字面量闭集）。
- 因此这是**潜在边界，不是现存泄漏**：今天从现有调用点不可达；变成可达需要新增调用点，
  或外部直接持有 `createLogRing` 实例并传入非闭集值。按父审指示**未加守卫、未改实现**。"""

UNVERIFIED = """\
**未测/未做（不因本轮 exit 0 而消失）**：
- 真实 Electron 下 `dialog.showSaveDialog` 与 IPC 端到端往返仍未测（本轮不启宿主、不启 GUI）。
- preload 通道越权未测。
- 「上游日志不含正文」的不变量仍未钉成回归守卫（v101 是结构化读码结论，不是守卫）。
- `stream` 的运行时守卫**本轮刻意未加**（父审指示只报告、不扩大实现）。
- 白名单能力边界依旧：canary 若被塞进白名单字段且恰好符合该字段文法，本模块认不出来（已在测试里如实钉住）。
- `redactValue` 的已登记机密替换循环在导出路径上仍非承重项（文法本就拒绝含机密取值）。
- 缺陷文件仅两处：`apps/desktop/lib/log-export.cjs`（`selectAllowlistedFields`）、
  `apps/desktop/lib/__tests__/log-export.test.mjs`（新增 6 条 + require 增加 `EXPORT_FIELD_ALLOWLIST`）。
  另有两个**工具**脚本：private/mutate-export.mjs（E1 锚点更新 + 新增 F1/F2）、private/crash-repro-and-stream-audit.mjs（新）。
- 未做任何 git 写操作，未 commit、未 push；HEAD 仍为 1558342a0aec04138135a7970aa0b72bc585a9fb，dirty 保持。
- **交父审的 diff 是「诚实标注版」，不是字节精确的文件级 diff**：`log-export.cjs` 与
  `log-export.test.mjs` 都是 v97 建的**未跟踪**文件，git 无历史，`git diff` 对其无输出。
  我试了两条路取「修复前整文件字节」，**都失败并已作废**：① 用本轮 Edit 的 old_string 反向套回重构
  -> sha256 da78580460dfc0a9… ② 从 v101 的 MINIMAL-DIFF.patch 取该文件全量原文（394 行、无尾换行），
  四种换行变体逐一比对 -> deb3439f… / ef3bf387… / 9094f0c6… / ee6021bc…，**全部不等于**父审记录的
  3e87bdd6…（说明那份补丁里的 log-export.cjs 不是父审崩溃时那一版）。
  ⇒ `MINIMAL-DIFF-v102.patch` 里 before 文本来自本会话 Edit 操作的**逐字记录**、**未经文件级哈希验证**；
    after 文本是从磁盘现读切片，与当前文件 sha256 4b020064d9ae2575902e0463c7381f1e6c2074625ae0ff192f1c71caa5db6ba4 **必然一致**。
- 临时物：预验证产物 1 个落在 %TEMP%（`zcc-ra09-pre-*.json`）；本轮单测建的私有导出目录若干（含本轮新增
  `zcc-ra09-exp-proto-driver-*`）。均未清理，未做永久删除。"""

NEXTSTEP = """\
交父审三件事：(1) 本轮完整最小 diff（`git diff` 对已跟踪文件 + `git diff --no-index -- /dev/null <file>`
对未跟踪新文件，含 log-export.cjs 与 log-export.test.mjs）；(2) `stream` 边界结论由父审裁定是否加守卫，
本轮按指示只报告；(3) 若同意，本项目剩余项按序：补「上游日志不含正文」回归守卫 -> preload 通道越权测试 ->
RA-09 :874 真实 Electron 预览交互/ACL/HTML 渲染 -> RA-08 剩余页面与可访问性 -> RA-06 精确取消与权威终态核销。
不擅自改部署/凭据/权限/服务，不启 8791，不探无关进程。"""

report = {
    "task": "business-v102-20261007",
    "round": ROUND.name,
    "status": "success",
    "projects": {
        "companion-log-export-v2": {
            "actions": [
                "b7a6e642-a70c-4378-95ca-58090e281380",
                "e9400343-9d70-4570-9344-059390bea5dd",
                "e525ba69-5b7b-424a-b2b0-bd255a029669",
                "6acae408-e136-44bf-83bc-fb9fc0f20c08",
                "2f36f540-a4b6-4b85-afcf-693d326fead1",
            ],
            "explanation": EXPLANATION,
            "unverified": UNVERIFIED,
            "nextstep": NEXTSTEP,
            "diagnosis": "",
        }
    },
}

out = ROUND / "report.json"
out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"REPORT_WRITTEN={out}")
print(f"REPORT_BYTES={out.stat().st_size}")