// SPDX-License-Identifier: AGPL-3.0-only
import { forRich } from './format.js'

/**
 * Streaming an answer into a Telegram draft, while it is still being written (#1).
 *
 * A draft is Telegram's own halfway point between silence and a finished message: an empty
 * one shows "Thinking…", a non-empty one shows the words so far, and either way it is
 * *ephemeral* — it lasts 30 seconds and then Telegram takes it down, which is why `open()`
 * starts a keep-alive that re-sends it well inside that window. The final answer still goes
 * out as an ordinary `sendRichMessage`, which is what actually replaces the draft; everything
 * here is what happens while the model is still talking.
 *
 * **At most one send per second.** A model can produce deltas far faster than that, and a
 * draft resent on every token is a draft resent so often Telegram would start dropping the
 * requests, not a smoother-looking answer. `add()` is a trailing-edge throttle for exactly
 * that reason: the latest text always goes out, but never more than once a `flushMs` window.
 *
 * **A draft that stops working turns itself off, once, for the rest of the session** — not
 * per answer. If both `sendMessageDraft` and `sendRichMessageDraft` are failing, they are
 * failing for a reason that will still be true on the next answer (an old client, a chat that
 * does not support drafts), and retrying every message is a retry that was never going to
 * succeed. `session` is the shared flag that remembers this across `Draft` instances, and
 * Phase 1's typing indicator is what still covers the chat once drafts are off.
 *
 * **Nothing here ever throws or rejects to the caller.** A draft is a nicety layered on top
 * of an answer that has to arrive regardless, so every send this class makes is caught
 * internally — the worst a failure does is turn drafts off, never fail the answer.
 */

/** At most one flush per this many milliseconds — the throttle `add()` enforces. */
export const FLUSH_MS = 1000

/** How often the keep-alive re-sends the current state. Well inside Telegram's 30 s expiry. */
export const KEEP_MS = 20_000

/** A random, non-zero 31-bit integer — Telegram's own `draft_id` shape. */
export function draftId() {
  return 1 + Math.floor(Math.random() * (2 ** 31 - 1))
}

export class Draft {
  #plain
  #rich
  #session
  #flushMs
  #keepMs
  #log
  #id = draftId()
  #text = ''
  #status = ''
  #opened = false
  #richOk = true
  #paused = false
  #closed = false
  #loggedFailure = false
  #flushTimer
  #keepTimer

  constructor({ plain, rich, session, flushMs = FLUSH_MS, keepMs = KEEP_MS, log }) {
    this.#plain = plain
    this.#rich = rich
    this.#session = session
    this.#flushMs = flushMs
    this.#keepMs = keepMs
    this.#log = log
  }

  get id() {
    return this.#id
  }

  get text() {
    return this.#text
  }

  /**
   * The first draft — the status line if one is set, Telegram's own empty *Thinking…* if not —
   * and the keep-alive that will refresh it while this runs.
   */
  open() {
    if (this.#session.off || this.#closed) return
    this.#opened = true
    this.#send()
    this.#startKeepAlive()
  }

  /**
   * What the wait is doing, in words (D198): the whole draft before the answer's first word,
   * and a line under the words so far after — a tool running halfway through an answer is
   * still worth saying. Sent at once rather than on the throttle, because stages are few and
   * the first one is the point. An empty string takes it off.
   */
  status(text) {
    const next = String(text ?? '')
    if (this.#closed || next === this.#status) return
    this.#status = next
    if (this.#opened) this.#send()
  }

  /** A piece of the answer, arrived. Schedules the throttled flush rather than sending now. */
  add(delta) {
    if (this.#closed) return
    this.#text += String(delta ?? '')
    this.#scheduleFlush()
  }

  /** A model failed mid-answer and another is starting over — the draft starts over with it. */
  restart() {
    this.#text = ''
    this.#send()
  }

  /** A question with buttons is about to be sent, which removes the draft anyway. */
  pause() {
    this.#paused = true
  }

  /** The question is answered. Resend the current state immediately, draft or no draft. */
  resume() {
    this.#paused = false
    this.#send()
  }

  /** Stop every timer. Idempotent, and nothing this `Draft` does sends anything after it. */
  close() {
    if (this.#closed) return
    this.#closed = true
    this.#stopTimers()
  }

  #scheduleFlush() {
    if (this.#closed || this.#session.off || this.#flushTimer) return
    const timer = setTimeout(() => {
      this.#flushTimer = undefined
      this.#send()
    }, this.#flushMs)
    timer.unref?.()
    this.#flushTimer = timer
  }

  #startKeepAlive() {
    if (this.#keepTimer) return
    const timer = setInterval(() => this.#send(), this.#keepMs)
    timer.unref?.()
    this.#keepTimer = timer
  }

  #stopTimers() {
    if (this.#flushTimer) clearTimeout(this.#flushTimer)
    if (this.#keepTimer) clearInterval(this.#keepTimer)
    this.#flushTimer = undefined
    this.#keepTimer = undefined
  }

  /**
   * The one place anything is actually sent: rich when there are words and rich has not already
   * failed on this draft, plain otherwise — and plain again, as the fallback, if rich just
   * failed. A status line on its own is always plain: it is this plugin's words, and a model
   * name with an underscore in it is not asking to be italic. If nothing lands, the session is
   * turned off and every timer stops.
   */
  async #send() {
    if (this.#closed || this.#paused || this.#session.off) return
    const words = this.#text
    const status = this.#status
    if (words !== '' && this.#richOk) {
      try {
        await this.#rich(this.#id, status ? `${forRich(words)}\n\n${escape(status)}` : forRich(words))
        return
      } catch {
        // Remembered for the rest of this draft — no point trying rich again this answer.
        this.#richOk = false
      }
    }
    const text = words && status ? `${words}\n\n${status}` : words || status
    try {
      await this.#plain(this.#id, text.slice(0, 4096))
    } catch (error) {
      this.#fail(error)
    }
  }

  /** Both methods just failed. Drafts are off for the rest of the session, said once. */
  #fail(error) {
    if (this.#session.off) return
    this.#session.off = true
    this.#stopTimers()
    if (!this.#loggedFailure) {
      this.#loggedFailure = true
      this.#log?.('Telegram stopped accepting drafts, so drafts are off for this session', error)
    }
  }
}

/** A status line inside Markdown, read as the characters it is and not as formatting. */
function escape(text) {
  return text.replace(/[\\`*_[\]()~>#|]/g, '\\$&')
}
