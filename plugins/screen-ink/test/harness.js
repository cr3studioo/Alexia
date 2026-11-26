// SPDX-License-Identifier: AGPL-3.0-only
// These tests run under `node --test` and under the repo's vitest alike: one `test`, and node's own assert.
import { setImmediate } from 'node:timers/promises'

const runner = process.env.VITEST ? await import('vitest') : await import('node:test')
export const test = runner.test
export { default as assert } from 'node:assert/strict'

/** A spawn on a slow, loaded machine. */
export const SLOW = 90_000

/** `test` with a long time limit, in the shape each runner takes it. */
export const slowTest = (name, fn) =>
  process.env.VITEST ? test(name, fn, SLOW) : test(name, { timeout: SLOW }, fn)

/** A clock that moves only when told to. */
export function fakeClock() {
  let now = 1_000_000
  let last = 0
  const timers = new Map()
  return {
    now: () => now,
    set(fn, ms) {
      timers.set(++last, { at: now + ms, fn })
      return last
    },
    clear: (key) => void timers.delete(key),
    /** Move on, running what falls due on the way, in order. */
    async advance(ms) {
      const end = now + ms
      for (;;) {
        const [key, due] = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0] ?? []
        if (!due) break
        timers.delete(key)
        now = due.at
        due.fn()
        await settle()
      }
      now = end
      await settle()
    },
  }
}

/** Let everything already promised happen. */
export const settle = () => setImmediate()

/**
 * The overlay process, faked: it stands where PowerShell or osascript would. `started` holds one
 * entry per process, with every line written to it. It says it is ready and does what it is told,
 * unless `silent`, when the test answers (or not) by `say`. `stubborn` ones ignore being asked to quit.
 */
export function fakeOverlay({ silent = false, stubborn = false } = {}) {
  const started = []
  function start(command, args, { onLine }) {
    let ended
    const one = {
      command,
      args,
      written: [],
      closed: false,
      killed: false,
      exited: false,
      exit: new Promise((resolve) => (ended = resolve)),
      say: (answer) => onLine(typeof answer === 'string' ? answer : JSON.stringify(answer)),
      die(code = 1, said = '') {
        one.exited = true
        ended({ code, said })
      },
      send(line) {
        one.written.push(line)
        const sent = JSON.parse(line)
        if (sent.cmd === 'quit' && !stubborn) return one.die(0)
        if (!silent && sent.id !== undefined) one.say({ id: sent.id, ok: true })
      },
      close: () => void (one.closed = true),
      kill() {
        one.killed = true
        one.die(null)
      },
      /** What was written, read back. */
      commands: () => one.written.map((line) => JSON.parse(line)),
    }
    started.push(one)
    if (!silent) one.say({ ready: true })
    return one
  }
  return { start, started }
}

/** A stand-in for the SDK's plugin that keeps what `register` gives it. */
export function fakePlugin() {
  const tools = new Map()
  return { tools, tool: (name, config, handler) => tools.set(name, { config, handler }) }
}
