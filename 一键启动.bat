@echo off
rem ===============================================================
rem  One-click launcher: service -> wait healthy -> tunnel -> worker
rem  Keep this file ASCII-only AND CRLF: cmd.exe reads .bat with the
rem  system ANSI codepage and requires CRLF. With LF-only it executes
rem  the comment text as commands. Both were hit in practice.
rem ===============================================================
chcp 65001 >nul
title Steam Account Manager - Launcher
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-all.ps1"
echo.
echo (Press any key to close)
pause >nul
