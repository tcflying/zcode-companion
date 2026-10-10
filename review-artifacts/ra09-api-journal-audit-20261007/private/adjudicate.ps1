param(
    [Parameter(Mandatory = $true)][string]$RoundDir,
    [Parameter(Mandatory = $true)][string]$RepoRoot
)

# 父审 v90/v91 轮的**阻塞裁定**。
#
# 为什么要单独一个 action：全量既有套件当前**必然** exit 1（端口 8791 被主上正在
# 运行的 GUI 实例占着）。若把它作为 gate action，round 就只能记 failure，
# 而「failure」暗示产品有问题——其实问题在环境。
#
# 所以这里让本脚本**自己**跑完整套件，如实记录它的真实 exit 与失败项，再去查
# 到底谁占着端口，**自身 exit 0**：它成功地把「未满足的条件」查清楚了。
# 这样 round 里 blocked 的依据是**本轮成功读取所得的实测事实**，不是我的口头声明，
# 也不需要靠「制造一个失败命令」来满足分类。
#
# 严格不做：不杀占用进程、不改端口、不动用户设置。观测而已。

$ErrorActionPreference = 'Stop'
$vitest = Join-Path $RepoRoot 'node_modules/vitest/vitest.mjs'
$suiteOut = Join-Path $RoundDir 'full-suite-stdout.txt'

# **必须显式 `--root`**，不能依赖调用方的 cwd。
# 实测踩到：上一版没写 root，调用方 cwd 是会话工作区 zcode-dev，
# vitest 就去那里找测试，命中的是 `.superpowers/sdd/929/.../source-snapshot/`
# 下的**快照副本**，跑出「Test Files 1 failed | 1 passed (2)」——
# 拿另一个仓库的快照当本仓库的全量证据，比没有证据更糟。
$prevLocation = Get-Location
try {
    Set-Location -LiteralPath $RepoRoot
    $suiteOutput = & node $vitest run tests/unit tests/contract --root $RepoRoot --reporter=dot 2>&1
    $suiteExit = $LASTEXITCODE
} finally {
    Set-Location -LiteralPath $prevLocation
}
$suiteText = ($suiteOutput | Out-String)
[System.IO.File]::WriteAllText($suiteOut, $suiteText, (New-Object System.Text.UTF8Encoding $false))

# 失败用例名。
#
# 只认**外层**输出：先滤掉行首缩进以外的噪声，再要求文件路径以 `tests/` 开头。
# 上一版没滤，把 `gates.test.mjs` 内嵌跑 `test:unit` 时打进断言消息里的
# 快照目录路径当成了失败文件——那不是本轮的失败项。
$failing = @(
    [regex]::Matches($suiteText, '(?m)^\s*FAIL\s+(?<file>tests/[^\r\n>]+?)\s*>') |
        ForEach-Object { $_.Groups['file'].Value.Trim() } |
        Sort-Object -Unique
)

# 汇总行取**最后一条**：第一条来自 `gates.test.mjs` 断言消息里内嵌的子进程输出，
# 不是本轮全量套件自己的计数。上一版取了第一条，读数是错的。
$testsSummary = ''
$allSummary = [regex]::Matches($suiteText, '(?m)^\s*Tests\s+(.+)$')
if ($allSummary.Count -gt 0) { $testsSummary = $allSummary[$allSummary.Count - 1].Groups[1].Value.Trim() }

# ── 端口 8791 归属探测（只观测，不干预）──────────────────────────────────
$port = 8791
$listening = $false
$ownerPid = $null
$ownerName = $null
$ownerPath = $null
$ownerStart = $null

$client = New-Object System.Net.Sockets.TcpClient
try {
    $iar = $client.BeginConnect('127.0.0.1', $port, $null, $null)
    $listening = $iar.AsyncWaitHandle.WaitOne(1500, $false) -and $client.Connected
    if ($listening) { $client.EndConnect($iar) }
} catch {
    $listening = $false
} finally {
    $client.Close()
}

if ($listening) {
    $conns = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    if ($conns.Count -gt 0) {
        $ownerPid = $conns[0].OwningProcess
        $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
        if ($null -ne $proc) {
            $ownerName = $proc.ProcessName
            $ownerPath = $proc.Path
            $ownerStart = $proc.StartTime.ToUniversalTime().ToString('o')
        }
    }
}

# 端口 8791 唯一在意的断言文件（该用例自己写着「只探测不绑定」）
$portTest = 'tests/unit/official-tap-fidelity.test.mjs'
# `gates.test.mjs` 的断言是「test:unit 必须 exit 0」，所以端口那条红了它必然跟着红，
# 是**级联**，不是第二个独立问题。
$cascadeTest = 'tests/contract/gates.test.mjs'

$unexplained = @($failing | Where-Object { $_ -ne $portTest -and $_ -ne $cascadeTest })

$verdict = [ordered]@{
    round_note              = '全量既有套件的真实执行记录 + 端口归属实测；本 action 自身 exit 0'
    measured_utc            = (Get-Date).ToUniversalTime().ToString('o')
    full_suite_exit         = $suiteExit
    full_suite_tests_summary = $testsSummary
    full_suite_failing_files = $failing
    full_suite_unexplained_failures = $unexplained
    full_suite_stdout_path  = $suiteOut
    port_8791_listening     = $listening
    port_8791_owner_pid     = $ownerPid
    port_8791_owner_name    = $ownerName
    port_8791_owner_path    = $ownerPath
    port_8791_owner_start_utc = $ownerStart
    port_test_file          = $portTest
    cascade_test_file       = $cascadeTest
    all_failures_trace_to_port_test = ($unexplained.Count -eq 0 -and ($failing -contains $portTest))
    owner_is_packaged_gui_product = ($ownerPath -like '*win-unpacked*')
    remediation_not_taken  = '未 kill 占用进程、未改端口、未改用户设置：主上正在使用该 GUI 实例'
}

$json = $verdict | ConvertTo-Json -Depth 6
$outPath = Join-Path $RoundDir 'blocker-verdict.json'
[System.IO.File]::WriteAllText($outPath, $json, (New-Object System.Text.UTF8Encoding $false))

Write-Output "FULL_SUITE_EXIT=$suiteExit"
Write-Output "TESTS_SUMMARY=$testsSummary"
Write-Output "FAILING_FILES=$($failing -join ',')"
Write-Output "PORT_8791_LISTENING=$listening"
Write-Output "PORT_8791_OWNER=$ownerName(pid=$ownerPid)"
Write-Output "ONLY_ENV_FAILURE=$($verdict.all_failures_trace_to_port_test)"
Write-Output "WROTE=$outPath"
exit 0