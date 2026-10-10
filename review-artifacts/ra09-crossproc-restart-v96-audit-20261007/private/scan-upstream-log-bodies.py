# -*- coding: utf-8 -*-
"""RA-09「上游日志不含正文」守卫 —— 结构化读码第一版（只读，不改产品代码）。

**先读码、后断言**：守卫最容易翻车的地方不是写不出正则，而是拿一条
「看起来对」的规则去卡正常代码。所以这一版**只做清点**：把 server.ts 里
所有 logger 调用连同实参原样列出来，由人眼确认哪条是真风险，再据此写断言。

**必须先剔除注释与字符串字面量**，否则 UI 文案里的 'message'/'content'
会被当成实参（v101 起在 happy-dom 静态断言上踩过同一类坑：假红）。
"""
import re
import sys
from pathlib import Path

REPO = Path(r"G:\zcode-project\zcode-companion")
TARGETS = [
    "packages/api/src/server.ts",
    "packages/api/src/auth.ts",
    "packages/api/src/errors.ts",
    "apps/desktop/lib/journal.cjs",
    "apps/desktop/lib/log-ring.cjs",
]

BODYISH = re.compile(
    r"\b(message|content|prompt|body|text|input|question|answer|delta|chunk|payload|choices|completion)\b",
    re.I,
)
LOGGER_CALL = re.compile(r"\b(?:logger|log)\s*\.\s*(info|warn|error|debug)\s*\(")


def strip_noise(src: str) -> str:
    """剔除注释与字符串字面量，保留换行以维持行号可读性。"""
    out = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        two = src[i : i + 2]
        if two == "//":
            while i < n and src[i] != "\n":
                i += 1
        elif two == "/*":
            i += 2
            while i < n and src[i : i + 2] != "*/":
                if src[i] == "\n":
                    out.append("\n")
                i += 1
            i += 2
        elif c in "'\"`":
            quote = c
            i += 1
            while i < n and src[i] != quote:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == "\n":
                    out.append("\n")
                i += 1
            i += 1
            out.append(" ")  # 字面量整体替换成空格，**不留内容**
        else:
            out.append(c)
            i += 1
    return "".join(out)


def template_interpolations(src: str):
    """**单独**抽出模板字面量里的 `${...}` 表达式。

    为什么必须单列：strip_noise 会把整个模板字面量（含反引号内容）抹成一个空格，
    于是 `` `收到 ${userMessage}` `` 里的 `userMessage` **跟着一起消失**，
    BODYISH 自然扫不到 ⇒ 报出一个漂亮的 0。
    这正是我自己刚造出来的假绿：**只看实参标识符、不看插值**，
    等于没看见正文最可能藏的地方。插值必须单独过一遍。
    """
    out = []
    i, n = 0, len(src)
    while i < n:
        if src[i] == "`":
            i += 1
            while i < n and src[i] != "`":
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i : i + 2] == "${":
                    depth, j = 1, i + 2
                    while j < n and depth > 0:
                        if src[j] == "{":
                            depth += 1
                        elif src[j] == "}":
                            depth -= 1
                        j += 1
                    expr = src[i + 2 : j - 1]
                    out.append((src[:i].count("\n") + 1, expr.strip()))
                    i = j
                    continue
                i += 1
            i += 1
        else:
            i += 1
    return out


total_calls = 0
total_hits = 0
total_interp = 0
total_interp_hits = 0
for rel in TARGETS:
    path = REPO / rel
    if not path.exists():
        print(f"[SKIP] {rel} 不存在")
        continue
    raw = path.read_text(encoding="utf-8")
    code = strip_noise(raw)
    calls = list(LOGGER_CALL.finditer(code))
    hits = []
    for m in calls:
        depth, j = 1, m.end()
        while j < len(code) and depth > 0:
            if code[j] == "(":
                depth += 1
            elif code[j] == ")":
                depth -= 1
            j += 1
        arg = code[m.end() : j - 1].strip()
        if BODYISH.search(arg):
            hits.append((code[: m.start()].count("\n") + 1, arg[:140]))
    interps = template_interpolations(raw)
    interp_hits = [(ln, e[:140]) for ln, e in interps if BODYISH.search(e)]
    total_calls += len(calls)
    total_hits += len(hits)
    total_interp += len(interps)
    total_interp_hits += len(interp_hits)
    print(
        f"{rel}: logger_calls={len(calls)} body_like_args={len(hits)} "
        f"template_interpolations={len(interps)} body_like_interpolations={len(interp_hits)}"
    )
    for ln, a in hits:
        print(f"    ARG L{ln}: {a}")
    for ln, e in interp_hits:
        print(f"    INTERP L{ln}: {e}")

print(f"TOTAL_LOGGER_CALLS={total_calls}")
print(f"TOTAL_BODY_LIKE_ARGS={total_hits}")
print(f"TOTAL_TEMPLATE_INTERPOLATIONS={total_interp}")
print(f"TOTAL_BODY_LIKE_INTERPOLATIONS={total_interp_hits}")
sys.exit(0)