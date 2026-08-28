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
 * The stop list is short and English and that is a stated limit rather than an oversight —
 * it exists so that "what did I say about the car" does not match every row containing
 * "the". A word that survives is at least three characters, because two-letter tokens match
 * everything and rank nothing.
 */
const STOP = new Set([
  'the', 'and', 'for', 'was', 'were', 'that', 'this', 'with', 'from', 'have', 'has', 'had',
  'what', 'when', 'where', 'which', 'who', 'about', 'did', 'does', 'you', 'your', 'are',
  'not', 'but', 'all', 'any', 'can', 'get', 'got', 'his', 'her', 'its', 'our', 'their',
  'there', 'they', 'them', 'then', 'than', 'been', 'being', 'into', 'over', 'more', 'most',
  'some', 'such', 'only', 'own', 'same', 'too', 'very', 'just', 'now', 'also',
])

export function words(text) {
  return [
    ...new Set(
      String(text)
        .toLowerCase()
        .split(/[^a-z0-9']+/)
        .filter((word) => word.length >= 3 && !STOP.has(word)),
    ),
  ]
}

/** A day, for the recency half of the score. */
const DAY = 24 * 60 * 60 * 1000

/**
 * Score and order.
 *
 * Overlap dominates: a row matching three of the asked-for words beats a row matching one,
 * whatever their ages. Recency only separates rows that matched equally well, and it decays
 * slowly — something said a year ago is still something you said, and a memory that forgets
 * it in favour of yesterday's noise is worse than no memory.
 */
export function rank(rows, asked, now = Date.now()) {
  const wanted = words(asked)
  if (wanted.length === 0) return []
  return rows
    .map((row) => {
      const has = new Set(words(row.text))
      const overlap = wanted.filter((word) => has.has(word)).length
      const age = Math.max(0, now - Number(row.at ?? 0)) / DAY
      // The half-life is a year. It is a knob, and it is the first thing to turn if recall
      // starts feeling stale rather than wrong.
      return { row, score: overlap + 1 / (1 + age / 365) }
    })
    .filter((scored) => scored.score >= 1)
    .sort((a, b) => b.score - a.score)
    .map((scored) => scored.row)
}
