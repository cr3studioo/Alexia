// SPDX-License-Identifier: AGPL-3.0-only
import { valid } from './garden.js'
import { content } from './search.js'

/**
 * The profile: the few notes Alexia reads before every task, rather than when it thinks to ask.
 *
 * `recall` is a search, and a search only finds what somebody thought to look for — nobody
 * searches for *what is this person's name* or *which language do they want answers in*
 * before saying hello. So a handful of notes are **pinned**, and core reads them once per task
 * through `memory.profile` and puts them in the system prompt.
 *
 * **Small on purpose.** Everything here is paid for in every prompt, forever, so it is capped
 * (`CAP`) and the cap drops whole lines, never half a sentence — half a sentence in a system
 * prompt is an instruction nobody wrote.
 *
 * Pure functions only, so the rules can be argued with without a database in the room.
 */

/** Characters, roughly a hundred and fifty tokens. A profile, not a biography. */
export const CAP = 600

/**
 * The profile text: pinned notes, one per line, cut to `cap` by dropping whole lines.
 *
 * **Who they are comes first, whatever its age.** The order is the priority, and newest-first
 * alone put the owner's name on the last line of a full profile, where the next pin would
 * have pushed it out — the one line a profile exists to carry. So the name, then the
 * language, then everything else; `stated` before `inferred` within each, newest first.
 *
 * A line that does not fit is skipped rather than ending the list, so one long note cannot
 * crowd out three short ones behind it. The order is still the priority: what is dropped is
 * always the thing further down.
 *
 * Inferred notes only get here by a person pinning one by hand — the sorting pass never pins
 * (see `tick` in index.js) — and they still sort after everything that was said out loud.
 */
export function profile(rows, cap = CAP) {
  // A note that is no longer true stays in the table as history and never reaches a prompt.
  // Checked here as well as by the caller, because this is the one read that is in every prompt.
  const pinned = rows.filter((row) => pinnedOf(row) && valid(row))
  const newest = (a, b) => Number(b.at ?? 0) - Number(a.at ?? 0) || Number(b.rowid ?? 0) - Number(a.rowid ?? 0)
  const said = (row) => (row.source === 'inferred' ? 1 : 0)
  const ordered = pinned.sort((a, b) => tier(a) - tier(b) || said(a) - said(b) || newest(a, b))
  const lines = []
  let used = 0
  for (const row of ordered) {
    const text = cityOnly(String(row.text ?? '')).trim()
    if (text === '') continue
    const line = `- ${text}`
    // +1 for the newline that joins it to the one before.
    const cost = line.length + (lines.length === 0 ? 0 : 1)
    if (used + cost > cap) continue
    lines.push(line)
    used += cost
  }
  return lines.join('\n')
}

/** Where a note sits in the profile's order: its name, then its language, then the rest. */
const NAMED = [/(?:^|\s)(?:my|his|her|their|the user['’]s|user['’]s) name is\b/i, /\b(?:is called|goes by|wants to be called)\s+\p{Lu}/u]
const SPOKEN = /\blanguage is\b/i
function tier(row) {
  const text = String(row?.text ?? '')
  if (NAMED.some((pattern) => pattern.test(text))) return 0
  return SPOKEN.test(text) ? 1 : 2
}

/** Storage hands a boolean back as 1 or 0, and older rows have no such column at all. */
export const pinnedOf = (row) => row?.pinned === true || Number(row?.pinned) === 1

/**
 * Where somebody lives, to the city and no further.
 *
 * **The owner's rule**: the profile goes into every prompt, to whichever model answers, so it
 * says *Prague* and not *Praha 6* and never a street. The note itself is untouched — `recall`
 * still reads it whole when somebody actually asks — this only shapes what is sent every time.
 *
 * Honest about its limits: it knows the Prague districts in Czech and English (`Praha 6`,
 * `Praze 6`, `Prague 6`, with or without `-Dejvice` after them), a Czech address with a
 * house number like `Vinohradská 1234/56`, and an English one ending in Street/Road/Avenue.
 * It drops a five-digit postcode wherever it is, which will one day take a five-digit number
 * that was not one. It does not know other cities' districts, or an address written any other way.
 * Those are the cases that matter for the one person using it today; the day that changes,
 * this is a list to extend rather than a parser to write.
 */
export function cityOnly(text) {
  return (
    String(text ?? '')
      // Praha 6, Praze 6, Prahy 10, Prague 6, Praha 6-Dejvice, Prague 6 – Dejvice.
      .replace(/\b(Praha|Prahy|Praze|Prahu|Prahou|Prague)\s*\d{1,2}\b(?:\s*[-–]\s*\p{Lu}\p{Ll}+)?/gu, '$1')
      // A Czech address: a capitalised street name, one or two words, and a house number with
      // a slash — "Vinohradská 1234/56", "Na Příkopě 12/3".
      .replace(/(?<!\p{L})\p{Lu}\p{L}*(?:\s+\p{Lu}\p{L}*)?\s+\d+\/\d+\p{L}?/gu, '')
      // An English one: "221B Baker Street", "12 Long Road".
      .replace(/\b\d+\p{L}?\s+(?:\p{Lu}\p{L}*\s+){1,3}(?:Street|St\.|Road|Rd\.|Avenue|Ave\.|Lane|Boulevard|Drive)(?=\W|$)/gu, '')
      // A postcode, "160 00" or "16000". Below city level anyway — and the router's outbound
      // redaction reads a five-digit number just after a city as a postcode and takes the city
      // with it, so one left here would cost the profile the one place it is allowed to name.
      .replace(/(?<![\d/])\d{3} ?\d{2}(?![\d/])/g, '')
      // `"location": "Prague"` is blanked by that same redaction. A note is prose, but one that
      // came from pasted JSON loses its quotes around the key rather than its value.
      .replace(/"([\p{L}_]+)"\s*:/gu, '$1:')
      // What removing an address leaves behind: "lives at , Prague" and ", ," and " ."
      .replace(/\s+(?:at|on)\s*,\s*/g, ' in ')
      // …and the Czech one, "bydlím na , Praha", where the preposition goes with the street.
      .replace(/\s+(?:na|v|ve)\s*,\s*/g, ', ')
      .replace(/,\s*(?=[,.;]|$)/g, '')
      .replace(/\s+([,.;])/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim()
  )
}

/**
 * What the one-time seed pins from notes written before pinning existed.
 *
 * **Conservative, because it runs without anybody watching.** Only notes the person said
 * themselves (`stated`), and only sentences that are plainly about who they are and how to
 * talk to them. *Filed as a preference* used to be enough, and on the owner's own notes it
 * pinned a favourite colour and how a school essay should be laid out — true, and nothing a
 * model needs before every hello. A seed that pins too little costs one click in the panel; one
 * that pins too much puts a wrong sentence in every prompt until somebody notices.
 */
const IDENTITY = [
  ...NAMED,
  SPOKEN,
  /\bwants (?:the assistant|alexia|you|me) to\b/i,
  /\blives in\b/i,
  // How they want to be spoken to or taught, which is a preference that does apply every time.
  /\bprefers\b.*\b(?:tone|answers?|replies|instructions|explanations?|language|conversation\w*|step[- ]by[- ]step)\b/i,
  /\b(?:when being taught|wants\b.*\b(?:explained|explanations?|step[- ]by[- ]step))\b/i,
]

const OTHERS =
  /\b(?:dog|cat|pet|son|daughter|child|kids?|wife|husband|partner|girlfriend|boyfriend|friend|colleague|brother|sister|mother|father|mum|mom|dad|boss)\b/i

export function seedable(row) {
  if (row?.source === 'inferred') return false
  const text = String(row?.text ?? '')
  // "His dog is called Bruno" and "his wife prefers tea" are about somebody else. A sentence
  // that names another person or a pet is left for a person to pin, which is the cheap way
  // to keep the seed about *them* without parsing whose sentence it is.
  if (OTHERS.test(text)) return false
  return IDENTITY.some((pattern) => pattern.test(text))
}

/**
 * The seed's choices, minus sentences that mostly repeat one already chosen.
 *
 * The owner's notes said *the language is Czech* twice, once on its own and once with a
 * clause attached, and both went in — sixty characters of a six-hundred-character profile
 * spent saying one thing again. Newest wins, because a later sentence is the one said with
 * the earlier one already known. Words any profile line shares (*user*, *wants*) are not
 * evidence of a repeat and are left out of the count; what is left must overlap by half of
 * the shorter sentence, which is stricter than the sorting pass's third because a wrong
 * call here silently drops something from every prompt. The words are `content`'s, in
 * `search.js`, which the sorting pass's replace check shares.
 */
export function distinct(rows) {
  const kept = []
  const newestFirst = [...rows].sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0) || Number(b.rowid ?? 0) - Number(a.rowid ?? 0))
  for (const row of newestFirst) {
    const mine = content(row.text)
    const repeats = kept.some((other) => {
      const theirs = content(other.text)
      const shared = [...mine].filter((word) => theirs.has(word)).length
      return mine.size > 0 && theirs.size > 0 && shared / Math.min(mine.size, theirs.size) >= 0.5
    })
    if (!repeats) kept.push(row)
  }
  return kept
}
