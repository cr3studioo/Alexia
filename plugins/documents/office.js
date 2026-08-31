// SPDX-License-Identifier: AGPL-3.0-only
import { decode, entities, fromHtml, stripTags, table, tidy } from './text.js'
import { unzip, within } from './zip.js'

/**
 * The office formats, which are all one format: **a ZIP holding XML** (§6.1).
 *
 * `.docx`, `.xlsx`, `.pptx` are OOXML; `.odt`, `.ods`, `.odp` are OpenDocument; `.epub` is a
 * book. Seven extensions, one container, and the difference between them is which entry
 * holds the words and which tags mean *paragraph*.
 *
 * **This is MarkItDown's design rather than MarkItDown's code** — that project is Python
 * (§6.1), so what is taken from it is the idea that most uploads are already text and want
 * extracting rather than recognising. What comes out is markdown, because markdown is what a
 * model reads best and because it survives being pasted into a message.
 *
 * **Shallow on purpose.** Headings, paragraphs, lists, tables and slide boundaries. No
 * styles, no colours, no images, no footnotes, no revision history. Everything left out is
 * left out because a model cannot use it and it costs tokens to carry.
 */

/**
 * Top-level `<tag …>…</tag>` regions, counting depth so a nested one does not end its parent.
 *
 * Nested tables are rare and real, and the naive non-greedy match closes the outer table at
 * the inner table's `</w:tbl>` — which silently drops the rest of the outer one. Counting is
 * four more lines than not counting.
 */
function blocks(xml, tag) {
  const marks = new RegExp(`<${tag}(?=[\\s>/])[^>]*?(/?)>|</${tag}>`, 'g')
  const found = []
  let depth = 0
  let from = 0
  for (let hit = marks.exec(xml); hit !== null; hit = marks.exec(xml)) {
    const closing = hit[0].startsWith('</')
    // `<w:tbl/>` — an empty element, which opens and closes in one token.
    if (!closing && hit[1] === '/') {
      if (depth === 0) found.push({ at: hit.index, text: hit[0] })
      continue
    }
    if (closing) {
      depth -= 1
      if (depth === 0) found.push({ at: from, text: xml.slice(from, hit.index + hit[0].length) })
      if (depth < 0) depth = 0
      continue
    }
    if (depth === 0) from = hit.index
    depth += 1
  }
  return found
}

/** The first attribute of that name on the first matching tag, or nothing. */
const attribute = (xml, tag, name) =>
  new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`).exec(xml)?.[1]

// ---- Word ------------------------------------------------------------------------------

/** Everything a Word run can put on a line, in the order it appears. */
const WORD_RUN = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:cr\s*\/>/g

function wordParagraph(xml) {
  let out = ''
  for (const hit of xml.matchAll(WORD_RUN)) {
    if (hit[1] !== undefined) out += entities(hit[1])
    else if (hit[0].startsWith('<w:tab')) out += '\t'
    else out += '\n'
  }
  return out
}

/**
 * `Heading 2` becomes `##`, and `Title` becomes `#`.
 *
 * Read from the style id rather than from the outline level, because the style is what Word
 * writes for a heading somebody actually applied — an outline level can be set on body text.
 * A document whose headings are hand-formatted bold text has no headings, here or anywhere.
 */
function wordHeading(xml) {
  const style = attribute(xml, 'w:pStyle', 'w:val') ?? ''
  if (/^title$/i.test(style)) return 1
  const level = /^heading\s*(\d)$/i.exec(style)?.[1]
  return level === undefined ? 0 : Math.min(6, Number(level))
}

function wordTable(xml) {
  const grid = blocks(xml, 'w:tr').map(({ text }) =>
    blocks(text, 'w:tc').map((cell) =>
      blocks(cell.text, 'w:p')
        .map((p) => wordParagraph(p.text).trim())
        .filter((line) => line !== '')
        .join(' '),
    ),
  )
  return table(grid)
}

function fromDocx(files) {
  const main = files.get('word/document.xml')
  if (!main) throw new Error('that .docx has no word/document.xml in it')
  const xml = decode(main)
  const body = /<w:body[^>]*>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml

  // Tables and paragraphs interleave, and the order is the document. So both are found and
  // then merged by where they started, rather than one being done after the other.
  const pieces = [
    ...blocks(body, 'w:tbl').map(({ at, text }) => ({ at, text: wordTable(text) })),
    ...blocks(body, 'w:p').map(({ at, text }) => {
      const line = wordParagraph(text)
      if (line.trim() === '') return { at, text: '' }
      const level = wordHeading(text)
      if (level > 0) return { at, text: `${'#'.repeat(level)} ${line.trim()}` }
      // A numbered or bulleted paragraph. Which of the two is in a separate part nobody
      // needs: a model reading `- one` does not care that Word would have drawn `1.`.
      return { at, text: /<w:numPr[\s>]/.test(text) ? `- ${line.trim()}` : line }
    }),
  ]
  // A paragraph inside a table cell starts after the table did, so it is already covered by
  // the table's own text. Dropping anything that begins inside one is what stops every cell
  // appearing twice.
  const tables = blocks(body, 'w:tbl').map(({ at, text }) => [at, at + text.length])
  return tidy(
    pieces
      .filter(({ at, text }) => text !== '' && !tables.some(([from, to]) => at > from && at < to))
      .sort((a, b) => a.at - b.at)
      .map(({ text }) => text)
      .join('\n\n'),
  )
}

// ---- Excel -----------------------------------------------------------------------------

/** `BC` → 54. A sparse row says which column each cell is in and skips the empty ones. */
function columnOf(reference) {
  const letters = /^([A-Z]+)/.exec(String(reference).toUpperCase())?.[1] ?? ''
  let at = 0
  for (const letter of letters) at = at * 26 + (letter.charCodeAt(0) - 64)
  return Math.max(0, at - 1)
}

/**
 * The shared string table, which is where Excel actually keeps the words.
 *
 * A cell holding text does not hold the text: it holds `t="s"` and an index into this. A
 * reader that skipped it would produce a spreadsheet of integers, every one of them wrong.
 */
const sharedStrings = (files) => {
  const raw = files.get('xl/sharedStrings.xml')
  if (!raw) return []
  return blocks(decode(raw), 'si').map(({ text }) =>
    [...text.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((hit) => entities(hit[1])).join(''),
  )
}

function sheetGrid(xml, strings) {
  return blocks(xml, 'row').map(({ text }) => {
    const cells = []
    for (const { text: one } of blocks(text, 'c')) {
      const where = columnOf(attribute(one, 'c', 'r') ?? '')
      const kind = attribute(one, 'c', 't') ?? 'n'
      const value = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(one)?.[1]
      const inline = [...one.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((hit) => entities(hit[1])).join('')
      const said =
        kind === 's' ? (strings[Number(value)] ?? '')
        : kind === 'inlineStr' ? inline
        : value === undefined ? inline
        : entities(value)
      cells[where] = said
    }
    return [...cells].map((one) => one ?? '')
  })
}

function fromXlsx(files) {
  const strings = sharedStrings(files)
  const workbook = files.get('xl/workbook.xml')
  const rels = files.get('xl/_rels/workbook.xml.rels')
  /** Sheet name to the entry holding it, through the relationship id that joins them. */
  const targets = new Map(
    rels === undefined ? []
    : [...decode(rels).matchAll(/<Relationship\b[^>]*>/g)].flatMap((hit) => {
        const id = /\bId="([^"]*)"/.exec(hit[0])?.[1]
        const to = /\bTarget="([^"]*)"/.exec(hit[0])?.[1]
        return id === undefined || to === undefined ? [] : [[id, `xl/${to.replace(/^\/?xl\//, '')}`]]
      }),
  )
  const sheets =
    workbook === undefined ? []
    : [...decode(workbook).matchAll(/<sheet\b[^>]*>/g)].flatMap((hit) => {
        const name = /\bname="([^"]*)"/.exec(hit[0])?.[1]
        const id = /\br:id="([^"]*)"/.exec(hit[0])?.[1]
        const entry = id === undefined ? undefined : targets.get(id)
        return name === undefined || entry === undefined ? [] : [{ name: entities(name), entry }]
      })

  // A workbook whose relationships did not parse still has its sheets on disk, in order.
  const found =
    sheets.length > 0 ? sheets
    : within(files, /^xl\/worksheets\/sheet\d+\.xml$/).map(({ name }, at) => ({
        name: `Sheet ${String(at + 1)}`,
        entry: name,
      }))

  const out = found.flatMap(({ name, entry }) => {
    const raw = files.get(entry)
    if (!raw) return []
    const grid = sheetGrid(decode(raw), strings).filter((row) => row.some((cell) => cell.trim() !== ''))
    return grid.length === 0 ? [] : [`## ${name}\n\n${table(grid)}`]
  })
  if (out.length === 0) throw new Error('there is nothing in that spreadsheet to read')
  return tidy(out.join('\n\n'))
}

// ---- PowerPoint ------------------------------------------------------------------------

function fromPptx(files) {
  const slides = within(files, /^ppt\/slides\/slide\d+\.xml$/)
  if (slides.length === 0) throw new Error('that .pptx has no slides in it')
  return tidy(
    slides
      .map(({ bytes }, at) => {
        const lines = blocks(decode(bytes), 'a:p')
          .map(({ text }) =>
            [...text.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((hit) => entities(hit[1])).join(''),
          )
          .map((line) => line.trim())
          .filter((line) => line !== '')
        return [`## Slide ${String(at + 1)}`, ...lines].join('\n\n')
      })
      .join('\n\n'),
  )
}

// ---- OpenDocument ----------------------------------------------------------------------

/** A cell may say *and the next nine are the same*, which is how a blank sheet stays small. */
const repeated = (xml, tag) => Math.min(64, Math.max(1, Number(attribute(xml, tag, 'table:number-columns-repeated') ?? 1)))

function odfTable(xml) {
  const grid = blocks(xml, 'table:table-row').map(({ text }) =>
    blocks(text, 'table:table-cell').flatMap(({ text: cell }) => {
      const said = stripTags(cell.replace(/<text:s\s*\/>/g, ' ')).trim()
      return Array.from({ length: repeated(cell, 'table:table-cell') }, () => said)
    }),
  )
  return table(grid.filter((row) => row.some((cell) => cell !== '')))
}

function fromOdf(files, kind) {
  const raw = files.get('content.xml')
  if (!raw) throw new Error('that OpenDocument file has no content.xml in it')
  const xml = decode(raw)
  const body = /<office:body[^>]*>([\s\S]*)<\/office:body>/.exec(xml)?.[1] ?? xml

  if (kind === 'ods') {
    const sheets = blocks(body, 'table:table').flatMap(({ text }) => {
      const drawn = odfTable(text)
      return drawn === '' ? [] : [`## ${entities(attribute(text, 'table:table', 'table:name') ?? 'Sheet')}\n\n${drawn}`]
    })
    if (sheets.length === 0) throw new Error('there is nothing in that spreadsheet to read')
    return tidy(sheets.join('\n\n'))
  }

  const tables = blocks(body, 'table:table').map(({ at, text }) => [at, at + text.length])
  const pieces = [
    ...blocks(body, 'table:table').map(({ at, text }) => ({ at, text: odfTable(text) })),
    ...blocks(body, 'text:h').map(({ at, text }) => ({
      at,
      text: `${'#'.repeat(Math.min(6, Math.max(1, Number(attribute(text, 'text:h', 'text:outline-level') ?? 1))))} ${stripTags(text).trim()}`,
    })),
    ...blocks(body, 'text:p').map(({ at, text }) => ({ at, text: stripTags(text.replace(/<text:s\s*\/>/g, ' ')).trim() })),
    // A slide deck's page boundary, so the reader can tell one slide from the next.
    ...blocks(body, 'draw:page').map(({ at, text }) => ({
      at: at - 1,
      text: `## ${entities(attribute(text, 'draw:page', 'draw:name') ?? 'Slide')}`,
    })),
  ]
  return tidy(
    pieces
      .filter(({ at, text }) => text !== '' && !tables.some(([from, to]) => at > from && at < to))
      .sort((a, b) => a.at - b.at)
      .map(({ text }) => text)
      .join('\n\n'),
  )
}

// ---- EPUB ------------------------------------------------------------------------------

function fromEpub(files) {
  const container = files.get('META-INF/container.xml')
  const opfName = container === undefined ? undefined : attribute(decode(container), 'rootfile', 'full-path')
  const opf = opfName === undefined ? undefined : files.get(opfName)
  if (opf === undefined || opfName === undefined) throw new Error('that .epub has no package file in it')
  const xml = decode(opf)
  // Everything in the package file is relative to the package file, which may not be at the
  // top of the archive.
  const base = opfName.includes('/') ? `${opfName.slice(0, opfName.lastIndexOf('/'))}/` : ''
  const items = new Map(
    [...xml.matchAll(/<item\b[^>]*>/g)].flatMap((hit) => {
      const id = /\bid="([^"]*)"/.exec(hit[0])?.[1]
      const href = /\bhref="([^"]*)"/.exec(hit[0])?.[1]
      return id === undefined || href === undefined ? [] : [[id, `${base}${entities(href).split('#')[0]}`]]
    }),
  )
  // The spine is the reading order, which is the one thing a folder listing cannot tell you.
  const spine = [...xml.matchAll(/<itemref\b[^>]*\bidref="([^"]*)"/g)].map((hit) => items.get(hit[1]))
  const read = spine.filter((name) => name !== undefined && files.has(name))
  if (read.length === 0) throw new Error('that .epub has no readable chapters in it')
  return tidy(read.map((name) => fromHtml(decode(files.get(name)))).join('\n\n'))
}

// ---- the one door ----------------------------------------------------------------------

const READERS = {
  docx: fromDocx,
  xlsx: fromXlsx,
  pptx: fromPptx,
  epub: fromEpub,
  odt: (files) => fromOdf(files, 'odt'),
  ods: (files) => fromOdf(files, 'ods'),
  odp: (files) => fromOdf(files, 'odp'),
}

export const readsArchive = (kind) => kind in READERS

/** One archive, as markdown. Throws with a sentence a person can act on. */
export function fromArchive(bytes, kind) {
  const read = READERS[kind]
  if (!read) throw new Error(`nothing here reads a ${kind} file`)
  return read(unzip(bytes))
}
