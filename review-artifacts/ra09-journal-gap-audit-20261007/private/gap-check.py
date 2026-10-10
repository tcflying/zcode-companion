"""RA-09 :875「journal不足拒新发而非丢unknown」的缺口核证（只读）。

本脚本**不复刻**任何产品逻辑，只做源码事实盘点，逐条给出可核对的行号与判定。
输出分两部分：
  PART A 条款要求的机制是否存在（journal 持久化 / 容量不足拒新发 / unknown 记录）
  PART B 产品中**真实存在但语义相邻**的行为（幂等重放表的容量淘汰、outcome_unknown 不被重试掩盖）

PART B 的存在**不等于**条款通过，只说明"未接线"而非"实现错误"。
"""
import hashlib
import pathlib
import re

ROOT = pathlib.Path(r"G:\zcode-project\zcode-companion")
SPEC = pathlib.Path(r"G:\zcode-project\zcode-dev\929.md")

SERVER = ROOT / "packages" / "api" / "src" / "server.ts"
CHAT = ROOT / "packages" / "api" / "src" / "chat.ts"
ERRORS = ROOT / "packages" / "api" / "src" / "errors.ts"
SNAPSHOT = ROOT / "apps" / "ui" / "src" / "data" / "snapshot.ts"
CONTRACT = ROOT / "packages" / "contracts" / "src" / "operation.ts"


def load(p):
    raw = p.read_bytes()
    return raw, raw.decode("utf-8")


def code_only(s):
    c = re.sub(r"/\*.*?\*/", " ", s, flags=re.S)
    c = re.sub(r"//[^\n]*", " ", c)
    c = re.sub(r"'[^'\n]*'", "''", c)
    c = re.sub(r'"[^"\n]*"', '""', c)
    return c


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


print("929md_SHA256=" + sha(SPEC))

# 精确引用条款原文：必须逐字取自 929.md:875，不得转述
spec_lines = SPEC.read_text(encoding="utf-8").splitlines()
line875 = spec_lines[874]
print("SPEC_875=" + line875.strip())
print("SPEC_875_has_journal_clause=", "journal不足拒新发而非丢unknown" in line875)

print("")
print("=== PART A: 条款要求的三项机制是否存在 ===")

# A1 journal 持久化：全仓（排除 node_modules 与 review-artifacts）是否有任何 journal 写入
journal_hits = []
for base in (ROOT / "apps" / "ui" / "src", ROOT / "packages"):
    for p in base.rglob("*.ts"):
        if "node_modules" in p.parts:
            continue
        try:
            s = p.read_text(encoding="utf-8")
        except Exception:
            continue
        if "journal" in s.lower():
            journal_hits.append((str(p.relative_to(ROOT)), s.lower().count("journal")))
print("A1_journal_mentions_in_product_code=" + str(len(journal_hits)))
for rel, n in journal_hits:
    print("   A1_hit " + rel + " x" + str(n))

snap_raw, snap = load(SNAPSHOT)
print("A1_snapshot_journal_value=", "journal: NOT_CONNECTED as string" in snap)
print("A1_NOT_CONNECTED_literal=", "export const NOT_CONNECTED = " in snap)

# A1b 是否存在任何 journal 落盘写入 API
writers = []
for base in (ROOT / "apps" / "ui" / "src", ROOT / "packages"):
    for p in base.rglob("*.ts"):
        if "node_modules" in p.parts:
            continue
        try:
            c = code_only(p.read_text(encoding="utf-8")).lower()
        except Exception:
            continue
        for kw in ("writejournal", "journalpath", "journalstore", "appendjournal", "journalfile"):
            if kw in c:
                writers.append(str(p.relative_to(ROOT)) + ":" + kw)
print("A2_journal_writer_apis=" + str(len(writers)))
for w in writers:
    print("   A2_hit " + w)

# A3 是否有"容量不足则拒绝新操作"的语义（reject new / refuse when full）
server_raw, server = load(SERVER)
server_code = code_only(server)
reject_markers = [
    "journal_capacity_exceeded",
    "journal_full",
    "insufficient_journal",
    "reject_new_operation",
    "refuse_new",
]
found_reject = [m for m in reject_markers if m in server_code.lower()]
print("A3_reject_when_journal_full_markers=" + str(len(found_reject)))
for m in found_reject:
    print("   A3_hit " + m)

print("")
print("=== PART B: 真实存在但语义相邻的行为（非条款验收）===")
print("server_SHA256=" + sha(SERVER))
print("chat_SHA256=" + sha(CHAT))
print("errors_SHA256=" + sha(ERRORS))
print("contract_SHA256=" + sha(CONTRACT))

print("B1_MAX_IDEMPOTENCY_ENTRIES_line=", end="")
for i, ln in enumerate(server.splitlines(), 1):
    if "MAX_IDEMPOTENCY_ENTRIES = " in ln:
        print(str(i) + " " + ln.strip())
        break

print("B2_isEvictableReplay_line=", end="")
for i, ln in enumerate(server.splitlines(), 1):
    if "const isEvictableReplay" in ln:
        print(str(i) + " " + ln.strip())
        break
print("B2_isEvictableReplay=" + str(
    "entry.state === 'done' && entry.replay !== null" in server))
print("B3_stored_state_enum_has_unknown=", "'unknown'" in server.split("interface StoredOperation")[1].split("}")[0])
for i, ln in enumerate(server.splitlines(), 1):
    if "state: 'in_flight' | 'done' | 'failed';" in ln:
        print("B3_stored_state_enum_line=" + str(i) + " " + ln.strip())
        break

print("B4_evict_breaks_when_no_candidate=", "if (victimScope === null) break;" in server)
print("B5_commit_before_evict=", "entry.state = 'done';" in server and "evictReplayOverflow();" in server)

# B6 outcome_unknown 是否被任何自动重试机制掩盖
retry_hits = []
for base in (ROOT / "packages" / "api" / "src",):
    for p in base.rglob("*.ts"):
        try:
            c = code_only(p.read_text(encoding="utf-8")).lower()
        except Exception:
            continue
        for kw in ("maxretries", "backoff", "shouldretry", "retrycount"):
            if kw in c:
                retry_hits.append(str(p.relative_to(ROOT)) + ":" + kw)
print("B6_auto_retry_mechanism_hits=" + str(len(retry_hits)))
for h in retry_hits:
    print("   B6_hit " + h)

chat_raw, chat = load(CHAT)
err_raw, errs = load(ERRORS)
print("B7_chat_throws_upstream_outcome_unknown=",
      "throw new ApiError('upstream_outcome_unknown'" in chat)
print("B8_errors_code_registered=",
      "'upstream_outcome_unknown'" in errs)