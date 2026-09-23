// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The words under *typing…* — what the wait is actually doing (D198).
 *
 * `sendChatAction` is Telegram's own indicator and its words are not this plugin's: every
 * client draws *typing…* or *sending photo…* from the action's name, and there is no action
 * for *choosing a model*. So the indicator stays (`presence.js`), and the words go where this
 * plugin does choose them — the draft while drafts work, and a status message of its own,
 * edited in place and deleted when the answer lands, on a chat where they do not.
 *
 * Plain words and no emoji, on purpose: it is one line that changes a few times and then
 * disappears, and it should read like the window's line under the question, not decorate it.
 */

/**
 * The line for one `alexia/stream` frame, or `undefined` for a frame that is not a stage or a
 * stage this plugin has not heard of yet — which leaves whatever was said before it standing.
 */
export function statusOf(frame) {
  const model = typeof frame?.model === 'string' && frame.model !== '' ? frame.model : undefined
  const tool = typeof frame?.tool === 'string' && frame.tool !== '' ? frame.tool : undefined
  switch (frame?.phase) {
    case 'choosing':
      return 'Choosing a model…'
    case 'reading':
      return 'Reading what you sent…'
    case 'asking':
      return model ? `Asking ${model}…` : 'Asking a model…'
    case 'retrying':
      return model ? `${model} is busy, trying again…` : 'Trying again…'
    case 'backup':
      return model ? `Also asking ${model}…` : 'Asking another model…'
    case 'thinking':
      return model ? `Thinking (${model})…` : 'Thinking…'
    case 'writing':
      return 'Generating answer…'
    case 'tool':
      return tool ? `Using ${tool}…` : 'Working…'
    default:
      return undefined
  }
}

/** Where every answer starts, before core has said anything. */
export const FIRST = 'Thinking…'

/**
 * A status message of this plugin's own, for a chat where drafts do not work.
 *
 * Sent silently the first time, edited after, deleted at the end — so what is left in the chat
 * is the answer and nothing else. Every call is chained behind the one before it, because an
 * edit that overtakes the send it edits has no message to land on. **Nothing here throws**: a
 * status line is a nicety on top of an answer that arrives regardless, so a failure is one line
 * in the log the first time and silence after.
 */
export class StatusMessage {
  #send
  #edit
  #remove
  #log
  #id
  #said
  #closed = false
  #logged = false
  #queue = Promise.resolve()

  /**
   * `send(text)` resolves to the sent message's id; `edit(id, text)` and `remove(id)` act on
   * it. All three are Bot API calls, injected so a test can record them.
   */
  constructor({ send, edit, remove, log }) {
    this.#send = send
    this.#edit = edit
    this.#remove = remove
    this.#log = log
  }

  /** Say `text`, sending the message the first time and editing it after. Same text is no call. */
  set(text) {
    if (this.#closed || !text || text === this.#said) return this.#queue
    this.#said = text
    return this.#then(async () => {
      if (this.#closed) return
      if (this.#id === undefined) this.#id = await this.#send(text)
      else await this.#edit(this.#id, text)
    })
  }

  /** Take it down. Idempotent, and every later `set()` is ignored. */
  clear() {
    if (this.#closed) return this.#queue
    this.#closed = true
    return this.#then(async () => {
      if (this.#id !== undefined) await this.#remove(this.#id)
    })
  }

  #then(step) {
    this.#queue = this.#queue.then(step).catch((error) => {
      if (this.#logged) return
      this.#logged = true
      this.#log?.('could not update the status message — answers are unaffected', error)
    })
    return this.#queue
  }
}
