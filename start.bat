@echo off
title Nova voice assistant
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org then run this again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing packages, first run only...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo Starting Nova on http://localhost:3000  (close this window to stop)
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3000"
call npm start
pause
