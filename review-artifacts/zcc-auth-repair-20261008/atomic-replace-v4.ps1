# ZCC-AUTH-20261008 原子替换 helper v4（PowerShell 7）
#
# 参数契约（两个路径 + 一个**整文件** SHA256；都不含任何配置值或密钥）：
#   -ConfigPath            目标 config 文件的绝对路径
#   -TempPath              同目录临时文件的绝对路径（含 secret，绝不放入 review-artifacts）
#   -ExpectedBeforeSha256  目标文件整文件 SHA256（**不是**密钥 hash），用于 CAS 比对
#
# v4 相对 v3 的唯一改动：backup 参数改用 [NullString]::Value，**不产生任何 backup 文件**。
#
# 已独立实证（无 secret 合成 fixture，%TEMP%\zcc-nullstr-*）：
#   - [File]::Replace(src, dst, $null, ...)          -> ArgumentException "The path is empty."
#     （PowerShell 把 $null 绑定成空串，选中不接受空 backupName 的重载）
#   - [File]::Replace(src, dst, [NullString]::Value, $true)
#       -> 成功；dest 内容 = src 内容；src 被消耗；**目标 ACL 保持不变**
#   因此 v4 用 NullString，不写 backup、不留含 secret 的备份副本。
#
# 硬约束（沿用 v2/v3，未放宽）：
#   - **没有** Move-Item / Copy-Item 等任何 fallback；失败即失败，不退化 truncate。
#   - Get-Acl 的 Sddl 只在子进程内比较、只输出相等 bool，绝不 dump Sddl 内容。
#   - temp 与目标 ACL 不等 -> 只报告局部事实并中止，**不 SetAcl 强行同步、不扩权限**。
#   - 写后复核目标 ACL/attributes 与 before 一致。
#   - 任何失败都保留 temp 并只报告确切路径，不永久删除含 secret 的文件。
param(
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [Parameter(Mandatory = $true)][string]$TempPath,
  [Parameter(Mandatory = $true)][string]$ExpectedBeforeSha256
)

$ErrorActionPreference = 'Stop'
$result = [ordered]@{
  schema              = 'zcc-atomic-replace/4'
  task                = 'ZCC-AUTH-20261008'
  aclMatch            = $false
  attributesMatch     = $false
  casMatch            = $false
  renamed             = $false
  postAclMatch        = $false
  postAttributesMatch = $false
  tempPreservedPath   = $null
  backupFileCreated   = $false
  error               = $null
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
    # 2) temp 与目标的属性/ACL 比对（只出 bool；不等只报告，不强行同步）
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
        # 3) 唯一替换路径：原子替换、保留目标 ACL、不产生 backup 文件
        [System.IO.File]::Replace($TempPath, $ConfigPath, [System.Management.Automation.Language.NullString]::Value, $true)
        $result.renamed = $true

        # 4) 写后复核
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