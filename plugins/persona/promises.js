// SPDX-License-Identifier: AGPL-3.0-only

/**
 * **Lines she cannot act on** (`plan-personality.md` improvement 4).
 *
 * This is D103's lesson arriving a second time. A personality is a standing instruction now,
 * so *What you do without being asked* is the section that actually changes behaviour — and a
 * line in it with nothing behind it is **inert**: she does not do it, nothing says why, and the
 * person reads it as *she ignores me*. The first real personality anybody wrote on this machine
 * had two such lines in it.
 *
 * **What this can honestly catch, and what it cannot.** Core answers one question — *would
 * anything here answer this capability?* — about names from a fixed list. So a line that asks
 * for something a capability covers (read this document, say it out loud, remember it for next
 * time) can be checked exactly; a line that asks for something no capability has a name for
 * (*chase the dates he set himself*) cannot be, and is left alone. Silence about a line means
 * *nothing was checked*, never *this is fine* — which is why the note says which lines were
 * looked at rather than implying it looked at all of them.
 *
 * **It flags, it never removes.** `safety.js` removes, because a line telling her to skip
 * asking is a line that must not reach a model. A line she cannot act on is not dangerous, it
 * is disappointing, and deciding it is worthless is the person's call and not this file's.
 */

/**
 * **What a behaviour line is asking for, in the words people write it in.**
 *
 * Deliberately a table rather than a model call: it is read on every save, it costs nothing,
 * and when it is wrong it is wrong in a way somebody can look at. A model asked the same
 * question would be right more often and confidently wrong the rest of the time, about lines
 * it had removed no evidence for.
 *
 * Each entry is a capability and the words that mean it. Matching is on whole words, so
 * *remembrance* does not match *remember*, and a line has to be **about** the thing rather than
 * merely mention it — hence the verbs.
 *
 * **The capability names are core's, from `docs/spec/capabilities.md`.** They are the whole of
 * what can be asked about, which is the shape of this check and its limit.
 */
export const MEANS = [
  {
    cap: 'memory.remember',
    // Long-term recall, which is the one people write into a personality most often and the one
    // that is a plugin rather than something core does.
    words: ['remember', 'remembers', 'remembering', 'recall', 'recalls', 'memorise', 'memorize', 'note down', 'write down'],
    says: 'nothing here remembers things between conversations',
  },
  {
    cap: 'voice.speak',
    words: ['say it out loud', 'out loud', 'aloud', 'speak', 'speaks', 'read out', 'reads out', 'voice'],
    says: 'nothing here speaks out loud',
  },
  {
    cap: 'voice.transcribe',
    words: ['listen', 'listens', 'transcribe', 'transcribes', 'dictate', 'dictation'],
    says: 'nothing here turns speech into words',
  },
  {
    cap: 'document.extract',
    words: ['pdf', 'pdfs', 'document', 'documents', 'spreadsheet', 'spreadsheets', 'word doc', 'epub'],
    says: 'nothing here reads documents',
  },
  {
    cap: 'image.ocr',
    words: ['scan', 'scans', 'scanned', 'screenshot', 'screenshots', 'ocr'],
    says: 'nothing here reads the words in a picture',
  },
  {
    cap: 'ask.confirm',
    words: ['text me', 'message me', 'ping me', 'telegram', 'whatsapp', 'notify me'],
    says: 'nothing here can reach you anywhere but this window',
  },
]

/** One line of a section, with its bullet or number taken off and nothing else changed. */
export const lineOf = (line) => String(line ?? '').replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()

/** Does this line's own wording ask for that capability? Whole words, case ignored. */
const asksFor = (line, words) => {
  const said = ` ${line.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `
  return words.some((word) => said.includes(` ${word.toLowerCase()} `))
}

/**
 * Which capability each line of a section is asking for, where any of them is.
 *
 * A line may ask for more than one — *read the PDF out to me* wants a document reader and a
 * voice — and both are checked, because either one missing makes the line inert.
 */
export const wants = (section) =>
  String(section ?? '')
    .split('\n')
    .map(lineOf)
    .filter((line) => line !== '' && !/^nothing\.?$/i.test(line))
    .map((line) => ({ line, caps: MEANS.filter((one) => asksFor(line, one.words)).map((one) => one.cap) }))
    .filter((one) => one.caps.length > 0)

/**
 * The findings, given an answer for each capability that was asked about.
 *
 * `answered` is `{ [cap]: { answers, here } }` — what core said, nothing more. This file does
 * no asking of its own, so it can be read and tested without a wire.
 */
export const inert = (section, answered) => {
  const found = []
  for (const { line, caps } of wants(section)) {
    const missing = caps.filter((cap) => answered[cap]?.answers !== true)
    if (missing.length === 0) continue
    const said = MEANS.filter((one) => missing.includes(one.cap))
    // *Switched off* and *not installed* are different sentences because they are different
    // afternoons: one is a switch two inches away and the other is a search through a library.
    const off = said.every((one) => answered[one.cap]?.here === true)
    found.push({
      line,
      why: `${said.map((one) => one.says).join(', and ')}${off ? ' — something that would is installed and switched off' : ''}`,
    })
  }
  return found
}

/** Every capability any line mentions, so the caller knows what to ask core about. */
export const asked = (section) => [...new Set(wants(section).flatMap((one) => one.caps))]

/**
 * The note under the row: which lines have nothing behind them, and what is missing.
 *
 * It says **what was checked** as well as what failed, because a check that reports only
 * failures reads as a guarantee about everything it did not mention — and this one looks at a
 * line only when the line's own words name something a capability covers.
 */
export const inertNote = (found, looked) => {
  if (looked === 0) return ''
  if (found.length === 0) {
    return `Checked ${String(looked)} of her unasked behaviours against what is installed: nothing she is told to do is missing a plugin.`
  }
  const lines = found.map((one) => `“${one.line}”: ${one.why}.`)
  return [
    found.length === 1 ?
      'One line here has nothing behind it, so she will not do it and nothing would have said why:'
    : `${String(found.length)} lines here have nothing behind them, so she will not do them and nothing would have said why:`,
    ...lines,
    'They are kept exactly as written — install or switch on what they need, and they start working.',
  ].join('\n')
}
