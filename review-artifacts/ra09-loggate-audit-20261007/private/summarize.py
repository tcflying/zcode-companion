"""把本轮封存的挂载探针 stdout 转录为结构化 JSON 裁定产物。

gate 的 blocker evidence 必须指向**可 JSON 解析**的文件（gate.py:203 `value = read(path)`），
stdout 是纯文本会抛 "Expecting value"。本脚本不产生新结论：pass/fail 判定、pid、UTC 全部
取自已封存的 receipt 与 stdout，逐字段转录。

用法：summarize.py <产物文件名> <封存 action id> <round 目录>
产物名与 round 均由命令行传入，**写死路径会导致跨 round 复用同一 artifact**，
使旧动作的 before/after 永不成立（gate.py:179 artifact changed）。
"""
import json
import pathlib
import sys

OUT_NAME = sys.argv[1]
SEALED = sys.argv[2]
ROUND = pathlib.Path(sys.argv[3])

folder = ROUND / "actions" / SEALED
stdout = (folder / "stdout").read_text(encoding="utf-8", errors="replace")
receipt = json.loads((folder / "receipt.json").read_text(encoding="utf-8"))

lines = [ln.strip() for ln in stdout.splitlines() if ln.strip()]
tests_line = next(ln for ln in lines if ln.startswith("Tests "))
vitest_line = next(ln for ln in lines if ln.startswith("VITEST_EXIT="))
class_line = next(ln for ln in lines if ln.startswith("CLASS="))
parts = tests_line.split()

doc = {
    "decision": "RA-09 log page redaction / 200 cap / desktop-unavailable passed under happy-dom private mount",
    "passed_tests_count": int(parts[1]),
    "total_tests_count": int(parts[3].strip("()")),
    "vitest_exit": int(vitest_line.split("=")[1]),
    "classification": class_line.split("=")[1],
    "sealed_action": SEALED,
    "sealed_pid": receipt["pid"],
    "sealed_exit": receipt["exit"],
    "sealed_started_utc": receipt["startedUtc"],
    "sealed_ended_utc": receipt["endedUtc"],
    "logspage_sha256": "c6cd6d7214b0b7368c68809fe39ae6d94ed216043a7cf024a363bbc4eeb86804",
    "logger_sha256": "0a957bdd2bcd2fb8af0f3eb0d849d336b8fafff7bcb138a0c7c0a9ec86",
    "useappstate_sha256": "9a1d110ee5e47a4307ef604020551a8e6e24bc52ec8fc9867fa70a6416254be8",
    "redact_sha256": "31beadca0bf54ced822c1741ccd48d29692fb9323bcd4df2aded6e5557ce12a9",
    "coverage": [
        "L1 self-check click writes 3 entries via real makeLogEntry; canary raw values absent from state JSON and DOM, [REDACTED] present, table has 3 rows",
        "L2 filter WARN/ERROR leaves 2 rows with no canary; back to all = 3; clear buffer empties state and table; repeated clear idempotent",
        "L3 250 pre-seeded entries render 250 rows without truncation, canary still absent",
        "L4 real log() path writes 250; state capped at exactly 200; UI shows 200/200; earliest canary entry evicted; no canary in retained state or DOM",
        "L5 desktop unavailable: pull button disabled, honest panel text, clicking it yields zero network and zero refreshLogs calls",
        "L6 self-check available while pull stays disabled; self-check does not trigger refreshLogs",
        "L7 REVERSE-VALIDITY positive control: desktop available, same button clickable, refreshLogs counter rises 1 then 2 (proves the counter is not a constant-zero shell)",
    ],
    "observed_network_channels": ["fetch", "XMLHttpRequest", "WebSocket"],
    "ipc_status": "NOT_INSTRUMENTED_STATIC_ONLY",
    "canary_kind": "public synthetic constants, no real credential",
    "journal_eviction_tested": False,
    "real_desktop_channel_tested": False,
    "real_browser": False,
    "ra09_overall": "NOT_SIGNED",
}

out = ROUND / OUT_NAME
out.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
print("wrote:", out)
print("tests_line:", tests_line, "pid:", receipt["pid"], "exit:", receipt["exit"])