// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { sameMoment } from '../moment.js'

// One screenshot's state from the probe before it and the probe after it (P3-34). The window
// is named only when both probes name the same one; anything less is unknown or locked.

const NOTEPAD = { app: 'notepad', title: 'notes.txt - Notepad', fullscreen: false, titleBar: true }
const open = (front) => ({ locked: false, front })

test('the same window before and after keeps its front', () => {
  expect(sameMoment(open(NOTEPAD), open({ ...NOTEPAD }))).toEqual({ locked: false, front: NOTEPAD })
})

test('a window that changed during the capture loses its front', () => {
  for (const changed of [{ app: 'chrome' }, { title: 'other.txt - Notepad' }, { fullscreen: true }, { titleBar: false }]) {
    expect(sameMoment(open(NOTEPAD), open({ ...NOTEPAD, ...changed })), JSON.stringify(changed)).toEqual({ locked: false })
  }
  // No front on one side is no match either.
  expect(sameMoment(open(NOTEPAD), { locked: false })).toEqual({ locked: false })
  expect(sameMoment({ locked: false }, { locked: false })).toEqual({ locked: false })
})

test('locked before or after is locked, with no front', () => {
  expect(sameMoment({ locked: true }, open(NOTEPAD))).toEqual({ locked: true })
  expect(sameMoment(open(NOTEPAD), { locked: true })).toEqual({ locked: true })
  // Even a probe that names a window is locked when it says it is.
  expect(sameMoment({ locked: true, front: NOTEPAD }, open(NOTEPAD))).toEqual({ locked: true })
})

test('a missing probe is locked', () => {
  const x = open(NOTEPAD)
  expect(sameMoment(undefined, x)).toEqual({ locked: true })
  expect(sameMoment(x, undefined)).toEqual({ locked: true })
  expect(sameMoment(null, null)).toEqual({ locked: true })
})

test('a key missing on both sides still matches; missing on one side does not', () => {
  expect(sameMoment(open({ app: 'a' }), open({ app: 'a' }))).toEqual({ locked: false, front: { app: 'a' } })
  expect(sameMoment(open({ app: 'a', title: 't' }), open({ app: 'a' }))).toEqual({ locked: false })
  expect(sameMoment(open({ app: 'a' }), open({ app: 'a', fullscreen: false }))).toEqual({ locked: false })
  // And a kept front carries no key the probes did not have.
  expect(Object.keys(sameMoment(open({ app: 'a' }), open({ app: 'a' })).front)).toEqual(['app'])
})

/**
 * Screen memory's reading of a screenshot result, **copied** from P3-19's `frontOf`
 * (`plugins/screen-memory/capture.js`) and the window half of `decide` (`filter.js`), as the
 * spec lists them. Copied rather than imported so this plugin's tests do not reach into another
 * plugin; if screen memory's rules change, this copy is the contract to re-read.
 */
const LOCK_SCREENS = ['lockapp', 'logonui', 'loginwindow', 'screensaverengine', 'credentialuibroker', 'consent']
function frontOf(result) {
  const s = result?.structuredContent
  const w = s?.front ?? s?.window
  if (!w || typeof w !== 'object') return { front: undefined, locked: s?.locked === true }
  const bool = (...values) => values.find((v) => typeof v === 'boolean')
  return {
    front: {
      app: [w.app, w.process, w.name].find((v) => typeof v === 'string'),
      title: typeof w.title === 'string' ? w.title : undefined,
      fullscreen: bool(w.fullscreen, w.full_screen),
      titleBar: bool(w.titleBar, w.title_bar),
    },
    locked: s.locked === true || w.locked === true,
  }
}
function windowVerdict({ front, locked }) {
  if (locked === true) return 'locked'
  if (!front || typeof front !== 'object') return 'unknown_window'
  const app = typeof front.app === 'string' ? front.app.trim() : ''
  if (app === '' || typeof front.title !== 'string') return 'unknown_window'
  if (LOCK_SCREENS.includes(app.toLowerCase().replace(/\.(exe|app)$/, ''))) return 'locked'
  if (typeof front.fullscreen !== 'boolean') return 'unknown_window'
  if (front.fullscreen && front.titleBar !== true) return 'full_screen'
  return 'kept'
}
const read = (before, after) => windowVerdict(frontOf({ structuredContent: { path: 'x.png', width: 1, height: 1, ...sameMoment(before, after) } }))

test('screen memory reads the result as intended', () => {
  // An ordinary window, the same before and after: not dropped for anything about the window.
  expect(read(open(NOTEPAD), open(NOTEPAD))).toBe('kept')
  // A maximized window over the whole monitor with its caption is kept too.
  const maximized = { ...NOTEPAD, fullscreen: true, titleBar: true }
  expect(read(open(maximized), open(maximized))).toBe('kept')
  // Locked on either side: dropped as locked.
  expect(read({ locked: true }, open(NOTEPAD))).toBe('locked')
  expect(read(open(NOTEPAD), { locked: true })).toBe('locked')
  // The lock app itself in front, unlocked by every flag, is still the lock screen.
  const lockApp = { app: 'LockApp', title: '', fullscreen: true, titleBar: false }
  expect(read(open(lockApp), open(lockApp))).toBe('locked')
  // A window that changed during the capture: unknown.
  expect(read(open(NOTEPAD), open({ ...NOTEPAD, app: 'KeePassXC', title: 'Passwords' }))).toBe('unknown_window')
  // A mac window without accessibility (no title, no full-screen state): unknown.
  expect(read(open({ app: 'Safari' }), open({ app: 'Safari' }))).toBe('unknown_window')
  // A borderless window over the monitor: full screen.
  const game = { app: 'game', title: 'Game', fullscreen: true, titleBar: false }
  expect(read(open(game), open(game))).toBe('full_screen')
})
