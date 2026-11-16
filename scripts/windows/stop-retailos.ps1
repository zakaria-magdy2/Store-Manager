param(
  [int]$Port = 4173
)

$ErrorActionPreference = "SilentlyContinue"
$LogDir = Join-Path $env:LOCALAPPDATA "RetailOS\logs"
$PidFile = Join-Path $LogDir "retailos.pid"
$Stopped = $false

if (Test-Path $PidFile) {
  $PidRaw = (Get-Content -Path $PidFile -Raw).Trim()
  if ($PidRaw -match '^\d+$') {
    $TargetPid = [int]$PidRaw
    $Proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
    if ($Proc -and $Proc.ProcessName -eq "node") {
      Stop-Process -Id $TargetPid
      $Stopped = $true
    }
  }
  Remove-Item -Path $PidFile -Force -ErrorAction SilentlyContinue
}

if (-not $Stopped) {
  $Conns = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $Conns) {
    $Proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    if ($Proc -and $Proc.ProcessName -eq "node") {
      Stop-Process -Id $Proc.Id
      $Stopped = $true
    }
  }
}

if ($Stopped) {
  Write-Output "RetailOS local server stopped cleanly."
} else {
  Write-Output "RetailOS local server was not running on 127.0.0.1:$Port."
}
