// SPDX-License-Identifier: AGPL-3.0-only

/**
 * **The line under an answer while it is being made**: a word for fun, what is really
 * happening, and how long it has been.
 *
 * ```
 * ✻ Pestering… · Qwen 3.8 is busy, trying again (2)  5s
 * ```
 *
 * Alexia.md: *silence is what kills, not time.* The wait before the first word used to be a
 * `…` that said nothing at all, for thirty seconds while a model hung or for a minute while
 * three busy ones were asked in turn. Somebody looking at `…` cannot tell a slow answer from a
 * crash. Somebody looking at *Qwen 3.8 is busy, trying again (3)* can.
 *
 * **Two halves, and only one of them may play.** The word is flavour, picked from a small pool
 * for the stage: *Pestering…* while a busy model is asked again, *Scouting…* while a second one
 * is asked as backup. The detail beside it is built from nothing but the fields core sent, so it
 * is always literally true. The model named is the one being asked, and the attempt is the
 * attempt. A joke is fine. A joke that claims something is not.
 *
 * A file of its own, rather than forty lines inside `respond()`, so the words, the clock and the
 * sentences can be tested without the page around them.
 */

/**
 * **What core says it is doing**: one `data: {"phase": …}` frame on the `/api/chat` stream.
 *
 * A copy of `Phase` in `packages/core/src/router.ts`, not an import of it. This page cannot
 * reach anything that has ever seen a Node builtin (invariant 6), which is the same reason
 * `main.ts` parses the stream's frames itself. When core's type grows a stage, this one grows
 * with it. Until then {@link isPhase} drops the new stage rather than drawing it wrong.
 */
export type Phase =
  | { kind: 'choosing' }
  | { kind: 'reading' }
  | { kind: 'asking'; model: string }
  | { kind: 'retrying'; model: string; attempt: number }
  | { kind: 'backup'; model: string; behind: string; why: 'busy' | 'slow' | 'lately' | 'fastest' }
  | { kind: 'thinking'; model: string }
  | { kind: 'writing'; model: string }
  | { kind: 'tool'; name: string }

/** One stage of the walk: what picks the word. */
export type Kind = Phase['kind']

/**
 * **The words, a pool per stage.** Gentle, a little silly, and never a claim: each one is how
 * the stage *feels*, and the detail beside it says what the stage *is*. Seven or so each, which
 * is enough that the same question asked twice rarely reads the same, and few enough that every
 * one of them has been read by a person.
 */
export const WORDS: Readonly<Record<Kind, readonly string[]>> = {
  choosing: ['Rummaging', 'Weighing', 'Mulling', 'Sifting', 'Browsing', 'Deliberating', 'Shortlisting'],
  reading: ['Skimming', 'Poring', 'Perusing', 'Leafing', 'Studying', 'Digesting', 'Absorbing'],
  asking: ['Knocking', 'Dialing', 'Summoning', 'Hailing', 'Beckoning', 'Ringing', 'Paging'],
  retrying: ['Pestering', 'Nudging', 'Badgering', 'Coaxing', 'Persisting', 'Wheedling', 'Insisting'],
  backup: ['Scouting', 'Recruiting', 'Enlisting', 'Rallying', 'Mustering', 'Reinforcing'],
  thinking: ['Pondering', 'Percolating', 'Noodling', 'Musing', 'Ruminating', 'Cogitating', 'Brewing', 'Simmering'],
  writing: ['Scribbling', 'Composing', 'Penning', 'Jotting', 'Wordsmithing', 'Inking', 'Drafting'],
  tool: ['Tinkering', 'Wrangling', 'Fiddling', 'Rigging', 'Tweaking', 'Puttering', 'Cranking'],
}

/** The mark in front of the word. Claude Code's, which is where the person who asked for this saw it. */
export const GLYPH = '✻'

/**
 * **How often the counter moves: once a second**, because it shows whole seconds. A faster clock
 * would only write the same number again.
 */
const TICK = 1000
const SECONDS_IN_A_MINUTE = 60

/** A frame's `phase`, if it is one this page knows how to say. A stage from a newer core is skipped. */
export function isPhase(value: unknown): value is Phase {
  if (typeof value !== 'object' || value === null) return false
  const kind = (value as { kind?: unknown }).kind
  return typeof kind === 'string' && Object.hasOwn(WORDS, kind)
}

/** A plugin's tool without its plugin: `files__search` is *search*, the name the chip above shows. */
function shortTool(name: string): string {
  const cut = name.indexOf('__')
  return cut === -1 ? name : name.slice(cut + 2)
}

/**
 * **Why a second model is being asked**, in the words for each reason.
 *
 * Each names only what is known. *Lately* is the record rather than right now — the first model
 * may be fine this time — so it says *was*, not *is*. *Fastest* is a choice somebody made, so it
 * blames nobody.
 */
function backup(phase: Extract<Phase, { kind: 'backup' }>): string {
  switch (phase.why) {
    case 'busy':
      return `${phase.behind} is busy — asking ${phase.model} as backup`
    case 'slow':
      return `${phase.behind} is slow to start — asking ${phase.model} too`
    case 'lately':
      return `${phase.behind} was busy a moment ago — asking ${phase.model} too`
    case 'fastest':
      return `asking ${phase.model} too, for speed`
  }
}

/**
 * **The true half**: what is happening, in words, from the event's own fields and nothing else.
 *
 * No guessing and no softening. *Busy* is what a 429 says. *Slow to start* is what a model that
 * showed no sign of life for a while is. Neither is *down*, because nothing here knows that.
 */
export function detail(phase: Phase): string {
  switch (phase.kind) {
    case 'choosing':
      return 'choosing a model'
    case 'reading':
      return 'reading your files'
    case 'asking':
      return `asking ${phase.model}`
    case 'retrying':
      return `${phase.model} is busy, trying again (${String(phase.attempt)})`
    case 'backup':
      return backup(phase)
    case 'thinking':
      return `${phase.model} is thinking`
    case 'writing':
      return `${phase.model} is writing`
    case 'tool':
      return `using ${shortTool(phase.name)}`
  }
}

/** One word from the stage's pool. `random` is `Math.random` on screen and a fixed number in a test. */
export function pick(kind: Kind, random: () => number = Math.random): string {
  const pool = WORDS[kind]
  // `Math.random` never returns 1, but a test's stand-in might, and an index past the end is
  // `undefined` on screen.
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]!
}

/** What the line says right now. */
export interface Said {
  kind: Kind
  word: string
  detail: string
}

/**
 * **The next line, from the one on screen and what core just said.**
 *
 * A new word only when the stage changes. Core may say *asking* three times in a second as it
 * works down a list, and a word that changed every time would flicker, which reads as the
 * screen being unsure rather than the work moving. The detail always follows the event, so the
 * model named is the one being asked even while the word stays still.
 */
export function next(was: Said | undefined, phase: Phase, random: () => number = Math.random): Said {
  return {
    kind: phase.kind,
    word: was?.kind === phase.kind ? was.word : pick(phase.kind, random),
    detail: detail(phase),
  }
}

/** **How long, as a person reads it**: `0s`, `59s`, then `1m 05s`. Never negative, whatever the clock did. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / TICK))
  if (seconds < SECONDS_IN_A_MINUTE) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / SECONDS_IN_A_MINUTE)
  return `${String(minutes)}m ${String(seconds % SECONDS_IN_A_MINUTE).padStart(2, '0')}s`
}

export interface Status {
  /** Say what is happening now. The word changes only if the stage did. */
  set(phase: Phase): void
  /** Take the line away and stop its clock. Safe to call twice, and a `set` after it does nothing. */
  stop(): void
}

export interface StatusOptions {
  /** What to say before core has said anything. `choosing`, unless the message carries files. */
  first?: Phase
  /** Where the word comes from. `Math.random`; a test passes its own. */
  random?: () => number
  /** The clock. `Date.now`; a test's fake timers move it. */
  now?: () => number
}

function span(className: string, text = ''): HTMLSpanElement {
  const element = document.createElement('span')
  element.className = className
  element.textContent = text
  return element
}

/**
 * **The line, drawn at the end of `host`**, counting from the moment it is mounted, which is
 * the moment the message was sent.
 *
 * **Only the word and the detail are announced.** They sit in a `role="status"` region, which
 * a screen reader reads politely when it changes. The counter sits *beside* that region rather
 * than inside it, and is hidden from the accessibility tree as well: a status region is atomic,
 * so a number changing inside it would re-read the whole line every second, and somebody
 * listening would hear nothing but the clock.
 *
 * It stays the last thing in `host`, under the words as they stream in, so it reads as *what is
 * happening next* rather than as part of the answer. Something else appended to `host` meanwhile
 * (a file a step made) goes above it at the next `set`, and the loop says a new stage before
 * every step.
 */
export function mountStatus(host: HTMLElement, options: StatusOptions = {}): Status {
  const random = options.random ?? Math.random
  const now = options.now ?? Date.now
  const since = now()

  const line = document.createElement('div')
  line.className = 'status-line'
  const said = span('status-said')
  said.setAttribute('role', 'status')
  said.setAttribute('aria-live', 'polite')
  const glyph = span('status-glyph', GLYPH)
  glyph.setAttribute('aria-hidden', 'true')
  const word = span('status-word')
  const dot = span('status-dot', ' · ')
  dot.setAttribute('aria-hidden', 'true')
  const what = span('status-detail')
  said.append(glyph, ' ', word, dot, what)
  const time = span('status-time', elapsed(0))
  time.setAttribute('aria-hidden', 'true')
  line.append(said, time)

  let shown: Said | undefined
  let stopped = false

  const tick = (): void => {
    time.textContent = elapsed(now() - since)
  }
  const timer = setInterval(tick, TICK)

  const set = (phase: Phase): void => {
    if (stopped) return
    shown = next(shown, phase, random)
    // Written only when it differs: a live region re-reads on any change to its text, and core
    // saying *asking Qwen* twice is not news worth interrupting anybody for.
    const saying = `${shown.word}…`
    if (word.textContent !== saying) word.textContent = saying
    if (what.textContent !== shown.detail) what.textContent = shown.detail
    if (host.lastElementChild !== line) host.append(line)
  }

  set(options.first ?? { kind: 'choosing' })

  return {
    set,
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      line.remove()
    },
  }
}
