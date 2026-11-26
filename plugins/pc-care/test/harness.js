// SPDX-License-Identifier: AGPL-3.0-only
// These tests run under `node --test` and under the repo's vitest alike: one `test`, and node's own assert.
import { createCare } from '../care.js'
import { macosBackend } from '../macos.js'
import { createPower } from '../power.js'
import { registerTools } from '../tools.js'
import { windowsBackend } from '../windows.js'

const runner = process.env.VITEST ? await import('vitest') : await import('node:test')
export const test = runner.test
export { default as assert } from 'node:assert/strict'

/** A spawn, or a slow disk, on a loaded machine. */
export const SLOW = 180_000

/** `test` with a long time limit, in the shape each runner takes it. */
export const slowTest = (name, fn) =>
  process.env.VITEST ? test(name, fn, SLOW) : test(name, { timeout: SLOW }, fn)

/** A clock and its timers that only move when told to, so waiting costs a test nothing. */
export function fakeClock(start = 1_000_000) {
  let at = start
  let next = 0
  const waiting = new Map()
  return {
    waiting,
    now: () => at,
    timers: {
      set: (run, ms) => {
        next += 1
        waiting.set(next, { run, due: at + ms })
        return next
      },
      clear: (id) => void waiting.delete(id),
    },
    /** Move on by `ms` in one step, then run whatever has come due. */
    async advance(ms) {
      at += ms
      for (const [id, timer] of [...waiting]) {
        if (timer.due > at) continue
        waiting.delete(id)
        await timer.run()
      }
    },
  }
}

/**
 * The runner, faked: it stands where every program would be started, so **nothing real ever
 * runs** — least of all a power action. `calls` keeps each start; `answer` says what it printed.
 */
export function fakeRunner(answer = () => '') {
  const calls = []
  const run = async (file, args, options = {}) => {
    const question = options.input === undefined ? undefined : JSON.parse(options.input)
    const call = { file, args, options, question }
    calls.push(call)
    const out = await answer(call)
    return { stdout: typeof out === 'string' ? out : JSON.stringify(out), stderr: '' }
  }
  return { run, calls }
}

/** The tools as the plugin registers them, by name, and a way to call one as the host would. */
export function register(parts) {
  const tools = new Map()
  registerTools({ tool: (name, config, handler) => tools.set(name, { config, handler }) }, parts)
  const call = (name, args) => {
    const { config, handler } = tools.get(name)
    return config.inputSchema ? handler(args, { mcpReq: {} }) : handler({ mcpReq: {} })
  }
  return { tools, call }
}

/** The whole plugin over a faked runner, as Windows or as a Mac. */
export function ready({ platform = 'win32', answer, clock = fakeClock(), temp, home, ...mac } = {}) {
  const fake = fakeRunner(answer)
  const backend =
    platform === 'win32' ? windowsBackend({ run: fake.run }) : macosBackend({ run: fake.run, home, uid: 501, ...mac })
  const logged = []
  const parts = {
    care: createCare({ backend, temp, home, now: clock.now }),
    power: createPower({ backend, now: clock.now, timers: clock.timers, log: (text) => logged.push(text) }),
  }
  return { ...register(parts), calls: fake.calls, clock, logged }
}
