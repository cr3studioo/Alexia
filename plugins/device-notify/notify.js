// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a notice is, and the one way every platform shows it.
 *
 * A backend (`windows.js`, `macos.js`) says which helper to start and what its lines mean.
 * Everything that has to behave the same everywhere is here: checking the arguments, waiting
 * for an answer and giving up, replacing a notice with the same id, and cancelling.
 *
 * A backend is `{ plan(notice, { answerMs }), read(line) }`:
 *
 * - `plan` → `{ command, args, input, asks, stays }`. `asks`: the helper can report an answer.
 *   `stays`: the notification lives only as long as the helper does, so giving up on an answer
 *   must leave the helper running.
 * - `read` takes one parsed JSON line and returns `{ type: 'shown' }`,
 *   `{ type: 'failed', reason }`, `{ type: 'action', action, text }` or `undefined`.
 *
 * An action is `b0`..`b2` (the owner's button), `send` (the reply box was submitted) or
 * anything else (closed without answering).
 *
 * **A notice is private.** Nothing here logs its title, text, buttons or the answer.
 */

export const MAX_BUTTONS = 3
export const URGENCIES = ['low', 'normal', 'high', 'urgent']
/** How long a call waits for a button or a reply, counted from when the notice is up. */
export const ANSWER_MS = 60_000
/** How long a helper may take to put the notice up. Together with `ANSWER_MS` under the host's 120 s. */
export const START_MS = 40_000
/** How many unanswered dialogs may stay on screen at once; the oldest is closed after that. */
export const MAX_LEFT_OPEN = 5

const MAX_TITLE = 200
const MAX_TEXT = 4000
const MAX_LABEL = 40
const MAX_DATA = 4096
const MAX_ID = 200
const MAX_REPLY = 4000

/** Control characters other than tab and newline, which no notification can show. */
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F]/g
const clean = (value) => value.replace(/\r\n?/g, '\n').replace(CONTROLS, '')
const oneLine = (value) => clean(value).replace(/\s+/g, ' ').trim()

/** At most `max` characters, never splitting one in half. */
export function cut(value, max) {
  const chars = Array.from(value)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : value
}

/** Tool arguments → `{ notice }`, or `{ error }` as a sentence that quotes none of them. */
export function parseNotice(args = {}) {
  const { title, text, urgency = 'normal', buttons = [], reply = false, id } = args
  if (typeof title !== 'string' || typeof text !== 'string') return { error: 'A notification needs a title and a text.' }
  const heading = cut(oneLine(title), MAX_TITLE)
  const body = cut(clean(text).trim(), MAX_TEXT)
  if (!heading && !body) return { error: 'A notification needs a title or a text.' }
  if (!URGENCIES.includes(urgency)) return { error: 'The urgency is low, normal, high or urgent.' }
  if (typeof reply !== 'boolean') return { error: 'reply is true or false.' }
  if (!Array.isArray(buttons)) return { error: 'The buttons are a list.' }
  if (buttons.length > MAX_BUTTONS) return { error: 'A notification takes at most three buttons.' }
  const parsed = []
  for (const button of buttons) {
    const label = typeof button?.label === 'string' ? cut(oneLine(button.label), MAX_LABEL) : ''
    const data = button?.data
    if (!label || typeof data !== 'string' || data.length > MAX_DATA) return { error: 'Every button needs a label and its data.' }
    parsed.push({ label, data })
  }
  if (new Set(parsed.map((b) => b.label.toLowerCase())).size !== parsed.length) return { error: 'Every button needs its own label.' }
  if (id !== undefined && (typeof id !== 'string' || !id || id.length > MAX_ID)) return { error: 'The id is a short piece of text.' }
  return { notice: { title: heading, text: body, urgency, buttons: parsed, reply, ...(id !== undefined && { id }) } }
}

/** Whether the caller is waiting for a button or a reply. */
export const wantsAnswer = (notice) => notice.reply || notice.buttons.length > 0

/**
 * What the owner answered: `{ data }` for a button (with `text` too when they also typed a
 * reply, so it is not thrown away), `{ text }` for a reply, `null` for anything else.
 */
export function answerFor(notice, { action, text }) {
  const typed = notice.reply && typeof text === 'string' && text.trim() !== '' ? cut(text.trim(), MAX_REPLY) : undefined
  const index = /^b([0-2])$/.exec(String(action))?.[1]
  const button = index === undefined ? undefined : notice.buttons[Number(index)]
  if (button) return { data: button.data, ...(typed !== undefined && { text: typed }) }
  if (action === 'send' && typed !== undefined) return { text: typed }
  return null
}

const realClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer),
}

function json(line) {
  try {
    const value = JSON.parse(line)
    return value !== null && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * `show(notice, { signal })` → `{ shown, answer?, reason? }`. `answer` is present only when
 * the notice asked for one and was shown. It never rejects.
 *
 * `start(command, args, { input, onLine })` → `{ exit: Promise<{ code }>, kill(), release() }`
 * is `startProcess` from `run.js`; tests pass a fake, and a fake `clock`.
 */
export function createNotifier({ backend, start, clock = realClock, answerMs = ANSWER_MS, startMs = START_MS }) {
  /** Calls still waiting. */
  const waiting = new Set()
  /** Helpers whose call is over and whose dialog is still on screen, oldest first. */
  const leftOpen = []

  const forget = (entry) => {
    const at = leftOpen.indexOf(entry)
    if (at >= 0) leftOpen.splice(at, 1)
  }

  /** A newer notice with this id: the older one's helper goes, and its call ends unanswered. */
  function replace(id) {
    for (const call of [...waiting]) if (call.id === id) call.replaced()
    for (const entry of [...leftOpen]) {
      if (entry.id !== id) continue
      forget(entry)
      entry.helper.kill()
    }
  }

  function leave(id, helper) {
    const entry = { id, helper }
    leftOpen.push(entry)
    helper.release()
    void helper.exit.then(() => forget(entry))
    while (leftOpen.length > MAX_LEFT_OPEN) leftOpen.shift().helper.kill()
  }

  function show(notice, { signal } = {}) {
    if (signal?.aborted) return Promise.resolve({ shown: false, reason: 'cancelled' })
    if (notice.id !== undefined) replace(notice.id)
    const asked = wantsAnswer(notice)

    return new Promise((resolve) => {
      let helper
      let plan
      let timer
      let shown = false
      let settled = false
      const call = { id: notice.id }
      const up = (answer = null) => ({ shown: true, ...(asked && { answer }) })
      const down = (reason) => ({ shown: false, reason })

      /** `then`: what happens to the helper: `'kill'`, `'leave'` it on screen, or nothing. */
      const finish = (result, then) => {
        if (settled) return
        settled = true
        clock.clearTimeout(timer)
        signal?.removeEventListener('abort', cancelled)
        waiting.delete(call)
        if (then === 'kill') helper?.kill()
        if (then === 'leave') leave(notice.id, helper)
        resolve(result)
      }
      const cancelled = () => finish(shown ? up() : down('cancelled'), 'kill')
      call.replaced = () => finish(up(), 'kill')

      const heard = (line) => {
        if (settled) return
        const message = json(line)
        const event = message && backend.read(message)
        if (!event) return
        if (event.type === 'failed') return finish(down(event.reason), 'kill')
        if (event.type === 'shown') {
          if (shown) return
          shown = true
          if (!plan.asks) return
          clock.clearTimeout(timer)
          timer = clock.setTimeout(() => finish(up(), plan.stays ? 'leave' : 'kill'), answerMs)
          return
        }
        if (event.type === 'action' && shown && plan.asks) finish(up(answerFor(notice, event)))
      }

      try {
        plan = backend.plan(notice, { answerMs })
        helper = start(plan.command, plan.args, { input: plan.input, onLine: heard })
      } catch {
        return finish(down('could not start'))
      }
      waiting.add(call)
      signal?.addEventListener('abort', cancelled, { once: true })
      timer = clock.setTimeout(() => finish(down('too slow'), 'kill'), startMs)
      void helper.exit.then(({ code }) => finish(shown && code === 0 ? up() : down(`exit ${String(code)}`)))
    })
  }

  return { show }
}
