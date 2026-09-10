[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$PublicUrl = "https://sjk3446.github.io/markitdown-vault/"
$StatusUrl = "http://127.0.0.1:8787/api/status"
$StartScript = Join-Path $PSScriptRoot "scripts\start-web.ps1"

$Ready = $false
try {
    $Status = Invoke-RestMethod -Uri $StatusUrl -TimeoutSec 2
    $Ready = [bool]$Status.ready
} catch {
    $Ready = $false
}

if (-not $Ready) {
    $QuotedStartScript = '"' + $StartScript + '"'
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $QuotedStartScript,
        "-NoBrowser",
        "-Port", "8787"
    )
    for ($Attempt = 0; $Attempt -lt 60; $Attempt++) {
        Start-Sleep -Milliseconds 500
        try {
            $Status = Invoke-RestMethod -Uri $StatusUrl -TimeoutSec 2
            if ($Status.ready) {
                $Ready = $true
                break
            }
        } catch {
            continue
        }
    }
}

Start-Process $PublicUrl
if (-not $Ready) {
    throw "The local converter did not start. Check whether port 8787 is already in use."
}

