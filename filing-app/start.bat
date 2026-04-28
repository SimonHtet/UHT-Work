@echo off
title UHT Filling Server
echo ================================
echo  UHT Filling App - Starting...
echo ================================
echo.

REM ── Map network drive first ──
net use Z: "\\dpf-nas5\Automation&Calibration" >nul 2>&1

REM ── Change this path if nodejs is in a different location ──
set NODE_PATH=Z:\Automation\App\node.js\node-v24.15.0-win-x64

set PATH=%NODE_PATH%;%PATH%

REM ── Check node is found ──
node --version >nul 2>&1
if errorlevel 1 (
  echo ERROR: node.exe not found at %NODE_PATH%
  echo Please check the NODE_PATH at the top of this file.
  pause
  exit /b 1
)

REM ── Start server ──
cd /d "%~dp0"
echo Server starting on http://localhost:3000
echo Tablets connect to http://YOUR-WORK-PC-IP:3000
echo.
echo Press Ctrl+C to stop the server.
echo.
node server.js

if errorlevel 1 (
  echo.
  echo ERROR: Server crashed or failed to start.
  echo Check the error message above.
)
pause
