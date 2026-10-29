@echo off
chcp 65001 >nul 2>&1
setlocal
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell"
if not exist "%~dp0tools\make-shortcut.ps1" (
  echo [ERROR] tools\make-shortcut.ps1 not found next to this file.
  pause
  exit /b 1
)
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\make-shortcut.ps1"
echo.
pause
endlocal
