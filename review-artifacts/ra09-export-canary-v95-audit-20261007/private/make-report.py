"""生成导出/canary 轮 report.json。

同前：PowerShell 命令行传中文会按代码页解释、把 explanation 写坏；
explanation / unverified / nextstep 必须是**非空字符串**（gate.py:150）。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

round_dir = Path(sys.argv[1])
ids = {
    "typecheck": "82f6afdb-f4f2-4799-b139-de8e7edda59f",
    "probe": "8f062cd5-e643-411b-8048-25cc8af46bc8",
    "scan": "d74c4c45-6539-45d6-bce9-c29ff96990fb",
}


def receipt(aid: str) -> dict:
    return json.loads((round_dir / "actions" / aid / "receipt.json").read_text(encoding="utf-8"))


def line(label: str, aid: str, tail: str) -> str:
    r = receipt(aid)
    return f"{label}：pid={r['pid']} exit={r['exit']} startUTC={r['startedUtc']} endUTC={r['endedUtc']} timeout={r['timeout']}。{tail}"


# A3 的产物从**已封存的 stdout** 解析，而不是另找文件。
# 原因：该 action 声明了 --artifact 路径但脚本只打印 stdout，文件并未生成；
# 它的 stdout 已被 gate 封存（sha256 记在 receipt 里），正是最可靠的证据载体。
# 也不为此新开一个 action 去补写同一路径的 artifact —— 那会踩「同 round 内
# artifact 路径被后续动作改写」的坑。
scan_stdout = (round_dir / "actions" / ids["scan"] / "stdout").read_text(encoding="utf-8", errors="replace")
scan_artifact = json.loads(scan_stdout[scan_stdout.index("{") :])

explanation = "\n".join(
    [
        line("A1 全仓 typecheck", ids["typecheck"], "tsc --noEmit 零错误（stdout 为空即无诊断）。"),
        line(
            "A2 集成红绿（canary 主证据）",
            ids["probe"],
            "真实 createApiServer + 真实 HTTP 打到 127.0.0.1 临时端口 + 假外部 driver + os.tmpdir() 临时 data；"
            "40 条用例全绿（stdout: Tests 40 passed (40)、CLASS=all_passed、STRAY_PROBE_FILES_IN_FORMAL_SRC=0）。"
            "本轮新增 T14 两条：T14a 把**非凭据形状**的合成 canary 放进用户消息正文与 x-zcc-* 头，"
            "经真实 runChat 走完后逐字节扫描临时 data 目录下**每一个**落盘产物（范围已钉死为恰好 "
            "`api-operations-journal.json` 一个文件）、服务端日志行，正文 canary 与头部 canary 均**零命中**；"
            "同时断言 fixture 驱动器的 `fixture_echo` 里**确实带着 canary**，以此证明 canary 真的进到了发送链"
            "——否则「盘上没有它」可能只是因为它压根没进来。"
            "T14b 是扫描器自检负控：把 canary 写进产物（含子目录）后扫描器必须报出命中，"
            "否则 T14a 的「零命中」是假绿。",
        ),
        line(
            "A3 导出入口定位扫描（静态负结论）",
            ids["scan"],
            "对 55 个产品代码文件（apps/ui/src、apps/desktop/lib、apps/desktop/*.cjs、packages，排除 *.test.* 与 node_modules）"
            f"扫描浏览器侧导出/保存原语，结果全部为 0：{json.dumps(scan_artifact['product_hits'], ensure_ascii=False)}。"
            "结论：**本候选不存在导出预览/保存入口**，929.md:874 的「走实际导出预览/保存」无从执行。",
        ),
    ]
)

unverified = "\n".join(
    [
        "**929.md:874 的导出步骤未执行**：不是跳过了，是入口不存在（A3 已给出可复跑的扫描规则与范围）。"
        "需要父审裁定：补建导出功能，还是把 RA-09 的导出面记为未实现。本轮**没有**新建导出功能，也**没有**新建纯 helper。",
        "A3 是**静态**扫描。它只回答「入口在不在」，**不能**替代「实际导出一次并扫 canary」——后者因入口缺失无从执行。",
        "canary 只覆盖了 journal 这一条落盘面与 API 日志行。**未**覆盖：desktop 日志环是否落文件、"
        "IPC 载荷、设置页展示面、请求记录页持久化。这些是 :876 列出的其余证据项，本轮未测。",
        "canary 形状刻意**不是凭据**（不是 sk- / bearer / apiKey=）。因为本条命题是「journal 不存正文」，"
        "若 canary 是凭据形状，redact() 命中就足以让测试变绿——那就测成了脱敏器，而脱敏器救不了"
        "「本就不该落盘的东西」。因此本轮**未**证明 canary 走脱敏器也不会泄漏（那是 :875 的另一半，未测）。",
        "响应体里 canary **会**出现（fixture 驱动器回显 prompt）。已判定不构成「外带」——回给把这段话发来的"
        "同一个客户端不构成外带；真实模型复述用户自己的提问同理。但这条边界是本轮的判断，**未**经父审确认。",
        "apps/desktop/lib/journal.cjs（桌面侧 journal）与 apps/ui 全量页面本轮未重测。",
        "RA-06 的精确取消 / 权威终态核销、:875 的官方秘密不入采集管道，仍未测。"
        "**不得据本轮结论宣称 RA-09 通过。**",
    ]
)

report = {
    "task": "business-v95-20261007",
    "round": round_dir.name,
    "status": "success",
    "projects": {
        "companion-export-canary": {
            "actions": [ids["typecheck"], ids["probe"], ids["scan"]],
            "explanation": explanation,
            "unverified": unverified,
            "nextstep": "请父审裁定 RA-09 导出面：补建导出预览/保存入口，或将其记为未实现；并确认「回显不构成外带」这条边界判断。",
            "diagnosis": "",
        }
    },
}

out = round_dir / "report.json"
out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"WROTE {out}")