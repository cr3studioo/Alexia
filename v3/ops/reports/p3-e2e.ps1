# SPDX-License-Identifier: AGPL-3.0-only
# P3-33: the real alexia-hub built from this checkout, run on this PC against a copy of the hub's
# data folder, and checked end to end.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File v3\ops\reports\p3-e2e.ps1
#
#   -DryRun     steps 1, 2, 4 and 5 only. No hub is started and nothing is sent to Telegram.
#   -Seen y|n   step 6: the owner's answer, given here instead of being asked for.
#   -Seen skip  step 6: no brief is asked for.
#   (no -Seen)  step 6 asks with Read-Host; with no console input the brief is still asked for,
#               but the step is SKIPPED, because nobody confirmed that it arrived.
#   -RealData   use the owner's real data folder, not a copy. Only when the owner says so.
#   -KeepData   keep the scratch copy afterwards (it is removed otherwise).
#
# Windows PowerShell 5.1, in the owner's desktop session. Results and logs: %TEMP%\p3-e2e\
# (transcript.txt, results.json, one log per step). notices.log there holds the owner's notice
# text: it stays on this PC, and only counts are printed.
#
# Exit code: 0 no FAIL; 1 at least one FAIL; 2 a hub is already running, so the script stopped.
# It stops only processes it started itself. It never stops the owner's hub, never installs
# anything at sign-in, and never reads a token or the keychain itself.
#
# What a full run does besides the checks: the scratch hub is a real hub on a copy of the data.
# It uses the real bot (messages sent to the bot while it runs go to it, not to the owner's hub),
# and whatever is due in the copied data (reminders, scheduled tasks, unfinished runs) runs.
param(
    [ValidateSet('y', 'n', 'skip', '')] [string]$Seen = '',
    [switch]$DryRun,
    [switch]$RealData,
    [switch]$KeepData
)

$ErrorActionPreference = 'Continue'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$V3 = Join-Path $Repo 'v3'
$PluginsDir = Join-Path $Repo 'plugins'
$Out = Join-Path ([IO.Path]::GetFullPath($env:TEMP)) 'p3-e2e'
$RealDir = Join-Path $env:LOCALAPPDATA 'AlexiaHub'
$Scratch = Join-Path $Out ('data-{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $PID)
$Data = if ($RealData) { $RealDir } else { $Scratch }

# The plugins P3 added or changed (v3/specs/P3/PHASE.md: D-P3-10 and the crates table; P3-34).
$P3Plugins = @('apple-context', 'commitments', 'computer', 'day-planner', 'errand-kit', 'google-account',
    'mail-desk', 'memory', 'microsoft-account', 'notes-library', 'page-watch', 'screen-memory',
    'study-desk', 'task-list')
$EmptySilent = 'The list is empty: on her own she asks before anything that changes something.'

if ($DryRun -and $RealData) {
    Write-Host '-DryRun works on a copy only; it cannot be used with -RealData.'
    exit 1
}
New-Item -ItemType Directory -Force -Path $Out | Out-Null
try { Start-Transcript -Path (Join-Path $Out 'transcript.txt') -Force | Out-Null } catch { }

$Steps = New-Object System.Collections.ArrayList
$Warnings = New-Object System.Collections.ArrayList
$Ours = @{}                                       # pid -> start time, processes this run started
$Roots = New-Object System.Collections.ArrayList  # held so Windows cannot give their pids away
$NoticeCounts = @()
$HubProc = $null
$HubUp = $false
$Blocked = $false

$EnvNames = @('ALEXIA_V3_DATA', 'ALEXIA_PLUGINS_DIR', 'ALEXIA_HUB_STOP_ON_EOF', 'ALEXIA_SECRETS_IN_MEMORY',
    'ALEXIA_WINDOW_PORT', 'ALEXIA_UI_DIR', 'CARGO_BUILD_JOBS', 'CARGO_TARGET_DIR', 'OPENSSL_SRC_PERL')
$EnvBefore = @{}
foreach ($n in $EnvNames) { $EnvBefore[$n] = [Environment]::GetEnvironmentVariable($n, 'Process') }

function Add-Step([string]$Name, [string]$Result, [string]$Detail) {
    [void]$Steps.Add([pscustomobject]@{ step = $Name; result = $Result; detail = $Detail })
    Write-Host ('[{0}] {1}: {2}' -f $Result, $Name, $Detail)
}

function Add-Warn([string]$Name, [string]$Detail) {
    [void]$Warnings.Add([pscustomobject]@{ step = $Name; detail = $Detail })
    Write-Host ('[WARN] {0}: {1}' -f $Name, $Detail)
}

function Get-RunningHub {
    $found = @()
    foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='alexia-hub.exe'")) {
        $found += 'process alexia-hub.exe, pid {0}, started {1}, from {2}' -f $p.ProcessId, $p.CreationDate, $p.ExecutablePath
    }
    $lock = Join-Path $RealDir 'hub.lock'
    if (Test-Path $lock) {
        # A running hub opens this file so that nobody else can.
        try { $f = [IO.File]::Open($lock, 'Open', 'Read', 'None'); $f.Close() }
        catch { $found += "the hub lock in the data folder is held ($lock)" }
    }
    $found
}

function Stop-ForRunningHub([string[]]$Found) {
    $script:Blocked = $true
    Write-Host ''
    Write-Host 'A hub is already running on this PC:'
    $Found | ForEach-Object { Write-Host "  $_" }
    Write-Host 'Please stop it (quit Alexia, or press Ctrl+C in its window), then run this script again.'
    Write-Host 'This script does not stop it.'
    Write-Host ''
}

# Adds the children of processes this run started. A child is taken only from a parent that is a
# root (its pid is held) or is verifiably still the same live process, so a reused pid is never ours.
function Update-Ours {
    $all = @(Get-CimInstance Win32_Process)
    $byPid = @{}
    foreach ($p in $all) { $byPid[[int]$p.ProcessId] = $p }
    $rootIds = @($Roots | ForEach-Object { $_.Id })
    do {
        $added = $false
        foreach ($p in $all) {
            $id = [int]$p.ProcessId
            $parent = [int]$p.ParentProcessId
            if ($Ours.ContainsKey($id) -or -not $Ours.ContainsKey($parent)) { continue }
            if ($p.CreationDate -lt $Ours[$parent]) { continue }
            $live = $byPid.ContainsKey($parent) -and [math]::Abs(($byPid[$parent].CreationDate - $Ours[$parent]).TotalSeconds) -lt 2
            if (($rootIds -contains $parent) -or $live) { $Ours[$id] = $p.CreationDate; $added = $true }
        }
    } while ($added)
}

function Get-LeftOver {
    Update-Ours
    @(Get-CimInstance Win32_Process | Where-Object {
            $id = [int]$_.ProcessId
            $Ours.ContainsKey($id) -and [math]::Abs(($_.CreationDate - $Ours[$id]).TotalSeconds) -lt 2
        })
}

function Add-Root($Process) {
    [void]$Roots.Add($Process)
    try { $Ours[$Process.Id] = $Process.StartTime.AddMilliseconds(-500) } catch { $Ours[$Process.Id] = (Get-Date).AddSeconds(-1) }
}

function Stop-OwnTree([int]$ProcessId) {
    # Only ever a pid this script started.
    cmd /c "taskkill /F /T /PID $ProcessId > nul 2>&1" | Out-Null
}

function Invoke-Logged([string]$Name, [string]$Command, [string]$Dir) {
    # cmd.exe does the redirect, so Windows PowerShell 5.1 does not wrap native stderr in errors.
    $log = Join-Path $Out ($Name + '.log')
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Push-Location $Dir
    try { cmd /c "$Command > `"$log`" 2>&1"; $code = $LASTEXITCODE } finally { Pop-Location }
    $sw.Stop()
    [pscustomobject]@{ code = $code; seconds = [int]$sw.Elapsed.TotalSeconds; log = $log }
}

# One CLI verb of the built hub, with a time limit. Output goes to <name>.log and <name>.err.log.
function Invoke-Hub([string]$Name, [string]$Arguments, [int]$TimeoutSec) {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $HubExe
    $psi.Arguments = $Arguments
    $psi.WorkingDirectory = $V3
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
    $p = [Diagnostics.Process]::Start($psi)
    Add-Root $p
    $p.StandardInput.Close()
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()
    $end = (Get-Date).AddSeconds($TimeoutSec)
    $done = $false
    while (-not $done -and (Get-Date) -lt $end) {
        $done = $p.WaitForExit(1000)
        if (-not $done) { Update-Ours }
    }
    if (-not $done) { Stop-OwnTree $p.Id; [void]$p.WaitForExit(15000) }
    Update-Ours
    $stdout = if ($outTask.Wait(15000)) { $outTask.Result } else { '' }
    $stderr = if ($errTask.Wait(15000)) { $errTask.Result } else { '' }
    [IO.File]::WriteAllText((Join-Path $Out ($Name + '.log')), $stdout)
    [IO.File]::WriteAllText((Join-Path $Out ($Name + '.err.log')), $stderr)
    $code = if ($done) { $p.ExitCode } else { -1 }
    [pscustomobject]@{ code = $code; out = $stdout; err = $stderr; timedOut = (-not $done) }
}

function Get-FailText($Result) {
    $how = if ($Result.timedOut) { 'did not finish in time' } else { "exit $($Result.code)" }
    $last = @($Result.err -split "`r?`n" | Where-Object { $_.Trim() }) | Select-Object -Last 1
    "$how; $last"
}

function Read-Lines([string]$Path) {
    if (Test-Path $Path) { @(Get-Content -Path $Path -Encoding UTF8) } else { @() }
}

try {
    $commit = (git -C $Repo rev-parse HEAD).Trim()
    $dirty = [bool](git -C $Repo status --porcelain -- v3/crates v3/Cargo.toml v3/Cargo.lock plugins packages)
    $mode = if ($DryRun) { 'dry run' } else { 'full' }
    Write-Host ("P3 end to end ({0}). Commit {1}{2}" -f $mode, $commit, $(if ($dirty) { ', with uncommitted code changes' } else { '' }))
    Write-Host "Logs: $Out"
    if (@(Get-Process -Name alexia -ErrorAction SilentlyContinue).Count -gt 0) {
        Write-Host 'Note: an alexia.exe app is running. If it talks to the same Telegram bot, step 6 may not arrive.'
    }

    $found = @(Get-RunningHub)
    if ($found.Count -gt 0) { Stop-ForRunningHub $found }
    $ok = -not $Blocked
    $why = 'a hub is already running; stop it and run this script again'

    # ============ 1. Build ============
    $HubExe = $null
    if ($ok) {
        $env:CARGO_BUILD_JOBS = '1'
        # Rust build output goes to D: on this PC (v3/ops/OWNER.md A-23) unless the caller chose.
        if (-not $env:CARGO_TARGET_DIR -and (Test-Path 'D:\alexia-target')) {
            $env:CARGO_TARGET_DIR = Join-Path 'D:\alexia-target' (Split-Path $Repo -Leaf)
        }
        $perl = 'C:\dev\Alexia-wt\tools\strawberry-perl\perl\bin\perl.exe'
        if (-not $env:OPENSSL_SRC_PERL -and (Test-Path $perl)) { $env:OPENSSL_SRC_PERL = $perl }
        if (@(Get-Process -Name rustc -ErrorAction SilentlyContinue).Count -gt 0) {
            Write-Host 'Note: another Rust build is running; this PC is short of memory for two.'
        }
        $a = Invoke-Logged '1a-pnpm-install' 'pnpm install --frozen-lockfile' $Repo
        $b = $null; $c = $null
        if ($a.code -eq 0) { $b = Invoke-Logged '1b-sdk' 'pnpm exec tsc -b packages/sdk' $Repo }
        if ($b -and $b.code -eq 0) { $c = Invoke-Logged '1c-cargo' 'cargo build -p alexia-hub --release' $V3 }
        if ($c -and $c.code -eq 0) {
            Push-Location $V3
            try { $meta = (cargo metadata --no-deps --format-version 1) -join '' | ConvertFrom-Json } finally { Pop-Location }
            $exe = Join-Path $meta.target_directory 'release\alexia-hub.exe'
            if (Test-Path $exe) { $HubExe = $exe }
        }
        if ($HubExe) {
            Add-Step '1 build' 'PASS' ('pnpm install {0} s, plugin SDK {1} s, cargo build --release {2} s' -f $a.seconds, $b.seconds, $c.seconds)
        } else {
            $bad = @($a, $b, $c | Where-Object { $_ }) | Select-Object -Last 1
            Add-Step '1 build' 'FAIL' ("no hub binary; exit {0}, see {1}`n{2}" -f $bad.code, $bad.log, ((Read-Lines $bad.log | Select-Object -Last 20) -join "`n"))
            $ok = $false; $why = 'the build failed'
        }
    } else { Add-Step '1 build' 'SKIPPED' $why }

    # A build takes minutes: look again before touching the data folder.
    if ($ok) {
        $found = @(Get-RunningHub)
        if ($found.Count -gt 0) { Stop-ForRunningHub $found; $ok = $false; $why = 'a hub was started during the build; stop it and run this script again' }
    }

    # ============ 2. Data ============
    $encrypted = $false
    if (-not $ok) { Add-Step '2 data' 'SKIPPED' $why }
    elseif ($RealData) {
        if (Test-Path (Join-Path $RealDir 'alexia.db')) { Add-Step '2 data' 'SKIPPED' 'no copy made: -RealData uses the real data folder' }
        else { Add-Step '2 data' 'FAIL' 'the real data folder has no database'; $ok = $false; $why = 'there is no data' }
    }
    elseif (-not (Test-Path (Join-Path $RealDir 'alexia.db'))) {
        Add-Step '2 data' 'FAIL' 'the hub data folder has no database to copy'
        $ok = $false; $why = 'there is no data to copy'
    }
    else {
        New-Item -ItemType Directory -Force -Path $Scratch | Out-Null
        # Downloaded models and image engines are tens of GB and no check here reads them.
        $heavy = @()
        $rootModels = Join-Path $RealDir 'models'
        if (Test-Path $rootModels) { $heavy += $rootModels }
        foreach ($own in @(Get-ChildItem (Join-Path $RealDir 'plugins') -Directory -ErrorAction SilentlyContinue)) {
            foreach ($d in @(Get-ChildItem $own.FullName -Directory -ErrorAction SilentlyContinue)) {
                if ($d.Name -in 'models', 'comfyui') { $heavy += $d.FullName }
            }
        }
        $robo = @($RealDir, $Scratch, '/E', '/XJ', '/R:1', '/W:1', '/NFL', '/NDL', '/NP', '/MAX:104857600',
            '/XF', 'alexia.db*', 'hub.lock', 'window.json', 'window.json.tmp')
        if ($heavy.Count -gt 0) { $robo += '/XD'; $robo += $heavy }
        & robocopy @robo > (Join-Path $Out '2-copy.log')
        $roboCode = $LASTEXITCODE
        $dbOk = $true
        foreach ($name in 'alexia.db', 'alexia.db-wal', 'alexia.db-shm', 'alexia.db.keyed') {
            $src = Join-Path $RealDir $name
            if (Test-Path $src) {
                try { Copy-Item -LiteralPath $src -Destination (Join-Path $Scratch $name) -ErrorAction Stop }
                catch { $dbOk = $false }
            }
        }
        $copyDb = Join-Path $Scratch 'alexia.db'
        if ($roboCode -lt 8 -and $dbOk -and (Test-Path $copyDb)) {
            $head = New-Object byte[] 15
            $s = [IO.File]::OpenRead($copyDb); [void]$s.Read($head, 0, 15); $s.Close()
            $encrypted = [Text.Encoding]::ASCII.GetString($head) -ne 'SQLite format 3'
            $m = Get-ChildItem $Scratch -Recurse -Force -File | Measure-Object Length -Sum
            Add-Step '2 data' 'PASS' ('copied {0} files, {1:N1} MB to the scratch folder; database encrypted: {2}; left out: {3} model or image-engine folder(s) and files over 100 MB' -f $m.Count, ($m.Sum / 1MB), $(if ($encrypted) { 'yes' } else { 'no' }), $heavy.Count)
        } else {
            Add-Step '2 data' 'FAIL' ('the copy failed (robocopy exit {0}, database copied: {1}); see 2-copy.log' -f $roboCode, $dbOk)
            $ok = $false; $why = 'the data copy failed'
        }
    }

    if ($ok) {
        # Absolute, or the hub would fall back to the real folder.
        if (-not [IO.Path]::IsPathRooted($Data)) { throw 'The data folder path is not absolute.' }
        $env:ALEXIA_V3_DATA = $Data
        $env:ALEXIA_PLUGINS_DIR = $PluginsDir
        foreach ($n in 'ALEXIA_SECRETS_IN_MEMORY', 'ALEXIA_WINDOW_PORT', 'ALEXIA_UI_DIR', 'ALEXIA_HUB_STOP_ON_EOF') {
            [Environment]::SetEnvironmentVariable($n, $null, 'Process')
        }
        if ($DryRun) {
            if (-not $encrypted) {
                # No keychain at all: no plugin gets a token, so nothing can reach Telegram or an account.
                $env:ALEXIA_SECRETS_IN_MEMORY = '1'
                Write-Host 'Dry run: secrets are in memory, so no plugin can read a token.'
            } else {
                Write-Host 'Dry run: the database key is needed from the keychain, so plugins started by step 4 can read their own settings.'
            }
        }
    }

    # ============ 3. Start ============
    $hubLog = Join-Path $Out '3-hub.log'
    $hubErr = Join-Path $Out '3-hub.err.log'
    $noChannel = $false
    if (-not $ok) { Add-Step '3 start' 'SKIPPED' $why }
    elseif ($DryRun) { Add-Step '3 start' 'SKIPPED' '-DryRun starts no hub' }
    else {
        $found = @(Get-RunningHub)
        if ($found.Count -gt 0) {
            Stop-ForRunningHub $found; $ok = $false; $why = 'a hub was started meanwhile; stop it and run this script again'
            Add-Step '3 start' 'SKIPPED' $why
        } else {
            Remove-Item -LiteralPath $hubLog, $hubErr -ErrorAction SilentlyContinue
            $wjPath = Join-Path $Data 'window.json'
            $psi = New-Object Diagnostics.ProcessStartInfo
            $psi.FileName = $env:ComSpec
            $psi.Arguments = '/d /s /c ""{0}" run > "{1}" 2> "{2}""' -f $HubExe, $hubLog, $hubErr
            $psi.WorkingDirectory = $V3
            $psi.UseShellExecute = $false
            $psi.CreateNoWindow = $true
            $psi.RedirectStandardInput = $true          # closing it is the hub's Ctrl+C
            $sw = [Diagnostics.Stopwatch]::StartNew()
            $env:ALEXIA_HUB_STOP_ON_EOF = '1'
            try { $HubProc = [Diagnostics.Process]::Start($psi) } finally { $env:ALEXIA_HUB_STOP_ON_EOF = $null }
            Add-Root $HubProc
            $end = (Get-Date).AddSeconds(180)
            $port = 0
            while (-not $HubUp -and -not $HubProc.HasExited -and (Get-Date) -lt $end) {
                Start-Sleep -Milliseconds 500
                Update-Ours
                if (Test-Path $wjPath) {
                    try { $wj = Get-Content -Raw $wjPath | ConvertFrom-Json } catch { $wj = $null }
                    if ($wj -and $Ours.ContainsKey([int]$wj.pid)) { $HubUp = $true; $port = [int]$wj.port }
                }
            }
            $noChannel = [bool](Read-Lines $hubLog | Where-Object { $_ -like 'No channel is set up*' })
            if ($HubUp) {
                Add-Step '3 start' 'PASS' ('window.json after {0:N1} s (127.0.0.1 port {1}){2}' -f $sw.Elapsed.TotalSeconds, $port, $(if ($noChannel) { '; no channel is set up' } else { '' }))
            } else {
                $state = if ($HubProc.HasExited) { "the hub exited with $($HubProc.ExitCode)" } else { 'no window.json within 180 s' }
                Add-Step '3 start' 'FAIL' ("{0}; see {1}`n{2}" -f $state, $hubErr, ((Read-Lines $hubErr | Select-Object -Last 8) -join "`n"))
            }
        }
    }

    # ============ 4. Plugins ============
    if (-not $ok) { Add-Step '4 plugins' 'SKIPPED' $why }
    else {
        $r = Invoke-Hub '4-plugins' 'plugins' 300
        $rows = @(foreach ($line in ($r.out -split "`r?`n")) {
                $f = $line -split "`t"
                if ($f.Count -ge 4) { [pscustomobject]@{ id = $f[0]; state = $f[1]; version = $f[2]; enabled = $f[3] } }
            })
        $rows | ForEach-Object { Write-Host ('    {0}  {1}  {2}  {3}' -f $_.id, $_.version, $_.state, $_.enabled) }
        # A copy installed in the data folder's extensions\ wins over the same id in this checkout:
        # the hub says so, and the version it lists is then the installed one.
        $ignored = @(foreach ($line in ($r.err -split "`r?`n")) {
                if ($line -match 'already found in an earlier folder; ignored folder=(.+?)\s*$') {
                    $folder = $Matches[1].Trim('"')
                    if ((Split-Path $folder -Parent) -eq $PluginsDir) { Split-Path $folder -Leaf }
                }
            })
        $shadowed = @()
        $otherShadowed = @()
        foreach ($row in $rows) {
            $manifest = Join-Path $PluginsDir (Join-Path $row.id 'plugin.json')
            if (-not (Test-Path $manifest)) { continue }
            $repoVersion = (Get-Content -Raw -Encoding UTF8 $manifest | ConvertFrom-Json).version
            if ($ignored -notcontains $row.id -and $row.version -eq $repoVersion) { continue }
            $entry = '{0} (data folder {1}, repo {2})' -f $row.id, $row.version, $repoVersion
            if ($P3Plugins -contains $row.id) { $shadowed += $entry } else { $otherShadowed += $entry }
        }
        $missing = @($P3Plugins | Where-Object { @($rows | ForEach-Object { $_.id }) -notcontains $_ })
        $bad = @($rows | Where-Object { $P3Plugins -contains $_.id -and $_.state -in 'refused', 'unhealthy' } | ForEach-Object { "$($_.id) ($($_.state))" })
        $otherBad = @($rows | Where-Object { $P3Plugins -notcontains $_.id -and $_.state -in 'refused', 'unhealthy' } | ForEach-Object { "$($_.id) ($($_.state))" })
        $on = @($rows | Where-Object { $P3Plugins -contains $_.id -and $_.enabled -eq 'enabled' } | ForEach-Object { $_.id })
        $off = @($rows | Where-Object { $P3Plugins -contains $_.id -and $_.enabled -ne 'enabled' } | ForEach-Object { $_.id })
        $loaded = @($P3Plugins | Where-Object {
                $id = $_
                $missing -notcontains $id -and
                @($bad + $shadowed | Where-Object { $_.StartsWith("$id ") }).Count -eq 0
            }).Count
        $detail = '{0} plugins listed; P3 plugins loaded from this checkout {1} of {2}; enabled: {3}' -f $rows.Count,
            $loaded, $P3Plugins.Count, $(if ($on.Count) { $on -join ', ' } else { 'none' })
        if ($missing.Count) { $detail += '; missing: ' + ($missing -join ', ') }
        if ($bad.Count) { $detail += '; not loaded: ' + ($bad -join ', ') }
        if ($shadowed.Count) { $detail += '; hidden by an older copy in the data folder: ' + ($shadowed -join ', ') }
        if ($otherBad.Count) { $detail += '; other plugins refused or unhealthy: ' + ($otherBad -join ', ') }
        if ($r.code -ne 0) { Add-Step '4 plugins' 'FAIL' (Get-FailText $r) }
        else {
            if ($missing.Count -or $bad.Count -or $shadowed.Count) { Add-Step '4 plugins' 'FAIL' $detail }
            else { Add-Step '4 plugins' 'PASS' $detail }
            if ($off.Count) { Add-Warn '4 plugins' ('P3 plugins that are disabled: ' + ($off -join ', ')) }
            if ($otherShadowed.Count) { Add-Warn '4 plugins' ('other plugins hidden by a copy in the data folder: ' + ($otherShadowed -join ', ')) }
        }
    }

    # ============ 5. The silent list ============
    if (-not $ok) { Add-Step '5 silent list' 'SKIPPED' $why }
    else {
        $r = Invoke-Hub '5-silent' 'silent list' 60
        $text = $r.out.Trim()
        if ($r.code -ne 0) { Add-Step '5 silent list' 'FAIL' (Get-FailText $r) }
        elseif ($text -eq '' -or $text -eq $EmptySilent) { Add-Step '5 silent list' 'PASS' 'the list is empty' }
        else { Add-Step '5 silent list' 'FAIL' ('{0} line(s) printed; the list was expected to be empty (D-P3-6). See 5-silent.log' -f @($text -split "`r?`n").Count) }
    }

    # ============ 6. A forced brief ============
    if (-not $ok) { Add-Step '6 brief' 'SKIPPED' $why }
    elseif ($DryRun) { Add-Step '6 brief' 'SKIPPED' '-DryRun sends nothing to Telegram' }
    elseif ($Seen -eq 'skip') { Add-Step '6 brief' 'SKIPPED' '-Seen skip: no brief was asked for' }
    elseif (-not $HubUp -or $HubProc.HasExited) { Add-Step '6 brief' 'SKIPPED' 'there is no running hub' }
    elseif ($noChannel) { Add-Step '6 brief' 'FAIL' 'the hub says no channel is set up, so no brief can arrive' }
    else {
        $mark = @(Read-Lines $hubErr).Count
        $r = Invoke-Hub '6-brief' 'brief --now morning' 60
        if ($r.code -ne 0) { Add-Step '6 brief' 'FAIL' (Get-FailText $r) }
        else {
            $sw = [Diagnostics.Stopwatch]::StartNew()
            Write-Host 'Asked for a morning brief; waiting up to 120 s for the hub to say it.'
            $said = $false
            while (-not $said -and $sw.Elapsed.TotalSeconds -lt 120 -and -not $HubProc.HasExited) {
                Start-Sleep -Seconds 1
                $said = [bool](Read-Lines $hubErr | Select-Object -Skip $mark | Where-Object { $_ -match 'brief said.*kind="?morning' })
            }
            $after = [int]$sw.Elapsed.TotalSeconds
            if (-not $said) { Add-Step '6 brief' 'FAIL' "the hub did not say a morning brief within $after s; see 3-hub.err.log" }
            else {
                Start-Sleep -Seconds 15   # let the channel deliver it before anything stops the hub
                $sendFailed = [bool](Read-Lines $hubErr | Select-Object -Skip $mark | Where-Object { $_ -match 'gateway: (say failed|primary chat)' })
                $failNote = if ($sendFailed) { '; the log has a send failure (3-hub.err.log)' } else { '' }
                $answer = $Seen
                $how = 'given with -Seen'
                if (-not $answer -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
                    $how = 'typed by the person at the keyboard'
                    try {
                        for ($i = 0; $i -lt 3 -and $answer -notin 'y', 'n'; $i++) {
                            $answer = ([string](Read-Host 'Did the brief arrive in your Telegram chat? (y/n)')).Trim().ToLower()
                        }
                    } catch { $answer = '' }
                }
                $base = "the hub said the brief after $after s"
                if ($answer -eq 'y') { Add-Step '6 brief' 'PASS' "$base; seen: y ($how)$failNote" }
                elseif ($answer -eq 'n') { Add-Step '6 brief' 'FAIL' "$base; seen: n ($how)$failNote" }
                elseif ($sendFailed) { Add-Step '6 brief' 'FAIL' "$base$failNote" }
                else { Add-Step '6 brief' 'SKIPPED' "$base, but nobody confirmed that it arrived (no answer from a keyboard)" }
            }
        }
    }

    # ============ 7. The notice log ============
    if (-not $ok) { Add-Step '7 notices' 'SKIPPED' $why }
    elseif ($DryRun) { Add-Step '7 notices' 'SKIPPED' '-DryRun does steps 1, 2, 4 and 5 only' }
    else {
        $r = Invoke-Hub '7-notices' 'notices --last 20' 60
        # The text of the owner's notices goes to this one file and nowhere else.
        Move-Item -Force -LiteralPath (Join-Path $Out '7-notices.log') -Destination (Join-Path $Out 'notices.log')
        if ($r.code -ne 0) { Add-Step '7 notices' 'FAIL' (Get-FailText $r) }
        else {
            # id, when, state, urgency, source, text
            $rows = @(foreach ($line in ($r.out -split "`r?`n")) {
                    $f = $line -split "`t"
                    if ($f.Count -ge 6) { [pscustomobject]@{ state = $f[2]; source = $f[4] } }
                })
            $NoticeCounts = @($rows | Group-Object source, state | Sort-Object Name | ForEach-Object {
                    [pscustomobject]@{ source = $_.Group[0].source; state = $_.Group[0].state; count = $_.Count }
                })
            $summary = if ($rows.Count) { ($NoticeCounts | ForEach-Object { '{0}/{1}: {2}' -f $_.source, $_.state, $_.count }) -join ', ' } else { 'no notices recorded' }
            Add-Step '7 notices' 'PASS' ('{0} listed (source/state): {1}' -f $rows.Count, $summary)
        }
    }

    # ============ 8. Stop ============
    if (-not $HubProc) {
        Add-Step '8 stop' 'SKIPPED' $(if ($DryRun) { '-DryRun started no hub' } elseif (-not $ok) { $why } else { 'no hub was started' })
    } else {
        Update-Ours
        $early = $HubProc.HasExited
        try { $HubProc.StandardInput.Close() } catch { }
        $exited = $HubProc.WaitForExit(60000)
        $wjGone = -not (Test-Path (Join-Path $Data 'window.json'))
        $saidStopped = [bool](Read-Lines $hubLog | Where-Object { $_ -eq 'Stopped.' })
        if ($exited -and -not $early -and $HubProc.ExitCode -eq 0 -and $wjGone -and $saidStopped) {
            Add-Step '8 stop' 'PASS' 'the hub stopped when its input closed: exit 0, "Stopped.", window.json gone'
        } else {
            $code = if ($exited) { $HubProc.ExitCode } else { 'still running after 60 s' }
            Add-Step '8 stop' 'FAIL' ('exit: {0}; had already exited: {1}; window.json gone: {2}; said "Stopped.": {3}' -f $code, $early, $wjGone, $saidStopped)
            if (-not $exited) { Stop-OwnTree $HubProc.Id; [void]$HubProc.WaitForExit(15000) }
        }
    }

    if ($Ours.Count -gt 0) {
        $end = (Get-Date).AddSeconds(30)
        $left = @(Get-LeftOver)
        while ($left.Count -gt 0 -and (Get-Date) -lt $end) { Start-Sleep -Seconds 1; $left = @(Get-LeftOver) }
        if ($left.Count -eq 0) {
            Add-Step '8 nothing left' 'PASS' ('none of the {0} processes this run saw itself start is still running (alexia-hub, node or other)' -f $Ours.Count)
        } else {
            Add-Step '8 nothing left' 'FAIL' ('still running 30 s later, now stopped: {0}' -f (($left | ForEach-Object { "$($_.Name) pid $($_.ProcessId)" }) -join ', '))
            $left | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        }
    }
}
catch {
    Add-Step 'script' 'FAIL' ('the script itself failed: {0} (line {1})' -f $_.Exception.Message, $_.InvocationInfo.ScriptLineNumber)
}
finally {
    # Also reached on Ctrl+C: never leave the hub this run started.
    if ($HubProc -and -not $HubProc.HasExited) {
        try { $HubProc.StandardInput.Close() } catch { }
        if (-not $HubProc.WaitForExit(30000)) { Stop-OwnTree $HubProc.Id }
    }
    foreach ($n in $EnvNames) { [Environment]::SetEnvironmentVariable($n, $EnvBefore[$n], 'Process') }

    if (Test-Path $Scratch) {
        if ($KeepData) { Write-Host "The scratch copy of the data is kept: $Scratch" }
        else {
            # rmdir removes a junction itself and never what it points to.
            cmd /c "rmdir /s /q `"$Scratch`"" | Out-Null
            if (Test-Path $Scratch) { Add-Step 'clean up' 'FAIL' "the scratch copy could not be removed: $Scratch" }
        }
    }

    $pass = @($Steps | Where-Object { $_.result -eq 'PASS' }).Count
    $fail = @($Steps | Where-Object { $_.result -eq 'FAIL' }).Count
    $skip = @($Steps | Where-Object { $_.result -eq 'SKIPPED' }).Count
    [ordered]@{
        date = (Get-Date).ToString('s'); commit = $commit; uncommittedCode = $dirty; dryRun = [bool]$DryRun
        realData = [bool]$RealData; blockedByRunningHub = $Blocked; steps = @($Steps); warnings = @($Warnings); noticeCounts = @($NoticeCounts)
    } | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $Out 'results.json')
    Write-Host ''
    Write-Host "RESULT: $pass PASS, $fail FAIL, $skip SKIPPED. Details: $(Join-Path $Out 'results.json')"
    try { Stop-Transcript | Out-Null } catch { }
}

if ($Blocked) { exit 2 }
if (@($Steps | Where-Object { $_.result -eq 'FAIL' }).Count -gt 0) { exit 1 }
exit 0
