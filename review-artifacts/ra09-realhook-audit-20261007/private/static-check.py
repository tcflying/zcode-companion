"""静态对照（只读）：证明本轮探针导入的是**真实 useAppState**，不是复刻。

二阶佐证，行为权威是挂载探针的 2 条用例。
本轮要防的正是「以复刻实现证明产品行为」这个错，所以静态侧必须能独立看出：
探针文件里**没有**任何 slice(0, 200)，**没有**自建 log/clearLogs，
而是从 apps/ui/src/app/useAppState 直接 import 真实 hook。
"""
import hashlib
import re

PROBE = r"G:\zcode-project\zcode-companion\review-artifacts\ra09-realhook-audit-20261007\private\realhook.probe.test.ts"
APPSTATE = r"G:\zcode-project\zcode-companion\apps\ui\src\app\useAppState.ts"
LOGGER = r"G:\zcode-project\zcode-companion\apps\ui\src\lib\logger.ts"
LOGSPAGE = r"G:\zcode-project\zcode-companion\apps\ui\src\pages\LogsPage.tsx"


def load(p):
    raw = open(p, "rb").read()
    return raw, raw.decode("utf-8")


def code_only(s):
    c = re.sub(r"/\*.*?\*/", " ", s, flags=re.S)
    c = re.sub(r"//[^\n]*", " ", c)
    c = re.sub(r"`[^`]*`", "``", c)          # 模板字符串
    c = re.sub(r"'[^'\n]*'", "''", c)
    c = re.sub(r'"[^"\n]*"', '""', c)
    return c


probe_raw, probe = load(PROBE)
app_raw, app = load(APPSTATE)
log_raw, log = load(LOGGER)
logs_raw, logs = load(LOGSPAGE)

print("probe_SHA256=" + hashlib.sha256(probe_raw).hexdigest())
print("useAppState_SHA256=" + hashlib.sha256(app_raw).hexdigest())
print("logger_SHA256=" + hashlib.sha256(log_raw).hexdigest())
print("LogsPage_SHA256=" + hashlib.sha256(logs_raw).hexdigest())

probe_code = code_only(probe)
app_code = code_only(app)

print("--- 探针是否导入真实 hook / 真实页面 ---")
print("PROBE_IMPORTS_useAppState=", "from '../../../apps/ui/src/app/useAppState'" in probe)
print("PROBE_IMPORTS_LogsPage=", "from '../../../apps/ui/src/pages/LogsPage'" in probe)
print("PROBE_CALLS_useAppState_hook=", "useAppState()" in probe_code)

print("--- 探针是否复刻了产品实现（本轮要防的错）---")
print("PROBE_HAS_slice_200=", "slice(0, 200)" in probe_code)
print("PROBE_HAS_slice_any=", ".slice(" in probe_code)
print("PROBE_HAS_makeLogEntry_import=", "makeLogEntry" in probe_code)
print("PROBE_SETS_log_manual=", ("state.log =" in probe_code) or ("log: (" in probe_code))
print("PROBE_SETS_clearLogs_manual=", "clearLogs =" in probe_code)

print("--- 产品侧上限的真实出处（探针不实现它，只触发它）---")
print("APSTATE_log_slice_200=", ".slice(0, 200)" in app_code)
print("APSTATE_log_uses_makeLogEntry=", "makeLogEntry(" in app_code)
print("APSTATE_clearLogs=", "const clearLogs = useCallback(() => setLogs([])" in app_code)

print("--- 替身边界：只有 desktop 被替身 ---")
print("PROBE_STUBS_desktop=", "refreshLogsCalls" in probe_code)
print("PROBE_STUBS_network=", ("vi.stubGlobal('fetch'" in probe) and ("vi.stubGlobal('WebSocket'" in probe))
print("PROBE_REFERENCES_mavis_note_no_ipc=", "ipc" not in probe_code.lower())

print("--- 页面侧未被改动 ---")
print("LOGS_HAS_200_literal=", "/ 200" in logs)
print("LOGS_HAS_disabled_available=", "disabled={!desktop.available}" in logs)
print("LOGGER_redacts_message=", "message: redact(message)" in log)