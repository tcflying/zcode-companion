$ErrorActionPreference = 'Stop'
# 探针**不落盘到 apps/ui/src**：config 的 include 用绝对路径直接指向
# review-artifacts/ra09-realhook-audit-20261007/private 下的探针文件。
# 前几轮那种 Copy-Item 到 apps/ui/src/__ra*.probe.test.ts 的做法已被主线程禁止。
# 本脚本同时断言 apps/ui/src 下不产生任何 __ra* 残留。

$appsUiSrc = 'G:/zcode-project/zcode-companion/apps/ui/src'
$stray = @(Get-ChildItem -Path $appsUiSrc -Filter '__ra*' -Recurse -ErrorAction SilentlyContinue)
if ($stray.Count -gt 0) {
  Write-Output "STRAY_FILES_IN_APPS_UI_SRC=$($stray.Count)"
  $stray | ForEach-Object { Write-Output $_.FullName }
  exit 2
}
Write-Output 'STRAY_FILES_IN_APPS_UI_SRC=0'

# vitest 5.0.2 在**仓库根** node_modules
$vitest = 'G:/zcode-project/zcode-companion/node_modules/vitest/vitest.mjs'

$out = & node $vitest run --config 'G:/zcode-project/zcode-companion/review-artifacts/ra09-realhook-audit-20261007/private/vitest.dom.config.mts' 2>&1
$code = $LASTEXITCODE

$out | ForEach-Object { $_ }

# 分类必须看**实际输出**：vitest 的 import 失败与断言失败都可能 exit=1。
$raw = ($out | Out-String)
if ($code -eq 0) {
  $class = 'all_passed'
} elseif ($raw -match 'no tests' -or $raw -match 'ERR_MODULE_NOT_FOUND' -or $raw -match 'Cannot find module' -or $raw -match 'Failed to load') {
  $class = 'import_failed'
} elseif ($raw -match 'AssertionError' -or $raw -match 'Tests\s+\d+\s+failed' -or $raw -match 'expected') {
  $class = 'assertion_failed'
} else {
  $class = 'other_failure'
}

Write-Output "VITEST_EXIT=$code"
Write-Output "CLASS=$class"
exit $code