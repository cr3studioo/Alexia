// SPDX-License-Identifier: AGPL-3.0-only
import { createBackend, monitorOf } from '../backend.js'
import { createDeck, fit, half, matchWindows } from '../deck.js'
import { windowsBackend } from '../windows.js'
import { assert, fakeDesktop, fakeStorage, fakeTime, row, SCREENS, test } from './harness.js'
// The live tests, which register only when ALEXIA_WINDOW_LIVE=1.
import './live.js'

/** The deck over the real Windows backend, with only the runner faked. */
function setup(options) {
  const desk = fakeDesktop(options)
  const storage = fakeStorage()
  const deck = createDeck({ backend: windowsBackend({ run: desk.run }), storage, spare: [11, 22], ...fakeTime() })
  return { desk, storage, deck }
}

const placed = (desk, id) => {
  const { x, y, w, h, minimized, maximized } = desk.windows.find((one) => one.id === id)
  return { x, y, w, h, minimized, maximized }
}

test('list_parses_backend_output', async () => {
  // What PowerShell really prints: monitors in no useful order, one window mostly on the second.
  const printed = JSON.stringify({
    windows: [
      { id: '65890', app: 'notepad', title: 'Poznámky – “draft”', x: 10, y: 20, w: 800, h: 600, minimized: false, maximized: false, path: 'C-notepad', aumid: '' },
      { id: '131', app: 'chrome', title: 'Mail', x: 1800, y: 0, w: 1000, h: 900, minimized: true, maximized: false, path: '', aumid: 'Chrome.App' },
    ],
    monitors: [
      { x: 1920, y: 0, w: 2560, h: 1440, work: { x: 1920, y: 0, w: 2560, h: 1400 }, primary: false },
      { x: 0, y: 0, w: 1920, h: 1080, work: { x: 0, y: 0, w: 1920, h: 1032 }, primary: true },
    ],
  })
  const questions = []
  const backend = windowsBackend({ run: async (_script, question) => (questions.push(question), printed) })
  const deck = createDeck({ backend, storage: fakeStorage() })
  assert.deepEqual(await deck.list(), {
    windows: [
      { id: '65890', app: 'notepad', title: 'Poznámky – “draft”', x: 10, y: 20, w: 800, h: 600, minimized: false, monitor: 1 },
      { id: '131', app: 'chrome', title: 'Mail', x: 1800, y: 0, w: 1000, h: 900, minimized: true, monitor: 2 },
    ],
    monitors: [
      { id: 1, x: 0, y: 0, w: 1920, h: 1080, primary: true },
      { id: 2, x: 1920, y: 0, w: 2560, h: 1440, primary: false },
    ],
  })
  assert.deepEqual(questions, [{ do: 'list' }])
  const full = await backend.list()
  assert.deepEqual(full.windows[1].launch, { aumid: 'Chrome.App' })
  assert.deepEqual(full.windows[0].launch, { path: 'C-notepad' })
})

test('a refusal and unreadable output come back as sentences', async () => {
  const refused = createBackend(async () => JSON.stringify({ refused: 'Not allowed here.' }), 'script')
  await assert.rejects(refused.list(), { message: 'Not allowed here.' })
  const noise = createBackend(async () => 'WARNING: something', 'script')
  await assert.rejects(noise.list(), /unreadable/)
  const blind = createBackend(async () => JSON.stringify({ windows: [], monitors: [] }), 'script')
  await assert.rejects(blind.list(), /No screen/)
})

test('snap_left_uses_monitor_half', async () => {
  const { desk, deck } = setup({
    windows: [
      row('1', 'notepad', 'a', 300, 300, 800, 600),
      row('2', 'chrome', 'b', 2000, 100, 900, 700),
    ],
  })
  const said = await deck.arrange({ id: '1', do: 'snap_left' })
  // Half of the work area, so the taskbar is not covered.
  assert.deepEqual(desk.asked.at(-1), { do: 'apply', ops: [{ id: '1', rect: { x: 0, y: 0, w: 960, h: 1032 } }] })
  assert.equal(said, '“a” (notepad) is now 960×1032 at 0,0.')

  await deck.arrange({ id: '2', do: 'snap_left' })
  assert.deepEqual(placed(desk, '2'), { x: 1920, y: 0, w: 1280, h: 1400, minimized: false, maximized: false })
  await deck.arrange({ id: '1', do: 'snap_right', monitor: 2 })
  assert.deepEqual(placed(desk, '1'), { x: 3200, y: 0, w: 1280, h: 1400, minimized: false, maximized: false })
})

test('the two halves of an odd width meet without a gap', () => {
  const monitor = { work: { x: -1365, y: 30, w: 1365, h: 700 } }
  assert.deepEqual(half(monitor, 'left'), { x: -1365, y: 30, w: 682, h: 700 })
  assert.deepEqual(half(monitor, 'right'), { x: -683, y: 30, w: 683, h: 700 })
})

test('move and resize send only what was given', async () => {
  const { desk, deck } = setup({ windows: [row('1', 'notepad', 'a', 300, 300, 800, 600)] })
  await deck.arrange({ id: '1', do: 'move', x: -20, y: 40 })
  assert.deepEqual(desk.asked.at(-1).ops, [{ id: '1', rect: { x: -20, y: 40 } }])
  await deck.arrange({ id: '1', do: 'resize', w: 500.4 })
  assert.deepEqual(desk.asked.at(-1).ops, [{ id: '1', rect: { w: 500 } }])
  // To another monitor: the same offset from its corner.
  await deck.arrange({ id: '1', do: 'move', x: 100, y: 200 })
  await deck.arrange({ id: '1', do: 'move', monitor: 2 })
  assert.deepEqual(desk.asked.at(-1).ops, [{ id: '1', rect: { x: 2020, y: 200 } }])
})

test('a maximized window sent to another monitor stays maximized; to its own it is left alone', async () => {
  const { desk, deck } = setup({ windows: [row('1', 'notepad', 'a', 0, 0, 1920, 1032, { maximized: true })] })
  await assert.rejects(deck.arrange({ id: '1', do: 'move', monitor: 1 }), /already on monitor 1/)
  assert.equal(desk.asked.filter((one) => one.do === 'apply').length, 0)
  assert.equal(await deck.arrange({ id: '1', do: 'move', monitor: 2 }), 'Moved “a” (notepad) to monitor 2, still maximised.')
  assert.deepEqual(desk.asked.at(-1).ops, [{ id: '1', rect: { x: 1920, y: 0, w: 1920, h: 1032 }, then: 'maximize' }])
  assert.deepEqual(placed(desk, '1'), { x: 1920, y: 0, w: 2560, h: 1400, minimized: false, maximized: true })
  await assert.rejects(deck.arrange({ id: '1', do: 'move', monitor: null }), /give x, y or monitor/)
})

test('maximize on another monitor moves there first; on its own it only maximizes', async () => {
  const { desk, deck } = setup({ windows: [row('1', 'notepad', 'a', 300, 300, 800, 600)] })
  await deck.arrange({ id: '1', do: 'maximize' })
  assert.deepEqual(desk.asked.at(-1).ops, [{ id: '1', then: 'maximize' }])
  await deck.arrange({ id: '1', do: 'restore' })
  await deck.arrange({ id: '1', do: 'maximize', monitor: 2 })
  assert.equal(desk.asked.at(-1).ops[0].rect.x, 1920)
  assert.equal(desk.asked.at(-1).ops[0].then, 'maximize')
})

test('arrange refuses an unlisted window, a missing value and an unknown monitor without touching anything', async () => {
  const { desk, deck } = setup({ windows: [row('1', 'notepad', 'a', 300, 300, 800, 600)] })
  await assert.rejects(deck.arrange({ id: '999', do: 'close' }), /no window with id 999/)
  await assert.rejects(deck.arrange({ id: '1', do: 'move' }), /give x, y or monitor/)
  await assert.rejects(deck.arrange({ id: '1', do: 'resize' }), /give w, h or both/)
  await assert.rejects(deck.arrange({ id: '1', do: 'resize', w: 0 }), /w must be a number/)
  await assert.rejects(deck.arrange({ id: '1', do: 'move', x: 'left' }), /x must be a number/)
  await assert.rejects(deck.arrange({ id: '1', do: 'snap_left', monitor: 7 }), /no monitor 7/)
  await assert.rejects(deck.arrange({ id: '1', do: 'explode' }), /is not one of/)
  assert.equal(desk.asked.filter((one) => one.do === 'apply').length, 0)
})

test('close says whether the window went or is asking to save', async () => {
  const { deck } = setup({
    windows: [row('1', 'notepad', 'a', 0, 0, 800, 600), row('2', 'word', 'b', 0, 0, 800, 600)],
    stubborn: ['2'],
  })
  assert.equal(await deck.arrange({ id: '1', do: 'close' }), 'Closed “a” (notepad).')
  assert.match(await deck.arrange({ id: '2', do: 'close' }), /still open, probably asking about unsaved work/)
})

test('a refusal by the system is said, not reported as done', async () => {
  const run = async (_script, question) =>
    JSON.stringify(
      question.do === 'list' ?
        { windows: [row('1', 'admin', 'a', 0, 0, 800, 600)], monitors: SCREENS }
      : { results: [{ id: '1', ok: false, why: 'Windows would not let me: that app is running as administrator.' }] },
    )
  const deck = createDeck({ backend: windowsBackend({ run }), storage: fakeStorage() })
  await assert.rejects(deck.arrange({ id: '1', do: 'minimize' }), /could not minimize .*administrator/)
})

test('layout_save_apply_round_trip', async () => {
  const { desk, storage, deck } = setup({
    windows: [
      row('1', 'notepad', 'notes', 0, 0, 960, 1032),
      row('2', 'chrome', 'Mail', 960, 0, 960, 1032),
      row('3', 'chrome', 'Docs', 1920, 0, 2560, 1400, { maximized: true }),
      row('4', 'spotify', 'Music', 100, 100, 600, 400, { minimized: true }),
    ],
  })
  assert.deepEqual(await deck.save('  My   study layout '), { saved: 'My study layout', windows: 4 })
  const before = structuredClone(desk.windows)
  assert.equal(storage.rows('layouts').length, 1)
  assert.deepEqual(Object.keys(storage.rows('layouts')[0]).sort(), ['json', 'name', 'saved_at'])

  // Everything is shuffled, and the ids are new, as after a restart.
  desk.windows = [
    row('13', 'chrome', 'Docs', 50, 50, 500, 500),
    row('11', 'notepad', 'notes', 700, 200, 400, 300, { minimized: true }),
    row('14', 'spotify', 'Music', 300, 300, 600, 400),
    row('12', 'chrome', 'Mail', 10, 10, 500, 500, { maximized: true }),
  ]
  const done = await deck.apply({ name: 'my study LAYOUT' })
  assert.equal(done.placed, 4)
  assert.deepEqual(done.missing, [])
  for (const [old, now] of [['1', '11'], ['2', '12'], ['3', '13']]) {
    const was = before.find((one) => one.id === old)
    assert.deepEqual(placed(desk, now), { x: was.x, y: was.y, w: was.w, h: was.h, minimized: false, maximized: was.maximized }, now)
  }
  assert.equal(placed(desk, '14').minimized, true)
})

test('saving a name again replaces it, and an unknown name lists what is saved', async () => {
  const { desk, storage, deck } = setup({ windows: [row('1', 'notepad', 'notes', 0, 0, 900, 900)] })
  await Promise.all([deck.save('Study'), deck.save('study')])
  desk.windows[0].x = 40
  await deck.save('STUDY')
  assert.equal(storage.rows('layouts').length, 1)
  assert.equal(JSON.parse(storage.rows('layouts')[0].json).windows[0].x, 40)
  await assert.rejects(deck.apply({ name: 'work' }), /no layout called “work”\. Saved layouts: “STUDY”/)
  await assert.rejects(deck.save('   '), /1 to 80/)
  desk.windows = []
  await assert.rejects(deck.save('empty'), /nothing to save/)
  storage.rows('layouts')[0].json = '{broken'
  await assert.rejects(deck.apply({ name: 'study' }), /cannot be read/)
})

test('windows are matched by app and title first, then by app alone', () => {
  const saved = [
    { app: 'chrome', title: 'Gone tab' },
    { app: 'chrome', title: 'Mail' },
    { app: 'Notepad', title: 'x' },
  ]
  const open = [
    { id: 'a', app: 'chrome', title: 'Mail' },
    { id: 'b', app: 'chrome', title: 'Other' },
    { id: 'c', app: 'notepad', title: 'y' },
    { id: 'd', app: 'word', title: 'Gone tab' },
  ]
  assert.deepEqual(
    matchWindows(saved, open).map((one) => [one.entry.title, one.window.id]),
    // “Mail” takes its own window although “Gone tab” was listed first; a title never crosses apps.
    [['Gone tab', 'b'], ['Mail', 'a'], ['x', 'c']],
  )
  assert.deepEqual(matchWindows(saved, open, new Set(['a', 'b', 'c'])), [])
})

test('a monitor that is gone brings its windows onto one that is there', () => {
  const saved = [{ id: 2, ...SCREENS[1] }]
  const only = [{ id: 1, ...SCREENS[0] }]
  const entry = { monitor: 2, x: 4000, y: 900, w: 2200, h: 400 }
  const { monitor, rect } = fit(entry, saved, only)
  assert.equal(monitor.id, 1)
  assert.deepEqual(rect, { x: 0, y: 632, w: 1920, h: 400 })
  // The same screen, still where it was: exactly as saved.
  assert.deepEqual(fit(entry, saved, [...only, { id: 2, ...SCREENS[1] }]).rect, { x: 4000, y: 900, w: 2200, h: 400 })
})

test('a window is on the monitor holding most of it, or the nearest', () => {
  const screens = [{ id: 1, ...SCREENS[0] }, { id: 2, ...SCREENS[1] }]
  assert.equal(monitorOf({ x: 1800, y: 0, w: 400, h: 300 }, screens).id, 2)
  assert.equal(monitorOf({ x: -32000, y: -32000, w: 200, h: 100 }, screens).id, 1)
  assert.equal(monitorOf({ x: 9000, y: 100, w: 200, h: 100 }, screens).id, 2)
})

test('missing_app_reported', async () => {
  const { desk, deck } = setup({
    windows: [row('1', 'notepad', 'notes', 0, 0, 960, 1032), row('2', 'chrome', 'Mail', 960, 0, 960, 1032), row('3', 'chrome', 'Docs', 0, 0, 800, 600)],
    launches: { chrome: [row('9', 'chrome', 'New tab', 5, 5, 400, 400)] },
  })
  await deck.save('study')
  desk.windows = [row('1', 'notepad', 'notes', 500, 500, 400, 300)]
  const done = await deck.apply({ name: 'study' })
  assert.deepEqual(done.missing, ['chrome'])
  assert.equal(done.placed, 1)
  assert.match(done.text, /Not running: chrome\. Nothing was opened\./)
  assert.equal(desk.asked.filter((one) => one.do === 'open').length, 0)
  // Anything but true is not permission to open.
  await deck.apply({ name: 'study', open_missing: 'yes' })
  assert.equal(desk.asked.filter((one) => one.do === 'open').length, 0)
})

test('open_missing opens each missing app once and places the windows that appear', async () => {
  const { desk, deck } = setup({
    windows: [row('2', 'chrome', 'Mail', 960, 0, 960, 1032), row('3', 'chrome', 'Docs', 0, 0, 800, 600), row('4', 'ghost', 'g', 0, 0, 100, 100)],
    launches: { chrome: [row('9', 'chrome', 'New tab', 5, 5, 400, 400)] },
  })
  await deck.save('study')
  desk.windows = []
  const done = await deck.apply({ name: 'study', open_missing: true })
  assert.deepEqual(done.missing, ['chrome', 'ghost'])
  // One of chrome's two saved windows appeared; ghost could not be started.
  assert.equal(done.placed, 1)
  assert.deepEqual(desk.asked.filter((one) => one.do === 'open'), [
    { do: 'open', app: 'chrome', path: '/apps/chrome' },
    { do: 'open', app: 'ghost', path: '/apps/ghost' },
  ])
  assert.deepEqual(placed(desk, '9'), { x: 960, y: 0, w: 960, h: 1032, minimized: false, maximized: false })
  assert.match(done.text, /Opened: chrome\./)
  assert.match(done.text, /Could not open: ghost \(Could not find ghost\.\)/)
  assert.match(done.text, /2 saved windows had no open window to use/)
})

test('an opened app that never shows a window is waited for only so long', async () => {
  const desk = fakeDesktop({ windows: [row('1', 'slow', 's', 0, 0, 100, 100)], launches: { slow: [] } })
  const time = fakeTime()
  const deck = createDeck({ backend: windowsBackend({ run: desk.run }), storage: fakeStorage(), ...time, openWaitMs: 3000 })
  await deck.save('one')
  desk.windows = []
  const start = time.now()
  const done = await deck.apply({ name: 'one', open_missing: true })
  assert.equal(done.placed, 0)
  assert.equal(time.now() - start, 3000)
})

test('quit_force_only_when_asked', async () => {
  const windows = [row('1', 'word', 'essay', 0, 0, 800, 600)]
  const { desk, deck } = setup({ windows, stubborn: ['1'] })
  for (const force of [undefined, false, 'true', 1]) {
    const said = await deck.quit({ app: 'word.exe', force })
    assert.match(said, /still open, probably asking about unsaved work/)
    assert.deepEqual(desk.asked.at(-1), { do: 'quit', app: 'word', force: false, spare: [11, 22], waitMs: 5000 })
  }
  assert.equal(desk.windows.length, 1)
  assert.match(await deck.quit({ app: 'word', force: true }), /Force-quit word\. Anything unsaved in it is lost\./)
  assert.equal(desk.asked.at(-1).force, true)
  assert.equal(desk.windows.length, 0)
})

test('quit never force-ends the system, and says when nothing is running', async () => {
  const { desk, deck } = setup({ windows: [row('1', 'explorer', 'Downloads', 0, 0, 800, 600)] })
  for (const app of ['explorer', 'Explorer.exe', 'dwm', 'Finder']) {
    await assert.rejects(deck.quit({ app, force: true }), /part of the system/)
  }
  assert.equal(desk.asked.length, 0)
  // Closing its windows politely is fine.
  assert.equal(await deck.quit({ app: 'explorer' }), 'explorer has quit.')
  await assert.rejects(deck.quit({ app: 'nothing' }), /Nothing called “nothing” is running/)
  await assert.rejects(deck.quit({ app: '  ' }), /which app/)
})

test('quit says what is still true afterwards', async () => {
  const said = async (answer, force = false) => {
    const deck = createDeck({ backend: windowsBackend({ run: async () => JSON.stringify(answer) }), storage: fakeStorage() })
    return deck.quit({ app: 'app', force })
  }
  assert.match(await said({ found: 1, windows: 0, open: 0, running: 1 }), /no window to close/)
  assert.match(await said({ found: 2, windows: 1, open: 0, running: 1 }), /Closed the windows of app\. It is still running/)
  assert.match(await said({ found: 1, windows: null, open: 0, running: 1 }), /perhaps asking/)
  await assert.rejects(said({ found: 1, windows: 0, open: 0, running: 1 }, true), /could not end app/)
})
