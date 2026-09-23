// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The messages waiting to be answered, one behind the other (D192).
 *
 * **The loop that hears them must never wait for one.** The poll loop used to answer each
 * message where it stood — `await answer(…)` — and that was the whole of a bug nobody could
 * see from the window: a task that needed permission sent its buttons and waited for a press,
 * and a press only ever arrives through `getUpdates`, the call the loop could not make until
 * the answer it was waiting on had finished. The yes from the phone was never read, and core's
 * 120 seconds read the silence as no. So the loop hands each message here and goes straight
 * back to listening.
 *
 * **One at a time, in the order they came, and that is not a limitation.** Core runs one task
 * at a time and refuses a second while the first runs, and the chat a permission question
 * goes to is one variable, which is only right while one answer is being written. A second message sent mid-task waits its turn here rather than
 * being told Alexia *is already working on something* there.
 *
 * **A job that throws is its own problem.** It is logged and the next one starts, because a
 * line that stalls on its first bad message is a bot that answers nothing after it, and the
 * person on the other end has no way to know why.
 *
 * `clear()` is for `/stop`: what has not started is dropped, and what is running is left to
 * the thing that can actually end it — its own abort — rather than pulled out from under
 * itself.
 */
export class Line {
  #waiting = []
  #busy = false
  #log

  /** `log(error)` hears about a job that threw. The job's own sentence to the user is its job. */
  constructor(log = () => {}) {
    this.#log = log
  }

  /**
   * Queue `job` — an async function — behind everything already here.
   *
   * Returns a promise that never rejects: `true` once the job has run (thrown or not), `false`
   * if `clear()` dropped it before it started. The poll loop does not wait on it; a caller that
   * wants to know when a message is done — the offset that survives a crash, say — can.
   */
  push(job) {
    return new Promise((settle) => {
      this.#waiting.push({ job, settle })
      void this.#run()
    })
  }

  /** Drop every job that has not started. The running one finishes. Returns how many went. */
  clear() {
    const dropped = this.#waiting.splice(0)
    for (const { settle } of dropped) settle(false)
    return dropped.length
  }

  /** A job is running now. */
  get busy() {
    return this.#busy
  }

  /** How many are queued behind it. */
  get waiting() {
    return this.#waiting.length
  }

  async #run() {
    if (this.#busy) return
    this.#busy = true
    while (this.#waiting.length > 0) {
      const { job, settle } = this.#waiting.shift()
      try {
        await job()
      } catch (error) {
        try {
          this.#log(error)
        } catch {
          /* a log that throws is still not a reason for everything behind it to wait */
        }
      }
      settle(true)
    }
    this.#busy = false
  }
}
