# -*- coding: utf-8 -*-
"""生成交父审的本轮最小 diff（**诚实标注版**）。

【为什么不拿文件级 git diff】
`apps/desktop/lib/log-export.cjs` 与 `apps/desktop/lib/__tests__/log-export.test.mjs`
都是 v97 建的**未跟踪**文件，git 无历史，`git diff` 对它们**什么都不显示**。

【前置态字节为什么没交】
我试了两条路拿「修复前」的整文件字节，**都失败了**，如实记录而不是硬凑：
  1) 用本轮两次 Edit 的 old_string 反向套回重构 ⇒ sha256 = da78580460dfc0a9…  ≠ 记录值 3e87bdd6…
  2) 从 v101 的 MINIMAL-DIFF.patch 取该文件全量原文（394 行、无尾换行），
     四种换行变体逐一比对 ⇒ deb3439f / ef3bf387 / 9094f0c6 / ee6021bc，**全部不等于** 3e87bdd6…
     （说明那份补丁的 log-export.cjs 内容不是父审崩溃时的那一版）
⇒ 所以**不产出**声称字节精确的文件级 diff。父审记录的前置态 sha256 是 3e87bdd6…，
   修复后是下方 AFTER_SHA；中间这处判定改写的 before 文本以本会话 Edit 操作的**逐字记录**为准。

【本文件实际交付什么】
  第 1 段：源码侧唯一改动点（before / after 逐字）
  第 2 段：测试侧新增 6 条用例（逐字，从磁盘现读）
"""
import difflib
import hashlib
from pathlib import Path

BASE = Path(r"G:\zcode-project\zcode-companion\review-artifacts\ra09-crossproc-restart-v96-audit-20261007")
SRC = Path(r"G:\zcode-project\zcode-companion\apps\desktop\lib\log-export.cjs")
TEST = Path(r"G:\zcode-project\zcode-companion\apps\desktop\lib\__tests__\log-export.test.mjs")
OUT = BASE / "MINIMAL-DIFF-v102.patch"

RECORDED_PREFIX_SHA = "3e87bdd6e0281617dc7035998fbc9898d32482bb7f45c8f9a541056a8c6b8eb2"

# 本轮**第一次** Edit 的 old_string（修复前原文，逐字记录）
BEFORE_REGION = """\
    if (grammar === undefined) {
      droppedFields += 1;
      continue;
    }
    const grammar = EXPORT_FIELD_ALLOWLIST[key];
    const redacted = redactValue(rawValue, secrets);"""

# 本轮**最终**形态（修复后原文，从磁盘现读并切片，避免转抄出错）
AFTER_REGION_START = "    // 必须判**自有属性**，不能判 `=== undefined`。"
AFTER_REGION_END = "    const redacted = redactValue(rawValue, secrets);\n"


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


src_text = SRC.read_text(encoding="utf-8")
test_text = TEST.read_text(encoding="utf-8")

a = src_text.index(AFTER_REGION_START)
b = src_text.index(AFTER_REGION_END, a) + len(AFTER_REGION_END)
after_region = src_text[a:b]

src_hunk = "".join(
    difflib.unified_diff(
        [f"@@ selectAllowlistedFields 字段名判定 @@\n", *(BEFORE_REGION.splitlines(keepends=True)), "\n"],
        [f"@@ selectAllowlistedFields 字段名判定 @@\n", *(after_region.splitlines(keepends=True)), "\n"],
        fromfile="a/apps/desktop/lib/log-export.cjs  (修复前，仅判定块，before 未做字节验证)",
        tofile="b/apps/desktop/lib/log-export.cjs  (修复后)",
        n=0,
    )
)

# 测试侧：新增块从本轮追加的分节标题起，到文件尾
marker = "/* 原型链字段名回归（父审 08:34:17 UTC 实跑崩溃）"
marker = marker + "                                 */"
tb = test_text.index(marker) if marker in test_text else test_text.index("原型链字段名回归")
test_tail = test_text[tb:]

require_old = """const {
  DEFAULT_MAX_BYTES,
  MIN_MAX_BYTES,
  HARD_MAX_BYTES,
  ALLOWLISTED_FIELDS,"""
require_new = """const {
  DEFAULT_MAX_BYTES,
  MIN_MAX_BYTES,
  HARD_MAX_BYTES,
  EXPORT_FIELD_ALLOWLIST,
  ALLOWLISTED_FIELDS,"""

body = f"""\
# 本轮最小 diff —— RA-09 日志导出「原型链字段名崩溃」修复
# 任务 business-v102-20261007 / round 0e17f3c0-9432-4edd-aa61-c3d5b1a903db
# validate: accepted_success / evidence_valid=true / exit 0
# 变更文件（均**未跟踪**，git diff 对其无输出）：
#   M(未跟踪) apps/desktop/lib/log-export.cjs
#   M(未跟踪) apps/desktop/lib/__tests__/log-export.test.mjs
#   M(未跟踪) review-artifacts/.../private/mutate-export.mjs            （E1 锚点更新 + 新增 F1/F2）
#   A(新)    review-artifacts/.../private/crash-repro-and-stream-audit.mjs
#   A(新)    review-artifacts/.../private/make-report-v102.py
#   A(新)    review-artifacts/.../private/make-minimal-diff-v102.py
# 未做 git 写操作（未 add / 未 commit / 未 push），HEAD 仍 1558342a0aec04138135a7970aa0b72bc585a9fb
#
# ── 前置态字节的诚实交代 ────────────────────────────────────────────────
# 父审记录的本文件修复前 sha256 : {RECORDED_PREFIX_SHA}
# 本文件修复后 sha256          : {sha(src_text)}
# 我尝试拿「修复前整文件字节」两条路，**都失败**，所以不产出声称字节精确的文件级 diff：
#   1) 用本轮 Edit 的 old_string 反向套回重构 -> da78580460dfc0a922da45c904faeaa9d4221d0cccd77960c94da918c4393bf2  ≠ 记录值
#   2) 从 v101 的 MINIMAL-DIFF.patch 取该文件全量原文（394 行、无尾换行），
#      四种换行变体逐一比对 -> deb3439f… / ef3bf387… / 9094f0c6… / ee6021bc…  **全部 ≠** 记录值
# ⇒ 下面第 1 段的 before 文本来自本会话 Edit 操作的**逐字记录**，**未经文件级哈希验证**；
#   after 文本则是从磁盘现读切片，**必然**与当前文件一致。
#
# ── 语义说明 ────────────────────────────────────────────────────────────
# 旧：`grammar === undefined` —— 对**直接索引**的结果判空。
#     但 EXPORT_FIELD_ALLOWLIST 是普通对象字面量，`['constructor']` 取到 `Object` 函数、
#     `['toString']` 取到函数、`['__proto__']` 取到原型对象，**都不是 undefined**，穿过检查后
#     `grammar.test(...)` 抛 `grammar.test is not a function`（父审 08:34:17 UTC，PID 5260 exit 1）。
# 新：先用 `Object.prototype.hasOwnProperty.call` 把**取值本身**关进三元，非自有 ⇒ undefined ⇒ 丢弃，
#     再由 `=== undefined` 收窄类型。
#     运行时语义与「hasOwnProperty 判否即丢弃」**完全相同**。
#     **刻意不写成** `if (!hasOwnProperty(...)) continue;`：该写法在 checkJs 下不做类型收窄，
#     typecheck:desktop 实测报 TS18048 `'grammar' is possibly 'undefined'`，而本仓禁用 `!`/`@ts-ignore`/放宽 tsconfig。

# ═══════════════════════════════════════════════════════════════════════
# 1/2  源码侧（apps/desktop/lib/log-export.cjs）—— 唯一改动点
# ═══════════════════════════════════════════════════════════════════════
{src_hunk}
# ═══════════════════════════════════════════════════════════════════════
# 2/2  测试侧（apps/desktop/lib/__tests__/log-export.test.mjs）
# ═══════════════════════════════════════════════════════════════════════

# --- require 解构里多一个 EXPORT_FIELD_ALLOWLIST（供「承重性对照」用例直接取旧判定的取值）---
--- before
{require_old}--- after
{require_new}

# --- 文件末尾追加以下 6 条用例（现读自磁盘，逐字）---
"""

OUT.write_text(body + test_tail, encoding="utf-8")
print(f"AFTER_SRC_SHA256={sha(src_text)}")
print(f"AFTER_TEST_SHA256={sha(test_text)}")
print(f"DIFF_WRITTEN={OUT}")
print(f"DIFF_BYTES={OUT.stat().st_size}")