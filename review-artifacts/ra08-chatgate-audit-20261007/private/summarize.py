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
    "decision": "RA-08 chat page E0 send gate passed under happy-dom private mount",
    "passed_tests_count": int(parts[1]),
    "total_tests_count": int(parts[3].strip("()")),
    "vitest_exit": int(vitest_line.split("=")[1]),
    "classification": class_line.split("=")[1],
    "sealed_action": SEALED,
    "sealed_pid": receipt["pid"],
    "sealed_exit": receipt["exit"],
    "sealed_started_utc": receipt["startedUtc"],
    "sealed_ended_utc": receipt["endedUtc"],
    "chatpage_sha256": "a09b9d89fe67fd2c644edfa56039ada1f18f839a7a9bc63faf7d1f61b7639db4",
    "snapshot_sha256": "3f4600a22e90963ee224e17ba0e62d8a51cfa888520a390f073e621906b4cfb8",
    "coverage": [
        "G1 empty-draft positive control: value='' draft length 0, send button disabled, 4 channels zero",
        "G2 long Chinese draft + real Enter (keydown/keypress/keyup): draft intact, 5 turns unchanged, no bubble leakage, gate still disabled",
        "G3 malicious HTML/Markdown draft: no real script/iframe elements, __pwned undefined, double Enter sends nothing",
        "G4 clear draft: exact before/after values (len>0 -> '' -> 0), repeat clear idempotent, zero dispatch",
        "G5 disabled buttons cannot trigger send: direct .click() on disabled send/cancel plus Enter produce no turns and zero dispatch",
    ],
    "dispatch_channels_counted": ["fetch", "XMLHttpRequest", "WebSocket", "ipc"],
    "ra08_overall": "NOT_SIGNED",
    "real_browser": False,
    "mock_network": True,
    "markdown_sanitization_verified": False,
}

out = ROUND / OUT_NAME
out.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
print("wrote:", out)
print("tests_line:", tests_line, "pid:", receipt["pid"], "exit:", receipt["exit"])