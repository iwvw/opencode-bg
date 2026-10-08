#Requires -Version 5.1
<#
.SYNOPSIS
    Install the opencode `bg` background-command tool into a user's opencode config.

.DESCRIPTION
    Copies tools/bg.js into the global opencode tools directory so that opencode
    loads `bg_start` / `bg_logs` / `bg_list` / `bg_restart` / `bg_stop` on next
    start, and appends the "long-running commands" convention to instructions.md
    (so the agent knows to use it).

    Idempotent and non-interactive: safe to run from an AI agent or CI.

.PARAMETER ConfigDir
    Target opencode config directory. Defaults to $env:OPENCODE_CONFIG_DIR,
    then $HOME/.config/opencode.

.PARAMETER Force
    Overwrite an existing bg.js without backing it up.

.PARAMETER SkipInstructions
    Do not touch instructions.md.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1
#>
[CmdletBinding()]
param(
    [string]$ConfigDir,
    [switch]$Force,
    [switch]$SkipInstructions
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

# ---- 1. Install bg.js ----
$needRestart = $true
if (Test-Path -LiteralPath $target) {
    $existing = Get-FileHash -LiteralPath $target -Algorithm SHA256
    $incoming = Get-FileHash -LiteralPath $source -Algorithm SHA256
    if ($existing.Hash -eq $incoming.Hash) {
        Write-Info "bg.js is already up to date."
        $needRestart = $false
    }
    elseif (-not $Force) {
        $backup = "$target.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Copy-Item -LiteralPath $target -Destination $backup -Force
        Write-Warn "Existing bg.js backed up to: $backup"
        Write-Warn "Pass -Force to overwrite without a backup."
    }
}

if ($needRestart) {
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
}

# ---- 2. Append the convention to instructions.md ----
if (-not $SkipInstructions) {
    $snippetPath = Join-Path $PSScriptRoot 'instructions-snippet.md'
    if (Test-Path -LiteralPath $snippetPath) {
        $instructionsPath = Join-Path $ConfigDir 'instructions.md'
        $marker = '长时命令后台执行约定'
        $snippet = (Get-Content -LiteralPath $snippetPath -Raw).TrimEnd()

        $already = (Test-Path -LiteralPath $instructionsPath) -and
            (Select-String -LiteralPath $instructionsPath -SimpleMatch $marker -Quiet)

        if ($already) {
            Write-Info "instructions.md already contains the convention. Skipping."
        }
        else {
            if (-not (Test-Path -LiteralPath $instructionsPath)) {
                New-Item -ItemType File -Path $instructionsPath -Force | Out-Null
                Write-Info "Created instructions.md."
            }
            $prefix = "`n`n"
            Add-Content -LiteralPath $instructionsPath -Value ($prefix + $snippet) -Encoding utf8
            Write-Info "Appended the long-running-commands convention to instructions.md."
        }
    }
    else {
        Write-Warn "instructions-snippet.md not found; skipped instructions.md update."
    }
}

Write-Info ""
if ($needRestart) {
    Write-Info "Done. Restart opencode for the tool to take effect."
}
else {
    Write-Info "Nothing changed. If opencode is running, restart it to (re)load the tool."
}
Write-Info "After restart you get five tools: bg_start, bg_logs, bg_list, bg_restart, bg_stop."
