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

  [switch]$SampleData,

  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($ApiOnly -and $UiOnly) {
  throw 'ApiOnly と UiOnly は同時に指定できません。'
}

if ($IsWindows -and -not ('NativeJobObject' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class NativeJobObject
{
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public IntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    public const int JobObjectExtendedLimitInformation = 9;
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetInformationJobObject(
        IntPtr hJob,
        int jobObjectInfoClass,
        IntPtr lpJobObjectInfo,
        uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr hObject);
}
'@
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$packageJsonPath = Join-Path $repoRoot 'package.json'
$lmStudioConfigPath = Join-Path $PSScriptRoot 'lm-studio.local.ps1'

if (-not (Test-Path -LiteralPath $packageJsonPath)) {
  throw "package.json が見つかりません: $packageJsonPath"
}

if (Test-Path -LiteralPath $lmStudioConfigPath) {
  . $lmStudioConfigPath
}

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) {
  $npmCommand = Get-Command npm -ErrorAction Stop
}
$npmPath = $npmCommand.Source

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules'))) {
  Write-Warning 'node_modules が見つかりません。必要なら先に npm install を実行してください。'
}

function New-ProcessJobObject {
  if (-not $IsWindows) {
    return [IntPtr]::Zero
  }

  $jobHandle = [NativeJobObject]::CreateJobObject([IntPtr]::Zero, $null)
  if ($jobHandle -eq [IntPtr]::Zero) {
    throw "Job Object の作成に失敗しました。Win32Error=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }

  $info = [NativeJobObject+JOBOBJECT_EXTENDED_LIMIT_INFORMATION]::new()
  $info.BasicLimitInformation.LimitFlags = [NativeJobObject]::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  $length = [Runtime.InteropServices.Marshal]::SizeOf([type][NativeJobObject+JOBOBJECT_EXTENDED_LIMIT_INFORMATION])
  $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal($length)

  try {
    [Runtime.InteropServices.Marshal]::StructureToPtr($info, $buffer, $false)
    if (-not [NativeJobObject]::SetInformationJobObject(
      $jobHandle,
      [NativeJobObject]::JobObjectExtendedLimitInformation,
      $buffer,
      [uint32]$length
    )) {
      $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw "Job Object の設定に失敗しました。Win32Error=$errorCode"
    }
  }
  finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
  }

  return $jobHandle
}

function Add-ProcessToJobObject {
  param(
    [Parameter(Mandatory = $true)]
    [System.Diagnostics.Process]$Process,

    [Parameter(Mandatory = $true)]
    [IntPtr]$JobHandle
  )

  if ($JobHandle -eq [IntPtr]::Zero) {
    return
  }

  if (-not [NativeJobObject]::AssignProcessToJobObject($JobHandle, $Process.Handle)) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Write-Warning "$($Process.ProcessName) (PID $($Process.Id)) を Job Object に追加できませんでした。Win32Error=$errorCode"
  }
}

function Close-ProcessJobObject {
  param(
    [Parameter(Mandatory = $true)]
    [IntPtr]$JobHandle
  )

  if ($JobHandle -ne [IntPtr]::Zero) {
    [void][NativeJobObject]::CloseHandle($JobHandle)
  }
}

$processJob = New-ProcessJobObject

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

  Add-ProcessToJobObject -Process $process -JobHandle $processJob

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
      Unregister-Event -SubscriptionId $subscription.SubscriptionId -ErrorAction SilentlyContinue
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

function Get-PortOwnerInfo {
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
    return [pscustomobject]@{
      Port = $Port
      Pid = $connection.OwningProcess
      ProcessName = $null
      Label = "PID $($connection.OwningProcess)"
    }
  }

  return [pscustomobject]@{
    Port = $Port
    Pid = $owner.Id
    ProcessName = $owner.ProcessName
    Label = "PID $($owner.Id) ($($owner.ProcessName))"
  }
}

function Test-AgentContextApiHealth {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Port
  )

  try {
    $response = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2 -ErrorAction Stop
    return $response.status -eq 'ok'
  }
  catch {
    return $false
  }
}

function Test-AgentContextUiHealth {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Port
  )

  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -TimeoutSec 2 -ErrorAction Stop
    $content = [string]$response.Content
    return $response.StatusCode -eq 200 -and $content.Contains('agentblume') -and $content.Contains('/src/ui/main.tsx')
  }
  catch {
    return $false
  }
}

function Stop-ProcessTree {
  param(
    [Parameter(Mandatory = $true)]
    [pscustomobject]$Owner
  )

  $process = Get-Process -Id $Owner.Pid -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    return
  }

  Write-Host "Stopping : $($Owner.Label)"
  $process.Kill($true)
  $null = $process.WaitForExit(5000)
}

function Wait-ForPortRelease {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Port,

    [int]$TimeoutMs = 5000
  )

  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  do {
    if ($null -eq (Get-PortOwnerInfo -Port $Port)) {
      return
    }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)

  $owner = Get-PortOwnerLabel -Port $Port
  if ($null -ne $owner) {
    throw "ポート $Port の解放待ちがタイムアウトしました: $owner"
  }
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

$restartExistingApi = $false
$existingApiOwner = $null
if (-not $UiOnly) {
  $existingApiOwner = Get-PortOwnerInfo -Port $ApiPort
  if ($null -ne $existingApiOwner) {
    if (Test-AgentContextApiHealth -Port $ApiPort) {
      $restartExistingApi = $true
    } else {
      throw "API ポート $ApiPort は使用中です: $($existingApiOwner.Label)。既存プロセスを停止するか、-ApiPort で別ポートを指定してください。"
    }
  }
}

$restartExistingUi = $false
$existingUiOwner = $null
if (-not $ApiOnly) {
  $existingUiOwner = Get-PortOwnerInfo -Port $UiPort
  if ($null -ne $existingUiOwner) {
    if (Test-AgentContextUiHealth -Port $UiPort) {
      $restartExistingUi = $true
    } else {
      throw "UI ポート $UiPort は使用中です: $($existingUiOwner.Label)。既存プロセスを停止するか、-UiPort で別ポートを指定してください。"
    }
  }
}

$targets = @()
$sampleDataEnvironment = if ($SampleData) { 'true' } else { 'false' }
if (-not $UiOnly) {
  $targets += [pscustomobject]@{
    Name = 'api'
    Arguments = 'run serve'
    Environment = @{
      AGENTCONTEXT_PROFILE = $Profile
      AGENTCONTEXT_PORT = $ApiPort
      AGENTCONTEXT_SAMPLE_DATA = $sampleDataEnvironment
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
  if ($restartExistingApi) {
    Write-Host "restart api: stop $($existingApiOwner.Label)"
  }
  if ($restartExistingUi) {
    Write-Host "restart ui: stop $($existingUiOwner.Label)"
  }
  foreach ($target in $targets) {
    if ($target.Name -eq 'api') {
      Write-Host "api: AGENTCONTEXT_PROFILE=$Profile AGENTCONTEXT_PORT=$ApiPort AGENTCONTEXT_SAMPLE_DATA=$sampleDataEnvironment $npmPath $($target.Arguments)"
    } else {
      Write-Host "ui: AGENTCONTEXT_API_URL=http://127.0.0.1:$ApiPort $npmPath $($target.Arguments)"
    }
  }
  exit 0
}

$ownersToRestart = @()
if ($restartExistingUi) {
  $ownersToRestart += [pscustomobject]@{ Name = 'ui'; Owner = $existingUiOwner }
}
if ($restartExistingApi) {
  $ownersToRestart += [pscustomobject]@{ Name = 'api'; Owner = $existingApiOwner }
}

$stoppedPids = @{}
foreach ($entry in $ownersToRestart) {
  if (-not $stoppedPids.ContainsKey($entry.Owner.Pid)) {
    Stop-ProcessTree -Owner $entry.Owner
    $stoppedPids[$entry.Owner.Pid] = $true
  }
}

if (-not $UiOnly) {
  Wait-ForPortRelease -Port $ApiPort
  Assert-PortAvailable -Name 'API' -Port $ApiPort -OverrideParameter 'ApiPort'
}
if (-not $ApiOnly) {
  Wait-ForPortRelease -Port $UiPort
  Assert-PortAvailable -Name 'UI' -Port $UiPort -OverrideParameter 'UiPort'
}

Write-Host "Repo root: $repoRoot"
Write-Host "Profile : $Profile"
if ($SampleData) {
  Write-Host 'Samples : enabled (idempotent sample data will be prepared by the API)'
}
if (-not $UiOnly) {
  if ($restartExistingApi) {
    Write-Host "API     : http://127.0.0.1:$ApiPort/health (restart: $($existingApiOwner.Label))"
  } else {
    Write-Host "API     : http://127.0.0.1:$ApiPort/health"
  }
}
if (-not $ApiOnly) {
  if ($restartExistingUi) {
    Write-Host "UI      : http://127.0.0.1:$UiPort (restart: $($existingUiOwner.Label))"
  } else {
    Write-Host "UI      : http://127.0.0.1:$UiPort"
  }
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
  Close-ProcessJobObject -JobHandle $processJob
}

exit $exitCode
