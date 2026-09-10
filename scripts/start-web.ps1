[CmdletBinding()]
param(
    [int] $Port = 8787,
    [string] $Vault = "",
    [switch] $NoBrowser
)

$ErrorActionPreference = "Stop"
$SkillRoot = Split-Path -Parent $PSScriptRoot
$PythonExe = Join-Path $SkillRoot ".venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $PythonExe)) {
    throw "MarkItDown Vault is not installed. Run $PSScriptRoot\setup.ps1 first."
}

$Arguments = @(
    (Join-Path $PSScriptRoot "webapp.py"),
    "--host", "127.0.0.1",
    "--port", $Port
)
if ($Vault) {
    $Arguments += @("--vault", $Vault)
}
if (-not $NoBrowser) {
    $Arguments += "--open"
}

Write-Host "MarkItDown Vault: http://127.0.0.1:$Port"
Write-Host "Stop with Ctrl+C."
& $PythonExe @Arguments
