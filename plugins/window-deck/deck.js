// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What this plugin decides, with no operating system in it: where a snapped window goes, which
 * open window a saved one is, and what to say afterwards. The caller hands in a `backend`
 * (see `backend.js`) and `storage` (the plugin's own table `layouts`), so the tests fake both.
 */

/** How long `apply` waits for the apps it opened to show their windows. */
export const OPEN_WAIT_MS = 20_000
/** How long `quit` waits for an app to close before saying it has not. */
export const QUIT_WAIT_MS = 5_000
const POLL_MS = 1_000
const MOST = 100_000

/** Never force-quit: ending one of these takes the desktop or the session with it. */
const PROTECTED = new Set([
  'applicationframehost', 'csrss', 'dwm', 'explorer', 'lsass', 'services', 'smss', 'svchost', 'system',
  'wininit', 'winlogon', 'dock', 'finder', 'kernel_task', 'launchd', 'loginwindow', 'systemuiserver', 'windowserver',
])

export const ACTIONS = ['move', 'resize', 'snap_left', 'snap_right', 'maximize', 'minimize', 'restore', 'close']

const same = (a, b) => a.toLowerCase() === b.toLowerCase()
const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high))
const plural = (count, word) => `${String(count)} ${word}${count === 1 ? '' : 's'}`

/** An app and a title, for a sentence. */
export const nameOf = (window) => `“${window.title || '(untitled)'}” (${window.app || 'unknown app'})`

/** A whole number a window can be placed with, or undefined when not given. */
function whole(value, key, least) {
  if (value === undefined || value === null) return undefined
  const n = Number(value)
  if (typeof value === 'boolean' || value === '' || !Number.isFinite(n) || n < least || n > MOST) {
    throw new Error(`${key} must be a number from ${String(least)} to ${String(MOST)}.`)
  }
  return Math.round(n)
}

/** The given keys only, so what the backend leaves alone is simply absent. */
const given = (rect) => Object.fromEntries(Object.entries(rect).filter(([, value]) => value !== undefined))

/** The left or right half of a monitor's work area: the screen without the taskbar or Dock. */
export function half(monitor, side) {
  const { x, y, w, h } = monitor.work
  const left = Math.floor(w / 2)
  return side === 'left' ? { x, y, w: left, h } : { x: x + left, y, w: w - left, h }
}

/** Where `window` lands when it moves to another monitor: the same corner offset, kept inside. */
function carried(window, from, to) {
  const w = Math.min(window.w, to.work.w)
  const h = Math.min(window.h, to.work.h)
  return {
    x: clamp(to.work.x + (window.x - from.work.x), to.work.x, to.work.x + to.work.w - w),
    y: clamp(to.work.y + (window.y - from.work.y), to.work.y, to.work.y + to.work.h - h),
  }
}

/** Put a window on `monitor` so that maximising it fills that one. */
const onto = (window, monitor) => ({
  x: monitor.work.x,
  y: monitor.work.y,
  w: Math.min(window.w, monitor.work.w),
  h: Math.min(window.h, monitor.work.h),
})

/** What `window_arrange` asks the backend for. */
export function arrangeOp(ask, window, monitors) {
  const action = ask.do
  if (!ACTIONS.includes(action)) throw new Error(`“${String(action)}” is not one of ${ACTIONS.join(', ')}.`)
  const at = monitors.find((one) => one.id === window.monitor) ?? monitors[0]
  let to = at
  const asked = ask.monitor !== undefined && ask.monitor !== null
  if (asked) {
    to = monitors.find((one) => one.id === Number(ask.monitor))
    if (!to) throw new Error(`There is no monitor ${String(ask.monitor)}. The monitors are ${monitors.map((one) => one.id).join(', ')}.`)
  }
  const x = whole(ask.x, 'x', -MOST)
  const y = whole(ask.y, 'y', -MOST)
  const w = whole(ask.w, 'w', 1)
  const h = whole(ask.h, 'h', 1)
  const elsewhere = to.id !== at.id
  const id = window.id
  if (action === 'move' || action === 'resize') {
    if (action === 'move' && x === undefined && y === undefined && !asked) throw new Error('To move a window, give x, y or monitor.')
    if (action === 'resize' && w === undefined && h === undefined) throw new Error('To resize a window, give w, h or both.')
    const values = given({ x, y, w, h })
    // A maximised window sent to another monitor, and nothing else, stays maximised there.
    if (elsewhere && window.maximized && !window.minimized && Object.keys(values).length === 0) {
      return { id, rect: onto(window, to), then: 'maximize' }
    }
    const rect = { ...(elsewhere && carried(window, at, to)), ...values }
    // Placing nothing would still un-maximise it, so say it instead.
    if (Object.keys(rect).length === 0) throw new Error(`It is already on monitor ${String(to.id)}.`)
    return { id, rect }
  }
  if (action === 'snap_left' || action === 'snap_right') return { id, rect: half(to, action.slice(5)) }
  if (action === 'maximize') return { id, ...(elsewhere && { rect: onto(window, to) }), then: 'maximize' }
  return { id, then: action }
}

// ---- layouts ------------------------------------------------------------------------------

export function layoutName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ')
  if (name === '' || name.length > 80) throw new Error('Give the layout a name of 1 to 80 characters.')
  return name
}

/**
 * Which open window each saved one is: **by app and title first, then by app alone**. Every
 * exact match is taken before any loose one, so a loose match never steals another's window.
 * Each open window is used once. `taken` holds ids already spoken for.
 */
export function matchWindows(saved, open, taken = new Set()) {
  const used = new Set(taken)
  const found = new Map()
  for (const byTitle of [true, false]) {
    for (const entry of saved) {
      if (found.has(entry)) continue
      const window = open.find((one) => !used.has(one.id) && same(one.app, entry.app) && (!byTitle || one.title === entry.title))
      if (!window) continue
      found.set(entry, window)
      used.add(window.id)
    }
  }
  return saved.filter((entry) => found.has(entry)).map((entry) => ({ entry, window: found.get(entry) }))
}

const bounds = (m) => `${String(m.x)},${String(m.y)},${String(m.w)},${String(m.h)}`

/**
 * The monitor a saved window goes to now, and its rectangle there. A monitor that is still where
 * it was keeps the rectangle exactly. Otherwise (unplugged, moved, another resolution) it goes to
 * a monitor of the same size, else the primary one, at the same offset and kept on screen.
 */
export function fit(entry, savedMonitors, monitors) {
  const was = savedMonitors.find((one) => one.id === entry.monitor)
  const unmoved = was && monitors.find((one) => bounds(one) === bounds(was))
  if (unmoved) return { monitor: unmoved, rect: { x: entry.x, y: entry.y, w: entry.w, h: entry.h } }
  const monitor =
    (was && monitors.find((one) => one.w === was.w && one.h === was.h)) ?? monitors.find((one) => one.primary) ?? monitors[0]
  const w = Math.min(entry.w, monitor.work.w)
  const h = Math.min(entry.h, monitor.work.h)
  const from = was?.work ?? { x: entry.x, y: entry.y }
  return {
    monitor,
    rect: {
      x: clamp(monitor.work.x + (entry.x - from.x), monitor.work.x, monitor.work.x + monitor.work.w - w),
      y: clamp(monitor.work.y + (entry.y - from.y), monitor.work.y, monitor.work.y + monitor.work.h - h),
      w,
      h,
    },
  }
}

/** What puts one open window back the way it was saved. */
export function restoreOp({ entry, window }, savedMonitors, monitors) {
  const id = window.id
  if (entry.minimized) return { id, then: 'minimize' }
  const { monitor, rect } = fit(entry, savedMonitors, monitors)
  if (!entry.maximized) return { id, rect }
  const already = window.maximized && !window.minimized && window.monitor === monitor.id
  return { id, ...(!already && { rect: onto(window, monitor) }), then: 'maximize' }
}

function parseLayout(row) {
  try {
    const layout = JSON.parse(String(row.json))
    if (Array.isArray(layout?.windows) && Array.isArray(layout?.monitors)) return layout
  } catch {
    // Said below.
  }
  throw new Error(`The saved layout “${String(row.name)}” cannot be read. Save it again.`)
}

// ---- the deck -----------------------------------------------------------------------------

export function createDeck({
  backend,
  storage,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  openWaitMs = OPEN_WAIT_MS,
  spare = [process.pid, process.ppid],
}) {
  /** One write at a time, so a name never ends up on two rows. */
  let writing = Promise.resolve()
  const inTurn = (write) => {
    const next = writing.then(write)
    writing = next.catch(() => {})
    return next
  }

  const rowNamed = async (name) => (await storage.select('layouts')).find((row) => same(String(row.name), name))

  async function apply(ops, signal) {
    return ops.length > 0 ? backend.apply(ops, signal) : []
  }

  /** Open the apps that are not running, then place their windows as they appear. */
  async function openMissing(layout, missing, taken, signal) {
    const unopened = []
    const opened = []
    for (const app of missing) {
      const entry = layout.windows.find((one) => same(one.app, app))
      try {
        await backend.open({ app: entry.app, ...entry.launch }, signal)
        opened.push(app)
      } catch (error) {
        unopened.push(`${app} (${error.message})`)
      }
    }
    if (opened.length === 0) return { opened, unopened, matches: [], monitors: [] }
    const wanted = layout.windows.filter((entry) => opened.some((app) => same(app, entry.app)))
    const deadline = now() + openWaitMs
    let before = ''
    for (;;) {
      await sleep(POLL_MS)
      signal?.throwIfAborted()
      const state = await backend.list(signal)
      const matches = matchWindows(wanted, state.windows, taken)
      const seen = matches.map((one) => one.window.id).join('\n')
      // The same windows twice in a row, so a splash screen has had its moment to go.
      const settled = seen === before && opened.every((app) => matches.some((one) => same(one.entry.app, app)))
      if (settled || now() >= deadline) return { opened, unopened, matches, monitors: state.monitors }
      before = seen
    }
  }

  return {
    async list(signal) {
      const { windows, monitors } = await backend.list(signal)
      return {
        windows: windows.map(({ id, app, title, x, y, w, h, minimized, monitor }) => ({
          id, app, title, x, y, w, h, minimized, monitor,
        })),
        monitors: monitors.map(({ id, x, y, w, h, primary }) => ({ id, x, y, w, h, primary })),
      }
    },

    /** Do one thing to one listed window, and say what is true afterwards. */
    async arrange(ask, signal) {
      const { windows, monitors } = await backend.list(signal)
      // Only an id the list gave: never a handle from anywhere else.
      const window = windows.find((one) => one.id === String(ask.id))
      if (!window) throw new Error(`There is no window with id ${String(ask.id)}. Ask for the window list again.`)
      const op = arrangeOp(ask, window, monitors)
      const [result] = await apply([op], signal)
      if (!result?.ok) throw new Error(`I could not ${ask.do.replace('_', ' ')} ${nameOf(window)}. ${result?.why ?? ''}`.trim())
      const name = nameOf(window)
      if (ask.do === 'close') {
        return result.gone ?
            `Closed ${name}.`
          : `Asked ${name} to close. It is still open, probably asking about unsaved work.`
      }
      if (ask.do === 'minimize') return `Minimised ${name}.`
      if (ask.do === 'maximize') return `Maximised ${name}.`
      if (ask.do === 'restore') {
        return result.unchanged ? `${name} was not minimised or maximised, so nothing changed.` : `Restored ${name}.`
      }
      if (op.then === 'maximize') return `Moved ${name} to monitor ${String(ask.monitor)}, still maximised.`
      const after = result.window
      if (!after) return `Placed ${name}.`
      const off = Object.entries(op.rect).some(([key, value]) => Math.abs(after[key] - value) > 2)
      return (
        `${name} is now ${String(after.w)}×${String(after.h)} at ${String(after.x)},${String(after.y)}.` +
        (off ? ' The app would not take exactly the size or place asked for.' : '')
      )
    },

    async save(value, signal) {
      const name = layoutName(value)
      const { windows, monitors } = await backend.list(signal)
      if (windows.length === 0) throw new Error('No windows are open, so there is nothing to save.')
      const json = JSON.stringify({
        monitors: monitors.map(({ id, x, y, w, h, primary, work }) => ({ id, x, y, w, h, primary, work })),
        windows: windows.map(({ app, title, x, y, w, h, minimized, maximized, monitor, launch }) => ({
          app, title, x, y, w, h, minimized, maximized, monitor, launch,
        })),
      })
      await inTurn(async () => {
        const row = await rowNamed(name)
        const saved = { name, json, saved_at: now() }
        if (row) await storage.update('layouts', saved, { name: String(row.name) })
        else await storage.insert('layouts', saved)
      })
      return { saved: name, windows: windows.length }
    },

    async apply({ name: value, open_missing: openThem } = {}, signal) {
      const name = layoutName(value)
      const row = await rowNamed(name)
      if (!row) {
        const names = (await storage.select('layouts')).map((one) => `“${String(one.name)}”`)
        throw new Error(
          `There is no layout called “${name}”. ${names.length > 0 ? `Saved layouts: ${names.join(', ')}.` : 'None is saved yet.'}`,
        )
      }
      const layout = parseLayout(row)
      const state = await backend.list(signal)
      const matches = matchWindows(layout.windows, state.windows)
      const missing = []
      for (const { app } of layout.windows) {
        const running = state.windows.some((one) => same(one.app, app))
        if (app !== '' && !running && !missing.some((one) => same(one, app))) missing.push(app)
      }

      const results = await apply(matches.map((one) => restoreOp(one, layout.monitors, state.monitors)), signal)
      let opened = []
      let unopened = []
      if (openThem === true && missing.length > 0) {
        const taken = new Set(matches.map((one) => one.window.id))
        const later = await openMissing(layout, missing, taken, signal)
        ;({ opened, unopened } = later)
        results.push(...(await apply(later.matches.map((one) => restoreOp(one, layout.monitors, later.monitors)), signal)))
      }

      const placed = results.filter((one) => one.ok).length
      const refused = results.filter((one) => !one.ok).map((one) => one.why).filter(Boolean)
      const left = layout.windows.length - placed
      const said = [`Put back ${String(placed)} of ${plural(layout.windows.length, 'window')} from “${String(row.name)}”.`]
      if (opened.length > 0) said.push(`Opened: ${opened.join(', ')}.`)
      if (missing.length > 0 && openThem !== true) said.push(`Not running: ${missing.join(', ')}. Nothing was opened.`)
      if (unopened.length > 0) said.push(`Could not open: ${unopened.join(', ')}.`)
      if (refused.length > 0) said.push(`Not moved: ${[...new Set(refused)].join(' ')}`)
      if (left > refused.length) said.push(`${plural(left - refused.length, 'saved window')} had no open window to use.`)
      return { placed, missing, text: said.join(' ') }
    },

    /** Ask an app to quit; end it by force only when `force` is exactly true. */
    async quit({ app: value, force } = {}, signal) {
      const app = String(value ?? '').trim().replace(/\.(exe|app)$/i, '')
      if (app === '' || app.length > 120) throw new Error('Say which app to quit, by the name the window list gives it.')
      const forced = force === true
      if (forced && PROTECTED.has(app.toLowerCase())) {
        throw new Error(`${app} is part of the system, so it is not force-quit.`)
      }
      const result = await backend.quit({ app, force: forced, spare, waitMs: QUIT_WAIT_MS }, signal)
      if (result.found === 0 && !result.windows) {
        throw new Error(`Nothing called “${app}” is running. The window list gives the names of open apps.`)
      }
      if (forced) {
        if (result.running > 0) throw new Error(`I could not end ${app}. It may be running as administrator.`)
        return `Force-quit ${app}. Anything unsaved in it is lost.`
      }
      if (result.open > 0) {
        return `Asked ${app} to quit. ${plural(result.open, 'window')} still open, probably asking about unsaved work.`
      }
      if (result.running === 0) return `${app} has quit.`
      if (result.windows === null) return `Asked ${app} to quit. It is still running, perhaps asking about unsaved work.`
      if (result.windows === 0) {
        return `${app} has no window to close and is still running in the background. Only a force quit would end it.`
      }
      return `Closed the windows of ${app}. It is still running in the background.`
    },
  }
}
