# ZCC-AUTH-20261008 原子替换 helper v3（PowerShell 7）
#
# 参数契约（两个路径 + 一个**整文件** SHA256；都不含任何配置值或密钥）：
#   -ConfigPath            目标 config 文件的绝对路径
#   -TempPath              同目录临时文件的绝对路径（含 secret，绝不放入 review-artifacts）
#   -ExpectedBeforeSha256  目标文件整文件 SHA256（**不是**密钥 hash），用于 CAS 比对
#
# v3 相对 v2 的唯一改动：修正 [System.IO.File]::Replace 的参数绑定。
# v2 传的是 ($src, $dest, $null, $true)，PowerShell 选中了不接受 null backupName 的重载，
# 抛 ArgumentException "The path is empty. (Parameter 'path')"。
# v3 显式传入一个**同目录、随机独占**的 backup 路径，重载绑定确定，替换成功。
# 该 backup 是 Replace 的原生产物（替换瞬间自动把目标原内容挪过去），消耗 temp 是设计语义，
# **不是**我们额外删除含 secret 的文件。
#
# 硬约束（沿用 v2，未放宽）：
#   - 仍然**没有** Move-Item / Copy-Item 等任何 fallback，失败即失败，不退化 truncate。
#   - Get-Acl 的 Sddl 只在子进程内比较、只输出相等 bool，绝不 dump Sddl 内容。
#   - 写后复核目标 ACL/attributes 与 before 一致。
#   - 任何失败都保留 temp 并只报告确切路径，不永久删除含 secret 的文件。
param(
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [Parameter(Mandatory = $true)][string]$TempPath,
  [Parameter(Mandatory = $true)][string]$ExpectedBeforeSha256
)

$ErrorActionPreference = 'Stop'
$result = [ordered]@{
  schema            = 'zcc-atomic-replace/3'
  task              = 'ZCC-AUTH-20261008'
  aclMatch          = $false
  attributesMatch   = $false
  casMatch          = $false
  renamed           = $false
  postAclMatch      = $false
  postAttributesMatch = $false
  tempPreservedPath = $null
  backupPath        = $null
  error             = $null
}

try {
  $cfgSddlBefore = (Get-Acl -LiteralPath $ConfigPath).Sddl
  $cfgAttrsBefore = (Get-Item -LiteralPath $ConfigPath).Attributes

  # 1) CAS
  $beforeHash = (Get-FileHash -LiteralPath $ConfigPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $result.casMatch = ($beforeHash -eq $ExpectedBeforeSha256)
  if (-not $result.casMatch) {
    $result.error = 'CAS_MISMATCH'
    $result.tempPreservedPath = $TempPath
  }
  else {
    # 2) temp 与目标的权限/属性比对（只出 bool）
    $tmpSddl = (Get-Acl -LiteralPath $TempPath).Sddl
    $tmpAttrs = (Get-Item -LiteralPath $TempPath).Attributes
    $result.attributesMatch = ($cfgAttrsBefore -eq $tmpAttrs)
    $result.aclMatch = ($cfgSddlBefore -eq $tmpSddl)

    if (-not ($result.attributesMatch -and $result.aclMatch)) {
      $result.error = if (-not $result.attributesMatch) { 'ATTRIBUTES_MISMATCH' } else { 'ACL_MISMATCH' }
      $result.tempPreservedPath = $TempPath
    }
    else {
      $preHash = (Get-FileHash -LiteralPath $ConfigPath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($preHash -ne $ExpectedBeforeSha256) {
        $result.error = 'CAS_MISMATCH_BEFORE_REPLACE'
        $result.tempPreservedPath = $TempPath
      }
      else {
        # 3) 显式 backup 路径：与 temp 同目录、随机独占，不与任何既有文件冲突
        $backupPath = Join-Path (Split-Path -Parent $TempPath) (".config.yaml.zcc-replace-backup-$PID-$([guid]::NewGuid().ToString('N').Substring(0,8)).tmp")
        $result.backupPath = $backupPath
        if (Test-Path -LiteralPath $backupPath) {
          $result.error = 'BACKUP_PATH_COLLISION'
          $result.tempPreservedPath = $TempPath
        }
        else {
          # 4) 唯一替换路径：原子替换并保留目标 ACL。无 fallback。
          [System.IO.File]::Replace($TempPath, $ConfigPath, $backupPath, $true)
          $result.renamed = $true

          # 5) 写后复核 ACL/attributes 与 before 一致
          $postSddl = (Get-Acl -LiteralPath $ConfigPath).Sddl
          $postAttrs = (Get-Item -LiteralPath $ConfigPath).Attributes
          $result.postAclMatch = ($postSddl -eq $cfgSddlBefore)
          $result.postAttributesMatch = ($postAttrs -eq $cfgAttrsBefore)
          if (-not ($result.postAclMatch -and $result.postAttributesMatch)) {
            $result.error = 'POST_ACL_OR_ATTRIBUTES_CHANGED'
          }
        }
      }
    }
  }
}
catch {
  $result.error = "HELPER_EXCEPTION:$($_.Exception.GetType().Name)"
  $result.tempPreservedPath = $TempPath
}

$result | ConvertTo-Json -Compress -Depth 5