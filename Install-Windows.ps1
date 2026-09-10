[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$SourceRoot = $PSScriptRoot
$InstallRoot = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "MarkItDownVaultApp"

function Find-CompatiblePython {
    $Candidates = @()
    $Command = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($Command) {
        $Candidates += $Command.Source
    }
    $Candidates += @(
        (Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Programs\Python\Python313\python.exe"),
        (Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Programs\Python\Python312\python.exe"),
        (Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Programs\Python\Python311\python.exe"),
        (Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Programs\Python\Python310\python.exe")
    )
    foreach ($Candidate in ($Candidates | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $Candidate)) {
            continue
        }
        try {
            $Compatible = & $Candidate -c "import sys; print(int((3,10) <= sys.version_info[:2] < (3,14)))"
            if ($LASTEXITCODE -eq 0 -and $Compatible -eq "1") {
                return $Candidate
            }
        } catch {
            continue
        }
    }
    return $null
}

$PythonExe = Find-CompatiblePython
if (-not $PythonExe) {
    $Winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $Winget) {
        throw "Python 3.10-3.13 is required. Install Python 3.12 from python.org and run this installer again."
    }
    Write-Host "Installing Python 3.12 for the current Windows user..."
    & $Winget.Source install --id Python.Python.3.12 --exact --scope user --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        throw "Python 3.12 installation failed."
    }
    $PythonExe = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Programs\Python\Python312\python.exe"
    if (-not (Test-Path -LiteralPath $PythonExe)) {
        throw "Python was installed but could not be located. Sign out and try again."
    }
}

Write-Host "Installing MarkItDown Vault locally..."
New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
$Items = @("scripts", "web", "references", "agents", "SKILL.md", "README.md", "LICENSE", "Launch-MarkItDown-Vault.ps1")
foreach ($Item in $Items) {
    $Source = Join-Path $SourceRoot $Item
    if (Test-Path -LiteralPath $Source) {
        Copy-Item -LiteralPath $Source -Destination $InstallRoot -Recurse -Force
    }
}

& (Join-Path $InstallRoot "scripts\setup.ps1") -PythonCommand $PythonExe
if ($LASTEXITCODE -ne 0) {
    throw "MarkItDown Vault setup failed."
}

$Desktop = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $Desktop "MarkItDown Vault.lnk"
$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = "powershell.exe"
$Shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $InstallRoot "Launch-MarkItDown-Vault.ps1") + '"'
$Shortcut.WorkingDirectory = $InstallRoot
$Shortcut.Description = "Open MarkItDown Vault"
$Shortcut.Save()

Write-Host "Installation complete. A desktop shortcut was created."
& (Join-Path $InstallRoot "Launch-MarkItDown-Vault.ps1")

