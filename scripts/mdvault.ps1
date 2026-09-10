[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $RemainingArgs
)

$ErrorActionPreference = "Stop"
$SkillRoot = Split-Path -Parent $PSScriptRoot
$PythonExe = Join-Path $SkillRoot ".venv\Scripts\python.exe"
$CliScript = Join-Path $PSScriptRoot "mdvault.py"

if (-not (Test-Path -LiteralPath $PythonExe)) {
    throw "MarkItDown Vault is not set up. Run '$PSScriptRoot\setup.ps1' first."
}

& $PythonExe $CliScript @RemainingArgs
exit $LASTEXITCODE
