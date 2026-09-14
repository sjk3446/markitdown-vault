[CmdletBinding()]
param(
    [string] $PythonCommand = ""
)

$ErrorActionPreference = "Stop"
$SkillRoot = Split-Path -Parent $PSScriptRoot
$VenvPath = Join-Path $SkillRoot ".venv"
$PythonExe = Join-Path $VenvPath "Scripts\python.exe"

if (-not $PythonCommand) {
    $BundledPython = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
    $PythonCommand = if (Test-Path -LiteralPath $BundledPython) {
        $BundledPython
    } else {
        "python"
    }
}

if (-not (Test-Path -LiteralPath $PythonExe)) {
    & $PythonCommand -m venv $VenvPath
    if ($LASTEXITCODE -ne 0) {
        throw "Could not create the Python virtual environment."
    }
}

& $PythonExe -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) {
    throw "Could not upgrade pip."
}

& $PythonExe -m pip install `
    "markitdown[pptx,docx,xlsx,xls,pdf,outlook,audio-transcription,youtube-transcription]" `
    markitdown-ocr "pymupdf>=1.24,<1.27" openai imageio-ffmpeg `
    fastapi "uvicorn[standard]" python-multipart keyring
if ($LASTEXITCODE -ne 0) {
    throw "Could not install MarkItDown dependencies. Python 3.10-3.13 may be required on this machine."
}

& $PythonExe (Join-Path $PSScriptRoot "mdvault.py") init
if ($LASTEXITCODE -ne 0) {
    throw "Dependencies were installed, but vault initialization failed."
}

Write-Host "MarkItDown Vault setup complete."
Write-Host "Run: $PSScriptRoot\mdvault.ps1 status"
Write-Host "Browser: $PSScriptRoot\start-web.ps1"
