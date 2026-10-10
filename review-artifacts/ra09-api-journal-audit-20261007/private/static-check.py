"""RA-09 packages/api journal 联动（父审 v90/v91）的**静态二阶佐证**。

判据纪律（前几轮踩过的坑，写在这里以免重蹈）：
  1. 静态结论只是辅证。**行为权威性来自 journal-api.probe.test.mjs 的实跑**：
     真实 `createApiServer` + 真实 HTTP + 假外部 driver + `os.tmpdir()` 临时 data。
     本脚本任何一条为 False 都不单独构成产品不合格，只说明静态预期需人工复核。
  2. 搜索标识符前**先剔除注释**，否则注释与文案里的字面量会造出假红。
  3. 每条判据都要能指出**行号或确切片段**。指不出来的判据无法被人眼复核。
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

REPO = Path(r"G:\zcode-project\zcode-companion")
API = REPO / "packages" / "api"
SRC = API / "src"
BIN = API / "bin"
DESKTOP = REPO / "apps" / "desktop"
REQ = Path(r"G:\zcode-project\zcode-dev\929.md")

BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)
LINE_COMMENT = re.compile(r"//[^\n]*")


def strip_comments(text: str) -> str:
    out = BLOCK_COMMENT.sub(lambda m: "\n" * m.group(0).count("\n"), text)
    return LINE_COMMENT.sub("", out)


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


def code_lines(p: Path) -> list[tuple[int, str]]:
    return [
        (i, line)
        for i, line in enumerate(strip_comments(read(p)).splitlines(), start=1)
    ]


def find_line(lines, needle: str) -> int | None:
    for lineno, line in lines:
        if needle in line:
            return lineno
    return None


def sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main() -> int:
    checks: list[dict] = []

    def check(cid: str, desc: str, ok: bool, evidence: str) -> None:
        checks.append({"id": cid, "desc": desc, "ok": bool(ok), "evidence": evidence})

    files = {
        "server": SRC / "server.ts",
        "errors": SRC / "errors.ts",
        "store": SRC / "journal-store.ts",
        "entry": BIN / "start-api.mjs",
        "spawn": DESKTOP / "lib" / "spawn-spec.cjs",
        "proxy": DESKTOP / "lib" / "proxy-manager.cjs",
        "main": DESKTOP / "main.cjs",
        "djournal": DESKTOP / "lib" / "journal.cjs",
    }
    for key, p in files.items():
        if not p.is_file():
            print(json.dumps({"fatal": f"missing file: {p}"}, ensure_ascii=False))
            return 2

    sl, el, bl = code_lines(files["server"]), code_lines(files["errors"]), code_lines(files["entry"])
    stl = code_lines(files["store"])
    spl, pxpl, mnl = code_lines(files["spawn"]), code_lines(files["proxy"]), code_lines(files["main"])

    # ── A 组：登记必须早于真实副作用 ──────────────────────────────────────
    reserve_at = find_line(sl, "operationJournal.reserve(")
    stream_at = find_line(sl, "driver.stream(")
    check(
        "A1",
        "operationJournal.reserve 行号必须早于 driver.stream 行号",
        reserve_at is not None and stream_at is not None and reserve_at < stream_at,
        f"reserve@L{reserve_at} / driver.stream@L{stream_at}",
    )
    check(
        "A2",
        "登记失败必须抛 ApiError（拒新发），不得降级继续",
        find_line(sl, "throw journalRejection(") is not None,
        f"throw journalRejection@L{find_line(sl, 'throw journalRejection(')}",
    )
    check(
        "A3",
        "登记被拒后必须撤销幂等登记，避免留下「在途却没发」的幽灵条目",
        find_line(sl, "operations.delete(scope)") is not None,
        f"operations.delete@L{find_line(sl, 'operations.delete(scope)')}",
    )

    # ── B 组：父审 v90 三条反例的正解 ────────────────────────────────────
    store_body = strip_comments(read(files["store"]))
    check(
        "B1",
        "载入期问题必须让实例进入 poisoned，reserve 一律拒（不得丢弃 problems）",
        "const isPoisoned = loaded.problems.length > 0;" in store_body
        and "reason: 'journal_corrupt'" in store_body,
        f"isPoisoned@L{find_line(stl, 'const isPoisoned')}",
    )
    # Python 的 f-string 表达式里**不能**出现反斜杠转义（PEP 701 之前直接 SyntaxError）。
    # 所以行号一律先算出来再拼进 f-string，不要在 {} 里写 \" ... \"。
    enoent_at = find_line(stl, "code === 'ENOENT'")
    check(
        "B1b",
        "ENOENT（首启）不得被判成问题（否则每个新用户永远起不来）",
        "if (code === 'ENOENT') return { entries: [], problems: [] };" in store_body,
        f"ENOENT 分支@L{enoent_at}",
    )
    unknown_at = find_line(stl, "reason: 'operation_outcome_unknown'")
    inflight_at = find_line(stl, "reason: 'operation_in_progress'")
    check(
        "B2",
        "unknown / in_flight 的同 operationId 必须拒绝（不可重发）",
        unknown_at is not None and inflight_at is not None,
        f"unknown@L{unknown_at} / in_flight@L{inflight_at}",
    )
    persist_list = bool(re.search(r"function\s+persist\s*\(\s*list\s*:", store_body))
    commit_after = bool(
        re.search(r"const\s+err\s*=\s*persist\(next\);\s*if\s*\(err\s*!==\s*null\)\s*\{[^}]*return\s*\{\s*ok:\s*false", store_body, re.S)
    )
    check(
        "B3",
        "内存变更必须在 persist 成功之后才提交（写失败不得丢旧条目）",
        persist_list and commit_after,
        f"persist(list)={persist_list} / 先写后赋值={commit_after}",
    )

    # ── C 组：结算按投递语义分流（父审 v90：漏了 upstream_timeout）───────
    err_body = strip_comments(read(files["errors"]))
    check(
        "C1",
        "ApiError 必须暴露 delivery（让调用方读语义而不是维护码名名单）",
        "get delivery(): DeliveryCertainty {" in err_body,
        f"delivery getter@L{find_line(el, 'get delivery()')}",
    )
    delivery_split_at = find_line(sl, "err.delivery === 'outcome_unknown'")
    check(
        "C2",
        "runChat 结算必须按 err.delivery === 'outcome_unknown' 分流",
        delivery_split_at is not None,
        f"delivery 分流@L{delivery_split_at}",
    )
    timeout_unknown = bool(
        re.search(r"upstream_timeout:\s*\{[^}]*delivery:\s*'outcome_unknown'", err_body)
    )
    check(
        "C3",
        "upstream_timeout 的 delivery 必须是 outcome_unknown（否则 C2 分流不到它）",
        timeout_unknown,
        f"upstream_timeout delivery=outcome_unknown: {timeout_unknown}",
    )

    # ── D 组：三个 journal 拒绝码的契约语义 ─────────────────────────────
    not_submitted = len(
        re.findall(
            r"journal_(?:capacity_exceeded|write_failed|corrupt):\s*\{[^}]*delivery:\s*'not_submitted'",
            err_body,
        )
    )
    check(
        "D1",
        "三个 journal 拒绝码的 delivery 都必须是 not_submitted（不得声称 outcome_unknown）",
        not_submitted == 3,
        f"not_submitted count={not_submitted} (期望 3)",
    )

    # ── E 组：幂等作用域跨重启守卫 ────────────────────────────────────────
    check(
        "E1",
        "跨重启守卫必须在 journal 真的落盘时才生效（否则顶掉 F02 的淘汰后重发语义）",
        "operationJournal.persistent()" in strip_comments(read(files["server"])),
        f"persistent() 门@L{find_line(sl, 'operationJournal.persistent()')}",
    )
    check(
        "E2",
        "journal 记录必须含 scope 与 bodyHash，且**不得**存请求正文",
        "lookupScope(scope: string)" in store_body and "readonly bodyHash?: string;" in store_body,
        "JournalEntry 含可选 scope/bodyHash",
    )

    # ── F 组：默认接线来自既有配置路径（父审 v91）─────────────────────────
    settings_line = find_line(mnl, "settingsFilePath(app.getPath('userData'))")
    dirname_line = find_line(mnl, "path.dirname(settingsFile)")
    check(
        "F1",
        "journalDir 必须由既有 settings 路径推导（dirname(settingsFile)）",
        settings_line is not None and dirname_line is not None,
        f"settingsFile@L{settings_line} / journalDir@L{dirname_line}",
    )
    check(
        "F2",
        "spawn 规格必须把 journalDir 传给子进程",
        "journalDir: options.journalDir," in strip_comments(read(files["spawn"])),
        f"spawn-spec journalDir@L{find_line(spl, 'journalDir: options.journalDir')}",
    )
    check(
        "F3",
        "子进程 env 必须经 ZCC_JOURNAL_DIR 下发，且它必须在入口闭集内",
        "env['ZCC_JOURNAL_DIR'] = options.journalDir;" in strip_comments(read(files["proxy"]))
        and "'ZCC_JOURNAL_DIR'" in strip_comments(read(files["entry"])),
        f"proxy-manager@L{find_line(pxpl, 'ZCC_JOURNAL_DIR')}",
    )

    # ── G 组：两个 journal 不得共用同一文件名（父审 v91 的写入冲突）───────
    desktop_name = re.search(r"JOURNAL_FILE_NAME\s*=\s*'([^']+)'", read(files["djournal"]))
    api_name = re.search(r"API_JOURNAL_FILE_NAME\s*=\s*'([^']+)'", store_body)
    distinct = (
        desktop_name is not None
        and api_name is not None
        and desktop_name.group(1) != api_name.group(1)
    )
    check(
        "G1",
        "api 与桌面 journal 同目录但**文件名必须不同**（同文件会被后写者整体覆盖，丢记录）",
        distinct,
        f"desktop={desktop_name.group(1) if desktop_name else None} / "
        f"api={api_name.group(1) if api_name else None}",
    )

    # ── H 组：需求出处 ─────────────────────────────────────────────────
    req_text = read(REQ)
    clause = "journal不足拒新发而非丢unknown" in req_text.replace(" ", "")
    check("H1", "929.md 原文含「journal不足拒新发而非丢unknown」", clause, f"929.md sha256={sha256(REQ)[:16]}…")

    all_ok = all(c["ok"] for c in checks)
    payload = {
        "scope": "RA-09 packages/api journal 联动 · 静态二阶佐证（v90/v91）",
        "authority_note": (
            "静态检查只是辅证。行为权威性来自 journal-api.probe.test.mjs："
            "真实 createApiServer + 真实 HTTP + 假外部 driver + os.tmpdir() 临时 data，29 条用例实跑。"
        ),
        "all_ok": all_ok,
        "checks": checks,
        "files_sha256": {f"{k}.{p.suffix}": sha256(p) for k, p in files.items()},
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())