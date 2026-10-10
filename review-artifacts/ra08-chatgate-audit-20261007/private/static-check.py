"""静态对照（只读，不改任何文件）：确认 ChatPage 的发送门依据仍然成立。

这是**二阶佐证**，行为权威是挂载探针的 5 条用例。
重点：源码里**根本不存在**任何 dispatch 调用点，也不存在 onKeyDown 发送分支。

两处必须避免的假红（本脚本第一版就踩了）：
  1) 切片按固定子串切 onClick 归属会切错位置 → 改用「按行判定」：看 disabled 与
     onClick 是否出现在**同一个 JSX 开始标签**内。
  2) ChatPage.tsx:95 的 placeholder 文案里就写着 "没有 fetch/XHR/WebSocket"，
     全文件子串搜 WebSocket 必然命中**注释/文案**，不是调用点。
     ⇒ 必须先剔除注释与字符串字面量，再搜标识符。
"""
import hashlib
import re

CHAT = r"G:\zcode-project\zcode-companion\apps\ui\src\pages\ChatPage.tsx"
SNAP = r"G:\zcode-project\zcode-companion\apps\ui\src\data\snapshot.ts"

raw = open(CHAT, "rb").read()
s = raw.decode("utf-8")
snap_raw = open(SNAP, "rb").read()
snap = snap_raw.decode("utf-8")

print("ChatPage_SHA256=" + hashlib.sha256(raw).hexdigest())
print("snapshot_SHA256=" + hashlib.sha256(snap_raw).hexdigest())
print("ChatPage_lines=" + str(s.count("\n") + 1))

# ---- 剥掉行注释、块注释与字符串字面量，只留「可执行代码」 ----
code = s
code = re.sub(r"/\*.*?\*/", " ", code, flags=re.S)      # 块注释
code = re.sub(r"//[^\n]*", " ", code)                    # 行注释
code = re.sub(r"'[^'\n]*'", "''", code)                 # 单引号字符串
code = re.sub(r'"[^"\n]*"', '""', code)                 # 双引号字符串（含 JSX 属性值与中文文案）

print("--- 代码区（已剔除注释与字符串）---")
for name in ("fetch(", "XMLHttpRequest", "WebSocket", "ipcRenderer", "ipc", "axios"):
    print(f"CODE_HAS_{name.replace('(', '')}=", name in code)
print("CODE_HAS_chat_completions=", "/chat/completions" in code)

# ---- textarea 是否有键盘发送分支（代码区判定）----
print("CODE_HAS_onKeyDown=", "onKeyDown" in code)
print("CODE_HAS_onKeyPress=", "onKeyPress" in code)
print("CODE_HAS_onKeyUp=", "onKeyUp" in code)

# ---- 发送按钮：disabled 与 onClick 是否同标签 ----
# 第二版修正：按**行**取真实标签体。上一版从 "{SEND_DISABLED_LABEL}" 起切到下一个 "/>"，
# 会跨过本标签的闭合继续吃下一个按钮（清空草稿）的 onClick，造成假红。
lines = s.splitlines()
send_btn_idx = next(i for i, ln in enumerate(lines) if "SEND_DISABLED_LABEL}" in ln)
# 向上回溯到 "<button" 开头
start = send_btn_idx
while "<button" not in lines[start]:
    start -= 1
# 向下取到该标签真正闭合。ChatPage.tsx:99-107 的标签跨 9 行，且收尾行是
# "            </button>"（闭合标签 + 换行 + 子元素），"/>" 落在 </button> 之前，
# 但不能假设它单独成行 —— 故以 </button> 或 /> 任一先出现为准，并做越界保护。
end = send_btn_idx
while end < len(lines) and "</button>" not in lines[end] and "/>" not in lines[end]:
    end += 1
send_tag = "\n".join(lines[start:end + 1])
print("--- 发送按钮标签体 ---")
print("SEND_TAG_LINES=" + str(end - start + 1))
print("SEND_TAG_HAS_disabled=", "disabled" in send_tag)
print("SEND_TAG_HAS_onClick=", "onClick" in send_tag)

# ---- 全文件 onClick 总数：应恰为 1（清空草稿）----
print("TOTAL_onClick_count=", s.count("onClick"))
print("TOTAL_handleClearDraft_count=", s.count("handleClearDraft"))

# ---- 发送门单一真源 ----
print("IMPORTS_CURRENT_EVIDENCE=", "CURRENT_EVIDENCE" in s)
print("snapshot_CURRENT_EVIDENCE_E0=", "CURRENT_EVIDENCE: EvidenceLevel = 'E0'" in snap)
print("snapshot_SEND_DISABLED_LABEL=", "SEND_DISABLED_LABEL = " in snap)