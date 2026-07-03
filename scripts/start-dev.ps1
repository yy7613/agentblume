[CmdletBinding()]
param(
  [ValidateSet('local', 'test')]
  [string]$Profile = 'local',

  [ValidateRange(1, 65535)]
  [int]$ApiPort = 3030,

  [ValidateRange(1, 65535)]
  [int]$UiPort = 5173,

  [switch]$ApiOnly,

  [switch]$UiOnly,

  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($ApiOnly -and $UiOnly) {
  throw 'ApiOnly と UiOnly は同時に指定できません。'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$packageJsonPath = Join-Path $repoRoot 'package.json'

if (-not (Test-Path -LiteralPath $packageJsonPath)) {
  throw "package.json が見つかりません: $packageJsonPath"
}

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) {
  $npmCommand = Get-Command npm -ErrorAction Stop
}
$npmPath = $npmCommand.Source

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules'))) {
  Write-Warning 'node_modules が見つかりません。必要なら先に npm install を実行してください。'
}

function Start-LoggedProcess {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,

    [Parameter(Mandatory = $true)]
    [string]$Arguments,

    [hashtable]$Environment = @{}
  )

  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $npmPath
  $psi.Arguments = $Arguments
  $psi.WorkingDirectory = $repoRoot
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true

  foreach ($pair in $Environment.GetEnumerator()) {
    $psi.Environment[$pair.Key] = [string]$pair.Value
  }

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $psi
  $process.EnableRaisingEvents = $true

  if (-not $process.Start()) {
    throw "$Name の起動に失敗しました。"
  }

  $subscriptions = @(
    (Register-ObjectEvent -InputObject $process -EventName OutputDataReceived -MessageData @{ Name = $Name } -Action {
      if ($EventArgs.Data) {
        Write-Host "[$($event.MessageData.Name)] $($EventArgs.Data)"
      }
    }),
    (Register-ObjectEvent -InputObject $process -EventName ErrorDataReceived -MessageData @{ Name = $Name } -Action {
      if ($EventArgs.Data) {
        Write-Host "[$($event.MessageData.Name)][err] $($EventArgs.Data)" -ForegroundColor Red
      }
    })
  )

  $process.BeginOutputReadLine()
  $process.BeginErrorReadLine()

  [pscustomobject]@{
    Name = $Name
    Process = $process
    Subscriptions = $subscriptions
  }
}

function Stop-LoggedProcess {
  param(
    [Parameter(Mandatory = $true)]
    $Entry
  )

  foreach ($subscription in $Entry.Subscriptions) {
    if ($null -ne $subscription) {
      Unregister-Event -SubscriptionId $subscription.Id -ErrorAction SilentlyContinue
      Remove-Job -Id $subscription.Id -Force -ErrorAction SilentlyContinue
    }
  }

  if (-not $Entry.Process.HasExited) {
    $Entry.Process.Kill($true)
    $null = $Entry.Process.WaitForExit(5000)
  }

  $Entry.Process.Dispose()
}

function Get-PortOwnerLabel {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Port
  )

  $connection = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -eq $connection) {
    return $null
  }

  $owner = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
  if ($null -eq $owner) {
    return "PID $($connection.OwningProcess)"
  }
  return "PID $($owner.Id) ($($owner.ProcessName))"
}

function Assert-PortAvailable {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,

    [Parameter(Mandatory = $true)]
    [int]$Port,

    [Parameter(Mandatory = $true)]
    [string]$OverrideParameter
  )

  $owner = Get-PortOwnerLabel -Port $Port
  if ($null -ne $owner) {
    throw "$Name ポート $Port は使用中です: $owner。既存プロセスを停止するか、-$OverrideParameter で別ポートを指定してください。"
  }
}

$targets = @()
if (-not $UiOnly) {
  $targets += [pscustomobject]@{
    Name = 'api'
    Arguments = 'run serve'
    Environment = @{
      AGENTCONTEXT_PROFILE = $Profile
      AGENTCONTEXT_PORT = $ApiPort
      NO_COLOR = '1'
      FORCE_COLOR = '0'
    }
  }
}

if (-not $ApiOnly) {
  $targets += [pscustomobject]@{
    Name = 'ui'
    Arguments = "run dev:ui -- --port $UiPort --strictPort"
    Environment = @{
      AGENTCONTEXT_API_URL = "http://127.0.0.1:$ApiPort"
      NO_COLOR = '1'
      FORCE_COLOR = '0'
    }
  }
}

if ($DryRun) {
  foreach ($target in $targets) {
    if ($target.Name -eq 'api') {
      Write-Host "api: AGENTCONTEXT_PROFILE=$Profile AGENTCONTEXT_PORT=$ApiPort $npmPath $($target.Arguments)"
    } else {
      Write-Host "ui: AGENTCONTEXT_API_URL=http://127.0.0.1:$ApiPort $npmPath $($target.Arguments)"
    }
  }
  exit 0
}

if (-not $UiOnly) {
  Assert-PortAvailable -Name 'API' -Port $ApiPort -OverrideParameter 'ApiPort'
}
if (-not $ApiOnly) {
  Assert-PortAvailable -Name 'UI' -Port $UiPort -OverrideParameter 'UiPort'
}

Write-Host "Repo root: $repoRoot"
Write-Host "Profile : $Profile"
if (-not $UiOnly) {
  Write-Host "API     : http://127.0.0.1:$ApiPort/health"
}
if (-not $ApiOnly) {
  Write-Host "UI      : http://127.0.0.1:$UiPort"
}
Write-Host 'Ctrl+C で起動したプロセスを停止します。'

$started = @()
$exitCode = 0

try {
  foreach ($target in $targets) {
    $started += Start-LoggedProcess -Name $target.Name -Arguments $target.Arguments -Environment $target.Environment
  }

  :monitor while ($true) {
    foreach ($entry in $started) {
      if ($entry.Process.HasExited) {
        if ($entry.Process.ExitCode -ne 0) {
          Write-Warning "$($entry.Name) が終了しました (exit=$($entry.Process.ExitCode))。"
          $exitCode = $entry.Process.ExitCode
        } else {
          Write-Host "$($entry.Name) が終了しました。"
        }
        break monitor
      }
    }

    Start-Sleep -Milliseconds 500
  }
}
finally {
  foreach ($entry in $started) {
    Stop-LoggedProcess -Entry $entry
  }
}

exit $exitCode
