@echo off
chcp 65001 >nul 2>&1
setlocal
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell"
if not exist "%~dp0tools\browser-alpha.ps1" (
  echo [ERROR] tools\browser-alpha.ps1 not found.
  pause
  exit /b 1
)
"%PS%" -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0tools\browser-alpha.ps1"
if errorlevel 1 pause
endlocal
