// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The four rules a personality is not allowed to contain, enforced in code.
 *
 * **The brief already forbids these, and that is exactly why this exists.** A personality goes
 * straight into the system prompt in front of every decision the loop makes, so the document
 * is the one place where "the model was told not to" is not a control. The instruction in
 * `writing.js` stays — it stops most of them being written at all — but what actually gets
 * saved is decided here, by code that runs the same way every time, on a document nobody has
 * read yet.
 *
 * Four things, and only four, because each one hands away something that is not the
 * personality's to hand away:
 *
 * 1. **Skipping the ask.** The gate is how a person stays in front of anything with a
 *    consequence. A document that says *never ask* is a document that turns it off.
 * 2. **Hiding what she did.** The trace and the ledger are how anybody checks any of this.
 * 3. **Ignoring a limit.** Caps and policies are set outside the personality, on purpose.
 * 4. **Claiming to be human.** She is not, and a document does not get to say otherwise.
 *
 * Everything else a personality says about tone, habits, what to chase and what to call
 * somebody is left exactly as written. This removes four kinds of line, not opinions.
 */

/**
 * Written so the negation is inside the pattern, which is the whole difficulty.
 *
 * *Ask before anything with external consequence* is the single best line a personality can
 * contain, and *never ask before anything* is the worst. They differ by one word, and a
 * keyword list built on "ask" removes both. So every pattern below matches the refusal itself
 * — `never ask`, `without asking`, `no need to confirm` — and a line telling her **to** ask
 * matches nothing here.
 */
const SKIPPING = [
  /\b(?:do not|don'?t|never|dont)\s+(?:ask|confirm|check|clear|verify|wait for)\b/,
  /\bwithout\s+(?:asking|checking|confirming|permission|approval|clearance|consent|my ok)\b/,
  /\bskip(?:ping|s)?\s+(?:the\s+|any\s+)?(?:ask|asking|question|questions|confirmation|approval|permission|check|checks)\b/,
  /\bno\s+need\s+to\s+(?:ask|confirm|check|clear)\b/,
  /\b(?:assume|presume)\s+(?:yes|consent|approval|permission|i(?:'m| am)? ?ok)\b/,
  /\b(?:don'?t|do not|never)\s+bother\s+(?:asking|checking|confirming)\b/,
  /\bgo\s+ahead\s+without\b/,
]

/** Strong enough on its own: there is no innocent reading of these. */
const HIDING_ALONE = [
  /\bsecretly\b/,
  /\bkeep\s+(?:it|this|that|them)\s+(?:to yourself|quiet|secret|hidden)\b/,
  /\bwithout\s+(?:telling|informing|mentioning it to|saying anything to)\b/,
  /\bbehind\s+(?:my|their|his|her)\s+back\b/,
  /\bcover\s+(?:it|your tracks|them)\s*(?:up)?\b/,
]

/**
 * A hiding verb, paired with the thing being hidden.
 *
 * Paired rather than single because *don't mention emojis* is a style rule somebody is
 * entitled to write, and *don't mention what you ran* is not. The verb alone cannot tell them
 * apart; the object can.
 */
const HIDING_VERB =
  /\b(?:hide|conceal|obscure|disguise|suppress|omit|bury|(?:do not|don'?t|never)\s+(?:tell|mention|say|show|reveal|report|disclose|admit|log|record|surface))\b/
const HER_DOING =
  /\b(?:what you (?:did|do|ran|used|called|changed)|that you (?:did|ran|used|called|changed|are|have)|your (?:steps?|actions?|reasoning|tools?|work|process|calls?)|the (?:tools?|steps?|trace|log|ledger)|you (?:ran|used|called)|anything you (?:did|do|ran)|any of (?:it|this|that))\b/

const IGNORING = [
  // The words between the verb and the noun are the point: *ignore the monthly cap* is the
  // shape somebody actually writes, and *ignore* immediately followed by *cap* is not.
  /\b(?:ignore|disregard|bypass|override|circumvent|work around|get around)\s+(?:\w+\s+){0,3}?(?:limit|limits|cap|caps|budget|rule|rules|policy|policies|restriction|restrictions|guardrail|guardrails|safety|instruction|instructions|setting|settings)\b/,
  // No bare `caps` here: *no caps* is somebody asking her not to shout, and a check that
  // reads it as *no spending cap* removes a style rule and tells them it was a safety line.
  // The word only counts as a limit where a verb above put it beyond doubt.
  /\b(?:no|without)\s+(?:\w+\s+){0,2}?(?:limits?|restrictions?|guardrails?)\b/,
  /\bregardless\s+of\s+(?:\w+\s+){0,3}?(?:limit|limits|cap|caps|policy|policies|rule|rules|budget|cost)\b/,
  /\beven\s+if\s+(?:you(?:'re| are)\s+not\s+allowed|it(?:'s| is)\s+(?:not allowed|forbidden|against))\b/,
  /\b(?:spend|use)\s+whatever\s+(?:it takes|you (?:need|want))\b/,
]

const HUMAN = [
  /\byou\s+(?:are|'re)\s+(?:a\s+)?(?:real\s+)?(?:human|person|man|woman)\b/,
  /\byou\s+(?:are|'re)\s+not\s+(?:an?\s+)?(?:ai|a\.i\.|assistant|bot|robot|model|program|machine)\b/,
  /\b(?:pretend|claim|insist|say|tell them|tell people)\s+(?:that\s+)?(?:you(?:'re| are)\s+)?(?:a\s+)?(?:human|person|not an ai|not a bot)\b/,
  /\b(?:do not|don'?t|never)\s+(?:say|admit|reveal|mention|disclose)\s+(?:that\s+)?you(?:'re| are)?\s*(?:an?\s+)?(?:ai|a\.i\.|assistant|bot|robot|model|program)\b/,
  /\bdeny\s+(?:being|that you(?:'re| are))\b/,
]

/** Why each kind comes out, in the words the person reading the note would use. */
const WHY = {
  asking: 'tells her to act without asking, and the ask is not hers to switch off',
  hiding: 'tells her to hide what she did, and the trace is how anybody checks any of this',
  limit: 'tells her to ignore a limit that is set outside the personality on purpose',
  human: 'tells her to claim she is a person',
}

/** Bullets, numbers and emphasis off, so a pattern meets the sentence rather than the markup. */
const bare = (line) =>
  line
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s*/, '')
    .replace(/[*_`#>]/g, '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

/** Which of the four a line is, or nothing — which is the answer for almost every line. */
export const kindOf = (line) => {
  const said = bare(line)
  if (said === '') return undefined
  if (SKIPPING.some((p) => p.test(said))) return 'asking'
  if (HIDING_ALONE.some((p) => p.test(said))) return 'hiding'
  if (HIDING_VERB.test(said) && HER_DOING.test(said)) return 'hiding'
  if (IGNORING.some((p) => p.test(said))) return 'limit'
  if (HUMAN.some((p) => p.test(said))) return 'human'
  return undefined
}

/**
 * The check itself: a document in, a document and a list of what came out.
 *
 * Line by line, because a personality is a list of instructions and one bad line does not make
 * the other twenty worthless — the alternative is refusing the whole document and handing back
 * nothing, which teaches somebody to stop pressing Adapt rather than to write a better line.
 *
 * Headings are never removed. A heading carries no instruction, and a removed one would take
 * the section's shape with it.
 */
export const check = (doc) => {
  const removed = []
  const kept = []
  for (const line of String(doc ?? '').split('\n')) {
    const kind = /^\s*#{1,6}\s/.test(line) ? undefined : kindOf(line)
    if (kind === undefined) kept.push(line)
    else removed.push({ line: bare(line), why: WHY[kind], kind })
  }
  // Two blank lines where a line was taken out reads as a mistake; one reads as a paragraph.
  const text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return { doc: text, removed }
}

/**
 * What was taken out of a saved row, read back off it.
 *
 * Kept on the row rather than only announced at the moment of saving, because the one time
 * somebody wants to know why a personality does not behave the way they wrote it is weeks
 * later, reading the row — not in the second after they pressed Adapt.
 */
export const removedOf = (row) => {
  const raw = row?.removed
  if (raw === undefined || raw === null || raw === '') return []
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(parsed) ? parsed.filter((one) => one && typeof one.line === 'string') : []
  } catch {
    return []
  }
}

/** What the person is shown, which is the part that makes this a check rather than a filter. */
export const noteOf = (removed) => {
  if (removed.length === 0) return ''
  const count = removed.length === 1 ? 'One line was' : `${removed.length} lines were`
  return [
    `${count} taken out before this was saved:`,
    '',
    ...removed.map(({ line, why }) => `  “${line}”\n  — ${why}.`),
    '',
    'Everything else was saved exactly as written.',
  ].join('\n')
}
