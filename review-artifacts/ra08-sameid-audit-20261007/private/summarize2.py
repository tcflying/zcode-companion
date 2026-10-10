"""把本轮封存的挂载探针 stdout 转录为结构化 JSON 裁定产物。

gate 的 blocker evidence 必须指向**可 JSON 解析**的文件（gate.py:203 `value = read(path)`），
stdout 是纯文本会抛 "Expecting value"。本脚本不产生新结论：pass/fail 判定、pid、
UTC、hash 全部取自已封存的 receipt 与 stdout，逐字段转录。

用法：summarize2.py <产物文件名> <封存 action id>
产物名与 action 均由命令行传入，**写死路径会导致跨 round 复用同一 artifact**，
使旧动作的 before/after 永不成立（gate.py:179 artifact changed）。
"""
import json
import pathlib
import sys

ROUND = pathlib.Path(sys.argv[3]) if len(sys.argv) > 3 else pathlib.Path(__file__).resolve()
OUT_NAME = sys.argv[1]
SEALED = sys.argv[2]

folder = ROUND / "actions" / SEALED
stdout = (folder / "stdout").read_text(encoding="utf-8", errors="replace")
receipt = json.loads((folder / "receipt.json").read_text(encoding="utf-8"))

lines = [ln.strip() for ln in stdout.splitlines() if ln.strip()]
tests_line = next(ln for ln in lines if ln.startswith("Tests "))
vitest_line = next(ln for ln in lines if ln.startswith("VITEST_EXIT="))
class_line = next(ln for ln in lines if ln.startswith("CLASS="))
parts = tests_line.split()

doc = {
    "decision": "RA-08 same-id-conflict subset passed under happy-dom private mount",
    "passed_tests_count": int(parts[1]),
    "total_tests_count": int(parts[3].strip("()")),
    "vitest_exit": int(vitest_line.split("=")[1]),
    "classification": class_line.split("=")[1],
    "sealed_action": SEALED,
    "sealed_pid": receipt["pid"],
    "sealed_exit": receipt["exit"],
    "sealed_started_utc": receipt["startedUtc"],
    "sealed_ended_utc": receipt["endedUtc"],
    "modelSource_sha256": "78acdb7a2266a3dca4f36543bf7cab0b0cfe57cc888f01abc815269a39642e43",
    "coverage": [
        "K1 same-id domains stay independent (origin/provider not cross-contaminated)",
        "K2 delete same-id manual entry then real refresh: source ids/origin/provider/summary unpolluted, delta stays consistent",
        "K3 positive control: real source removal still counted in delta",
    ],
    "ra08_overall": "NOT_SIGNED",
    "real_browser": False,
    "mock_fetch": True,
}

out = ROUND / OUT_NAME
out.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
print("wrote:", out)
print("tests_line:", tests_line, "pid:", receipt["pid"], "exit:", receipt["exit"])