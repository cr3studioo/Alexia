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
