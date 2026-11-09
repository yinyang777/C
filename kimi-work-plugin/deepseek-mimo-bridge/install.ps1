<#
.SYNOPSIS
  安装 / 更新 / 卸载 deepseek-mimo-bridge。

.DESCRIPTION
  两个宿主走的是两套不同机制：
    Kimi Work —— 用 Kimi 自带的 Plugin Builder 登记脚本写入「个人插件市场」
                 （daimon/plugin-market/personal/<id>.json）；登记后到「插件 → 个人」
                 点 + 安装，daemon 热重载，无需重启。
    Kimi Code —— 复制到托管插件目录并写入 plugins/installed.json（严格 JSON、无 BOM）。

  脚本不改任何 Kimi 配置，只做复制/登记；installed.json 改动前会自动备份。

.PARAMETER Target
  work | code | both（默认 both）

.PARAMETER Uninstall
  撤销个人市场登记 / 移除托管副本。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Target both
#>
param(
  [ValidateSet('work', 'code', 'both')]
  [string]$Target = 'both',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$PluginId = 'deepseek-mimo-bridge'
$Source = $PSScriptRoot
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

$ShareDir = Join-Path $env:APPDATA 'kimi-desktop\daimon-share'
$WorkHome = Join-Path $ShareDir 'daimon\runtime\kimi-code\home'
$CodeHome = Join-Path $env:USERPROFILE '.kimi-code'
$Builder = Join-Path $ShareDir 'daimon\skills\plugin-builder\scripts\register_personal.py'
$DaimonBin = Join-Path $env:APPDATA 'kimi-desktop\daimon-bundle\bin\kimi-daimon.cmd'
$MarketEntry = Join-Path $ShareDir "daimon\plugin-market\personal\$PluginId.json"

# Kimi 宿主严格解析 JSON：installed.json 带 UTF-8 BOM 会让插件页整个列表读不出来
# （报错 `Unexpected token '﻿'`）。所有写入必须无 BOM。
function Read-JsonFile {
  param([string]$Path)
  $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
  return ($text.TrimStart([char]0xFEFF) | ConvertFrom-Json)
}
function Write-JsonFileNoBom {
  param([string]$Path, $Object)
  $json = $Object | ConvertTo-Json -Depth 10
  [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Install-Work {
  if (-not (Test-Path $Builder)) {
    throw "找不到 Kimi Work 的插件登记脚本：$Builder（客户端版本过旧，或未安装 Kimi Work）"
  }
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { throw 'PATH 上找不到 node，Kimi 的插件登记需要它' }

  & python $Builder $Source --share-dir $ShareDir --daimon-bin $DaimonBin --node $node --confirm-rights
  if ($LASTEXITCODE -ne 0) { throw "登记到个人插件市场失败（exit $LASTEXITCODE）" }

  Write-Host '[Kimi Work] 已登记到个人插件市场' -ForegroundColor Green
  Write-Host "           目录：$MarketEntry"
  Write-Host '           下一步：打开 Kimi Work → 插件 → 个人 → 点 + 安装（无需重启）'
}

function Install-Code {
  $pluginsDir = Join-Path $CodeHome 'plugins'
  $managedDir = Join-Path $pluginsDir "managed\$PluginId"
  $installedFile = Join-Path $pluginsDir 'installed.json'

  New-Item -ItemType Directory -Force -Path $managedDir | Out-Null
  Get-ChildItem $managedDir -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $Source '*') $managedDir -Recurse -Force
  foreach ($skip in @('config.json', 'node_modules', '.git')) {
    $p = Join-Path $managedDir $skip
    if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }
  }

  New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null
  if (Test-Path $installedFile) {
    Copy-Item $installedFile "$installedFile.bak-$Stamp" -Force
    $doc = Read-JsonFile -Path $installedFile
  } else {
    $doc = [pscustomobject]@{ version = 1; plugins = @() }
  }
  $now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  $existing = @($doc.plugins | Where-Object { $_.id -eq $PluginId })
  $entry = [pscustomobject]@{
    id             = $PluginId
    root           = $managedDir
    source         = 'local-path'
    enabled        = $true
    installedAt    = if ($existing.Count -gt 0 -and $existing[0].installedAt) { $existing[0].installedAt } else { $now }
    updatedAt      = $now
    originalSource = $Source
  }
  $doc.plugins = @(@($doc.plugins | Where-Object { $_.id -ne $PluginId }) + $entry)
  Write-JsonFileNoBom -Path $installedFile -Object $doc
  Write-Host "[Kimi Code] 已安装到 $managedDir" -ForegroundColor Green
}

function Uninstall-Work {
  if (Test-Path $MarketEntry) {
    Copy-Item $MarketEntry "$MarketEntry.bak-$Stamp" -Force
    Remove-Item $MarketEntry -Force
    Write-Host '[Kimi Work] 已撤销个人市场登记' -ForegroundColor Yellow
  } else {
    Write-Host '[Kimi Work] 没有找到个人市场登记项（可能已卸载）' -ForegroundColor Yellow
  }
  $installedFile = Join-Path $WorkHome 'plugins\installed.json'
  $managedDir = Join-Path $WorkHome "plugins\managed\$PluginId"
  if (Test-Path $managedDir) { Remove-Item $managedDir -Recurse -Force }
  if (Test-Path $installedFile) {
    Copy-Item $installedFile "$installedFile.bak-$Stamp" -Force
    $doc = Read-JsonFile -Path $installedFile
    $doc.plugins = @($doc.plugins | Where-Object { $_.id -ne $PluginId })
    Write-JsonFileNoBom -Path $installedFile -Object $doc
  }
}

function Uninstall-Code {
  $installedFile = Join-Path $CodeHome 'plugins\installed.json'
  $managedDir = Join-Path $CodeHome "plugins\managed\$PluginId"
  if (Test-Path $managedDir) { Remove-Item $managedDir -Recurse -Force }
  if (Test-Path $installedFile) {
    Copy-Item $installedFile "$installedFile.bak-$Stamp" -Force
    $doc = Read-JsonFile -Path $installedFile
    $doc.plugins = @($doc.plugins | Where-Object { $_.id -ne $PluginId })
    Write-JsonFileNoBom -Path $installedFile -Object $doc
  }
  Write-Host '[Kimi Code] 已移除' -ForegroundColor Yellow
}

try {
  if ($Uninstall) {
    if ($Target -in @('work', 'both')) { Uninstall-Work }
    if ($Target -in @('code', 'both')) { Uninstall-Code }
  } else {
    if ($Target -in @('work', 'both')) { Install-Work }
    if ($Target -in @('code', 'both')) { Install-Code }
    Write-Host ''
    Write-Host '自检：node .\test\mcp-smoke.mjs' -ForegroundColor Cyan
  }
} catch {
  Write-Host "失败：$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
