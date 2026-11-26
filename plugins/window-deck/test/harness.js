// SPDX-License-Identifier: AGPL-3.0-only
// These tests run under `node --test` and under the repo's vitest alike: one `test`, and node's own assert.
const runner = process.env.VITEST ? await import('vitest') : await import('node:test')
export const test = runner.test
export { default as assert } from 'node:assert/strict'

/** A spawn on a slow, loaded machine. Both runners take it as `test(name, fn)` followed by nothing else. */
export const SLOW = 90_000

/** `test` with a long time limit, in the shape each runner takes it. */
export const slowTest = (name, fn) =>
  process.env.VITEST ? test(name, fn, SLOW) : test(name, { timeout: SLOW }, fn)

const row = (id, app, title, x, y, w, h, more = {}) => ({
  id, app, title, x, y, w, h, minimized: false, maximized: false, path: `/apps/${app}`, aumid: '', ...more,
})
export { row }

/** One 1920×1080 screen with a 48px taskbar, and a second one to its right. */
export const SCREENS = [
  { x: 0, y: 0, w: 1920, h: 1080, work: { x: 0, y: 0, w: 1920, h: 1032 }, primary: true },
  { x: 1920, y: 0, w: 2560, h: 1440, work: { x: 1920, y: 0, w: 2560, h: 1400 }, primary: false },
]

/**
 * The runner, faked: it stands where PowerShell or osascript would, answers the same JSON from a
 * desktop held in memory, and carries out what it is asked on that desktop. `asked` keeps every
 * question. `launches` says which windows appear once an app is opened.
 */
export function fakeDesktop({ windows = [], monitors = SCREENS, launches = {}, stubborn = [] } = {}) {
  const desk = { windows: windows.map((one) => ({ ...one })), monitors, asked: [], scripts: [] }
  const answer = {
    list: () => ({ windows: desk.windows, monitors: desk.monitors }),
    apply: ({ ops }) => ({
      results: ops.map((op) => {
        const window = desk.windows.find((one) => one.id === op.id)
        if (!window) return { id: op.id, ok: false, gone: true, why: 'That window is gone.' }
        if (op.rect) Object.assign(window, { minimized: false, maximized: false }, op.rect)
        let unchanged = false
        if (op.then === 'minimize') window.minimized = true
        if (op.then === 'maximize') {
          const screen = desk.monitors.find((m) => window.x >= m.x && window.x < m.x + m.w) ?? desk.monitors[0]
          Object.assign(window, screen.work, { minimized: false, maximized: true })
        }
        if (op.then === 'restore') {
          unchanged = !window.minimized && !window.maximized
          Object.assign(window, { minimized: false, maximized: false })
        }
        // A stubborn window stays: it is asking about unsaved work.
        const gone = op.then === 'close' && !stubborn.includes(window.id)
        if (gone) desk.windows = desk.windows.filter((one) => one !== window)
        return { id: op.id, ok: true, why: '', gone, unchanged, ...(!gone && { window: { ...window } }) }
      }),
    }),
    quit: ({ app, force }) => {
      const mine = () => desk.windows.filter((one) => one.app.toLowerCase() === app.toLowerCase())
      const before = mine().length
      desk.windows = desk.windows.filter((one) => !mine().includes(one) || (!force && stubborn.includes(one.id)))
      return { found: before > 0 ? 1 : 0, windows: before, open: mine().length, running: mine().length > 0 ? 1 : 0 }
    },
    open: ({ app }) => {
      if (!launches[app]) return { refused: `Could not find ${app}.` }
      desk.windows.push(...launches[app].map((one) => ({ ...one })))
      return { opened: true }
    },
  }
  desk.run = async (script, question) => {
    desk.scripts.push(script)
    desk.asked.push(structuredClone(question))
    return JSON.stringify(answer[question.do](question))
  }
  return desk
}

/** The plugin's `layouts` table, in memory, answering the calls the deck makes. */
export function fakeStorage() {
  const tables = new Map()
  const rows = (table) => tables.get(table) ?? tables.set(table, []).get(table)
  const matches = (one, where = {}) => Object.entries(where).every(([key, value]) => one[key] === value)
  return {
    rows,
    select: async (table, query = {}) => rows(table).filter((one) => matches(one, query.where)).map((one) => ({ ...one })),
    insert: async (table, entry) => rows(table).push({ ...entry }),
    update: async (table, set, where) => {
      const found = rows(table).filter((one) => matches(one, where))
      for (const one of found) Object.assign(one, set)
      return found.length
    },
  }
}

/** A clock that only moves when somebody sleeps, so waiting costs a test nothing. */
export function fakeTime() {
  let at = 1_000_000
  return { now: () => at, sleep: async (ms) => void (at += ms) }
}
