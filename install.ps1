#Requires -Version 5.1
<#
.SYNOPSIS
    Install the opencode `bg` background-command tool into a user's opencode config.

.DESCRIPTION
    Copies tools/bg.js into the global opencode tools directory so that opencode
    loads `bg_start` / `bg_stop` on next start.

    Idempotent and non-interactive: safe to run from an AI agent or CI.

.PARAMETER ConfigDir
    Target opencode config directory. Defaults to $env:OPENCODE_CONFIG_DIR,
    then $HOME/.config/opencode.

.PARAMETER Force
    Overwrite an existing bg.js without backing it up.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1
#>
[CmdletBinding()]
param(
    [string]$ConfigDir,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Write-Info($msg) { Write-Host "[bg-install] $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "[bg-install] $msg" -ForegroundColor Yellow }

if (-not $ConfigDir -or $ConfigDir.Trim() -eq '') {
    if ($env:OPENCODE_CONFIG_DIR -and $env:OPENCODE_CONFIG_DIR.Trim() -ne '') {
        $ConfigDir = $env:OPENCODE_CONFIG_DIR
    }
    else {
        $ConfigDir = Join-Path $HOME '.config/opencode'
    }
}

$source = Join-Path $PSScriptRoot 'tools/bg.js'
if (-not (Test-Path -LiteralPath $source)) {
    throw "Source file not found: $source. Run this script from the repository root."
}

$toolsDir = Join-Path $ConfigDir 'tools'
$target = Join-Path $toolsDir 'bg.js'

Write-Info "Config dir : $ConfigDir"
Write-Info "Source     : $source"
Write-Info "Target     : $target"

if (-not (Test-Path -LiteralPath $ConfigDir)) {
    New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
    Write-Info "Created config dir."
}

if (-not (Test-Path -LiteralPath $toolsDir)) {
    New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null
    Write-Info "Created tools dir."
}

if (Test-Path -LiteralPath $target) {
    $existing = Get-FileHash -LiteralPath $target -Algorithm SHA256
    $incoming = Get-FileHash -LiteralPath $source -Algorithm SHA256
    if ($existing.Hash -eq $incoming.Hash) {
        Write-Info "bg.js is already up to date. Nothing to do."
        Write-Info "If opencode is running, restart it to (re)load the tool."
        exit 0
    }

    if (-not $Force) {
        $backup = "$target.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Copy-Item -LiteralPath $target -Destination $backup -Force
        Write-Warn "Existing bg.js backed up to: $backup"
        Write-Warn "Pass -Force to overwrite without a backup."
    }
}

Copy-Item -LiteralPath $source -Destination $target -Force
Write-Info "Installed bg.js."

# Best-effort sanity check: the file must be loadable as an ES module.
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    try {
        & node --check $target 2>$null
        Write-Info "Syntax check passed."
    }
    catch {
        Write-Warn "Syntax check failed. The file may not load correctly."
    }
}
else {
    Write-Warn "node not found; skipped syntax check."
}

Write-Info ""
Write-Info "Done. Restart opencode for the tool to take effect."
Write-Info "After restart you get two tools: bg_start and bg_stop."
