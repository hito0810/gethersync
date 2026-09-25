[System.Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "   GatherSync - GitHub Upload Tool" -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host ""

$gitPath = "C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer\Git\cmd\git.exe"

if (-not (Test-Path $gitPath)) {
    $fallback = Get-ChildItem -Path "C:\Program Files\Microsoft Visual Studio", "$env:LOCALAPPDATA\Programs\Git", "C:\Program Files\Git" -Recurse -Filter "git.exe" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
    if ($fallback) {
        $gitPath = $fallback
    } else {
        Write-Host "Git executable not found." -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit
    }
}

Write-Host "Please paste your GitHub Repository URL below and press Enter:" -ForegroundColor Yellow
Write-Host "(Example: https://github.com/your-username/gathersync.git)" -ForegroundColor Gray
Write-Host ""

$repoUrl = Read-Host "GitHub URL"

if ([string]::IsNullOrWhiteSpace($repoUrl)) {
    Write-Host "No URL entered. Exiting..." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit
}

$repoUrl = $repoUrl.Trim()

Write-Host ""
Write-Host "Target URL: $repoUrl" -ForegroundColor Green
Write-Host "Preparing files..." -ForegroundColor Cyan

& $gitPath config user.name "GatherSync User"
& $gitPath config user.email "user@gathersync.local"
& $gitPath add .
& $gitPath commit -m "Update GatherSync files for cloud hosting" --allow-empty

Write-Host ""
Write-Host "Pushing to GitHub..." -ForegroundColor Yellow
& $gitPath remote remove origin 2>$null
& $gitPath remote add origin $repoUrl
& $gitPath branch -M main

$pushResult = & $gitPath push -u origin main 2>&1

Write-Host ""
Write-Host ($pushResult -join "`n")

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "===================================================" -ForegroundColor Green
    Write-Host "  GitHub Upload Success!" -ForegroundColor Green
    Write-Host "  You can now deploy from Render or Vercel." -ForegroundColor Green
    Write-Host "===================================================" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "---------------------------------------------------" -ForegroundColor Red
    Write-Host "  Upload failed. Please check URL or permissions." -ForegroundColor Red
    Write-Host "---------------------------------------------------" -ForegroundColor Red
}

Write-Host ""
Read-Host "Press Enter to close this window"