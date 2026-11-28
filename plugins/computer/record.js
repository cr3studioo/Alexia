// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process'

/**
 * **"Watch me do this once"** (P4-29): the owner starts a recording, does the task with mouse and
 * keyboard, stops, and what they did becomes a plan of named steps that `replay.js` runs again.
 *
 * The privacy rules, and where each one is kept:
 *
 * - **Only while the indicator is up.** {@link startRecording} shows it before capture starts,
 *   refuses when nothing can show it, and ends the recording the moment a refresh fails.
 * - **Never a raw key stream.** The capture scripts (in `windows.js` and `macos.js`) never read
 *   ordinary keystrokes: typed text is the *field's value* when the owner leaves it, and a key is
 *   reported only as a shortcut (a modifier held) or a named key such as Enter or Tab.
 * - **Never a password.** A password field's value is not read by the scripts, and
 *   {@link recorder} replaces whatever arrives for one with {@link ASK} as well.
 * - **Nothing kept until it is named.** A recording lives in memory; `record_stop` saves it and
 *   `record_cancel` drops it.
 */

/** A recording ends by itself at this many steps... */
export const MAX_STEPS = 200

/** ...or after this long. */
export const MAX_MS = 10 * 60_000

/** How often the on-screen dot is drawn again; it is drawn to last {@link TTL_MS}. */
export const REFRESH_MS = 2_000
export const TTL_MS = 3_000

/** What a password step types: the replay stops there and the owner types it themselves. */
export const ASK = '<ask>'

export const NO_INDICATOR = 'I can’t show that I’m recording on this computer, so I won’t record.'

/** Controls a person types into, in both vocabularies (UI Automation's and AX's). */
const FIELDS = new Set(['Edit', 'Document', 'ComboBox', 'AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField', 'AXSecureTextField'])

/** Alexia's own window: talking to her (including *stop recording*) is not part of the task. */
const OWN = /^Alexia( Dev)?$/

const said = (value) => (typeof value === 'string' ? value.trim() : '')

/**
 * Events in, steps out. An event is what a capture script printed:
 *
 * - `{ kind: 'click', name, role, window, x, y, password }`
 * - `{ kind: 'text', name, role, window, text, password }` — a field's value as it was left
 * - `{ kind: 'key', keys, window }` — already in this platform's key notation
 *
 * `add` answers true once the recording is full.
 */
export function recorder(max = MAX_STEPS) {
  const steps = []
  const add = (step) => {
    if (steps.length < max) steps.push(step)
    return steps.length >= max
  }
  return {
    steps,
    add(event) {
      if (steps.length >= max) return true
      if (OWN.test(said(event?.window))) return false
      const name = said(event?.name)
      const window = said(event?.window)
      if (event?.kind === 'key') return said(event.keys) === '' ? false : add({ do: 'key', keys: said(event.keys) })
      // Only named controls: an unnamed one is nothing a replay could find again.
      if (name === '') return false
      const field = event.password === true || FIELDS.has(said(event.role))
      if (event.kind === 'click') {
        // ponytail: a field is clicked by where it was, because pressing one does nothing; a moved
        // window misses it. A replay step that focuses a field by name is the upgrade.
        if (field) return Number.isFinite(event.x) && Number.isFinite(event.y) ? add({ do: 'click', x: Math.round(event.x), y: Math.round(event.y), into: name }) : false
        return add({ do: 'press', match: name, name, role: said(event.role), ...(window && { title: window, window }) })
      }
      if (event.kind === 'text') {
        const text = event.password === true ? ASK : typeof event.text === 'string' ? event.text : ''
        if (text === '') return false
        // Coalesced per field: leaving it, coming back and typing more is one step, its last value.
        const last = steps.at(-1)
        if (last?.do === 'type' && last.into === name) {
          last.text = text
          return false
        }
        return add({ do: 'type', into: name, text })
      }
      return false
    },
  }
}

/**
 * Show that a recording is on: a red dot and "Recording" in the top left corner through
 * `screen.draw`, drawn again every {@link REFRESH_MS}; else one notification through
 * `notify.show`. Resolves to `{ stop }`, or undefined when neither could be shown. `lost()` is
 * called if the dot stops being drawable, so the recording can end with it.
 */
export async function indicate({ answers, capability, lost, every = REFRESH_MS }) {
  const has = async (cap) => (await Promise.resolve().then(() => answers(cap)).catch(() => undefined))?.answers === true
  const ok = (cap, args) =>
    Promise.resolve()
      .then(() => capability(cap, args))
      .then((result) => result?.isError !== true)
      .catch(() => false)
  if (await has('screen.draw')) {
    const DOT = {
      shapes: [
        { kind: 'dot', x: 24, y: 24, w: 18, color: 'red' },
        { kind: 'text', x: 40, y: 14, text: 'Recording', color: 'red' },
      ],
      ttl_ms: TTL_MS,
    }
    if (await ok('screen.draw', DOT)) {
      let stopped = false
      const timer = setInterval(async () => {
        if (stopped || (await ok('screen.draw', DOT)) || stopped) return
        stopped = true
        clearInterval(timer)
        lost?.()
      }, every)
      return {
        how: 'dot',
        stop: () => {
          stopped = true
          clearInterval(timer)
        },
      }
    }
  }
  if (await has('notify.show')) {
    const shown = await ok('notify.show', {
      title: 'Alexia is recording',
      text: 'What you click and type is being watched until you stop it. Passwords are never recorded.',
      id: 'computer-recording',
    })
    if (shown) return { how: 'notice', stop: () => {} }
  }
  return undefined
}

/**
 * One recording: the indicator first, then capture, then the two limits.
 *
 * `capture(onEvent, onEnd)` starts watching and returns a function that stops it. Resolves to
 * `{ refused }` when no indicator could be shown (and capture is never started), else to the
 * session: `steps`, `ended` (why it stopped by itself, if it did) and `end()`.
 */
export async function startRecording({ goal, answers, capability, capture, max = MAX_STEPS, maxMs = MAX_MS, every = REFRESH_MS }) {
  const session = { goal, steps: [], ended: undefined, end: () => session.steps }
  let stopCapture = () => {}
  let timer
  let shown
  const end = (why) => {
    if (session.ended === undefined) session.ended = why
    clearTimeout(timer)
    shown?.stop()
    stopCapture()
    return session.steps
  }
  shown = await indicate({ answers, capability, every, lost: () => end('the recording sign could not be shown any more') })
  if (!shown) return { refused: NO_INDICATOR }
  const rec = recorder(max)
  session.steps = rec.steps
  session.end = () => end('stopped')
  timer = setTimeout(() => end(`it reached ${String(Math.round(maxMs / 60_000))} minutes`), maxMs)
  timer.unref?.()
  stopCapture = capture(
    (event) => {
      if (session.ended !== undefined) return
      if (rec.add(event)) end(`it reached ${String(max)} steps`)
    },
    (why) => end(why || 'watching stopped'),
  )
  return session
}

/**
 * A capture script run as a process, its JSON lines as events. `{ command, args }` comes from the
 * desktop backend. A line `{ "end": "..." }` is the script saying why it stopped.
 */
export function spawnCapture({ command, args }, onEvent, onEnd, start = spawn) {
  const child = start(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let buffer = ''
  let over = false
  const finish = (why) => {
    if (over) return
    over = true
    onEnd(why)
  }
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk)
    let at
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim()
      buffer = buffer.slice(at + 1)
      if (line === '') continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof event?.end === 'string') finish(event.end)
      else onEvent(event)
    }
  })
  child.stderr?.on('data', () => {})
  child.on('error', (error) => finish(`watching could not start (${String(error?.code ?? error?.message ?? error)})`))
  child.on('close', () => finish('watching stopped'))
  return () => {
    over = true
    child.kill()
  }
}

/**
 * A plan cut at its password steps: `[{ steps, then }]`, where `then` is the field the owner types
 * into themselves before the next part runs. The password never passes through Alexia.
 */
export function parts(plan) {
  const out = [{ steps: [] }]
  for (const step of plan) {
    if (step?.do === 'type' && step.text === ASK) {
      out.at(-1).then = String(step.into ?? 'the password field')
      out.push({ steps: [] })
    } else out.at(-1).steps.push(step)
  }
  return out
}
