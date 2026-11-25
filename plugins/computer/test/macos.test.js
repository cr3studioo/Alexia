// SPDX-License-Identifier: AGPL-3.0-only
import { EventEmitter } from 'node:events'
import { beforeEach, expect, test, vi } from 'vitest'
import { KEY_HELP, macState, parseKeys, screenState, screenStateScript } from '../macos.js'

/**
 * osascript, faked, the way `windows.test.js` fakes PowerShell: every script lands in `spawned`
 * and the fake prints whatever `answer` returns. `ALEXIA_COMPUTER_SPAWN=1` sends each call
 * through a process of its own rather than the long-lived worker, so one fake spawn is one call.
 * Nothing reaches a real shell.
 */
const osa = vi.hoisted(() => ({ spawned: [], answer: () => '' }))
vi.mock('node:child_process', () => ({
  spawn: (_exe, args) => {
    osa.spawned.push(args[3])
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    void Promise.resolve().then(() => {
      child.stdout.emit('data', osa.answer(args[3]))
      child.emit('close', 0)
    })
    return child
  },
}))

beforeEach(() => {
  process.env.ALEXIA_COMPUTER_SPAWN = '1'
  osa.spawned.length = 0
  osa.answer = () => ''
})

/** An unlocked Mac with Safari in front and accessibility granted, as the probe prints it. */
const SAFARI = { locked: false, name: 'Safari', trusted: true, title: 'Apple', full: false }

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

// ---- what the screen showed, for screen memory (P3-34) ---------------------------------------

test('mac screen state: a named window, unlocked, not full screen', () => {
  expect(macState(SAFARI)).toEqual({ locked: false, front: { app: 'Safari', title: 'Apple', fullscreen: false, titleBar: true } })
})

test('mac screen state: native full screen has no title bar', () => {
  expect(macState({ ...SAFARI, full: true }).front).toEqual({ app: 'Safari', title: 'Apple', fullscreen: true, titleBar: false })
})

test('mac screen state: without accessibility the window is unknown', () => {
  const state = macState({ ...SAFARI, trusted: false, title: null, full: null })
  expect(state).toEqual({ locked: false, front: { app: 'Safari' } })
  expect(Object.keys(state.front)).toEqual(['app'])
})

test('mac screen state: an empty title is unknown, not a title', () => {
  expect(macState({ ...SAFARI, title: '' }).front).not.toHaveProperty('title')
  expect(macState({ ...SAFARI, name: '' })).toEqual({ locked: false })
  expect(macState({ ...SAFARI, name: null })).toEqual({ locked: false })
})

test('mac screen state: an unknown lock state is locked', async () => {
  expect(macState({ ...SAFARI, locked: null })).toEqual({ locked: true })
  expect(macState({ ...SAFARI, locked: true })).toEqual({ locked: true })
  expect(macState({ ...SAFARI, locked: undefined })).toEqual({ locked: true })
  expect(macState(null)).toEqual({ locked: true })
  // Through the real path: garbled output from osascript, then a good answer for contrast.
  osa.answer = () => 'not json'
  await expect(screenState()).resolves.toEqual({ locked: true })
  osa.answer = () => JSON.stringify(SAFARI)
  await expect(screenState()).resolves.toEqual({ locked: false, front: { app: 'Safari', title: 'Apple', fullscreen: false, titleBar: true } })
  expect(osa.spawned).toHaveLength(2)
  for (const script of osa.spawned) expect(script).toContain(screenStateScript())
})

test('mac screen state script asks for the session lock and the focused window', () => {
  const script = screenStateScript()
  for (const name of ['CGSessionCopyCurrentDictionary', 'CGSSessionScreenIsLocked', 'AXFocusedWindow', 'AXFullScreen', 'AXTitle']) expect(script, name).toContain(name)
  // It only looks: nothing in it sets an attribute, posts an event or activates an app.
  for (const forbidden of ['AXUIElementSetAttributeValue', 'CGEventPost', 'activateWithOptions']) expect(script).not.toContain(forbidden)
})
