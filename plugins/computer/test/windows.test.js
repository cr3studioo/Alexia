// SPDX-License-Identifier: AGPL-3.0-only
import { EventEmitter } from 'node:events'
import { beforeEach, expect, test, vi } from 'vitest'
import { act, actResult, actScript, candidatesScript, click, clickBack, clickScript, hows, PRESS, elements, focus, focusScript, front, frontScript, invoke, key, MOUSE, NOT_FRONT, openApp, pickWindow, PROBE_TIMEOUT, quoted, readElement, screenState, screenStateScript, scroll, type, unknownKey, windowOf, windowsKeyIn, windowsState, wrongWindow } from '../windows.js'

/**
 * PowerShell, faked. Every script `run` would hand to powershell.exe lands in `spawned`, and
 * the fake answers with whatever `answer` returns for it, the way the real one prints JSON.
 * Nothing reaches a real shell, so nothing here can type into, click on or focus a window.
 */
const shell = vi.hoisted(() => ({ spawned: [], signals: [], answer: () => '', end: 'ok' }))
vi.mock('node:child_process', () => ({
  spawn: (_exe, args, options) => {
    const script = args.at(-1)
    shell.spawned.push(script)
    shell.signals.push(options?.signal)
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    void Promise.resolve().then(() => {
      // `end` is how the run finishes: printed and exited 0, exited non-zero, never started, or
      // hung: it prints nothing and never exits, and (unlike the real spawn) ignores its signal.
      if (shell.end === 'hang') return
      if (shell.end === 'error') return child.emit('error', new Error('spawn powershell.exe ENOENT'))
      child.stdout.emit('data', shell.answer(script))
      if (shell.end === 'exit') child.stderr.emit('data', 'Something went wrong')
      child.emit('close', shell.end === 'exit' ? 1 : 0)
    })
    return child
  },
}))

beforeEach(() => {
  shell.spawned.length = 0
  shell.signals.length = 0
  shell.answer = () => ''
  shell.end = 'ok'
})

/**
 * The fake's stand-in for Windows' own answer to *who is in front*, following the rule the
 * C# `Owns` spells (checked against the script in the UWP test below): the window in front
 * belongs to process `front`; when that is an ApplicationFrameHost frame, `hosted` is the
 * process of the CoreWindow inside it. A guarded script stops unless its pid is one of the two;
 * a focus script reports `front` and whether its target owns it; `front()` reports the app.
 */
const inFront = (front, hosted) => (script) => {
  const owns = (pid) => pid === front || (hosted !== undefined && pid === hosted)
  const wanted = /if \(-not \[Alexia\.Front\]::FrontIs\((\d+)\)\)/.exec(script)?.[1]
  if (wanted !== undefined && !owns(Number(wanted))) return JSON.stringify({ refused: true, front })
  const target = /\$target = (\d+)/.exec(script)?.[1]
  if (target !== undefined) return JSON.stringify({ front, ok: owns(Number(target)) })
  if (script.includes('GetWindowText($window')) return JSON.stringify({ pid: hosted ?? front, name: 'app', title: 'A window' })
  return ''
}

/** The guard's last statement. Whatever follows it runs only when the right window is in front. */
const GUARD_END = '-Compress; exit }'
const beforeGuardEnds = (script) => script.slice(0, script.indexOf(GUARD_END) + GUARD_END.length)
const afterGuard = (script) => script.slice(script.indexOf(GUARD_END) + GUARD_END.length)

// This plugin builds PowerShell out of strings a model wrote. That is the one place here
// where getting it wrong is not a bug but a hole, so the two functions standing between a
// model's argument and a shell are the two with tests.

test('a value from a model cannot leave its own quotes', () => {
  // Inside single quotes PowerShell expands nothing — no $, no backtick, no subexpression.
  // The only way out is a quote of your own, and doubling it is the whole defence.
  expect(quoted("it's fine")).toBe("'it''s fine'")
  expect(quoted("'; Remove-Item C:\\ -Recurse; '")).toBe("'''; Remove-Item C:\\ -Recurse; '''")
  expect(quoted('$(whoami)')).toBe("'$(whoami)'")
  expect(quoted('`n')).toBe("'`n'")
  // PowerShell also reads the four typographic single quotes as quotes: every one is doubled.
  expect(quoted('don’t')).toBe("'don’’t'")
  expect(quoted('‘a’ ‚b‛')).toBe("'‘‘a’’ ‚‚b‛‛'")
  expect(quoted('’; Remove-Item C:\ -Recurse; ’')).toBe("'’’; Remove-Item C:\ -Recurse; ’’'")
  // The prime and the double quotes are not single quotes to PowerShell and stay as they are.
  expect(quoted('′ “”')).toBe("'′ “”'")
})

test('a key combination is checked against the notation, not sent and hoped for', () => {
  // The one argument a model writes that is executable notation rather than data. Anything
  // outside the grammar is refused with a sentence naming the grammar, so the next attempt
  // is a corrected one rather than the same one again — and it is refused *before* a shell
  // is spawned, which is why this throws rather than rejecting.
  expect(() => key('{ENTER}; Remove-Item')).toThrow(/not a key combination/)
  expect(() => key('$(bad)')).toThrow(/SendKeys notation/)
  expect(() => key('')).toThrow(/not a key combination/)
  expect(shell.spawned).toHaveLength(0)
})

test('the notation the docs promise actually passes the check', () => {
  // A grammar that rejects what the tool description tells the model to send would be
  // worse than no grammar: the model would be right and the plugin would refuse.
  // `key` spawns PowerShell on a valid combination, so what is checked is the grammar
  // itself — anything else here would be measuring Windows.
  const accepted = ['{ENTER}', '{TAB}', '{ESC}', '{F5}', '{F16}', '^c', '^v', '%{F4}', '+{TAB}', '^+{HOME}', 'a', '{LEFT 5}', '{{}', '{}}']
  for (const combination of accepted) expect(unknownKey(combination)).toBeUndefined()
})

test('a key SendKeys does not have is named, not sent and hoped for', () => {
  // The bug this replaced: `{SUPER}` matched *braces round some letters*, reached SendKeys,
  // and came back as a bare ArgumentException — nothing a model can act on, so it tries the
  // same key again. Checking against the real keyword list is what makes the refusal a
  // sentence, and the sentence is what makes the next attempt a different one.
  expect(unknownKey('{SUPER}')).toBe('{SUPER}')
  expect(unknownKey('{CTRL}')).toBe('{CTRL}')
  expect(unknownKey('{F17}')).toBe('{F17}')
  expect(unknownKey('{ENTER')).toBe('{ENTER')
  expect(unknownKey('{LEFT five}')).toBe('{LEFT five}')
  // And the refusal names the notation, including the one SendKeys itself does not have.
  expect(() => key('{CTRL}')).toThrow(/\{WIN\}/)
})

test('the Windows key is a key, even though SendKeys has no name for it', () => {
  // `{SUPER}` was what a model actually reached for, and it is the same key. All four
  // spellings go to `keybd_event` rather than to SendKeys, which cannot hold a key down.
  // SendKeys has no name for any of them — which is why they are routed away from it.
  for (const spelling of ['{WIN}', '{SUPER}', '{CMD}', '{WINDOWS}']) {
    expect(unknownKey(spelling)).toBe(spelling)
    expect(windowsKeyIn(spelling)).toBe('')
  }
  expect(windowsKeyIn('{WIN}r')).toBe('r')
  expect(windowsKeyIn('{win}d')).toBe('d')
  // Not the Windows key, and so still checked against the SendKeys list.
  expect(windowsKeyIn('{ENTER}')).toBeUndefined()
  expect(windowsKeyIn('{WIN}{TAB}')).toBeUndefined()
})

// ---- the window in front (P2D-16) -----------------------------------------------------------

test('focus checks the window really came to the front', async () => {
  // The P2D-12 failure: AppActivate was refused by the foreground lock and `focus` said
  // Focused anyway. Now the script asks Windows who is in front after trying, and `focus`
  // believes the answer, not the attempt.
  shell.answer = inFront(4242)
  await expect(focus(4242)).resolves.toBeUndefined()

  shell.answer = inFront(20768)
  await expect(focus(4242)).rejects.toThrow(NOT_FRONT)
  // Silence, or something that is not the answer, is not a yes either.
  shell.answer = () => ''
  await expect(focus(4242)).rejects.toThrow(NOT_FRONT)
  shell.answer = () => 'not json'
  await expect(focus(4242)).rejects.toThrow(NOT_FRONT)
  expect(NOT_FRONT).toBe('Could not bring that window to the front.')
})

test('the focus script tries the sequence that works under the foreground lock, then checks', () => {
  const script = focusScript(4242)
  const at = (text, from = 0) => {
    const where = script.indexOf(text, from)
    expect(where, text).toBeGreaterThan(-1)
    return where
  }
  expect(script).not.toMatch(/AppActivate/)
  // Restore when minimised, attach to the foreground thread, the three calls, detach.
  const restore = at('[Alexia.Front]::ShowWindow($window, 9)')
  const attach = at('AttachThreadInput($mine, $theirs, $true)')
  const top = at('[Alexia.Front]::BringWindowToTop($window)')
  const fore = at('[Alexia.Front]::SetForegroundWindow($window)')
  const focusing = at('[Alexia.Front]::SetFocus($window)')
  const detach = at('AttachThreadInput($mine, $theirs, $false)')
  expect(restore).toBeLessThan(attach)
  expect(attach).toBeLessThan(top)
  expect(top).toBeLessThan(fore)
  expect(fore).toBeLessThan(focusing)
  expect(focusing).toBeLessThan(detach)
  // Only if still not in front: Alt down, SetForegroundWindow once more, Alt up.
  const unlock = at('if (-not [Alexia.Front]::FrontIs($target)) {')
  const altDown = at('keybd_event(0x12, 0, 0,')
  const again = at('SetForegroundWindow($window)', altDown)
  const altUp = at('keybd_event(0x12, 0, 2,')
  expect(detach).toBeLessThan(unlock)
  expect(unlock).toBeLessThan(altDown)
  expect(altDown).toBeLessThan(again)
  expect(again).toBeLessThan(altUp)
  // And the check itself: GetForegroundWindow + GetWindowThreadProcessId, asked last.
  expect(script).toMatch(/GetForegroundWindow\(\)/)
  expect(script).toMatch(/GetWindowThreadProcessId/)
  expect(script.trim().split('\n').at(-1)).toBe('ConvertTo-Json @{ front = [int][Alexia.Front]::FrontPid(); ok = [Alexia.Front]::FrontIs($target) } -Compress')
  // No system setting is changed to get there.
  expect(script).not.toMatch(/SystemParametersInfo/)
})

test('typing refuses when another window is in front', async () => {
  shell.answer = inFront(20768)
  await expect(type('hello', undefined, 4242)).rejects.toThrow(wrongWindow('type'))
  expect(wrongWindow('type')).toBe('The window in front is not the one I was working in, so I did not type.')
  // One script, and the text sits only after its guard: the guard's `exit` comes first, so a
  // refusal leaves SendKeys unreached.
  expect(shell.spawned).toHaveLength(1)
  const [script] = shell.spawned
  expect(beforeGuardEnds(script)).toMatch(/FrontIs\(4242\)/)
  expect(beforeGuardEnds(script)).not.toMatch(/SendWait|hello/)
  expect(afterGuard(script)).toMatch(/SendWait\('hello'\)/)

  // The right window in front: it types, and nothing is refused.
  shell.answer = inFront(4242)
  await expect(type('hello', undefined, 4242)).resolves.toBe('')
})

test('a key press refuses when another window is in front', async () => {
  shell.answer = inFront(20768)
  await expect(key('{ENTER}', undefined, 4242)).rejects.toThrow(wrongWindow('type'))
  await expect(key('{WIN}r', undefined, 4242)).rejects.toThrow(wrongWindow('type'))
  expect(shell.spawned).toHaveLength(2)
  for (const script of shell.spawned) {
    expect(beforeGuardEnds(script)).toMatch(/FrontIs\(4242\)/)
    expect(beforeGuardEnds(script)).not.toMatch(/SendWait|Keyboard/)
  }
  expect(afterGuard(shell.spawned[0])).toMatch(/SendWait\('\{ENTER\}'\)/)
  expect(afterGuard(shell.spawned[1])).toMatch(/keybd_event\(91, 0, 0, 0\)/)

  shell.answer = inFront(4242)
  await expect(key('{ENTER}', undefined, 4242)).resolves.toBe('')
})

test('a click refuses when another window is in front', async () => {
  shell.answer = inFront(20768)
  await expect(click(10, 20, 'left', false, undefined, 4242)).rejects.toThrow(wrongWindow('click'))
  expect(wrongWindow('click')).toBe('The window in front is not the one I was working in, so I did not click.')
  const [script] = shell.spawned
  expect(beforeGuardEnds(script)).toMatch(/FrontIs\(4242\)/)
  // Neither the pointer move nor the button press comes before the guard.
  expect(beforeGuardEnds(script)).not.toMatch(/mouse_event|Cursor\]::Position/)
  expect(afterGuard(script)).toMatch(/mouse_event\(2,/)

  shell.answer = inFront(4242)
  await expect(click(10, 20, 'left', false, undefined, 4242)).resolves.toBe('')
})

test('with no window to work in, input is sent as before, with no guard', async () => {
  // A plain screen click the owner asked for has no target, and stays exactly as in v2.
  shell.answer = inFront(20768)
  await expect(type('hi')).resolves.toBe('')
  await expect(key('^c')).resolves.toBe('')
  await expect(click(1, 2)).resolves.toBe('')
  expect(shell.spawned).toHaveLength(3)
  for (const script of shell.spawned) expect(script).not.toMatch(/Alexia\.Front|\$front/)
})

// ---- following the window a plan opens (P2D-17) ----------------------------------------------

test('front returns the foreground window on Windows', async () => {
  // It was `null` on Windows, so a task that opened a page never followed it to the browser.
  shell.answer = inFront(31337)
  await expect(front()).resolves.toEqual({ pid: 31337, name: 'app', title: 'A window' })
  const script = frontScript()
  expect(shell.spawned).toEqual([script])
  // GetForegroundWindow + GetWindowThreadProcessId + the window's text, in the one script.
  expect(script).toMatch(/GetForegroundWindow\(\)/)
  expect(script).toMatch(/GetWindowThreadProcessId/)
  expect(script).toMatch(/GetWindowText\(\$window, \$text, 512\)/)
  // A UWP frame answers with the app inside it, not ApplicationFrameHost, which hosts them all.
  expect(script).toMatch(/\$owner = if \(\$hosted -ne 0\) \{ \$hosted \}/)
  shell.answer = inFront(9000, 4242)
  await expect(front()).resolves.toMatchObject({ pid: 4242 })
  // No window in front, or an answer that is not one: null, as it was.
  shell.answer = () => 'null'
  await expect(front()).resolves.toBeNull()
  shell.answer = () => 'not json'
  await expect(front()).resolves.toBeNull()
  shell.answer = () => JSON.stringify({ pid: 0, title: '' })
  await expect(front()).resolves.toBeNull()
})

test('a UWP window hosted by ApplicationFrameHost passes focus and the guard', async () => {
  // Calculator: the frame in front belongs to ApplicationFrameHost (9000); the CoreWindow
  // inside it belongs to CalculatorApp (4242), which is the pid the task targets.
  shell.answer = inFront(9000, 4242)
  await expect(focus(4242)).resolves.toBeUndefined()
  await expect(type('7', undefined, 4242)).resolves.toBe('')
  await expect(key('{ENTER}', undefined, 4242)).resolves.toBe('')
  await expect(click(5, 5, 'left', false, undefined, 4242)).resolves.toBe('')
  // Targeting ApplicationFrameHost itself is its own window: an exact match, as before.
  await expect(focus(9000)).resolves.toBeUndefined()
  await expect(type('7', undefined, 9000)).resolves.toBe('')

  // The rule the fake follows is the one the scripts carry: the guard and focus both ask
  // `FrontIs`, which is the window's own pid, or the pid of the CoreWindow child of a frame
  // that ApplicationFrameHost owns.
  const guard = shell.spawned[1]
  expect(beforeGuardEnds(guard)).toMatch(/if \(-not \[Alexia\.Front\]::FrontIs\(4242\)\)/)
  for (const script of [guard, focusScript(4242)]) {
    expect(script).toContain('return PidOf(window) == target || HostedPid(window) == target;')
    expect(script).toContain('.ProcessName != "ApplicationFrameHost") return 0;')
    expect(script).toContain('FindWindowEx(window, System.IntPtr.Zero, "Windows.UI.Core.CoreWindow", null)')
    expect(script).toContain('public static bool FrontIs(uint target) { return Owns(GetForegroundWindow(), target); }')
  }
  // A UWP app's own process has no top-level window, so focus brings its frame forward.
  expect(focusScript(4242)).toContain('if ($window -eq [System.IntPtr]::Zero) { $window = [Alexia.Front]::FrameOf($target) }')
})

test('an unrelated window is still refused', async () => {
  // Another UWP app in front (frame 9000, CoreWindow 5555) and a plain window (20768): neither
  // is 4242's, so nothing is sent and focus does not say it worked.
  for (const answer of [inFront(9000, 5555), inFront(20768)]) {
    shell.spawned.length = 0
    shell.answer = answer
    await expect(type('secret', undefined, 4242)).rejects.toThrow(wrongWindow('type'))
    await expect(key('{ENTER}', undefined, 4242)).rejects.toThrow(wrongWindow('type'))
    await expect(click(5, 5, 'left', false, undefined, 4242)).rejects.toThrow(wrongWindow('click'))
    await expect(focus(4242)).rejects.toThrow(NOT_FRONT)
    // And every input line sat after the guard's exit, so the refusal reached none of them.
    for (const script of shell.spawned.slice(0, 3)) expect(beforeGuardEnds(script)).not.toMatch(/SendWait|mouse_event|secret/)
  }
  // focus believes `ok` only when it is true: a missing or false one is not a yes.
  shell.answer = () => JSON.stringify({ front: 20768 })
  await expect(focus(4242)).rejects.toThrow(NOT_FRONT)
  shell.answer = () => JSON.stringify({ front: 20768, ok: false })
  await expect(focus(4242)).rejects.toThrow(NOT_FRONT)
})

test('a click and a scroll make their mouse type the way that compiles', async () => {
  // The bug: `-UsingNamespace System` repeats the `using System;` Add-Type already writes,
  // which compiles as an error, so `[Mouse]` never existed and every click died with
  // TypeNotFound after the pointer had moved. Now one definition, no extra using, a full name.
  await click(10, 20)
  await scroll(10, 20, 3)
  expect(shell.spawned).toHaveLength(2)
  for (const script of shell.spawned) {
    expect(script).not.toMatch(/-UsingNamespace/)
    expect(script).not.toMatch(/(?<!Alexia\.)\[Mouse\]::/)
    expect(script.startsWith(MOUSE)).toBe(true)
    // Defined before it is used, and a failure stops the script rather than passing silently.
    expect(script.indexOf('Add-Type -Namespace Alexia -Name Mouse')).toBeLessThan(script.indexOf('[Alexia.Mouse]::mouse_event'))
    expect(script.indexOf("$ErrorActionPreference = 'Stop'")).toBeLessThan(script.indexOf('Add-Type'))
  }
  expect(MOUSE).toContain('System.Windows.Forms, System.Drawing')
  expect(shell.spawned[0]).toMatch(/\[Alexia\.Mouse\]::mouse_event\(2, 0, 0, 0, 0\)/)
  expect(shell.spawned[1]).toMatch(/\[Alexia\.Mouse\]::mouse_event\(2048, 0, 0, -120, 0\)/)
  // With a pid, the guard comes first and the mouse script after it, unchanged.
  shell.spawned.length = 0
  shell.answer = inFront(4242)
  await click(10, 20, 'left', false, undefined, 4242)
  expect(afterGuard(shell.spawned[0])).toContain(MOUSE)
})

test('openApp answers with the process it started, and searches by name only after a hand-off', async () => {
  // Character Map took over ten seconds to get a window title, the title search gave up, and the
  // plan was left with no pid to guard with. The pid now comes from Start-Process itself.
  shell.answer = (script) => (script.includes('-PassThru') ? JSON.stringify({ pid: 15512, alive: true, name: 'charmap', title: 'Character Map' }) : '[]')
  await expect(openApp('charmap')).resolves.toEqual({ pid: 15512, name: 'charmap', title: 'Character Map' })
  expect(shell.spawned).toHaveLength(1)
  expect(shell.spawned[0]).toMatch(/\$p = Start-Process 'charmap' -PassThru/)
  expect(shell.spawned[0]).toMatch(/WaitForInputIdle/)
  // A missing app is an error, not a silent nothing.
  expect(shell.spawned[0].indexOf("$ErrorActionPreference = 'Stop'")).toBe(0)

  // calc.exe hands off to CalculatorApp and exits: its pid is not the app, so the name search runs.
  shell.spawned.length = 0
  shell.answer = (script) =>
    script.includes('-PassThru') ? JSON.stringify({ pid: 300, alive: false, name: '', title: '' })
    : JSON.stringify([{ Id: 4242, ProcessName: 'notes', MainWindowTitle: 'Notes' }])
  await expect(openApp('notes')).resolves.toEqual({ pid: 4242, name: 'notes', title: 'Notes' })
  expect(shell.spawned).toHaveLength(2)
})

// ---- which window of a process `elements`, `read` and `invoke` look in (P2D-19) ----

/**
 * What `candidatesScript` printed on this PC for a Character Map that had just been focused:
 * a tooltip's drop shadow (SysShadow, a 164x25 pane of the same process) in front of the dialog.
 * `FindFirst(Children, ProcessId)` took the shadow, and `elements` said *Nothing there names
 * itself*.
 */
const SHADOW = { handle: 1444132, type: 'Pane', kind: 'SysShadow', name: '', w: 164, h: 25 }
const DIALOG = { handle: 1444248, type: 'Window', kind: '#32770', name: 'Character Map', w: 491, h: 437 }
const BOX = { name: 'Characters to copy :', type: 'Edit', id: '104', x: 240, y: 418, w: 165, h: 26, off: false }
const isCandidates = (script) => script.includes('RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)')

/** Windows, faked: the candidates, then the dialog's controls only when the walk starts at the dialog. */
const charmap = (candidates) => (script) => {
  if (isCandidates(script)) return JSON.stringify(candidates)
  if (script.includes(`FromHandle([System.IntPtr]${String(DIALOG.handle)})`)) {
    if (script.includes('$found')) return JSON.stringify({ found: true, text: 'hello', name: BOX.name, type: 'Edit', x: 240, y: 418, how: 'none' })
    return JSON.stringify([BOX])
  }
  return script.includes('$found') ? JSON.stringify({ found: false }) : '[]'
}

test('elements lists the app window, not the tooltip shadow in front of it', async () => {
  shell.answer = charmap([SHADOW, DIALOG])
  await expect(elements({ pid: 17360 })).resolves.toEqual([BOX])
  expect(shell.spawned).toHaveLength(2)
  const [candidates, walk] = shell.spawned
  expect(candidates).toBe(candidatesScript(17360))
  expect(candidates).toContain('ProcessIdProperty, 17360)')
  // The walk starts at the window chosen, by its handle, and never at the first one by pid.
  expect(walk).toContain(`$start = $auto::FromHandle([System.IntPtr]${String(DIALOG.handle)})`)
  expect(walk).not.toContain(String(SHADOW.handle))
  expect(walk).not.toMatch(/FindFirst\(\[System\.Windows\.Automation\.TreeScope\]::Children, \$cond\)/)
  // The order the shadow comes in does not matter: it is never the one.
  shell.spawned.length = 0
  shell.answer = charmap([DIALOG, SHADOW])
  await expect(elements({ pid: 17360 })).resolves.toEqual([BOX])
})

test('read and invoke look in the same window elements does', async () => {
  shell.answer = charmap([SHADOW, DIALOG])
  await expect(readElement({ pid: 17360, match: '104' })).resolves.toMatchObject({ found: true, text: 'hello' })
  await expect(invoke({ pid: 17360, match: '104' })).resolves.toMatchObject({ found: true })
  for (const script of shell.spawned.filter((one) => !isCandidates(one))) {
    expect(script).toContain(`FromHandle([System.IntPtr]${String(DIALOG.handle)})`)
  }
})

test('a process with no window of its own is an empty answer, not somebody else’s window', async () => {
  // Only the shadow (or nothing at all, or something unparseable): no walk starts anywhere.
  for (const answer of [JSON.stringify([SHADOW]), '', '[]', 'not json']) {
    shell.spawned.length = 0
    shell.answer = (script) => (isCandidates(script) ? answer : JSON.stringify([BOX]))
    const walked = await elements({ pid: 17360 })
    expect(shell.spawned[1]).toContain('$start = $null\nif ($null -eq $start) { Write-Output "[]"; exit }')
    expect(shell.spawned[1]).not.toContain('FromHandle([System.IntPtr]')
    // The fake answers the walk anyway; the real script exits before it at `$start = $null`.
    expect(Array.isArray(walked)).toBe(true)
  }
  // One candidate comes back from ConvertTo-Json as a bare object, not a list.
  shell.answer = (script) => (isCandidates(script) ? JSON.stringify(DIALOG) : JSON.stringify([BOX]))
  await expect(windowOf(17360)).resolves.toBe(DIALOG.handle)
})

test('pickWindow: the frontmost window, else the largest thing that is not a tooltip or menu', () => {
  const tip = { handle: 1, type: 'ToolTip', kind: 'tooltips_class32', name: 'U+0041', w: 300, h: 300 }
  const menu = { handle: 2, type: 'Menu', kind: '#32768', name: '', w: 400, h: 400 }
  const hidden = { handle: 3, type: 'Window', kind: '#32770', name: 'Gone', w: 0, h: 0 }
  const small = { handle: 4, type: 'Pane', kind: 'Chrome_WidgetWin_1', name: '', w: 10, h: 10 }
  const big = { handle: 5, type: 'Pane', kind: 'Chrome_WidgetWin_1', name: 'Page', w: 1200, h: 800 }
  const second = { ...DIALOG, handle: 6, name: 'Advanced' }
  expect(pickWindow([SHADOW, DIALOG])).toBe(DIALOG)
  expect(pickWindow([tip, menu, SHADOW, DIALOG, second])).toBe(DIALOG)
  expect(pickWindow([hidden, second, DIALOG])).toBe(second)
  // A browser's top-level window is a pane: the largest one, never a bigger tooltip or menu.
  expect(pickWindow([tip, small, menu, big])).toBe(big)
  expect(pickWindow([SHADOW])).toBeUndefined()
  expect(pickWindow([tip, menu, hidden])).toBeUndefined()
  expect(pickWindow([])).toBeUndefined()
  expect(pickWindow(undefined)).toBeUndefined()
})

test('focus brings the app window forward, not whatever MainWindowHandle says', () => {
  // MainWindowHandle is the first visible unowned window, which was the shadow too.
  const script = focusScript(17360)
  expect(script).not.toContain('MainWindowHandle')
  expect(script).toContain('$window = [Alexia.Front]::WindowOf($target)')
  expect(script.indexOf('WindowOf($target)')).toBeLessThan(script.indexOf('FrameOf($target)'))
  // Visible, no owner (GW_OWNER is 4), and not a tool window (WS_EX_TOOLWINDOW 0x80) unless it
  // asks to be on the taskbar (WS_EX_APPWINDOW 0x40000). The shadow's extended style is 0x800A0.
  expect(script).toContain('if (PidOf(one) != target || !IsWindowVisible(one) || GetWindow(one, 4) != System.IntPtr.Zero) continue;')
  expect(script).toContain('if ((ex & 0x80) != 0 && (ex & 0x40000) == 0) continue;')
  const ex = 0x800a0
  expect((ex & 0x80) !== 0 && (ex & 0x40000) === 0).toBe(true)
})

// ---- what the screen showed, for screen memory (P3-34) ---------------------------------------

/** An ordinary, unlocked Notepad, as the probe prints it. Each test changes what it is about. */
const NOTEPAD = {
  desk: 'Default',
  quns: 5,
  hwnd: 1,
  pid: 42,
  name: 'notepad',
  title: 'notes.txt - Notepad',
  style: 0x14cf0000,
  win: [100, 100, 900, 700],
  mon: [0, 0, 1920, 1080],
}

test('screen state script asks for the desktop, notification state, window, style and both rects', () => {
  const script = screenStateScript()
  for (const call of ['OpenInputDesktop', 'GetUserObjectInformation', 'CloseDesktop', 'SHQueryUserNotificationState', 'GetForegroundWindow', 'GetWindowText', 'GetWindowLong', 'GetWindowRect', 'MonitorFromWindow', 'GetMonitorInfo', '-Compress']) {
    expect(script, call).toContain(call)
  }
  // FOREGROUND declares the calls that change the foreground (focus uses them); the probe after
  // it must call none of them, nor anything that types, clicks or grabs pixels.
  const end = "'@\n"
  const probe = script.slice(script.indexOf(end) + end.length)
  expect(probe).toContain('Alexia -Name Screen2')
  for (const forbidden of ['SwitchDesktop', '[Alexia.Front]::SetForegroundWindow', 'BringWindowToTop', 'SetFocus', 'ShowWindow', 'AttachThreadInput', 'keybd_event', 'SendKeys', 'mouse_event', 'CopyFromScreen']) {
    expect(probe, forbidden).not.toContain(forbidden)
  }
  // Every raw key, in the one line it prints.
  const line = script.split('\n').find((l) => l.includes('ConvertTo-Json @{ desk'))
  for (const key of ['desk', 'quns', 'hwnd', 'pid', 'name', 'title', 'style', 'win', 'mon']) expect(line).toMatch(new RegExp(`\\b${key} = `))
})

test('screen state: an ordinary unlocked window is reported in full', () => {
  expect(windowsState(NOTEPAD)).toEqual({ locked: false, front: { app: 'notepad', title: 'notes.txt - Notepad', fullscreen: false, titleBar: true } })
})

test('screen state: a maximized window keeps its title bar', () => {
  const maximized = { ...NOTEPAD, style: 0x16cf0000, mon: [0, 0, 1920, 1080], quns: 5 }
  // The taskbar's strip left free: the window does not reach the bottom of the monitor.
  expect(windowsState({ ...maximized, win: [-8, -8, 1928, 1048] }).front).toEqual({ app: 'notepad', title: 'notes.txt - Notepad', fullscreen: false, titleBar: true })
  // An auto-hidden taskbar: it covers the monitor, and still has its caption, so it is kept.
  expect(windowsState({ ...maximized, win: [-8, -8, 1928, 1088] }).front).toEqual({ app: 'notepad', title: 'notes.txt - Notepad', fullscreen: true, titleBar: true })
})

test('screen state: a borderless window over the whole monitor has no title bar', () => {
  const state = windowsState({ ...NOTEPAD, style: 0x16000000, win: [0, 0, 1920, 1080], mon: [0, 0, 1920, 1080] })
  expect(state.front).toMatchObject({ fullscreen: true, titleBar: false })
})

test('screen state: a D3D full-screen game is full screen whatever its rect', () => {
  expect(windowsState({ ...NOTEPAD, quns: 3, win: null }).front?.fullscreen).toBe(true)
  // Busy and presentation mode say the same.
  expect(windowsState({ ...NOTEPAD, quns: 2 }).front?.fullscreen).toBe(true)
  expect(windowsState({ ...NOTEPAD, quns: 4, win: null, mon: null }).front?.fullscreen).toBe(true)
})

test('screen state: the lock screen and the secure desktop are locked', () => {
  expect(windowsState({ ...NOTEPAD, desk: 'Winlogon' })).toEqual({ locked: true })
  expect(windowsState({ ...NOTEPAD, desk: '' })).toEqual({ locked: true })
  expect(windowsState({ ...NOTEPAD, desk: 'Default', quns: 1 })).toEqual({ locked: true })
  expect(windowsState({ ...NOTEPAD, hwnd: 0 })).toEqual({ locked: true })
  // Not an object at all: nobody can say it was unlocked.
  for (const raw of [null, undefined, 'Default', 7, [NOTEPAD]]) expect(windowsState(raw)).toEqual({ locked: true })
})

test('screen state: what the probe could not read is left out, not guessed', () => {
  const blind = windowsState({ ...NOTEPAD, win: null, mon: null, quns: -1 })
  expect(blind.locked).toBe(false)
  expect(blind.front).not.toHaveProperty('fullscreen')
  expect(blind.front).toHaveProperty('titleBar', true)
  // One rect without the other is no comparison either.
  expect(windowsState({ ...NOTEPAD, mon: [0, 0, 1920] }).front).not.toHaveProperty('fullscreen')
  expect(windowsState({ ...NOTEPAD, style: 0 }).front).not.toHaveProperty('titleBar')
  expect(windowsState({ ...NOTEPAD, pid: 0 })).toEqual({ locked: false })
  expect(windowsState({ ...NOTEPAD, name: '' })).toEqual({ locked: false })
  // A real empty title from GetWindowText is an answer, and it is kept as one.
  expect(windowsState({ ...NOTEPAD, title: '' }).front).toHaveProperty('title', '')
})

test('screen state: a failed or garbled probe is locked', async () => {
  shell.answer = () => 'not json'
  await expect(screenState()).resolves.toEqual({ locked: true })
  shell.answer = () => JSON.stringify(NOTEPAD)
  shell.end = 'exit'
  await expect(screenState()).resolves.toEqual({ locked: true })
  shell.end = 'error'
  await expect(screenState()).resolves.toEqual({ locked: true })
  // The same fake, finishing normally, does answer: the three above were the failures.
  shell.end = 'ok'
  await expect(screenState()).resolves.toMatchObject({ locked: false, front: { app: 'notepad' } })
  expect(shell.spawned).toHaveLength(4)
  for (const script of shell.spawned) expect(script).toBe(screenStateScript())
})

test('screen state: a window title from the probe is passed through as data', async () => {
  const title = 'it\'s "quoted" $env:USERNAME\nsecond line'
  shell.answer = () => JSON.stringify({ ...NOTEPAD, title })
  const state = await screenState()
  expect(state.front?.title).toBe(title)
})

test('screen state: the probe prints plain ASCII, whatever the code page', async () => {
  // PowerShell 5.1 writes a pipe in the OEM code page; Node reads UTF-8. The script escapes
  // every non-ASCII unit as \uXXXX after ConvertTo-Json and prints only that.
  const script = screenStateScript()
  const lines = script.split('\n')
  const json = lines.findIndex((l) => l.startsWith('$json = ConvertTo-Json'))
  const escape = lines.findIndex((l) => l.startsWith('$ascii = [regex]::Replace($json'))
  expect(json).toBeGreaterThan(0)
  expect(escape).toBeGreaterThan(json)
  expect(lines[escape]).toContain("'[^\\u0000-\\u007F]'")
  expect(lines[escape]).toContain("'\\u{0:x4}'")
  expect(lines.at(-1)).toBe('Write-Output $ascii')
  // What the escaped line looks like on the pipe parses back to the exact title, surrogates too.
  const title = 'Přihlášení — 日本 😀'
  const escaped = JSON.stringify({ ...NOTEPAD, title }).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
  expect([...escaped].every((c) => c.charCodeAt(0) < 0x80)).toBe(true)
  shell.answer = () => escaped
  expect((await screenState()).front?.title).toBe(title)
})

test('screen state: a hung probe is locked at its deadline, and the PowerShell is told to stop', async () => {
  shell.end = 'hang'
  shell.answer = () => JSON.stringify(NOTEPAD)
  const started = Date.now()
  await expect(screenState(undefined, 50)).resolves.toEqual({ locked: true })
  // Answered at the deadline, not after the 10 s default; generous for a loaded machine.
  expect(Date.now() - started).toBeLessThan(5_000)
  expect(shell.signals).toHaveLength(1)
  expect(shell.signals[0]?.aborted).toBe(true)
  // The default deadline is a few seconds: long enough for an Add-Type compile, short enough
  // not to hold up a screenshot for long.
  expect(PROBE_TIMEOUT).toBeGreaterThanOrEqual(3_000)
  expect(PROBE_TIMEOUT).toBeLessThanOrEqual(15_000)
  // A caller's own abort ends it too, before the deadline.
  const caller = new AbortController()
  const pending = screenState(caller.signal, 60_000)
  caller.abort()
  await expect(pending).resolves.toEqual({ locked: true })
  expect(shell.signals[1]?.aborted).toBe(true)
  // An already-aborted signal spawns nothing.
  await expect(screenState(AbortSignal.abort())).resolves.toEqual({ locked: true })
  expect(shell.spawned).toHaveLength(2)
})

// ---- accessibility first (P4-28) -------------------------------------------------------------

test('act scripts call the pattern each how names, in the order given', () => {
  const script = actScript('$found = $null', PRESS)
  const order = ['InvokePattern', 'TogglePattern', 'SelectionItemPattern', 'ExpandCollapsePattern'].map((name) => script.indexOf(`[System.Windows.Automation.${name}]::Pattern`))
  expect(order.every((at) => at > 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  expect(script).toContain('$pattern.Invoke()')
  expect(script).toContain('$pattern.Toggle()')
  expect(script).toContain('$pattern.Select()')
  expect(script).toContain('$pattern.Expand()')
  // Only what was asked for: a press never sets a value.
  expect(script).not.toContain('ValuePattern')
  // Each pattern is tried only while nothing has worked and nothing has failed.
  expect(script.match(/if \(\$null -eq \$via -and \$null -eq \$failed\)/g)).toHaveLength(4)
  // A call that throws is recorded as failed, never wiped back into a miss.
  expect(script).not.toContain('catch { $via = $null }')
  expect(script).toContain("catch { $failed = 'invoke'; $e = $_.Exception")
  expect(script).toContain('failed = $failed; error = $why')
})

test('act sets a value through ValuePattern, quoted, and not into a read-only field', () => {
  const script = actScript('$found = $null', { set_value: "it's $(Remove-Item x)" })
  expect(script).toContain('[System.Windows.Automation.ValuePattern]::Pattern')
  expect(script).toContain(`$pattern.SetValue(${quoted("it's $(Remove-Item x)")})`)
  // Read-only is asked before acting, so it is a miss, not a failed call.
  expect(script).toContain('-and (-not $pattern.Current.IsReadOnly) }')
  expect(script).not.toContain("throw 'read only'")
  expect(script).not.toContain('InvokePattern')
})

test('act refuses a how it does not know rather than reading it as no pattern', () => {
  expect(() => hows('click')).toThrow(/not a way/)
  expect(() => hows('set_value')).toThrow(/not a way/)
  expect(() => hows([])).toThrow(/needs a way/)
  expect(hows(['invoke', { set_value: 'a' }])).toEqual([{ kind: 'invoke' }, { kind: 'set_value', text: 'a' }])
})

test('act result mapping: a pattern ran is done through uia; anything else is not done', () => {
  expect(actResult('{"found":true,"how":"invoke","x":5,"y":6}')).toEqual({ done: true, via: 'uia', how: 'invoke', x: 5, y: 6 })
  expect(actResult('{"found":true,"how":"set_value","x":null,"y":null}')).toEqual({ done: true, via: 'uia', how: 'set_value' })
  expect(actResult('{"found":true,"how":null,"x":5,"y":6}')).toEqual({ done: false, found: true, x: 5, y: 6 })
  expect(actResult('{"found":true,"disabled":true,"x":5,"y":6}')).toEqual({ done: false, found: true, disabled: true, x: 5, y: 6 })
  expect(actResult('{"found":false}')).toEqual({ done: false, found: false })
  expect(actResult('')).toEqual({ done: false, found: false })
  expect(actResult('not json')).toEqual({ done: false, found: false })
  // A how this file does not know is not a success, whatever the script said.
  expect(actResult('{"found":true,"how":"click"}')).toEqual({ done: false, found: true })
  // Tried and threw: failed, with the error, which is not the same answer as *no pattern*.
  expect(actResult('{"found":true,"how":null,"failed":"invoke","error":"Element not enabled","x":5,"y":6}')).toEqual({
    done: false,
    found: true,
    failed: 'invoke',
    error: 'Element not enabled',
    x: 5,
    y: 6,
  })
  expect(actResult('{"found":true,"how":null,"failed":"toggle","error":null}')).toEqual({ done: false, found: true, failed: 'toggle', error: 'it threw' })
})

test('act finds a named control in the window in front, or the control under a point', async () => {
  shell.answer = () => '{"found":true,"how":"toggle","x":1,"y":2}'
  await expect(act({ match: 'Wrap' }, PRESS)).resolves.toEqual({ done: true, via: 'uia', how: 'toggle', x: 1, y: 2 })
  expect(shell.spawned).toHaveLength(1)
  expect(shell.spawned[0]).toContain("$wantedText = 'Wrap'")
  expect(shell.spawned[0]).toContain('GetForegroundWindow')
  shell.answer = () => '{"found":true,"how":null,"x":40,"y":50}'
  await expect(act({ x: 40.2, y: 49.7 }, 'invoke')).resolves.toEqual({ done: false, found: true, x: 40, y: 50 })
  expect(shell.spawned[1]).toContain('$auto::FromPoint((New-Object System.Windows.Point(40, 50)))')
  // Nothing is typed and no pointer moves on the accessible road.
  for (const script of shell.spawned) {
    expect(script).not.toContain('mouse_event')
    expect(script).not.toContain('Cursor]::Position')
  }
  // A bad how never reaches PowerShell.
  await expect(act({ match: 'Wrap' }, 'wiggle')).rejects.toThrow(/not a way/)
  expect(shell.spawned).toHaveLength(2)
})

test('the fallback click keeps the pointer and puts it back, even if the press throws', async () => {
  const back = clickScript(10, 20, 'left', false, undefined, { back: true })
  expect(back).toContain('GetCursorPos(out POINT p)')
  expect(back).toContain('SetCursorPos(int x, int y)')
  const kept = back.indexOf('[Alexia.Pointer]::GetCursorPos([ref]$was)')
  const pressed = back.indexOf('[Alexia.Mouse]::mouse_event(2,')
  const returned = back.indexOf('[Alexia.Pointer]::SetCursorPos($was.X, $was.Y)')
  expect(kept).toBeGreaterThan(0)
  expect(pressed).toBeGreaterThan(kept)
  expect(returned).toBeGreaterThan(pressed)
  expect(back.slice(pressed, returned)).toContain('} finally {')
  // A plain click is as it was: it does not take the pointer back.
  expect(clickScript(10, 20)).not.toContain('SetCursorPos')
  await clickBack(10, 20)
  expect(shell.spawned.at(-1)).toBe(back)
})

test('the fallback click is guarded like any click when it names its window', async () => {
  shell.answer = inFront(1, undefined)
  await expect(clickBack(10, 20, 'left', false, undefined, 4242)).rejects.toThrow(wrongWindow('click'))
  // The guard comes first: refused, the pointer was never taken.
  const script = shell.spawned.at(-1)
  expect(beforeGuardEnds(script)).not.toContain('GetCursorPos')
  expect(afterGuard(script)).toContain('GetCursorPos')
})

// ---- the same scripts, run by the real PowerShell (Windows only) ------------------------------

/**
 * Everything above fakes PowerShell. These run the real one, on scripts that touch no window and
 * press nothing: `$found` is a stand-in object whose patterns only record what was called on them,
 * and the typing script is only parsed, never run. They are what shows a throwing pattern call is
 * reported rather than retried, and that a curly quote cannot end a literal and start a command.
 * The injections that are run only try to set a variable, which is then checked for.
 */
const onWindows = process.platform === 'win32'
const SLOW = 180_000

async function powershell(script) {
  const { execFileSync } = await vi.importActual('node:child_process')
  const exe = process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe'
  return execFileSync(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    timeout: 90_000,
    windowsHide: true,
  }).trim()
}

/** A script travels as base64 so the test's own quoting cannot change what is examined. */
const b64 = (text) => Buffer.from(String(text), 'utf8').toString('base64')
const decoded = (script) => `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64(script)}'))`

/** What PowerShell's own parser makes of a script: its errors and every command it would run. */
async function parsed(script) {
  const out = await powershell(
    [
      `$source = ${decoded(script)}`,
      '$tokens = $null; $errors = $null',
      '$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)',
      '$names = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { [string]$_.GetCommandName() })',
      'ConvertTo-Json @{ errors = @($errors).Count; commands = $names } -Compress',
    ].join('\n'),
  )
  return JSON.parse(out)
}

/**
 * A stand-in control. `patterns` names the ones it has: `ok` acts, `throws` throws when called,
 * `askThrows` throws when merely asked for, `readonly` is a read-only ValuePattern. Every call
 * made on a pattern is appended to `$global:calls`, and a value set lands in `$global:setTo`.
 */
const VERB = { InvokePattern: 'Invoke', TogglePattern: 'Toggle', SelectionItemPattern: 'Select', ExpandCollapsePattern: 'Expand', ValuePattern: 'SetValue' }
const standIn = (patterns) =>
  [
    '$global:calls = @()',
    '$global:setTo = $null',
    '$found = New-Object psobject',
    '$found | Add-Member NoteProperty Current ([pscustomobject]@{ IsEnabled = $true; BoundingRectangle = (New-Object System.Windows.Rect(10, 20, 30, 40)) })',
    '$found | Add-Member ScriptMethod TryGetClickablePoint { param($point) $false }',
    '$made = @{}',
    ...Object.entries(patterns).map(([name, how]) => {
      const pattern = `[System.Windows.Automation.${name}]::Pattern`
      if (how === 'askThrows') return `$made[${pattern}.Id] = 'ASK'`
      const verb = VERB[name]
      const body =
        how === 'throws' ? `$global:calls += '${verb}'; throw 'the app said no'`
        : name === 'ValuePattern' ? `param($v) $global:calls += '${verb}'; $global:setTo = $v`
        : `$global:calls += '${verb}'`
      return [
        '$one = New-Object psobject',
        `$one | Add-Member ScriptMethod ${verb} { ${body} }`,
        `$one | Add-Member NoteProperty Current ([pscustomobject]@{ IsReadOnly = $${how === 'readonly' ? 'true' : 'false'} })`,
        `$made[${pattern}.Id] = $one`,
      ].join('\n')
    }),
    '$found | Add-Member NoteProperty Made $made',
    '$found | Add-Member ScriptMethod TryGetCurrentPattern { param($kind, $into) $one = $this.Made[$kind.Id]; if ($one -eq "ASK") { throw "cannot ask" }; if ($null -eq $one) { return $false }; $into.Value = $one; return $true }',
  ].join('\n')

/** `actScript` run on a stand-in: what `act` would answer, and which pattern calls were made. */
async function actOn(patterns, how) {
  const out = await powershell(
    [
      actScript(standIn(patterns), how),
      "Write-Output ('CALLS=' + ($global:calls -join ','))",
      "if ($null -ne $global:setTo) { Write-Output ('SET=' + [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$global:setTo))) }",
      "if ($null -ne (Get-Variable -Name pwned -Scope Global -ErrorAction SilentlyContinue)) { Write-Output 'PWNED' }",
    ].join('\n'),
  )
  const lines = out.split(/\r?\n/)
  const calls = (lines.find((line) => line.startsWith('CALLS=')) ?? 'CALLS=').slice(6)
  const set = lines.find((line) => line.startsWith('SET='))
  return {
    answer: actResult(lines[0]),
    calls: calls === '' ? [] : calls.split(','),
    pwned: lines.includes('PWNED'),
    ...(set && { set: Buffer.from(set.slice(4), 'base64').toString('utf8') }),
  }
}

test.runIf(onWindows)('real PowerShell: a pattern call that throws is failed, and nothing after it is tried', async () => {
  const { answer, calls } = await actOn({ InvokePattern: 'throws', TogglePattern: 'ok' }, PRESS)
  expect(answer).toEqual({ done: false, found: true, failed: 'invoke', error: 'the app said no', x: 25, y: 40 })
  // Toggle fits too, but after a press that may have happened, nothing else is pressed.
  expect(calls).toEqual(['Invoke'])
}, SLOW)

test.runIf(onWindows)('real PowerShell: no pattern, or one that cannot even be asked for, is a plain miss', async () => {
  const none = await actOn({}, PRESS)
  expect(none.answer).toEqual({ done: false, found: true, x: 25, y: 40 })
  expect(none.calls).toEqual([])
  // Asking threw: nothing was attempted, so the next pattern is tried and acts.
  const asked = await actOn({ InvokePattern: 'askThrows', TogglePattern: 'ok' }, PRESS)
  expect(asked.answer).toEqual({ done: true, via: 'uia', how: 'toggle', x: 25, y: 40 })
  expect(asked.calls).toEqual(['Toggle'])
  // A read-only field is asked about before acting: a miss, and SetValue is never called.
  const readOnly = await actOn({ ValuePattern: 'readonly' }, { set_value: 'x' })
  expect(readOnly.answer).toEqual({ done: false, found: true, x: 25, y: 40 })
  expect(readOnly.calls).toEqual([])
}, SLOW)

test.runIf(onWindows)('real PowerShell: a value with curly quotes is set exactly, and an injection stays text', async () => {
  const tricks = [
    'don\u2019t stop',
    '\u2018left\u2019 \u201Alow\u201B and \'plain\'',
    'x\u2019; Set-Variable -Name pwned -Value 1 -Scope Global; \u2019',
    '\u201A; Set-Variable -Name pwned -Value 1 -Scope Global; \u201B',
    '\u2019) ; Set-Variable -Name pwned -Value 1 -Scope Global ; (\u2018',
  ]
  for (const text of tricks) {
    const { answer, calls, set, pwned } = await actOn({ ValuePattern: 'ok' }, { set_value: text })
    expect(answer).toEqual({ done: true, via: 'uia', how: 'set_value', x: 25, y: 40 })
    expect(calls).toEqual(['SetValue'])
    expect(set).toBe(text)
    expect(pwned).toBe(false)
  }
}, SLOW)

test.runIf(onWindows)('real PowerShell: typed text with a curly quote parses to no command but its own', async () => {
  // Only parsed, never run: this is the shape an attack would take.
  const text = 'it\u2019s; Remove-Item -LiteralPath C:\\alexia-test-never-there; \u2018'
  await type(text)
  const script = shell.spawned.at(-1)
  const { errors, commands } = await parsed(script)
  expect(errors).toBe(0)
  expect(commands).toEqual(['Add-Type'])
  // The same text with only the ASCII quote escaped (the old rule) would have been a command,
  // so this test can tell the two apart.
  const braced = text.replace(/([+^%~(){}[\]])/g, '{$1}')
  const unsafe = script.replace(quoted(braced), `'${braced.replace(/'/g, "''")}'`)
  expect(unsafe).not.toBe(script)
  expect((await parsed(unsafe)).commands).toContain('Remove-Item')
}, SLOW)
