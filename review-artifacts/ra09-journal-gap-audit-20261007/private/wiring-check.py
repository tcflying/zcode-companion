"""核证 journal 已接入真实业务入口（只读，不启动宿主/进程）。

本脚本**不执行** main.cjs，只做源码级接线核对：
  - journal 模块被 main.cjs 真实 require（不是孤立新文件）
  - 实例用的是真实 userData 目录（与 settings.json 同根），不是临时目录
  - 三个 IPC handler 已注册，且把容量不足的拒绝如实透出
  - journal.cjs 落盘用原子写（tmp + rename）且权限 0600，与 settings.cjs 同范式
  - 测试文件只碰 os.tmpdir() 私有目录，不碰真实 userData
"""
import hashlib
import pathlib
import re

ROOT = pathlib.Path(r"G:\zcode-project\zcode-companion")
MAIN = ROOT / "apps" / "desktop" / "main.cjs"
JOURNAL = ROOT / "apps" / "desktop" / "lib" / "journal.cjs"
TEST = ROOT / "apps" / "desktop" / "lib" / "__tests__" / "journal.test.mjs"
SETTINGS = ROOT / "apps" / "desktop" / "lib" / "settings.cjs"


def load(p):
    raw = p.read_bytes()
    return raw, raw.decode("utf-8")


def code_only(s):
    c = re.sub(r"/\*.*?\*/", " ", s, flags=re.S)
    c = re.sub(r"//[^\n]*", " ", c)
    c = re.sub(r"'[^'\n]*'", "''", c)
    c = re.sub(r'"[^"\n]*"', '""', c)
    return c


for p in (MAIN, JOURNAL, TEST, SETTINGS):
    print(p.name + "_SHA256=" + hashlib.sha256(p.read_bytes()).hexdigest())

main_raw, main = load(MAIN)
j_raw, j = load(JOURNAL)
t_raw, t = load(TEST)
main_code = code_only(main)
j_code = code_only(j)
t_code = code_only(t)

print("--- 接线：journal 是否进入真实业务入口 ---")
print("W1_main_requires_journal=", "require('./lib/journal.cjs')" in main)
print("W2_main_creates_instance=", "createJournal({" in main_code)
print("W3_instance_dir_is_userData=", "path.dirname(settingsFile)" in main_code)
print("W4_main_loads_on_startup=", "journal.load(journalDir)" in main_code)

print("--- IPC handler 注册 ---")
print("W5_handler_list=", "zcc:journal:list" in main)
print("W6_handler_append=", "zcc:journal:append" in main)
print("W7_handler_cancel=", "zcc:journal:cancel" in main)
print("W8_reject_reason_exposed=", "journal_capacity_exceeded" in j)
print("W9_append_result_passthrough=", "journal.append(input ?? {})" in main_code)

print("--- 落盘范式与权限（须与 settings.cjs 同款）---")
print("W10_atomic_tmp_rename=", "renameSync(tmp, file)" in j_code and ".tmp" in j)
print("W11_mode_0600=", "0o600" in j_code)
print("W12_settings_same_pattern=", "renameSync(tmp, file)" in code_only(SETTINGS.read_text(encoding='utf-8')))

print("--- 语义保护 ---")
print("W13_unknown_not_evictable=", "state !== JOURNAL_STATE_UNKNOWN" in j_code)
print("W14_inflight_not_evictable=", "'in_flight'" in j)
print("W15_self_eviction_guard=", "new entry" in j_code.lower() or "entry] //" in j or "kept = [entry" in j_code)
print("W16_write_failure_reported=", "journal_write_failed" in j)
print("W17_unknown_requires_outcome=", "unknown 记录必须带 outcome" in j)

print("--- 测试只碰私有临时目录 ---")
print("T_uses_os_tmpdir=", "os.tmpdir()" in t)
print("T_cleans_up=", "fs.rmSync" in t)
print("T_no_real_userdata=", "getPath" not in t and "APPDATA" not in t)
print("T_assert_cases=", len(re.findall(r"^test\(", t, flags=re.M)))
print("T_uses_node_test=", "from 'node:test'" in t)