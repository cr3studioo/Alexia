// SPDX-License-Identifier: AGPL-3.0-only
import vm from 'node:vm'
import { createDeck } from '../deck.js'
import { macosBackend, SCRIPT } from '../macos.js'
import { assert, fakeStorage, fakeTime, test } from './harness.js'

/**
 * The real JXA script, run by Node against a stand-in for System Events and the corner of AppKit
 * it touches. It proves the script's own logic and the questions and answers it exchanges. It
 * cannot prove that macOS behaves like the stand-in.
 */
function fakeMac({ apps, trusted = true }) {
  const mac = { apps, opened: [] }
  const text = (value) => ({ js: value, isNil: () => false })
  const rect = (x, y, w, h) => ({ origin: { x, y }, size: { width: w, height: h } })
  // One 1440×900 screen: a 25pt menu bar and a 70pt Dock. AppKit counts from the bottom.
  const screens = [{ frame: rect(0, 0, 1440, 900), visibleFrame: rect(0, 70, 1440, 805) }]
  const array = (items) => ({ count: items.length, objectAtIndex: (i) => items[i] })

  const windowOf = (app, state) => {
    const attribute = (name) => ({
      get value() {
        return () => state[name] === true
      },
      set value(next) {
        state[name] = next
      },
    })
    return {
      name: () => state.title,
      subrole: () => state.subrole ?? 'AXStandardWindow',
      get position() {
        return () => state.at
      },
      set position(next) {
        // Copied: an array made inside the script belongs to its own realm.
        state.at = [...next]
      },
      get size() {
        return () => state.size
      },
      set size(next) {
        state.size = [...next]
      },
      attributes: { byName: attribute },
      buttons: {
        whose: () => () =>
          state.noClose ? []
          : [{ click: () => void (state.stays || app.windows.splice(app.windows.indexOf(state), 1)) }],
      },
    }
  }
  const running = (app) => ({
    activationPolicy: 0,
    processIdentifier: app.pid,
    localizedName: text(app.name),
    bundleURL: { isNil: () => false, path: text(`/Applications/${app.name}.app`) },
    get terminated() {
      return app.dead === true
    },
    get terminate() {
      if (!app.stays) app.dead = true
      return true
    },
    get forceTerminate() {
      app.dead = true
      return true
    },
  })

  const handles = new Map(apps.map((app) => [app, running(app)]))
  const dollar = Object.assign((value) => value, {
    NSScreen: { screens: array(screens) },
    NSWorkspace: {
      sharedWorkspace: {
        get runningApplications() {
          return array(apps.filter((app) => !app.dead).map((app) => handles.get(app)))
        },
        openURL: (url) => (mac.opened.push(url), true),
        launchApplication: (name) => (mac.opened.push(name), name !== 'Nowhere'),
      },
    },
    NSURL: { fileURLWithPath: (path) => `file:${path}` },
    NSRunLoop: { currentRunLoop: { runUntilDate: () => {} } },
    NSDate: { dateWithTimeIntervalSinceNow: () => 0 },
    AXIsProcessTrusted: () => trusted,
  })
  const Application = () => ({
    applicationProcesses: {
      whose: ({ unixId }) => () =>
        apps.filter((app) => app.pid === unixId && !app.dead).map((app) => ({ windows: () => app.windows.map((w) => windowOf(app, w)) })),
    },
  })

  mac.run = async (script, question) => {
    const context = vm.createContext({ $: dollar, ObjC: { import: () => {} }, Application, delay: () => {} })
    vm.runInContext(script, context)
    return context.run([JSON.stringify(question)])
  }
  return mac
}

const app = (pid, name, ...windows) => ({ pid, name, windows })
const win = (title, x, y, w, h, more = {}) => ({ title, at: [x, y], size: [w, h], ...more })

function setup(options) {
  const mac = fakeMac(options)
  const backend = macosBackend({ run: mac.run })
  return { mac, backend, deck: createDeck({ backend, storage: fakeStorage(), spare: [1], ...fakeTime() }) }
}

test('the Mac script compiles as it is shipped', () => {
  assert.doesNotThrow(() => new vm.Script(SCRIPT))
})

test('mac: lists windows with screen coordinates from the top left', async () => {
  const { deck } = setup({
    apps: [app(50, 'Safari', win('Mail: inbox', 10, 40, 700, 500), win('palette', 0, 0, 90, 90, { subrole: 'AXFloatingWindow' }))],
  })
  const found = await deck.list()
  assert.deepEqual(found.windows, [
    { id: '50:0:Mail: inbox', app: 'Safari', title: 'Mail: inbox', x: 10, y: 40, w: 700, h: 500, minimized: false, monitor: 1 },
  ])
  assert.deepEqual(found.monitors, [{ id: 1, x: 0, y: 0, w: 1440, h: 900, primary: true }])
})

test('mac: snaps below the menu bar, minimises, restores and finds a window by title', async () => {
  const first = win('one', 10, 40, 700, 500)
  const second = win('two', 20, 50, 600, 400, { AXMinimized: true })
  const { deck } = setup({ apps: [app(50, 'Notes', first, second)] })
  await deck.arrange({ id: '50:0:one', do: 'snap_right' })
  assert.deepEqual([first.at, first.size], [[720, 25], [720, 805]])
  await deck.arrange({ id: '50:1:two', do: 'snap_left' })
  assert.equal(second.AXMinimized, false)
  assert.deepEqual([second.at, second.size], [[0, 25], [720, 805]])
  await deck.arrange({ id: '50:0:one', do: 'minimize' })
  assert.equal(first.AXMinimized, true)
  assert.match(await deck.arrange({ id: '50:0:one', do: 'restore' }), /^Restored/)
  assert.match(await deck.arrange({ id: '50:0:one', do: 'restore' }), /nothing changed/)
  await deck.arrange({ id: '50:1:two', do: 'maximize' })
  assert.deepEqual([second.at, second.size], [[0, 25], [1440, 805]])
})

test('mac: an id whose title is gone is refused, never guessed at', async () => {
  const { backend } = setup({ apps: [app(50, 'Notes', win('renamed', 0, 30, 500, 400))] })
  const [result] = await backend.apply([{ id: '50:0:old title', then: 'close' }])
  assert.equal(result.ok, false)
  assert.match(result.why, /gone, or its title changed/)
  // The same title at another place is the same window.
  const [moved] = await backend.apply([{ id: '50:7:renamed', rect: { x: 40 } }])
  assert.equal(moved.ok, true)
  assert.equal(moved.window.x, 40)
})

test('mac: close presses the close button and says when the window stays', async () => {
  const notes = app(50, 'Notes', win('a', 0, 30, 500, 400), win('b', 0, 30, 500, 400, { stays: true }), win('c', 0, 30, 5, 5, { noClose: true }))
  const { deck } = setup({ apps: [notes] })
  assert.match(await deck.arrange({ id: '50:0:a', do: 'close' }), /^Closed/)
  assert.match(await deck.arrange({ id: '50:0:b', do: 'close' }), /still open/)
  await assert.rejects(deck.arrange({ id: '50:1:c', do: 'close' }), /no close button/)
})

test('mac: quit asks, force ends, and opening uses the saved bundle', async () => {
  const stubborn = { ...app(50, 'Pages', win('essay', 0, 30, 500, 400)), stays: true }
  const { mac, deck, backend } = setup({ apps: [stubborn] })
  assert.match(await deck.quit({ app: 'pages' }), /1 window still open/)
  assert.equal(stubborn.dead, undefined)
  assert.match(await deck.quit({ app: 'Pages.app', force: true }), /Force-quit Pages/)
  assert.equal(stubborn.dead, true)
  await backend.open({ app: 'Pages', path: '/Applications/Pages.app' })
  assert.deepEqual(mac.opened, ['file:/Applications/Pages.app'])
  await assert.rejects(backend.open({ app: 'Nowhere' }), /could not open Nowhere/)
})

test('mac: without Accessibility it refuses to look or move, and can still ask an app to quit', async () => {
  const { deck } = setup({ apps: [{ ...app(50, 'Pages'), stays: true }], trusted: false })
  await assert.rejects(deck.list(), /Privacy & Security → Accessibility/)
  assert.match(await deck.quit({ app: 'Pages' }), /perhaps asking about unsaved work/)
})
