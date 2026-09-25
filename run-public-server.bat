@echo off
chcp 65001 > nul
title GatherSync 公開サーバー起動ランチャー
cd /d "%~dp0"
echo ====================================================
echo   GatherSync リアルタイム同期＆公開サーバー起動中...
echo ====================================================
powershell -ExecutionPolicy Bypass -File "%~dp0start-public-server.ps1"
pause
