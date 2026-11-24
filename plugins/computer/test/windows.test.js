// SPDX-License-Identifier: AGPL-3.0-only
import { EventEmitter } from 'node:events'
import { beforeEach, expect, test, vi } from 'vitest'
import { click, focus, focusScript, front, frontScript, key, MOUSE, NOT_FRONT, quoted, scroll, type, unknownKey, windowsKeyIn, wrongWindow } from '../windows.js'

/**
 * PowerShell, faked. Every script `run` would hand to powershell.exe lands in `spawned`, and
 * the fake answers with whatever `answer` returns for it, the way the real one prints JSON.
 * Nothing reaches a real shell, so nothing here can type into, click on or focus a window.
 */
const shell = vi.hoisted(() => ({ spawned: [], answer: () => '' }))
vi.mock('node:child_process', () => ({
  spawn: (_exe, args) => {
    const script = args.at(-1)
    shell.spawned.push(script)
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    void Promise.resolve().then(() => {
      child.stdout.emit('data', shell.answer(script))
      child.emit('close', 0)
    })
    return child
  },
}))

beforeEach(() => {
  shell.spawned.length = 0
  shell.answer = () => ''
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
