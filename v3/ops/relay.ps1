# Keeps a CEO running for the Alexia v3 build, one after another (see v3/ops/CEO.md §12, §14).
#
# Start (from the repo root, in its own PowerShell window, and leave it open):
#   powershell -ExecutionPolicy Bypass -File v3\ops\relay.ps1
# Stop: create an empty file v3\ops\STOP. The current CEO finishes and the relay exits.
#
# Each CEO is a fresh headless Claude Code session with permission prompts off, so run this in
# a Windows account that holds only this work.

$ErrorActionPreference = 'Continue'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repo
$ops  = Join-Path $repo 'v3\ops'
$log  = Join-Path $ops 'relay.log'
$stop = Join-Path $ops 'STOP'

$prompt = 'Read v3/ops/CEO.md in full and act as the CEO it describes. You were started by the relay as a successor CEO: skip section 6 (First run) and begin at section 7 (Every run).'

function Note($text) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $text" | Add-Content -Path $log }

$crashes = 0
$ceo = 0
while ($true) {
    if (Test-Path $stop) { Note 'STOP file found. Relay exiting.'; break }

    $ceo++
    Note "Starting CEO run $ceo"
    $out = & claude -p $prompt --model opus --dangerously-skip-permissions 2>&1 | Out-String
    $tail = (($out -split "`r?`n") | Select-Object -Last 30) -join "`n"
    Note "CEO run $ceo ended. Last lines:`n$tail"

    if ($out -match 'ALEXIA-CEO: DONE') { Note 'Build finished.'; break }
    if ($out -match 'ALEXIA-CEO: HANDOFF') { $crashes = 0; Start-Sleep -Seconds 10; continue }
    if ($out -match 'ALEXIA-CEO: WAITING-OWNER') { $crashes = 0; Note 'Waiting on the owner, checking again in 15 minutes.'; Start-Sleep -Seconds 900; continue }
    if ($out -match '(?i)ALEXIA-CEO: LIMIT|usage limit|rate limit|limit reached|limit will reset|resets at') {
        $crashes = 0; Note 'Usage limit. Waiting 20 minutes.'; Start-Sleep -Seconds 1200; continue
    }

    $crashes++
    $wait = [Math]::Min(1800, 60 * $crashes)
    Note "No marker (crash $crashes in a row). Waiting $wait seconds."
    Start-Sleep -Seconds $wait
}
