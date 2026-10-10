$ErrorActionPreference = 'Stop'
# 把私有探针挂到 apps/ui/src 下（官方 vitest.config include 只有 src/**/*.test.ts）
$probeSrc = 'G:/zcode-project/zcode-companion/review-artifacts/ra08-sameid-audit-20261007/private/ra08-sameid.probe.test.ts'
$link = 'G:/zcode-project/zcode-companion/apps/ui/src/__ra08sameid.probe.test.ts'
Copy-Item -LiteralPath $probeSrc -Destination $link -Force

# vitest 5.0.2 在**仓库根** node_modules，不在 apps/ui（实测：apps/ui/node_modules/vitest 不存在）
$vitest = 'G:/zcode-project/zcode-companion/node_modules/vitest/vitest.mjs'

$out = & node $vitest run --config 'G:/zcode-project/zcode-companion/review-artifacts/ra08-sameid-audit-20261007/private/vitest.dom.config.mts' '__ra08sameid.probe.test.ts' 2>&1
$code = $LASTEXITCODE

Remove-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue

$out | ForEach-Object { $_ }

# 分类必须看**实际输出**，不能只看退出码：vitest 的 import 失败与断言失败都可能 exit=1。
$raw = ($out | Out-String)
if ($code -eq 0) {
  $class = 'all_passed'
} elseif ($raw -match 'no tests' -or $raw -match 'ERR_MODULE_NOT_FOUND' -or $raw -match 'Cannot find module' -or $raw -match 'Failed to load' -or $raw -match 'Error: Cannot find') {
  $class = 'import_failed'
} elseif ($raw -match 'AssertionError' -or $raw -match 'Tests\s+\d+\s+failed' -or $raw -match 'expected') {
  $class = 'assertion_failed'
} else {
  $class = 'other_failure'
}

Write-Output "VITEST_EXIT=$code"
Write-Output "CLASS=$class"
exit $code