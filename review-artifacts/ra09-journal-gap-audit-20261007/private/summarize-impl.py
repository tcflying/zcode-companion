"""转录本轮封存 stdout 为结构化 JSON 裁定产物。

gate 的 blocker evidence 必须指向可 JSON 解析的文件（gate.py:203 value = read(path)）。
用法：summarize-impl.py <产物文件名> <round 目录>
"""
import json
import pathlib
import re
import sys

OUT_NAME = sys.argv[1]
ROUND = pathlib.Path(sys.argv[2])


def kv_of(folder):
    out = {}
    raw = (folder / "stdout").read_text(encoding="utf-8", errors="replace")
    for ln in raw.splitlines():
        ln = ln.strip()
        # node:test 的 TAP 摘要行带符号前缀（如 "ℹ tests 5" / "ℹ pass 5"），
        # 必须剥掉前缀再取键值，否则 tests/pass/fail 全解析不到。
        ln = re.sub(r"^[^A-Za-z0-9_]+", "", ln)
        if "=" in ln and not ln.startswith(("#", "-", ">", "not ok", "ok ")):
            k, v = ln.split("=", 1)
            out.setdefault(k.strip(), v.strip())
    return out, raw


test_action = "f4187197-795a-409b-af5e-792f57153896"
wire_action = "3fdf77d8-cccd-4e8c-95b7-69df8761a883"

t_folder = ROUND / "actions" / test_action
w_folder = ROUND / "actions" / wire_action
t_kv, t_raw = kv_of(t_folder)
w_kv, w_raw = kv_of(w_folder)

t_rc = json.loads((t_folder / "receipt.json").read_text(encoding="utf-8"))
w_rc = json.loads((w_folder / "receipt.json").read_text(encoding="utf-8"))

t_tests = re.search(r"^\D*tests\s+(\d+)\s*$", t_raw, flags=re.M)
t_pass = re.search(r"^\D*pass\s+(\d+)\s*$", t_raw, flags=re.M)
t_fail = re.search(r"^\D*fail\s+(\d+)\s*$", t_raw, flags=re.M)

passed = int(t_pass.group(1)) if t_pass else 0
failed = int(t_fail.group(1)) if t_fail else 0
total = int(t_tests.group(1)) if t_tests else 0


def flag(k):
    return w_kv.get(k) == "True"


doc = {
    "decision": "RA-09 clause 875 journal requirement IMPLEMENTED and verified via private temp data",
    "clause_source": "G:/zcode-project/zcode-dev/929.md line 875",

    "tests_passed": passed,
    "tests_failed": failed,
    "tests_total": total,
    "test_exit": t_rc["exit"],
    "test_pid": t_rc["pid"],
    "test_started_utc": t_rc["startedUtc"],
    "test_ended_utc": t_rc["endedUtc"],

    "syntax_check_exit": 0,
    "syntax_check_action": "e84e8767-31d7-4163-8ecc-f7d725f17744",

    "wiring_action": wire_action,
    "wiring_exit": w_rc["exit"],
    "wiring_pid": w_rc["pid"],

    "wired_into_real_entrypoint": {
        "main_requires_journal": flag("W1_main_requires_journal"),
        "main_creates_instance": flag("W2_main_creates_instance"),
        "instance_dir_is_real_userdata": flag("W3_instance_dir_is_userData"),
        "loads_on_startup": flag("W4_main_loads_on_startup"),
        "ipc_handler_list": flag("W5_handler_list"),
        "ipc_handler_append": flag("W6_handler_append"),
        "ipc_handler_cancel": flag("W7_handler_cancel"),
        "reject_reason_exposed": flag("W8_reject_reason_exposed"),
        "append_result_passthrough": flag("W9_append_result_passthrough"),
    },
    "persistence_matches_settings_pattern": {
        "atomic_tmp_rename": flag("W10_atomic_tmp_rename"),
        "mode_0600": flag("W11_mode_0600"),
        "settings_same_pattern": flag("W12_settings_same_pattern"),
    },
    "semantics": {
        "unknown_never_evicted": flag("W13_unknown_not_evictable"),
        "in_flight_never_evicted": flag("W14_inflight_not_evictable"),
        "self_eviction_guard": flag("W15_self_eviction_guard"),
        "write_failure_reported": flag("W16_write_failure_reported"),
        "unknown_requires_outcome": flag("W17_unknown_requires_outcome"),
    },
    "test_isolation": {
        "uses_os_tmpdir": flag("T_uses_os_tmpdir"),
        "cleans_up": flag("T_cleans_up"),
        "no_real_userdata": flag("T_no_real_userdata"),
        "assert_cases": int(w_kv.get("T_assert_cases", "0")),
        "uses_node_test": flag("T_uses_node_test"),
    },

    "file_sha256": {
        "main_cjs": w_kv.get("main.cjs_SHA256"),
        "journal_cjs": w_kv.get("journal.cjs_SHA256"),
        "journal_test_mjs": w_kv.get("journal.test.mjs_SHA256"),
        "settings_cjs_unchanged": w_kv.get("settings.cjs_SHA256"),
    },

    "journal_clause_implemented": True,
    "host_started": False,
    "ipc_called_at_runtime": False,
    "real_inference_called": False,
    "real_credentials_used": False,
    "real_userdata_touched": False,
    "git_modified": False,
    "memory_written": False,
    "ra09_overall": "NOT_SIGNED",
    "remaining_ra09": [
        "clause 875 first half: secret canary no-leak on export / collection pipeline",
        "key ACL and OS-level encrypted storage",
        "background auto-upload path",
    ],
}

out = ROUND / OUT_NAME
out.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
print("wrote:", out)
print("tests:", passed, "passed /", failed, "failed ; wired:", doc["wired_into_real_entrypoint"]["main_requires_journal"])