@echo off
rem ===============================================================
rem  XianGuanjia tunnel launcher.
rem  Keep this file ASCII-only AND CRLF: cmd.exe reads .bat with the
rem  system ANSI codepage and requires CRLF line endings. With LF-only
rem  it executes the comment text as commands (seen: "this is not
rem  recognized as an internal or external command").
rem ===============================================================
chcp 65001 >nul
title XianGuanjia Tunnel
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\tunnel.ps1"
echo.
echo (Press any key to close)
pause >nul
