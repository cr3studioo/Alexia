// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { key, quoted, unknownKey, windowsKeyIn } from '../windows.js'

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
