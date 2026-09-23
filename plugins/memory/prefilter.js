// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What is not worth showing the sorting pass at all — decided by code, before any model.
 *
 * `capture.js` keeps the bar for *writing* on the floor, and that stays true: this is not a
 * judgement about what is worth remembering. It is the part of the buffer that cannot hold a
 * fact in the first place — *ok*, *continue*, *you alive?* — and the part of an exchange that
 * is not language — a pasted stack trace, a base64 image, a code block. Both cost prompt and
 * neither has ever produced a note; a small model shown forty lines of JSON is more likely to
 * write a note about the JSON than to find the one sentence around it.
 *
 * Not wired in yet. It is pure and tested so the wiring can be one line when it is.
 *
 * ponytail: word count and a list, nothing smarter. *"who am i?"* is three words and carries
 * no fact, and it passes — a question with no first-person statement in it could be dropped
 * too, but telling a question from a statement in two languages is a model's job, and this
 * module exists to run before one.
 */

/**
 * What a person says that never carries a fact. Matched whole, ignoring case and punctuation,
 * so `hey?` and `Hey!!` and `hey` are one entry. A parameter everywhere it is used, because it
 * is going to be a setting.
 */
export const DEFAULT_FILLER = [
  '.',
  'ok',
  'okay',
  'continue',
  'why',
  'test',
  'again',
  'hey',
  'hey?',
  'you good?',
  'you alive?',
  'yes',
  'no',
  'thanks',
  'jo',
  'ne',
  'díky',
  'pokračuj',
  'proč',
  'ano',
]

/**
 * Fewer real words than this and there is no room for a fact.
 *
 * Every default filler entry is shorter than this already, so today the list changes nothing
 * the count had not decided. It is kept anyway, because it is the half somebody can edit: *what
 * do you think* is four words and no fact, and belongs on a person's own list.
 */
export const MIN_WORDS = 3

/**
 * The exchange with everything that is not somebody talking taken out.
 *
 * Code blocks, `data:` URLs, bare base64, attachment markers, and the long unbroken runs that
 * tool output is made of — a path, a hash, a line of minified JSON. What is left is collapsed
 * to single spaces, because it is going to be read, not rendered.
 */
export function clean(text) {
  return (
    String(text ?? '')
      // Fenced code, closed or cut off at the end.
      .replace(/```[\s\S]*?(?:```|$)/g, ' ')
      .replace(/\[attached:[^\]]*\]/gi, ' ')
      .replace(/data:[\w/+.-]+(?:;[\w=.-]+)*;base64,[A-Za-z0-9+/=]*/g, ' ')
      // A JSON body pasted on its own lines: from an opening brace at the start of a line to a
      // closing one at the start of a later line, when there is a lot of it.
      .replace(/^\s*[[{][\s\S]{200,}?^\s*[\]}][,;]?\s*$/gm, ' ')
      // Anything sixty characters long with no space in it is not a word: base64, a hash, a
      // path, a URL with a token in it, a line of minified output.
      .replace(/\S{60,}/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/** Lower case, punctuation gone, one space between words — what the filler list is matched on. */
const plain = (text) =>
  String(text ?? '')
    .toLowerCase()
    // "I'm" is one word, not two. Split on the apostrophe and every contraction counts double.
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** A word is something with a letter or a digit in it. "—" and ":)" are not. */
const words = (text) => plain(text).split(' ').filter((one) => one !== '')

/**
 * The user's half of an exchange. The buffer holds `They said: …\nAlexia answered: …` (see
 * `capture` in index.js); an object with `said` is accepted too, so this does not care which
 * side of the insert it is called on, or whether it is handed the row or its text.
 */
function saidOf(exchange) {
  if (exchange && typeof exchange === 'object') {
    // A buffer row is `{ text }` holding both halves; a fresh exchange is `{ said, answered }`.
    return exchange.said !== undefined ? String(exchange.said) : saidOf(exchange.text)
  }
  const text = String(exchange ?? '')
  const from = text.startsWith('They said:') ? 'They said:'.length : 0
  const to = text.indexOf('\nAlexia answered:')
  return text.slice(from, to === -1 ? undefined : to)
}

/**
 * Is this exchange worth a model's time?
 *
 * Only the user's side is judged. What Alexia answered is never the reason a note is written —
 * a note is about the person — and an answer is long whatever it was asked, so counting its
 * words would pass everything.
 *
 * False when, after cleaning, what they said is on the filler list or is shorter than
 * `MIN_WORDS`. That drops *"I'm Vaclav"* too, and it is the price: a name said in two words is
 * rare, a two-word *ok thanks* is most of a day, and `remember` is still there for the first.
 */
export function worthSorting(exchange, { filler = DEFAULT_FILLER } = {}) {
  const said = clean(saidOf(exchange))
  const heard = plain(said)
  if (heard === '') return false
  if (new Set(filler.map(plain)).has(heard)) return false
  return words(said).length >= MIN_WORDS
}
