// SPDX-License-Identifier: AGPL-3.0-only
import { content } from './search.js'

/**
 * Truth over time: which notes still hold, which ones used to, and which ones nobody has
 * checked in a while.
 *
 * **A note that stops being true is closed, not deleted.** *He lives in Brno* was true until he
 * moved, and a memory that erased it would be unable to answer *where did he live before* — and
 * would make a wrong replacement unrecoverable. So an old version gets `invalid_at` and a
 * `replaced_by` pointing at the new one, and everything that reads memory for use (`recall`,
 * the profile, the panel's list, what the sorting pass is shown) reads only `valid` rows. This
 * is Graphiti's validity window, kept to the two columns a person can read.
 *
 * **The gardener does not guess.** Some notes describe a state that will end — a year of study,
 * a job, a current project — and nothing about a note written in September says whether it is
 * still true in March. So such a note gets a `review_at`, and when it comes due the gardener
 * does the only two things that need no knowledge it has not got: it rewrites *relative* time
 * into absolute time using the date the note was written (*first-year student*, written in
 * September 2026, is *started in September 2026*, which is true forever), and it marks the note
 * *may be out of date* for a person to confirm or close. It never decides a note is false.
 *
 * Pure functions only — the storage around them is in index.js — so every one of these rules
 * can be argued with without a database or a model in the room.
 */

const DAY = 24 * 60 * 60 * 1000

/**
 * How long a time-bound note is trusted before it is checked: half a year, which is one
 * semester, and about as long as a job, a flat or a project goes unmentioned before it has
 * quietly changed. Too short and the panel fills with *may be out of date* on things that are
 * fine; too long and a finished degree is read back as current for a year.
 */
export const REVIEW_AFTER = 180 * DAY

/**
 * How often the gardener may run at most. A week: nothing it looks at changes faster than
 * that, and it is the only part of memory besides the sorting pass that may call a model.
 */
export const GARDEN_EVERY = 7 * DAY

/**
 * At most this many rewrites per pass, one model call each. A first pass over an old table
 * could otherwise be a hundred calls in one go; what is not reached this week is next week's.
 */
export const GARDEN_MOST = 10

/** A millisecond column as a number, or `null`. Storage hands back null, '' or a string. */
export const when = (value) => (value === null || value === undefined || value === '' ? null : Number(value))

/** Still true, as far as anybody knows: never closed. Rows older than the column read null. */
export const valid = (row) => when(row?.invalid_at) === null

/** Marked by the gardener as possibly no longer true, and not confirmed since. */
export const stale = (row) => when(row?.stale_since) !== null

/** Storage hands a boolean back as 1 or 0, and older rows have no such column at all. */
export const timeBound = (row) => row?.time_bound === true || Number(row?.time_bound) === 1

/** The notes whose review has come: valid, with a `review_at` that has passed. Oldest due first. */
export function due(rows, now) {
  return rows
    .filter((row) => valid(row) && when(row.review_at) !== null && when(row.review_at) <= now)
    .sort((a, b) => when(a.review_at) - when(b.review_at) || Number(a.rowid ?? 0) - Number(b.rowid ?? 0))
}

/**
 * Words whose meaning depends on when they are read, English and Czech.
 *
 * Matched on the text lower-cased and without accents, so *teď* and *ted*, *momentálně* and
 * *momentalne* are one entry each — people type Czech on English keyboards. Whole words only:
 * *now* is relative, *know* and *snow* are not.
 *
 * Honest about its limits: it is a list, and it will miss phrasings that are not on it and
 * catch the odd *now* that was harmless. A miss costs nothing but a note left marked *may be
 * out of date* instead of rewritten; a false hit costs one model call whose answer is then
 * checked (`rewrite`). Both are cheap, which is why this is a list and not a parser.
 */
const RELATIVE = [
  // English.
  /currently|current|right now|at the moment|at present|presently|these days|nowadays|now/,
  /recently|lately|today|tonight|tomorrow|yesterday|soon/,
  /(?:this|next|last|coming) (?:year|semester|term|month|week|summer|winter|spring|autumn|fall|season)/,
  /(?:first|second|third|fourth|fifth|final|last|1st|2nd|3rd|4th|5th)[- ]year/,
  /freshman|sophomore|\d+ years? old|aged \d+/,
  // Czech.
  /letos\w*|ted|nyni|momentalne|aktualne|v soucasnosti|soucasne|zrovna|prave ted/,
  /dnes\w*|zitra|vcera|brzy|nedavno|loni|lonsk\w*/,
  /(?:tento|tenhle|letosni|pristi|minuly|minulej) (?:rok|semestr|mesic|tyden|rocnik)\w*/,
  /(?:prvn|druh|tret|ctvrt|pat|posledn)\w* (?:rocnik|semestr)\w*|prvak\w*|druhak\w*/,
  /je (?:mi|mu|ji) \d+/,
]
const fold = (text) =>
  String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
const WHOLE = RELATIVE.map((pattern) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern.source})(?![\\p{L}\\p{N}])`, 'u'))

export function relative(text) {
  const plain = fold(text)
  return WHOLE.some((pattern) => pattern.test(plain))
}

/**
 * What the free model is asked, for one note. Closed like the sorting prompt: one sentence
 * back, or `KEEP`, and a way to say *KEEP* is what makes treating anything else as an attempt
 * safe.
 */
export function rewritePrompt(note) {
  const written = new Date(Number(note.at)).toISOString().slice(0, 10)
  return [
    `This note about a person was written on ${written}:`,
    '',
    `  ${String(note.text)}`,
    '',
    'It uses words whose meaning depends on when it is read ("currently", "this year",',
    '"first-year", "letos", "teď"). Rewrite it as one sentence that says the same thing with',
    `absolute dates instead, counting from ${written}. For example, "is a first-year student at`,
    'ČVUT FEL" written on 2026-09-23 becomes "started studying at ČVUT FEL in September 2026".',
    'Keep the language the note is written in. Add nothing it does not say.',
    '',
    'If it cannot be done without guessing, answer KEEP. Answer with the sentence and nothing else.',
  ].join('\n')
}

/**
 * The model's rewrite, if it is one worth writing. `null` means keep the note as it is.
 *
 * **Code overrules the model here too**, for the reason written on `duplicate()` in capture.js:
 * a rewrite replaces the note it came from, so a model that wanders off the subject would
 * quietly swap a true sentence for an invented one. It is believed only if it:
 * - is a sentence, not `KEEP`, and not the note unchanged;
 * - no longer uses relative time, which was the whole point of asking;
 * - is not much longer than the note — a rewrite that doubled is a rewrite that added things;
 * - and shares at least a third of the shorter one's subject words with the original, the same
 *   bar the sorting pass holds a duplicate claim to (`OVERLAP` in capture.js, which imports
 *   from here, so the third is written again rather than imported back).
 */
export function rewrite(original, said) {
  const line =
    String(said ?? '')
      .split('\n')
      .map((one) => one.trim())
      .find((one) => one !== '') ?? ''
  const text = line.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim()
  const before = String(original ?? '').trim()
  if (text === '' || /^keep\W*$/i.test(text) || text === before) return null
  if (relative(text)) return null
  if (text.length > Math.max(300, before.length * 2)) return null
  const mine = content(text)
  const theirs = content(before)
  if (mine.size === 0 || theirs.size === 0) return null
  const shared = [...mine].filter((word) => theirs.has(word)).length
  return shared / Math.min(mine.size, theirs.size) >= 1 / 3 ? text : null
}

/**
 * Every version of the note `rowid` is one of, oldest first.
 *
 * Followed both ways along `replaced_by` and to every branch, so two notes that were both
 * replaced by one later note come back together. This is what `history` shows and — more
 * importantly — what forgetting takes: forgetting *where he lives* must take *where he lived
 * before* with it, or the forgotten thing is one `history` call away.
 */
export function chain(rows, rowid) {
  const byId = new Map(rows.map((row) => [Number(row.rowid), row]))
  const start = byId.get(Number(rowid))
  if (!start) return []
  const seen = new Set([Number(start.rowid)])
  const queue = [start]
  while (queue.length > 0) {
    const row = queue.shift()
    const next = [
      byId.get(when(row.replaced_by)),
      ...rows.filter((other) => when(other.replaced_by) === Number(row.rowid)),
    ]
    for (const one of next) {
      if (!one || seen.has(Number(one.rowid))) continue
      seen.add(Number(one.rowid))
      queue.push(one)
    }
  }
  const from = (row) => when(row.valid_from) ?? Number(row.at ?? 0)
  return [...seen]
    .map((id) => byId.get(id))
    .sort((a, b) => from(a) - from(b) || Number(a.rowid) - Number(b.rowid))
}
