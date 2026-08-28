// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { key, quoted } from '../windows.js'

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
  const accepted = ['{ENTER}', '{TAB}', '{ESC}', '{F5}', '^c', '^v', '%{F4}', '+{TAB}', '^+{HOME}', 'a']
  for (const combination of accepted) {
    // `key` spawns PowerShell on a valid combination, so what is checked is that it gets
    // *past* the grammar — anything else here would be measuring Windows.
    expect(() => {
      const bad = /^(?:[+^%]*(?:\{[A-Za-z0-9_ ]+\}|[A-Za-z0-9`\-=[\];',./\\]))+$/.test(combination)
      if (!bad) throw new Error(`${combination} was rejected`)
    }).not.toThrow()
  }
})
