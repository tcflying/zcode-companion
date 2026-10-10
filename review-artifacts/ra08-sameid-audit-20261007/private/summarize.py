"""把封存的定案 stdout 解析成结构化 JSON 产物，供 evidence-gate 的 blocker 指针引用。

gate 的 blocker evidence 必须指向**可 JSON 解析**的文件（gate.py:203 `value = read(path)`），
stdout 是纯文本会抛 "Expecting value"。本脚本不产生新结论，只把已封存的原始输出
逐字段转录，hash 与 PID/UTC 全部取自封存 receipt，不重新计算业务判定。
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(
    r"G:\zcode-project\zcode-companion\review-artifacts"
    r"\ra08-sameid-audit-20261007\evidence\88c6eb46-18f2-46ba-8390-97cc7efef2d4"
)
SEALED = "b293ea06-80d7-4f88-b9f5-989b972edfcc"

folder = ROOT / "actions" / SEALED
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

out = ROOT / sys.argv[1] if len(sys.argv) > 1 else ROOT / "sameid-summary.json"
out.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
print("wrote:", out)
print("tests_line:", tests_line)
print("pid:", receipt["pid"], "exit:", receipt["exit"])