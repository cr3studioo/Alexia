// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The point to start polling from after a crash (D194).
 *
 * **Telegram's offset is an acknowledgement, and it is one-way.** Asking `getUpdates` for
 * `last + 1` is what tells Telegram the batch before it was dealt with, and the moment it
 * hears that it forgets those updates for good. The loop has always advanced its own offset
 * the instant an update arrived, which is right for the loop — a message being answered must
 * not be handed out a second time in the next poll, ten seconds later, while the first answer
 * is still being written.
 *
 * What that leaves is the gap nobody had covered: **a crash between answering a message and
 * the next poll**. The offset the loop was holding lived in a variable, so a plugin that came
 * back up asked Telegram for everything it still had — which is the batch that was just
 * answered — and answered all of it again. Two identical replies for one question, and for a
 * message that ran a tool, the tool ran twice.
 *
 * So the number that survives a restart is not the one the loop is using. It is **the oldest
 * update that has not finished yet**, and when nothing is outstanding, one past the newest
 * that has. Restarting there replays only what was genuinely unfinished.
 *
 * **What that costs, said plainly:** a message still waiting its turn in the line when the
 * process dies is lost, not answered twice — it was never started, nothing was said about it,
 * and the person can send it again. That is the trade this makes on purpose, because the other
 * failure is Alexia doing something twice that she was asked to do once.
 *
 * Pure, and holding nothing but numbers, so the rule can be checked without a bot or a clock.
 */
export class Acks {
  /** The update ids that have been taken in and are not finished. */
  #open = new Set()
  /** The highest id ever taken in, which is what *one past the newest* counts from. */
  #newest

  /** An update has arrived and its work has started (or been queued). */
  received(id) {
    if (!Number.isInteger(id)) return
    this.#open.add(id)
    if (this.#newest === undefined || id > this.#newest) this.#newest = id
  }

  /**
   * That update is finished — answered, replied to, or dropped by `/stop`, all of which mean
   * nobody is coming back to it. Returns the offset to save now.
   */
  done(id) {
    this.#open.delete(id)
    return this.mark
  }

  /**
   * The restart point as it stands: the oldest unfinished update, or one past the newest when
   * everything is done. `undefined` before anything has arrived, because there is nothing yet
   * to say and an offset of zero would mean *give me the backlog*.
   */
  get mark() {
    if (this.#newest === undefined) return undefined
    let oldest
    for (const id of this.#open) if (oldest === undefined || id < oldest) oldest = id
    return oldest ?? this.#newest + 1
  }

  /** How many updates are still in flight. */
  get open() {
    return this.#open.size
  }
}
