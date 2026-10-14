@echo off
rem ============================================================
rem  Steam Account Manager - launcher
rem  (This file is intentionally ASCII-only: cmd.exe garbles
rem   non-ASCII batch files when the code page changes mid-file.
rem   All Chinese output is produced by scripts\launch.mjs.)
rem ============================================================
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "NODE_EXE="
for %%I in (node.exe) do if not defined NODE_EXE if exist "%%~$PATH:I" set "NODE_EXE=%%~$PATH:I"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%APPDATA%\npm\node.exe" set "NODE_EXE=%APPDATA%\npm\node.exe"

if not defined NODE_EXE goto :nonode

echo.
echo   Using Node: %NODE_EXE%
"%NODE_EXE%" "scripts\launch.mjs"

if errorlevel 1 (
  echo.
  echo   [x] The service exited with an error. See the message above.
  pause
)
endlocal
exit /b 0

:nonode
echo.
echo   ============================================================
echo    Node.js not found
echo   ============================================================
echo.
echo    This tool needs Node.js 22 or newer.
echo.
echo    How to install:
echo      1. Open  https://nodejs.org/
echo      2. Download the LTS build and click Next through the installer
echo      3. Close this window and double-click this file again
echo.
echo    Keep the default options - the installer adds Node to PATH.
echo.
pause
exit /b 1
