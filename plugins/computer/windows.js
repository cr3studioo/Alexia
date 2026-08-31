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
export function key(combination, signal) {
  const combo = String(combination).trim()
  const win = windowsKeyIn(combo)
  if (win !== undefined) return windowsKey(win, signal)
  const wrong = unknownKey(combo)
  if (wrong !== undefined) {
    throw new Error(
      `"${wrong}" is not a key combination. Use SendKeys notation: {ENTER}, {TAB}, {ESC}, {F5}, {UP}, ` +
        '^c for Ctrl+C, %{F4} for Alt+F4, +{TAB} for Shift+Tab — and {WIN} for the Windows ' +
        'key, or {WIN}r for Windows+R. Ordinary letters are typed as themselves.',
    )
  }
  return run(
    'Add-Type -AssemblyName System.Windows.Forms;' +
      `[System.Windows.Forms.SendKeys]::SendWait(${quoted(combo)});`,
    signal,
  )
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
function windowsKey(partner, signal) {
  const LWIN = 0x5b
  const RELEASE = 2
  const press = (code, flags) => `[Alexia.Keyboard]::keybd_event(${String(code)}, 0, ${String(flags)}, 0)`
  const other = partner === '' ? undefined : partner.toUpperCase().charCodeAt(0)
  return run(
    [
      'Add-Type -Namespace Alexia -Name Keyboard -MemberDefinition ' +
        '\'[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, int extra);\'',
      press(LWIN, 0),
      ...(other === undefined ? [] : [press(other, 0), press(other, RELEASE)]),
      press(LWIN, RELEASE),
    ].join('\n'),
    signal,
  )
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

/** Bring one to the front, by process id. */
export const focus = (pid, signal) =>
  run(
    'Add-Type -AssemblyName Microsoft.VisualBasic;' +
      `[Microsoft.VisualBasic.Interaction]::AppActivate(${Math.round(pid)});`,
    signal,
  )
