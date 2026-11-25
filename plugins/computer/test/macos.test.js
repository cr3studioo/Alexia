// SPDX-License-Identifier: AGPL-3.0-only
import { EventEmitter } from 'node:events'
import { beforeEach, expect, test, vi } from 'vitest'
import { ACT, act, actArgs, actResult, clickBack, hows, KEY_HELP, lockedFrom, macState, MOUSE, parseKeys, PRESS, PROBE_TIMEOUT, screenState, screenStateScript } from '../macos.js'

/**
 * osascript, faked, the way `windows.test.js` fakes PowerShell: every script lands in `spawned`
 * and the fake prints whatever `answer` returns. `ALEXIA_COMPUTER_SPAWN=1` sends each call
 * through a process of its own rather than the long-lived worker, so one fake spawn is one call.
 * Nothing reaches a real shell.
 */
const osa = vi.hoisted(() => ({ spawned: [], args: [], signals: [], answer: () => '', hang: false }))
vi.mock('node:child_process', () => ({
  spawn: (_exe, args, options) => {
    osa.spawned.push(args[3])
    osa.args.push(args.slice(4))
    osa.signals.push(options?.signal)
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    void Promise.resolve().then(() => {
      // A hung osascript: prints nothing, never exits, and ignores its signal.
      if (osa.hang) return
      child.stdout.emit('data', osa.answer(args[3]))
      child.emit('close', 0)
    })
    return child
  },
}))

beforeEach(() => {
  process.env.ALEXIA_COMPUTER_SPAWN = '1'
  osa.spawned.length = 0
  osa.args.length = 0
  osa.signals.length = 0
  osa.answer = () => ''
  osa.hang = false
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

test('mac screen state: a lock flag missing from something that is not the session dictionary is unknown', () => {
  // The real dictionary, unlocked: it names the session's user and leaves the flag out.
  expect(lockedFrom({ kCGSSessionUserIDKey: 501, kCGSSessionOnConsoleKey: 1 })).toBe(false)
  expect(lockedFrom({ kCGSSessionOnConsoleKey: true })).toBe(false)
  expect(lockedFrom({ kCGSSessionUserIDKey: 501, CGSSessionScreenIsLocked: 0 })).toBe(false)
  // Locked says so, whatever else is there.
  expect(lockedFrom({ kCGSSessionUserIDKey: 501, CGSSessionScreenIsLocked: 1 })).toBe(true)
  expect(lockedFrom({ CGSSessionScreenIsLocked: true })).toBe(true)
  // What the fallback unwrap can give when castRefToObject threw: an empty object, a wrapper
  // with other keys, or nothing. No flag there is not "unlocked".
  for (const dict of [{}, { isNil: 0 }, { CGSSessionScreenIsLocked: undefined }, null, undefined, 'dict', 1, []]) {
    expect(lockedFrom(dict), JSON.stringify(dict)).toBe(null)
  }
  // A flag that is neither yes nor no is unknown too.
  expect(lockedFrom({ kCGSSessionUserIDKey: 501, CGSSessionScreenIsLocked: 'maybe' })).toBe(null)
  // And macState reads unknown as locked.
  expect(macState({ ...SAFARI, locked: lockedFrom({}) })).toEqual({ locked: true })
  // The probe runs this very rule: its source is pasted into the script and called on the
  // unwrapped dictionary, and the pasted copy answers the same.
  const script = screenStateScript()
  expect(script).toContain(lockedFrom.toString())
  expect(script).toContain('locked = lockedFrom(dict);')
  const pasted = new Function(`${lockedFrom.toString()}\nreturn lockedFrom`)()
  expect(pasted({})).toBe(null)
  expect(pasted({ kCGSSessionUserIDKey: 501 })).toBe(false)
  expect(pasted({ kCGSSessionUserIDKey: 501, CGSSessionScreenIsLocked: 1 })).toBe(true)
})

test('mac screen state: a hung probe is locked at its deadline, and osascript is told to stop', async () => {
  osa.hang = true
  osa.answer = () => JSON.stringify(SAFARI)
  const started = Date.now()
  await expect(screenState(undefined, 50)).resolves.toEqual({ locked: true })
  // Answered at the deadline, not after the 10 s default; generous for a loaded machine.
  expect(Date.now() - started).toBeLessThan(5_000)
  expect(osa.signals).toHaveLength(1)
  expect(osa.signals[0]?.aborted).toBe(true)
  expect(PROBE_TIMEOUT).toBeGreaterThanOrEqual(3_000)
  expect(PROBE_TIMEOUT).toBeLessThanOrEqual(15_000)
  // The caller's own abort ends it too.
  const caller = new AbortController()
  const pending = screenState(caller.signal, 60_000)
  caller.abort()
  await expect(pending).resolves.toEqual({ locked: true })
  expect(osa.signals[1]?.aborted).toBe(true)
})

// ---- accessibility first (P4-28) -------------------------------------------------------------

test('the act script spells each how as its AX action or attribute', () => {
  expect(ACT).toContain("perform(element, actions, 'AXPress') || perform(element, actions, 'AXConfirm')")
  expect(ACT).toContain("toggle: () => perform(element, actions, 'AXPress')")
  expect(ACT).toContain("perform(element, actions, 'AXPick') || assign(element, 'AXSelected', $(true))")
  expect(ACT).toContain("perform(element, actions, 'AXShowMenu') || assign(element, 'AXExpanded', $(true))")
  expect(ACT).toContain("set_value: (text) => assign(element, 'AXValue', $(text))")
  // A value is set only where the attribute says it can be.
  expect(ACT).toContain('AXUIElementIsAttributeSettable')
  expect(ACT).toContain('AXUIElementSetAttributeValue')
  expect(ACT).toContain('AXUIElementCopyElementAtPosition')
  // No pointer and no keystroke on this road.
  expect(ACT).not.toContain('CGEventPost')
})

test('act hands the hows and the control to the script as data, never as code', () => {
  const sneaky = "'); $.NSTask.launch('rm"
  expect(actArgs({ pid: 12.4, match: ` ${sneaky} ` }, [{ set_value: sneaky }, 'invoke'])).toEqual([
    12,
    '',
    sneaky,
    '',
    '',
    JSON.stringify([{ kind: 'set_value', text: sneaky }, { kind: 'invoke' }]),
  ])
  expect(actArgs({ x: 10.6, y: 20.2 }, 'invoke')).toEqual([0, '', '', 11, 20, '[{"kind":"invoke"}]'])
  expect(ACT).not.toContain(sneaky)
  expect(() => hows('wiggle')).toThrow(/not a way/)
  expect(PRESS).toEqual(['invoke', 'toggle', 'select', 'expand'])
})

test('act result mapping: an AX action ran is done through ax; anything else is not done', () => {
  expect(actResult({ found: true, how: 'invoke', x: 1, y: 2 })).toEqual({ done: true, via: 'ax', how: 'invoke', x: 1, y: 2 })
  expect(actResult({ found: true, how: 'set_value', x: null, y: null })).toEqual({ done: true, via: 'ax', how: 'set_value' })
  expect(actResult({ found: true, how: null, x: 1, y: 2 })).toEqual({ done: false, found: true, x: 1, y: 2 })
  expect(actResult({ found: true, disabled: true, x: 1, y: 2 })).toEqual({ done: false, found: true, disabled: true, x: 1, y: 2 })
  expect(actResult({ found: false })).toEqual({ done: false, found: false })
  expect(actResult(null)).toEqual({ done: false, found: false })
})

test('act runs the AX script after a browser page has had its say, and maps its answer', async () => {
  osa.answer = (script) => (script.includes('AXUIElementCopyElementAtPosition') ? '{"found":true,"how":"select","x":3,"y":4}' : '')
  await expect(act({ match: 'Row 2' }, PRESS)).resolves.toEqual({ done: true, via: 'ax', how: 'select', x: 3, y: 4 })
  // The page first (it found nothing), then the tree.
  expect(osa.spawned).toHaveLength(2)
  expect(osa.spawned[1]).toContain(ACT)
  expect(osa.args[1]).toEqual(['0', '', 'Row 2', '', '', JSON.stringify(hows(PRESS))])
  // A value is never set through the page, so only the tree is asked.
  osa.answer = () => '{"found":true,"how":null,"x":3,"y":4}'
  await expect(act({ match: 'Name' }, { set_value: 'Ada' })).resolves.toEqual({ done: false, found: true, x: 3, y: 4 })
  expect(osa.spawned).toHaveLength(3)
})

test('a page that presses the control is done through the page', async () => {
  osa.answer = (script) => (script.includes('AXUIElementCopyElementAtPosition') ? '{"found":false}' : JSON.stringify({ out: JSON.stringify({ found: true, how: 'invoke', x: 9, y: 9 }) }))
  await expect(act({ match: 'Subscribe' }, PRESS)).resolves.toEqual({ done: true, via: 'page', how: 'invoke', x: 9, y: 9 })
  expect(osa.spawned).toHaveLength(1)
})

test('the fallback click keeps the pointer and moves it back after, even if the press throws', async () => {
  expect(MOUSE).toContain("argv[4] === 'back'")
  expect(MOUSE).toContain('$.NSEvent.mouseLocation')
  const pressed = MOUSE.indexOf('post(down, which, n)')
  const returned = MOUSE.indexOf('post($.kCGEventMouseMoved, $.kCGMouseButtonLeft, 0, back)')
  expect(pressed).toBeGreaterThan(0)
  expect(returned).toBeGreaterThan(pressed)
  expect(MOUSE.slice(pressed, returned)).toContain('} finally {')
  expect(MOUSE).toContain('$.CGEventCreateMouseEvent(null, type, where || at, which)')
  osa.answer = () => '{"ok":true}'
  await clickBack(10.4, 20.6)
  expect(osa.spawned[0]).toContain(MOUSE)
  expect(osa.args[0]).toEqual(['10', '21', 'left', '1', 'back'])
})
