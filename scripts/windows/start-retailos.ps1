param(
  [switch]$NoBrowser,
  [int]$Port = 4173,
  [string]$DataDir = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$ServerScript = Join-Path $RepoRoot "apps\web\dist\server.mjs"
if (-not (Test-Path $ServerScript)) {
  $ServerScript = Join-Path $RepoRoot "apps\web\server.mjs"
}

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
  Write-Error "Node.js is not installed or not in PATH. Install Node.js >= 22 LTS first."
  exit 1
}

if ([string]::IsNullOrWhiteSpace($DataDir)) {
  if ($env:RETAILOS_DATA_DIR) {
    $DataDir = $env:RETAILOS_DATA_DIR
  } else {
    $DataDir = Join-Path $RepoRoot "apps\web\data"
  }
}

$LogDir = Join-Path $env:LOCALAPPDATA "RetailOS\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

$PidFile = Join-Path $LogDir "retailos.pid"
$OutLog = Join-Path $LogDir "retailos-out.log"
$ErrLog = Join-Path $LogDir "retailos-err.log"
$BaseUrl = "http://127.0.0.1:$Port"

function Test-ServerReady {
  param([string]$Url)
  try {
    $res = Invoke-WebRequest -Uri "$Url/api/bootstrap" -UseBasicParsing -TimeoutSec 2
    return ($res.StatusCode -eq 200)
  } catch {
    return $false
  }
}

if (-not (Test-ServerReady -Url $BaseUrl)) {
  $env:PORT = "$Port"
  $env:RETAILOS_DATA_DIR = $DataDir
  $proc = Start-Process -FilePath $NodeCmd.Source `
    -ArgumentList @($ServerScript) `
    -WorkingDirectory $RepoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $OutLog `
    -RedirectStandardError $ErrLog `
    -PassThru

  Set-Content -Path $PidFile -Value "$($proc.Id)" -Encoding ASCII

  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    if ($proc.HasExited) {
      Write-Error "RetailOS server exited early with code $($proc.ExitCode). Check log: $ErrLog"
      exit 1
    }
    if (Test-ServerReady -Url $BaseUrl) {
      $ready = $true
      break
    }
    Start-Sleep -Milliseconds 250
  }

  if (-not $ready) {
    Write-Error "RetailOS did not respond on $BaseUrl within 10 seconds. Check log: $ErrLog"
    exit 1
  }
}

if (-not $NoBrowser) {
  Start-Process $BaseUrl
}
