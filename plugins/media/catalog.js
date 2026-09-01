// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The workflows somebody could have, as opposed to the ones they do.
 *
 * **ComfyUI already ships the catalogue, and it is richer than a list of names.**
 * `GET /templates/index.json` on the running server answers with grouped entries carrying a
 * title, a description, tags, the models each needs, **how much video memory it wants**, and
 * whether it is open source or calls a paid service. Nothing has to be scraped, mirrored, or
 * kept up to date: it arrives with ComfyUI and moves when ComfyUI moves.
 *
 * **The counts are the reason this file filters before it ranks.** Measured against the live
 * index and the card in this machine:
 *
 * | | |
 * |---|---|
 * | in the catalogue | 468 |
 * | call a paid service | **255** |
 * | open source | 213 |
 * | **fit an 8.5 GB card** | **45** |
 * | of those, make images | **4** |
 *
 * A shelf of 468 that presents 468 is a shelf where five in six things disappoint — either by
 * asking for a card the person does not have, or by asking for a credit card. Filtering is not
 * tidying here; it is the difference between a library and a list.
 */

/** Every entry, flattened out of the groups, with the group kept as its category. */
export function flatten(index) {
  if (!Array.isArray(index)) return []
  return index.flatMap((group) =>
    (group?.templates ?? []).map((one) => ({
      name: String(one?.name ?? ''),
      title: String(one?.title ?? one?.name ?? ''),
      description: String(one?.description ?? ''),
      tags: Array.isArray(one?.tags) ? one.tags.map(String) : [],
      models: Array.isArray(one?.models) ? one.models.map(String) : [],
      category: String(group?.title ?? 'Other'),
      // `openSource: false` is how the index marks the ones that call somebody's paid API.
      // Absent means open source, which is the safe reading: a missing flag must not make
      // something look free.
      paid: one?.openSource === false,
      vram: Number.isFinite(Number(one?.vram)) && Number(one.vram) > 0 ? Number(one.vram) : undefined,
      rank: Number(one?.searchRank) || 0,
    })),
  )
}

/**
 * What this machine can actually run.
 *
 * **`undefined` vram is kept rather than dropped.** Fifteen of the 468 do not say what they
 * want, and hiding something because its author left a field blank would be punishing the
 * entry for the catalogue's gap. It runs or it does not, and finding out costs one attempt.
 */
export function runnable(entries, { vram, paid = false } = {}) {
  return entries.filter((one) => {
    if (one.paid && !paid) return false
    if (one.vram === undefined || vram === undefined) return true
    return one.vram <= vram
  })
}

const WORDS = /[^a-z0-9]+/

/**
 * Search, scored rather than filtered.
 *
 * A person asks for *remove the background*, and the entry that matches is called *BiRefNet
 * Background Removal* — so every word is looked for in every field, and where it is found
 * decides how much it is worth. The title is what somebody reads first and is weighted like it.
 */
export function search(entries, asked, limit = 8) {
  const words = String(asked ?? '')
    .toLowerCase()
    .split(WORDS)
    .filter((one) => one.length > 2)
  if (words.length === 0) return []
  const scored = entries.map((one) => {
    const title = one.title.toLowerCase()
    const tags = one.tags.join(' ').toLowerCase()
    const body = one.description.toLowerCase()
    let score = 0
    let prose = 0
    for (const word of words) {
      if (title.includes(word)) score += 10
      if (tags.includes(word)) score += 6
      if (one.models.join(' ').toLowerCase().includes(word)) score += 4
      if (body.includes(word)) {
        score += 1
        prose += 1
      }
    }
    // The catalogue's own idea of what is worth showing, as a nudge rather than a verdict.
    return { ...one, prose, score: score > 0 ? score + Math.min(one.rank, 5) / 10 : 0 }
  })
  // **A floor, and it is the difference between useful and annoying.** Without one, *read this
  // out loud* came back — measured against the real catalogue — with depth estimation and an
  // anime model, entries that shared a stray word with a paragraph and nothing a person would
  // call a match. Nothing is the right answer far more often than the fourth-best guess is.
  //
  // Six is one tag hit or better, so an answer normally has to agree with the *subject*. The
  // second clause is there because the first alone was too blunt: *make a picture from words*
  // is what somebody says and *Text to Image* is what the thing is called, sharing no word at
  // all — but a description matching three of somebody's words is agreement, not coincidence.
  return scored
    .filter((one) => one.score >= 6 || one.prose >= 3)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit)
}

const gb = (n) => `${(n / 1e9).toFixed(1)} GB`

/** One entry, as a line somebody can decide from. */
export const describe = (one) =>
  `${one.title} — ${one.category.toLowerCase()}${one.vram ? `, wants ${gb(one.vram)}` : ''}${one.paid ? ', **calls a paid service**' : ''}` +
  `${one.models.length > 0 ? `, needs ${one.models.join(', ')}` : ''}`

/**
 * What the whole shelf looks like from this machine, in numbers that are true rather than
 * impressive.
 *
 * Saying *468 workflows* to somebody whose card can run 45 of them is a sentence that is
 * accurate and misleading, which is the combination this project has the least room for.
 */
export function shelf(entries, vram) {
  const open = entries.filter((one) => !one.paid)
  const fits = runnable(entries, { vram })
  return {
    total: entries.length,
    paid: entries.length - open.length,
    open: open.length,
    fits: fits.length,
    said:
      vram === undefined ?
        `${entries.length} workflows ship with ComfyUI, ${open.length} of them open source.`
      : `${entries.length} workflows ship with ComfyUI. ${entries.length - open.length} call paid services and are hidden; ` +
        `of the ${open.length} open-source ones, **${fits.length} fit your ${gb(vram)} card**.`,
  }
}
