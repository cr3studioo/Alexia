// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The timeline (P3-15, ME-05): one short entry per day, written by the nightly pass.
 *
 * **One row per day, ever.** The table is `days` — `date` as `YYYY-MM-DD` in the owner's own
 * clock, `text`, `at` — and writing a day that already has a row rewrites that row. The nightly
 * pass can therefore run twice, or be repaired by hand, without a day showing up twice in the
 * weekly brief.
 *
 * **Code overrules the model**, as everywhere in this plugin: the model is asked for at most
 * five sentences, and whatever comes back is cut to five and to a length, with quotes and list
 * markers taken off. A model that answers nothing, or `NONE`, writes nothing.
 *
 * Pure functions only. Locked facts never reach `dayPrompt` — the caller leaves them out — so
 * nothing the owner locked can end up in a line that a proactive message might quote.
 */

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/** At most this many sentences in one day's entry. */
export const SENTENCES = 5
/** …and at most this many characters, so a rambling answer is not a page. */
export const LONGEST = 700

/** The local day an instant falls on, as `YYYY-MM-DD`; `tz` is minutes east of UTC. */
export const dayOf = (ms, tz = 0) => new Date(Number(ms) + tz * MINUTE).toISOString().slice(0, 10)

/** `[from, to)` in epoch ms for a local `YYYY-MM-DD` day. */
export function bounds(date, tz = 0) {
  const start = Date.parse(`${date}T00:00:00Z`) - tz * MINUTE
  return { from: start, to: start + DAY }
}

/** The day before a `YYYY-MM-DD` day. */
export const before = (date, days = 1) => new Date(Date.parse(`${date}T00:00:00Z`) - days * DAY).toISOString().slice(0, 10)

const valid = (date) => /^\d{4}-\d{2}-\d{2}$/.test(String(date ?? '')) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`))

/** One short piece of text for the prompt: one line, cut with an ellipsis. */
const brief = (text, most = 240) => {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim()
  return [...one].length > most ? `${[...one].slice(0, most - 1).join('')}…` : one
}

/**
 * What the free model is asked for one day. Closed like the sorting prompt: sentences back or
 * `NONE`, and the only things it is shown are what was written down that day.
 */
export function dayPrompt(date, { facts = [], dates = [], exchanges = [] } = {}) {
  const lines = (title, rows) => (rows.length === 0 ? [] : ['', `${title}:`, ...rows.map((one) => `- ${brief(one)}`)])
  return [
    `Below is what was written down about one person's day, ${date}.`,
    'Write a short diary line for that day, in the third person, in the language most of it is written in.',
    `At most ${SENTENCES} sentences. Say only what the lines say: no advice, no guesses, nothing added.`,
    'If there is nothing worth a line, answer NONE. Answer with the sentences and nothing else.',
    ...lines('Notes written down that day', facts),
    ...lines('Dated things', dates),
    ...lines('Said that day, not yet sorted', exchanges),
  ].join('\n')
}

/** Sentences, in order, with their end marks. The text is not parsed any further than that. */
const sentencesOf = (text) => text.match(/[^.!?…]+(?:[.!?…]+|$)/gu)?.map((one) => one.trim()).filter(Boolean) ?? []

/**
 * The model's day, if it is one worth keeping, or `null`. One paragraph; list markers, quotes
 * and a leading date are taken off; at most `SENTENCES` sentences and `LONGEST` characters.
 */
export function dayEntry(said) {
  const flat = String(said ?? '')
    .split('\n')
    .map((line) => line.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, ''))
    .filter((line) => line !== '')
    .join(' ')
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .replace(/^\d{4}-\d{2}-\d{2}\s*[:–-]\s*/, '')
    .trim()
  if (flat === '' || /^(?:none|keep|nothing)\W*$/i.test(flat)) return null
  const kept = sentencesOf(flat).slice(0, SENTENCES).join(' ')
  const text = [...kept].length > LONGEST ? `${[...kept].slice(0, LONGEST - 1).join('')}…` : kept
  return text === '' ? null : text
}

/**
 * The entry used when no model can be asked: the notes of that day, one after the other, up to
 * `SENTENCES`. Plain, and never wrong, which is the point of having it.
 */
export function plainEntry(facts) {
  const lines = facts
    .map((one) => brief(one, 160).replace(/[.!?]+$/, ''))
    .filter((one) => one !== '')
    .slice(0, SENTENCES)
  return lines.length === 0 ? null : `${lines.join('. ')}.`
}

/**
 * Write a day: what to do to the table so that it holds one row for `date`. An identical row
 * is left alone (`null`), a different one for the same day is rewritten, and a new day is a row.
 */
export function upsert(rows, date, text, at) {
  if (!valid(date) || String(text ?? '').trim() === '') return null
  const same = rows.filter((row) => row.date === date).sort((a, b) => Number(a.rowid ?? 0) - Number(b.rowid ?? 0))
  const [first] = same
  if (!first) return { insert: { date, text, at } }
  if (first.text === text && same.length === 1) return null
  return { update: { rowid: Number(first.rowid), set: { text, at } }, remove: same.slice(1).map((row) => Number(row.rowid)) }
}

/** The days from `from` to `to`, both inclusive and both optional, oldest first. */
export function between(rows, from, to) {
  return rows
    .filter((row) => valid(row.date) && (!valid(from) || row.date >= from) && (!valid(to) || row.date <= to))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : Number(a.rowid ?? 0) - Number(b.rowid ?? 0)))
}

/** A day as the line it is shown on. */
export const lineOf = (row) => `${String(row.date)}: ${String(row.text)}`

/** The last seven local days up to and including `today`, as lines. */
export const weekLines = (rows, today) => between(rows, before(today, 6), today).map(lineOf)

/**
 * One section of a brief (`brief.section`). Only the weekly kind has anything to say: a morning
 * or evening brief already has today's notices, and yesterday's diary line would repeat them.
 */
export function section(kind, rows, now, tz = 0) {
  if (kind !== 'weekly') return { title: 'Your days', text: '' }
  return { title: 'Your days', text: weekLines(rows, dayOf(now, tz)).join('\n') }
}
