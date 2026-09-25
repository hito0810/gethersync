param(
    [int]$Port = 3000,
    [string]$Root = $PSScriptRoot
)

$dbFile = Join-Path $Root "database.json"

# --- DB初期化 ---
$script:memoryDB = [ordered]@{
    epoch = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    users = @{}
    userFriends = @{}
    groups = [System.Collections.ArrayList]@()
    events = [System.Collections.ArrayList]@()
    deletedEventIds = [System.Collections.ArrayList]@()
    notifications = [System.Collections.ArrayList]@()
}

if (Test-Path $dbFile) {
    try {
        $jsonContent = [System.IO.File]::ReadAllText($dbFile, [System.Text.Encoding]::UTF8)
        $loaded = $jsonContent | ConvertFrom-Json
        if ($loaded) {
            if ($loaded.epoch) { $script:memoryDB.epoch = $loaded.epoch }
            if ($loaded.users) {
                foreach ($prop in $loaded.users.PSObject.Properties) {
                    $script:memoryDB.users[$prop.Name] = $prop.Value
                }
            }
            if ($loaded.userFriends) {
                foreach ($prop in $loaded.userFriends.PSObject.Properties) {
                    $script:memoryDB.userFriends[$prop.Name] = [System.Collections.ArrayList]@($prop.Value)
                }
            }
            if ($loaded.groups) { $script:memoryDB.groups = [System.Collections.ArrayList]@($loaded.groups) }
            if ($loaded.events) { $script:memoryDB.events = [System.Collections.ArrayList]@($loaded.events) }
            if ($loaded.deletedEventIds) { $script:memoryDB.deletedEventIds = [System.Collections.ArrayList]@($loaded.deletedEventIds) }
            if ($loaded.notifications) { $script:memoryDB.notifications = [System.Collections.ArrayList]@($loaded.notifications) }
        }
    } catch {
        Write-Host "DB Load Warning: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

function Save-DB {
    try {
        $script:memoryDB.epoch = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $json = $script:memoryDB | ConvertTo-Json -Depth 10
        [System.IO.File]::WriteAllText($dbFile, $json, [System.Text.Encoding]::UTF8)
    } catch {
        Write-Host "DB Save Error: $($_.Exception.Message)" -ForegroundColor Red
    }
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$($Port)/")

try {
    $listener.Start()
    Write-Host "====================================================" -ForegroundColor Green
    Write-Host "  GatherSync API & Web Server running on Port $Port  " -ForegroundColor Green
    Write-Host "====================================================" -ForegroundColor Green
} catch {
    Write-Host ("Failed to start listener: " + $_.Exception.Message) -ForegroundColor Red
    exit 1
}

$mimeTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".htm"  = "text/html; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".png"  = "image/png"
    ".jpg"  = "image/jpeg"
    ".jpeg" = "image/jpeg"
    ".svg"  = "image/svg+xml"
    ".ico"  = "image/x-icon"
    ".webmanifest" = "application/manifest+json"
}

function Send-JsonResponse($response, $data, [int]$statusCode = 200) {
    try {
        $response.Headers.Add("Access-Control-Allow-Origin", "*")
        $response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
        $response.ContentType = "application/json; charset=utf-8"
        $response.StatusCode = $statusCode
        $json = $data | ConvertTo-Json -Depth 10 -Compress
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
        $response.ContentLength64 = $bytes.Length
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
        $response.OutputStream.Flush()
        $response.OutputStream.Close()
    } catch {}
}

function Read-RequestBody($request) {
    try {
        $reader = New-Object System.IO.StreamReader($request.InputStream, [System.Text.Encoding]::UTF8)
        $body = $reader.ReadToEnd()
        if ([string]::IsNullOrWhiteSpace($body)) { return $null }
        return ($body | ConvertFrom-Json)
    } catch {
        return $null
    }
}

while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        $response.Headers.Add("Access-Control-Allow-Origin", "*")
        $response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")

        if ($request.HttpMethod -eq "OPTIONS") {
            $response.StatusCode = 204
            $response.OutputStream.Close()
            continue
        }

        $rawUrl = $request.Url.LocalPath
        $queryString = $request.QueryString

        # --- API: GET /api/sync ---
        if ($rawUrl -eq "/api/sync" -and $request.HttpMethod -eq "GET") {
            $userId = $queryString["userId"]
            if (-not $userId) {
                Send-JsonResponse $response @{ epoch = $script:memoryDB.epoch; friends = @(); groups = @(); events = @() }
                continue
            }

            $rawFriends = if ($script:memoryDB.userFriends.ContainsKey($userId)) { @($script:memoryDB.userFriends[$userId]) } else { @() }
            $myFriends = @()
            foreach ($f in $rawFriends) {
                if ($f -and $f.id) {
                    $u = if ($script:memoryDB.users.ContainsKey($f.id)) { $script:memoryDB.users[$f.id] } else { $null }
                    $myFriends += @{
                        id = $f.id
                        name = if ($u -and $u.name) { $u.name } else { $f.name }
                        avatar = if ($u -and $u.avatar) { $u.avatar } else { $f.avatar }
                        note = $f.note
                    }
                }
            }

            $myGroups = @($script:memoryDB.groups | Where-Object {
                $_.createdById -eq $userId -or ($_.memberIds -contains $userId)
            })

            $myEvents = @($script:memoryDB.events | Where-Object {
                $e = $_
                if ($e.createdById -eq $userId) { return $true }
                if ($e.attendees -and ($e.attendees | Where-Object { $_.friendId -eq $userId })) { return $true }
                if ($e.groupId) {
                    $g = $script:memoryDB.groups | Where-Object { $_.id -eq $e.groupId }
                    if ($g -and $g.memberIds -contains $userId) { return $true }
                }
                return $false
            })

            Send-JsonResponse $response @{
                epoch = $script:memoryDB.epoch
                friends = $myFriends
                groups = $myGroups
                events = $myEvents
            }
            continue
        }

        # --- API: POST /api/sync ---
        if ($rawUrl -eq "/api/sync" -and $request.HttpMethod -eq "POST") {
            $body = Read-RequestBody $request
            if ($body) {
                if ($body.user -and $body.user.id) {
                    $uid = $body.user.id
                    $script:memoryDB.users[$uid] = $body.user
                    if ($body.friends) {
                        if (-not $script:memoryDB.userFriends.ContainsKey($uid)) {
                            $script:memoryDB.userFriends[$uid] = [System.Collections.ArrayList]@()
                        }
                        $existingList = $script:memoryDB.userFriends[$uid]
                        foreach ($inF in $body.friends) {
                            if ($inF -and $inF.id -and $inF.id -ne $uid) {
                                $fIdx = -1
                                for ($i = 0; $i -lt $existingList.Count; $i++) {
                                    if ($existingList[$i].id -eq $inF.id) { $fIdx = $i; break }
                                }
                                if ($fIdx -ge 0) { $existingList[$fIdx] = $inF }
                                else { [void]$existingList.Add($inF) }
                            }
                        }
                    }
                }

                if ($body.groups) {
                    foreach ($inG in $body.groups) {
                        if ($inG -and $inG.id) {
                            $gIdx = -1
                            for ($i = 0; $i -lt $script:memoryDB.groups.Count; $i++) {
                                if ($script:memoryDB.groups[$i].id -eq $inG.id) { $gIdx = $i; break }
                            }
                            if ($gIdx -ge 0) { $script:memoryDB.groups[$gIdx] = $inG }
                            else { [void]$script:memoryDB.groups.Add($inG) }
                        }
                    }
                }

                if ($body.events) {
                    foreach ($inE in $body.events) {
                        if ($inE -and $inE.id) {
                            if ($script:memoryDB.deletedEventIds -and $script:memoryDB.deletedEventIds.Contains($inE.id)) {
                                continue
                            }
                            $eIdx = -1
                            for ($i = 0; $i -lt $script:memoryDB.events.Count; $i++) {
                                if ($script:memoryDB.events[$i].id -eq $inE.id) { $eIdx = $i; break }
                            }
                            if ($eIdx -ge 0) { $script:memoryDB.events[$eIdx] = $inE }
                            else { [void]$script:memoryDB.events.Insert(0, $inE) }
                        }
                    }
                }
                Save-DB
            }
            Send-JsonResponse $response @{ success = $true }
            continue
        }

        # --- API: POST /api/events/save ---
        if ($rawUrl -eq "/api/events/save" -and $request.HttpMethod -eq "POST") {
            $ev = Read-RequestBody $request
            if ($ev -and $ev.id) {
                if ($script:memoryDB.deletedEventIds -and $script:memoryDB.deletedEventIds.Contains($ev.id)) {
                    $script:memoryDB.deletedEventIds.Remove($ev.id)
                }
                $idx = -1
                for ($i = 0; $i -lt $script:memoryDB.events.Count; $i++) {
                    if ($script:memoryDB.events[$i].id -eq $ev.id) { $idx = $i; break }
                }
                if ($idx -ge 0) { $script:memoryDB.events[$idx] = $ev }
                else { [void]$script:memoryDB.events.Insert(0, $ev) }
                Save-DB
                Send-JsonResponse $response @{ success = $true; event = $ev }
            } else {
                Send-JsonResponse $response @{ error = "Invalid event data"; received = "$ev" } 400
            }
            continue
        }

        # --- API: POST /api/rsvp ---
        if ($rawUrl -eq "/api/rsvp" -and $request.HttpMethod -eq "POST") {
            $body = Read-RequestBody $request
            if ($body -and $body.eventId) {
                $ev = $null
                foreach ($e in $script:memoryDB.events) {
                    if ($e.id -eq $body.eventId) { $ev = $e; break }
                }
                if ($ev) {
                    $rawAtts = if ($ev.attendees) { @($ev.attendees) } else { @() }
                    $attList = [System.Collections.ArrayList]@()
                    $found = $false
                    $nowStr = [DateTime]::UtcNow.ToString("o")

                    foreach ($a in $rawAtts) {
                        if ($a.friendId -eq $body.userId) {
                            $found = $true
                            $newA = @{
                                friendId = $a.friendId
                                name = if ($body.userName) { $body.userName } else { $a.name }
                                avatar = if ($body.userAvatar) { $body.userAvatar } else { $a.avatar }
                                status = $body.status
                                comment = if ($body.comment) { $body.comment } else { $a.comment }
                                updatedAt = $nowStr
                            }
                            [void]$attList.Add($newA)
                        } else {
                            [void]$attList.Add($a)
                        }
                    }

                    if (-not $found) {
                        [void]$attList.Add(@{
                            friendId = $body.userId
                            name = if ($body.userName) { $body.userName } else { "Member" }
                            avatar = if ($body.userAvatar) { $body.userAvatar } else { "icon" }
                            status = $body.status
                            comment = if ($body.comment) { $body.comment } else { "" }
                            updatedAt = $nowStr
                        })
                    }

                    if ($ev.PSObject.Properties["attendees"]) {
                        $ev.attendees = @($attList)
                    } else {
                        $ev | Add-Member -NotePropertyName attendees -NotePropertyValue @($attList) -Force
                    }
                    Save-DB
                    Send-JsonResponse $response @{ success = $true }
                } else {
                    Send-JsonResponse $response @{ error = "Event not found"; eventId = $body.eventId } 400
                }
            } else {
                Send-JsonResponse $response @{ error = "Invalid RSVP body"; body = "$body" } 400
            }
            continue
        }

        # --- API: POST /api/friends ---
        if ($rawUrl -eq "/api/friends" -and $request.HttpMethod -eq "POST") {
            $body = Read-RequestBody $request
            if ($body -and $body.hostId -and $body.guestId -and ($body.hostId -ne $body.guestId)) {
                $hId = $body.hostId
                $gId = $body.guestId

                if (-not $script:memoryDB.users.ContainsKey($gId)) {
                    $script:memoryDB.users[$gId] = @{ id = $gId; name = $body.guestName; avatar = $body.guestAvatar }
                }
                if (-not $script:memoryDB.users.ContainsKey($hId)) {
                    $script:memoryDB.users[$hId] = @{ id = $hId; name = $body.hostName; avatar = $body.hostAvatar }
                }

                if (-not $script:memoryDB.userFriends.ContainsKey($hId)) {
                    $script:memoryDB.userFriends[$hId] = [System.Collections.ArrayList]@()
                }
                $hFriends = $script:memoryDB.userFriends[$hId]
                $foundG = $hFriends | Where-Object { $_.id -eq $gId }
                if (-not $foundG) {
                    [void]$hFriends.Add(@{ id = $gId; name = $body.guestName; avatar = $body.guestAvatar; note = "Added via invite" })
                }

                if (-not $script:memoryDB.userFriends.ContainsKey($gId)) {
                    $script:memoryDB.userFriends[$gId] = [System.Collections.ArrayList]@()
                }
                $gFriends = $script:memoryDB.userFriends[$gId]
                $foundH = $gFriends | Where-Object { $_.id -eq $hId }
                if (-not $foundH) {
                    [void]$gFriends.Add(@{ id = $hId; name = $body.hostName; avatar = $body.hostAvatar; note = "Added via invite" })
                }

                Save-DB
                Send-JsonResponse $response @{ success = $true }
            } else {
                Send-JsonResponse $response @{ success = $true; ignored = $true }
            }
            continue
        }

        # --- API: POST /api/events/delete ---
        if ($rawUrl -eq "/api/events/delete" -and $request.HttpMethod -eq "POST") {
            $body = Read-RequestBody $request
            if ($body -and $body.eventId) {
                for ($i = $script:memoryDB.events.Count - 1; $i -ge 0; $i--) {
                    if ($script:memoryDB.events[$i].id -eq $body.eventId) {
                        $script:memoryDB.events.RemoveAt($i)
                    }
                }
                if ($script:memoryDB.deletedEventIds -and (-not $script:memoryDB.deletedEventIds.Contains($body.eventId))) {
                    [void]$script:memoryDB.deletedEventIds.Add($body.eventId)
                    if ($script:memoryDB.deletedEventIds.Count -gt 500) {
                        $script:memoryDB.deletedEventIds.RemoveAt(0)
                    }
                }
                Save-DB
                Send-JsonResponse $response @{ success = $true }
            } else {
                Send-JsonResponse $response @{ error = "Invalid event ID" } 400
            }
            continue
        }

        # --- API: POST /api/friends/delete ---
        if ($rawUrl -eq "/api/friends/delete" -and $request.HttpMethod -eq "POST") {
            $body = Read-RequestBody $request
            if ($body -and $body.userId -and $body.friendId) {
                if ($script:memoryDB.userFriends.ContainsKey($body.userId)) {
                    $list = $script:memoryDB.userFriends[$body.userId]
                    for ($i = $list.Count - 1; $i -ge 0; $i--) {
                        if ($list[$i].id -eq $body.friendId) {
                            $list.RemoveAt($i)
                        }
                    }
                    Save-DB
                }
                Send-JsonResponse $response @{ success = $true }
            } else {
                Send-JsonResponse $response @{ error = "Invalid delete request" } 400
            }
            continue
        }

        # --- API: POST /api/groups/update ---
        if ($rawUrl -eq "/api/groups/update" -and $request.HttpMethod -eq "POST") {
            $grp = Read-RequestBody $request
            if ($grp -and $grp.id) {
                $idx = -1
                for ($i = 0; $i -lt $script:memoryDB.groups.Count; $i++) {
                    if ($script:memoryDB.groups[$i].id -eq $grp.id) { $idx = $i; break }
                }
                if ($idx -ge 0) { $script:memoryDB.groups[$idx] = $grp }
                else { [void]$script:memoryDB.groups.Add($grp) }
                Save-DB
                Send-JsonResponse $response @{ success = $true }
            } else {
                Send-JsonResponse $response @{ error = "Invalid group" } 400
            }
            continue
        }

        # --- API: POST /api/groups/delete ---
        if ($rawUrl -eq "/api/groups/delete" -and $request.HttpMethod -eq "POST") {
            $body = Read-RequestBody $request
            if ($body -and $body.groupId) {
                for ($i = $script:memoryDB.groups.Count - 1; $i -ge 0; $i--) {
                    if ($script:memoryDB.groups[$i].id -eq $body.groupId) {
                        $script:memoryDB.groups.RemoveAt($i)
                    }
                }
                Save-DB
                Send-JsonResponse $response @{ success = $true }
            } else {
                Send-JsonResponse $response @{ error = "Invalid group ID" } 400
            }
            continue
        }

        # --- 静的ファイル配信 ---
        if ($rawUrl -eq "/" -or [string]::IsNullOrEmpty($rawUrl)) {
            $rawUrl = "/index.html"
        }

        $decodedPath = [System.Uri]::UnescapeDataString($rawUrl)
        $filePath = Join-Path $Root ($decodedPath.TrimStart('/'))

        if (Test-Path $filePath -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
            $contentType = if ($mimeTypes.ContainsKey($ext)) { $mimeTypes[$ext] } else { "application/octet-stream" }
            $response.ContentType = $contentType
            $response.StatusCode = 200

            $bytes = [System.IO.File]::ReadAllBytes($filePath)
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $response.StatusCode = 404
            $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
            $response.ContentLength64 = $msg.Length
            $response.OutputStream.Write($msg, 0, $msg.Length)
        }
        $response.OutputStream.Close()
    } catch {
        # ignore context errors
    }
}
