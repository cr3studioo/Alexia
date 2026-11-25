// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process'

/**
 * Windows, driven through PowerShell and .NET.
 *
 * ponytail: no native module, no robotjs, no nut.js. Every one of them is a compiled
 * dependency that has to be rebuilt per Node version and shipped per architecture, and the
 * whole of what is needed here — a screenshot, a cursor position, a click, a keystroke — is
 * four .NET types that are already on every Windows machine. The cost is a PowerShell spawn
 * per action, about 200 ms, which is nothing next to the model call on either side of it.
 * The day this needs 60 fps input, a native module is the sanctioned replacement.
 *
 * **Everything in here happens in the plugin process.** Core spawns this and reads JSON from
 * a pipe; there is no screen buffer on that pipe and no way for core to ask for one. The
 * screenshot lands in this plugin's own folder and what crosses the wire is a path.
 */

/** Windows' own PowerShell, asked for by absolute path for the reason `voice` gives. */
function shell() {
  const root = process.env.SystemRoot
  return root ?
      `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : 'powershell.exe'
}

export const supported = () => process.platform === 'win32'

/** What a person reads when this platform is named in a sentence. */
export const engine = 'Windows'

/** What the `key` tool tells a model, because the notation is this backend's to define. */
export const KEY_HELP =
  'Press a key or a combination — {ENTER}, {TAB}, {ESC}, {F5}, ^c for Ctrl+C, ^v for ' +
  'Ctrl+V, %{F4} for Alt+F4, {WIN} for the Windows key on its own (this opens the start ' +
  'menu) and {WIN}r for Windows+R. Use for anything that is not ordinary text.'
export const KEY_NOTATION = 'The combination, in SendKeys notation.'

/**
 * Run a script and give back what it printed.
 *
 * `-NoProfile` because a user's profile can print a banner, which would be parsed as
 * output; `-NonInteractive` because a prompt here would hang until the call timeout.
 */
export function run(script, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      shell(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { stdio: ['ignore', 'pipe', 'pipe'], signal },
    )
    let out = ''
    let said = ''
    child.stdout.on('data', (chunk) => (out += String(chunk)))
    child.stderr.on('data', (chunk) => (said += String(chunk)))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) return resolve(out.trim())
      const last = said.trim().split('\n').at(-1) ?? `PowerShell exited ${code}`
      /**
       * The antivirus, said out loud.
       *
       * Windows scans every script before it runs it (AMSI), and the raw refusal is a line
       * reading `FullyQualifiedErrorId : ScriptContainedMaliciousContent`, which tells
       * nobody anything. A model reading it will retry the same call forever and a person
       * reading it will think Alexia is broken. It is neither: something on this machine
       * decided not to run the script, and only the person at it can change that.
       */
      reject(
        new Error(
          /ScriptContainedMaliciousContent/.test(said) ?
            'Windows blocked this script before it ran — the antivirus decided it looked like malware. ' +
              'Nothing was done. Allowing Alexia in your antivirus settings is the only thing that changes it.'
          : last,
        ),
      )
    })
  })
}

/**
 * A string, as a PowerShell single-quoted literal.
 *
 * The one escaping rule that matters here: inside `'...'` PowerShell expands nothing —
 * no `$`, no backtick, no subexpression — and a literal quote is doubled. So this is the
 * whole of it, and it is used for **every** value that comes from a model, which is the
 * reason it exists rather than being inlined.
 */
export const quoted = (value) => `'${String(value).replace(/'/g, "''")}'`

// ---- the window in front ------------------------------------------------------------------

/**
 * **Which process owns the window in front, and the Win32 that changes it.**
 *
 * `focus` used to be VB's `AppActivate`, which asks politely. Windows' foreground lock says
 * no to a process that did not receive the last input, and this one never has: it is
 * PowerShell, started by node, started by the hub, none of which anybody clicked. `AppActivate`
 * returned anyway, `focus` said *Focused*, and every keystroke after it went to whatever window
 * was really in front. So the answer is now checked, not assumed: `FrontPid` is
 * `GetForegroundWindow` + `GetWindowThreadProcessId`, asked after every attempt and right
 * before every guarded keystroke or click.
 *
 * Same P/Invoke shape as `click` and `windowsKey`: no native module, nothing to rebuild.
 */
const FOREGROUND = [
  "Add-Type -Namespace Alexia -Name Front -MemberDefinition @'",
  '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();',
  '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr window, out uint pid);',
  '[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);',
  '[DllImport("user32.dll")] public static extern bool BringWindowToTop(System.IntPtr window);',
  '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr window);',
  '[DllImport("user32.dll")] public static extern System.IntPtr SetFocus(System.IntPtr window);',
  '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr window, int how);',
  '[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr window);',
  '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);',
  '[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
  'public static uint ThreadOf(System.IntPtr window) { uint pid; return GetWindowThreadProcessId(window, out pid); }',
  'public static uint FrontPid() { uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid); return pid; }',
  '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr window, System.Text.StringBuilder text, int most);',
  '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern System.IntPtr FindWindowEx(System.IntPtr parent, System.IntPtr after, string kind, string title);',
  'public static uint PidOf(System.IntPtr window) { uint pid; GetWindowThreadProcessId(window, out pid); return pid; }',
  // A modern (UWP) app draws into a CoreWindow that is a child of a frame owned by
  // ApplicationFrameHost. That child's process is the app's own; 0 when there is none.
  'public static uint HostedPid(System.IntPtr window) {',
  '  if (window == System.IntPtr.Zero) return 0;',
  '  try { if (System.Diagnostics.Process.GetProcessById((int)PidOf(window)).ProcessName != "ApplicationFrameHost") return 0; } catch { return 0; }',
  '  System.IntPtr core = FindWindowEx(window, System.IntPtr.Zero, "Windows.UI.Core.CoreWindow", null);',
  '  return core == System.IntPtr.Zero ? 0 : PidOf(core);',
  '}',
  // The window counts as `target`'s when its own process is `target`, or when it is a frame
  // ApplicationFrameHost draws for `target`'s CoreWindow. Nothing else does.
  'public static bool Owns(System.IntPtr window, uint target) {',
  '  if (window == System.IntPtr.Zero || target == 0) return false;',
  '  return PidOf(window) == target || HostedPid(window) == target;',
  '}',
  'public static bool FrontIs(uint target) { return Owns(GetForegroundWindow(), target); }',
  // `target`'s own window, the one a person would call the app: the frontmost top-level window
  // it owns that is visible, has no owner and is not a tool window. Not `MainWindowHandle`,
  // which is .NET's first visible unowned one and so, while a tooltip shows, the tooltip's
  // drop shadow (SysShadow, a WS_EX_TOOLWINDOW of the same process; P2D-19).
  '[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr window);',
  '[DllImport("user32.dll")] public static extern System.IntPtr GetWindow(System.IntPtr window, uint how);',
  '[DllImport("user32.dll")] public static extern int GetWindowLong(System.IntPtr window, int index);',
  'public static System.IntPtr WindowOf(uint target) {',
  '  System.IntPtr one = System.IntPtr.Zero;',
  '  while ((one = FindWindowEx(System.IntPtr.Zero, one, null, null)) != System.IntPtr.Zero) {',
  '    if (PidOf(one) != target || !IsWindowVisible(one) || GetWindow(one, 4) != System.IntPtr.Zero) continue;',
  '    int ex = GetWindowLong(one, -20);',
  '    if ((ex & 0x80) != 0 && (ex & 0x40000) == 0) continue;',
  '    return one;',
  '  }',
  '  return System.IntPtr.Zero;',
  '}',
  // The frame ApplicationFrameHost draws for `target`, for an app whose own process has no
  // top-level window of its own to bring forward.
  'public static System.IntPtr FrameOf(uint target) {',
  '  System.IntPtr frame = System.IntPtr.Zero;',
  '  while ((frame = FindWindowEx(System.IntPtr.Zero, frame, "ApplicationFrameWindow", null)) != System.IntPtr.Zero) {',
  '    if (HostedPid(frame) == target) return frame;',
  '  }',
  '  return System.IntPtr.Zero;',
  '}',
  "'@",
].join('\n')

/** What `focus` says when the window did not come to the front. Never *Focused*. */
export const NOT_FRONT = 'Could not bring that window to the front.'

/** What a guarded keystroke or click says when the window in front is somebody else's. */
export const wrongWindow = (what) => `The window in front is not the one I was working in, so I did not ${what}.`

/**
 * The guard, as the opening of a script: when the window in front is not `pid`'s, say so and
 * stop **before** the input lines after it run. In the same PowerShell as the input itself,
 * rather than a spawn of its own, so there is no 200 ms gap between checking and sending for
 * another window to jump into. No pid, no guard: a plain click the owner asked for stays as
 * it was.
 */
export function guarded(pid) {
  if (!(Number(pid) > 0)) return ''
  return [
    FOREGROUND,
    '$front = [Alexia.Front]::FrontPid()',
    // Its own window, or a UWP frame hosting its CoreWindow (`Owns` above). Nothing else.
    `if (-not [Alexia.Front]::FrontIs(${String(Math.round(Number(pid)))})) { ConvertTo-Json @{ refused = $true; front = [int]$front } -Compress; exit }`,
    '',
  ].join('\n')
}

/** The answer from a guarded script, turned into a rejection when the guard stopped it. */
const sentUnless = (what) => (out) => {
  if (/"refused"\s*:\s*true/.test(String(out))) throw new Error(wrongWindow(what))
  return out
}

/** The virtual screen, which is every monitor together rather than only the primary one. */
export const bounds = (signal) =>
  run(
    'Add-Type -AssemblyName System.Windows.Forms;' +
      '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen;' +
      'ConvertTo-Json @{ x = $b.X; y = $b.Y; width = $b.Width; height = $b.Height }',
    signal,
  ).then((out) => JSON.parse(out))

/**
 * Everything on screen, as one PNG.
 *
 * Written out as a script a person would write — one statement per line, variables with
 * names — rather than crammed onto one line the way the rest of this file is. The compact
 * form is the shape a decade of PowerShell screen-grabbers were written in, and Windows'
 * own scanner refuses it on sight: `ScriptContainedMaliciousContent`, before a single
 * statement runs. This form is the same seven calls, and it is the one worth keeping
 * anyway because it is the one somebody can read.
 *
 * **It is not a guarantee.** A scanner that decides differently tomorrow blocks this too,
 * and `run` above turns that into a sentence rather than an error id. The durable answer is
 * a signed build the antivirus already trusts, which is an installer problem, not this
 * file's.
 */
export const screenshot = (to, signal) =>
  run(
    [
      'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
      '$area = [System.Windows.Forms.SystemInformation]::VirtualScreen',
      '$bitmap = New-Object System.Drawing.Bitmap $area.Width, $area.Height',
      '$canvas = [System.Drawing.Graphics]::FromImage($bitmap)',
      '$canvas.CopyFromScreen($area.X, $area.Y, 0, 0, $bitmap.Size)',
      `$bitmap.Save(${quoted(to)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
      '$canvas.Dispose()',
      'ConvertTo-Json @{ width = $bitmap.Width; height = $bitmap.Height }',
      '$bitmap.Dispose()',
    ].join('\n'),
    signal,
  ).then((out) => JSON.parse(out))

/** Where the pointer is now. */
export const cursor = (signal) =>
  run(
    'Add-Type -AssemblyName System.Windows.Forms;' +
      '$p = [System.Windows.Forms.Cursor]::Position;' +
      'ConvertTo-Json @{ x = $p.X; y = $p.Y }',
    signal,
  ).then((out) => JSON.parse(out))

/**
 * The pointer's button and wheel, as one type every mouse script shares.
 *
 * What stood here was `Add-Type -Namespace Mouse -Name Mouse ... -UsingNamespace System`, called
 * as `[Mouse]`. Add-Type already writes `using System;`, so the second one is a compiler warning
 * that Add-Type treats as an error: the type was never made, and every click and scroll died at
 * `[Mouse]` with TypeNotFound, after the pointer had moved (P2D-17). Now: no extra using, the
 * full name `[Alexia.Mouse]`, one definition (a signed wheel amount suits both), and `Stop`, so a
 * script that cannot press says so instead of exiting as if it had.
 */
export const MOUSE = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
  'Add-Type -Namespace Alexia -Name Mouse -MemberDefinition ' +
    '\'[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, int extra);\'',
  '',
].join('\n')

/**
 * Move, and optionally press.
 *
 * `mouse_event` is the P/Invoke: .NET can set the cursor position but has no managed way to
 * synthesise a button press, so the one unavoidable piece of Win32 in this plugin is here
 * and is four lines.
 */
export function click(x, y, button = 'left', double = false, signal, pid) {
  const codes = { left: [0x0002, 0x0004], right: [0x0008, 0x0010], middle: [0x0020, 0x0040] }
  const [down, up] = codes[button] ?? codes.left
  const once = `[Alexia.Mouse]::mouse_event(${down}, 0, 0, 0, 0); Start-Sleep -Milliseconds 30; [Alexia.Mouse]::mouse_event(${up}, 0, 0, 0, 0);`
  return run(
    guarded(pid) +
      MOUSE +
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)}, ${Math.round(y)});` +
      'Start-Sleep -Milliseconds 40;' +
      (double ? `${once} Start-Sleep -Milliseconds 60; ${once}` : once),
    signal,
  ).then(sentUnless('click'))
}

export const move = (x, y, signal) =>
  run(
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;' +
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)}, ${Math.round(y)});`,
    signal,
  )

/** Turn the wheel over a point: `down` lines down (negative is up), `right` lines right. */
export function scroll(x, y, down = 3, right = 0, signal) {
  const lines = (n) => Math.max(-50, Math.min(50, Math.round(n)))
  // One notch is 120 (WHEEL_DELTA), three lines by default; positive wheel is up, so negated.
  const wheel = (flag, n) => (n === 0 ? '' : `[Alexia.Mouse]::mouse_event(${flag}, 0, 0, ${String(-lines(n) * 40)}, 0);`)
  return run(
    MOUSE +
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)}, ${Math.round(y)});` +
      'Start-Sleep -Milliseconds 30;' +
      wheel(0x0800, down) +
      wheel(0x01000, -right),
    signal,
  )
}

/** What Start-Process is handed to reach an app by name, and nothing a name could smuggle. */
const APP_NAME = /^[\p{L}\p{N} ._&'()+-]{1,80}$/u

/** Open an app by name — what the Start menu would find — and answer with its window. */
export async function openApp(name, signal) {
  const wanted = String(name ?? '').trim().replace(/\.exe$/i, '')
  if (!APP_NAME.test(wanted)) throw new Error(`“${wanted}” is not an app name this can open.`)
  /**
   * The process Start-Process made, waited on until it takes input. This is the pid a plan's
   * later keystrokes are guarded with (P2D-17). Before this, the pid came only from a search of
   * window titles that ran ten times and gave up before a slow window (Character Map took over
   * ten seconds) had one, and the task was left with no target at all.
   *
   * A launcher that hands off and exits (`calc.exe`, a browser already open) is not the app, so
   * then the search by name below still runs.
   */
  const started = await run(
    [
      "$ErrorActionPreference = 'Stop'",
      `$p = Start-Process ${quoted(wanted)} -PassThru`,
      'if ($null -eq $p) { Write-Output "null"; exit }',
      'try { [void]$p.WaitForInputIdle(10000) } catch { }',
      '$p.Refresh()',
      // An exited process throws on its name, so those are read only while it is alive.
      '$alive = -not $p.HasExited',
      '$name = ""; $title = ""',
      'if ($alive) { try { $name = $p.ProcessName; $title = $p.MainWindowTitle } catch { } }',
      'ConvertTo-Json @{ pid = [int]$p.Id; alive = $alive; name = [string]$name; title = [string]$title } -Compress',
    ].join('\n'),
    signal,
  )
  let own
  try {
    own = JSON.parse(started)
  } catch {
    own = undefined
  }
  if (own?.alive === true && Number(own.pid) > 0) return { pid: Number(own.pid), name: own.name || wanted, title: own.title ?? '' }
  for (let tries = 0; tries < 10; tries += 1) {
    const found = (await windows(signal)).find((one) => String(one.ProcessName).toLowerCase() === wanted.toLowerCase())
    if (found) return { pid: found.Id, name: found.ProcessName, title: found.MainWindowTitle }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return { name: wanted }
}

/** The web addresses `openUrl` takes. Not `file:`, not a script, not an app's own scheme. */
const WEB = /^(https?:\/\/|mailto:)/i

/** Open a web address in the default browser. */
export async function openUrl(url, signal, browser) {
  const address = String(url ?? '').trim()
  if (!WEB.test(address) || /\s/.test(address)) throw new Error(`“${address}” is not a web address. Give one that starts with https://.`)
  // The executables Windows knows these browsers by, for `Start-Process <browser> <address>`.
  const exe = { 'Google Chrome': 'chrome', 'Microsoft Edge': 'msedge', 'Brave Browser': 'brave', Firefox: 'firefox', Comet: 'comet', Arc: 'arc' }[String(browser)]
  await run(exe ? `Start-Process ${quoted(exe)} ${quoted(address)}` : `Start-Process ${quoted(address)}`, signal)
}

/** AppleScript and Shortcuts are the Mac's; Windows says so rather than pretending. */
export const runScript = () => Promise.reject(new Error('Scripts for apps are AppleScript, which is macOS only.'))
export const runShortcut = () => Promise.reject(new Error('Shortcuts are macOS only.'))
export const shortcuts = () => Promise.resolve([])

/**
 * Type, as the keyboard would.
 *
 * `SendKeys` reads `+^%~(){}[]` as instructions rather than characters, which is how a
 * password containing `+` becomes a Shift press. Every one of them is braced, so what
 * arrives is what was asked for.
 */
export function type(text, signal, pid) {
  const literal = String(text).replace(/([+^%~(){}[\]])/g, '{$1}')
  return run(
    guarded(pid) +
      'Add-Type -AssemblyName System.Windows.Forms;' +
      `[System.Windows.Forms.SendKeys]::SendWait(${quoted(literal)});`,
    signal,
  ).then(sentUnless('type'))
}

/**
 * Every name SendKeys accepts between braces, and no others.
 *
 * The list is the point. What stood here was `\{[A-Za-z0-9_ ]+\}`, which says *braces round
 * some letters* — so `{SUPER}` passed the check, reached SendKeys, and came back as a bare
 * `ArgumentException` with no sentence in it. A grammar that accepts what the thing behind
 * it rejects is worse than no grammar: it turns a correctable mistake into a dead end, and
 * a model that is told nothing tries the same key again.
 */
const KEYWORDS = new Set([
  'backspace', 'bs', 'bksp', 'break', 'capslock', 'delete', 'del', 'down', 'end', 'enter',
  'esc', 'escape', 'help', 'home', 'insert', 'ins', 'left', 'numlock', 'pgdn', 'pgup',
  'prtsc', 'right', 'scrolllock', 'tab', 'up', 'add', 'subtract', 'multiply', 'divide',
  ...Array.from({ length: 16 }, (_, n) => `f${String(n + 1)}`),
])

/** The characters SendKeys reads as instructions, and so the ones braces make literal. */
const ESCAPED = new Set(['+', '^', '%', '~', '(', ')', '[', ']', '{', '}'])

/**
 * The Windows key, which is the hole the list above still has.
 *
 * SendKeys has no notation for it — not a keyword, not a modifier — and *open the start
 * menu* is the first thing anybody asks a computer-control plugin for. So it is spelled the
 * way a model will guess it, all four spellings, and pressed by a different mechanism below.
 */
const WINDOWS_KEY = /^\{(?:win|super|cmd|command|windows|lwin|meta)\}([A-Za-z0-9]?)$/i

/** The key held with Windows, `''` for the Windows key alone, `undefined` when it is not it. */
export const windowsKeyIn = (combination) => WINDOWS_KEY.exec(String(combination).trim())?.[1]

/** A modifier, or the parens that apply one to several keys at once. */
const MODIFIERS = '+^%~()'

/** One key, unbraced. The set SendKeys types as itself — and no space, which is the point. */
const PLAIN = /^[A-Za-z0-9`\-=[\];',./\\]$/

/**
 * The first thing in a combination SendKeys would not understand, or `undefined`.
 *
 * **A combination, not a sentence.** SendKeys would happily type `; Remove-Item` as text,
 * and letting it through here would make this a second `type` tool — one whose log keeps
 * the literal characters, which is the thing `type` deliberately does not do. So a space
 * ends it, exactly as it did before, and the brace groups are checked by name.
 */
export function unknownKey(combination) {
  const combo = String(combination)
  if (combo.trim() === '') return 'nothing'
  let at = 0
  while (at < combo.length) {
    if (combo[at] !== '{') {
      if (MODIFIERS.includes(combo[at]) || PLAIN.test(combo[at])) {
        at += 1
        continue
      }
      // Not one key and not a modifier, so it is the whole combination that is wrong.
      return combo
    }
    // `{}}` is a literal closing brace, so the `}` that ends the group is the second one.
    const closes = combo.indexOf('}', combo[at + 1] === '}' ? at + 2 : at + 1)
    if (closes === -1) return combo.slice(at)
    const inner = combo.slice(at + 1, closes)
    const [name, repeat, ...extra] = inner.split(' ')
    const named = String(name).toLowerCase()
    const literal = ESCAPED.has(name) && repeat === undefined
    // `{LEFT 5}` is five left arrows; anything else after the name is not notation.
    if (extra.length > 0) return `{${inner}}`
    if (repeat !== undefined && !/^\d+$/.test(repeat)) return `{${inner}}`
    if (!literal && !KEYWORDS.has(named)) return `{${inner}}`
    at = closes + 1
  }
  return undefined
}

/**
 * A named key or a combination, in SendKeys' own notation — `{ENTER}`, `^c`, `%{F4}`, and
 * `{WIN}` or `{WIN}r` for the Windows key.
 *
 * Passed through rather than translated, and checked first: this is the one argument a model
 * writes that is executable notation, so anything outside the grammar is refused **with the
 * grammar in the refusal**, which is what makes the next attempt a corrected one.
 */
export function key(combination, signal, pid) {
  const combo = String(combination).trim()
  const win = windowsKeyIn(combo)
  if (win !== undefined) return windowsKey(win, signal, pid)
  const wrong = unknownKey(combo)
  if (wrong !== undefined) {
    throw new Error(
      `"${wrong}" is not a key combination. Use SendKeys notation: {ENTER}, {TAB}, {ESC}, {F5}, {UP}, ` +
        '^c for Ctrl+C, %{F4} for Alt+F4, +{TAB} for Shift+Tab — and {WIN} for the Windows ' +
        'key, or {WIN}r for Windows+R. Ordinary letters are typed as themselves.',
    )
  }
  return run(
    guarded(pid) +
      'Add-Type -AssemblyName System.Windows.Forms;' +
      `[System.Windows.Forms.SendKeys]::SendWait(${quoted(combo)});`,
    signal,
  ).then(sentUnless('type'))
}

/**
 * The Windows key, held down while one other key is pressed.
 *
 * `keybd_event` rather than SendKeys, because SendKeys cannot hold a key down — it sends
 * whole keystrokes, and Windows+R is one key held across another. Same P/Invoke shape as
 * `click` above and the same reason: one Win32 call that .NET has no managed spelling for.
 *
 * ponytail: one partner key, a letter or a digit, whose virtual-key code is its own
 * uppercase character code. {WIN}, {WIN}r, {WIN}d, {WIN}e is the whole of what anybody
 * asks for. A longer chord needs a virtual-key table — add it when something needs one.
 */
function windowsKey(partner, signal, pid) {
  const LWIN = 0x5b
  const RELEASE = 2
  const press = (code, flags) => `[Alexia.Keyboard]::keybd_event(${String(code)}, 0, ${String(flags)}, 0)`
  const other = partner === '' ? undefined : partner.toUpperCase().charCodeAt(0)
  return run(
    guarded(pid) +
    [
      'Add-Type -Namespace Alexia -Name Keyboard -MemberDefinition ' +
        '\'[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, int extra);\'',
      press(LWIN, 0),
      ...(other === undefined ? [] : [press(other, 0), press(other, RELEASE)]),
      press(LWIN, RELEASE),
    ].join('\n'),
    signal,
  ).then(sentUnless('type'))
}

/**
 * Every window with a title, which is the only list a person would recognise.
 *
 * `ConvertTo-Json @(…)` rather than `-AsArray`, which is PowerShell 7 and this is Windows
 * PowerShell 5.1 — the one that ships with Windows, and the one `shell()` above asks for by
 * absolute path. The flag it does not have is a `NamedParameterNotFound` and the whole tool
 * fails. Wrapping is the 5.1 spelling, and it still hands back a bare object when exactly
 * one window matched, so the shape is settled here rather than at every call site.
 */
export const windows = (signal) =>
  run(
    'ConvertTo-Json @(Get-Process | Where-Object { $_.MainWindowTitle -ne "" } |' +
      ' Select-Object -First 40 Id, ProcessName, MainWindowTitle)',
    signal,
  ).then((out) => {
    if (!out) return []
    const list = JSON.parse(out)
    return Array.isArray(list) ? list : [list]
  })

/**
 * Bring one to the front, by process id, and say so only when it is.
 *
 * The standard sequence for a process the foreground lock does not favour: restore the window
 * if it is minimised; attach this thread's input to the thread that owns the window in front,
 * so Windows treats the request as coming from there; `BringWindowToTop`,
 * `SetForegroundWindow`, `SetFocus`; detach. If the window is still not in front, the known
 * unlock: a synthetic Alt press (the lock lets the process that sent the last input take the
 * foreground) around one more `SetForegroundWindow`. Alt goes down before that call and up
 * after it, so neither window sees a whole Alt press, which would open a menu bar in whichever
 * window got both halves. No system setting is read or written (no `SystemParametersInfo`).
 *
 * Then it asks who is in front, and resolves only when it is `pid`. Anything else rejects with
 * `NOT_FRONT`, so the tool answer can never say *Focused* about a window that is not.
 */
export const focusScript = (pid) =>
  [
    FOREGROUND,
    `$target = ${String(Math.round(Number(pid)))}`,
    // Its own window by the rule `WindowOf` spells, not `MainWindowHandle` (P2D-19).
    '$window = [Alexia.Front]::WindowOf($target)',
    // A UWP app's own process has no top-level window: its frame belongs to ApplicationFrameHost.
    'if ($window -eq [System.IntPtr]::Zero) { $window = [Alexia.Front]::FrameOf($target) }',
    'if ($window -eq [System.IntPtr]::Zero) { ConvertTo-Json @{ front = [int][Alexia.Front]::FrontPid(); ok = $false } -Compress; exit }',
    // SW_RESTORE, only when minimised: restoring a maximised window would un-maximise it.
    'if ([Alexia.Front]::IsIconic($window)) { [void][Alexia.Front]::ShowWindow($window, 9) }',
    '$mine = [Alexia.Front]::GetCurrentThreadId()',
    '$theirs = [Alexia.Front]::ThreadOf([Alexia.Front]::GetForegroundWindow())',
    '$attached = $false',
    'if ($theirs -ne 0 -and $theirs -ne $mine) { $attached = [Alexia.Front]::AttachThreadInput($mine, $theirs, $true) }',
    '[void][Alexia.Front]::BringWindowToTop($window)',
    '[void][Alexia.Front]::SetForegroundWindow($window)',
    '[void][Alexia.Front]::SetFocus($window)',
    'if ($attached) { [void][Alexia.Front]::AttachThreadInput($mine, $theirs, $false) }',
    'Start-Sleep -Milliseconds 100',
    'if (-not [Alexia.Front]::FrontIs($target)) {',
    // VK_MENU down, the call, VK_MENU up (KEYEVENTF_KEYUP is 2).
    '  [Alexia.Front]::keybd_event(0x12, 0, 0, [System.UIntPtr]::Zero)',
    '  [void][Alexia.Front]::SetForegroundWindow($window)',
    '  [Alexia.Front]::keybd_event(0x12, 0, 2, [System.UIntPtr]::Zero)',
    '  Start-Sleep -Milliseconds 150',
    '}',
    'ConvertTo-Json @{ front = [int][Alexia.Front]::FrontPid(); ok = [Alexia.Front]::FrontIs($target) } -Compress',
  ].join('\n')

export const focus = (pid, signal) =>
  run(focusScript(pid), signal).then((out) => {
    let answer
    try {
      answer = JSON.parse(out)
    } catch {
      answer = undefined
    }
    // In front means its own window (the pid itself), or a UWP frame hosting it (`ok`).
    const there = Number(answer?.front) === Math.round(Number(pid)) || answer?.ok === true
    if (!(Number(pid) > 0) || !there) throw new Error(NOT_FRONT)
  })

// ---- the control tree ---------------------------------------------------------------------

/**
 * **UI Automation: the tier above OCR, and the one this plugin was missing.**
 *
 * The `screenshot` tool returns a path and a resolution. Nothing reads the pixels — not this
 * plugin, not core, not a model — so `click`'s own description, *use after taking a screenshot
 * and working out where the thing you want actually is*, describes something the tool surface
 * cannot do. The loop is: take a picture it cannot see, then click coordinates it cannot
 * derive.
 *
 * The fix is not OCR. **A document parser answers *what does this say*; a screen needs *is the
 * Save button there, and where*** — and those are different questions. Windows already answers
 * the second one exactly: every control's name, its role, its automation id and its rectangle
 * **in screen coordinates**, which is precisely what a click needs and precisely what a
 * picture does not carry.
 *
 * The economics are not close either. A screenshot spends a large number of tokens encoding a
 * picture a model then has to interpret; the control tree is compact text that states each
 * element's role and name outright.
 *
 * **And it fits this file's own rule, one assembly over.** `UIAutomationClient` and
 * `UIAutomationTypes` are .NET assemblies present on every Windows machine — no native module,
 * no rebuild per Node version, nothing to download. Reading the control tree is *seeing the
 * screen*, which is what `screen.capture` already grants and what its sentence already says,
 * so it needs no twelfth permission either.
 *
 * **Where it is blind, and it is blind in named places.** `BoundingRectangle` comes back empty
 * for anything not currently displaying, and a control that draws itself — a game, a canvas, a
 * PDF inside a viewer, a remote desktop — exposes one element for the whole surface. Those
 * rows come back with no coordinates rather than with wrong ones, and a reader that believed
 * a rectangle unconditionally would click nothing and report success.
 */

/** The two assemblies, and the one P/Invoke. Every script below opens with this. */
const UIA = [
  'Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes',
  'Add-Type -Namespace Alexia -Name Screen -MemberDefinition ' +
    '\'[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();\'',
  '$auto = [System.Windows.Automation.AutomationElement]',
  '$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker',
  // `ControlType.Button` says the same thing as `Button` and costs eleven characters a row,
  // on a list that is read by something charged by the token.
  "function kindOf($info) { $info.ControlType.ProgrammaticName -replace '^ControlType\\.','' }",
].join('\n')

/**
 * **Which of a process's top-level windows is the app** (P2D-19).
 *
 * This was `RootElement.FindFirst(Children, ProcessId = pid)`: the first top-level element of
 * that process, which is the frontmost. Character Map, once focused, shows a tooltip over its
 * grid, and the tooltip's drop shadow is a top-level window of Character Map's own process
 * (class `SysShadow`, an empty 164x25 pane) that sits in front of the dialog. So `elements`
 * walked the shadow, found nothing, and said *Nothing there names itself* — on every run where
 * the pointer happened to rest over the grid, and on none where it did not.
 *
 * Now every top-level element of the process is listed and `pickWindow` chooses: the frontmost
 * one that is a window, else the largest that is not a tooltip or a menu. Never a tooltip, a
 * menu or something with no size: none of those is what anybody means by *that app's window*.
 */
export const candidatesScript = (pid) =>
  [
    'Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes',
    '$auto = [System.Windows.Automation.AutomationElement]',
    `$cond = New-Object System.Windows.Automation.PropertyCondition($auto::ProcessIdProperty, ${String(Math.round(Number(pid)))})`,
    '$rows = New-Object System.Collections.ArrayList',
    'foreach ($one in $auto::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {',
    '  try { $info = $one.Current } catch { continue }',
    '  $r = $info.BoundingRectangle',
    '  $ok = -not ([double]::IsInfinity($r.X) -or [double]::IsNaN($r.X) -or $r.Width -le 0)',
    '  $row = New-Object psobject',
    '  $row | Add-Member NoteProperty handle ([int64]$info.NativeWindowHandle)',
    "  $row | Add-Member NoteProperty type ($info.ControlType.ProgrammaticName -replace '^ControlType\\.','')",
    '  $row | Add-Member NoteProperty kind ([string]$info.ClassName)',
    '  $row | Add-Member NoteProperty name ([string]$info.Name)',
    '  $row | Add-Member NoteProperty w $(if ($ok) { [math]::Round($r.Width) } else { 0 })',
    '  $row | Add-Member NoteProperty h $(if ($ok) { [math]::Round($r.Height) } else { 0 })',
    '  [void]$rows.Add($row)',
    '}',
    'ConvertTo-Json @($rows) -Compress',
  ].join('\n')

/** Not a window anybody means by *that app*, whatever process it belongs to. */
const NOT_THE_APP = new Set(['ToolTip', 'Menu', 'MenuBar'])

/** The chosen candidate from `candidatesScript`'s list, frontmost first; undefined for none. */
export function pickWindow(list) {
  const usable = (Array.isArray(list) ? list : [])
    .filter((one) => Number(one?.handle) > 0 && Number(one.w) > 0 && Number(one.h) > 0)
    .filter((one) => !NOT_THE_APP.has(String(one.type)) && String(one.kind) !== 'SysShadow')
  const window = usable.find((one) => one.type === 'Window')
  if (window) return window
  return usable.reduce((best, one) => (best === undefined || one.w * one.h > best.w * best.h ? one : best), undefined)
}

/** The handle of `pid`'s own window, as `pickWindow` chooses it; undefined when it has none. */
export async function windowOf(pid, signal) {
  const out = await run(candidatesScript(pid), signal)
  let list
  try {
    list = out ? JSON.parse(out) : []
  } catch {
    list = []
  }
  return pickWindow(Array.isArray(list) ? list : [list])?.handle
}

/**
 * Which window to look at, as a script fragment leaving `$start` set.
 *
 * Three ways, in the order a caller is likely to know them: a process id from the `windows`
 * tool, a window title from the same place, or — with neither — whatever is in front. The
 * last is the useful default, because *the thing the user is looking at* is what almost every
 * request is about. A pid is looked up first (`windowOf`), so this is async.
 */
async function targeting({ pid, title } = {}, signal) {
  if (Number(pid) > 0) {
    const handle = await windowOf(pid, signal)
    if (!(Number(handle) > 0)) return '$start = $null'
    return [
      '$start = $null',
      `try { $start = $auto::FromHandle([System.IntPtr]${String(Math.round(Number(handle)))}) } catch { }`,
    ].join('\n')
  }
  if (typeof title === 'string' && title.trim() !== '') {
    // Walked rather than matched with a `PropertyCondition`, because UIA's own conditions are
    // equality only and nobody types a window title exactly.
    return [
      `$wanted = ${quoted(title.trim())}`,
      '$start = $null',
      '$one = $walker.GetFirstChild($auto::RootElement)',
      'while ($null -ne $one -and $null -eq $start) {',
      '  try { if ($one.Current.Name -like "*$wanted*") { $start = $one } } catch { }',
      '  $one = $walker.GetNextSibling($one)',
      '}',
    ].join('\n')
  }
  return '$start = $auto::FromHandle([Alexia.Screen]::GetForegroundWindow())'
}

/** How many nodes one walk may visit. A tree is a tree; a browser's is a large one. */
const VISIT = 2500

/** The breadth-first walk itself, shared by all three readers below. */
const WALK = [
  '$queue = New-Object System.Collections.Queue',
  '$queue.Enqueue($start)',
  '$seen = 0',
].join('\n')

/**
 * Every control that can be addressed, breadth first, with where it is on screen.
 *
 * Breadth first rather than depth: the things a person means are near the top of a window,
 * and a depth-first walk that hits the cap spends it all inside the first toolbar.
 *
 * A row with no name **and** no automation id is not emitted, because there is no way to ask
 * for it later — but it is still walked through, because its children may well be named. The
 * point is a list somebody can act on, not a picture of the tree.
 */
export async function elements({ pid, title, match, limit = 60 } = {}, signal) {
  const most = Math.min(300, Math.max(1, Math.round(Number(limit) || 60)))
  const wanted = typeof match === 'string' && match.trim() !== '' ? match.trim() : undefined
  return run(
    [
      UIA,
      await targeting({ pid, title }, signal),
      'if ($null -eq $start) { Write-Output "[]"; exit }',
      `$wantedText = ${wanted === undefined ? '$null' : quoted(wanted)}`,
      '$rows = New-Object System.Collections.ArrayList',
      WALK,
      `while ($queue.Count -gt 0 -and $rows.Count -lt ${String(most)} -and $seen -lt ${String(VISIT)}) {`,
      '  $node = $queue.Dequeue()',
      '  $seen = $seen + 1',
      '  try { $info = $node.Current } catch { continue }',
      '  $child = $walker.GetFirstChild($node)',
      '  while ($null -ne $child) { $queue.Enqueue($child); $child = $walker.GetNextSibling($child) }',
      '  if ($info.Name -eq "" -and $info.AutomationId -eq "") { continue }',
      '  if ($null -ne $wantedText -and -not ($info.Name -like "*$wantedText*" -or $info.AutomationId -like "*$wantedText*")) { continue }',
      '  $r = $info.BoundingRectangle',
      // The documented empty rectangle: an element that is not displaying reports infinities,
      // and rounding one of those is an overflow rather than a coordinate.
      '  $ok = -not ([double]::IsInfinity($r.X) -or [double]::IsNaN($r.X) -or $r.Width -le 0)',
      '  $row = New-Object psobject',
      '  $row | Add-Member NoteProperty name ([string]$info.Name)',
      '  $row | Add-Member NoteProperty type (kindOf $info)',
      '  $row | Add-Member NoteProperty id ([string]$info.AutomationId)',
      // The middle of the control, because that is what a click wants. The edges are where
      // borders and rounded corners live.
      '  $row | Add-Member NoteProperty x $(if ($ok) { [math]::Round($r.X + $r.Width / 2) } else { $null })',
      '  $row | Add-Member NoteProperty y $(if ($ok) { [math]::Round($r.Y + $r.Height / 2) } else { $null })',
      '  $row | Add-Member NoteProperty w $(if ($ok) { [math]::Round($r.Width) } else { $null })',
      '  $row | Add-Member NoteProperty h $(if ($ok) { [math]::Round($r.Height) } else { $null })',
      '  $row | Add-Member NoteProperty off ([bool]$info.IsOffscreen)',
      '  [void]$rows.Add($row)',
      '}',
      'ConvertTo-Json @($rows) -Compress -Depth 3',
    ].join('\n'),
    signal,
  ).then((out) => {
    if (!out) return []
    const list = JSON.parse(out)
    return Array.isArray(list) ? list : [list]
  })
}

/**
 * What one control **says**, which is the question a postcondition actually asks.
 *
 * *What number is in the calculator display* needs no OCR: that display is an element and its
 * value comes back as text. The general form is the point — **if a person can select the text,
 * an element holds it**, and reading it that way is both cheaper and exact. OCR is for the
 * pixels nobody can select, which is a narrower set than it first appears.
 *
 * Three places a control keeps its words, in the order a control is likely to use them: the
 * value it holds, the text it displays, and failing both its own name.
 */
export async function readElement({ pid, title, match } = {}, signal) {
  return run(
    [
      UIA,
      await targeting({ pid, title }, signal),
      'if ($null -eq $start) { ConvertTo-Json @{ found = $false } -Compress; exit }',
      `$wantedText = ${typeof match === 'string' && match.trim() !== '' ? quoted(match.trim()) : '$null'}`,
      '$found = $null',
      WALK,
      `while ($queue.Count -gt 0 -and $null -eq $found -and $seen -lt ${String(VISIT)}) {`,
      '  $node = $queue.Dequeue()',
      '  $seen = $seen + 1',
      '  try { $info = $node.Current } catch { continue }',
      '  $child = $walker.GetFirstChild($node)',
      '  while ($null -ne $child) { $queue.Enqueue($child); $child = $walker.GetNextSibling($child) }',
      // With nothing to match on, the window itself is the answer — which is how *what does
      // this window say* works without anybody naming a control inside it.
      '  if ($null -eq $wantedText) { $found = $node }',
      '  elseif ($info.Name -like "*$wantedText*" -or $info.AutomationId -like "*$wantedText*") { $found = $node }',
      '}',
      'if ($null -eq $found) { ConvertTo-Json @{ found = $false } -Compress; exit }',
      '$said = $null',
      '$pattern = $null',
      // ValuePattern is what an edit box, a slider and a calculator display all use.
      'if ($found.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { $said = $pattern.Current.Value }',
      'if ([string]::IsNullOrEmpty($said)) {',
      '  if ($found.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) { $said = $pattern.DocumentRange.GetText(4000) }',
      '}',
      'if ([string]::IsNullOrEmpty($said)) { $said = $found.Current.Name }',
      '$r = $found.Current.BoundingRectangle',
      '$ok = -not ([double]::IsInfinity($r.X) -or [double]::IsNaN($r.X) -or $r.Width -le 0)',
      'ConvertTo-Json @{',
      '  found = $true',
      '  text = [string]$said',
      '  name = [string]$found.Current.Name',
      '  type = (kindOf $found.Current)',
      '  x = $(if ($ok) { [math]::Round($r.X + $r.Width / 2) } else { $null })',
      '  y = $(if ($ok) { [math]::Round($r.Y + $r.Height / 2) } else { $null })',
      '} -Compress',
    ].join('\n'),
    signal,
  ).then((out) => JSON.parse(out || '{"found":false}'))
}

/**
 * Press a control **through the control itself**, with no pointer and no keystroke.
 *
 * This is the near-term answer to *could Alexia have a second mouse, so she can work while I
 * do*, and it is a better answer than the question hoped for. Windows was built single-pointer:
 * the window-message system has no field saying which mouse generated an event, so however many
 * are plugged in, applications see one — and no arrangement of software gives a second cursor
 * to other programs. But a UI Automation pattern acts on the control **directly**. Nothing
 * moves, nothing is typed, and nothing contends for the cursor, so most of the need dissolves
 * rather than being solved.
 *
 * The fallback order is Microsoft's own, from `winappCli`: `Invoke`, then `Toggle`, then
 * `SelectionItem`, then `ExpandCollapse`. Where none of them exists this stops and hands back
 * the point the control says is clickable, rather than reaching for the mouse itself — because
 * a real click is the one step that needs the input toggle, and that is the caller's ruling to
 * make and the caller's log to write.
 */
export async function invoke({ pid, title, match } = {}, signal) {
  return run(
    [
      UIA,
      await targeting({ pid, title }, signal),
      'if ($null -eq $start) { ConvertTo-Json @{ found = $false } -Compress; exit }',
      `$wantedText = ${quoted(String(match ?? '').trim())}`,
      '$found = $null',
      WALK,
      `while ($queue.Count -gt 0 -and $null -eq $found -and $seen -lt ${String(VISIT)}) {`,
      '  $node = $queue.Dequeue()',
      '  $seen = $seen + 1',
      '  try { $info = $node.Current } catch { continue }',
      '  $child = $walker.GetFirstChild($node)',
      '  while ($null -ne $child) { $queue.Enqueue($child); $child = $walker.GetNextSibling($child) }',
      '  if ($node -ne $start -and ($info.Name -like "*$wantedText*" -or $info.AutomationId -like "*$wantedText*")) { $found = $node }',
      '}',
      'if ($null -eq $found) { ConvertTo-Json @{ found = $false } -Compress; exit }',
      'if (-not $found.Current.IsEnabled) { ConvertTo-Json @{ found = $true; how = "disabled"; name = [string]$found.Current.Name } -Compress; exit }',
      '$pattern = $null',
      '$how = $null',
      'if ($found.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $pattern.Invoke(); $how = "invoke" }',
      'elseif ($found.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) { $pattern.Toggle(); $how = "toggle" }',
      'elseif ($found.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) { $pattern.Select(); $how = "select" }',
      'elseif ($found.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) { $pattern.Expand(); $how = "expand" }',
      'if ($null -eq $how) {',
      // No pattern at all. The point comes back so the caller can decide whether to spend the
      // input permission on it, rather than this reaching for the mouse on its own.
      '  $point = New-Object System.Windows.Point',
      '  $has = $found.TryGetClickablePoint([ref]$point)',
      '  ConvertTo-Json @{ found = $true; how = "none"; name = [string]$found.Current.Name;',
      '    x = $(if ($has) { [math]::Round($point.X) } else { $null });',
      '    y = $(if ($has) { [math]::Round($point.Y) } else { $null }) } -Compress',
      '  exit',
      '}',
      'ConvertTo-Json @{ found = $true; how = $how; name = [string]$found.Current.Name } -Compress',
    ].join('\n'),
    signal,
  ).then((out) => JSON.parse(out || '{"found":false}'))
}

/** Nothing stays running on Windows between calls, so there is nothing to let go. */
export const close = () => {}

/**
 * The window in front: `{ pid, name, title }`, or null when there is none.
 *
 * `GetForegroundWindow` + `GetWindowThreadProcessId` + its text, through the same P/Invoke as
 * `focus`. A UWP frame answers with the app it hosts rather than with ApplicationFrameHost,
 * which hosts every such app: a task that followed that pid would accept any of them.
 */
export const frontScript = () =>
  [
    FOREGROUND,
    '$window = [Alexia.Front]::GetForegroundWindow()',
    'if ($window -eq [System.IntPtr]::Zero) { Write-Output "null"; exit }',
    '$text = New-Object System.Text.StringBuilder 512',
    '[void][Alexia.Front]::GetWindowText($window, $text, 512)',
    '$hosted = [Alexia.Front]::HostedPid($window)',
    '$owner = if ($hosted -ne 0) { $hosted } else { [Alexia.Front]::PidOf($window) }',
    '$name = (Get-Process -Id $owner -ErrorAction SilentlyContinue).ProcessName',
    'ConvertTo-Json @{ pid = [int]$owner; name = [string]$name; title = $text.ToString() } -Compress',
  ].join('\n')

export const front = (signal) =>
  run(frontScript(), signal).then((out) => {
    let answer
    try {
      answer = JSON.parse(out)
    } catch {
      return null
    }
    if (!(Number(answer?.pid) > 0)) return null
    return { pid: Math.round(Number(answer.pid)), ...(answer.name && { name: String(answer.name) }), title: String(answer.title ?? '') }
  })

// ---- what the screen showed: the window in front, and whether anybody was there -----------

/**
 * **The probe screen memory decides every moment from** (P3-34, ME-06).
 *
 * Which window was in front, whether it covered its monitor, whether it had a title bar, and
 * whether the session was locked. A separate spawn before and after the picture, never part
 * of `screenshot`: that script's shape is what the scanner lets through, and this one adds
 * P/Invoke. It only looks — no `SwitchDesktop`, no focus, no input.
 *
 * Each probe sits in its own `try`, so one failing call leaves its default (`""`, `-1`, `0`,
 * `$null`) and the rest still answer. `windowsState` turns every default into *unknown*,
 * never into a guess.
 *
 * `Screen2`, because `Alexia.Screen` is the elements script's and a type cannot be added twice
 * in one session with a different body. Same P/Invoke shape as `FOREGROUND`: no native module.
 * Rects stay unscaled on both sides: PowerShell is not DPI-aware, so `GetWindowRect` and
 * `rcMonitor` are virtualised alike, and the 2-pixel slack in `windowsState` covers rounding.
 */
const SCREEN_STATE = [
  "Add-Type -Namespace Alexia -Name Screen2 -MemberDefinition @'",
  '[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
  '[StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int Size; public RECT Monitor; public RECT Work; public uint Flags; }',
  '[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr window, out RECT rect);',
  '[DllImport("user32.dll")] public static extern System.IntPtr MonitorFromWindow(System.IntPtr window, uint flags);',
  '[DllImport("user32.dll")] public static extern bool GetMonitorInfo(System.IntPtr monitor, ref MONITORINFO info);',
  '[DllImport("user32.dll")] public static extern System.IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);',
  '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetUserObjectInformation(System.IntPtr handle, int index, System.Text.StringBuilder info, int length, out int needed);',
  '[DllImport("user32.dll")] public static extern bool CloseDesktop(System.IntPtr desktop);',
  '[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);',
  // The input desktop's name (UOI_NAME = 2), opened with DESKTOP_READOBJECTS only and closed
  // again; "" when it cannot be opened, which is what a disconnected session gives.
  'public static string InputDesktop() {',
  '  System.IntPtr desk = OpenInputDesktop(0, false, 1);',
  '  if (desk == System.IntPtr.Zero) return "";',
  '  try {',
  '    System.Text.StringBuilder name = new System.Text.StringBuilder(256);',
  '    int needed;',
  '    if (!GetUserObjectInformation(desk, 2, name, 512, out needed)) return "";',
  '    return name.ToString();',
  '  } finally { CloseDesktop(desk); }',
  '}',
  'public static int[] WindowRect(System.IntPtr window) {',
  '  RECT rect;',
  '  if (!GetWindowRect(window, out rect)) return null;',
  '  return new int[] { rect.Left, rect.Top, rect.Right, rect.Bottom };',
  '}',
  // MONITOR_DEFAULTTONEAREST = 2: the monitor the window is mostly on.
  'public static int[] MonitorRect(System.IntPtr window) {',
  '  System.IntPtr monitor = MonitorFromWindow(window, 2);',
  '  if (monitor == System.IntPtr.Zero) return null;',
  '  MONITORINFO info = new MONITORINFO();',
  '  info.Size = Marshal.SizeOf(typeof(MONITORINFO));',
  '  if (!GetMonitorInfo(monitor, ref info)) return null;',
  '  return new int[] { info.Monitor.Left, info.Monitor.Top, info.Monitor.Right, info.Monitor.Bottom };',
  '}',
  "'@",
].join('\n')

/** The PowerShell the probe runs. Pure: one compressed JSON line, every raw key always present. */
export const screenStateScript = () =>
  [
    FOREGROUND,
    SCREEN_STATE,
    '$desk = ""',
    'try {',
    '  $desk = [string][Alexia.Screen2]::InputDesktop()',
    '} catch { }',
    '$quns = -1',
    'try {',
    '  $state = 0',
    '  $result = [Alexia.Screen2]::SHQueryUserNotificationState([ref]$state)',
    '  if ($result -eq 0) { $quns = [int]$state }',
    '} catch { }',
    '$hwnd = 0',
    '$owner = 0',
    '$name = ""',
    '$title = ""',
    '$style = 0',
    '$window = [System.IntPtr]::Zero',
    'try {',
    '  $window = [Alexia.Front]::GetForegroundWindow()',
    '  if ($window -ne [System.IntPtr]::Zero) { $hwnd = 1 }',
    '} catch { }',
    'if ($hwnd -eq 1) {',
    '  try {',
    '    $text = New-Object System.Text.StringBuilder 512',
    '    [void][Alexia.Front]::GetWindowText($window, $text, 512)',
    '    $title = $text.ToString()',
    '  } catch { }',
    '  try {',
    '    $hosted = [Alexia.Front]::HostedPid($window)',
    '    if ($hosted -ne 0) { $owner = $hosted } else { $owner = [Alexia.Front]::PidOf($window) }',
    '  } catch { }',
    // Never `Get-Process -Id 0`: that is the Idle process, a name for no window at all.
    '  if ($owner -ne 0) {',
    '    try {',
    '      $process = Get-Process -Id $owner -ErrorAction SilentlyContinue',
    '      if ($null -ne $process) { $name = [string]$process.ProcessName }',
    '    } catch { }',
    '  }',
    '  try {',
    '    $style = [int][Alexia.Front]::GetWindowLong($window, -16)',
    '  } catch { }',
    '}',
    '$win = $null',
    '$mon = $null',
    'if ($hwnd -eq 1) {',
    '  try {',
    '    $win = [Alexia.Screen2]::WindowRect($window)',
    '  } catch { }',
    '  try {',
    '    $mon = [Alexia.Screen2]::MonitorRect($window)',
    '  } catch { }',
    '}',
    '$json = ConvertTo-Json @{ desk = [string]$desk; quns = [int]$quns; hwnd = [int]$hwnd; pid = [int]$owner; name = [string]$name; title = [string]$title; style = [int]$style; win = $win; mon = $mon } -Compress',
    // Windows PowerShell 5.1 writes a pipe in the OEM code page, so "Přihlášení" reached Node as
    // "Rihl?sen?" and screen memory's skip list missed it. Every non-ASCII UTF-16 unit becomes a
    // JSON \uXXXX escape (a surrogate pair as two, which JSON.parse joins again), so the line is
    // plain ASCII and no code page can change it.
    "$ascii = [regex]::Replace($json, '[^\\u0000-\\u007F]', { param($m) '\\u{0:x4}' -f [int][char]$m.Value })",
    'Write-Output $ascii',
  ].join('\n')

/** Four finite numbers: a rect the probe really read. */
const rectOf = (value) =>
  Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === 'number' && Number.isFinite(n)) ? value : undefined

/**
 * The probe's raw JSON as `{ locked, front? }`, the shape screen memory reads (P3-19 `frontOf`).
 *
 * **Unknown is a key left out, never a default.** Not sure the session was unlocked: locked.
 * No owner: no `front`. Rects and notification state unreadable: no `fullscreen`. No style: no
 * `titleBar`. The one empty string kept is a real empty window title, which is an answer.
 */
export function windowsState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { locked: true }
  // Winlogon is the lock screen and the UAC / Windows Hello secure desktop; "" is a desktop
  // that could not be opened. QUNS_NOT_PRESENT (1) is a screen saver, a lock or a user switch.
  if (raw.desk !== 'Default' || raw.quns === 1 || raw.hwnd !== 1) return { locked: true }
  if (!(typeof raw.pid === 'number' && raw.pid > 0) || typeof raw.name !== 'string' || raw.name === '') return { locked: false }
  const front = { app: raw.name }
  if (typeof raw.title === 'string') front.title = String(raw.title)
  const win = rectOf(raw.win)
  const mon = rectOf(raw.mon)
  // QUNS_BUSY (2), QUNS_RUNNING_D3D_FULL_SCREEN (3), QUNS_PRESENTATION_MODE (4).
  const busy = raw.quns === 2 || raw.quns === 3 || raw.quns === 4
  const covers =
    win && mon ? win[0] <= mon[0] + 2 && win[1] <= mon[1] + 2 && win[2] >= mon[2] - 2 && win[3] >= mon[3] - 2 : undefined
  if (busy || covers === true) front.fullscreen = true
  else if (covers === false) front.fullscreen = false
  if (typeof raw.style === 'number' && Number.isFinite(raw.style) && raw.style !== 0) {
    // WS_CAPTION is WS_BORDER | WS_DLGFRAME: both bits, or no title bar.
    front.titleBar = (raw.style & 0x00c00000) === 0x00c00000
  }
  return { locked: false, front }
}

/**
 * How long one probe may take. A spawn and an `Add-Type` compile is about a second; a loaded
 * machine can take several. Past this the screenshot is not held up any longer: the moment is
 * reported locked and the PowerShell is killed.
 */
export const PROBE_TIMEOUT = 10_000

/**
 * Run the probe once. Never rejects: a spawn error, a non-zero exit, a script the scanner
 * blocked, output that is not JSON, an aborted signal or a probe that outlives `timeout` all
 * give `{ locked: true }`.
 */
export const screenState = async (signal, timeout = PROBE_TIMEOUT) => {
  if (signal?.aborted) return { locked: true }
  const stop = new AbortController()
  const abort = () => stop.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, timeout)
  // At the deadline, or when the caller gives up, the answer is given whether or not the
  // stopped child ever reports back.
  const late = new Promise((resolve) => stop.signal.addEventListener('abort', () => resolve({ locked: true }), { once: true }))
  try {
    const probe = run(screenStateScript(), stop.signal).then((out) => windowsState(JSON.parse(out)))
    return await Promise.race([probe, late])
  } catch {
    return { locked: true }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
