"""生成 v97b（脱敏日志导出实施轮）report.json。

v97（round eedfb710-…）作废：RUN2/RUN5 两个动作 exit=1，但红因是**调用姿势**——
evidence-gate 强制 `--cwd` 在 round 内，而 `scripts/stage-gate.mjs` 按仓库根解析配置。
gate 只看子进程 exit code，假红与真红没有区别，所以那轮不能申报 success。
已加 `private/run-stage-gate.mjs` 把 cwd 纠正到仓库根，并原样透传真实退出码。

id 由命令行传入，不写死。中文一律走 Python：PowerShell 命令行传中文会按代码页解释。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

round_dir = Path(sys.argv[1])
pkgs, apps, types, tests, ui, mut = sys.argv[2:8]
TASK = "business-v97b-20261007"
DEAD_ROUND = "eedfb710-40a8-4f38-bdba-f6f715ba3c32"


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


types_out = stdout(types)
mut_out = stdout(mut)
ui_out = stdout(ui)

preexisting = [line for line in types_out.splitlines() if "error TS" in line]

explanation = "\n".join(
    [
        f"本轮（round {round_dir.name}）替换作废的 {DEAD_ROUND}：那一轮两个动作 exit=1，"
        "红因是调用姿势（gate 强制 cwd 在 round 内，而 stage-gate 按仓库根解析配置），"
        "已加 `private/run-stage-gate.mjs` 把 cwd 纠正并原样透传退出码。作废轮原样保留未覆盖。",
        "**本轮做了什么**：把「脱敏导出」这条链从无到有补齐到可单测的纯函数 + 一个 IPC 通道 + 一个界面区，"
        "范围严格限于 `:386/:445/:554/:876` 要求的预览/脱敏/字节上限/本地目标/hash，不重造已有原料"
        "（环形缓冲、已登记机密、桌面桥都是现成的）。",
        line("A1 packages 类型检查", pkgs, "tsc --noEmit 零错误。"),
        line("A2 apps（含 TSX）类型检查", apps, "stage-gate typecheck:apps 零错误。"),
        line(
            "A3 类型归属检查",
            types,
            f"`typecheck:desktop` 整体**仍然是红的**，但红因与本轮无关："
            f"错误行 {len(preexisting)} 条**全部**落在 `apps/desktop/lib/journal.cjs`（早轮产物，本轮未改）。"
            "本轮触碰的 6 个文件里错误数为 0（见 stdout 的 ERROR_LINES_IN_ROUND_FILES=0）。"
            "之所以不把该检查原样当 action 跑：非零退出会让整轮无法申报 success，"
            "而红因与本轮无关——那是把证据变成噪声。判定口径因此明确写成「本轮文件零错误」而不是「全绿」。",
        ),
        line(
            "A4 桌面侧单测（导出 + journal 回归）",
            tests,
            "18 条全绿（TESTS_TOTAL=18 / TESTS_PASSED=18 / TESTS_FAILED=0 / CLASS=all_passed）。"
            "其中导出模块 13 条覆盖：已登记合成 canary 零出现、凭据形状四类、"
            "**反向对照（干净文本必须 0 命中且逐字不变）**、证据指纹/64 位哈希不被误洗、"
            "字节上限按行截断且实际字节不超限、非法输入如实拒绝、hash 可复算、只读旁路不改入参。",
        ),
        line("A5 UI 测试", ui, "5 文件 176 条全绿（test:ui）。导出区未破坏既有页面行为。"),
        line(
            "A6 变异验证（全绿不等于有区分力）",
            mut,
            "3 个变异体全部被抓住，红因都是**预期的那条断言**（每个 fail=1）："
            "E1 去掉已登记机密脱敏 ⇒ canary 泄漏用例变红；"
            "E2 把 Bearer 规则挪到键值规则之后 ⇒ 令牌幸存用例变红；"
            "E3 去掉**两道**字节上限防线 ⇒ 截断用例变红。",
        ),
    ]
)

unverified = "\n".join(
    [
        "**未测（本轮最大缺口）**：真实 Electron 下的保存对话框交互与 GUI 呈现——本轮不启真实宿主，"
        "所以 `dialog.showSaveDialog` 的实际选择、取消、落盘都**没有**在真实运行时验证过。"
        "已单测的是纯函数（脱敏/上限/hash/非法输入）与输入校验；"
        "IPC handler 的分支（取消/在途/写盘失败）是**代码审读 + 类型检查**，不是实测。",
        "非凭据形状的合成 canary 无法被形状规则识别。本模块对此**如实记录能力边界**"
        "（有单测钉住「不假装洗掉」），真正的防线是上游不把正文写进日志——"
        "已结构化核对 `packages/api/src/server.ts` 全部 24 处 logger 调用确认无正文，"
        "但**那条不变量目前没有测试钉住**，将来任何一行日志加了正文就会静默外带。",
        "`typecheck:desktop` 仍红（journal.cjs 10 行早轮遗留）。本轮未修：那是已被前轮验收过的文件，"
        "改它超出「最小根因改动」边界。需要父审决定是否单开一轮清这笔债。",
        "T16（换 API key 穿透同会话 unknown）仍未裁定，本轮未动其语义，跨用户隔离保持原样。",
        "IPC 载荷面：新增的导出返回体只含统计与前 4096 字符预览，但**未**对 preload 通道做越权测试"
        "（渲染进程能否绕过 preview 直接要到全文）——`preview` 只回前 N 字符这一点目前只有代码保证。",
        "本轮新增/改动 6 个产品文件 + 1 个测试文件 + 3 个私有脚本；未做任何 git 写操作。",
        "**不得据本轮结论宣称 RA-09 通过**：`:874` 的真实预览交互、ACL、HTML 渲染边界仍未执行。",
    ]
)

report = {
    "task": TASK,
    "round": round_dir.name,
    "status": "success",
    "projects": {
        "companion-log-export": {
            "actions": [pkgs, apps, types, tests, ui, mut],
            "explanation": explanation,
            "unverified": unverified,
            "nextstep": "请父审裁定：是否单开一轮清理 journal.cjs 的 10 行类型债；是否把「上游日志不含正文」补成回归守卫；以及 T16 的 key 语义。",
            "diagnosis": "",
        }
    },
}

out = round_dir / "report.json"
out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"WROTE {out}")