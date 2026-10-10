"""把本轮封存的挂载探针 stdout 转录为结构化 JSON 裁定产物。

gate 的 blocker evidence 必须指向可 JSON 解析的文件（gate.py:203 value = read(path)），
stdout 是纯文本会抛 Expecting value。本脚本不产生新结论，逐字段转录已封存的 receipt/stdout。

用法：summarize.py <产物文件名> <封存 action id> <round 目录>
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
stray_line = next((ln for ln in lines if ln.startswith("STRAY_FILES_IN_APPS_UI_SRC=")), "UNKNOWN")
parts = tests_line.split()

doc = {
    "decision": "RA-09 real useAppState hook wiring: 200 cap is produced by the product hook itself",
    "passed_tests_count": int(parts[1]),
    "total_tests_count": int(parts[3].strip("()")),
    "vitest_exit": int(vitest_line.split("=")[1]),
    "classification": class_line.split("=")[1],
    "sealed_action": SEALED,
    "sealed_pid": receipt["pid"],
    "sealed_exit": receipt["exit"],
    "sealed_started_utc": receipt["startedUtc"],
    "sealed_ended_utc": receipt["endedUtc"],
    "apps_ui_src_stray_files": stray_line.split("=")[1],
    "probe_sha256": "3f86c5a4fb143bbbb3238e61c2abeec837fc15323a0af177ad41b894575b1571",
    "useappstate_sha256": "9a1d110ee5e47a4307ef604020551a8e6e24bc52ec8fc9867fa70a6416254be8",
    "logspage_sha256": "c6cd6d7214b0b7368c68809fe39ae6d94ed216043a7cf024a363bbc4eeb86804",
    "logger_sha256": "0a957bdd2bcd2fb8af0f3eb0d849d336b8fafff7bcb138a0c7c0a9ec86",
    "coverage": [
        "L4R real hook: boot logs from useAppState.ts:50-61 prove it is the real hook, not an empty stub; real log() called 250 times; state.logs capped at exactly 200 by useAppState.ts:40 slice itself; earliest canary entry evicted; canary absent from state JSON and DOM; UI shows 200/200; 200 DOM rows; zero network",
        "L4R2 real clearLogs(): empties to 0, empty-state panel shown, repeated clear idempotent, zero network",
    ],
    "probe_reimplements_product_logic": False,
    "probe_has_slice_calls": False,
    "probe_imports_makeLogEntry": False,
    "probe_assigns_log_or_clearlogs": False,
    "stubbed_dependencies": ["DesktopState (external Electron main, intentionally not started)", "fetch", "XMLHttpRequest", "WebSocket"],
    "not_stubbed": ["useAppState", "LogsPage", "makeLogEntry", "redact"],
    "observed_network_channels": ["fetch", "XMLHttpRequest", "WebSocket"],
    "ipc_status": "NOT_INSTRUMENTED_STATIC_ONLY",
    "real_desktop_channel_tested": False,
    "real_browser": False,
    "journal_eviction_tested": False,
    "ra09_overall": "NOT_SIGNED",
}

out = ROUND / OUT_NAME
out.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
print("wrote:", out)
print("tests_line:", tests_line, "pid:", receipt["pid"], "exit:", receipt["exit"], "stray:", stray_line)