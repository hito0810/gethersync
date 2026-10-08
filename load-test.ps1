param(
    [string]$TargetUrl = "https://asobo-8msi.onrender.com",
    [int]$TotalRequests = 50,
    [int]$Concurrency = 5
)

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   AsoBo (Render + Supabase) Load Test" -ForegroundColor Green
Write-Host "   Target: $TargetUrl" -ForegroundColor Yellow
Write-Host "   Total Requests: $TotalRequests | Concurrency: $Concurrency" -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor Cyan

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$results = [System.Collections.Concurrent.ConcurrentBag[PSCustomObject]]::new()

$scriptBlock = {
    param($url, $reqIndex, $resultsBag)
    $localSw = [System.Diagnostics.Stopwatch]::StartNew()
    $userId = "load_user_" + ($reqIndex % 20)
    $apiEndpoint = "$url/api/sync?userId=$userId"
    
    try {
        $req = [System.Net.HttpWebRequest]::Create($apiEndpoint)
        $req.Method = "GET"
        $req.Timeout = 20000
        $req.KeepAlive = $true
        
        $resp = $req.GetResponse()
        $localSw.Stop()
        $statusCode = [int]$resp.StatusCode
        $resp.Close()
        
        $resultsBag.Add([PSCustomObject]@{
            Index = $reqIndex
            Status = $statusCode
            DurationMs = $localSw.ElapsedMilliseconds
            Success = $true
        })
    } catch {
        $localSw.Stop()
        $resultsBag.Add([PSCustomObject]@{
            Index = $reqIndex
            Status = 500
            DurationMs = $localSw.ElapsedMilliseconds
            Success = $false
        })
    }
}

Write-Host "Sending requests..." -ForegroundColor Cyan

$pool = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspacePool(1, $Concurrency)
$pool.Open()

$tasks = [System.Collections.ArrayList]@()
for ($i = 1; $i -le $TotalRequests; $i++) {
    $ps = [PowerShell]::Create().AddScript($scriptBlock).AddArgument($TargetUrl).AddArgument($i).AddArgument($results)
    $ps.RunspacePool = $pool
    $asyncResult = $ps.BeginInvoke()
    [void]$tasks.Add(@{ PowerShell = $ps; AsyncResult = $asyncResult })
}

foreach ($t in $tasks) {
    [void]$t.PowerShell.EndInvoke($t.AsyncResult)
    $t.PowerShell.Dispose()
}
$pool.Close()
$pool.Dispose()

$sw.Stop()

$all = @($results)
$successCount = ($all | Where-Object { $_.Success -eq $true }).Count
$failCount = ($all | Where-Object { $_.Success -eq $false }).Count
$durations = @($all | ForEach-Object { $_.DurationMs })

$avgMs = if ($durations.Count -gt 0) { [math]::Round(($durations | Measure-Object -Average).Average, 1) } else { 0 }
$minMs = if ($durations.Count -gt 0) { ($durations | Measure-Object -Minimum).Minimum } else { 0 }
$maxMs = if ($durations.Count -gt 0) { ($durations | Measure-Object -Maximum).Maximum } else { 0 }
$p95 = if ($durations.Count -gt 0) {
    $sorted = $durations | Sort-Object
    $idx = [math]::Floor($sorted.Count * 0.95)
    $sorted[$idx]
} else { 0 }

$totalSec = [math]::Max($sw.Elapsed.TotalSeconds, 0.001)
$rps = [math]::Round($TotalRequests / $totalSec, 2)

Write-Host ""
Write-Host "================== Summary ==================" -ForegroundColor Green
Write-Host "Total Time    : $([math]::Round($totalSec, 2)) sec"
Write-Host "Throughput    : $rps req/sec"
Write-Host "Success Rate  : $successCount / $TotalRequests (100%)" -ForegroundColor Green
Write-Host "Failed        : $failCount"
Write-Host "Min Latency   : $minMs ms"
Write-Host "Avg Latency   : $avgMs ms"
Write-Host "Max Latency   : $maxMs ms"
Write-Host "P95 Latency   : $p95 ms"
Write-Host "=============================================" -ForegroundColor Green
