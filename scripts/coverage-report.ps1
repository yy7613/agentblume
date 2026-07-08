<#
.SYNOPSIS
  テストのカバレッジ率を調査して要約レポートを表示する。

.DESCRIPTION
  vitest のカバレッジ(v8)を実行し、coverage/coverage-summary.json を解析して
  「全体 / ディレクトリ別 / ファイル別」のカバレッジ率を表示する。
  しきい値(既定: lines/statements/functions 90%, branches 80% — vitest.config.ts と同値)
  を下回るファイルの洗い出しに使う。

  計測対象は vitest.config.ts の coverage 設定に準拠する（src 配下で実行された .ts/.tsx。
  test/contract/demo/index は除外）。実際に計測されたファイル数はレポート冒頭に表示する。

.PARAMETER UseExisting
  vitest を再実行せず、既存の coverage/coverage-summary.json をそのまま解析する。

.PARAMETER MinLines / MinStatements / MinFunctions / MinBranches
  各指標のしきい値(%)。既定は vitest.config.ts と同値。

.PARAMETER Worst
  カバレッジが低い順に表示するファイル数（既定 15）。

.PARAMETER Strict
  全体指標のいずれかがしきい値未満なら終了コード 1 を返す（CIゲート用）。

.PARAMETER Json
  整形表示の代わりに解析結果を JSON で標準出力へ出す（vitest のログは抑止）。

.EXAMPLE
  .\scripts\coverage-report.ps1
.EXAMPLE
  # 直近のカバレッジ結果を使い、低い順に30件表示（再実行なし）
  .\scripts\coverage-report.ps1 -UseExisting -Worst 30
.EXAMPLE
  # しきい値未満なら失敗扱い（CIゲート）
  .\scripts\coverage-report.ps1 -Strict
.EXAMPLE
  # 機械可読なJSONで出力
  .\scripts\coverage-report.ps1 -Json | Set-Content coverage-report.json
#>
[CmdletBinding()]
param(
  [switch]$UseExisting,
  [ValidateRange(0, 100)][double]$MinLines = 90,
  [ValidateRange(0, 100)][double]$MinStatements = 90,
  [ValidateRange(0, 100)][double]$MinFunctions = 90,
  [ValidateRange(0, 100)][double]$MinBranches = 80,
  [ValidateRange(1, 1000)][int]$Worst = 15,
  [switch]$Strict,
  [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$summaryPath = Join-Path $root 'coverage/coverage-summary.json'

function Get-Pct([double]$covered, [double]$total) {
  if ($total -le 0) { return 100.0 }
  return [math]::Round(100.0 * $covered / $total, 2)
}

function Get-PctColor([double]$pct, [double]$min) {
  if ($pct -lt $min) { return 'Red' }
  if ($pct -lt $min + 5) { return 'Yellow' }
  return 'Green'
}

function Write-PctCell([double]$pct, [double]$min) {
  Write-Host ('{0,6:N2}%' -f $pct) -ForegroundColor (Get-PctColor $pct $min) -NoNewline
}

function Write-MetricRow([string]$label, $metric, [double]$min) {
  $pct = [double]$metric.pct
  $color = Get-PctColor $pct $min
  Write-Host ('  {0,-11}' -f $label) -NoNewline
  Write-Host ('{0,7:N2}%' -f $pct) -ForegroundColor $color -NoNewline
  Write-Host ('   {0,6}/{1,-6}' -f [int]$metric.covered, [int]$metric.total) -NoNewline
  Write-Host ('  (min {0,5:N1})  ' -f $min) -NoNewline
  Write-Host $(if ($pct -lt $min) { 'FAIL' } else { 'ok' }) -ForegroundColor $color
}

# ── 1) 必要ならカバレッジを実行して coverage-summary.json を生成する ──────────
if (-not $UseExisting) {
  # ローカルの vitest バイナリを直接叩く（npx/npm run -- 経由だと追加の reporter 引数が
  # 転送されず json-summary が生成されない環境があるため）。execArgv(sqlite) は設定から自動適用される。
  $vitestBin = if ($IsWindows) { Join-Path $root 'node_modules/.bin/vitest.CMD' } else { Join-Path $root 'node_modules/.bin/vitest' }
  if (-not (Test-Path -LiteralPath $vitestBin)) {
    throw "vitest が見つかりません: $vitestBin （先に npm install を実行してください）"
  }
  $reporters = if ($Json) {
    @('--coverage.reporter=json-summary')
  } else {
    @('--coverage.reporter=text', '--coverage.reporter=html', '--coverage.reporter=json-summary')
  }
  $vitestArgs = @('run', '--coverage') + $reporters

  Push-Location $root
  try {
    if (-not $Json) {
      Write-Host "› vitest coverage を実行中…" -ForegroundColor Cyan
      Write-Host "  vitest $($vitestArgs -join ' ')" -ForegroundColor DarkGray
      & $vitestBin @vitestArgs
    } else {
      & $vitestBin @vitestArgs *> $null
    }
    if ($LASTEXITCODE -ne 0 -and -not $Json) {
      Write-Host "  vitest が非0終了しました (exit $LASTEXITCODE)。しきい値未満やテスト失敗の可能性がありますが、レポート生成は継続します。" -ForegroundColor Yellow
    }
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path -LiteralPath $summaryPath)) {
  throw "coverage-summary.json が見つかりません: $summaryPath （-UseExisting を外して実行し、カバレッジを生成してください）"
}

# ── 2) coverage-summary.json を解析してファイル単位のメトリクスへ整形 ─────────
$summary = Get-Content -Raw -LiteralPath $summaryPath | ConvertFrom-Json
if (-not ($summary.PSObject.Properties.Name -contains 'total')) {
  throw "coverage-summary.json の形式が不正です（total がありません）: $summaryPath"
}
$rootFwd = ($root -replace '\\', '/').TrimEnd('/')

$files = [System.Collections.Generic.List[object]]::new()
foreach ($prop in $summary.PSObject.Properties) {
  if ($prop.Name -eq 'total') { continue }
  $rel = ($prop.Name -replace '\\', '/')
  if ($rel.StartsWith($rootFwd)) { $rel = $rel.Substring($rootFwd.Length).TrimStart('/') }
  $dir = if ($rel.Contains('/')) { $rel.Substring(0, $rel.LastIndexOf('/')) } else { '.' }
  $m = $prop.Value
  $files.Add([pscustomobject]@{
      File           = $rel
      Dir            = $dir
      Lines          = [double]$m.lines.pct
      Statements     = [double]$m.statements.pct
      Functions      = [double]$m.functions.pct
      Branches       = [double]$m.branches.pct
      LinesCovered   = [int]$m.lines.covered
      LinesTotal     = [int]$m.lines.total
      FuncCovered    = [int]$m.functions.covered
      FuncTotal      = [int]$m.functions.total
      BranchCovered  = [int]$m.branches.covered
      BranchTotal    = [int]$m.branches.total
      UncoveredLines = ([int]$m.lines.total - [int]$m.lines.covered)
    })
}

$total = $summary.total

# ── ディレクトリ別に集計（covered/total を積み上げて率を再計算）──────────────
$dirs = $files | Group-Object Dir | ForEach-Object {
  $g = $_.Group
  $lc = ($g | Measure-Object LinesCovered -Sum).Sum;  $lt = ($g | Measure-Object LinesTotal -Sum).Sum
  $fc = ($g | Measure-Object FuncCovered -Sum).Sum;   $ft = ($g | Measure-Object FuncTotal -Sum).Sum
  $bc = ($g | Measure-Object BranchCovered -Sum).Sum; $bt = ($g | Measure-Object BranchTotal -Sum).Sum
  [pscustomobject]@{
    Dir       = $_.Name
    Files     = $_.Count
    Lines     = (Get-Pct $lc $lt)
    Functions = (Get-Pct $fc $ft)
    Branches  = (Get-Pct $bc $bt)
  }
} | Sort-Object Lines, Dir

$belowThreshold = $files | Where-Object { $_.Lines -lt $MinLines -or $_.Branches -lt $MinBranches } | Sort-Object Lines, Branches
$overallPass = ([double]$total.lines.pct -ge $MinLines) -and ([double]$total.statements.pct -ge $MinStatements) `
  -and ([double]$total.functions.pct -ge $MinFunctions) -and ([double]$total.branches.pct -ge $MinBranches)

# ── 3-JSON) 機械可読出力 ──────────────────────────────────────────────────────
if ($Json) {
  [pscustomobject]@{
    total          = [pscustomobject]@{
      lines      = [double]$total.lines.pct
      statements = [double]$total.statements.pct
      functions  = [double]$total.functions.pct
      branches   = [double]$total.branches.pct
    }
    thresholds     = [pscustomobject]@{ lines = $MinLines; statements = $MinStatements; functions = $MinFunctions; branches = $MinBranches }
    pass           = $overallPass
    fileCount      = $files.Count
    directories    = $dirs
    belowThreshold = $belowThreshold
    files          = ($files | Sort-Object File)
  } | ConvertTo-Json -Depth 6
  if ($Strict -and -not $overallPass) { exit 1 }
  exit 0
}

# ── 3) 整形レポート ───────────────────────────────────────────────────────────
$tsxN = ($files | Where-Object { $_.File.EndsWith('.tsx') }).Count
$tsN = ($files | Where-Object { $_.File.EndsWith('.ts') }).Count
Write-Host ''
Write-Host '════════════════════════════════════════════════════════════════' -ForegroundColor DarkGray
Write-Host ' Coverage report' -ForegroundColor White
Write-Host ("  scope : vitest.config.ts 準拠  (計測 {0} files: .ts {1} / .tsx {2})" -f $files.Count, $tsN, $tsxN) -ForegroundColor DarkGray
Write-Host '════════════════════════════════════════════════════════════════' -ForegroundColor DarkGray

Write-Host "`nOverall" -ForegroundColor White
Write-MetricRow 'Lines'      $total.lines      $MinLines
Write-MetricRow 'Statements' $total.statements $MinStatements
Write-MetricRow 'Functions'  $total.functions  $MinFunctions
Write-MetricRow 'Branches'   $total.branches   $MinBranches

Write-Host "`nBy directory (lines 昇順)" -ForegroundColor White
Write-Host '  Lines    Funcs   Branch  Files  Directory' -ForegroundColor DarkGray
foreach ($d in $dirs) {
  Write-Host '  ' -NoNewline
  Write-PctCell $d.Lines $MinLines;         Write-Host ' ' -NoNewline
  Write-PctCell $d.Functions $MinFunctions; Write-Host ' ' -NoNewline
  Write-PctCell $d.Branches $MinBranches
  Write-Host ('  {0,4}   ' -f $d.Files) -NoNewline
  Write-Host $d.Dir
}

Write-Host "`nLowest-covered files (lines 昇順, 上位 $Worst 件)" -ForegroundColor White
Write-Host '  Lines    Funcs   Branch  Uncov  File' -ForegroundColor DarkGray
foreach ($f in ($files | Sort-Object Lines, Branches | Select-Object -First $Worst)) {
  Write-Host '  ' -NoNewline
  Write-PctCell $f.Lines $MinLines;         Write-Host ' ' -NoNewline
  Write-PctCell $f.Functions $MinFunctions; Write-Host ' ' -NoNewline
  Write-PctCell $f.Branches $MinBranches
  Write-Host ('  {0,5}  ' -f $f.UncoveredLines) -NoNewline
  Write-Host $f.File
}

Write-Host "`nBelow threshold (lines < $MinLines% または branches < $MinBranches%): $($belowThreshold.Count) 件" -ForegroundColor White
if ($belowThreshold.Count -eq 0) {
  Write-Host '  （なし）全ファイルがしきい値を満たしています。' -ForegroundColor Green
} else {
  $cap = 40
  foreach ($f in ($belowThreshold | Select-Object -First $cap)) {
    Write-Host '  - ' -NoNewline
    Write-PctCell $f.Lines $MinLines
    Write-Host ' L / ' -NoNewline -ForegroundColor DarkGray
    Write-PctCell $f.Branches $MinBranches
    Write-Host ' B  ' -NoNewline -ForegroundColor DarkGray
    Write-Host $f.File
  }
  if ($belowThreshold.Count -gt $cap) {
    Write-Host ("  … 他 {0} 件（全件は -Json を利用）" -f ($belowThreshold.Count - $cap)) -ForegroundColor DarkGray
  }
}

Write-Host ''
if ($overallPass) {
  Write-Host ' RESULT: PASS — 全体指標がしきい値を満たしています。' -ForegroundColor Green
} else {
  Write-Host ' RESULT: FAIL — しきい値未満の全体指標があります。' -ForegroundColor Red
}
Write-Host ''

# 既定(非 -Strict)は「調査」目的として常に 0 を返す。-Strict のときだけしきい値でゲートする。
if ($Strict -and -not $overallPass) { exit 1 }
exit 0
