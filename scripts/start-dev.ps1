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

  [switch]$DryRun,

  [switch]$Stop
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
  # stdinも切り離す。継承させるとvite等が親コンソールの入力をrawモードにし、
  # Ctrl+C停止時にエコー無効などの壊れた状態が残ってコンソールが操作不能になる。
  $psi.RedirectStandardInput = $true
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
    TrackedPids = @{}
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

  # Kill($true)はkill時点のツリーしか辿れないため、追跡済みの子孫でJob登録前に切り離されたものを個別に停止する。
  foreach ($trackedId in @($Entry.TrackedPids.Keys)) {
    $leftover = Get-Process -Id $trackedId -ErrorAction SilentlyContinue
    if ($null -eq $leftover) {
      continue
    }
    if (-not (Test-RepoProcess -ProcessId $trackedId)) {
      continue
    }
    try {
      $leftover.Kill($true)
      $null = $leftover.WaitForExit(3000)
    }
    catch {
      Write-Warning "$($Entry.Name) の子プロセス (PID $trackedId) を停止できませんでした: $_"
    }
    finally {
      $leftover.Dispose()
    }
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

function Get-DescendantProcessIds {
  param(
    [Parameter(Mandatory = $true)]
    [int]$RootProcessId
  )

  if (-not $IsWindows) {
    return @()
  }

  $all = Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId -ErrorAction SilentlyContinue
  if ($null -eq $all) {
    return @()
  }

  $childrenByParent = @{}
  foreach ($processInfo in $all) {
    $parent = [int]$processInfo.ParentProcessId
    if (-not $childrenByParent.ContainsKey($parent)) {
      $childrenByParent[$parent] = [System.Collections.Generic.List[int]]::new()
    }
    $childrenByParent[$parent].Add([int]$processInfo.ProcessId)
  }

  $result = [System.Collections.Generic.List[int]]::new()
  $queue = [System.Collections.Generic.Queue[int]]::new()
  $queue.Enqueue($RootProcessId)
  while ($queue.Count -gt 0) {
    $current = $queue.Dequeue()
    if (-not $childrenByParent.ContainsKey($current)) {
      continue
    }
    foreach ($childId in $childrenByParent[$current]) {
      if (-not $result.Contains($childId)) {
        $result.Add($childId)
        $queue.Enqueue($childId)
      }
    }
  }
  return $result
}

# npm.cmd は起動直後に実サーバー(node/vite)をspawnするため、Job Object登録が親npmだけだと
# 子孫が登録前に生まれてJobの外へ逃げ、親の停止後も残留する。子孫を定期的にJobへ追い登録する。
function Update-TrackedDescendants {
  param(
    [Parameter(Mandatory = $true)]
    $Entry,

    [Parameter(Mandatory = $true)]
    [IntPtr]$JobHandle
  )

  if ($Entry.Process.HasExited) {
    return
  }

  foreach ($descendantId in (Get-DescendantProcessIds -RootProcessId $Entry.Process.Id)) {
    if ($Entry.TrackedPids.ContainsKey($descendantId)) {
      continue
    }
    $Entry.TrackedPids[$descendantId] = $true
    if ($JobHandle -eq [IntPtr]::Zero) {
      continue
    }
    $descendant = Get-Process -Id $descendantId -ErrorAction SilentlyContinue
    if ($null -ne $descendant) {
      # 既にJob内(親から継承済み)の場合は失敗するが問題ない。
      [void][NativeJobObject]::AssignProcessToJobObject($JobHandle, $descendant.Handle)
    }
  }
}

function Test-RepoProcess {
  param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId
  )

  if (-not $IsWindows) {
    return $true
  }

  $processInfo = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$ProcessId" -Property CommandLine -ErrorAction SilentlyContinue
  if ($null -eq $processInfo) {
    return $false
  }
  $commandLine = [string]$processInfo.CommandLine
  if ($commandLine.Length -eq 0) {
    return $false
  }
  if ($commandLine.ToLowerInvariant().Contains($repoRoot.ToLowerInvariant())) {
    return $true
  }
  # npm run 系はコマンドラインに相対パスしか残らないことがあるため、開発プロセスの特徴で補完判定する。
  return $commandLine -match 'vite|--import tsx|server\.ts|dev:ui|run serve'
}

function Stop-RepoPortOwner {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,

    [Parameter(Mandatory = $true)]
    [int]$Port,

    [switch]$Silent
  )

  $owner = Get-PortOwnerInfo -Port $Port
  if ($null -eq $owner) {
    if (-not $Silent) {
      Write-Host "$Name ポート $Port は使用されていません。"
    }
    return
  }

  if (-not (Test-RepoProcess -ProcessId $owner.Pid)) {
    Write-Warning "$Name ポート $Port の占有プロセス $($owner.Label) はこのリポジトリの開発プロセスに見えないため停止しません。必要なら手動で停止してください。"
    return
  }

  Stop-ProcessTree -Owner $owner
  try {
    Wait-ForPortRelease -Port $Port
    Write-Host "$Name ポート $Port を解放しました。"
  }
  catch {
    Write-Warning "$Name ポート $Port の解放を確認できませんでした: $_"
  }
}

# 残留プロセスの掃除モード: このスクリプトが起動した(とみなせる)ポート占有プロセスを停止して終了する。
if ($Stop) {
  if (-not $UiOnly) {
    Stop-RepoPortOwner -Name 'API' -Port $ApiPort
  }
  if (-not $ApiOnly) {
    Stop-RepoPortOwner -Name 'UI' -Port $UiPort
  }
  Close-ProcessJobObject -JobHandle $processJob
  exit 0
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

  $sweepCounter = 0
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

    # 起動直後(約10秒)は毎回、それ以降は4秒間隔で子孫をJobへ追い登録する(vite再起動等の遅れて生まれる子も拾う)。
    if ($sweepCounter -lt 20 -or ($sweepCounter % 8) -eq 0) {
      foreach ($entry in $started) {
        Update-TrackedDescendants -Entry $entry -JobHandle $processJob
      }
    }
    $sweepCounter++

    Start-Sleep -Milliseconds 500
  }
}
finally {
  foreach ($entry in $started) {
    try {
      Stop-LoggedProcess -Entry $entry
    }
    catch {
      Write-Warning "$($entry.Name) の停止処理でエラー: $_"
    }
  }
  # 追跡から漏れた残留があってもポートを確実に返す(このリポジトリの開発プロセスと判定できたものだけ停止)。
  if ($started.Count -gt 0) {
    if (-not $UiOnly) {
      Stop-RepoPortOwner -Name 'API' -Port $ApiPort -Silent
    }
    if (-not $ApiOnly) {
      Stop-RepoPortOwner -Name 'UI' -Port $UiPort -Silent
    }
  }
  Close-ProcessJobObject -JobHandle $processJob
  # 子プロセスの巻き添えでコンソール状態が乱れた場合に備えた防御的な復元。
  try {
    [Console]::TreatControlCAsInput = $false
    [Console]::CursorVisible = $true
  }
  catch {
    # コンソールが無い実行環境(リダイレクト実行等)では設定できないが問題ない。
  }
  if ($started.Count -gt 0) {
    Write-Host 'すべての子プロセスを停止しました。'
  }
}

exit $exitCode
