// SPDX-License-Identifier: AGPL-3.0-only
import type { Message } from './store.js'

/**
 * What may leave this machine for a third-party model.
 *
 * **A different job from `SecretStore`** (M1-3). That guards what is *written* — a token
 * never reaches the database. This guards what is *sent*. A string can be perfectly fine to
 * store and still not fine to transmit, and until this file existed a conversation
 * containing an API key went to a free endpoint intact.
 *
 * D51 is why it has to exist at all: free endpoints are the default, they are how spend
 * stays at 0.00, and their terms permit training on what they receive.
 *
 * **The policy is three exclusions, and the third one is the point.** From the predecessor's
 * owner, in his own words, kept verbatim because the temptation is always to broaden it:
 *
 * > *"i dont care that it sends some information about me to the model just not passwords /
 * > env variables. or anything that could leak my current location. but the things how i
 * > operate, what i do, what i like etc. i dont care about that."*
 *
 * So:
 *
 * 1. Credentials, secrets and env values — **always stripped**
 * 2. Anything saying **where he is** — always stripped
 * 3. Everything else about him — **allowed, deliberately**
 *
 * Behavioural data — projects, habits, commitments, how he fails, what he likes — is
 * explicitly permitted. **Do not "helpfully" broaden this.** Over-redacting the behavioural
 * layer would gut the thing that makes Alexia worth running, and it is not what was asked
 * for. A future session tightening this is the failure mode this comment guards against.
 *
 * **The ceiling, stated rather than hidden.** This is pattern matching. It is deliberately
 * narrow, it is not exhaustive, and it will miss something — a credential shape nobody has
 * seen yet, a street written in a form not listed below. Saying so is the difference between
 * a filter and a promise. It is still enforcement rather than instruction: no prompt asks a
 * model to be careful, because a prompt cannot be relied on to hold and would be relied on
 * for exactly the payloads where it matters most.
 *
 * ponytail: regexes over a string, not a parser. The upgrade path if a real leak gets past
 * is another row, not another architecture.
 */

export const PLACEHOLDER = '[redacted]'

/**
 * Credential shapes. Ported from the predecessor's `core/redact.py`, which had been through
 * a real leak per row.
 */
const SECRETS: [string, RegExp][] = [
  // sk-, and every vendor that prefixes it — sk-ant-, sk-or-v1-.
  ['api key', /\bsk-[A-Za-z0-9_-]{16,}\b/g],
  ['github token', /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g],
  ['aws key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  // Real Google keys are AIza plus exactly 35. An exact length is brittle — a truncated or
  // reformatted paste walks straight through — so near-miss shapes are caught too.
  ['google key', /\bAIza[A-Za-z0-9_-]{30,}/g],
  ['slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g],
  ['telegram token', /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g],
  ['private key', /-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  /**
   * Anything secret-named being assigned a non-trivial value.
   *
   * **Both character classes are load-bearing and both were paid for.** The leading one:
   * anchoring with a word boundary silently failed on every *prefixed* env var, because `_`
   * is a word character and there is no boundary inside `OPENROUTER_API_KEY` — the most
   * common real shape, sailing straight through. The trailing one is the same bug from the
   * other end, found by M7-3's own test: `AWS_SECRET_ACCESS_KEY=…` has the keyword in the
   * *middle*, and a pattern demanding `=` immediately after it does not see one of the most
   * copied-and-pasted lines there is.
   *
   * It over-matches — `token_count = 123456789012` goes too. That is the safe direction and
   * it is inside exclusion 1; the line that must never be broadened is the behavioural one.
   */
  [
    'env assignment',
    /[A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|bearer|credential)[A-Za-z0-9_.-]*\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{12,}/gi,
  ],
]

/**
 * Where he is. The sharpest reading of what was asked for: anything saying **where he is**,
 * especially tied to a time.
 *
 * The dangerous payloads are not an identity file — they are calendar events and email,
 * which carry street addresses and venue names next to timestamps. A shift at a named
 * restaurant from 17:00 to 21:00 is a statement about his whereabouts.
 *
 * **City-level stays.** "CTU FEL Prague" and "relocating to Prague" are part of who he is
 * and what he is doing, which exclusion 3 explicitly allows, and neither locates him at any
 * moment.
 */
const LOCATIONS: [string, RegExp][] = [
  ['gps', /[-+]?\d{1,3}\.\d{3,}\s*[,;]\s*[-+]?\d{1,3}\.\d{3,}/g],
  // A postcode, either side of the city that makes it one rather than five loose digits.
  ['postcode', /\b\d{3}\s?\d{2}\b(?=[^\n]{0,40}\b(?:praha|prague|brno|ostrava|plzen|plzeň|berlin|dresden)\b)/gi],
  ['postcode', /\b(?:praha|prague|brno|ostrava|berlin|dresden)\b[^\n]{0,20}\b\d{3}\s?\d{2}\b/gi],
  // Czech and Slovak street forms: "Na Příkopě 12", "ulice Dlouhá 5", "nám. Míru 3".
  ['street', /\b(?:ulice|ul\.|nám(?:\.|ěstí)?|nam\.?|třída|trida|nábř\.?)\s+[A-ZÁ-Ž][\wÀ-ſ.\- ]{1,30}\s+\d+[a-z]?\b/gi],
  // German: "Hauptstraße 12", "Bahnhofstr. 4".
  ['street', /\b[A-ZÄÖÜ][\wÀ-ſ-]{2,30}(?:straße|strasse|str\.)\s*\d+[a-z]?\b/gi],
  // Anglo: "12 Baker Street", "5 Mill Rd." — the trailing dot is optional rather than
  // required-and-then-bounded, which is how "5 Mill St." at the end of a sentence escaped.
  [
    'street',
    /\b\d{1,4}[a-z]?\s+[A-Z][\w-]{1,25}\s+(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|square|sq)\.?(?!\w)/gi,
  ],
  ['map link', /https?:\/\/(?:www\.)?(?:maps\.google\.\w+|goo\.gl\/maps|maps\.app\.goo\.gl)\/\S+/g],
  ['what3words', /\/\/\/[a-z]+\.[a-z]+\.[a-z]+\b/g],
  /**
   * Fields that **are** a location by definition, in the JSON a tool result arrives as. A
   * venue name carries no street number and would survive every pattern above while still
   * answering *where is he right now*, so the value goes whole and the key stays — the model
   * can still see that there was a place, which is the part it may need to reason about.
   */
  [
    'location field',
    /("(?:location|address|street|venue|place|where|geo|coordinates|coords|lat|lng|lon|latitude|longitude|postcode|postal_code|zip|zipcode|formatted_address)"\s*:\s*")[^"\\]{1,200}"/gi,
  ],
]

/** Deliberately not here: IBANs and card numbers. See {@link redactText}. */
const RULES: [string, RegExp][] = [...SECRETS, ...LOCATIONS]

/**
 * The credential half alone, for the other door (M7-3).
 *
 * What may be *written down* is not what may be *sent*. A street address is fine in memory
 * — it is where the user lives, and a memory that could not hold it would be a worse memory
 * — and it is not fine in a payload bound for somebody's training corpus. So the location
 * rules stay on the egress door and the credential rules run on both, which is the same
 * asymmetry `SecretStore` already draws between storing and transmitting.
 */
export function redactSecrets(text: string): { text: string; kinds: Kinds } {
  return apply(SECRETS, text)
}

/** What was removed, and never what it was. Countable, so a note can say how much. */
export type Kinds = string[]

/**
 * Strip credentials and location from one string.
 *
 * Financial shapes — IBAN, card-like digit runs — are **deliberately absent**, though the
 * predecessor carried them. It carried them for a different rule of its own, and the card
 * pattern in particular eats any thirteen-to-nineteen digit run, which is a real cost paid
 * against a payload exclusion 3 says is allowed.
 */
export function redactText(text: string): { text: string; kinds: Kinds } {
  return apply(RULES, text)
}

function apply(rules: [string, RegExp][], text: string): { text: string; kinds: Kinds } {
  const kinds: Kinds = []
  let out = text
  for (const [kind, pattern] of rules) {
    out = out.replace(pattern, (_match, ...rest: unknown[]) => {
      kinds.push(kind)
      // A rule with a capture group keeps it — that is the JSON key, whose value is what
      // goes. Everything else is replaced whole. The type test rather than a check for
      // `undefined`: a pattern with no group is handed the match offset in that slot.
      const [keep] = rest
      return typeof keep === 'string' ? `${keep}${PLACEHOLDER}"` : PLACEHOLDER
    })
  }
  return { text: out, kinds }
}

/**
 * The whole payload: every message, and the arguments of every tool call in one.
 *
 * Tool-call arguments matter as much as the text. A model that has just read a calendar
 * asks the next tool about it, and *that* string is a payload nobody was watching.
 */
export function redact(messages: Message[]): { messages: Message[]; kinds: Kinds } {
  const kinds: Kinds = []
  const out = messages.map((message) => {
    const body = redactText(message.content)
    kinds.push(...body.kinds)
    const calls = message.calls?.map((call) => {
      const args = redactText(call.arguments)
      kinds.push(...args.kinds)
      return { ...call, arguments: args.text }
    })
    return { ...message, content: body.text, ...(calls && { calls }) }
  })
  return { messages: out, kinds }
}

/** `secret×2, street×1` — what went, never the values. The line a person is shown. */
export function summarise(kinds: Kinds): string {
  const counts = new Map<string, number>()
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1)
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, n]) => `${kind}×${String(n)}`)
    .join(', ')
}
