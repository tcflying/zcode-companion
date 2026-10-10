$ErrorActionPreference = 'Stop'
# RA-09 packages/api journal 联动探针 runner。
#
# 前置断言：正式源码目录里**不得**出现任何本轮探针产物。
# 探针只在 review-artifacts 下跑（config 的 include 用绝对路径指向它），
# 所以这条断言是「配置有没有按约定生效」的真实检查，不是走过场。

$repoRoot = 'G:/zcode-project/zcode-companion'

# 判定口径：**只抓 git 未跟踪的新增文件**，不按文件名模糊扫。
# 上一版用 `*probe*` 全树扫，结果把既有产品文件
# packages/runtime/src/capability-probe.ts 误报成残留——那是**已跟踪且未修改**的产品文件，
# 不是本轮写入。守卫自己假红比没守卫更糟。
$status = @(git -C $repoRoot status --porcelain --untracked-files=all)
if ($LASTEXITCODE -ne 0) {
    Write-Output 'GIT_STATUS_FAILED'
    exit 2
}
$stray = @($status | Where-Object {
    $_ -match '^\?\?' -and $_ -match 'probe' -and $_ -match '(packages/|apps/)'
})
Write-Output "STRAY_PROBE_FILES_IN_FORMAL_SRC=$($stray.Count)"
if ($stray.Count -gt 0) {
    $stray | ForEach-Object { Write-Output $_ }
    exit 2
}

# vitest 5.0.2 在**仓库根** node_modules，不在 apps/ui/node_modules
$vitest = "$repoRoot/node_modules/vitest/vitest.mjs"
$config = "$repoRoot/review-artifacts/ra09-api-journal-audit-20261007/private/vitest.api.config.mts"

# 注意：这里是赋值不是管道，$LASTEXITCODE 才不会被吞。
$out = & node $vitest run --config $config 2>&1
$code = $LASTEXITCODE

$out | ForEach-Object { $_ }

$raw = ($out | Out-String)

# 从 vitest 的 `Tests  a failed | b passed | c skipped (n)` 汇总行取数，
# 不用 ✓ 计数：默认 reporter 只在失败时逐条列用例名，绿的时候根本没有 ✓ 行。
$testsLine = [regex]::Match($raw, '(?m)^\s*Tests\s+(.+)$')
$testsSummary = if ($testsLine.Success) { $testsLine.Groups[1].Value } else { '' }
$passLines = if ($testsSummary -match '(\d+)\s+passed') { [int]$Matches[1] } else { 0 }
$failLines = if ($testsSummary -match '(\d+)\s+failed') { [int]$Matches[1] } else { 0 }
$ranAny = $testsLine.Success

# 分类必须看**实际输出**：vitest 的 import 失败与断言失败都可能 exit=1。
# 尤其注意「零 FAIL 行 + 非零退出」= 根本没跑起来，必须单独归类，
# 否则会把 DID-NOT-RUN 误报成「断言抓到了问题」。
if ($code -eq 0 -and $ranAny -and $failLines -eq 0 -and $passLines -gt 0) {
    $class = 'all_passed'
} elseif (-not $ranAny -and ($raw -match 'no tests' -or $raw -match 'ERR_MODULE_NOT_FOUND' -or $raw -match 'Cannot find module' -or $raw -match 'Failed to load')) {
    $class = 'import_failed'
} elseif (-not $ranAny) {
    # 有进程退出码却没有 Tests 汇总行：什么都没跑起来，绝不能当成「断言抓到了问题」
    $class = 'did_not_run'
} elseif ($raw -match 'AssertionError' -or $failLines -gt 0 -or $raw -match 'expected') {
    $class = 'assertion_failed'
} else {
    $class = 'other_failure'
}

Write-Output "VITEST_EXIT=$code"
Write-Output "CLASS=$class"
Write-Output "TESTS_SUMMARY=$testsSummary"
Write-Output "PASS_LINES=$passLines"
Write-Output "FAIL_LINES=$failLines"
exit $code