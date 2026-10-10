"""生成本轮 report.json。

**为什么用 Python 写而不是 PowerShell**：PowerShell 经命令行接收中文参数时会按
当前代码页解释，产生乱码——上一次就是这么把 explanation 写坏、validate 直接
`explanation/unverified/nextstep required` 打回的。本文件以 UTF-8 落盘再执行，
中文不经过任何 shell 参数。

字段形状由 evidence-gate/gate.py:150 决定：`explanation` / `unverified` /
`nextstep` 必须各自是**非空字符串**（不是数组）。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

round_dir = Path(sys.argv[1])
action_ids = {
    "typecheck": "fbc7b2d8-c763-4f2e-ae0c-c40e4c4211ea",
    "integration": "9f07b5ea-cf61-4ee0-a84f-a157e192cecd",
    "regression": "a3eb0d92-4e6b-4848-9ed4-be4058569ef2",
}


def receipt(aid: str) -> dict:
    p = round_dir / "actions" / aid / "receipt.json"
    return json.loads(p.read_text(encoding="utf-8"))


def line(label: str, aid: str, tail: str) -> str:
    r = receipt(aid)
    return f"{label}：pid={r['pid']} exit={r['exit']} startUTC={r['startedUtc']} endUTC={r['endedUtc']} timeout={r['timeout']}。{tail}"


explanation = "\n".join(
    [
        line("A1 全仓 typecheck", action_ids["typecheck"], "tsc --noEmit 零错误，确认 journal-store / server / errors 三处类型改动自洽。"),
        line(
            "A2 集成红绿（本轮主证据）",
            action_ids["integration"],
            "真实 createApiServer + 真实 HTTP 请求打到 127.0.0.1 临时端口 + 假外部 driver + os.tmpdir() 临时 data；"
            "29 条用例全绿（stdout: Tests 29 passed (29)、CLASS=all_passed、STRAY_PROBE_FILES_IN_FORMAL_SRC=0）。"
            "覆盖：登记严格早于 driver.stream（取样点在 driver.stream 调用体内同步读盘）；容量不足/落盘失败/原件损坏三类一律拒发且 "
            "driverCalls=0；unknown 与 in_flight 的 operationId 不可重发；写失败后内存不被淘汰污染（父审反例 #3）；"
            "upstream_timeout 按 delivery 归 unknown（父审 v90 遗漏项）；跨重启同 scope 不重复投递"
            "（done→409 replay_unavailable、unknown→502、异体→409 conflict、换键→200 放行）；客户端中途取消记 unknown 而非谎称 done；"
            "损坏 JSON 原件逐字节保留不覆盖；首启 ENOENT 不误判为损坏。",
        ),
        line(
            "A3 既有回归",
            action_ids["regression"],
            "本次改动直接触及的 6 个既有测试文件 204 条用例全绿（Test Files 6 passed (6)、Tests 204 passed (204)）。"
            "其中 tests/unit/api-replay-budget-inflight.test.mjs（F02 重放预算淘汰）一度被我的跨重启幂等守卫从 200 打成 409，"
            "已用 journal.persistent() 门限定该守卫只在真正落盘时生效并复测通过——这是本轮抓到的真实回归，不是测试问题。",
        ),
    ]
)

unverified = "\n".join(
    [
        "跨重启「原样重放 2xx 正文」**未实现**：那需要把响应正文持久化，与「journal 不存正文」硬要求冲突。"
        "本轮保证的是不重复投递（安全性），不是跨重启重放（便利性）。此为有意边界，非缺陷。",
        "start-api.mjs 的 --journal-dir / ZCC_JOURNAL_DIR 只做了解析层与 spawn 层验证（desktop-proxy-manager 与 "
        "api-start-entry 两个既有文件内的断言实跑），未真实拉起 api 进程：父审 v92 明令不启 8791、不探无关进程。",
        "journalMaxEntries 默认 512 只在小值（1~3）下实测过容量拒绝，未在 512 条真实规模下压测。",
        "桌面主进程 journal.cjs 的跨重启保留本轮未重测；api 与桌面两份 journal 的文件名分离已静态核对"
        "（desktop=journal.json / api=api-operations-journal.json），但未做双写者并发实测。",
        "929.md:871-877 中除 :875 外的其余条款（secret canary 不外泄、官方秘密不入采集管道、密钥 ACL、"
        "OS 级加密存储、后台自动上转链路）本轮**完全未测**，不得据本轮结论宣称 RA-09 整体通过。",
    ]
)

report = {
    "task": "business-v90-20261007",
    "round": round_dir.name,
    "status": "success",
    "projects": {
        "companion-journal": {
            "actions": [action_ids["typecheck"], action_ids["integration"], action_ids["regression"]],
            "explanation": explanation,
            "unverified": unverified,
            "nextstep": "把完整业务 diff 与 929.md:871-877 逐条映射交父审签收；签收后另起新一轮处理 RA-09 其余未测条款。",
            "diagnosis": "",
        }
    },
}

out = round_dir / "report.json"
out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"WROTE {out}")