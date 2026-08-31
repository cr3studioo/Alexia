// SPDX-License-Identifier: AGPL-3.0-only
import { basename } from 'node:path'
import { kindOf, READABLE, SCANNED } from './kinds.js'
import { fromArchive, readsArchive } from './office.js'
import { fromPdf } from './pdf.js'
import { decode, delimiterOf, fromHtml, looksBinary, rows, table, tidy } from './text.js'

/**
 * **File in, markdown out** — the whole of `document.extract`, with no plugin process in it.
 *
 * Kept apart from `index.js` so the thing that does the work can be tested without a wire, a
 * host or a spawn. Everything above it is the SDK; everything below it is one format each.
 */

/**
 * How much of a document goes into a message before it is cut, and why there is a limit here
 * at all.
 *
 * A 200-page PDF is on the order of 150k tokens and the free rungs are nowhere near that
 * (§5.5). The router already refuses what will not fit — `fits()` filters a model out on its
 * context window — so an uncut extraction of a long book does not go wrong quietly, it goes
 * wrong loudly, by making every later turn in that conversation refuse too. **The document
 * outlives the question somebody asked about it**, which is the part that surprises people.
 *
 * So it is cut, and the cut is **said out loud in the text itself** rather than only in a
 * field nobody renders. A reader who can see the sentence *this is the first N characters of
 * M* can ask for the rest of it; one who cannot is being quietly lied to about what was read.
 *
 * The number is a setting, and this is its default: roughly forty thousand tokens, which is
 * inside a 64k window with the conversation still fitting round it.
 */
export const DEFAULT_LIMIT = 160_000

/**
 * What a document that will not fit says, in the extraction itself.
 *
 * Exported because the OCR path in `index.js` reads the same document by another route and
 * has to be cut by the same rule. Two budgets that could disagree is how a setting becomes
 * a lie about one of the two ways in.
 */
export const cut = (text, limit) => {
  if (text.length <= limit) return { text, truncated: false }
  // Cut at a line, so the last thing a model reads is not half a word.
  const at = text.lastIndexOf('\n', limit)
  const kept = text.slice(0, at > limit * 0.8 ? at : limit)
  return {
    text: `${kept}\n\n*(cut here — this is the first ${String(kept.length)} characters of ${String(text.length)}. The rest of the document was not sent.)*`,
    truncated: true,
  }
}

/**
 * One file, as markdown.
 *
 * Throws with a sentence rather than an error code, because every caller of this — a tool
 * result, a capability result, a note under the composer — puts that sentence in front of a
 * person. `kinds.js` writes the refusals; this one writes only the ones that need the bytes.
 */
export function read(name, bytes, { limit = DEFAULT_LIMIT } = {}) {
  const called = basename(String(name))
  if (bytes.length === 0) throw new Error(`${called} is empty — there is nothing in it to read.`)
  const { kind, refusal } = kindOf(called, bytes)
  if (refusal !== undefined) throw new Error(refusal)

  const done = (text, kind, extra = {}) => {
    const trimmed = tidy(text)
    if (trimmed === '') throw new Error(`there are no words in ${called}. Nothing was read.`)
    const { text: kept, truncated } = cut(trimmed, Math.max(1000, limit))
    return { markdown: kept, kind, truncated, characters: trimmed.length, ...extra }
  }

  if (kind === 'pdf') {
    const { text, pages, empty } = fromPdf(bytes)
    if (empty) throw new Error(SCANNED)
    return done(text, 'pdf', { pages })
  }

  if (readsArchive(kind)) return done(fromArchive(bytes, kind), kind)

  // Everything left is text, or is nothing this reads. The binary check is here rather than
  // in `kinds.js` because it is the one question that needs the bytes rather than the name.
  if (looksBinary(bytes)) {
    throw new Error(
      `${called} is not a document — there are bytes in it that no text encoding has. This reads ${READABLE}.`,
    )
  }
  const text = decode(bytes)

  if (kind === 'csv') {
    const grid = rows(text, delimiterOf(text))
    // A one-column "table" is a list of lines, and drawing pipes round it helps nobody.
    return done(grid.every((row) => row.length <= 1) ? text : table(grid), 'csv')
  }
  if (kind === 'html' || kind === 'xml') return done(fromHtml(text), kind)
  // Markdown is already the output format, and a `.txt` is close enough that reformatting it
  // would be inventing structure. Source code goes in a fence so the model can see it is code.
  if (kind === 'code') return done(`\`\`\`\n${text}\n\`\`\``, 'code')
  return done(text, kind === 'unknown' ? 'text' : kind)
}
