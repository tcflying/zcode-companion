"""生成 v101（类型债清零 + 导出白名单轮）report.json。

id 由命令行传入，不写死。中文一律走 Python：PowerShell 命令行传中文会按代码页解释。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

round_dir = Path(sys.argv[1])
pkgs, apps, desktop, tests, ui, mut = sys.argv[2:8]
TASK = "business-v101-20261007"


def receipt(aid: str) -> dict:
    return json.loads((round_dir / "actions" / aid / "receipt.json").read_text(encoding="utf-8"))


def line(label: str, aid: str, tail: str) -> str:
    r = receipt(aid)
    return (
        f"{label}：pid={r['pid']} exit={r['exit']} "
        f"startUTC={r['startedUtc']} endUTC={r['endedUtc']} timeout={r['timeout']}。{tail}"
    )


def stdout(aid: str) -> str:
    return (round_dir / "actions" / aid / "stdout").read_text(encoding="utf-8", errors="replace")


explanation = "\n".join(
    [
        "**A1–A3 是父审点名的核心项**：`typecheck:desktop` 上一轮以「归属包装器 exit 0」蒙过去，"
        "本轮由原始作者最小修掉 `journal.cjs` 的类型错误，并**跑原始未过滤命令**留下真实 receipt。",
        line("A1 packages 类型检查", pkgs, "tsc --noEmit 零错误。"),
        line("A2 apps（含 TSX）类型检查", apps, "stage-gate typecheck:apps 零错误。"),
        line(
            "A3 原始未过滤 `typecheck:desktop`",
            desktop,
            "**exit=0**（stdout 尾部 STAGE_GATE_EXIT=0，无任何 error TS 行）。"
            "本轮修了 10 处 journal.cjs 类型债 + 9 处本轮新引入的 log-export.cjs 类型债。"
            "修法一律是**类型归一 + 边界显式校验**，**没有**用 `!` / `@ts-ignore` / 放宽 tsconfig 压制类型。",
        ),
        line(
            "A4 桌面侧单测（导出 23 条 + journal 回归 5 条）",
            tests,
            "28/28 全绿（TESTS_TOTAL=28 / TESTS_PASSED=28 / TESTS_FAILED=0 / CLASS=all_passed）。"
            "导出侧**真实驱动**了 preview / save / cancel / repeat / 写失败五条路径："
            "preview 不写任何文件；save 把文件**真的写到 os.tmpdir() 现造的私有目录**并从落盘文件复算 sha256；"
            "cancel 两条分支（canceled=true 与 filePath 空串）都**零写入**且目标目录保持空；"
            "repeat 在真实并发窗口下第二次被 EXPORT_IN_PROGRESS 挡住、saveAs 只被调用一次、只写一次盘；"
            "写失败返回 SAVE_FAILED 且**闸门仍会释放**（下一次保存仍可成功，不被残留状态永久卡死）。",
        ),
        line("A5 UI 测试", ui, "5 文件 176 条全绿。"),
        line(
            "A6 变异验证（5 个）",
            mut,
            "5/5 全部被抓住，红因都是预期的断言："
            "E1 关掉字段白名单（fail=2, assertion）、E2 关掉取值文法（fail=2, assertion）、"
            "E3 去掉两道字节上限防线（fail=1, assertion）、"
            "E4 让自由文本直接流入导出（fail=7, assertion）、"
            "E5 短接在途闸门（fail=0, **timeout**——表现为挂死而非断言失败，已分开标注不混为一谈）。",
        ),
    ]
)

unverified = "\n".join(
    [
        "**白名单的能力边界（如实钉住，非遗留）**：一个 canary 若被塞进**白名单字段**且**恰好符合该字段文法**"
        "（例如全小写短串落进 `reason`），本模块认不出来。该边界有**测试显式钉住**，不是猜测。"
        "承重防线是「字段名白名单 + 取值文法 + 自由文本不进格式」，不是形状脱敏。",
        "`redactValue` 的**已登记机密替换循环在导出路径上不是承重项**：白名单字段的文法本就拒绝含机密的取值，"
        "所以把该循环整段删掉，那条断言照样成立——这是「归因错误」的高发点，本轮已把测试措辞改成如实标注。",
        "**未测**：真实 Electron 下的保存对话框交互与 GUI 呈现。preview/save/cancel/repeat 的**语义**已实测，"
        "但注入的 `saveAs` 是桩；真实 `dialog.showSaveDialog` 的选择/取消、IPC 通道的端到端往返**未跑过**"
        "（本轮不启真实宿主、不与任何 GUI 交互）。",
        "**未测**：preload 通道越权（渲染进程能否绕过 preview 直接要到全文）。`preview` 只回前 N 字符目前只有代码保证。",
        "「上游日志不含正文」这条不变量**仍未钉成测试**：已结构化核对 server.ts 全部 logger 调用无正文，"
        "但那是代码事实、不是被强制的不变量。",
        "本轮改动：apps/desktop/{main.cjs,preload.cjs,lib/log-ring.cjs,lib/journal.cjs,lib/log-export.cjs(新增)}、"
        "apps/desktop/lib/__tests__/log-export.test.mjs(新增)、apps/ui/src/{data/desktopBridge.ts,pages/LogsPage.tsx}。"
        "未做任何 git 写操作，HEAD 未动。",
        "**不得据本轮结论宣称 RA-09 通过**：`:874` 的真实预览交互、ACL、HTML 渲染边界仍未执行。",
    ]
)

report = {
    "task": TASK,
    "round": round_dir.name,
    "status": "success",
    "projects": {
        "companion-log-export-v2": {
            "actions": [pkgs, apps, desktop, tests, ui, mut],
            "explanation": explanation,
            "unverified": unverified,
            "nextstep": "请父审裁定：是否补「上游日志不含正文」回归守卫与 preload 越权测试；真实 Electron 下的对话框交互需在允许启宿主时单独验。",
            "diagnosis": "",
        }
    },
}

out = round_dir / "report.json"
out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"WROTE {out}")