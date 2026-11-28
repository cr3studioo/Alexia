// SPDX-License-Identifier: AGPL-3.0-only
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { ASK, MAX_MS, MAX_STEPS, NO_INDICATOR, REFRESH_MS, parts, recorder, spawnCapture, startRecording } from '../record.js'
import { check, replay } from '../replay.js'
import * as win from '../windows.js'
import * as mac from '../macos.js'

/**
 * Recorded workflows (P4-29), with the event stream faked: every event here is one a capture
 * script could print, fed straight to the recorder, and the desktop the replay drives is a list.
 */
const fake = vi.hoisted(() => ({ calls: [] }))
vi.mock('../desktop.js', () => ({
  desktop: {
    click: async (x, y) => void fake.calls.push(['click', x, y]),
    type: async (text) => void fake.calls.push(['type', text]),
    key: async (keys) => void fake.calls.push(['key', keys]),
    invoke: async (target) => {
      fake.calls.push(['invoke', target])
      return { found: true, how: 'invoke' }
    },
  },
}))

afterEach(() => {
  vi.useRealTimers()
  fake.calls.length = 0
})

const here = join(import.meta.dirname, '..')

/** Core's two ways in, faked: which capabilities answer, and every call made to one. */
const host = ({ draw = false, notify = false, drawWorks = () => true } = {}) => {
  const calls = []
  return {
    calls,
    answers: async (cap) => ({ answers: (cap === 'screen.draw' && draw) || (cap === 'notify.show' && notify), here: false }),
    capability: async (cap, args) => {
      calls.push([cap, args])
      return cap === 'screen.draw' && !drawWorks() ? { isError: true, content: [] } : { content: [] }
    },
  }
}

/** A capture that hands its `onEvent` to the test and counts how often it was stopped. */
const captured = () => {
  const it = { started: 0, stopped: 0, send: undefined, end: undefined }
  it.capture = (onEvent, onEnd) => {
    it.started += 1
    it.send = onEvent
    it.end = onEnd
    return () => void (it.stopped += 1)
  }
  return it
}

const click = (name, more = {}) => ({ kind: 'click', name, role: 'Button', window: 'Report — Writer', x: 100, y: 200, ...more })

test('clicks_become_named_presses', () => {
  const rec = recorder()
  rec.add(click('Export'))
  rec.add(click('PDF', { role: 'RadioButton' }))
  // Unnamed: nothing a replay could find again. Alexia's own window: talking to her, not the task.
  rec.add(click(''))
  rec.add(click('Send', { window: 'Alexia' }))
  rec.add(click('Send', { window: 'Alexia Dev' }))
  // A text field is clicked where it was: pressing a field does nothing.
  rec.add(click('File name', { role: 'Edit', x: 300.4, y: 410.6 }))
  expect(rec.steps).toEqual([
    { do: 'press', match: 'Export', name: 'Export', role: 'Button', title: 'Report — Writer', window: 'Report — Writer' },
    { do: 'press', match: 'PDF', name: 'PDF', role: 'RadioButton', title: 'Report — Writer', window: 'Report — Writer' },
    { do: 'click', x: 300, y: 411, into: 'File name' },
  ])
  expect(check(rec.steps)).toBeUndefined()
})

test('typing_coalesced', () => {
  const rec = recorder()
  const typed = (name, text) => rec.add({ kind: 'text', name, role: 'Edit', window: 'Save as', text, password: false })
  typed('File name', 'rep')
  typed('File name', 'report')
  typed('File name', 'report-2026')
  rec.add({ kind: 'key', keys: '{ENTER}' })
  typed('Title', 'Q3')
  typed('Title', '')
  expect(rec.steps).toEqual([
    { do: 'type', into: 'File name', text: 'report-2026' },
    { do: 'key', keys: '{ENTER}' },
    { do: 'type', into: 'Title', text: 'Q3' },
  ])
})

test('password_never_recorded', async () => {
  // Built from halves, so no file holds it whole.
  const secret = ['hunter', '2-secret'].join('')
  const rec = recorder()
  rec.add(click('Password', { role: 'Edit', password: true }))
  // Even if a capture script ever sent the text, it is not kept.
  rec.add({ kind: 'text', name: 'Password', role: 'Edit', window: 'Sign in', text: secret, password: true })
  rec.add({ kind: 'text', name: 'Password', role: 'AXSecureTextField', window: 'Sign in', text: secret, password: true })
  rec.add({ kind: 'key', keys: '{ENTER}' })
  expect(JSON.stringify(rec.steps)).not.toContain(secret)
  expect(rec.steps).toEqual([
    { do: 'click', x: 100, y: 200, into: 'Password' },
    { do: 'type', into: 'Password', text: ASK },
    { do: 'key', keys: '{ENTER}' },
  ])

  // The capture scripts check for a password field before they read a value, on both systems.
  const winScript = win.recordScript(1, 1000)
  expect(winScript).toMatch(/function Get-Value\(\$el\) \{\n {2}try \{ if \(\$el\.Current\.IsPassword\) \{ return \$null \}/)
  expect(mac.recordScript).toContain("const value = (element, said) => { if (said.password) return null;")
  expect(mac.recordScript).toContain("password = sub === 'AXSecureTextField'")
  // And neither ever polls a plain key: letters only under Ctrl, Alt or Windows (not AltGr), or Cmd or Ctrl.
  expect(winScript).toContain('if (($ctrl -or $alt -or $win) -and -not ($ctrl -and $alt)) {')
  expect(mac.recordScript).toContain('if (!(flags & (CMD | CTRL))) return;')
})

test('indicator_required', async () => {
  // Nothing can show it: refused, and capture never starts.
  const none = host()
  const quiet = captured()
  expect(await startRecording({ goal: 'g', ...none, capture: quiet.capture })).toEqual({ refused: NO_INDICATOR })
  expect(quiet.started).toBe(0)
  expect(none.calls).toEqual([])

  // A notification when nothing draws.
  const told = host({ notify: true })
  const one = captured()
  const noticed = await startRecording({ goal: 'g', ...told, capture: one.capture })
  expect(told.calls.map(([cap]) => cap)).toEqual(['notify.show'])
  expect(one.started).toBe(1)
  noticed.end()

  // The red dot, drawn before capture starts and drawn again while it runs.
  vi.useFakeTimers()
  let works = true
  const drawn = host({ draw: true, notify: true, drawWorks: () => works })
  const two = captured()
  const session = await startRecording({ goal: 'g', ...drawn, capture: two.capture })
  expect(drawn.calls[0][0]).toBe('screen.draw')
  expect(drawn.calls[0][1].shapes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'dot', color: 'red' }), expect.objectContaining({ kind: 'text', text: 'Recording' })]))
  await vi.advanceTimersByTimeAsync(REFRESH_MS * 3)
  expect(drawn.calls.filter(([cap]) => cap === 'screen.draw').length).toBe(4)
  // The sign can no longer be drawn: the recording ends with it, and capture stops.
  works = false
  await vi.advanceTimersByTimeAsync(REFRESH_MS)
  expect(session.ended).toMatch(/sign/)
  expect(two.stopped).toBeGreaterThan(0)
  two.send(click('Export'))
  expect(session.steps).toEqual([])
})

test('cap_at_200_steps', async () => {
  const shown = host({ notify: true })
  const it = captured()
  const session = await startRecording({ goal: 'g', ...shown, capture: it.capture })
  for (let i = 0; i < 250; i += 1) it.send(click(`Button ${String(i)}`))
  expect(MAX_STEPS).toBe(200)
  expect(session.steps.length).toBe(200)
  expect(session.ended).toBe('it reached 200 steps')
  expect(it.stopped).toBe(1)

  // And after ten minutes, whatever the count.
  vi.useFakeTimers()
  const later = captured()
  const timed = await startRecording({ goal: 'g', ...shown, capture: later.capture })
  later.send(click('Export'))
  await vi.advanceTimersByTimeAsync(MAX_MS - 1)
  expect(timed.ended).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1)
  expect(timed.ended).toBe('it reached 10 minutes')
  expect(later.stopped).toBe(1)
  expect(timed.steps.length).toBe(1)
})

test('cancel_keeps_nothing', async () => {
  vi.useFakeTimers()
  const drawn = host({ draw: true })
  const it = captured()
  const session = await startRecording({ goal: 'g', ...drawn, capture: it.capture })
  it.send(click('Export'))
  session.end()
  expect(it.stopped).toBe(1)
  // Ended: no more events are taken and the sign is not drawn again.
  it.send(click('PDF'))
  const draws = drawn.calls.length
  await vi.advanceTimersByTimeAsync(REFRESH_MS * 5)
  expect(drawn.calls.length).toBe(draws)
  expect(session.steps.length).toBe(1)

  // record_cancel drops the session without a write; only record_stop stores a plan.
  const source = readFileSync(join(here, 'index.js'), 'utf8')
  const cancel = source.slice(source.indexOf("'record_cancel'"), source.indexOf('/**', source.indexOf("'record_cancel'")))
  expect(cancel).toContain('session?.end()')
  expect(cancel).not.toContain('storage')
  expect(readFileSync(join(here, 'record.js'), 'utf8')).not.toMatch(/storage|writeFile/)
})

test('recorded_plan_replays', async () => {
  const rec = recorder()
  rec.add(click('Export'))
  rec.add(click('File name', { role: 'Edit', x: 320, y: 240 }))
  rec.add({ kind: 'text', name: 'File name', role: 'Edit', window: 'Export', text: 'report', password: false })
  rec.add({ kind: 'key', keys: '^s' })
  rec.add(click('PDF', { role: 'RadioButton', window: 'Export' }))
  expect(check(rec.steps)).toBeUndefined()
  expect(await replay(rec.steps)).toEqual({ steps: 5, answers: {}, stopped: false })
  expect(fake.calls).toEqual([
    ['invoke', { title: 'Report — Writer', match: 'Export' }],
    ['click', 320, 240],
    ['type', 'report'],
    ['key', '^s'],
    ['invoke', { title: 'Export', match: 'PDF' }],
  ])

  // A password splits the plan: the part before runs, the owner types, the part after runs.
  fake.calls.length = 0
  const signIn = recorder()
  signIn.add({ kind: 'text', name: 'User', role: 'Edit', window: 'Sign in', text: 'owner', password: false })
  signIn.add({ kind: 'text', name: 'Password', role: 'Edit', window: 'Sign in', password: true })
  signIn.add({ kind: 'key', keys: '{ENTER}' })
  const [first, second] = parts(signIn.steps)
  expect(first).toEqual({ steps: [{ do: 'type', into: 'User', text: 'owner' }], then: 'Password' })
  expect(second).toEqual({ steps: [{ do: 'key', keys: '{ENTER}' }] })
  for (const part of [first, second]) await replay(part.steps)
  expect(fake.calls).toEqual([
    ['type', 'owner'],
    ['key', '{ENTER}'],
  ])
})

test('every capability in provides is bound by exactly one tool', () => {
  const manifest = JSON.parse(readFileSync(join(here, 'plugin.json'), 'utf8'))
  const source = readFileSync(join(here, 'index.js'), 'utf8')
  const bound = [...source.matchAll(/'alexia\/provides': \[([^\]]*)\]/g)].flatMap((found) => [...found[1].matchAll(/'([^']+)'/g)].map((cap) => cap[1]))
  expect(bound.sort()).toEqual([...manifest.provides].sort())
  // And the two it now calls are asked for, or core refuses the call.
  expect(manifest.requires.map((one) => one.cap)).toEqual(expect.arrayContaining(['screen.draw', 'notify.show']))
})

test('a capture process: its lines are events, its end line ends it once, and stop kills it', () => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: 0 })
  child.kill = () => void (child.killed += 1)
  const events = []
  const ends = []
  const stop = spawnCapture({ command: 'x', args: [] }, (event) => events.push(event), (why) => ends.push(why), () => child)
  child.stdout.emit('data', '{"kind":"key","keys":"^s"}\n{"kind":"cli')
  child.stdout.emit('data', 'ck","name":"OK"}\nnot json\n\n{"end":"it reached its time limit"}\n')
  child.emit('close', 0)
  expect(events).toEqual([
    { kind: 'key', keys: '^s' },
    { kind: 'click', name: 'OK' },
  ])
  expect(ends).toEqual(['it reached its time limit'])
  stop()
  expect(child.killed).toBe(1)
})

test('the Mac watcher is a script that parses', () => {
  expect(() => new Function(mac.recordScript)).not.toThrow()
  const { command, args } = mac.recording(42, 5000)
  expect(command).toBe('/usr/bin/osascript')
  expect(args.slice(-2)).toEqual(['42', '5000'])
})

test.runIf(process.platform === 'win32')('real PowerShell: the watcher runs and stops by itself at its time', async () => {
  const ended = await new Promise((resolve) => {
    spawnCapture(win.recording(process.pid, 1500), () => {}, resolve)
  })
  expect(ended).toBe('it reached its time limit')
}, 60_000)
