$ErrorActionPreference = 'Stop'
# RA-09 跨进程重启承接探针 runner。
#
# 步骤：前置断言 → 打包子进程（产物只落 os.tmpdir()）→ 跑 vitest → 分类。
#
# 前置断言沿用既有口径：**只抓 git 未跟踪的新增文件**，不按文件名模糊全树扫。
# 上一版按 `*probe*` 扫全树，把已跟踪且未修改的产品文件 capability-probe.ts 误报成残留，
# 守卫自己假红比没守卫更糟。

$repoRoot = 'G:/zcode-project/zcode-companion'
$privateDir = "$repoRoot/review-artifacts/ra09-crossproc-restart-v96-audit-20261007/private"

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

# 子进程产物：打包输出目录只落 os.tmpdir()，绝不进正式源码目录。
$buildOut = Join-Path ([System.IO.Path]::GetTempPath()) ("zcc-xproc-build-" + [guid]::NewGuid().ToString('N'))
$buildLog = & node "$privateDir/build-child.mjs" "$privateDir/crossproc-child.ts" $buildOut 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Output 'CHILD_BUILD_FAILED'
    $buildLog | ForEach-Object { Write-Output $_ }
    exit 3
}
$bundle = "$buildOut/crossproc-child.mjs"
if (-not (Test-Path $bundle)) {
    Write-Output "CHILD_BUNDLE_MISSING $bundle"
    exit 3
}
Write-Output "CHILD_BUNDLE_BYTES=$((Get-Item $bundle).Length)"
$env:ZCC_CP_BUNDLE = $bundle

$vitest = "$repoRoot/node_modules/vitest/vitest.mjs"
$config = "$privateDir/vitest.crossproc.config.mts"

# 注意：这里是赋值不是管道，$LASTEXITCODE 才不会被吞。
$out = & node $vitest run --config $config 2>&1
$code = $LASTEXITCODE

$out | ForEach-Object { $_ }

$raw = ($out | Out-String)

# 汇总行取数，不用 ✓ 计数：默认 reporter 只在失败时逐条列用例名。
$testsLine = [regex]::Match($raw, '(?m)^\s*Tests\s+(.+)$')
$testsSummary = if ($testsLine.Success) { $testsLine.Groups[1].Value } else { '' }
$passLines = if ($testsSummary -match '(\d+)\s+passed') { [int]$Matches[1] } else { 0 }
$failLines = if ($testsSummary -match '(\d+)\s+failed') { [int]$Matches[1] } else { 0 }
$ranAny = $testsLine.Success

# 「零 FAIL 行 + 非零退出」= 根本没跑起来，必须单独归类，
# 否则会把 DID-NOT-RUN 误报成「断言抓到了问题」。
if ($code -eq 0 -and $ranAny -and $failLines -eq 0 -and $passLines -gt 0) {
    $class = 'all_passed'
} elseif (-not $ranAny -and ($raw -match 'no tests' -or $raw -match 'ERR_MODULE_NOT_FOUND' -or $raw -match 'Cannot find module' -or $raw -match 'Failed to load')) {
    $class = 'import_failed'
} elseif (-not $ranAny) {
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