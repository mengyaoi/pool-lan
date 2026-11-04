@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 双人台球 · 局域网对战

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [X] 没找到 Node.js
  echo.
  echo   请先装 Node 18 或更高版本： https://nodejs.org
  echo   装完关掉这个窗口重新双击 start.bat
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动服务端，稍后会自动打开浏览器...
echo   ------------------------------------------------
start "" /min cmd /c "timeout /t 2 >nul && start "" http://localhost:8080"
node server.js

echo.
echo   服务端已停止。
pause
