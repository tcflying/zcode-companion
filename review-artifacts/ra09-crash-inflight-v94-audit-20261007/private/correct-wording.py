"""更正 v94 轮 report.json 的措辞（父审 v95）。

更正内容：此前把 T13a 写成「新进程…已测」。实际 `startApi`（→createApiServer）与
`j2`（→createOperationJournal）的构造**全在同一个测试进程内**，没有 spawn / kill /
真实 OS 冷启动。准确表述：**新实例重建 + 持久化故障现场模拟**。

只改表述，不改任何动作 ID、退出码、hash 或结论范围；改完需重新 validate。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

round_dir = Path(sys.argv[1])
p = round_dir / "report.json"
report = json.loads(p.read_text(encoding="utf-8"))
proj = report["projects"]["companion-journal"]

OLD_T13 = "再在新进程用**同会话换新幂等键**发请求 ⇒ "
NEW_T13 = "再在**同一测试进程内**新建 server/journal 实例（无 spawn / 无 kill / 无真实 OS 冷启动），用**同会话换新幂等键**发请求 ⇒ "
assert OLD_T13 in proj["explanation"], "explanation 锚点未命中"
proj["explanation"] = proj["explanation"].replace(OLD_T13, NEW_T13)

proj["explanation"] = (
    "【措辞更正·父审 v95】本轮证据不涉及真实 OS 冷启动：T13 的「新进程」实际是"
    "**同一测试进程内的新实例重建 + 持久化故障现场模拟**（先 reserve 不 settle 造出 in_flight，"
    "再新建 server/journal 实例从同一目录读回）。没有 spawn、没有 kill、没有真实进程边界。"
    "\n"
    + proj["explanation"]
)

OLD_UV = "未做真实 desktop 冷启动、未终止真实子进程：跨进程承接是用「先 reserve 不 settle、再新开进程」模拟的崩溃现场"
NEW_UV = "未做真实 OS 冷启动、未 spawn/kill 任何进程、未终止真实子进程：跨进程承接是用「先 reserve 不 settle 造出 in_flight，再在同一测试进程内新建 server/journal 实例」模拟的崩溃现场"
assert OLD_UV in proj["unverified"], "unverified 锚点未命中"
proj["unverified"] = proj["unverified"].replace(OLD_UV, NEW_UV)

p.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"UPDATED {p}")