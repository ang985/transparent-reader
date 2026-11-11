@echo off
chcp 65001 >nul 2>&1
setlocal
set "ELECTRON_RUN_AS_NODE="
set "APPDIR=%~dp0"
set "APPDIR=%APPDIR:~0,-1%"
cd /d "%APPDIR%"
if not exist "%APPDIR%\node_modules\electron\dist\electron.exe" (
  echo [ERROR] Electron runtime not found. Run "npm install" in this folder.
  pause
  exit /b 1
)
start "" "%APPDIR%\node_modules\electron\dist\electron.exe" "%APPDIR%"
