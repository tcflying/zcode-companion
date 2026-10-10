"""生成 v96b（跨进程重启 + session_locked 最小修复轮）report.json。

为什么有 v96（786d3e65）与 v96b（d5386fb5）两轮：
  v96 的 A2 探针把证据写进 artifact，但 A3 变异脚本**继承了我 shell 里的
  ZCC_CP_EVIDENCE_FILE**，把自己的 6 行也追加进了同一份 artifact（8 行 vs 正例 3 行）。
  证据被污染，且后续动作改写 artifact 路径会让 validate 必然失败（artifact changed）。
  已定位并修掉两处：变异脚本显式清空该环境变量；探针每次运行先清空证据文件。
  v96 原样保留不覆盖，本轮是干净重跑。

id 由命令行传入，不写死。中文一律走 Python：PowerShell 命令行传中文会按代码页解释。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

round_dir = Path(sys.argv[1])
tc, probe, mut, scan = sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
TASK = "business-v96b-20261007"
DEAD_ROUND = "786d3e65-1f55-4f88-983c-63a53a0fdfbc"


def receipt(aid: str) -> dict:
    return json.loads((round_dir / "actions" / aid / "receipt.json").read_text(encoding="utf-8"))


def line(label: str, aid: str, tail: str) -> str:
    r = receipt(aid)
    return (
        f"{label}：pid={r['pid']} exit={r['exit']} "
        f"startUTC={r['startedUtc']} endUTC={r['endedUtc']} timeout={r['timeout']}。{tail}"
    )


ev_lines = (round_dir / "crossproc-evidence.jsonl").read_text(encoding="utf-8").splitlines()
ev = {}
for raw in ev_lines:
    tag, payload = raw.split(" ", 1)
    ev[tag] = json.loads(payload)
evidence = ev["XPROC_EVIDENCE"]
keyobs = ev["XPROC_KEYROTATION_OBSERVATION"]
logobs = ev["XPROC_LOG_OBSERVATION"]
scan_doc = json.loads((round_dir / "export-scan-v96.json").read_text(encoding="utf-8"))
scan_sha = receipt(scan)["artifacts"][0]["after"]["sha256"]
ev_sha = receipt(probe)["artifacts"][0]["after"]["sha256"]

explanation = "\n".join(
    [
        f"本轮（round {round_dir.name}）替换被污染的 {DEAD_ROUND}：那一轮 A2 探针的证据 artifact "
        "被后续变异运行追加污染（8 行 vs 正例 3 行），且改写 artifact 路径会让 validate 必然失败。"
        "两处根因已修（变异脚本显式清空 ZCC_CP_EVIDENCE_FILE；探针每次运行先清空证据文件）。"
        "被污染那一轮原样保留、未覆盖。**结论未因重跑而扩大**：正例仍是同样 3 条用例。",
        line(
            "A1 全仓 typecheck",
            tc,
            "tsc --noEmit 零错误。本轮**确实动了产品源码**（server.ts 的 session_locked 日志行），"
            "所以 typecheck 不是走过场。",
        ),
        line(
            "A2 跨进程闭环探针（真实独立 OS 子进程）",
            probe,
            f"3 条全绿（Tests 3 passed (3)、CLASS=all_passed、STRAY_PROBE_FILES_IN_FORMAL_SRC=0）。"
            f"**T15 冷重启闭环**：子进程 A（pid={evidence['pidA']}，驱动器永不返回⇒请求已进入 driver 且 journal 落 "
            f"in_flight）由本测试父进程 kill，退出信号={evidence['exitA']['signal']}；"
            f"kill 前后两次读盘，journal 均为 in_flight，{evidence['journalBytes']} 字节、"
            f"sha256={evidence['journalSha256']} 完全一致 ⇒ 是**持久**现场，不是内存凑的。"
            f"子进程 B（pid={evidence['pidB']}，与 A 不同，退出信号={evidence['exitB']['signal']}）读同一份临时 data："
            f"同 session + 新 Idempotency-Key + 新输入 ⇒ HTTP {evidence['refusedStatus']}、"
            f"契约码 {evidence['refusedCode']}，且驱动器调用台账 {evidence['callsAfterBStart']}→"
            f"{evidence['callsAfterRefusal']} **未增加**（零 dispatch）；"
            f"独立会话正向 ⇒ HTTP {evidence['acceptedStatus']}，台账涨到 {evidence['callsAfterAccept']} ⇒ "
            "证明上一步的「拒绝+零调用」是闸门造成的，不是环境发不出去。",
        ),
        line(
            "A2 之 T16（换 API key 的同会话重发）——**实测观察项，不是通过项**",
            probe,
            f"sessionKey = idempotencyScope(client, session, keyFingerprint) 含 key 指纹，"
            f"所以换一把 API key 会换出会话键。实测：同会话、换 API key、新幂等键 ⇒ "
            f"**HTTP {keyobs['observedStatus']}、dispatched={keyobs['dispatched']}**"
            f"（驱动器调用 {keyobs['driverCallsBefore']}→{keyobs['driverCallsAfter']}）。"
            "是否算缺陷取决于「929.md:347/:916 的『新key』是否涵盖 API key」——"
            "`:347` 同时规定幂等作用域本就含 key，故**本轮只报事实，不自行裁定**。",
        ),
        line(
            "A2 之 T17（session_locked 日志不再写原值）",
            probe,
            f"合成 canary 原值在子进程日志中出现次数={logobs['rawCanaryOccurrences']}；"
            f"日志行已改为只带会话指纹（hasRawSessionField={logobs['childBLog']['hasRawSessionField']}、"
            f"hasSessionKeyField={logobs['childBLog']['hasSessionKeyField']}），"
            f"该行 sha256={logobs['lockedLineSha256']}。修复见 A2 的产品改动说明。",
        ),
        line(
            "A3 变异验证（全绿不等于有区分力）",
            mut,
            "3 个变异体全部被抓住，且红因都是**预期的那条断言**："
            "M1 短接跨进程承接 ⇒ T15/T17 变红；M2 短接会话闸门 ⇒ T15/T17 变红；"
            "M3 把日志改回原值形态 ⇒ T17 变红（`1 failed | 2 passed`）。"
            "变异在 os.tmpdir() 的副本上做，**正式源码目录零写入**。",
        ),
        line(
            "A4 导出面扫描（口径已按父审意见扩到三面）",
            scan,
            f"浏览器层原语 {json.dumps(scan_doc['product_hits'], ensure_ascii=False)}；"
            f"Electron 层原语 {json.dumps(scan_doc['product_electron_hits'], ensure_ascii=False)}；"
            f"导出类 IPC 通道 {json.dumps(scan_doc['product_export_like_ipc_channels'], ensure_ascii=False)}"
            f"（人工判读：**保存设置**，不是导出路径，属通道名启发式的假阳性——这条假阳性恰好证明扫描不是恒零）。"
            f"产物 sha256={scan_sha}。",
        ),
    ]
)

unverified = "\n".join(
    [
        "**对 v95 旧结论的准确撤回**：v95 说「canary 在服务端日志行零命中」，那是**只测了正常完成路径**。"
        "被拒路径（session_locked）当时会把 client/session **原值**写进日志。本轮已实测并修掉（见 T17），"
        "因此现在可以说：正常完成路径与会话拒绝路径上，合成 canary 原值均未出现在日志中。"
        "**不能**据此泛称「所有日志路径都零泄漏」——未覆盖的面见下。",
        "未覆盖的面：desktop 侧日志环是否落盘、IPC 载荷、设置页/请求记录页展示面。",
        "T16 是**观察项不是通过项**。若父审认定「换 API key 也必须守住同会话 unknown」，"
        "那就是真缺陷，且修法会牵动 `:347` 规定的幂等作用域（本就含 key），需父审先定语义。",
        "`:874` 的导出步骤**仍未执行**：本轮把扫描扩到浏览器层 + Electron 层 + 导出类 IPC 通道名，三面均可核查范围内为零；"
        "但这**不等于**已证明导出功能不存在（UI 文案拼装、直接 fs 写盘都不在计数内）。"
        "按父审口径据实保留为未实现，不再重复请批。",
        "T15 的正向对照用**独立会话**放行。若产品将来允许客户端自报任意 sessionId，"
        "「同会话」本身是客户端声明而非认证身份，这个前提需在 RA-15 单独核。",
        "A2 与 A3 在**被污染轮**里各跑过一次；本轮为干净重跑。探针逻辑未变，仅证据出口从 console 改为文件+清空。",
        "apps/desktop/lib/journal.cjs（桌面侧 journal）与 apps/ui 全量页面本轮未重测。"
        "**不得据本轮结论宣称 RA-09 通过。**",
    ]
)

report = {
    "task": TASK,
    "round": round_dir.name,
    "status": "success",
    "projects": {
        "companion-crossproc-restart": {
            "actions": [tc, probe, mut, scan],
            "explanation": explanation,
            "unverified": unverified,
            "nextstep": "请父审裁定 T16 的语义（换 API key 是否也必须守住同会话 unknown）；并确认 A4 三面扫描口径下的『导出面未实现』据实保留。",
            "diagnosis": "",
        }
    },
}

out = round_dir / "report.json"
out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"WROTE {out} evidence_sha256={ev_sha}")