"""静态对照（只读，不改任何文件）：确认两域隔离的实现依据仍然成立。

这是**二阶佐证**，不是行为断言。行为权威是挂载探针的三条用例。
"""
import hashlib

ABS = r"G:\zcode-project\zcode-companion\apps\ui\src\data\modelSource.ts"
raw = open(ABS, "rb").read()
s = raw.decode("utf-8")

print("SHA256=" + hashlib.sha256(raw).hexdigest())
# key 命名空间分离：手工 manual:m{n} vs 来源 source:{modelId}
print("HAS_manual_key=", "manual:m" in s)
print("HAS_source_key=", "source:" in s)
# 展示面按 mode 二选一，不合并
print("HAS_activeEntries_ternary=",
      "state.mode === 'manual' ? state.manualEntries : state.refresh.entries" in s)
print("HAS_merged_domains=",
      ("manualEntries.concat" in s)
      or ("[...state.refresh.entries, ...state.manualEntries]" in s)
      or ("state.refresh.entries.concat" in s))
# delta 只比来源域
print("HAS_delta_only_source=", "listDelta(state.entries, parsed.entries)" in s)
# 删除只 filter 手工域
print("HAS_remove_filter_manual_only=",
      "state.manualEntries.filter((e) => e.key !== key)" in s)
print("HAS_remove_touches_refresh=", "entries:" in s.split("export function removeManualEntry")[1].split("}")[0])