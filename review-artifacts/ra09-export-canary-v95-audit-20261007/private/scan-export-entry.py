"""RA-09 导出预览/保存入口的定位扫描（**静态**，因为要证的是"不存在"）。

为什么用静态：`929.md:874` 要求「走实际导出预览/保存」，但**该入口在产品代码里不存在**。
要证明"不存在"，扫描就是合适的工具——而"实际走一遍"在这种情形下**根本无从执行**。

扫描口径（写死在这里，便于复核）：
  - 范围：`apps/ui/src/**`、`apps/desktop/lib/**`、`apps/desktop/*.cjs`、`packages/**`
    下的 .ts/.tsx/.cjs/.mjs，**排除** `*.test.*` 与 **排除 node_modules**
    （上一版把 `apps/desktop/node_modules/**` 的 .d.ts 算了进来，
     `createObjectURL` 一度报 8 处命中，全是类型存根，差点得出"有导出"的假结论）。
  - 判据：导出/保存类浏览器与 Node 原语的出现次数。
  - 输出：JSON，含每个模式的产品代码命中数与 node_modules 命中数（后者仅作对照）。

这不是业务验收：它只回答「入口在不在」，不回答「导出会不会泄漏 canary」。
后者由 T14 用**真实 HTTP + 临时 data + 合成 canary** 单独证明。
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

REPO = Path(r"G:\zcode-project\zcode-companion")
EXTS = {".ts", ".tsx", ".cjs", ".mjs"}
PRODUCT_ROOTS = ["apps/ui/src", "apps/desktop/lib", "packages"]
PRODUCT_FILES = ["apps/desktop/main.cjs", "apps/desktop/preload.cjs"]

# 导出/保存/落地所需的**浏览器侧**原语。
# 注意 `fs_writeFile*` **不在**这张表里：产品确实在写自己的数据文件
# （settings.cjs / journal.cjs / journal-store.ts 的原子写），那是产品自身的持久化，
# 与「把内容导出给用户/外发」是两件事。把它算进判据会让结论被正常代码污染——
# 这正是本脚本第一版把 8 处正常写盘误算成「有导出」的同一个错误。
PATTERNS = {
    "createObjectURL": r"createObjectURL",
    "showSaveFilePicker": r"showSaveFilePicker",
    "download_attr": r"download\s*=",
    "new_Blob": r"\bBlob\s*\(",
    "toBlob": r"toBlob",
    "clipboard_writeText": r"clipboard\s*\.\s*writeText|\.writeText\s*\(",
}

# 仅作信息项，不参与结论。
INFORMATIONAL = {"fs_writeFile": r"writeFileSync|writeFile\s*\("}

# v96 补强：**浏览器原语全 0 并不能排除「存在导出功能」**。
# Electron 侧根本不经过 createObjectURL/showSaveFilePicker——它走 dialog.showSaveDialog、
# webContents 的 download 事件、session.download、shell.openExternal，或干脆自己 fs 写文件。
# 上一版只扫浏览器原语，得出「不存在导出入口」时**只覆盖了 web 渲染层**，
# 那个结论的覆盖面比表述看起来要窄。这里把 Electron 原语补齐，与浏览器原语同表判定。
ELECTRON_PATTERNS = {
    "electron_showSaveDialog": r"showSaveDialog",
    "electron_showOpenDialog": r"showOpenDialog",
    "electron_download_event": r"will-download|\.download\s*\(",
    "electron_openExternal": r"openExternal",
    "electron_net_upload": r"net\.request|net\.upload",
    "electron_saveDialog_message": r"defaultPath",
}

# IPC 通道名里带导出/保存/诊断字样的，按名字结构单列。
# 计数式正则答不了「这个通道是不是导出通道」，所以这里直接抽名字。
IPC_CHANNEL_RE = re.compile(r"ipc(?:Main|Renderer)\.(?:handle|on|invoke|send)\(\s*['\"]([^'\"]+)['\"]")
IPC_NAME_RE = re.compile(r"export|save|dump|diagnos|download", re.I)

# 「导出」二字在产品代码里的出现（用于人工判读是 UI 文案还是注释/关键字）
WORD = "导出"


def is_test(p: Path) -> bool:
    return ".test." in p.name


def collect(roots: list[str], explicit: list[str], include_node_modules: bool) -> list[Path]:
    out: list[Path] = []
    for r in roots:
        base = REPO / r
        if not base.exists():
            continue
        for p in base.rglob("*"):
            if p.suffix not in EXTS or not p.is_file():
                continue
            if is_test(p):
                continue
            if not include_node_modules and "node_modules" in p.parts:
                continue
            out.append(p)
    for e in explicit:
        p = REPO / e
        if p.is_file():
            out.append(p)
    return sorted(set(out))


def scan(files: list[Path]) -> dict:
    hits = {k: 0 for k in PATTERNS}
    electron_hits = {k: 0 for k in ELECTRON_PATTERNS}
    info = {k: 0 for k in INFORMATIONAL}
    word_hits: list[str] = []
    ipc_channels: set[str] = set()
    for p in files:
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for name, pat in PATTERNS.items():
            n = len(re.findall(pat, text))
            if n:
                hits[name] += n
        for name, pat in ELECTRON_PATTERNS.items():
            n = len(re.findall(pat, text))
            if n:
                electron_hits[name] += n
        for name, pat in INFORMATIONAL.items():
            n = len(re.findall(pat, text))
            if n:
                info[name] += n
        for channel in IPC_CHANNEL_RE.findall(text):
            if IPC_NAME_RE.search(channel):
                ipc_channels.add(f"{p.relative_to(REPO)}::{channel}")
        if WORD in text:
            word_hits.append(str(p.relative_to(REPO)))
    return {
        "hits": hits,
        "electron_hits": electron_hits,
        "info": info,
        "word_hits": word_hits,
        "ipc_channels": sorted(ipc_channels),
    }


def main() -> int:
    # v95b 修正：上一轮这里只 print，声明成 --artifact 的 export-entry-scan.json
    # 从未被生成，receipt 里 generated=false，gate 在 success 状态下机械拒绝
    # （gate.py:183 'old/missing artifact is not new output'）。
    # 输出路径由 argv[1] 传入且**参数化**：写死路径会在下一轮撞上
    # 「同 round 内 artifact 路径不可被后续动作改写」的坑。
    out_path = Path(sys.argv[1]).absolute() if len(sys.argv) > 1 else None
    prod = collect(PRODUCT_ROOTS, PRODUCT_FILES, include_node_modules=False)
    node = [p for p in collect(["apps/desktop/node_modules"], [], include_node_modules=True)]
    prod_scan = scan(prod)
    node_scan = scan(node)

    export_primitives_zero = all(v == 0 for v in prod_scan["hits"].values())
    electron_zero = all(v == 0 for v in prod_scan["electron_hits"].values())
    no_export_ipc = len(prod_scan["ipc_channels"]) == 0
    payload = {
        "scope": "RA-09 导出预览/保存入口定位（静态负结论）",
        "authority_note": (
            "这是静态定位，只回答「入口在不在」。导出会不会泄漏 canary 由 T14 "
            "（真实 HTTP + 临时 data + 合成 canary）单独证明，两者不可互相替代。"
        ),
        "scan_rule": {
            "roots": PRODUCT_ROOTS + PRODUCT_FILES,
            "extensions": sorted(EXTS),
            "excluded": ["*.test.*", "**/node_modules/**"],
            "note": "排除 node_modules 是必须的：上一版未排除时 createObjectURL 报 8 处，全是 @types 存根。",
        },
        "product_file_count": len(prod),
        "product_hits": prod_scan["hits"],
        "product_electron_hits": prod_scan["electron_hits"],
        "product_export_like_ipc_channels": prod_scan["ipc_channels"],
        "product_informational_not_in_verdict": prod_scan["info"],
        "export_primitives_all_zero_in_product": export_primitives_zero,
        "electron_export_primitives_all_zero_in_product": electron_zero,
        "no_export_like_ipc_channel": no_export_ipc,
        "verdict_scope": (
            "覆盖三面：浏览器渲染层原语、Electron 主进程原语、导出类 IPC 通道名。"
            "**仍不等于**「用户可达的导出路径不存在」——UI 文案拼装、fs 直接写文件再让用户自己去拿，"
            "都不在这三面的计数里。要彻底否定必须按实际 UI/IPC 链路定位。"
        ),
        "files_mentioning_导出": prod_scan["word_hits"],
        "node_modules_control": {
            "file_count": len(node),
            "hits": node_scan["hits"],
            "note": "仅作对照，证明排除 node_modules 是必要的。",
        },
        "conclusion": (
            "浏览器层与 Electron 层导出/保存类原语、以及导出类 IPC 通道名全部为 0 "
            "⇒ 在这三面的可核查范围内**没有发现导出预览/保存入口**，"
            "929.md:874 的「走实际导出预览/保存」在本候选上无从执行。"
            "（这不是「已证明不存在」：UI 文案拼装与直接 fs 写盘不在计数内。）"
            if export_primitives_zero and electron_zero and no_export_ipc
            else "存在导出/保存类调用点或导出类 IPC 通道，需人工判读是否构成用户可达的导出路径。"
        ),
    }
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if out_path is not None:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text, encoding="utf-8")
        print(f"WROTE_ARTIFACT={out_path}")
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())