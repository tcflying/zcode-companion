"""生成崩溃遗留 in_flight 轮的 report.json。

同前两轮：PowerShell 命令行传中文会按代码页解释、把 explanation 写坏；
explanation / unverified / nextstep 必须是**非空字符串**（gate.py:150）。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

round_dir = Path(sys.argv[1])
ids = {
    "typecheck": "730c27c1-72c3-4f0e-ade7-5a86c2994c42",
    "probe": "feba725a-f884-45ed-ab10-8eab6cbf7814",
    "regression": "0daeecac-f3af-410e-82e4-0dc55e55f7bb",
}


def receipt(aid: str) -> dict:
    return json.loads((round_dir / "actions" / aid / "receipt.json").read_text(encoding="utf-8"))


def line(label: str, aid: str, tail: str) -> str:
    r = receipt(aid)
    return f"{label}：pid={r['pid']} exit={r['exit']} startUTC={r['startedUtc']} endUTC={r['endedUtc']} timeout={r['timeout']}。{tail}"


explanation = "\n".join(
    [
        line("A1 全仓 typecheck", ids["typecheck"], "tsc --noEmit 零错误（stdout 为空即无诊断）。"),
        line(
            "A2 集成红绿（本轮主证据）",
            ids["probe"],
            "真实 createApiServer + 真实 HTTP 打到 127.0.0.1 临时端口 + 假外部 driver + os.tmpdir() 临时 data；"
            "38 条用例全绿（stdout: Tests 38 passed (38)、CLASS=all_passed、STRAY_PROBE_FILES_IN_FORMAL_SRC=0）。"
            "本轮新增 T13 四条：T13a 用产品自己的 createOperationJournal 先真实持久 reserve 出 in_flight（不 settle，"
            "模拟已提交上游未拿终态后进程被杀），确认盘上写的确实是 in_flight，再在新进程用**同会话换新幂等键**发请求 ⇒ "
            "502 session_locked:true、probe.calls.n=0、diagnostics.driverCalls=0；"
            "T13b 承接本身可见且不误伤——problems 为空、poisoned=false（否则一次崩溃会把整个发送功能永久冻死）、recovered 有说明、"
            "状态变为 unknown；T13c 反向对照——同一进程内活着的 in_flight **不**冻结并发（驱动器只挂住第一次调用，"
            "第二条同会话不同键正常 200，probe.calls.n 由 1 涨到 2），并发契约未被扩大；"
            "T13d 边界——旧记录没有 sessionKey 时无法归属会话，lookupSessionUnknown 返回 undefined。",
        ),
        line(
            "A3 既有回归",
            ids["regression"],
            "7 个既有测试文件 250 条用例全绿（Test Files 7 passed (7)、Tests 250 passed (250)）。"
            "连带修正了 T8-2 的过时断言：载入的 in_flight 现已承接为 unknown，其 reserve 理由应为 "
            "operation_outcome_unknown；operation_in_progress 现在只适用于**同进程**活着的在途，两种语义分别覆盖。",
        ),
        "变异验证（非 gate action，单独记录）：把 recoverInFlightFromPreviousProcess 短路为直接返回原 entries 后重跑探针，"
        "T8-2 / T13a / T13b / T13d 立刻变红（4 failed | 34 passed），T13c 保持绿（它本就不依赖跨进程承接）。"
        "这证明 T13 确实由载入承接驱动，而不是碰巧绿。随后按 sha256 校验还原，journal-store.ts 恢复一致（RESTORED_OK=True）。",
    ]
)

unverified = "\n".join(
    [
        "边界（旧记录无 sessionKey）：引入 sessionKey 之前落盘的记录没有这个字段，会话闸门无从判断它属于哪个会话——"
        "T13d 把这一缺口钉成可复核事实。**因此不能声称会话级保护是完整保障**：只有新写入的记录具备会话维度。",
        "客户端不发 x-zcc-client-id / x-zcc-session-id 时 resolveSessionIdentity 返回 null（缺身份不假造），"
        "会话闸门不做判定。危害面未测。",
        "未做真实 desktop 冷启动、未终止真实子进程：跨进程承接是用「先 reserve 不 settle、再新开进程」模拟的"
        "崩溃现场（父审 v92 明令不启 8791、不探无关进程、不动真实进程）。",
        "T13c 的并发对照是在**同一进程**内构造的，不是真实多客户端并发压测。",
        "跨重启「原样重放 2xx 正文」仍未实现；本轮保证的是不重复投递，不是跨重启重放。",
        "全量既有套件未签收：official-tap-fidelity 要求 8791 无监听，该端口由主上正在运行的 ZCodeCompanion.exe 占用；"
        "未 kill 该进程、未改端口。",
        "RA-09 :875 的 secret canary 无泄漏、官方秘密不曾进入采集管道，以及 :876 要求的扫描规则/退出码/脱敏导出 hash/"
        "IPC 文件访问审计/实际预览交互，本轮全部未测。RA-06 完整条款（精确取消、权威终态核销）也未测——"
        ":854 明写「仅unknown保留正确是保护机制通过，不是整个恢复/清场门通过」。",
    ]
)

report = {
    "task": "business-v94-20261007",
    "round": round_dir.name,
    "status": "success",
    "projects": {
        "companion-journal": {
            "actions": [ids["typecheck"], ids["probe"], ids["regression"]],
            "explanation": explanation,
            "unverified": unverified,
            "nextstep": "把完整 diff（含未跟踪 journal-store.ts）与 929.md:845/853/854/875 映射交父审签收；旧记录无 sessionKey 的历史兼容缺口需父审裁定是否另开补写轮。",
            "diagnosis": "",
        }
    },
}

out = round_dir / "report.json"
out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"WROTE {out}")