[CmdletBinding()]
param(
  [string]$BaseUrl,

  [string]$Model,

  [AllowEmptyString()]
  [string]$ApiKey,

  [int]$TimeoutMs,

  [string]$ConfigPath = (Join-Path $PSScriptRoot 'lm-studio.local.ps1'),

  [switch]$ListModels,

  [switch]$UseFirstModel,

  [switch]$SkipProbe,

  [switch]$PrintOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-Setting {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,

    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string]$ParameterValue,

    [Parameter(Mandatory = $true)]
    [bool]$ParameterProvided,

    [AllowEmptyString()]
    [string]$DefaultValue = ''
  )

  if ($ParameterProvided) {
    return $ParameterValue
  }

  $envValue = [Environment]::GetEnvironmentVariable($Name)
  if ($null -ne $envValue) {
    return $envValue
  }

  return $DefaultValue
}

function Normalize-BaseUrl {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Value
  )

  $trimmed = $Value.Trim()
  if ($trimmed.Length -eq 0) {
    throw 'LM Studio base URL is required.'
  }

  $uri = [Uri]$trimmed
  $base = $trimmed.TrimEnd('/')
  if ($uri.AbsolutePath -eq '/' -or $uri.AbsolutePath.Length -eq 0) {
    return "$base/v1"
  }
  return $base
}

function Get-ModelsEndpoint {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ResolvedBaseUrl
  )

  return "$($ResolvedBaseUrl.TrimEnd('/'))/models"
}

function Get-LmStudioModels {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ResolvedBaseUrl
  )

  $endpoint = Get-ModelsEndpoint -ResolvedBaseUrl $ResolvedBaseUrl
  $response = Invoke-RestMethod -Uri $endpoint -TimeoutSec 3 -ErrorAction Stop
  if ($null -eq $response -or $null -eq $response.data) {
    throw "LM Studio model list response is invalid: $endpoint"
  }

  $models = @(
    $response.data |
      ForEach-Object {
        if ($null -eq $_) { return }
        $id = $_.id
        if ([string]::IsNullOrWhiteSpace($id)) { return }
        [pscustomobject]@{
          Id = [string]$id
          Raw = $_
        }
      } |
      Where-Object { $null -ne $_ }
  )

  return $models
}

function Write-ModelList {
  param(
    [Parameter(Mandatory = $true)]
    [object[]]$Models,

    [Parameter(Mandatory = $true)]
    [string]$ResolvedBaseUrl
  )

  Write-Host "LM Studio models: $((Get-ModelsEndpoint -ResolvedBaseUrl $ResolvedBaseUrl))"
  if ($Models.Count -eq 0) {
    Write-Host '  (no models returned)'
    return
  }

  for ($i = 0; $i -lt $Models.Count; $i++) {
    Write-Host ("  [{0}] {1}" -f ($i + 1), $Models[$i].Id)
  }
}

function Prompt-ForModelSelection {
  param(
    [Parameter(Mandatory = $true)]
    [object[]]$Models
  )

  while ($true) {
    $selection = Read-Host 'Select model by number or id'
    if ([string]::IsNullOrWhiteSpace($selection)) {
      throw 'LM Studio model selection was cancelled.'
    }

    $trimmed = $selection.Trim()
    $index = 0
    if ([int]::TryParse($trimmed, [ref]$index)) {
      if ($index -ge 1 -and $index -le $Models.Count) {
        return $Models[$index - 1].Id
      }
      Write-Warning "選択番号が範囲外です: $trimmed"
      continue
    }

    $matched = @($Models | Where-Object { $_.Id -eq $trimmed })
    if ($matched.Count -eq 1) {
      return $matched[0].Id
    }

    Write-Warning "一致するモデルが見つかりません: $trimmed"
  }
}

function Escape-SingleQuoted {
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string]$Value
  )

  return $Value.Replace("'", "''")
}

$resolvedBaseUrl = Normalize-BaseUrl -Value (Resolve-Setting -Name 'LM_STUDIO_BASE_URL' -ParameterValue $BaseUrl -ParameterProvided $PSBoundParameters.ContainsKey('BaseUrl') -DefaultValue 'http://127.0.0.1:1234/v1')
$resolvedModel = (Resolve-Setting -Name 'LM_STUDIO_MODEL' -ParameterValue $Model -ParameterProvided $PSBoundParameters.ContainsKey('Model')).Trim()
$resolvedApiKey = Resolve-Setting -Name 'LM_STUDIO_API_KEY' -ParameterValue $ApiKey -ParameterProvided $PSBoundParameters.ContainsKey('ApiKey')
$timeoutRaw = Resolve-Setting -Name 'LM_STUDIO_TIMEOUT_MS' -ParameterValue ([string]$TimeoutMs) -ParameterProvided $PSBoundParameters.ContainsKey('TimeoutMs') -DefaultValue '120000'

$resolvedTimeoutMs = 0
if (-not [int]::TryParse($timeoutRaw, [ref]$resolvedTimeoutMs) -or $resolvedTimeoutMs -le 0) {
  throw "LM_STUDIO_TIMEOUT_MS must be a positive integer: $timeoutRaw"
}

$models = @()
$probed = $false
if (-not $SkipProbe) {
  try {
    $models = Get-LmStudioModels -ResolvedBaseUrl $resolvedBaseUrl
    $probed = $true
  }
  catch {
    if ($ListModels -or [string]::IsNullOrWhiteSpace($resolvedModel)) {
      throw "LM Studio model list could not be loaded from $(Get-ModelsEndpoint -ResolvedBaseUrl $resolvedBaseUrl): $($_.Exception.Message)"
    }
    Write-Warning "LM Studio model list could not be loaded: $($_.Exception.Message)"
  }
}

if ($ListModels -and $probed) {
  Write-ModelList -Models $models -ResolvedBaseUrl $resolvedBaseUrl
}

if ([string]::IsNullOrWhiteSpace($resolvedModel)) {
  if (-not $probed) {
    throw 'LM Studio model is required. Specify -Model or start LM Studio and omit -SkipProbe.'
  }

  if ($models.Count -eq 1) {
    $resolvedModel = $models[0].Id
    Write-Host "Model    : auto-selected $resolvedModel"
  } elseif ($models.Count -gt 1 -and $UseFirstModel) {
    $resolvedModel = $models[0].Id
    Write-Warning "複数モデルがあるため先頭を採用しました: $resolvedModel"
  } elseif ($models.Count -gt 1) {
    Write-ModelList -Models $models -ResolvedBaseUrl $resolvedBaseUrl
    $resolvedModel = Prompt-ForModelSelection -Models $models
  } else {
    Write-ModelList -Models $models -ResolvedBaseUrl $resolvedBaseUrl
    throw 'LM Studio model is not resolved because LM Studio returned no models.'
  }
}

$lines = @(
  '# Generated by scripts/set-lm-studio-config.ps1',
  '# Auto-loaded by scripts/start-dev.ps1 when present.',
  ('$env:LM_STUDIO_BASE_URL = ''{0}''' -f (Escape-SingleQuoted -Value $resolvedBaseUrl)),
  ('$env:LM_STUDIO_MODEL = ''{0}''' -f (Escape-SingleQuoted -Value $resolvedModel)),
  ('$env:LM_STUDIO_TIMEOUT_MS = ''{0}''' -f $resolvedTimeoutMs)
)

if ([string]::IsNullOrEmpty($resolvedApiKey)) {
  $lines += 'Remove-Item Env:\LM_STUDIO_API_KEY -ErrorAction SilentlyContinue'
} else {
  $lines += ('$env:LM_STUDIO_API_KEY = ''{0}''' -f (Escape-SingleQuoted -Value $resolvedApiKey))
}

if ($PrintOnly) {
  $lines | ForEach-Object { Write-Host $_ }
} else {
  Set-Content -Path $ConfigPath -Value $lines -Encoding utf8
  Write-Host "Saved    : $ConfigPath"
}

Write-Host "Base URL : $resolvedBaseUrl"
Write-Host "Model    : $resolvedModel"
Write-Host "Timeout  : $resolvedTimeoutMs ms"
if ([string]::IsNullOrEmpty($resolvedApiKey)) {
  Write-Host 'API key  : not set'
} else {
  Write-Host 'API key  : set'
}
if (-not $PrintOnly) {
  Write-Host 'Next     : .\scripts\start-dev.ps1'
}
