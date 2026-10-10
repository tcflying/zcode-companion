"""生成 v95b（重跑轮）report.json。

为什么不复用上一轮：round 1763aeb8 在 gate 的 success 状态下被机械拒绝——
A3 声明了 `--artifact .../export-entry-scan.json`，但扫描脚本只 print 不落盘，
receipt 里 generated=false，gate.py:183 'old/missing artifact is not new output'。
那一轮无法补救（在同 round 内补写同一路径会触发 'artifact changed'），
故保留原状不覆盖，另起本轮重跑同样三个动作，并把「脚本真的写盘」这个缺陷修掉。

id 由命令行传入，不写死：写死就是下一轮同路径复用踩坑的根因。
explanation / unverified / nextstep 必须是非空字符串（gate.py:150）。
中文一律走 Python：PowerShell 命令行传中文会按代码页解释、把正文写坏。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

round_dir = Path(sys.argv[1])
typecheck_id, probe_id, scan_id = sys.argv[2], sys.argv[3], sys.argv[4]
TASK = "business-v95b-20261007"
PREV_ROUND = "1763aeb8-66e7-41db-95b8-63a87df390dc"


def receipt(aid: str) -> dict:
    return json.loads((round_dir / "actions" / aid / "receipt.json").read_text(encoding="utf-8"))


def line(label: str, aid: str, tail: str) -> str:
    r = receipt(aid)
    return f"{label}：pid={r['pid']} exit={r['exit']} startUTC={r['startedUtc']} endUTC={r['endedUtc']} timeout={r['timeout']}。{tail}"


# A3 的证据从**实际生成的 artifact** 读取（上一轮正是没生成才翻车）。
scan_artifact_path = round_dir / "export-entry-scan.json"
scan = json.loads(scan_artifact_path.read_text(encoding="utf-8"))
scan_sha = receipt(scan_id)["artifacts"][0]["after"]["sha256"]

explanation = "\n".join(
    [
        f"本轮（round {round_dir.name}）是 v95 的**重跑轮**：上一轮 {PREV_ROUND} 被 gate 在 success 状态下拒绝，"
        "原因是 A3 声明了 --artifact 但脚本只打印 stdout、从未落盘（receipt generated=false）。"
        "该缺陷已修（扫描脚本改为按 argv[1] 写盘），三个动作原样重跑；**被拒的上一轮原样保留、未覆盖、未改写**。"
        "重跑不扩大也不降低原验收范围，结论与上一轮相同。",
        line(
            "A1 全仓 typecheck",
            typecheck_id,
            "tsc --noEmit 零错误（stdout/stderr 均空即无诊断）。",
        ),
        line(
            "A2 集成红绿（canary 主证据）",
            probe_id,
            "真实 createApiServer + 真实 HTTP 打到 127.0.0.1 临时端口 + 假外部 driver + os.tmpdir() 临时 data；"
            "40 条用例全绿（stdout: Tests 40 passed (40)、CLASS=all_passed、STRAY_PROBE_FILES_IN_FORMAL_SRC=0）。"
            "T14a 把**非凭据形状**的合成 canary 放进用户消息正文与 x-zcc-* 头，经真实 runChat 走完后逐字节扫描"
            "临时 data 目录下**每一个**落盘产物（范围已钉死为恰好 `api-operations-journal.json`）与服务端日志行，"
            "正文 canary 与头部 canary 均**零命中**；同时断言 fixture 驱动器的 `fixture_echo` 里**确实带着 canary**，"
            "以此证明 canary 真的进到了发送链——否则「盘上没有它」可能只是因为它压根没进来。"
            "T14b 是扫描器自检负控：把 canary 写进产物（含子目录）后扫描器必须报出命中，否则 T14a 的「零命中」是假绿。",
        ),
        line(
            "A3 导出入口定位扫描（静态负结论）",
            scan_id,
            f"对 {scan['product_file_count']} 个产品代码文件"
            f"（{', '.join(scan['scan_rule']['roots'])}，扩展名 {'/'.join(scan['scan_rule']['extensions'])}，"
            f"排除 {', '.join(scan['scan_rule']['excluded'])}）扫描浏览器侧导出/保存原语，结果全部为 0："
            f"{json.dumps(scan['product_hits'], ensure_ascii=False)}。"
            f"结论：**本候选不存在导出预览/保存入口**，929.md:874 的「走实际导出预览/保存」无从执行。"
            f"本轮新增：扫描 JSON 真正落盘为 artifact（sha256 {scan_sha}），"
            "不再出现「声明了产物却没生成、证据只活在 stdout 里」的情况。",
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
        "A1/A2 与被拒轮做的是同一批事，此处**不**计为新增业务进展，只是把证据链修成自洽。",
        "apps/desktop/lib/journal.cjs（桌面侧 journal）与 apps/ui 全量页面本轮未重测。",
        "RA-06 的精确取消 / 权威终态核销、:875 的官方秘密不入采集管道，仍未测。"
        "**不得据本轮结论宣称 RA-09 通过。**",
    ]
)

report = {
    "task": TASK,
    "round": round_dir.name,
    "status": "success",
    "projects": {
        "companion-export-canary": {
            "actions": [typecheck_id, probe_id, scan_id],
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