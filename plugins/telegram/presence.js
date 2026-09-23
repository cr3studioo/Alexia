// SPDX-License-Identifier: AGPL-3.0-only

/**
 * *Typing…* for as long as an answer is being made, and the right word for it (D192).
 *
 * **Telegram's chat action is not a switch.** It shows for five seconds at most, or until the
 * bot's next message arrives, whichever is first — so an indicator that has to last a
 * two-minute task is one that is sent again and again, and one sent every five seconds is one
 * that blinks off whenever a request is slow. `EVERY` is four: a second of room, and one small
 * request every four seconds only while somebody is waiting for an answer.
 *
 * **What it says follows what is coming.** A picture is *sending photo…*, a voice reply is
 * *recording voice…* and then *sending voice…* — `as()` switches it, so the phone says the
 * true thing about the next few seconds rather than *typing* over an upload.
 *
 * **Quiet under a question.** While a permission question waits for a press, the next move is
 * the person's, and *typing…* under the buttons says the opposite. `pause()` stops it and
 * `resume()` starts it again the moment the answer is in. Pauses count, so two questions open
 * at once need two answers before it comes back.
 *
 * **Cosmetic, so it cannot cost anything.** A send that throws or rejects is swallowed, and
 * the first one is logged — once, because a chat that has blocked the bot fails on every tick
 * and the log is not the place to find that out forty times. Nothing here throws, and nothing
 * here is awaited by the answer it sits beside.
 *
 * The send and the interval are passed in, the way `asking.js` keeps Telegram out of its
 * state, so the test is fake timers and a list rather than a bot.
 */

/** Under Telegram's five seconds, with one to spare for a slow request. */
export const EVERY = 4000

export class Presence {
  #act
  #every
  #warn
  #warned = false
  /**
   * `String(chatId)` → `{ chatId, action, paused, timer }`. Keyed as a string because a chat
   * id arrives as a number from a message and as a string from storage, and it is one chat.
   */
  #chats = new Map()

  /**
   * `act(chatId, action)` sends one chat action and may return a promise. `warn(error)` hears
   * about the first time that fails, and only the first.
   */
  constructor(act, every = EVERY, warn = () => {}) {
    this.#act = act
    this.#every = every
    this.#warn = warn
  }

  /**
   * Show `action` in this chat now and keep it showing. A chat already showing one just
   * changes what it says, on the next tick — one chat is one heartbeat, never two.
   */
  start(chatId, action = 'typing') {
    const held = this.#chats.get(String(chatId))
    if (held) {
      held.action = action
      return
    }
    const fresh = { chatId, action, paused: 0, timer: undefined }
    this.#chats.set(String(chatId), fresh)
    this.#beat(fresh)
  }

  /**
   * Say something else — `upload_photo`, `record_voice` — from now on. Sent at once unless
   * paused. A chat nobody started is left alone: a file sent from outside an answer has nothing
   * to keep alive, and a timer started here would have nobody to stop it.
   */
  as(chatId, action) {
    const held = this.#chats.get(String(chatId))
    if (!held) return
    held.action = action
    if (held.paused === 0) this.#beat(held)
  }

  /** No tick goes out until the matching `resume`. */
  pause(chatId) {
    const held = this.#chats.get(String(chatId))
    if (!held) return
    held.paused += 1
    this.#quiet(held)
  }

  /** The last open pause is over: sent at once, and on every tick after. */
  resume(chatId) {
    const held = this.#chats.get(String(chatId))
    if (!held || held.paused === 0) return
    held.paused -= 1
    if (held.paused === 0) this.#beat(held)
  }

  /** Done in this chat. Safe to call twice, and on a chat that never started. */
  stop(chatId) {
    const held = this.#chats.get(String(chatId))
    if (!held) return
    this.#quiet(held)
    this.#chats.delete(String(chatId))
  }

  /** Every chat at once — the connection they were all being sent over is going away. */
  stopAll() {
    for (const held of this.#chats.values()) this.#quiet(held)
    this.#chats.clear()
  }

  /** Send now, then every `EVERY` from now — so a switch leaves no tick about to fire twice. */
  #beat(held) {
    this.#quiet(held)
    this.#send(held)
    const timer = setInterval(() => this.#send(held), this.#every)
    // A heartbeat is never the reason the process is still running.
    timer.unref?.()
    held.timer = timer
  }

  #quiet(held) {
    if (held.timer !== undefined) clearInterval(held.timer)
    held.timer = undefined
  }

  #send(held) {
    try {
      Promise.resolve(this.#act(held.chatId, held.action)).catch((error) => this.#failed(error))
    } catch (error) {
      this.#failed(error)
    }
  }

  #failed(error) {
    if (this.#warned) return
    this.#warned = true
    try {
      this.#warn(error)
    } catch {
      /* the log is cosmetic here too */
    }
  }
}
