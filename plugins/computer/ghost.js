// SPDX-License-Identifier: AGPL-3.0-only

/**
 * **Her own cursor: where she is about to act, shown on screen** (PC-02).
 *
 * The owner's pointer stays theirs; what marks the spot Alexia acts on is `cursor.show`, which
 * some other plugin may provide (screen ink, P4-26). This plugin never names that plugin: it asks
 * core whether anything answers the capability (`alexia/answers`) and, when something does, calls
 * it through `alexia/capability/call`. Nothing answers — no call. The owner turned it off — no
 * call.
 *
 * **It is a nicety, and it is timed like one.** Every `show` returns within {@link WAIT_MS},
 * whatever the provider does: an action is never held up by a slow cursor. What the provider is
 * still doing after that is let go, and its answer, late or failed, is dropped. Whether anything
 * answers is asked at most once every {@link ASK_EVERY_MS}, because a provider being installed
 * or removed is a rare event and asking is a round trip.
 */

/** The longest `show` is ever waited for. */
export const WAIT_MS = 200

/** How long an `alexia/answers` reply is believed. */
export const ASK_EVERY_MS = 60_000

/** The capability, as `docs/spec/capabilities.md` names it. */
export const CAP = 'cursor.show'

/**
 * A `show` bound to this plugin's ways of asking.
 *
 * - `answers(cap)` → `{ answers: boolean }` (`alexia.answers`)
 * - `capability(cap, args)` → the provider's result (`alexia.capability`)
 * - `settings()` → this plugin's settings; `show_cursor: false` turns it off (default on)
 *
 * `show(x, y)` resolves to what happened, for logs and tests: `shown`, `off` (setting),
 * `none` (no provider), `slow` (let go at {@link WAIT_MS}), or `failed`. It never rejects.
 */
export function ghost({ answers, capability, settings, now = Date.now, wait = WAIT_MS, every = ASK_EVERY_MS }) {
  let known

  async function provided() {
    const at = now()
    if (known && at - known.at < every) return known.yes
    // Asked, and the answer kept, even while it is in flight: two shows in a row ask once.
    const asking = Promise.resolve()
      .then(() => answers(CAP))
      .then((said) => said?.answers === true)
      .catch(() => false)
    known = { at, yes: asking }
    return asking
  }

  async function attempt(x, y) {
    const s = await Promise.resolve()
      .then(() => settings())
      .catch(() => ({}))
    if (s?.show_cursor === false) return 'off'
    if (!(await provided())) return 'none'
    await capability(CAP, { x: Math.round(x), y: Math.round(y), label: 'Alexia' })
    return 'shown'
  }

  return {
    show(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return Promise.resolve('none')
      let timer
      const late = new Promise((resolve) => {
        timer = setTimeout(() => resolve('slow'), wait)
        timer.unref?.()
      })
      const done = attempt(x, y).catch(() => 'failed')
      return Promise.race([done, late]).finally(() => clearTimeout(timer))
    },
    /** Forget the provider answer, so the next show asks again. */
    forget() {
      known = undefined
    },
  }
}

/** What a how is called in a sentence, when it failed. */
const SAID = { invoke: 'pressing it', toggle: 'ticking it', select: 'choosing it', expand: 'opening it', set_value: 'setting its value' }

/**
 * **Accessibility first, the mouse only when nothing else fits** (PC-01), with her cursor shown
 * wherever she acts. Kept here, beside the cursor, rather than in `index.js`, so the one rule
 * that decides whether the real pointer is used can be tested without starting the plugin.
 *
 * - `act(element, how, signal)` is `desktop.act`: the patterns (UI Automation on Windows, AX on a
 *   Mac), so no pointer moves and nothing is typed.
 * - `clickBack(x, y, button, double, signal, pid)` clicks with the real pointer and puts it back.
 * - `show(x, y)` is her cursor; `log` takes `info` and `warn`.
 *
 * Returns `accessibly(element, how, signal, { pid, named, then })`. The mouse is used **only**
 * when nothing was attempted: the control has none of the patterns asked for, or nothing was
 * found under a point the caller gave. Then the pointer clicks and goes back, and `then` (typing,
 * for a value) runs after. A pattern call that was made and threw (`failed`) is an error: the
 * control may already have been pressed, and a mouse click after it could press it twice. A
 * control that is not there, is greyed out, or has no place on screen is an error too.
 *
 * Logged by which way it went and never by what the control is called or what the app said:
 * the log is not a transcript of somebody's screen.
 */
export function actFirst({ act, clickBack, show, log }) {
  return async function accessibly(element, how, signal, { pid, named = 'that', then } = {}) {
    const done = await act(element, how, signal)
    if (done.done) {
      log.info(`computer: acted through accessibility (${String(done.via)}, ${String(done.how)})`)
      if (Number.isFinite(done.x) && Number.isFinite(done.y)) await show(done.x, done.y)
      return { ...done, way: 'accessibility' }
    }
    if (done.failed) {
      log.warn(`computer: an accessibility action was tried and failed (${String(done.failed)}); not clicking as well`)
      throw new Error(
        `“${named}”: ${SAID[done.failed] ?? 'acting on it'} through accessibility failed (${String(done.error ?? 'it threw')}). ` +
          'It may or may not have happened, so I did not click it with the mouse as well. Look at the screen before trying again.',
      )
    }
    // A point the caller gave is where the click goes, whatever control is under it (that
    // control's own middle may be elsewhere in a large pane); a named control's is its own.
    const at =
      !element.match && Number.isFinite(element.x) && Number.isFinite(element.y) ? { x: element.x, y: element.y }
      : Number.isFinite(done.x) && Number.isFinite(done.y) ? { x: done.x, y: done.y }
      : undefined
    if (!done.found && !at) throw new Error(`There is no “${named}” on screen.`)
    if (done.disabled) throw new Error(`“${named}” is on screen and greyed out, so nothing was done.`)
    if (!at) throw new Error(`“${named}” is on screen but offers no way to act on it and no place to click, so nothing was done.`)
    await show(at.x, at.y)
    await clickBack(at.x, at.y, 'left', false, signal, pid)
    if (then) await then()
    log.info('computer: no accessibility pattern fitted; clicked with the mouse and put the pointer back')
    return { ...done, ...at, done: false, way: 'mouse' }
  }
}
