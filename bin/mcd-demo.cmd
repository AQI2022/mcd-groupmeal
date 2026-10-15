@echo off
chcp 65001 >nul
rem ---------------------------------------------------------------
rem  Demo mode: built-in sample data, no network, no token needed.
rem ---------------------------------------------------------------
node "%~dp0..\src\cli.mjs" demo
echo.
pause
