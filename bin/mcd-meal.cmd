@echo off
chcp 65001 >nul
rem ---------------------------------------------------------------
rem  Double-click friendly entry point (Windows).
rem  All user-facing text lives in bin/meal.mjs (UTF-8 safe).
rem  Usage: mcd-meal.cmd            (interactive prompts)
rem         mcd-meal.cmd 20 35 Xian (direct args, no prompts)
rem ---------------------------------------------------------------
node "%~dp0meal.mjs" %*
echo.
pause
