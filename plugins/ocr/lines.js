// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Recognised lines, put back into the order a person reads them in.
 *
 * **This is the part that decides whether the answer is worth having**, and it is separate
 * from `windows.js` so it can be tested on a machine with no desktop, no Windows and no
 * picture — the same split `replay.js` made for its postconditions, and for the same reason:
 * a rule whose only test needs the right window open is a rule nobody ever runs.
 *
 * The engine returns lines in its own order, which is not reading order. Measured on an
 * invoice with two columns, what came back was:
 *
 *     Invoice number 4711 / Description / Widget, brass, 8mm / Bracket, steel /
 *     Total due 129.50 EUR / Date 12 March 2026 / Qty Price / 3 / 12 42.00 / 18.50
 *
 * — every word correct, every relationship destroyed. The date has floated away from the
 * invoice number, and the three prices have come loose from the three things they price.
 * That is exactly the failure `document_plan.md` §4 says is worse than a refusal: *nothing
 * errors, and the model then answers confidently about a soup of nouns.* A reader cannot
 * tell that output from a correct one, so nobody catches it.
 *
 * The fix is that the engine also hands back where each line **is**. Sorting on that turns
 * the same input into the page:
 *
 *     Invoice number 4711    Date 12 March 2026
 *     Description            Qty      Price
 *     Widget, brass, 8mm     12       42.00
 *
 * No model, no heuristic about content, no guessing — just the geometry that was already in
 * the answer and was being thrown away.
 */

/**
 * The value a quarter of the way up, and `at(0.5)` is the median.
 *
 * Ranked rather than averaged throughout this file: one banner headline drags an average of
 * heights far enough to change how every body line is grouped, and one tight pair of lines
 * drags a minimum. A rank is unmoved by either.
 */
const percentile = (numbers, at) => {
  if (numbers.length === 0) return 0
  const sorted = [...numbers].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * at))]
}

/**
 * Lines grouped into the rows they sit on.
 *
 * **Grown greedily rather than bucketed by a fixed grid**, and that is the one decision in
 * this file worth defending. Dividing the page into bands of a fixed height splits any two
 * lines that happen to straddle a boundary — and on a scan, which is never perfectly
 * straight, some row always does. Growing a band until something is clearly below it has no
 * boundaries to straddle.
 *
 * The tolerance is a fraction of the typical line height rather than a pixel count, so it
 * holds at 150 dpi and at 600, and on a screen crop of a menu as well as on a page.
 */
export function bands(lines, tolerance) {
  const sorted = [...lines].sort((one, two) => one.top - two.top)
  const rows = []
  for (const line of sorted) {
    const current = rows.at(-1)
    if (current === undefined || line.top - current.top > tolerance) {
      rows.push({ top: line.top, lines: [line] })
    } else {
      current.lines.push(line)
    }
  }
  // Left to right within the row, which is what makes a two-column table read as rows.
  for (const row of rows) row.lines.sort((one, two) => one.left - two.left)
  return rows
}

/**
 * The recognised text of one picture, as something worth putting in a message.
 *
 * Two spaces between the pieces of one row rather than a markdown table: the geometry says
 * *these were side by side* and it does not say *this is a table with these columns*, and
 * inventing the second from the first is how a receipt acquires a header row it never had.
 * A blank line where the vertical gap jumps, because that is a paragraph, and losing it
 * turns a letter into one long sentence.
 */
export function assemble(lines) {
  const usable = (lines ?? []).filter(
    (line) => typeof line?.text === 'string' && line.text.trim() !== '' && Number.isFinite(line.top),
  )
  if (usable.length === 0) return ''

  const typical = percentile(usable.map((line) => line.height), 0.5) || 1
  const rows = bands(usable, typical * 0.6)

  /**
   * What a paragraph break is, measured from **this page's own line spacing** rather than
   * from the size of its letters.
   *
   * Guessing it from the glyph height was the first version and it was wrong on the first
   * real page: leading varies from about 1.2× the letter height in a dense scan to over 2×
   * in a printed letter, so any multiple of the height that splits paragraphs in one
   * document splits every single line in the other. The gap between consecutive rows is the
   * leading, directly, and the smallest gaps on a page are the ones inside its paragraphs —
   * so the quarter mark is the line spacing, and anything half again bigger is a break.
   */
  const gaps = rows.slice(1).map((row, at) => row.top - rows[at].top)
  const leading = percentile(gaps, 0.25) || typical

  return rows
    .map((row, at) => {
      const previous = rows[at - 1]
      const broke = previous !== undefined && row.top - previous.top > leading * 1.5
      return (broke ? '\n' : '') + row.lines.map((line) => line.text.trim()).join('  ')
    })
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
