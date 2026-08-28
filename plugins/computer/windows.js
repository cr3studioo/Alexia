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
    child.on('close', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(said.trim().split('\n').at(-1) ?? `PowerShell exited ${code}`)),
    )
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

/** The virtual screen, which is every monitor together rather than only the primary one. */
export const bounds = (signal) =>
  run(
    'Add-Type -AssemblyName System.Windows.Forms;' +
      '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen;' +
      'ConvertTo-Json @{ x = $b.X; y = $b.Y; width = $b.Width; height = $b.Height }',
    signal,
  ).then((out) => JSON.parse(out))

/** Everything on screen, as one PNG. */
export const screenshot = (to, signal) =>
  run(
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;' +
      '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen;' +
      '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height;' +
      '$g = [System.Drawing.Graphics]::FromImage($bmp);' +
      '$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size);' +
      `$bmp.Save(${quoted(to)}, [System.Drawing.Imaging.ImageFormat]::Png);` +
      '$g.Dispose(); $bmp.Dispose();' +
      `ConvertTo-Json @{ width = $bmp.Width; height = $bmp.Height }`,
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
 * Move, and optionally press.
 *
 * `mouse_event` is the P/Invoke: .NET can set the cursor position but has no managed way to
 * synthesise a button press, so the one unavoidable piece of Win32 in this plugin is here
 * and is four lines.
 */
export function click(x, y, button = 'left', double = false, signal) {
  const codes = { left: [0x0002, 0x0004], right: [0x0008, 0x0010], middle: [0x0020, 0x0040] }
  const [down, up] = codes[button] ?? codes.left
  const once = `[Mouse]::mouse_event(${down}, 0, 0, 0, 0); Start-Sleep -Milliseconds 30; [Mouse]::mouse_event(${up}, 0, 0, 0, 0);`
  return run(
    'Add-Type -AssemblyName System.Windows.Forms;' +
      "Add-Type -Namespace Mouse -Name Mouse -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, int e);' -UsingNamespace System;" +
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)}, ${Math.round(y)});` +
      'Start-Sleep -Milliseconds 40;' +
      (double ? `${once} Start-Sleep -Milliseconds 60; ${once}` : once),
    signal,
  )
}

export const move = (x, y, signal) =>
  run(
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;' +
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)}, ${Math.round(y)});`,
    signal,
  )

/**
 * Type, as the keyboard would.
 *
 * `SendKeys` reads `+^%~(){}[]` as instructions rather than characters, which is how a
 * password containing `+` becomes a Shift press. Every one of them is braced, so what
 * arrives is what was asked for.
 */
export function type(text, signal) {
  const literal = String(text).replace(/([+^%~(){}[\]])/g, '{$1}')
  return run(
    'Add-Type -AssemblyName System.Windows.Forms;' +
      `[System.Windows.Forms.SendKeys]::SendWait(${quoted(literal)});`,
    signal,
  )
}

/**
 * A named key or a combination, in SendKeys' own notation — `{ENTER}`, `^c`, `%{F4}`.
 *
 * Passed through rather than translated, and **checked against what SendKeys actually
 * accepts** first: this is the one argument a model writes that is executable notation, so
 * anything outside the grammar is refused rather than sent and hoped for.
 */
const KEYS = /^(?:[+^%]*(?:\{[A-Za-z0-9_ ]+\}|[A-Za-z0-9`\-=[\];',./\\]))+$/

export function key(combination, signal) {
  if (!KEYS.test(String(combination))) {
    throw new Error(
      `"${String(combination)}" is not a key combination. Use SendKeys notation: {ENTER}, {TAB}, {F5}, ^c for Ctrl+C, %{F4} for Alt+F4.`,
    )
  }
  return run(
    'Add-Type -AssemblyName System.Windows.Forms;' +
      `[System.Windows.Forms.SendKeys]::SendWait(${quoted(combination)});`,
    signal,
  )
}

/** Every window with a title, which is the only list a person would recognise. */
export const windows = (signal) =>
  run(
    'Get-Process | Where-Object { $_.MainWindowTitle -ne "" } |' +
      ' Select-Object -First 40 Id, ProcessName, MainWindowTitle | ConvertTo-Json -AsArray',
    signal,
  ).then((out) => (out ? JSON.parse(out) : []))

/** Bring one to the front, by process id. */
export const focus = (pid, signal) =>
  run(
    'Add-Type -AssemblyName Microsoft.VisualBasic;' +
      `[Microsoft.VisualBasic.Interaction]::AppActivate(${Math.round(pid)});`,
    signal,
  )
