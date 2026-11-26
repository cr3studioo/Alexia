// SPDX-License-Identifier: AGPL-3.0-only

/**
 * **The overlay process: started when something is first drawn, gone a minute after nothing is.**
 *
 * One long-lived helper owns the transparent window; this end sends it one JSON object per line
 * and it answers each with one:
 *
 * - `{id, cmd:'draw', shapes, ttl_ms}` — the shapes come down again after `ttl_ms`
 * - `{id, cmd:'clear'}` — everything drawn, her cursor included
 * - `{id, cmd:'cursor', label, path:[[x,y]…], step_ms, hide_ms}` — her cursor follows `path`
 * - `{cmd:'quit'}`
 *
 * back: `{ready:true}` once its window is up, then `{id, ok:true}` or `{id, ok:false, error}`.
 *
 * The helper keeps the short clocks (a shape's time, the cursor's three seconds), because it is
 * the one drawing. This end keeps the long one: when to let the process go.
 */

/** How long the overlay stays running with nothing on screen. */
export const IDLE_MS = 60_000

/** Her cursor is hidden this long after it was last moved. */
export const HIDE_MS = 3_000

/** How long her cursor takes to reach where it is going, and how often it moves on the way. */
export const GLIDE_MS = 150
export const STEP_MS = 15

/** The longest an answer is waited for: the first one includes starting the helper on a slow machine. */
export const REPLY_MS = 30_000

/** How long a helper told to quit is given before it is killed. */
export const QUIT_MS = 10_000

/**
 * Where her cursor is every {@link STEP_MS} on its way, both ends included: slow, fast, slow.
 * With nowhere to come from it is simply there.
 */
export function glide(from, to) {
  if (!from || (from[0] === to[0] && from[1] === to[1])) return [to]
  const steps = Math.round(GLIDE_MS / STEP_MS)
  return Array.from({ length: steps + 1 }, (_, step) => {
    const t = step / steps
    const eased = t * t * (3 - 2 * t)
    return [0, 1].map((axis) => Math.round(from[axis] + (to[axis] - from[axis]) * eased))
  })
}

/**
 * A command as one line of plain ASCII. Everything else is written `\uXXXX`, so what the helper
 * reads is the same in any code page and no chunk of it can split a character.
 */
export const commandLine = (command) =>
  JSON.stringify(command).replace(/[\u007f-￿]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)

const clock = {
  now: () => Date.now(),
  set(fn, ms) {
    const timer = setTimeout(fn, ms)
    timer.unref?.()
    return timer
  },
  clear: (timer) => clearTimeout(timer),
}

/**
 * The overlay, over a `backend` (`{ command, args }`) and the thing that starts it:
 * `start(command, args, { onLine })` → `{ send(line), close(), kill(), exit }`.
 * `timers` is the clock (`now`, `set`, `clear`), faked in tests. `warn` is told why a helper
 * failed, never what was being drawn.
 */
export function createInk({ backend, start, timers = clock, warn = () => {} }) {
  /** The helper in use, if one is. */
  let live
  /** Where her cursor was last sent, which is where the next glide starts. */
  let cursorAt
  let next = 1

  function open() {
    const helper = { waiting: new Map(), shapesUntil: 0, cursorUntil: 0, idle: undefined, ready: undefined, gone: false }
    helper.child = start(backend.command, backend.args, { onLine: (line) => heard(helper, line) })
    helper.child.exit.then(({ code, said } = {}) => {
      helper.gone = true
      timers.clear(helper.quitting)
      if (helper !== live) return
      if (!helper.ready) warn(`the overlay did not start (exit ${String(code)}${said ? `: ${said}` : ''})`)
      else if (helper.waiting.size > 0) warn(`the overlay stopped (exit ${String(code)})`)
      drop(helper, new Error('the overlay stopped'))
    })
    live = helper
    return helper
  }

  function heard(helper, line) {
    let said
    try {
      said = JSON.parse(line)
    } catch {
      return // Something a system library printed; not an answer.
    }
    if (said?.ready === true) {
      helper.ready = said
      return
    }
    const one = helper.waiting.get(said?.id)
    if (!one) return
    helper.waiting.delete(said.id)
    timers.clear(one.timer)
    if (said.ok === true) {
      one.drawn(helper, timers.now())
      one.resolve()
    } else {
      warn(`the overlay could not carry out a command (${String(said.error)})`)
      one.reject(new Error('the overlay refused'))
    }
    rest(helper)
  }

  /** With nothing owed, start the clock that lets the helper go once the screen has been empty long enough. */
  function rest(helper) {
    timers.clear(helper.idle)
    if (helper !== live || helper.waiting.size > 0) return
    const now = timers.now()
    const empty = Math.max(now, helper.shapesUntil, helper.cursorUntil)
    helper.idle = timers.set(() => quit(helper), empty - now + IDLE_MS)
  }

  /** Ask a helper to leave, and make it if it does not. */
  function quit(helper) {
    if (helper === live) live = undefined
    timers.clear(helper.idle)
    if (helper.gone) return
    helper.child.send(commandLine({ cmd: 'quit' }))
    helper.child.close()
    helper.quitting = timers.set(() => helper.child.kill(), QUIT_MS)
  }

  /** A helper that failed: every caller still waiting is told, and the next call starts another. */
  function drop(helper, error) {
    if (helper === live) live = undefined
    timers.clear(helper.idle)
    for (const one of helper.waiting.values()) {
      timers.clear(one.timer)
      one.reject(error)
    }
    helper.waiting.clear()
    if (!helper.gone) helper.child.kill()
  }

  /** Send one command. `drawn` records what is on screen once the helper says it did it. */
  function send(command, drawn) {
    const helper = live ?? open()
    timers.clear(helper.idle)
    const id = next++
    return new Promise((resolve, reject) => {
      const timer = timers.set(() => {
        warn('the overlay did not answer in time')
        drop(helper, new Error('the overlay did not answer'))
      }, REPLY_MS)
      helper.waiting.set(id, { resolve, reject, timer, drawn })
      helper.child.send(commandLine({ id, ...command }))
    })
  }

  return {
    async draw({ shapes, ttlMs }) {
      await send({ cmd: 'draw', shapes, ttl_ms: ttlMs }, (helper, now) => {
        helper.shapesUntil = Math.max(helper.shapesUntil, now + ttlMs)
      })
      return shapes.length
    },

    /** With no helper running there is nothing on screen, so none is started to say so. */
    async clear() {
      if (!live) return
      await send({ cmd: 'clear' }, (helper, now) => {
        helper.shapesUntil = now
        helper.cursorUntil = now
      })
    },

    async cursor({ x, y, label }) {
      const path = glide(cursorAt, [x, y])
      cursorAt = [x, y]
      await send({ cmd: 'cursor', label, path, step_ms: STEP_MS, hide_ms: HIDE_MS }, (helper, now) => {
        helper.cursorUntil = now + HIDE_MS
      })
    },

    /** What the running helper said about itself when it started, or undefined with none running. */
    running: () => live?.ready,

    /** Let the helper go now. */
    close() {
      const helper = live
      if (!helper) return
      quit(helper)
      for (const one of helper.waiting.values()) {
        timers.clear(one.timer)
        one.reject(new Error('the overlay was closed'))
      }
      helper.waiting.clear()
    },
  }
}
