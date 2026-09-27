// SPDX-License-Identifier: AGPL-3.0-only

/**
 * **The small rules of the conversation on screen**, out of `main.ts` so they can be tested
 * without the whole page around them: what an old turn shows when it is drawn again, whether
 * the log should follow new words, which commands the `/` menu lists, and how tall the box
 * you type in is.
 *
 * Nothing here talks to core or reaches for an element by id. It is handed what it works on.
 */

/** One stored turn, as `/api/state` sends it. `content` is words, or parts when a picture came with them. */
export interface StoredTurn {
  role: string
  content: string | { type: string; text?: string; url?: string }[]
  /** What the person typed, when documents were read into `content`. */
  typed?: string
  /** What this turn asked to run. A turn with calls and no words is a tool-only turn. */
  calls?: unknown[]
  /** The answer was cut short by Stop. Written by core; read defensively, since older cores never send it. */
  stopped?: unknown
}

/** What a stored turn shows when an old conversation is drawn again. */
export interface Shown {
  /** The words, as the person typed them or as she wrote them. */
  text: string
  /** One entry per thing that came with it: a document's name, or `picture`. */
  attached: { name: string; picture: boolean }[]
  /** How many tools this turn asked to run. */
  tools: number
  /** Whether the answer was stopped before it was finished. */
  stopped: boolean
}

/** Where core put the first document into the question (`withDocuments` in core's `attach.ts`). */
const DOCUMENTS = /(?:^|\n\n)\[attached: [\s\S]*$/

/**
 * **A stored turn, as somebody reading the conversation expects to see it again.**
 *
 * The question as it was typed, not the question with a whole lease merged underneath it —
 * which is what a model was sent, and nobody typed. A turn with a picture in it is parts rather
 * than a string, and drawing that as text used to show `[object Object]`.
 */
export function shownTurn(turn: StoredTurn): Shown {
  const whole =
    typeof turn.content === 'string' ? turn.content
    : Array.isArray(turn.content) ?
      turn.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('\n')
    : ''
  const text = typeof turn.typed === 'string' ? turn.typed : whole.replace(DOCUMENTS, '')
  const documents = [...whole.matchAll(/\[attached: ([^\]\n]+?)(?: — [^\]\n]*)?\]/g)].map(([, name]) => ({
    name: name!.trim(),
    picture: false,
  }))
  const pictures =
    Array.isArray(turn.content) ?
      turn.content.filter((part) => part.type === 'image').map(() => ({ name: 'picture', picture: true }))
    : []
  return {
    text,
    attached: [...documents, ...pictures],
    tools: Array.isArray(turn.calls) ? turn.calls.length : 0,
    stopped: turn.stopped === true,
  }
}

/** The quiet line that stands in for her tool-only turns: *Used 3 tools*. */
export const usedTools = (count: number): string => `Used ${String(count)} ${count === 1 ? 'tool' : 'tools'}`

/**
 * **How close to the bottom still counts as reading the newest words**, in CSS pixels. About
 * two lines: somebody who scrolled up a little to reread something has scrolled up on purpose.
 */
const NEAR = 48

/** Whether the log is scrolled to (or within a line or two of) its end. */
export function nearBottom(log: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>): boolean {
  return log.scrollHeight - log.scrollTop - log.clientHeight <= NEAR
}

/** A command as `/api/state` lists it. */
export interface Listed {
  name: string
  alias?: string
}

/**
 * **What the `/` menu lists for what has been typed so far**: every command whose name (or
 * short name) starts with the word after the `/`. All of them, not the first eight — a command
 * the menu never shows is a command nobody finds.
 */
export function slashMatches<T extends Listed>(known: readonly T[], typed: string): T[] {
  if (!typed.startsWith('/')) return []
  const word = (typed.slice(1).split(/\s/)[0] ?? '').toLowerCase()
  return known.filter(
    (command) => command.name.toLowerCase().startsWith(word) || (command.alias?.toLowerCase().startsWith(word) ?? false),
  )
}

/** The next highlighted row when ↑ or ↓ is pressed, going round at either end. */
export function moveIn(count: number, at: number, down: boolean): number {
  if (count === 0) return 0
  return (at + (down ? 1 : -1) + count) % count
}

/** **How many lines the box you type in grows to** before it scrolls instead. */
export const MOST_LINES = 6

/**
 * **The box you type in, as tall as what is in it** — one line empty, up to six, then it scrolls.
 *
 * It used to stay one line whatever was typed, so a pasted paragraph was read through a slot.
 */
export function grow(box: HTMLTextAreaElement, most = MOST_LINES): void {
  const style = getComputedStyle(box)
  const px = (value: string): number => Number.parseFloat(value) || 0
  // `normal` has no number in it; a line is about 1.4 of the font in every face this page uses.
  const line = px(style.lineHeight) || px(style.fontSize) * 1.4 || 20
  const frame = px(style.paddingTop) + px(style.paddingBottom) + px(style.borderTopWidth) + px(style.borderBottomWidth)
  const tallest = line * most + frame
  box.style.height = 'auto'
  const wanted = box.scrollHeight + px(style.borderTopWidth) + px(style.borderBottomWidth)
  // A page not laid out yet (a hidden page, or a test) measures nothing; leave the box as it is.
  if (wanted <= 0) {
    box.style.removeProperty('height')
    return
  }
  box.style.height = `${String(Math.min(wanted, tallest))}px`
  box.style.overflowY = wanted > tallest ? 'auto' : 'hidden'
}

/** Her words in an answer: its own text, without the lines, chips and buttons drawn into it. */
export function wordsOf(answer: HTMLElement): string {
  return [...answer.childNodes]
    .filter((node): node is Text => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.data)
    .join('')
    .trim()
}

/**
 * **Copy some words**, the modern way, and the old way where the modern one is refused — the
 * clipboard API wants a page it trusts and a press, and a Copy button that silently did nothing
 * would be worse than none.
 */
export async function copyText(words: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(words)
    return true
  } catch {
    const scratch = document.createElement('textarea')
    scratch.value = words
    scratch.setAttribute('readonly', '')
    scratch.style.position = 'fixed'
    scratch.style.opacity = '0'
    document.body.append(scratch)
    scratch.select()
    try {
      // Deprecated, and still the only way left when the clipboard API says no.
      return document.execCommand('copy')
    } catch {
      return false
    } finally {
      scratch.remove()
    }
  }
}
