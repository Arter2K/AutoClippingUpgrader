@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -File "%~dp0scripts\run.ps1" preview
if errorlevel 1 pause
