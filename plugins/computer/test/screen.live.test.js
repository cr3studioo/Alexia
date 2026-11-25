// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { run, screenState, screenStateScript, windowsState } from '../windows.js'

/**
 * The screen-state probe on this PC, for real (P3-34): no mocks, real PowerShell, read-only.
 * It reads which desktop has input, the notification state and the window in front; it
 * focuses nothing, types nothing and clicks nothing.
 *
 * What it proves that the faked tests cannot: that Windows' script scanner lets the probe
 * through (a blocked probe would make screen memory drop every moment), and that the P/Invoke
 * compiles and answers with the raw shape `windowsState` expects.
 *
 * A test runner is an unlocked, interactive session. Run as a service with no desktop,
 * `locked: true` is the right answer and this file should be skipped there, not changed.
 */

/** An Add-Type compile and a spawn on a slow, loaded machine: generous. */
const SLOW = 60_000

const rect = (value) => value === null || (Array.isArray(value) && value.length === 4 && value.every((n) => Number.isInteger(n)))

test.runIf(process.platform === 'win32')(
  'on this PC the probe answers with every raw key',
  async () => {
    const out = await run(screenStateScript())
    const raw = JSON.parse(out)
    expect(typeof raw.desk).toBe('string')
    expect(Number.isInteger(raw.quns)).toBe(true)
    expect([0, 1]).toContain(raw.hwnd)
    expect(Number.isInteger(raw.pid)).toBe(true)
    expect(typeof raw.name).toBe('string')
    expect(typeof raw.title).toBe('string')
    expect(Number.isInteger(raw.style)).toBe(true)
    expect(rect(raw.win), JSON.stringify(raw.win)).toBe(true)
    expect(rect(raw.mon), JSON.stringify(raw.mon)).toBe(true)
    expect(Object.keys(raw).sort()).toEqual(['desk', 'hwnd', 'mon', 'name', 'pid', 'quns', 'style', 'title', 'win'])
  },
  SLOW,
)

test.runIf(process.platform === 'win32')(
  'on this unlocked PC the window in front is reported',
  async () => {
    // GetForegroundWindow is zero for an instant while windows switch, which is a correct
    // `locked: true` for that one moment; a few tries ride over it, never past a real lock.
    let state = await screenState()
    for (let tries = 1; tries < 3 && state.locked; tries += 1) state = await screenState()
    expect(state.locked).toBe(false)
    expect(typeof state.front?.app).toBe('string')
    expect(state.front?.app).not.toBe('')
    expect(typeof state.front?.title).toBe('string')
    expect(typeof state.front?.fullscreen).toBe('boolean')
    expect(typeof state.front?.titleBar).toBe('boolean')
  },
  SLOW,
)

test.runIf(process.platform === 'win32')(
  'on this PC a Czech and CJK window title survives the trip from PowerShell exactly',
  async () => {
    // Windows PowerShell 5.1 writes a pipe in the OEM code page: before the fix "Přihlášení"
    // arrived as "Rihl?sen?" and screen memory's skip list missed the sign-in window. Opening a
    // window with that title would mean touching the desktop, so the real probe runs with only
    // its title line swapped for one that builds the title from code points (no non-ASCII in
    // the script text itself), and everything after it — JSON, escaping, the pipe, Node — is
    // the real path.
    const title = 'Přihlášení — 日本 😀'
    const line = '$title = $text.ToString()'
    const units = [...title].flatMap((c) => (c.length === 2 ? [c.charCodeAt(0), c.charCodeAt(1)] : [c.charCodeAt(0)]))
    const built = `$title = -join @(${units.map((u) => `[char]0x${u.toString(16)}`).join(',')})`
    const script = screenStateScript()
    expect(script).toContain(line)
    const swapped = script.replace(line, built)
    const out = await run(swapped)
    // Plain ASCII on the pipe, so no code page can touch it.
    expect(out).toMatch(/^[\x20-\x7e]*$/)
    const raw = JSON.parse(out)
    // A locked or switching moment has no window, so no title to carry; ride over a switch.
    let again = raw
    for (let tries = 1; tries < 3 && again.hwnd !== 1; tries += 1) again = JSON.parse(await run(swapped))
    expect(again.hwnd).toBe(1)
    expect(again.title).toBe(title)
    expect(windowsState(again).front?.title).toBe(title)
  },
  SLOW,
)
