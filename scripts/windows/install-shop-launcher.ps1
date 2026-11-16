param(
  [switch]$RegisterAutoStart,
  [switch]$UnregisterAutoStart
)

$ErrorActionPreference = "Stop"
$WinScripts = $PSScriptRoot
$RepoRoot = (Resolve-Path (Join-Path $WinScripts "..\..")).Path
$StartCmd = Join-Path $WinScripts "start-retailos.cmd"
$StopCmd = Join-Path $WinScripts "stop-retailos.cmd"
$DesktopDir = [Environment]::GetFolderPath("Desktop")
$WshShell = New-Object -ComObject WScript.Shell

$StartShortcut = $WshShell.CreateShortcut((Join-Path $DesktopDir "تشغيل رَفّ - RetailOS.lnk"))
$StartShortcut.TargetPath = $StartCmd
$StartShortcut.WorkingDirectory = $RepoRoot
$StartShortcut.WindowStyle = 7
$StartShortcut.Description = "Start RetailOS on http://127.0.0.1:4173"
$StartShortcut.Save()

$StopShortcut = $WshShell.CreateShortcut((Join-Path $DesktopDir "إيقاف رَفّ - RetailOS.lnk"))
$StopShortcut.TargetPath = $StopCmd
$StopShortcut.WorkingDirectory = $RepoRoot
$StopShortcut.WindowStyle = 7
$StopShortcut.Description = "Stop RetailOS cleanly"
$StopShortcut.Save()

$StartupDir = [Environment]::GetFolderPath("Startup")
$AutoStartLnk = Join-Path $StartupDir "RetailOS-AutoStart.lnk"

if ($UnregisterAutoStart) {
  Remove-Item -Path $AutoStartLnk -Force -ErrorAction SilentlyContinue
  Write-Output "Removed RetailOS auto-start shortcut."
} elseif ($RegisterAutoStart) {
  $AutoShortcut = $WshShell.CreateShortcut($AutoStartLnk)
  $AutoShortcut.TargetPath = "powershell.exe"
  $AutoShortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$WinScripts\start-retailos.ps1`" -NoBrowser"
  $AutoShortcut.WorkingDirectory = $RepoRoot
  $AutoShortcut.WindowStyle = 7
  $AutoShortcut.Description = "Start RetailOS silently on Windows logon"
  $AutoShortcut.Save()
  Write-Output "Registered per-user logon auto-start at: $AutoStartLnk"
}

Write-Output "Desktop shortcuts created in: $DesktopDir"
