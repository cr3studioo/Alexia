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
 * **No dependency, and a few dozen lines of it.** Exact beats starts-with beats a word that
 * starts with it beats every word typed starting a word, and a one-letter slip comes last.
 * This is ranking a few short in-memory lists, not tuning relevance, and anything cleverer
 * would be a library carried for a text box.
 *
 * **Words, not letters.** It used to take any letters in order anywhere, so *hey* found a
 * skill with an h, an e and a y somewhere in its long name — a match nobody meant and the
 * reason the palette felt random. And *edit* sat inside *credit*. A match now has to begin
 * where a word begins.
 *
 * **It navigates; it does not execute.** Slash commands already run things (M1-12), and
 * M1-12's own rule is that every command has a control somewhere. A palette that also ran
 * things would be a second command system with a different permission story — so this one
 * finds a thing and opens the tab it lives on, with the filter already typed.
 */

/** The words of a name. Underscores, dashes, dots and slashes are seams, as spaces are. */
const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word !== '')

/**
 * Whether `typed` is `word`'s beginning with one slip in it: a letter wrong, missing, extra,
 * or two swapped. Three letters is the least that may slip at all, and at three only a swap
 * counts — one wrong letter in three is a different word, not a typo.
 */
function nearlyStarts(typed: string, word: string): boolean {
  if (typed.length < 3) return false
  for (const size of [typed.length, typed.length - 1, typed.length + 1]) {
    if (size < 2 || size > word.length) continue
    const start = word.slice(0, size)
    if (typed.length === 3 ? swapped(typed, start) : oneEdit(typed, start)) return true
  }
  return false
}

/** Two neighbouring letters swapped and nothing else. */
function swapped(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  const at = [...a].findIndex((letter, index) => letter !== b[index])
  return at !== -1 && at < a.length - 1 && a[at] === b[at + 1] && a[at + 1] === b[at] && a.slice(at + 2) === b.slice(at + 2)
}

/** At most one letter wrong, missing, extra — or two neighbours swapped. */
function oneEdit(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  if (a.length === b.length) {
    const wrong = [...a].filter((letter, index) => letter !== b[index]).length
    return wrong === 1 || swapped(a, b)
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a]
  const at = [...short].findIndex((letter, index) => letter !== long[index])
  return at === -1 || short.slice(at) === long.slice(at + 1)
}

/**
 * How well one string answers another. Zero is no match at all.
 *
 * The shape of the ladder matters more than the numbers: a shorter thing that starts with
 * what you typed beats a longer one, and a word near the front beats one buried in the
 * middle — which is what makes typing three letters land on the thing you meant.
 */
export function score(needle: string, hay: string): number {
  const n = needle.trim().toLowerCase()
  const h = hay.trim().toLowerCase()
  if (n === '' || h === '') return 0
  if (h === n) return 100
  if (h.startsWith(n)) return 80 - Math.min(h.length - n.length, 19)
  const words = wordsOf(h)
  const typed = wordsOf(n)
  if (typed.length === 0) return 0
  // What was typed, whole, starting a word further in: *layout* in *Edit layout*.
  const at = words.findIndex((_, index) => words.slice(index).join(' ').startsWith(typed.join(' ')))
  if (at !== -1) return 60 - Math.min(at * 3, 19)
  // Every word typed starts one of its words, in any order: *money spend* finds
  // *spending money*.
  if (typed.every((one) => words.some((word) => word.startsWith(one)))) return 40
  // The same, with room for one slip in each word of three letters or more.
  if (typed.every((one) => words.some((word) => word.startsWith(one) || nearlyStarts(one, word)))) return 25
  return 0
}

/**
 * A tool's id as a name somebody reads: `accept_suggestion` is *Accept suggestion*. Only the
 * seams are taken out — the words are the author's, and guessing better ones would be core
 * writing about a plugin it knows nothing of.
 */
export const friendly = (id: string): string => {
  const plain = id.replace(/[_.]+|-+/g, ' ').replace(/\s+/g, ' ').trim()
  return plain.charAt(0).toUpperCase() + plain.slice(1)
}

/** What a hit carries besides its name: where it lives, and what to do once there. */
interface Where {
  /**
   * Where to go. Core's own sections are bare words, a Settings page is its page name, and
   * `chat` is one conversation, opened by {@link Where.id}.
   */
  tab: string
  /** What sort of thing this is, in the words the screen uses for it. */
  kind: string
  label: string
  /** The second line: enough to tell two things of the same name apart. */
  detail?: string
  /**
   * What to type into the list it lives in, so the list shows this row. Its own name as that
   * list writes it — a tool's is `accept_suggestion` there even though the palette says
   * *Accept suggestion*. Absent for a page, which has no list to narrow.
   */
  filter?: string
  /** For a chat, which one. */
  id?: string
}

export type Hit = Where & { score: number }

export interface Searchable extends Where {
  /**
   * Other words for it, never shown: *dark* for the theme, *budget* for money. A setting is
   * looked for by what it does as often as by what it is called.
   */
  words?: string[]
}

/** How many come back. A palette that fills the screen is a list, and a list is the tab bar. */
export const MOST = 8

/**
 * The Settings a person looks for by name (Round 1 ideas). Not rows of any table — these are
 * places on the Settings screen, so there is nothing to read them from, and the list is here
 * with the ranking rather than in the shell so they rank alongside everything else. `tab` is
 * the Settings page each one is on.
 */
export const SETTINGS: readonly Searchable[] = [
  { tab: 'general', kind: 'setting', label: 'Theme', detail: 'Settings › General', words: ['dark', 'light', 'appearance', 'colour', 'color', 'mode'] },
  { tab: 'general', kind: 'setting', label: 'Her name', detail: 'Settings › General', words: ['name', 'rename', 'call', 'alexia'] },
  { tab: 'general', kind: 'setting', label: 'Panel glass', detail: 'Settings › General', words: ['transparency', 'blur', 'see through'] },
  { tab: 'general', kind: 'setting', label: 'Glass look', detail: 'Settings › General', words: ['liquid glass', 'apple glass', 'switches'] },
  { tab: 'general', kind: 'setting', label: 'Start at login', detail: 'Settings › General', words: ['sign in', 'startup', 'autostart', 'launch', 'boot'] },
  { tab: 'general', kind: 'setting', label: 'Keyboard shortcut', detail: 'Settings › General', words: ['hotkey', 'shortcut', 'keys'] },
  { tab: 'models', kind: 'setting', label: 'Keys and providers', detail: 'Settings › Models & money', words: ['api key', 'provider', 'connect', 'openrouter', 'token'] },
  { tab: 'models', kind: 'setting', label: 'Where she runs', detail: 'Settings › Models & money', words: ['local', 'cloud', 'combined', 'mode'] },
  { tab: 'models', kind: 'setting', label: 'Money and spending', detail: 'Settings › Models & money', words: ['spend', 'cost', 'price', 'paid', 'free', 'daily allowance', 'budget'] },
  { tab: 'safety', kind: 'setting', label: 'Monthly budget', detail: 'Settings › Safety', words: ['money', 'spend', 'cap', 'limit', 'month'] },
  { tab: 'safety', kind: 'setting', label: 'What she may do', detail: 'Settings › Safety', words: ['permission', 'permissions', 'safety', 'allow', 'access'] },
  { tab: 'safety', kind: 'setting', label: 'Most steps in one task', detail: 'Settings › Safety', words: ['limit', 'ceiling', 'loop'] },
  { tab: 'safety', kind: 'setting', label: 'Ask before a costly task', detail: 'Settings › Safety', words: ['ask first', 'confirm', 'cost', 'money'] },
  { tab: 'plugins', kind: 'setting', label: 'Plugins', detail: 'Settings › Plugins', words: ['extensions', 'install', 'add'] },
  { tab: 'about', kind: 'setting', label: 'About Alexia', detail: 'Settings › About', words: ['version', 'licence', 'license', 'source'] },
  { tab: 'about', kind: 'setting', label: 'Updates', detail: 'Settings › About', words: ['update', 'upgrade', 'new version', 'release'] },
]

/**
 * Rank, merge, cut.
 *
 * The label is what somebody is typing at; the detail counts for less because it is the line
 * they read *after* finding the row rather than the one they aimed at, and the unseen other
 * words count for no more than a word inside the label would.
 */
export function search(query: string, over: readonly Searchable[]): Hit[] {
  const asked = query.trim()
  if (asked === '') return []
  return over
    .map(({ words, ...one }) => ({
      ...one,
      score: Math.max(
        score(asked, one.label),
        one.detail === undefined ? 0 : score(asked, one.detail) - 25,
        words === undefined ? 0 : Math.min(score(asked, [one.label, ...words].join(' ')), 55),
      ),
    }))
    .filter((one) => one.score > 0)
    // Ties broken by label, so the same query gives the same order every time. A palette
    // whose second and third rows swap between keystrokes is one nobody trusts to Enter on.
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, MOST)
}
