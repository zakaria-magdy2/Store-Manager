@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-retailos.ps1" %*
exit /b %ERRORLEVEL%
