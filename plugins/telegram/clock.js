// SPDX-License-Identifier: AGPL-3.0-only
import { TRIES } from './reminders.js'

/**
 * The thirty-second tick that delivers reminders, and the three ways it used to eat them.
 *
 * `reminders.js` decides *which rows are due*; this decides *what happens to one*, which is a
 * different kind of question and a much easier one to get wrong — every failure here is
 * silent, arrives hours later, and looks to the person like Alexia simply forgot.
 *
 * **One tick at a time.** There was no guard, and `api.js` sets no timeout on a fetch, so a
 * slow link meant the next tick read the same due rows the current one was still sending: the
 * reminder arrives twice, and so does the morning summary, whose *sent today* mark is written
 * after an await like everything else. `busy` is the whole fix, and it is why this is a class
 * rather than a function.
 *
 * **One bad row must not stop the rest.** A send that throws used to reject the whole tick
 * before the row was marked — so a chat that blocked the bot left a row due forever, retried
 * every thirty seconds, with every later reminder stuck behind it and the summary never
 * reached. Each row is now its own try/catch, and each failure counts against `TRIES` before
 * the row is given up on.
 *
 * **And the two halves are independent.** A database that cannot be read must not cost the
 * morning summary, and a summary that throws must not cost the reminders — so they fail apart
 * rather than together.
 *
 * Everything it touches is injected, the way `Presence` and `Draft` take their sends: storage
 * and Telegram stay in `index.js`, and what is left here is a rule a test can hold without a
 * database, a bot token or a real clock.
 */
export class Clock {
  #due
  #send
  #done
  #retry
  #summary
  #log
  #busy = false

  /**
   * `due(now)` → the rows to deliver. `send(row, now)` puts one on a phone and throws if it
   * could not. `done(row)` is *finished with* — delivered, or given up on. `retry(row, tries)`
   * writes the count back. `summary(now)` is the morning summary, run after the rows.
   */
  constructor({ due, send, done, retry, summary = async () => {}, log = () => {} }) {
    this.#due = due
    this.#send = send
    this.#done = done
    this.#retry = retry
    this.#summary = summary
    this.#log = log
  }

  /** Whether a tick is running. A second one does nothing while this is true. */
  get busy() {
    return this.#busy
  }

  /**
   * One tick. `true` if it ran, `false` if it was skipped because the previous one had not
   * finished — which is a normal thing to happen on a slow link and not a failure.
   *
   * It never throws: there is nothing above it but a `setInterval`, and an interval whose
   * callback rejects is an unhandled rejection rather than a message to anybody.
   */
  async tick(now = Date.now()) {
    if (this.#busy) return false
    this.#busy = true
    try {
      try {
        for (const row of await this.#due(now)) {
          // Per row, so that a storage write failing on one — not just the send — leaves the
          // rest of the batch alone.
          try {
            await this.#one(row, now)
          } catch (error) {
            this.#log('a reminder could not be dealt with', error)
          }
        }
      } catch (error) {
        this.#log('could not read the reminders that are due', error)
      }
      try {
        await this.#summary(now)
      } catch (error) {
        this.#log('could not send the morning summary', error)
      }
    } finally {
      this.#busy = false
    }
    return true
  }

  /**
   * Deliver one row, or count the failure against it.
   *
   * **Sent, then finished with** — in that order, and not the other way round: the gap between
   * them can lose a reminder to a duplicate, and the reverse gap loses it entirely. A duplicate
   * is a nuisance; a reminder that never arrives is the thing somebody trusted this with.
   */
  async #one(row, now) {
    try {
      await this.#send(row, now)
    } catch (error) {
      const tries = (Number(row.tries) || 0) + 1
      if (tries < TRIES) return this.#retry(row, tries)
      // Nowhere to say so: the reason this is being dropped is that its chat cannot be
      // reached. The log is the only place left, and one line in it is the whole report.
      this.#log(`a reminder could not be delivered after ${String(TRIES)} tries, so it was dropped`, error)
      return this.#done(row)
    }
    return this.#done(row)
  }
}
