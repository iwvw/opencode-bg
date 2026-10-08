#Requires -Version 5.1
<#
.SYNOPSIS
    Install the opencode `bg` background-command tool into a user's opencode config.

.DESCRIPTION
    Copies tools/bg.js into the global opencode tools directory so that opencode
    loads `bg_start` / `bg_logs` / `bg_list` / `bg_restart` / `bg_stop` on next
    start, and installs the "long-running commands" convention into
    instructions.md (so the agent knows to use it). The convention is written as
    a managed BEGIN/END block, so re-running updates it in place.

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

# ---- 2. Install (or update) the convention in instructions.md ----
# The snippet is wrapped in BEGIN/END markers. On re-run we replace just that
# block, so snippet updates stay in sync. A legacy unmarked section is migrated
# once; otherwise we append a fresh block.
$changed = $needRestart
if (-not $SkipInstructions) {
    $snippetPath = Join-Path $PSScriptRoot 'instructions-snippet.md'
    if (Test-Path -LiteralPath $snippetPath) {
        $instructionsPath = Join-Path $ConfigDir 'instructions.md'
        $beginMarker = '<!-- BEGIN opencode-bg convention -->'
        $endMarker = '<!-- END opencode-bg convention -->'
        $legacyMarker = '长时命令后台执行约定'
        $snippet = (Get-Content -LiteralPath $snippetPath -Raw -Encoding UTF8).TrimEnd()

        $existing = $null
        if (Test-Path -LiteralPath $instructionsPath) {
            $existing = Get-Content -LiteralPath $instructionsPath -Raw -Encoding UTF8
        }

        if ($existing -and $existing.Contains($beginMarker) -and $existing.Contains($endMarker)) {
            $startIdx = $existing.IndexOf($beginMarker)
            $endIdx = $existing.IndexOf($endMarker) + $endMarker.Length
            $updated = $existing.Substring(0, $startIdx) + $snippet + $existing.Substring($endIdx)
            if ($updated -ne $existing) {
                Set-Content -LiteralPath $instructionsPath -Value $updated -Encoding utf8
                $changed = $true
                Write-Info "Updated the managed convention block in instructions.md."
            }
            else {
                Write-Info "instructions.md convention block is already up to date."
            }
        }
        elseif ($existing -and $existing.Contains($legacyMarker)) {
            $m = [regex]::Match($existing, '(?ms)^#\s*' + [regex]::Escape($legacyMarker) + '.*?(?=^#\s|\z)')
            if ($m.Success) {
                $updated = $existing.Substring(0, $m.Index) + $snippet + "`n`n" + $existing.Substring($m.Index + $m.Length)
                Set-Content -LiteralPath $instructionsPath -Value $updated.TrimEnd() -Encoding utf8
                $changed = $true
                Write-Info "Migrated the legacy convention in instructions.md to a managed block."
            }
        }
        else {
            if (-not (Test-Path -LiteralPath $instructionsPath)) {
                New-Item -ItemType File -Path $instructionsPath -Force | Out-Null
                Write-Info "Created instructions.md."
            }
            $prefix = if ($existing -and $existing.Trim().Length -gt 0) { "`n`n" } else { "" }
            Add-Content -LiteralPath $instructionsPath -Value ($prefix + $snippet) -Encoding utf8
            $changed = $true
            Write-Info "Appended the long-running-commands convention to instructions.md."
        }
    }
    else {
        Write-Warn "instructions-snippet.md not found; skipped instructions.md update."
    }
}

Write-Info ""
if ($changed) {
    Write-Info "Done. Restart opencode for changes to take effect."
}
else {
    Write-Info "Nothing changed. If opencode is running, restart it to (re)load the tool."
}
Write-Info "After restart you get five tools: bg_start, bg_logs, bg_list, bg_restart, bg_stop."
