[CmdletBinding()]
param([switch]$LiveModel)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$apiPort = 3036
$uiPort = 5176
$apiUrl = "http://127.0.0.1:$apiPort"
$uiUrl = "http://127.0.0.1:$uiPort"
$started = @()

function Wait-ForHttp {
  param([Parameter(Mandatory = $true)][string]$Url)
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    try {
      $response = Invoke-WebRequest -Uri $Url -TimeoutSec 2 -ErrorAction Stop
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { return }
    }
    catch { }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "起動確認がタイムアウトしました: $Url"
}

function Stop-Tree {
  param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process)
  if (-not $Process.HasExited) {
    $Process.Kill($true)
    $null = $Process.WaitForExit(5000)
  }
  $Process.Dispose()
}

try {
  if ($LiveModel) {
    $modelConfig = Join-Path $PSScriptRoot 'lm-studio.local.ps1'
    if (-not (Test-Path -LiteralPath $modelConfig)) { throw "LM Studio設定が見つかりません: $modelConfig" }
    . $modelConfig
    $env:AGENTCONTEXT_MANUAL_LIVE = 'true'
  }
  else {
    $env:AGENTCONTEXT_MANUAL_LIVE = 'false'
  }
  $env:AGENTCONTEXT_PROFILE = if ($LiveModel) { 'local' } else { 'test' }
  $env:AGENTCONTEXT_PORT = [string]$apiPort
  $env:AGENTCONTEXT_SAMPLE_DATA = 'true'
  $api = Start-Process -FilePath $node -ArgumentList @('--experimental-sqlite', '--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/server.ts') -WorkingDirectory $repoRoot -PassThru -WindowStyle Hidden
  $started += $api

  $env:AGENTCONTEXT_API_URL = $apiUrl
  $ui = Start-Process -FilePath $node -ArgumentList @('node_modules/vite/bin/vite.js', '--port', [string]$uiPort, '--strictPort') -WorkingDirectory $repoRoot -PassThru -WindowStyle Hidden
  $started += $ui

  Wait-ForHttp "$apiUrl/health"
  Wait-ForHttp $uiUrl

  & $node 'node_modules/@playwright/test/cli.js' test --config playwright.manual.config.ts
  exit $LASTEXITCODE
}
finally {
  foreach ($process in $started) { Stop-Tree $process }
}
