param(
  [int]$Port = 4173,
  [string]$DataDir = ""
)

$ErrorActionPreference = "SilentlyContinue"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if ([string]::IsNullOrWhiteSpace($DataDir)) {
  if ($env:RETAILOS_DATA_DIR) {
    $DataDir = $env:RETAILOS_DATA_DIR
  } else {
    $DataDir = Join-Path $RepoRoot "apps\web\data"
  }
}

$LogDir = Join-Path $env:LOCALAPPDATA "RetailOS\logs"
$PidFile = Join-Path $LogDir "retailos.pid"
$ControlFile = Join-Path $DataDir ".retailos-control.json"
$StoppedGracefully = $false
$StoppedForced = $false

function Wait-ProcessExit {
  param([int]$ProcessId, [int]$TimeoutMs = 15000)
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  while ([DateTime]::UtcNow -lt $deadline) {
    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $proc -or $proc.HasExited) {
      return $true
    }
    Start-Sleep -Milliseconds 200
  }
  return $false
}

if (Test-Path $ControlFile) {
  try {
    $ctrl = Get-Content -Path $ControlFile -Raw | ConvertFrom-Json
    $ctrlPort = if ($ctrl.port) { [int]$ctrl.port } else { $Port }
    $ctrlPid = if ($ctrl.pid) { [int]$ctrl.pid } else { 0 }
    $ctrlToken = [string]$ctrl.token
    if ($ctrlPort -gt 0 -and -not [string]::IsNullOrWhiteSpace($ctrlToken)) {
      $resp = Invoke-WebRequest `
        -Uri "http://127.0.0.1:$ctrlPort/api/internal/shutdown" `
        -Method Post `
        -Headers @{ "x-retailos-shutdown-token" = $ctrlToken } `
        -UseBasicParsing `
        -TimeoutSec 5
      if ($resp.StatusCode -eq 202 -or $resp.StatusCode -eq 200) {
        if ($ctrlPid -gt 0) {
          if (Wait-ProcessExit -ProcessId $ctrlPid -TimeoutMs 15000) {
            $StoppedGracefully = $true
          }
        } else {
          Start-Sleep -Milliseconds 1500
          $StoppedGracefully = $true
        }
      }
    }
  } catch {
    # Fall through to PID / listener cleanup below if HTTP shutdown failed
  }
}

if (-not $StoppedGracefully -and (Test-Path $PidFile)) {
  $PidRaw = (Get-Content -Path $PidFile -Raw).Trim()
  if ($PidRaw -match '^\d+$') {
    $TargetPid = [int]$PidRaw
    $Proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
    if ($Proc -and $Proc.ProcessName -eq "node") {
      Stop-Process -Id $TargetPid -ErrorAction SilentlyContinue
      if (Wait-ProcessExit -ProcessId $TargetPid -TimeoutMs 5000) {
        $StoppedForced = $true
      }
    }
  }
}

if (-not $StoppedGracefully -and -not $StoppedForced) {
  $Conns = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $Conns) {
    $Proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    if ($Proc -and $Proc.ProcessName -eq "node") {
      Stop-Process -Id $Proc.Id -ErrorAction SilentlyContinue
      if (Wait-ProcessExit -ProcessId $Proc.Id -TimeoutMs 5000) {
        $StoppedForced = $true
      }
    }
  }
}

if (Test-Path $PidFile) {
  Remove-Item -Path $PidFile -Force -ErrorAction SilentlyContinue
}

if ($StoppedGracefully) {
  Write-Output "RetailOS local server stopped gracefully (daily backup saved & WAL checkpointed)."
} elseif ($StoppedForced) {
  Write-Warning "RetailOS server did not respond to graceful shutdown; terminated process via Stop-Process."
} else {
  Write-Output "RetailOS local server was not running on 127.0.0.1:$Port."
}
