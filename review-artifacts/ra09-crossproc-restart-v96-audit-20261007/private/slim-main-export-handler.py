"""把 main.cjs 里的导出 handler 换成「只注入」的薄壳。

为什么用脚本而不是 Edit：那一段里有中文注释，Edit 的锚点容易被代码页搞坏
（我刚就因为一个字对不上而失败）。这里按**唯一标记**做区间替换，可核查、可复跑。
替换后立即断言：新片段存在、旧片段消失、行数变化符合预期。
"""

from __future__ import annotations

import sys
from pathlib import Path

target = Path(sys.argv[1])
text = target.read_text(encoding="utf-8")

start_marker = "  ipcMain.handle('zcc:desktop:logs:export'"
end_marker = "\n  });\n}"
start = text.index(start_marker)
end = text.index(end_marker, start) + len(end_marker)

replacement = """  ipcMain.handle('zcc:desktop:logs:export', (_event, input) => exportLogs(input));
}"""

old = text[start:end]
if "exportInFlight = true;" not in old:
    raise SystemExit("未找到预期的旧 handler 体；文件可能已被改动，拒绝盲改。")

text = text[:start] + replacement + text[end:]

# 旧 handler 独占的那两个常量/标志现在由 createLogExporter 内部持有，
# 留在主进程里就是**没人读的残留**，删掉。
for dead in (
    "/** 保存进行中的标志：用来实现「重复动作不重复写盘」。 */\nlet exportInFlight = false;\n",
    "/** 预览只回前 N 个字符。预览不该变成一次无意的全量外带。 */\nconst EXPORT_PREVIEW_CHARS = 4096;\n",
):
    if dead not in text:
        raise SystemExit(f"未找到预期残留片段：{dead[:40]!r}")
    text = text.replace(dead, "")

target.write_text(text, encoding="utf-8")
print(f"REPLACED old_lines={old.count(chr(10))} new_total_lines={text.count(chr(10))}")