# 准备本工程的开发工具链（Node 22 LTS）
#
# 用途：本机没有全局 node/npm 时，把 Node 准备好给构建使用。
# 已存在则直接退出。整个 .tools 目录都在 .gitignore 中，不入库。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\setup-toolchain.ps1
#   # 已有 Node 解压包（免联网）：
#   powershell -ExecutionPolicy Bypass -File scripts\setup-toolchain.ps1 -SourceDir "D:\somewhere\node-v22.23.3-win-x64"
#
# 注意：.tools\node 允许是指向别处工具链的目录联接（junction）。
# 参考工程被移动/删除后会变成「断链」，此时 Test-Path 为假，本脚本会重新准备。
# 摘链接一律走 rmdir —— 绝不能用 Remove-Item -Recurse，那会顺着链接删掉目标里的真实文件。

[CmdletBinding()]
param(
  [string]$Version = '22.23.3',
  [string]$Mirror = 'https://npmmirror.com/mirrors/node',
  [string]$SourceDir = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$toolsDir = Join-Path $root '.tools'
$targetDir = Join-Path $toolsDir 'node'
$nodeExe = Join-Path $targetDir 'node.exe'

function Remove-NodeTarget {
  param([string]$Dir)
  if (-not (Test-Path $Dir)) { return }
  $item = Get-Item $Dir -Force -ErrorAction SilentlyContinue
  if ($item -and $item.LinkType) {
    # 链接（junction/symlink）：只摘链接，不动目标
    cmd /c rmdir "$Dir" | Out-Null
  } else {
    Remove-Item $Dir -Recurse -Force
  }
}

if (Test-Path $nodeExe) {
  Write-Host "工具链已就绪：$nodeExe"
  & $nodeExe -v
  exit 0
}

New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null

# 免联网路径：链接到已有的 Node 解压目录
if ($SourceDir) {
  $src = Join-Path $SourceDir 'node.exe'
  if (-not (Test-Path $src)) { throw "SourceDir 里找不到 node.exe：$SourceDir" }
  Remove-NodeTarget $targetDir
  New-Item -ItemType Junction -Path $targetDir -Target $SourceDir | Out-Null
  Write-Host "已链接到现有工具链：$SourceDir"
  & $nodeExe -v
  exit 0
}

$arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
$asset = "node-v$Version-win-$arch.zip"
$url = "$Mirror/v$Version/$asset"

$zip = Join-Path $toolsDir $asset
$tmp = Join-Path $toolsDir "extract-$([guid]::NewGuid().ToString('N').Substring(0,8))"

Write-Host "下载 $url"
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

Write-Host "解压到 $tmp"
Expand-Archive -Path $zip -DestinationPath $tmp -Force

$inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
if (-not $inner) { throw '解压结果异常：找不到 Node 目录' }

Remove-NodeTarget $targetDir
Move-Item -Path $inner.FullName -Destination $targetDir
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $zip -Force -ErrorAction SilentlyContinue

Write-Host "完成：$nodeExe"
& $nodeExe -v
