// SPDX-License-Identifier: AGPL-3.0-only

/**
 * **Two Alexias, one bot.**
 *
 * Telegram hands a bot's messages to one `getUpdates` at a time. When a second one starts —
 * Alexia on another Mac with the same token, or a test copy of her on this one — Telegram ends
 * the older poll with `409 Conflict`, and the two take turns stealing it from each other for as
 * long as both run. The loop used to read that as a network blip and retry within a second,
 * forever, while the screen still said *Listening*: two copies fighting, each answering some of
 * the messages, neither saying so.
 *
 * So a clash is its own case. The copy that is told to stop, stops — for {@link CLASH_WAIT} —
 * and says why in a sentence on the Telegram screen. Then it asks once more. If the other copy
 * has gone, that ask is simply the next poll and she is back. If it is still there, the ask
 * takes the bot back and the *other* copy is the one told to stop, so the two hand the bot
 * back and forth every few minutes rather than every second — and at every moment exactly one
 * of them is listening. The *Try again* button on the screen ends the wait at once.
 *
 * The wait is here rather than in the loop so that the test is fake timers and a promise.
 */

/** How long a paused copy leaves the bot alone before asking for it again. */
export const CLASH_WAIT = 5 * 60_000

/** The state line while paused. Plain, because the person reading it did nothing wrong. */
export const PAUSED = '▲ Paused — another copy of Alexia is using this bot. She will try again in a few minutes.'

/**
 * Whether a failed poll was another copy polling the same bot.
 *
 * Only a `409` that is not about a webhook. Telegram answers `409` for that too — *can't use
 * getUpdates method while webhook is active* — and that is somebody's setup, not a second
 * Alexia, so it goes down the ordinary retry path with its own sentence in the log.
 */
export function clashed(error) {
  return error?.status === 409 && !/webhook/i.test(String(error?.message ?? ''))
}

/** A wait that the *Try again* button, or the loop being stopped, can cut short. */
export class Pause {
  #wake

  /** True while a copy is standing aside. */
  get waiting() {
    return this.#wake !== undefined
  }

  /** Resolves after `ms`, on {@link wake}, or when `signal` aborts — whichever is first. */
  wait(ms, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve()
      const done = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', done)
        if (this.#wake === done) this.#wake = undefined
        resolve()
      }
      const timer = setTimeout(done, ms)
      signal?.addEventListener('abort', done, { once: true })
      this.#wake = done
    })
  }

  /** End the wait now. Returns whether there was one to end. */
  wake() {
    const wake = this.#wake
    wake?.()
    return wake !== undefined
  }
}
