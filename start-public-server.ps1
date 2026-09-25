# GatherSync 公開サーバー起動スクリプト (リアルタイム同期 & Cloudflare Tunnel HTTPS公開)
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "  GatherSync リアルタイム同期＆公開サーバー起動中...  " -ForegroundColor Green
Write-Host "====================================================" -ForegroundColor Cyan

$port = 3000
$scriptDir = $PSScriptRoot

# 1. 既存のバックグラウンドプロセスを整理
Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*node.exe*" } | Stop-Process -Force -ErrorAction SilentlyContinue

# 2. Node.js または PowerShell によるサーバー起動
$hasNode = $false
try {
    $nodeCmd = Get-Command "node" -ErrorAction SilentlyContinue
    if ($nodeCmd) { $hasNode = $true }
} catch {}

if ($hasNode) {
    Write-Host "[1/2] Node.js サーバーを起動中 (Port: $port)..." -ForegroundColor Yellow
    $serverProcess = Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $scriptDir -PassThru -NoNewWindow
} else {
    Write-Host "[1/2] PowerShell APIサーバーを起動中 (Port: $port)..." -ForegroundColor Yellow
    $serverProcess = Start-Process -FilePath "powershell" -ArgumentList "-ExecutionPolicy Bypass -File `"$scriptDir\run-server.ps1`" -Port $port" -WorkingDirectory $scriptDir -PassThru -NoNewWindow
}

Start-Sleep -Seconds 2

# 3. cloudflared によるセキュアHTTPSトンネル公開
$cloudflaredPath = Join-Path $scriptDir "cloudflared.exe"
if (Test-Path $cloudflaredPath) {
    Write-Host "[2/2] Cloudflare セキュアトンネルで世界中にHTTPS公開中..." -ForegroundColor Green
    Write-Host "====================================================" -ForegroundColor Cyan
    Write-Host "※ 下記に表示される 'https://...trycloudflare.com' のURLを" -ForegroundColor Yellow
    Write-Host "   友達やLINEに共有すると、世界中どこからでも" -ForegroundColor Yellow
    Write-Host "   リアルタイムに出欠・カレンダー同期が利用できます！" -ForegroundColor Yellow
    Write-Host "====================================================" -ForegroundColor Cyan
    & $cloudflaredPath tunnel --url "http://localhost:$port"
} else {
    Write-Host "ローカルサーバー起動完了: http://localhost:$port" -ForegroundColor Green
    Write-Host "Ctrl+C で終了します。"
    while ($true) { Start-Sleep -Seconds 1 }
}
