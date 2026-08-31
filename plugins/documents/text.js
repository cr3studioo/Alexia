// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Category A in one file: **the documents that are already text** (§4).
 *
 * A `.md`, a `.csv`, a `.json`, a source file, a saved web page. There is no OCR here and no
 * model — this is decoding and a little reshaping, and it is most of what anybody actually
 * drops in. It costs nothing, it works offline, and it cannot fail on a machine that has
 * never had Python on it, which is the whole argument for the tier this plugin ships (§6.1).
 */

/** Where a decoder decides it is looking at bytes rather than at writing. */
const SNIFF = 4096

/**
 * Is this a file of bytes rather than a file of words?
 *
 * A NUL is the test every editor uses and the only one worth having: no *byte* encoding this
 * reads puts one in the body, and every binary format has them within the first page. It is
 * checked before anything is decoded, because decoding a JPEG as UTF-8 does not fail — it
 * succeeds, and returns a page of replacement characters that reads as a document.
 *
 * **Except that UTF-16 is half NULs**, which is the exception that makes the rule usable: a
 * file that opens with a byte-order mark has said what it is, and a Notepad file saved as
 * Unicode is the most ordinary thing on Windows there is.
 */
export const looksBinary = (bytes) =>
  !hasMark(bytes) && bytes.subarray(0, SNIFF).includes(0)

const hasMark = (bytes) =>
  bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))

/**
 * Bytes to a string, believing the file's own byte-order mark before anything else.
 *
 * UTF-8 is the assumption when there is no mark, and a failed one is caught rather than
 * shipped: Node's UTF-8 decoder never throws, it substitutes U+FFFD, so a Windows-1252 file
 * comes back looking *almost* right with a scatter of `?` through every accented word. So
 * the substitutions are counted, and past a threshold the file is read again as Latin-1,
 * which cannot fail and is right often enough to be the fallback rather than a refusal.
 */
export function decode(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.toString('utf16le', 2)
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return swapped(bytes.subarray(2))
  const from = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
  const utf8 = bytes.toString('utf8', from)
  const broken = (utf8.match(/�/g) ?? []).length
  return broken > 0 && broken > utf8.length / 200 ? bytes.toString('latin1', from) : utf8
}

/** Big-endian UTF-16, which Node cannot read directly. Rare, and two lines to support. */
function swapped(bytes) {
  const flipped = Buffer.from(bytes)
  for (let at = 0; at + 1 < flipped.length; at += 2) {
    const first = flipped[at]
    flipped[at] = flipped[at + 1]
    flipped[at + 1] = first
  }
  return flipped.toString('utf16le')
}

/**
 * The five XML entities plus the numeric forms, which is the whole of what these formats use.
 *
 * A full HTML entity table is 2,231 names and this is a document extractor, not a browser.
 * `&nbsp;` earns its place because Word and every web page are full of them and a
 * non-breaking space that survives as the literal text `&nbsp;` is noise in every sentence
 * it appears in.
 */
export function entities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_all, hex) => code(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, digits) => code(Number(digits)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&(?:apos|#39);/g, "'")
    // Last, always: an `&amp;lt;` decoded the other way round becomes a tag.
    .replace(/&amp;/g, '&')
}

/** A code point, or nothing when the number is not one. `fromCodePoint` throws on those. */
const code = (at) => (at >= 0 && at <= 0x10ffff && !(at >= 0xd800 && at <= 0xdfff) ? String.fromCodePoint(at) : '')

/**
 * Markup out, text in — the shared bottom of every XML format here.
 *
 * Not a parser. These files are machine-written XML with no ambiguity in them, and the two
 * things that would need a parser — knowing which tag a `>` closes, and CDATA — do not occur
 * in the parts being read. What does occur is comments and processing instructions, which go
 * first so their contents are not mistaken for text.
 */
export const stripTags = (xml) =>
  entities(
    String(xml)
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<\?[\s\S]*?\?>/g, '')
      .replace(/<[^>]*>/g, ''),
  )

/** Runs of blank lines collapsed, trailing spaces gone. Every producer here needs it. */
export const tidy = (text) =>
  text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

/**
 * A saved web page, as markdown.
 *
 * Deliberately shallow: headings, paragraphs, list items, table rows, and a blank line
 * between blocks. Everything else becomes its own text. A converter that tried to be
 * faithful would be a second HTML renderer, and what the model needs from a saved page is
 * the words in the order they are written.
 */
export function fromHtml(html) {
  const body = String(html)
    // Whatever these hold is not prose, and `<style>` in particular reads as a wall of
    // punctuation that would otherwise arrive as the first paragraph of the document.
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|tr|li|h[1-6]|blockquote|pre)>/gi, '\n\n')
    .replace(/<h([1-6])[^>]*>/gi, (_all, level) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(/<li[^>]*>/gi, '\n- ')
    // A cell separator that survives `stripTags`, so a table arrives as rows rather than as
    // one long line of words with no columns in it.
    .replace(/<t[dh][^>]*>/gi, ' | ')
  return tidy(stripTags(body))
}

/**
 * One row of delimited text at a time, with quotes handled.
 *
 * The one rule that makes a hand-written CSV reader either right or useless: a quoted field
 * may contain the delimiter *and* a newline, so the split cannot happen line by line. This
 * walks characters, which is the only way that is true.
 */
export function rows(text, delimiter) {
  const out = []
  let row = []
  let field = ''
  let quoted = false
  const source = String(text).replace(/\r\n?/g, '\n')
  for (let at = 0; at < source.length; at++) {
    const here = source[at]
    if (quoted) {
      if (here !== '"') field += here
      else if (source[at + 1] === '"') {
        field += '"'
        at++
      } else quoted = false
      continue
    }
    if (here === '"') quoted = true
    else if (here === delimiter) {
      row.push(field)
      field = ''
    } else if (here === '\n') {
      row.push(field)
      out.push(row)
      row = []
      field = ''
    } else field += here
  }
  // The last field only ends at the end of the file, and a file with no trailing newline is
  // the common case rather than the corner one.
  if (field !== '' || row.length > 0) {
    row.push(field)
    out.push(row)
  }
  return out.filter((one) => one.some((cell) => cell.trim() !== ''))
}

/** Comma or tab, decided by which one the first line actually has more of. */
export const delimiterOf = (text) => {
  const first = String(text).split('\n', 1)[0] ?? ''
  const tabs = (first.match(/\t/g) ?? []).length
  const commas = (first.match(/,/g) ?? []).length
  const semicolons = (first.match(/;/g) ?? []).length
  if (tabs > commas && tabs > semicolons) return '\t'
  // A European spreadsheet exports semicolons, because the comma is its decimal point.
  return semicolons > commas ? ';' : ','
}

/**
 * A grid as a markdown table, with the first row as the header.
 *
 * Markdown, rather than the original delimiters, because a table is one of the few things
 * every model reads better with the pipes in — and because the header separator is what
 * tells it the first row is names rather than data.
 */
export function table(grid) {
  if (grid.length === 0) return ''
  const width = Math.max(...grid.map((row) => row.length))
  const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim()
  const line = (row) => `| ${Array.from({ length: width }, (_none, at) => cell(row[at])).join(' | ')} |`
  const [head, ...body] = grid
  return [line(head), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...body.map(line)].join('\n')
}
