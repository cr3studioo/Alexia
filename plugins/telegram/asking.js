// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto'

/**
 * A question with buttons on it, and the token that makes the buttons safe (M7-5).
 *
 * **Telegram caps `callback_data` at 64 bytes**, and the interesting decision is what to do
 * about it. Shortening the action to fit is a length check somebody has to remember, and a
 * permission question is exactly the place a forgotten one turns into a silently truncated
 * answer. So **the action never travels**: what goes on the button is an opaque token of a
 * fixed size, and what it stands for is looked up here.
 *
 * The limit cannot be exceeded whatever the action says, which is the point — it is a
 * property of the shape rather than something a test has to keep checking. The test checks
 * it anyway, with an action long enough to prove it.
 *
 * **In memory, and gone on restart.** A pending question outlives nothing: the loop that was
 * waiting for it is gone too, and a token that survived would be a button answering a
 * question nobody is listening for.
 */

/** Eight hex characters. Room to spare inside 64, and no two the same in any real session. */
const token = () => randomUUID().replaceAll('-', '').slice(0, 8)

export class Asking {
  #open = new Map()

  /**
   * Register a question. Returns the buttons to put on the message and a promise that
   * settles when one is pressed — or when `close` is called, which is what a restart is.
   */
  ask(options) {
    const id = token()
    const buttons = options.map((label, at) => ({ label, data: `${id}.${String(at)}` }))
    const answer = new Promise((resolve) => {
      this.#open.set(id, { options, resolve })
    })
    return { id, buttons, answer }
  }

  /** A press. Returns what was chosen, or undefined for a token nobody is waiting on. */
  press(data) {
    const [id, at] = String(data ?? '').split('.')
    const held = this.#open.get(id)
    if (!held) return undefined
    this.#open.delete(id)
    const chosen = held.options[Number(at)]
    held.resolve(chosen)
    return chosen
  }

  /** Nobody is listening any more. Every open question settles as unanswered. */
  close() {
    for (const held of this.#open.values()) held.resolve(undefined)
    this.#open.clear()
  }

  get waiting() {
    return this.#open.size
  }
}
