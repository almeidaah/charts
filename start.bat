@echo off
rem Opens Charts in the default browser and shows server messages in this window.
cd /d "%~dp0"
title Charts
set "NODE=node"
if exist "runtime\node.exe" set "NODE=runtime\node.exe"
"%NODE%" --version >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install version 24 or newer from nodejs.org
  pause
  exit /b 1
)
echo To quit, close this window.
"%NODE%" server/index.js --open
if errorlevel 1 pause
