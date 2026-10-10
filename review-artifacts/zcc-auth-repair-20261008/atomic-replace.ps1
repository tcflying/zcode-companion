# ZCC-AUTH-20261008 原子替换 helper（PowerShell 7）
# 契约：参数只有路径，不含任何配置值/密钥。
#  - 用 Get-Acl 的 Sddl 在子进程内只输出**相等 bool**，不 dump ACL
#  - temp 与原 ACL 不等 -> 不 rename，返回 ACL_MATCH=false，调用方必须中止
#  - mode 不等 -> 不 rename
#  - rename 失败 -> 保留 temp，返回确切路径，不退化 truncate、不永久删除
# 输出：单个 JSON 对象（仅 bool、路径、exit 语义），无 secret。
param(
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [Parameter(Mandatory = $true)][string]$TempPath,
  [Parameter(Mandatory = $true)][string]$ExpectedBeforeSha256
)

$ErrorActionPreference = 'Stop'
$result = [ordered]@{
  schema            = 'zcc-atomic-replace/1'
  task              = 'ZCC-AUTH-20261008'
  aclMatch          = $false
  modeMatch         = $false
  casMatch          = $false
  renamed           = $false
  tempPreservedPath = $null
  error             = $null
}

try {
  # 1) CAS：落盘前目标必须仍是同一份 bytes
  $beforeHash = (Get-FileHash -LiteralPath $ConfigPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $result.casMatch = ($beforeHash -eq $ExpectedBeforeSha256)
  if (-not $result.casMatch) {
    $result.error = 'CAS_MISMATCH'
    $result.tempPreservedPath = $TempPath
  }
  else {
    # 2) mode 比对（POSIX 位；Windows 上通常等价于只读位，单独记录）
    $cfgItem  = Get-Item -LiteralPath $ConfigPath
    $tmpItem  = Get-Item -LiteralPath $TempPath
    $result.modeMatch = ($cfgItem.Mode -eq $tmpItem.Mode)

    # 3) 真实 ACL 比对：只在子进程内比较 Sddl，只出 bool
    $cfgSddl = (Get-Acl -LiteralPath $ConfigPath).Sddl
    $tmpSddl = (Get-Acl -LiteralPath $TempPath).Sddl
    $result.aclMatch = ($cfgSddl -eq $tmpSddl)

    if ($result.modeMatch -and $result.aclMatch) {
      # 4) 再次 CAS，紧贴 rename
      $preHash = (Get-FileHash -LiteralPath $ConfigPath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($preHash -eq $ExpectedBeforeSha256) {
        # 5) 原子替换：Move-Item -Force 在同卷内走 rename 替换
        [System.IO.File]::Replace($TempPath, $ConfigPath, $null) 2>$null
        if (-not $?) {
          Move-Item -LiteralPath $TempPath -Destination $ConfigPath -Force
        }
        $result.renamed = $true
      }
      else {
        $result.error = 'CAS_MISMATCH_BEFORE_RENAME'
        $result.tempPreservedPath = $TempPath
      }
    }
    else {
      # 权限/ACL 不一致：绝不 rename、绝不改原文件权限、绝不删除含 secret 的 temp
      $result.error = if (-not $result.modeMatch) { 'MODE_MISMATCH' } else { 'ACL_MISMATCH' }
      $result.tempPreservedPath = $TempPath
    }
  }
}
catch {
  $result.error = "HELPER_EXCEPTION:$($_.Exception.GetType().Name)"
  $result.tempPreservedPath = $TempPath
}

$result | ConvertTo-Json -Compress -Depth 5