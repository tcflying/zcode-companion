"""静态对照（只读，不改任何文件）：RA-09 日志页的脱敏与上限依据是否成立。

二阶佐证，行为权威是挂载探针的 7 条用例。

两处必须避免的假红（本脚本第一版就踩了）：
  1) LogsPage.tsx:10-15 与 :224-236 的**脱敏规则说明文案**里字面写着
     apiKey / token / Bearer / sk- 等字样 ⇒ 全文件搜这些关键字必然命中，
     那是"规则说明"，不是"调用点"。必须先剔除注释与字符串字面量再搜。
  2) 200 上限在 useAppState.ts 的 log() 内（slice(0,200)），
     而 LogsPage.tsx 只渲染 "{length} / 200" 字面 ⇒ 搜 LogsPage 找不到 slice。
"""
import hashlib
import re

LOGS = r"G:\zcode-project\zcode-companion\apps\ui\src\pages\LogsPage.tsx"
LOGGER = r"G:\zcode-project\zcode-companion\apps\ui\src\lib\logger.ts"
APPSTATE = r"G:\zcode-project\zcode-companion\apps\ui\src\app\useAppState.ts"
REDACT = r"G:\zcode-project\zcode-companion\apps\ui\src\lib\redact.ts"


def load(p):
    raw = open(p, "rb").read()
    return raw, raw.decode("utf-8")


def code_only(s):
    """剔除块注释、行注释、字符串字面量，只留可执行代码。"""
    c = re.sub(r"/\*.*?\*/", " ", s, flags=re.S)
    c = re.sub(r"//[^\n]*", " ", c)
    c = re.sub(r"'[^'\n]*'", "''", c)
    c = re.sub(r'"[^"\n]*"', '""', c)
    return c


logs_raw, logs = load(LOGS)
logger_raw, logger = load(LOGGER)
app_raw, app = load(APPSTATE)
red_raw, red = load(REDACT)

print("LogsPage_SHA256=" + hashlib.sha256(logs_raw).hexdigest())
print("logger_SHA256=" + hashlib.sha256(logger_raw).hexdigest())
print("useAppState_SHA256=" + hashlib.sha256(app_raw).hexdigest())
print("redact_SHA256=" + hashlib.sha256(red_raw).hexdigest())

logs_code = code_only(logs)
logger_code = code_only(logger)
app_code = code_only(app)

print("--- 日志页代码区（已剔除说明文案）---")
for n in ("fetch(", "XMLHttpRequest", "WebSocket", "ipcRenderer"):
    print(f"LOGS_CODE_HAS_{n.replace('(', '')}=", n in logs_code)

print("--- 写前脱敏硬编码（唯一日志写入口）---")
print("makeLogEntry_redacts_message=", "message: redact(message)" in logger)
print("makeLogEntry_redacts_source=", "source: redact(source)" in logger)
print("makeLogEntry_is_only_writer=", logger.count("export function makeLogEntry") == 1)

print("--- 200 条上限（在 useAppState.log 内，不在页面）---")
print("app_slice_200=", ".slice(0, 200)" in app_code)
print("app_log_uses_makeLogEntry=", "makeLogEntry(" in app_code)

print("--- 页面显示与桌面边界 ---")
print("page_shows_200_literal=", "/ 200" in logs)
print("page_pull_disabled_by_available=", "disabled={!desktop.available}" in logs)
print("page_selfcheck_logs_raw_canary=", "SELF_CHECK_RAW" in logs_code)

print("--- 脱敏规则常量 ---")
print("redact_REDACTED=", "export const REDACTED" in red)
print("redact_bearer_rule=", "Bearer" in red)
print("redact_prefixed_key=", "sk-" in red)