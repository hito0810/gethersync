@echo off
chcp 65001 > nul
title GatherSync - GitHub アップロード

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0push-to-github.ps1"

if %ERRORLEVEL% neq 0 (
    echo.
    echo 実行中にエラーが発生しました。
    pause
)
