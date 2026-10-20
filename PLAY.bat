@echo off
setlocal
cd /d "%~dp0"
title TAGLITE

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js isn't installed - TAGLITE needs it to run.
  echo   Install it from https://nodejs.org then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo.
  echo   First run: installing dependencies. This takes a minute...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   Install failed. Check your internet connection and try again.
    echo.
    pause
    exit /b 1
  )
)

echo.
echo   Starting TAGLITE - your browser will open automatically.
echo   Keep this window open while you play; close it to stop the game.
echo.
call npm start
