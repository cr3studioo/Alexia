# SPDX-License-Identifier: AGPL-3.0-only
# P2D-15: the app built from this checkout, run on this PC, checked end to end.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File v3\ops\reports\p2d-e2e.ps1
#
# Windows PowerShell 5.1, in the owner's desktop session (not SSH, not SYSTEM). It builds the
# unbundled app, opens it, calls one case per INVENTORY row against the live hub, runs the
# pc_actions test, asks the owner for one Telegram message, checks that a second start attaches
# to a hub that is already running, and presses "Start again" after the hub is stopped.
# It prints every result and writes them to $Out (results.json, transcript.txt, one log per step).
#
# It starts only what it names: processes are stopped by pid, only ones it started (the app, the
# hubs under it, one console hub). The one exception is step 2, where it stops a v2 Alexia
# (alexia.exe from %LOCALAPPDATA%\Alexia) because the brief says to, and it starts that exe again
# at the end. It never runs `alexia-hub install`, never reads a bot token or the keychain itself,
# and the only requests it sends to the live hub are GETs and three POSTs that only read.
# Read-only CLI calls (`alexia-hub runs`, `activity`) open the hub's store the way the owner's
# own terminal would.
param(
    [string]$Out = (Join-Path $env:TEMP 'p2d-e2e'),
    [int]$TelegramWaitSec = 300,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Continue'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$V3 = Join-Path $Repo 'v3'
$Tauri = Join-Path $Repo 'src-tauri'
$AppExe = Join-Path $Tauri 'target\release\alexia.exe'
$HubExe = Join-Path $V3 'target\release\alexia-hub.exe'
$UiDir = Join-Path $Tauri 'resources\ui'
$DataDir = Join-Path $env:LOCALAPPDATA 'AlexiaHub'
$WindowJson = Join-Path $DataDir 'window.json'
$V2Dir = Join-Path $env:LOCALAPPDATA 'Alexia'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
try { Start-Transcript -Path (Join-Path $Out 'transcript.txt') -Force | Out-Null } catch { }

# The SQLCipher build needs a full Perl, and this machine is short of memory.
$perl = 'C:/dev/Alexia-wt/tools/strawberry-perl/perl/bin/perl.exe'
if ((Test-Path $perl) -and -not $env:OPENSSL_SRC_PERL) { $env:OPENSSL_SRC_PERL = $perl }
if (-not $env:CARGO_BUILD_JOBS) { $env:CARGO_BUILD_JOBS = '2' }

$Steps = New-Object System.Collections.ArrayList
$Screens = @()
$Started = New-Object System.Collections.ArrayList   # pids this script started and must stop

function Add-Step([string]$Name, [string]$Result, [string]$Detail) {
    [void]$Steps.Add([pscustomobject]@{ step = $Name; result = $Result; detail = $Detail })
    Write-Host ("[{0}] {1}: {2}" -f $Result, $Name, $Detail)
}

function Get-Procs { @(Get-CimInstance Win32_Process) }

function Get-Hubs { @(Get-Procs | Where-Object { $_.Name -eq 'alexia-hub.exe' }) }

function Get-Descendants([int]$RootPid, $All) {
    $out = @(); $queue = @($RootPid)
    while ($queue.Count -gt 0) {
        $next = @()
        foreach ($parent in $queue) {
            foreach ($child in @($All | Where-Object { $_.ParentProcessId -eq $parent })) { $out += $child; $next += [int]$child.ProcessId }
        }
        $queue = $next
    }
    $out
}

function Wait-Until([scriptblock]$Cond, [int]$Seconds, [int]$EveryMs = 500) {
    $end = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $end) {
        $v = & $Cond
        if ($v) { return $v }
        Start-Sleep -Milliseconds $EveryMs
    }
    & $Cond
}

function Read-WindowJson {
    if (-not (Test-Path $WindowJson)) { return $null }
    try { Get-Content -Raw $WindowJson | ConvertFrom-Json } catch { $null }
}

function Get-Page([int]$Port) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/" -TimeoutSec 5
        return $r
    } catch { return $null }
}

function Get-Token([string]$Html) {
    $m = [regex]::Match($Html, 'data-token="([^"]+)"')
    if ($m.Success) { $m.Groups[1].Value } else { $null }
}

function Run-Logged([string]$Name, [string]$Cmd, [string]$Dir) {
    # cmd.exe does the redirect, so Windows PowerShell 5.1 does not wrap native stderr in errors.
    $log = Join-Path $Out ($Name + '.log')
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Push-Location $Dir
    try { cmd /c "$Cmd > `"$log`" 2>&1"; $code = $LASTEXITCODE } finally { Pop-Location }
    $sw.Stop()
    [pscustomobject]@{ code = $code; seconds = [int]$sw.Elapsed.TotalSeconds; log = $log }
}

function Tail([string]$Path, [int]$N = 15) {
    if (Test-Path $Path) { (Get-Content $Path -Tail $N) -join "`n" } else { '(no log)' }
}

function Stop-Pid([int]$P) {
    try { Stop-Process -Id $P -Force -ErrorAction Stop } catch { }
}

function Stop-Tree([int]$P) {
    # Only ever a pid this script started.
    cmd /c "taskkill /F /T /PID $P > nul 2>&1" | Out-Null
}

# ---- UI Automation, on the app's own windows only (found by its pid) ----
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
function Get-AppWindows([int]$AppPid) {
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $AppPid)
    @([System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $cond))
}
function Get-AppScreen([int]$AppPid) {
    $lines = @()
    try {
        foreach ($w in (Get-AppWindows $AppPid)) {
            $lines += ('window "{0}" ({1})' -f $w.Current.Name, $w.Current.ControlType.ProgrammaticName)
            $items = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
            $n = 0
            foreach ($e in $items) {
                $t = $e.Current.ControlType.ProgrammaticName
                if (($t -match 'Text|Button|Hyperlink|Document') -and $e.Current.Name) {
                    $lines += ('  {0}: {1}' -f ($t -replace 'ControlType\.', ''), $(if ($e.Current.Name.Length -gt 60) { $e.Current.Name.Substring(0, 60) + '...' } else { $e.Current.Name }))
                    $n++
                    if ($n -ge 8) { break }
                }
            }
        }
    } catch { $lines += "(UI Automation failed: $($_.Exception.Message))" }
    if ($lines.Count -eq 0) { $lines = @('(the app has no window UI Automation can see)') }
    $lines
}
function Press-Button([int]$AppPid, [string]$Pattern) {
    try {
        foreach ($w in (Get-AppWindows $AppPid)) {
            $btnCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
            foreach ($b in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)) {
                if ($b.Current.Name -match $Pattern) {
                    $p = $null
                    if ($b.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) {
                        $p.Invoke(); return "pressed '$($b.Current.Name)' through InvokePattern"
                    }
                    return "found '$($b.Current.Name)' but it has no InvokePattern"
                }
            }
        }
    } catch { return "UI Automation failed: $($_.Exception.Message)" }
    return 'no button matching ' + $Pattern + ' in the app''s windows'
}

function Start-App {
    $env:ALEXIA_HUB_EXE = $HubExe
    $env:ALEXIA_UI_DIR = $UiDir
    $p = Start-Process -FilePath $AppExe -PassThru
    [void]$Started.Add($p.Id)
    $p
}
function Stop-App([int]$AppPid) {
    Stop-Pid $AppPid   # the shell only: its stdin close is the hub's own stop
}

$report = [ordered]@{ date = (Get-Date).ToString('s'); repo = $Repo }
$commit = (git -C $Repo rev-parse HEAD).Trim()
$report.commit = $commit
$os = Get-CimInstance Win32_OperatingSystem
$report.machine = [ordered]@{
    windows = "$($os.Caption) build $($os.BuildNumber)"
    ram_gb = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
    gpu = ((& nvidia-smi --query-gpu=name,memory.total --format=csv 2>$null) -join ' | ')
}
Write-Host "Commit $commit"
Write-Host "Machine: $($report.machine.windows), $($report.machine.ram_gb) GB RAM, $($report.machine.gpu)"

# ============ 1. Build ============
if ($SkipBuild -and (Test-Path $AppExe) -and (Test-Path $HubExe)) {
    Add-Step '1 build' 'skipped' 'built earlier (-SkipBuild); the exe and hub exist'
} else {
    $a = Run-Logged '1a-pnpm-install' 'pnpm install --frozen-lockfile' $Repo
    if ($a.code -ne 0) { Add-Step '1 build' 'fail' ("pnpm install failed ({0}); tail:`n{1}" -f $a.code, (Tail $a.log)); $Fatal = $true }
    if (-not $Fatal) {
        $b = Run-Logged '1b-pnpm-sidecar' 'pnpm sidecar' $Repo
        if ($b.code -ne 0) { Add-Step '1 build' 'fail' ("pnpm sidecar failed ({0}); tail:`n{1}" -f $b.code, (Tail $b.log 30)); $Fatal = $true }
    }
    if (-not $Fatal) {
        $c = Run-Logged '1c-tauri-build' 'pnpm tauri build --no-bundle' $Repo
        if ($c.code -ne 0) {
            Add-Step '1 build (no-bundle)' 'note' ("pnpm tauri build --no-bundle failed ({0}); tail:`n{1}" -f $c.code, (Tail $c.log 20))
            $c = Run-Logged '1c-pnpm-app' 'pnpm app' $Repo
        }
        if ($c.code -ne 0 -or -not (Test-Path $AppExe)) { Add-Step '1 build' 'fail' ("the app did not build; tail:`n{0}" -f (Tail $c.log 30)); $Fatal = $true }
        else { Add-Step '1 build' 'pass' ("install {0} s, sidecar {1} s, tauri {2} s; {3}" -f $a.seconds, $b.seconds, $c.seconds, $AppExe) }
    }
}
if ($Fatal) {
    $report.steps = $Steps
    $report | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 (Join-Path $Out 'results.json')
    try { Stop-Transcript | Out-Null } catch { }
    exit 1
}
$report.build_hub = $HubExe

# ============ 2. Before ============
$v2 = @(Get-Procs | Where-Object { $_.Name -eq 'alexia.exe' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($V2Dir, [StringComparison]::OrdinalIgnoreCase) })
$v2Exe = $null
foreach ($p in $v2) { if (-not $v2Exe) { $v2Exe = $p.ExecutablePath }; Stop-Pid $p.ProcessId }
if ($v2.Count -gt 0) { Start-Sleep -Seconds 3 }
$hubsBefore = @(Get-Hubs)
$wj = Read-WindowJson
$sched = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -match 'lexia' } | ForEach-Object { "$($_.TaskName)=$($_.State)" })
Add-Step '2 before' 'info' ("v2 app stopped: {0}; hubs running: {1}; window.json: {2}; scheduled tasks: {3}" -f $v2.Count, $hubsBefore.Count, $(if ($wj) { "port $($wj.port) pid $($wj.pid)" } else { 'none' }), $(if ($sched.Count) { $sched -join ', ' } else { 'none' }))
$preexisting = $hubsBefore.Count -gt 0

# ============ 3. Open ============
$sw = [Diagnostics.Stopwatch]::StartNew()
$app = Start-App
$ok3 = Wait-Until { $w = Read-WindowJson; $w -and $w.port -and (Get-Page $w.port) } 60 1000
$sw.Stop()
$wj = Read-WindowJson
$page = $null; $token = $null; $port = 0
if ($wj) { $port = [int]$wj.port; $page = Get-Page $port; if ($page) { $token = Get-Token $page.Content } }
$procs = Get-Procs
$hubs = @($procs | Where-Object { $_.Name -eq 'alexia-hub.exe' })
$hubPid = if ($hubs.Count -ge 1) { [int]$hubs[0].ProcessId } else { 0 }
$offenders = @($procs | Where-Object { ($_.Name -in @('node.exe', 'alexia-core.exe')) -and $_.CommandLine -and ($_.CommandLine -match 'boot\.mjs' -or $_.CommandLine -match 'packages\\core') })
$underApp = @(Get-Descendants $app.Id $procs | Where-Object { $_.Name -in 'node.exe', 'alexia-core.exe' })
$underHub = if ($hubPid) { @(Get-Descendants $hubPid $procs | ForEach-Object { [int]$_.ProcessId }) } else { @() }
$strayPlugins = @($underApp | Where-Object { $underHub -notcontains [int]$_.ProcessId })
$hubParent = if ($hubs.Count -ge 1) { [int]$hubs[0].ParentProcessId } else { 0 }
$pass3 = [bool]($ok3 -and $page -and $token -and $hubs.Count -eq 1 -and $offenders.Count -eq 0 -and $strayPlugins.Count -eq 0)
Add-Step '3 open' $(if ($pass3) { 'pass' } else { 'fail' }) ("app pid {0}; window.json {1} after {2:N1} s; GET / {3} (token {4}); alexia-hub.exe x{5} (pid {6}, parent {7}); Node core processes {8}; plugin node/alexia-core under the app {9}, outside the hub {10}" -f $app.Id, $(if ($wj) { "port $port pid $($wj.pid)" } else { 'missing' }), $sw.Elapsed.TotalSeconds, $(if ($page) { $page.StatusCode } else { 'no answer' }), $(if ($token) { 'read' } else { 'missing' }), $hubs.Count, $hubPid, $hubParent, $offenders.Count, $underApp.Count, $strayPlugins.Count)
$report.open = [ordered]@{ app_pid = $app.Id; hub_pid = $hubPid; hub_parent = $hubParent; port = $port; preexisting_hub = $preexisting }

# ============ 4. Every screen ============
if ($pass3 -or ($page -and $token)) {
    $js = @'
const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const [dir, port, token] = process.argv.slice(2)
const skipWhy = {
  C1: 'sends a message: runs the owner\'s model and may spend', C2: 'stops whatever the owner is running', C3: 'answers an approval',
  C4: 'runs a command in the owner\'s chat', C5: 'records feedback on the owner\'s persona', C7: '/api/file open: opens a file in Explorer (brief: skip)',
  A2: 'writes the owner\'s settings', A3: 'writes the owner\'s permissions', A4: 'writes the owner\'s limits', A5: 'writes the owner\'s safety setting',
  P2: 'plugin delete/enable (brief: skip)', P3: 'installs a plugin', P4: 'adds or trusts an MCP server', P5: 'writes a plugin setting', P6: 'stores an upload',
  B2: 'needs a row id from a fixture chat; the live store is the owner\'s', B3: 'actions include forget_chat (brief: skip)', B4: 'edits or forgets learned skills',
  L3: 'library install (brief: skip)', M5: 'writes local-model settings', M9: 'downloads a model', M10: 'cancels the owner\'s install', M11: 'imports a model file',
  M12: 'loads a model and benchmarks the GPU', M13: 'changes the owner\'s model choice', M14: 'model remove (brief: skip)', M15: 'model remove (brief: skip)',
  M16: 'writes the Hugging Face token to the keychain', R2: 'role switch (brief: skip)', R3: 'stops a role switch', R6: 'changes Tailscale use', R8: 'opens a pairing code',
  R10: 'cancels pairing', R11: 'unpair (brief: skip)', R14: 'changes whose models show', R15: 'installs a requirement', R19: 'cancels a job', R20: 'pauses compute',
  R22: 'writes service addresses', R23: 'closes the compute window', E1: 'forwards an edit to the image plugin', E4: 'forgets editor pictures', E5: 'uploads into the editor',
  T4: 'a shell event, not a request: checked in step 7b',
}
const readPosts = new Set(['B1', 'E6'])
const kind = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'boolean' ? 'bool' : typeof v
const pm = (pat, p) => { const a = pat.split('/'), b = p.split('/'); return a.length === b.length && a.every((s, i) => s === '*' || s === b[i]) }
const any = (list, p) => (list || []).some(x => pm(x, p))
function walk(e, a, at, R, out) {
  if (any(R.ignore, at)) return
  const bad = x => out.push(`${at || '/'}: expected ${x}, got ${kind(a)}`)
  if (typeof e === 'string') { if (e !== kind(a)) bad(e) }
  else if (Array.isArray(e)) { if (!Array.isArray(a)) return bad('array'); e.forEach((x, i) => { if (i < a.length) walk(x, a[i], `${at}/${i}`, R, out) }) }
  else if (e && typeof e === 'object') {
    if (kind(a) !== 'object') return bad('object')
    for (const k of Object.keys(e)) { const c = `${at}/${k}`; if (k in a) walk(e[k], a[k], c, R, out); else if (!any(R.optional, c) && !any(R.ignore, c)) out.push(`${c}: missing`) }
    for (const k of Object.keys(a)) { const c = `${at}/${k}`; if (!(k in e) && !any(R.optional, c) && !any(R.ignore, c)) out.push(`${c}: unexpected key`) }
  }
}
function send(req) {
  return new Promise(resolve => {
    const q = new URLSearchParams(req.query || {}).toString()
    const body = req.body == null ? null : typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
    const headers = { Host: req.host === '127.0.0.1' ? `127.0.0.1:${port}` : req.host }
    if (req.token) headers['x-alexia-token'] = token
    if (body !== null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(body) }
    const r = http.request({ host: '127.0.0.1', port: Number(port), method: req.method, path: req.path + (q ? '?' + q : ''), headers, timeout: 30000 }, res => {
      const chunks = []; res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, type: String(res.headers['content-type'] || '').split(';')[0].trim(), text: Buffer.concat(chunks).toString('utf8') }))
    })
    r.on('timeout', () => { r.destroy(new Error('no answer in 30 s')) })
    r.on('error', e => resolve({ error: String(e.message || e) }))
    if (body !== null) r.write(body)
    r.end()
  })
}
const cases = []
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) for (const c of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).cases) cases.push(c)
const rows = []; for (const c of cases) if (!rows.includes(c.row)) rows.push(c.row)
const order = r => { const m = /^([A-Z])(\d+)$/.exec(r); return 'SACPBLMREI'.indexOf(m ? m[1] : 'T') * 1000 + (m ? Number(m[2]) : 0) }
rows.sort((a, b) => order(a) - order(b))
const results = []
;(async () => {
for (const row of rows) {
  const mine = cases.filter(c => c.row === row)
  const safe = mine.filter(c => c.request.method === 'GET' || (readPosts.has(row)) || (row === 'S3' && c.request.path === '/api/nothing-here'))
  const pick = safe.find(c => (c.setup || ['fresh'])[0] === 'fresh') || null
  if (!pick || skipWhy[row]) { results.push({ row, verdict: 'skipped', note: skipWhy[row] || 'only POST/DELETE cases, which act on the owner\'s real state' }); continue }
  if (pick.stream) { results.push({ row, verdict: 'skipped', note: 'a stream' }); continue }
  const got = await send(pick.request)
  const r = { row, name: pick.name, request: `${pick.request.method} ${pick.request.path}`, want: pick.response.status }
  if (got.error) { results.push({ ...r, verdict: 'fail', note: got.error }); continue }
  const out = []
  if (got.status !== pick.response.status) out.push(`status ${got.status}, recorded ${pick.response.status}`)
  if (got.type !== (pick.response.type || '')) out.push(`content-type "${got.type}", recorded "${pick.response.type || ''}"`)
  if (typeof pick.response.text === 'string') { if (got.text !== pick.response.text) out.push(`body "${got.text.slice(0, 80)}", recorded "${pick.response.text.slice(0, 80)}"`) }
  else if (pick.response.type === 'application/json' && pick.response.shape != null) {
    let v; try { v = JSON.parse(got.text) } catch (e) { out.push('body is not JSON: ' + got.text.slice(0, 80)) }
    if (v !== undefined) walk(pick.response.shape, v, '', { ignore: pick.response.ignore, optional: pick.response.optional }, out)
  }
  results.push({ ...r, status: got.status, verdict: out.length ? 'fail' : 'pass', note: out.slice(0, 4).join('; ') })
}
console.log(JSON.stringify(results))
})()
'@
    $jsPath = Join-Path $Out 'screens.cjs'
    Set-Content -Encoding UTF8 -Path $jsPath -Value $js
    $contract = Join-Path $V3 'crates\alexia-hub\tests\contract'
    $raw = & node $jsPath $contract $port $token
    try { $parsed = ConvertFrom-Json ($raw -join ''); $Screens = @($parsed | ForEach-Object { $_ }) } catch { Add-Step '4 screens' 'fail' ("the screen checker printed no JSON: {0}" -f ($raw -join ' ')) }
    if ($Screens.Count -gt 0) {
        $Screens | Format-Table row, verdict, request, status, note -AutoSize -Wrap | Out-String -Width 220 | Write-Host
        $np = @($Screens | Where-Object verdict -eq 'pass').Count; $nf = @($Screens | Where-Object verdict -eq 'fail').Count; $ns = @($Screens | Where-Object verdict -eq 'skipped').Count
        Add-Step '4 screens' $(if ($nf -eq 0) { 'pass' } else { 'fail' }) ("{0} rows: {1} pass, {2} fail, {3} skipped" -f $Screens.Count, $np, $nf, $ns)
    }
} else { Add-Step '4 screens' 'fail' 'no page or token, so no screen could be called' }

# ============ 5. PC actions ============
$pc = Run-Logged '5-pc-actions' 'cargo test -p alexia-hub --features pc-actions --test pc_actions -- --nocapture' $V3
$pcTail = Tail $pc.log 25
$pcResult = [regex]::Match((Get-Content $pc.log -Raw), 'test result: [^\r\n]+').Value
Add-Step '5 pc_actions' $(if ($pc.code -eq 0) { 'pass' } else { 'fail' }) ("exit {0} in {1} s; {2}; log {3}`n{4}" -f $pc.code, $pc.seconds, $pcResult, $pc.log, $pcTail)

# ============ 6. One brain ============
$cli = { param($a) cmd /c "`"$HubExe`" $a 2>&1" }
$runsBefore = @(& $cli 'runs --last 5')
$actBefore = @(& $cli 'activity --last 5')
$hubBeforePing = (Read-WindowJson).pid
Write-Host ''
Write-Host '>>> OWNER: please send "p2d ping" to Alexia on Telegram now. Waiting up to 5 minutes. <<<'
Write-Host ''
$seen = Wait-Until {
    $r = @(& $cli 'runs --last 5'); $a = @(& $cli 'activity --last 5')
    if ((($r -join "`n") -ne ($runsBefore -join "`n")) -or (($a -join "`n") -ne ($actBefore -join "`n"))) { [pscustomobject]@{ runs = $r; activity = $a } } else { $null }
} $TelegramWaitSec 10
if ($seen) {
    $first = ($seen.runs | Select-Object -First 1)
    $hubAfter = (Read-WindowJson).pid
    $same = ($hubBeforePing -eq $hubAfter) -and (@(Get-Hubs).Count -eq 1)
    $ping = [bool](($seen.runs + $seen.activity) -match 'p2d ping')
    Add-Step '6 one brain' 'pass' ("the store's newest runs changed after the ping; same hub pid before/after: {0} (pid {1}); text 'p2d ping' visible in runs/activity: {2}; newest run line: {3}" -f $same, $hubAfter, $ping, $first)
} else {
    Add-Step '6 one brain' 'not observed' ("no new run or audited call within {0} s of asking the owner for 'p2d ping'; hub pid stays {1}" -f $TelegramWaitSec, $hubBeforePing)
}

# ============ 7. Attach ============
Stop-App $app.Id
$gone = Wait-Until { @(Get-Hubs).Count -eq 0 } 30 1000
$cleanStop = [bool]$gone
if (-not $gone) { foreach ($h in (Get-Hubs)) { if ($underHub -contains [int]$h.ProcessId -or [int]$h.ProcessId -eq $hubPid) { Stop-Tree ([int]$h.ProcessId) } }; Start-Sleep -Seconds 2 }
Add-Step '7a quit the app' $(if ($cleanStop) { 'pass' } else { 'note' }) $(if ($cleanStop) { 'the hub it started stopped by itself within 30 s of the shell going' } else { 'the hub was still there 30 s after the shell was stopped; stopped by pid' })

$env:ALEXIA_UI_DIR = $UiDir
$console = Start-Process -FilePath $HubExe -ArgumentList 'run' -PassThru -WindowStyle Minimized
[void]$Started.Add($console.Id)
$up = Wait-Until { $w = Read-WindowJson; $w -and $w.pid -eq $console.Id -and (Get-Page $w.port) } 60 1000
$app2 = Start-App
Start-Sleep -Seconds 10
$hubs2 = @(Get-Hubs)
$cwj = Read-WindowJson
$under2 = @(Get-Descendants $app2.Id (Get-Procs) | Where-Object Name -eq 'alexia-hub.exe')
$pass7 = [bool]($up -and $hubs2.Count -eq 1 -and [int]$hubs2[0].ProcessId -eq $console.Id -and $under2.Count -eq 0)
Add-Step '7 attach' $(if ($pass7) { 'pass' } else { 'fail' }) ("console hub pid {0} answered: {1}; after the app started: alexia-hub.exe x{2} (pid {3}); hubs under the app: {4}; window.json pid {5}" -f $console.Id, [bool]$up, $hubs2.Count, $(if ($hubs2.Count) { $hubs2[0].ProcessId } else { '-' }), $under2.Count, $(if ($cwj) { $cwj.pid } else { 'none' }))
Stop-App $app2.Id
Start-Sleep -Seconds 3
$survived = [bool](Get-Process -Id $console.Id -ErrorAction SilentlyContinue)
Add-Step '7 attach, quit' $(if ($survived) { 'pass' } else { 'fail' }) ("the app quit; the console hub it attached to {0}" -f $(if ($survived) { 'is still running (not ours to stop)' } else { 'was stopped by the app' }))
Stop-Tree $console.Id
[void](Wait-Until { @(Get-Hubs).Count -eq 0 } 20 1000)

# ============ 7b. Start again ============
$app3 = Start-App
$ok = Wait-Until { $w = Read-WindowJson; $w -and $w.port -and (Get-Page $w.port) } 60 1000
$h1 = @(Get-Descendants $app3.Id (Get-Procs) | Where-Object Name -eq 'alexia-hub.exe')
if ($h1.Count -ne 1) {
    Add-Step '7b start again' 'fail' ("the app started {0} hubs of its own; cannot stop one by pid" -f $h1.Count)
} else {
    $oldPid = [int]$h1[0].ProcessId
    Stop-Pid $oldPid
    Start-Sleep -Seconds 1
    $screen1 = Get-AppScreen $app3.Id
    $press = 'no button found'
    $restarted = $null
    $end = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $end -and -not $restarted) {
        $restarted = @(Get-Hubs | Where-Object { [int]$_.ProcessId -ne $oldPid })
        if ($restarted.Count -eq 0) {
            $restarted = $null
            $press = Press-Button $app3.Id 'Start again|Try again'
            if ($press -match '^pressed') { break }
        }
        Start-Sleep -Milliseconds 500
    }
    if ($restarted) { $press = 'not pressed: the app started another hub by itself' }
    $afterKill = @(Get-Hubs)
    $again = Wait-Until { $x = @(Get-Hubs | Where-Object { [int]$_.ProcessId -ne $oldPid }); $w = Read-WindowJson; if ($x.Count -and $w -and [int]$w.pid -eq [int]$x[0].ProcessId -and (Get-Page $w.port)) { $x } else { $null } } 60 1000
    $newPid = if ($again) { [int]@($again)[0].ProcessId } else { 0 }
    $result = if ($again) { 'pass' } else { 'fail' }
    Add-Step '7b start again' $result ("stopped the app's hub pid {0}; hubs running after: {1}; the app's own restart within 20 s: {2}; button: {3}; new hub pid {4} answering through window.json: {5}`nScreen after the stop:`n{6}" -f $oldPid, $afterKill.Count, [bool]$restarted, $press, $newPid, [bool]$again, ($screen1 -join "`n"))
}
Stop-App $app3.Id
[void](Wait-Until { @(Get-Hubs).Count -eq 0 } 30 1000)

# ============ 8. After ============
foreach ($h in (Get-Hubs)) {
    if (-not $preexisting) { Stop-Tree ([int]$h.ProcessId) }
}
$left = @(Get-Procs | Where-Object { ($_.Name -in @('alexia.exe', 'alexia-hub.exe')) -and $_.ExecutablePath -and $_.ExecutablePath -notlike "$V2Dir*" })
if ($v2Exe) { Start-Process -FilePath $v2Exe | Out-Null }
Add-Step '8 after' $(if ($left.Count -eq 0) { 'pass' } else { 'note' }) ("left of ours running: {0}; v2 app {1}" -f $left.Count, $(if ($v2Exe) { 'started again' } else { 'was not running' }))

$report.steps = $Steps
$report.screens = $Screens
$report.pc_actions = [ordered]@{ exit = $pc.code; result = $pcResult; log = $pc.log }
$report | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 (Join-Path $Out 'results.json')
Write-Host "Results: $(Join-Path $Out 'results.json')"
try { Stop-Transcript | Out-Null } catch { }
