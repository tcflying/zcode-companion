# -*- coding: utf-8 -*-
"""精准 mutant 重跑包装器（zc51-mutant-reaudit 轮，**不含任何删除操作**）。

主线程核查意见，逐条对应：
 1) 实际测试退出状态可核查 → 原样输出 VITEST_EXIT（vitest 进程真实 returncode）。
    门禁 collector 的 exit=0 只代表「脚本跑完了」，**不代表 mutant 红了**。
 2) 明确区分「导入失败」与「断言失败」：
      CLASS=import_failed     收集阶段挂（no tests / MODULE_NOT_FOUND）→ **不是反例**
      CLASS=assertion_failed  跑起来了且有断言失败 → 这才是有效反例
      CLASS=all_passed
 3) 预期红例给出**每条失败用例的名字 + 文件 + AssertionError 首行 + Expected/Received**，
    证明是断言红而不是导入红。
 4) 只跑 mutant 这一份影子配置，**不重跑五项绿色基线**。

影子目录与临时探针的清理由调用方在本脚本之外用 mavis-trash 显式执行
（Windows 下永久删除不走 CLI），本脚本不碰删除。
"""

import hashlib
import io
import os
import re
import shutil
import subprocess
import sys
import datetime

ROOT = r"G:\zcode-project\zcode-companion"
PRIV = os.path.join(ROOT, "review-artifacts", "zc51-mutant-reaudit-20261007", "private")
SHADOW = os.path.join(ROOT, "apps", "ui", "src", "data", "__mutant_reaudit")
TMP_PROBE = os.path.join(ROOT, "apps", "ui", "src", "pages", "__zc51_mutant_reaudit2.test.ts")

ANCHOR = """  const delta: ListDelta = state.lastSuccessAt === null
    ? { added: [], removed: [], kept: 0, previous: null, current: parsed.entries.length }
    : listDelta(state.entries, parsed.entries);"""
REPLACE = "  const delta: ListDelta = listDelta([], parsed.entries);"


def sha256(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def emit(key, value):
    sys.stdout.write("%s=%s\n" % (key, value))
    sys.stdout.flush()


emit("RUN_UTC", datetime.datetime.now(datetime.timezone.utc).isoformat())
emit("PID", os.getpid())

if os.path.isdir(SHADOW):
    emit("ABORT_REASON", "shadow_dir_already_exists_needs_trash_first")
    sys.exit(4)

shutil.copytree(
    os.path.join(ROOT, "apps", "ui", "src", "data"),
    SHADOW,
    ignore=shutil.ignore_patterns("*.test.ts", "__mutant*"),
)

mutant_file = os.path.join(SHADOW, "modelSource.ts")
real_file = os.path.join(ROOT, "apps", "ui", "src", "data", "modelSource.ts")

src = io.open(mutant_file, encoding="utf-8").read()
if ANCHOR not in src:
    emit("CLASS", "anchor_not_found")
    emit("VITEST_EXIT", -99)
    sys.exit(3)

io.open(mutant_file, "w", encoding="utf-8").write(src.replace(ANCHOR, REPLACE))

emit("REAL_SHA256", sha256(real_file))
emit("MUTANT_SHA256", sha256(mutant_file))
emit("PROBE_SHA256", sha256(os.path.join(PRIV, "zc51-dom.probe.test.ts")))
emit("CONFIG_SHA256", sha256(os.path.join(PRIV, "vitest.mutant.config.mts")))

shutil.copyfile(os.path.join(PRIV, "zc51-dom.probe.test.ts"), TMP_PROBE)

cfg = os.path.join(PRIV, "vitest.mutant.config.mts").replace("\\", "/")
r = subprocess.run(
    [
        "node",
        "node_modules/vitest/vitest.mjs",
        "run",
        "--config",
        cfg,
        "src/pages/__zc51_mutant_reaudit2.test.ts",
        "--reporter=verbose",
    ],
    cwd=ROOT,
    capture_output=True,
    text=True,
    encoding="utf-8",
    errors="replace",
    timeout=600,
)
out = (r.stdout or "") + "\n" + (r.stderr or "")
io.open(os.path.join(PRIV, "mutant-raw-output-v2.txt"), "w", encoding="utf-8").write(out)

emit("VITEST_EXIT", r.returncode)
for line in out.splitlines():
    stripped = line.strip()
    if re.match(r"^(Test Files|Tests|Duration)\s", stripped):
        emit("VITEST_SUMMARY", stripped)

module_error = ("ERR_MODULE_NOT_FOUND" in out) or ("Cannot find module" in out)
no_tests = bool(re.search(r"Tests\s+no tests", out))

failed_ids = re.findall(r"^\s*[\u00d7x]\s+(src/\S+)\s+>\s+(.+?)\s+(\d+)ms\s*$", out, re.M)
n = 0
for path, name, _ms in failed_ids:
    n += 1
    idx = out.find("FAIL  " + path)
    seg = out[idx: idx + 3000] if idx >= 0 else ""
    a = re.search(r"AssertionError: (.+)", seg)
    e = re.search(r"Expected: (.+)", seg)
    g = re.search(r"Received: (.+)", seg)
    emit("FAILED_%d_CASE" % n, name)
    emit("FAILED_%d_FILE" % n, path)
    emit("FAILED_%d_ASSERT" % n, a.group(1).strip()[:200] if a else "NO_ASSERTION_ERROR_FOUND")
    emit("FAILED_%d_EXPECTED" % n, e.group(1).strip()[:120] if e else "-")
    emit("FAILED_%d_RECEIVED" % n, g.group(1).strip()[:120] if g else "-")
emit("FAILED_COUNT", n)

passed_ids = re.findall(r"^\s*\u2713\s+(src/\S+)\s+>\s+(.+?)\s+(\d+)ms\s*$", out, re.M)
p = 0
for _path, name, _ms in passed_ids:
    p += 1
    emit("PASSED_%d_CASE" % p, name)
emit("PASSED_COUNT", p)

if module_error or no_tests:
    emit("CLASS", "import_failed")
elif n > 0:
    emit("CLASS", "assertion_failed")
else:
    emit("CLASS", "all_passed")
