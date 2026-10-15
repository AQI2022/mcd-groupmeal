@echo off
chcp 65001 >nul
rem ---------------------------------------------------------------
rem  Double-click friendly entry point for the phone-ordering mode.
rem  All user-facing text lives in bin/phone.mjs (UTF-8 safe).
rem  Usage: mcd-phone.cmd                       (interactive prompts)
rem         mcd-phone.cmd 西安市 长安大厦 巨无霸,中杯美式
rem         mcd-phone.cmd --demo                (offline demo, no token)
rem ---------------------------------------------------------------
node "%~dp0phone.mjs" %*
echo.
pause
