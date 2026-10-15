@echo off
chcp 65001 >nul
rem ---------------------------------------------------------------
rem  Self-check: token / handshake / tool list / address book.
rem ---------------------------------------------------------------
node "%~dp0..\src\cli.mjs" doctor
echo.
pause
