// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Study cards, Leitner style: pure, with no wire and no clock.
 *
 * Five boxes. A right answer moves a card up a box and spaces it further out; a wrong one
 * sends it back to box 1, due tomorrow. Days are `YYYY-MM-DD` strings in the owner's zone.
 */

export const BOXES = 5
/** Days until a card in box 1..5 is asked again. */
export const SPACING = [1, 2, 4, 8, 16]
const DAY_MS = 86_400_000

/** The day `n` days after `from` (`YYYY-MM-DD`). */
export const addDays = (from, n) => new Date(Date.parse(`${from}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)

/** A real calendar day, ISO only, or `undefined`. */
export function day(said) {
  const text = String(said ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined
  const parsed = Date.parse(`${text}T00:00:00Z`)
  return Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== text ? undefined : text
}

/** The box a card is in, clamped to 1..5 (a missing or odd value is box 1). */
export const boxOf = (card) => {
  const box = Math.trunc(Number(card?.box))
  return Number.isFinite(box) ? Math.min(BOXES, Math.max(1, box)) : 1
}

/** A new card goes in box 1 and is due the day it is made. */
export const newCard = ({ note_id, q, a }, today) => ({ note_id: note_id ?? null, q: String(q).trim(), a: String(a).trim(), box: 1, due: today })

/** What a card becomes after an answer: `{ box, due }`. */
export function grade(card, right, today) {
  const box = right ? Math.min(BOXES, boxOf(card) + 1) : 1
  return { box, due: addDays(today, right ? SPACING[box - 1] : 1) }
}

/** Cards due on or before `today`, the longest overdue first, then the lowest box (the shakiest). */
export const dueCards = (cards, today) =>
  cards
    .filter((card) => typeof card.due === 'string' && card.due <= today)
    .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : boxOf(a) - boxOf(b) || Number(a.rowid) - Number(b.rowid)))

/** How many cards are due on or before `today`. */
export const dueCount = (cards, today) => dueCards(cards, today).length

/**
 * Question and answer pairs out of a model's reply. One per line, `Q: … | A: …` (the bar may
 * be missing when `A:` starts a line of its own). Anything that does not fit is ignored.
 */
export function parseCards(text, most = 20) {
  const out = []
  const lines = String(text ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length && out.length < most; i += 1) {
    const found = /^\s*(?:[-*\d.)]+\s*)?Q\s*:\s*(.+?)(?:\s*\|\s*A\s*:\s*(.+))?$/i.exec(lines[i])
    if (!found) continue
    let answer = found[2]
    if (answer === undefined) {
      const next = /^\s*A\s*:\s*(.+)$/i.exec(lines[i + 1] ?? '')
      if (next) { answer = next[1]; i += 1 }
    }
    if (answer && found[1].trim() && answer.trim()) out.push({ q: found[1].trim(), a: answer.trim() })
  }
  return out
}
