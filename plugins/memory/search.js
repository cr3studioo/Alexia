// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Finding a remembered thing again.
 *
 * ponytail: keyword overlap, not embeddings. An embedding index means a model to run, a
 * vector to store per row, and a similarity search built on a storage API that has no
 * `ORDER BY distance` — three problems, to beat `LIKE` on a table that in practice holds
 * hundreds of short sentences rather than millions. **The upgrade path is real and
 * written down**: when recall measurably misses things a person expected, embed with the
 * local T0 model through `sampling`, keep the vector as a column, and rank here instead
 * of in SQL. Until somebody can point at a miss, this is the honest amount of machinery.
 *
 * What it does do properly is *rank*, because returning six rows in insertion order is how
 * a memory feature looks useless: the ranking is overlap first, then recency, and both are
 * needed — the most recent thing is rarely the most relevant, and the most relevant thing
 * from two years ago is rarely what somebody meant either.
 */

/**
 * Words worth matching on.
 *
 * A word is letters and digits in any script, so "ČVUT" stays "čvut" rather than becoming
 * "vut", and every accented word is also kept without its accents — "čvut" and "cvut",
 * "václav" and "vaclav" — because people type Czech on English keyboards and the row was
 * written by whoever wrote it. NFKC first, so the same letter typed two ways is one letter.
 *
 * The stop lists are short, English and Czech, and that is a stated limit rather than an
 * oversight — they exist so that "what did I say about the car" does not match every row
 * containing "the", and "jak jsem to říkal" every row containing "jsem". They are compared
 * without accents, so "kdyz" is as dead as "když"; the Czech one leaves out the words whose
 * bare form is an English word or a name worth finding (ten, tom, tím, mít, nás). A word
 * that survives is at least three characters, because two-letter tokens match everything
 * and rank nothing.
 */
const fold = (word) => word.normalize('NFD').replace(/\p{M}/gu, '')

const STOP = new Set(
  [
    'the', 'and', 'for', 'was', 'were', 'that', 'this', 'with', 'from', 'have', 'has', 'had',
    'what', 'when', 'where', 'which', 'who', 'about', 'did', 'does', 'you', 'your', 'are',
    'not', 'but', 'all', 'any', 'can', 'get', 'got', 'his', 'her', 'its', 'our', 'their',
    'there', 'they', 'them', 'then', 'than', 'been', 'being', 'into', 'over', 'more', 'most',
    'some', 'such', 'only', 'own', 'same', 'too', 'very', 'just', 'now', 'also',
    // Czech.
    'jsem', 'jsi', 'jsme', 'jste', 'jsou', 'jak', 'ale', 'pro', 'jako', 'nebo', 'také',
    'když', 'který', 'která', 'které', 'jeho', 'její', 'tak', 'jen', 'ještě', 'byl', 'byla',
    'bylo', 'být', 'mám', 'máš', 'než', 'pak', 'kde', 'proč', 'aby', 'však', 'sem', 'tam',
    'vás', 'mně', 'můj', 'moje', 'tvůj', 'tady',
  ].map(fold),
)

/**
 * Each surviving word with its spellings: `[word]`, or `[word, unaccented]`. Kept grouped so
 * that ranking counts "Václav" once, not once per spelling.
 */
function terms(text) {
  const seen = new Map()
  for (const word of String(text).normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}']+/u)) {
    if (seen.has(word) || [...word].length < 3) continue
    const bare = fold(word)
    if (STOP.has(bare)) continue
    seen.set(word, bare === word ? [word] : [word, bare])
  }
  return [...seen.values()]
}

export function words(text) {
  return [...new Set(terms(text).flat())]
}

/**
 * The words that say what a note is *about*, as a set.
 *
 * `words` minus the ones every note about a person shares: *user*, *wants*, *prefers*. Those
 * are true of half the table, so two notes sharing one of them says nothing about whether they
 * are on the same subject — and "are these two about the same thing" is what both the seed's
 * repeat check (`profile.js`) and the replace check (`capture.js`) are asking.
 */
const COMMON = new Set(['user', "user's", 'users', 'assistant', 'alexia', 'wants', 'prefers', 'likes', 'she', 'him'])
export const content = (text) => new Set(words(text).filter((word) => !COMMON.has(word)))

/** The first five letters, which is where a Czech word keeps its meaning. */
const stem = (word) => [...word].slice(0, 5).join('')

/** A day, for the recency half of the score. */
const DAY = 24 * 60 * 60 * 1000

/**
 * Score and order.
 *
 * Overlap dominates: a row matching three of the asked-for words beats a row matching one,
 * whatever their ages. Recency only separates rows that matched equally well, and it decays
 * slowly — something said a year ago is still something you said, and a memory that forgets
 * it in favour of yesterday's noise is worse than no memory.
 *
 * ponytail: Czech bends its words — "programování" in the question, "programovat" in the
 * row — and a stemmer is a dictionary this does not carry. So an asked word of six letters
 * or more that did not hit exactly counts half if a row word starts with the same five. Half,
 * so that one lucky prefix ("prázdniny" for "prázdný") never qualifies a row alone: it takes
 * one exact word or two bent ones.
 */
export function rank(rows, asked, now = Date.now()) {
  const wanted = terms(asked)
  if (wanted.length === 0) return []
  return rows
    .map((row) => {
      const has = new Set(words(row.text))
      const stems = new Set([...has].filter((word) => [...word].length >= 5).map(stem))
      let overlap = 0
      for (const forms of wanted) {
        if (forms.some((word) => has.has(word))) overlap += 1
        else if (forms.some((word) => [...word].length >= 6 && stems.has(stem(word)))) {
          overlap += 0.5
        }
      }
      const age = Math.max(0, now - Number(row.at ?? 0)) / DAY
      // The half-life is a year. It is a knob, and it is the first thing to turn if recall
      // starts feeling stale rather than wrong.
      return { row, overlap, score: overlap + 1 / (1 + age / 365) }
    })
    .filter((scored) => scored.overlap >= 1)
    .sort((a, b) => b.score - a.score)
    .map((scored) => scored.row)
}

/**
 * Finding by meaning (P3-13): the upgrade the header of this file wrote down.
 *
 * Each fact may carry a vector, a column `vec` holding a JSON array, made by the host's
 * `text.embed`. Ranking stays here, in code, over the whole table — there is still no
 * `ORDER BY distance` to lean on, and a few hundred rows do not need one.
 *
 * The keyword ranking above is kept, and is what runs when nothing can embed text (no GPU, no
 * provider): `rank` is untouched, and `rankByMeaning` is only asked for when a vector for the
 * question exists. A fact with no vector yet — written before this, or waiting for the
 * backfill — still competes on its words.
 */

/** Weights of the blended score. Meaning first, words second, recency only to separate. */
export const WEIGHT = { meaning: 0.6, words: 0.3, recency: 0.1 }

/** Below this similarity, with no shared word, a fact is not an answer. */
export const FLOOR = 0.25

/** Decimal places a stored vector keeps; five is far below what changes a ranking. */
const PLACES = 5

/** A vector as it is stored: a JSON array of numbers, rounded. `null` when it is not one. */
export function pack(vector) {
  if (!Array.isArray(vector) || vector.length === 0) return null
  if (!vector.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  const scale = 10 ** PLACES
  return JSON.stringify(vector.map((n) => Math.round(n * scale) / scale))
}

/** A stored vector read back: an array of numbers, or `null` for a row that has none. */
export function unpack(stored) {
  let vector = stored
  if (typeof stored === 'string') {
    try {
      vector = JSON.parse(stored)
    } catch {
      return null
    }
  }
  return Array.isArray(vector) && vector.length > 0 && vector.every((n) => typeof n === 'number' && Number.isFinite(n))
    ? vector
    : null
}

/**
 * Cosine similarity of two plain arrays, clamped to 0..1: the opposite of a sentence is not
 * "less than nothing" for ranking purposes. Vectors of different lengths came from different
 * models and are not comparable, so they are 0 rather than an error; the same for a zero vector.
 */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return Math.min(1, Math.max(0, dot / Math.sqrt(na * nb)))
}

/** How many of the asked-for words a row hit, as v2 counted them: exact 1, bent Czech 0.5. */
function overlapOf(row, wanted) {
  const has = new Set(words(row.text))
  const stems = new Set([...has].filter((word) => [...word].length >= 5).map(stem))
  let overlap = 0
  for (const forms of wanted) {
    if (forms.some((word) => has.has(word))) overlap += 1
    else if (forms.some((word) => [...word].length >= 6 && stems.has(stem(word)))) overlap += 0.5
  }
  return overlap
}

/**
 * `score = 0.6 * cosine + 0.3 * keyword + 0.1 * recency`, ties by newest.
 *
 * `keyword` is v2's overlap divided by the number of words asked, so 0..1. A fact is returned
 * when it has at least one keyword hit (v2's bar) or a cosine of at least `FLOOR`; one with
 * neither is not an answer, and nothing matching comes back as nothing, not as everything.
 */
export function rankByMeaning(rows, asked, vector, now = Date.now()) {
  const wanted = terms(asked)
  const mine = unpack(vector)
  if (mine === null) return rank(rows, asked, now)
  return rows
    .map((row) => {
      const meaning = cosine(mine, unpack(row.vec))
      const overlap = wanted.length === 0 ? 0 : overlapOf(row, wanted)
      const age = Math.max(0, now - Number(row.at ?? 0)) / DAY
      const recency = 1 / (1 + age / 365)
      const score =
        WEIGHT.meaning * meaning + WEIGHT.words * Math.min(1, overlap / Math.max(1, wanted.length)) + WEIGHT.recency * recency
      return { row, meaning, overlap, score }
    })
    .filter((scored) => scored.overlap >= 1 || scored.meaning >= FLOOR)
    .sort((a, b) => b.score - a.score || Number(b.row.at ?? 0) - Number(a.row.at ?? 0))
    .map((scored) => scored.row)
}

/**
 * Where a fact came from, as a phrase to put after it: *you said it on Telegram, 12 Nov*,
 * *worked out rather than said, from a Telegram chat on 3 Oct*, *from “Thesis plan.docx”*.
 *
 * Built from what the row actually has — a fact written before any of this has no channel and
 * says only *you said it, 12 Nov* — and never from a guess. The year is shown only when it is
 * not this year, so a recent line stays short.
 */
const CHANNELS = { window: ' in the Alexia window', telegram: ' on Telegram', whatsapp: ' on WhatsApp', imessage: ' on iMessage' }
const NAMES = { window: 'Alexia window', telegram: 'Telegram', whatsapp: 'WhatsApp', imessage: 'iMessage' }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const shortDay = (ms, now) => {
  const at = new Date(Number(ms))
  if (Number.isNaN(at.getTime())) return ''
  const year = at.getUTCFullYear() === new Date(now).getUTCFullYear() ? '' : ` ${at.getUTCFullYear()}`
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}${year}`
}

const title = (channel) => String(channel).replace(/^./u, (c) => c.toUpperCase())

export function sourceOf(row, now = Date.now()) {
  const when = shortDay(row.at, now)
  const doc = String(row.src_doc ?? '').trim()
  if (doc !== '') return `from “${doc}”`
  const channel = String(row.src_channel ?? '').trim().toLowerCase()
  if (row.source === 'inferred') {
    const chat = channel === '' ? 'a chat' : `a ${NAMES[channel] ?? title(channel)} chat`
    // Keeps v2's own words, which a test in core reads, and adds where and when.
    return `worked out rather than said, from ${chat}${when === '' ? '' : ` on ${when}`}`
  }
  const via = channel === '' ? '' : (CHANNELS[channel] ?? ` on ${title(channel)}`)
  return `you said it${via}${when === '' ? '' : `, ${when}`}`
}

/**
 * The columns that say where a new fact came from, from what the host handed over. Only keys
 * that are known: writing `null` to a column that does not exist yet would create it as text
 * (see `cleared` in index.js), and a session number written as text is a bug in waiting.
 */
export function originFields(origin) {
  const out = {}
  const channel = typeof origin?.channel === 'string' ? origin.channel.trim().toLowerCase() : ''
  if (channel !== '' && channel.length <= 40) out.src_channel = channel
  const session = Number(origin?.session)
  if (origin?.session !== undefined && origin?.session !== null && Number.isInteger(session) && session >= 0) out.src_session = session
  const doc = typeof origin?.doc === 'string' ? origin.doc.trim() : ''
  if (doc !== '') out.src_doc = doc.slice(0, 200)
  return out
}
