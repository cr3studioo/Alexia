// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The command palette's ranking, and what it searches (M6-10).
 *
 * Ctrl+K, type, jump. Eight tabs is where a tab bar stops being navigation, and the
 * predecessor added one at exactly that point.
 *
 * **One search over each source's existing read path.** The rows this ranks are the rows the
 * panels themselves show — there is no second index, so there is nothing to keep in step with
 * four sources of truth, and a thing that has just been forgotten is gone from the palette by
 * the same act that removed it.
 *
 * **No dependency, and about fifteen lines of it.** Exact beats starts-with beats substring
 * beats subsequence. This is ranking four short in-memory lists, not tuning relevance, and
 * anything cleverer would be a library carried for a text box.
 *
 * **It navigates; it does not execute.** Slash commands already run things (M1-12), and
 * M1-12's own rule is that every command has a control somewhere. A palette that also ran
 * things would be a second command system with a different permission story — so this one
 * finds a thing and opens the tab it lives on, with the filter already typed.
 */

/** Every letter of `needle`, in order, somewhere in `hay`. The loosest match that is still one. */
function subsequence(needle: string, hay: string): boolean {
  let at = 0
  for (const letter of hay) if (letter === needle[at]) at++
  return at === needle.length
}

/**
 * How well one string answers another. Zero is no match at all.
 *
 * The shape of the ladder matters more than the numbers: a shorter thing that starts with
 * what you typed beats a longer one, and a match near the front beats one buried in the
 * middle — which is what makes typing three letters land on the thing you meant.
 */
export function score(needle: string, hay: string): number {
  const n = needle.trim().toLowerCase()
  const h = hay.toLowerCase()
  if (n === '' || h === '') return 0
  if (h === n) return 100
  if (h.startsWith(n)) return 80 - Math.min(h.length - n.length, 19)
  const at = h.indexOf(n)
  if (at !== -1) return 60 - Math.min(at, 19)
  return subsequence(n, h) ? 30 : 0
}

export interface Hit {
  /** The tab to open. Core's own are bare words; a plugin's is `plugin:<id>`. */
  tab: string
  /** What sort of thing this is, in the words the screen uses for it. */
  kind: string
  label: string
  /** The second line: enough to tell two things of the same name apart. */
  detail?: string
  score: number
}

export interface Searchable {
  tab: string
  kind: string
  label: string
  detail?: string
}

/** How many come back. A palette that fills the screen is a list, and a list is the tab bar. */
export const MOST = 8

/**
 * Rank, merge, cut.
 *
 * The label is what somebody is typing at; the detail counts for less because it is the line
 * they read *after* finding the row rather than the one they aimed at.
 */
export function search(query: string, over: readonly Searchable[]): Hit[] {
  const asked = query.trim()
  if (asked === '') return []
  return over
    .map((one) => ({
      ...one,
      score: Math.max(score(asked, one.label), one.detail === undefined ? 0 : score(asked, one.detail) - 25),
    }))
    .filter((one) => one.score > 0)
    // Ties broken by label, so the same query gives the same order every time. A palette
    // whose second and third rows swap between keystrokes is one nobody trusts to Enter on.
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, MOST)
}
