# ZCC-AUTH-20261008 原子替换 helper v2（PowerShell 7）
#
# 参数契约（三个参数都是路径/哈希，**都不含任何配置值或密钥**）：
#   -ConfigPath            目标 config 文件的绝对路径
#   -TempPath              同目录临时文件的绝对路径（含 secret，绝不放入 review-artifacts）
#   -ExpectedBeforeSha256  目标文件**整文件** SHA256（不是密钥 hash），用于 CAS 比对
#
# 行为硬约束：
#   - 只用 [System.IO.File]::Replace 做原子替换并保留目标 ACL；
#     **没有 Move-Item / Copy-Item 等任何 fallback**，失败即失败，不退化 truncate。
#   - 用 Get-Acl 的 Sddl 在子进程内**只输出相等 bool**，绝不 dump Sddl 内容。
#   - 写后必须复核目标 ACL/attributes 与 before 一致，不一致如实报告。
#   - 任何失败都**保留** temp（可能含 secret）并只报告其确切路径，不永久删除。
param(
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [Parameter(Mandatory = $true)][string]$TempPath,
  [Parameter(Mandatory = $true)][string]$ExpectedBeforeSha256
)

$ErrorActionPreference = 'Stop'
$result = [ordered]@{
  schema            = 'zcc-atomic-replace/2'
  task              = 'ZCC-AUTH-20261008'
  aclMatch          = $false
  attributesMatch   = $false
  casMatch          = $false
  renamed           = $false
  postAclMatch      = $false
  postAttributesMatch = $false
  tempPreservedPath = $null
  error             = $null
}

try {
  $cfgAclBefore = Get-Acl -LiteralPath $ConfigPath
  $cfgAttrsBefore = (Get-Item -LiteralPath $ConfigPath).Attributes
  $cfgSddlBefore = $cfgAclBefore.Sddl

  # 1) CAS：落盘前目标必须仍是同一份 bytes
  $beforeHash = (Get-FileHash -LiteralPath $ConfigPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $result.casMatch = ($beforeHash -eq $ExpectedBeforeSha256)
  if (-not $result.casMatch) {
    $result.error = 'CAS_MISMATCH'
    $result.tempPreservedPath = $TempPath
  }
  else {
    # 2) temp 与目标的权限/属性比对（只出 bool）
    $tmpAttrs = (Get-Item -LiteralPath $TempPath).Attributes
    $tmpSddl = (Get-Acl -LiteralPath $TempPath).Sddl
    $result.attributesMatch = ($cfgAttrsBefore -eq $tmpAttrs)
    $result.aclMatch = ($cfgSddlBefore -eq $tmpSddl)

    if (-not ($result.attributesMatch -and $result.aclMatch)) {
      # 不 rename、不改原文件 ACL、不删除含 secret 的 temp
      $result.error = if (-not $result.attributesMatch) { 'ATTRIBUTES_MISMATCH' } else { 'ACL_MISMATCH' }
      $result.tempPreservedPath = $TempPath
    }
    else {
      # 3) 紧贴 rename 再做一次 CAS
      $preHash = (Get-FileHash -LiteralPath $ConfigPath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($preHash -ne $ExpectedBeforeSha256) {
        $result.error = 'CAS_MISMATCH_BEFORE_REPLACE'
        $result.tempPreservedPath = $TempPath
      }
      else {
        # 4) 唯一路径：原子替换并保留目标 ACL。无 fallback。
        [System.IO.File]::Replace($TempPath, $ConfigPath, $null, $true)
        $result.renamed = $true

        # 5) 写后复核：目标 ACL/attributes 必须仍与 before 一致
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
catch {
  $result.error = "HELPER_EXCEPTION:$($_.Exception.GetType().Name)"
  $result.tempPreservedPath = $TempPath
}

$result | ConvertTo-Json -Compress -Depth 5