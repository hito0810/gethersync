@echo off
chcp 65001 > nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0push-to-github.ps1"
if %ERRORLEVEL% neq 0 (
    echo.
    echo エラーが発生しました。
    pause
)