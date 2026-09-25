Add-Type -AssemblyName Microsoft.VisualBasic
Add-Type -AssemblyName System.Windows.Forms

[System.Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "   GatherSync - GitHub アップロード ツール" -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host ""

$gitPath = "C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer\Git\cmd\git.exe"

if (-not (Test-Path $gitPath)) {
    # Search fallback git paths
    $fallback = Get-ChildItem -Path "C:\Program Files\Microsoft Visual Studio", "$env:LOCALAPPDATA\Programs\Git", "C:\Program Files\Git" -Recurse -Filter "git.exe" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
    if ($fallback) {
        $gitPath = $fallback
    } else {
        Write-Host "Gitが見つかりませんでした。" -ForegroundColor Red
        Read-Host "Enterキーを押して終了してください..."
        exit
    }
}

# Check clipboard for github url
$clipText = ""
try {
    $clipText = [System.Windows.Forms.Clipboard]::GetText()
} catch {}

$defaultUrl = ""
if ($clipText -match "^https:\/\/github\.com\/.+\.git$") {
    $defaultUrl = $clipText
}

$repoUrl = [Microsoft.VisualBasic.Interaction]::InputBox(
    "GitHubのリポジトリURLを入力（貼り付け）してください`n`n例: https://github.com/あなたのユーザー名/gathersync.git",
    "GitHub アップロード設定",
    $defaultUrl
)

if ([string]::IsNullOrWhiteSpace($repoUrl)) {
    Write-Host "URLの入力がキャンセルされたか、空でした。" -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Enterキーを押すと画面を閉じます..."
    exit
}

$repoUrl = $repoUrl.Trim()

Write-Host ""
Write-Host "リポジトリURL: $repoUrl" -ForegroundColor Green
Write-Host "ファイルを準備中..." -ForegroundColor Cyan

# Ensure git repo initialized
if (-not (Test-Path (Join-Path $PSScriptRoot ".git"))) {
    & $gitPath init
    & $gitPath branch -M main
}

# Commit current state
& $gitPath config user.name "GatherSync User"
& $gitPath config user.email "user@gathersync.local"
& $gitPath add .
& $gitPath commit -m "Update GatherSync files for cloud hosting" --allow-empty

Write-Host ""
Write-Host "GitHub へ送信中（Push）..." -ForegroundColor Yellow
& $gitPath remote remove origin 2>$null
& $gitPath remote add origin $repoUrl
& $gitPath branch -M main

$pushResult = & $gitPath push -u origin main 2>&1

Write-Host ""
Write-Host ($pushResult -join "`n")

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "===================================================" -ForegroundColor Green
    Write-Host "  ✨ GitHub へのアップロードが成功しました！" -ForegroundColor Green
    Write-Host "  Render や Vercel から連携してデプロイできます。" -ForegroundColor Green
    Write-Host "===================================================" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "---------------------------------------------------" -ForegroundColor Red
    Write-Host "  アップロード時にエラーが発生しました。" -ForegroundColor Red
    Write-Host "  ・URLが正しいか確認してください。" -ForegroundColor Red
    Write-Host "  ・GitHubのログイン認証画面が出た場合はログインを完了させてください。" -ForegroundColor Red
    Write-Host "---------------------------------------------------" -ForegroundColor Red
}

Write-Host ""
Read-Host "確認したら Enter キーを押して閉じてください..."
