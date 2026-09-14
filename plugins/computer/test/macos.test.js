// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { KEY_HELP, parseKeys } from '../macos.js'

// The Mac key grammar (D148). Like SendKeys on Windows, it is the one argument a model writes
// that is notation rather than data, so it is checked before anything is posted — and the
// refusal carries the grammar, so the next attempt is a corrected one.

test('the combinations the tool description promises actually parse', () => {
  // A grammar that refuses what its own description teaches is worse than none.
  for (const combo of ['enter', 'tab', 'escape', 'f5', 'up', 'cmd+c', 'cmd+v', 'cmd+tab', 'cmd+space', 'cmd+shift+4']) {
    expect(KEY_HELP).toContain(combo)
    expect(parseKeys(combo).error, combo).toBeUndefined()
  }
})

test('named keys become key codes and characters stay characters', () => {
  expect(parseKeys('enter')).toEqual({ code: 36, flags: 0 })
  expect(parseKeys('{ESCAPE}')).toEqual({ code: 53, flags: 0 })
  // A letter is not resolved to a key code here: which key types `z` depends on the keyboard
  // layout, and only the Mac running it can say — on a Czech one it is the key a US one calls Y.
  expect(parseKeys('cmd+z')).toEqual({ char: 'z', flags: 0x100000 })
  expect(parseKeys('Cmd+Shift+T')).toEqual({ char: 't', flags: 0x100000 | 0x20000 })
  expect(parseKeys('option+left')).toEqual({ code: 123, flags: 0x80000 })
  expect(parseKeys('cmd++')).toEqual({ char: '+', flags: 0x100000 })
})

test('anything outside the grammar is refused with the grammar in the refusal', () => {
  expect(parseKeys('').error).toMatch(/nothing in it/)
  expect(parseKeys('cmd+banana').error).toMatch(/"banana" is not a key this knows/)
  expect(parseKeys('hyper+c').error).toMatch(/"hyper" is not a modifier/)
  expect(parseKeys('cmd+').error).toMatch(/ends without a key/)
  // Windows notation, named as such, because a model that learned it will try it here.
  for (const windows of ['^c', '%{F4}', '{WIN}r']) expect(parseKeys(windows).error).toMatch(/Windows notation/)
  // A sentence is not a key: that is what the type tool is for, and it logs no characters.
  expect(parseKeys('hello world').error).toMatch(/cmd\+c for copy/)
})
