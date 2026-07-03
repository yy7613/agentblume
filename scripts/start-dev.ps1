[CmdletBinding()]
param(
  [ValidateSet('local', 'team', 'test')]
  [string]$Profile = 'local',

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

$targets = @()
if (-not $UiOnly) {
  $targets += [pscustomobject]@{
    Name = 'api'
    Arguments = 'run serve'
    Environment = @{
      AGENTCONTEXT_PROFILE = $Profile
    }
  }
}

if (-not $ApiOnly) {
  $targets += [pscustomobject]@{
    Name = 'ui'
    Arguments = 'run dev:ui'
    Environment = @{}
  }
}

if ($DryRun) {
  foreach ($target in $targets) {
    Write-Host "$($target.Name): $npmPath $($target.Arguments)"
  }
  exit 0
}

Write-Host "Repo root: $repoRoot"
Write-Host "Profile : $Profile"
if (-not $UiOnly) {
  Write-Host 'API     : http://127.0.0.1:3030/health'
}
if (-not $ApiOnly) {
  Write-Host 'UI      : http://127.0.0.1:5173'
}
Write-Host 'Ctrl+C で起動したプロセスを停止します。'

$started = @()
$exitCode = 0

try {
  foreach ($target in $targets) {
    $started += Start-LoggedProcess -Name $target.Name -Arguments $target.Arguments -Environment $target.Environment
  }

  while ($true) {
    foreach ($entry in $started) {
      if ($entry.Process.HasExited) {
        if ($entry.Process.ExitCode -ne 0) {
          Write-Warning "$($entry.Name) が終了しました (exit=$($entry.Process.ExitCode))。"
          $exitCode = $entry.Process.ExitCode
        } else {
          Write-Host "$($entry.Name) が終了しました。"
        }
        return
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
