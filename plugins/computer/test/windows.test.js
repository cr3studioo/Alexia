// SPDX-License-Identifier: AGPL-3.0-only
import { EventEmitter } from 'node:events'
import { beforeEach, expect, test, vi } from 'vitest'
import { click, focus, focusScript, key, NOT_FRONT, quoted, type, unknownKey, windowsKeyIn, wrongWindow } from '../windows.js'

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
 * The fake's stand-in for Windows' own answer to *who is in front*. A guarded script asks
 * first and stops when it is not `front`; a focus script reports `front` at its end.
 */
const inFront = (front) => (script) => {
  const wanted = /if \(\$front -ne (\d+)\)/.exec(script)?.[1]
  if (wanted !== undefined && Number(wanted) !== front) return JSON.stringify({ refused: true, front })
  if (script.includes('$target =')) return JSON.stringify({ front })
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
  const unlock = at('if ([Alexia.Front]::FrontPid() -ne $target) {')
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
  expect(script.trim().split('\n').at(-1)).toBe('ConvertTo-Json @{ front = [int][Alexia.Front]::FrontPid() } -Compress')
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
  expect(beforeGuardEnds(script)).toMatch(/if \(\$front -ne 4242\)/)
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
    expect(beforeGuardEnds(script)).toMatch(/if \(\$front -ne 4242\)/)
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
  expect(beforeGuardEnds(script)).toMatch(/if \(\$front -ne 4242\)/)
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
