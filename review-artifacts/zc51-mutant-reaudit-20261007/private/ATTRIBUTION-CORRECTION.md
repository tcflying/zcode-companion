# mutant_runner 归因纠正（zc51-mutant-reaudit 轮）

**结论先行：上一轮报告里"S1/S2/S3 三条 AssertionError 各自是什么"是不准确的。**
本文件按**原始三个 FAIL 段**纠正，不重跑、不改旧 seal。

## 缺陷本身

`mutant_runner.py` 里这段：

```python
idx = out.find("FAIL  " + path)
seg = out[idx: idx + 3000]
```

`path` 对三条失败用例是**同一个文件** `src/pages/__zc51_mutant_reaudit2.test.ts`。
`str.find` 只返回**首次**出现位置，于是三次循环都截到**第一条** FAIL 段，
`FAILED_2_EXPECTED` / `FAILED_3_EXPECTED` 都被填成了 S1 的 `"首次读回"`。

这解释了回执里那三行一模一样的 Expected —— **不是三条用例期望相同，是提取器坏了**。

## 正确做法

按出现次序逐段推进游标，而非每次从头 find：

```python
cursor = 0
for path, name, _ms in failed_ids:
    idx = out.find("FAIL  " + path, cursor)   # 从上一段之后开始找
    if idx < 0:
        emit("FAILED_%d_SEGMENT" % n, "NOT_FOUND")
        continue
    cursor = idx + 1
    seg = out[idx: out.find("\n⎯", idx) if out.find("\n⎯", idx) > 0 else idx + 3000]
```

更稳的做法是不解析文本：让 vitest 输出 **JSON reporter**（`--reporter=json --outputFile=...`），
失败项自带 `assertionResults[].failureMessages`，逐条对应、无歧义。

## 本轮的有效结论仍然成立的部分

纠正只影响"每条用例的 Expected 具体是什么"，**不影响**这些已由原始 stdout 直接证实的事实：

- `VITEST_EXIT=1`
- `Tests  3 failed | 2 passed (5)`
- `CLASS=assertion_failed`（不是 import_failed）
- FAILED_1_CASE = S1、FAILED_2_CASE = S2、FAILED_3_CASE = S3（三条**用例名**提取正确，
  因为用例名来自 `×` 行而非 FAIL 段）
- PASSED_1 = S4 失败保留旧表、PASSED_2 = S5 未接 epoch
- 页面确实渲染出 F30 症状「与上次相比：新增 2（m1、m2），消失 0，保持 0 个，0 → 2」

**因此**：反例成立（该变异会让 S1/S2/S3 三条页面断言失败），但"三条各自的 Expected 文案"
此前是错误归因，本文件予以纠正。三条用例的真实 Expected 应分别是：

- S1 → `"首次读回"`
- S2 → `"与上次一致"`
- S3 → `"新增 0"`

（本轮不重跑，故这三条按用例内断言代码声明，而非本轮实测摘录。）

## 判据（写死，别再犯）

1. **同一文件多次失败时，禁止用 `find(固定串)` 逐条截取**——它永远返回第一段。
2. 断言类证据要**逐条对应**，一条 FAIL 段只能支撑一条用例的 Expected。
3. 解析器报错/提取不到时输出 `NOT_FOUND`，**不要用上一条的值兜底**——
   静默兜底会把提取缺陷伪装成测试结论。
4. 长期方案：改用 JSON reporter 拿结构化失败项，不解析人类可读文本。
