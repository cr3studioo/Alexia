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
 * Which window to look at, as a script fragment leaving `$start` set.
 *
 * Three ways, in the order a caller is likely to know them: a process id from the `windows`
 * tool, a window title from the same place, or — with neither — whatever is in front. The
 * last is the useful default, because *the thing the user is looking at* is what almost every
 * request is about.
 */
function targeting({ pid, title } = {}) {
  if (Number(pid) > 0) {
    return [
      `$cond = New-Object System.Windows.Automation.PropertyCondition($auto::ProcessIdProperty, ${String(Math.round(Number(pid)))})`,
      '$start = $auto::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)',
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
export function elements({ pid, title, match, limit = 60 } = {}, signal) {
  const most = Math.min(300, Math.max(1, Math.round(Number(limit) || 60)))
  const wanted = typeof match === 'string' && match.trim() !== '' ? match.trim() : undefined
  return run(
    [
      UIA,
      targeting({ pid, title }),
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
export function readElement({ pid, title, match } = {}, signal) {
  return run(
    [
      UIA,
      targeting({ pid, title }),
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
export function invoke({ pid, title, match } = {}, signal) {
  return run(
    [
      UIA,
      targeting({ pid, title }),
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
