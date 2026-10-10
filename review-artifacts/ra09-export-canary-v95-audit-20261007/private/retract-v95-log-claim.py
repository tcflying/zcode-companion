"""在 v95b 的 report.json 里**追加**一条准确撤回，并重新落盘。

撤回内容：v95 说「canary 在服务端日志行零命中」——那只测了**正常完成路径**。
被拒路径（session_locked）当时会把 client/session 原值写进日志。
该问题已在 v96b 实测并做最小修复，所以现在能说的是「正常完成路径与会话拒绝路径均零命中」，
**不能**泛称「所有日志路径零泄漏」。

只追加、不覆盖既有文字：被拒轮与旧结论都保留可追溯。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

report_path = Path(sys.argv[1])
marker = "【v96b 撤回】"

report = json.loads(report_path.read_text(encoding="utf-8"))
project = next(iter(report["projects"].values()))
unverified = project["unverified"]

if marker in unverified:
    print("ALREADY_PRESENT")
    raise SystemExit(0)

correction = (
    marker
    + "本条更正 v95 的一个过宽表述：v95 写「canary 在服务端日志行零命中」，"
    "但那只覆盖**正常完成路径**；被拒路径（session_locked）当时会把 client/session **原值**写进日志。"
    "该问题已在 v96b（round d5386fb5-…）实测并做最小修复（改为只写会话指纹），"
    "因此现在成立的表述是「正常完成路径与会话拒绝路径上，合成 canary 原值均未出现在日志中」。"
    "**仍不得**泛称「所有日志路径零泄漏」——desktop 日志环、IPC 载荷、设置页/请求记录页展示面仍未覆盖。"
)

project["unverified"] = correction + "\n" + unverified
report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"CORRECTION_ADDED {report_path}")