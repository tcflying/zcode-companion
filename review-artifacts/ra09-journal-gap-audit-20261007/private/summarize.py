"""把本轮封存的缺口核证 stdout 转录为结构化 JSON 裁定产物。

gate 的 blocker evidence 必须指向可 JSON 解析的文件（gate.py:203 value = read(path)）。
本脚本不产生新结论，逐字段转录已封存的 receipt/stdout。

用法：summarize.py <产物文件名> <封存 action id> <round 目录>
"""
import json
import pathlib
import sys

OUT_NAME = sys.argv[1]
SEALED = sys.argv[2]
ROUND = pathlib.Path(sys.argv[3])

folder = ROUND / "actions" / SEALED
stdout = (folder / "stdout").read_text(encoding="utf-8", errors="replace")
receipt = json.loads((folder / "receipt.json").read_text(encoding="utf-8"))

lines = [ln.strip() for ln in stdout.splitlines() if ln.strip()]
kv = {}
for ln in lines:
    if "=" in ln:
        k, v = ln.split("=", 1)
        kv.setdefault(k.strip(), v.strip())

doc = {
    "decision": "RA-09 clause 875 journal-requirement is NOT IMPLEMENTED in product; recorded as a business gap, not a test pass",
    "clause_source": "G:/zcode-project/zcode-dev/929.md line 875",
    "clause_929_sha256": kv.get("929md_SHA256"),
    "clause_verbatim_contains_journal_requirement": kv.get("SPEC_875_has_journal_clause") == "True",
    "clause_verbatim": kv.get("SPEC_875"),

    "PART_A_journal_requirement_exists": False,
    "A1_journal_mentions_in_product_code": int(kv.get("A1_journal_mentions_in_product_code", "0")),
    "A1_only_site": "apps/ui/src/data/snapshot.ts:270 journal: NOT_CONNECTED as string (display placeholder)",
    "A2_journal_writer_apis": int(kv.get("A2_journal_writer_apis", "0")),
    "A3_reject_when_full_markers": int(kv.get("A3_reject_when_journal_full_markers", "0")),

    "PART_B_adjacent_real_behaviour_ONLY": {
        "note": "These exist in product but are NOT the clause-875 journal mechanism. Neighbouring behaviour only, not clause acceptance.",
        "MAX_IDEMPOTENCY_ENTRIES_512": kv.get("B1_MAX_IDEMPOTENCY_ENTRIES_line"),
        "isEvictableReplay_line": kv.get("B2_isEvictableReplay_line"),
        "stored_state_enum_line": kv.get("B3_stored_state_enum_line"),
        "stored_state_enum_has_unknown": kv.get("B3_stored_state_enum_has_unknown") == "True",
        "evict_breaks_when_no_candidate": kv.get("B4_evict_breaks_when_no_candidate") == "True",
        "commit_precedes_evict": kv.get("B5_commit_before_evict") == "True",
        "auto_retry_mechanism_hits": int(kv.get("B6_auto_retry_mechanism_hits", "0")),
        "chat_throws_upstream_outcome_unknown": kv.get("B7_chat_throws_upstream_outcome_unknown") == "True",
        "errors_code_registered": kv.get("B8_errors_code_registered") == "True",
    },

    "file_sha256": {
        "server_ts": kv.get("server_SHA256"),
        "chat_ts": kv.get("chat_SHA256"),
        "errors_ts": kv.get("errors_SHA256"),
        "contract_operation_ts": kv.get("contract_SHA256"),
    },

    "sealed_action": SEALED,
    "sealed_pid": receipt["pid"],
    "sealed_exit": receipt["exit"],
    "sealed_started_utc": receipt["startedUtc"],
    "sealed_ended_utc": receipt["endedUtc"],

    "verification_kind": "read-only source fact inventory; no product logic reimplemented",
    "real_journal_module_present": False,
    "real_persistence_tested": False,
    "real_inference_called": False,
    "real_credentials_used": False,
    "host_started": False,
    "ipc_used": False,
    "journal_clause_accepted": False,
    "ra09_overall": "NOT_SIGNED",
}

out = ROUND / OUT_NAME
out.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
print("wrote:", out)
print("pid:", receipt["pid"], "exit:", receipt["exit"], "clause_ok:", doc["clause_verbatim_contains_journal_requirement"])