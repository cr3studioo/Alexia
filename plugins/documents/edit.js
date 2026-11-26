// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto'
import { open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'
import { crc32 } from 'node:zlib'
import { kindOf } from './kinds.js'
import { delimiterOf, looksBinary } from './text.js'
import { unzip } from './zip.js'

/**
 * **Changing the words in a document** — the whole of `document.edit`, with no plugin process
 * in it. Word, Markdown, plain text and CSV; replace a phrase, append a paragraph or a row.
 *
 * Three rules hold everywhere here:
 *
 * - **Nothing is lost by default.** The result is a new file beside the original, created so
 *   that it cannot replace anything. Writing over the original happens only when asked for.
 * - **All or nothing.** If any part of a request cannot be done, no file is written.
 * - **What was not asked about stays byte for byte** — the encoding, the byte-order mark, the
 *   line endings, and in a Word file every part and every run the edit did not touch.
 */

export const NOT_EDITABLE = 'Alexia can read this kind of file but not edit it yet.'

/** A refusal that carries a sentence the owner can read. */
export class Refused extends Error {}
const refuse = (text) => new Refused(text)

/** The same ceiling the reader has. */
const MOST = 80 * 1024 * 1024

const EDITABLE = new Set(['docx', 'markdown', 'text', 'csv'])

/**
 * One edit of one file. `roots` answers with the folders the owner opened (MCP `roots`), and
 * nothing outside them is read or written. Resolves to `{ path, changed }`; throws `Refused`.
 */
export async function editDocument(args, { roots }) {
  const change = wanted(args)
  const { real, mode } = await scoped(args.path, await roots())
  const extension = extname(real).toLowerCase()
  // By name alone: with no bytes to sniff this is the extension table the reader uses.
  const { kind } = kindOf(basename(real), Buffer.alloc(0))
  if (!EDITABLE.has(kind)) throw refuse(NOT_EDITABLE)
  if (change.row !== undefined && kind !== 'csv') {
    throw refuse('Only a CSV or TSV file takes a new row. Use append or edits for this one.')
  }
  if (change.append !== undefined && kind === 'csv') {
    throw refuse('A CSV file takes a row rather than a paragraph. Use append_row.')
  }

  const before = await readFile(real)
  const { bytes, changed } =
    kind === 'docx' ? editDocx(before, change) : editText(before, change, { tabbed: extension === '.tsv' })
  const path = args.in_place === true ? await replaceFile(real, before, bytes, mode) : await writeCopy(real, bytes, mode)
  return { path, changed }
}

/** Exactly one of the three kinds of change, checked before any file is looked at. */
function wanted(args) {
  const given = ['edits', 'append', 'append_row'].filter((key) => args?.[key] !== undefined && args[key] !== null)
  if (given.length !== 1) throw refuse('Say what to change: exactly one of edits, append or append_row.')

  if (given[0] === 'edits') {
    const { edits } = args
    const fine =
      Array.isArray(edits) &&
      edits.length > 0 &&
      edits.every((one) => typeof one?.find === 'string' && one.find !== '' && typeof one.replace === 'string')
    if (!fine) throw refuse('Each edit needs the text to find (not empty) and the text to put in its place.')
    return { edits: edits.map(({ find, replace, all }) => ({ find, replace, all: all === true })) }
  }

  if (given[0] === 'append') {
    const text = args.append?.text
    if (typeof text !== 'string' || text.trim() === '') throw refuse('There was no text to append.')
    return { append: text }
  }

  const row = args.append_row
  if (!Array.isArray(row) || !row.every((cell) => typeof cell === 'string')) {
    throw refuse('A row is a list of texts, one for each column.')
  }
  if (row.every((cell) => cell === '')) throw refuse('That row is empty, so there was nothing to append.')
  return { row }
}

/** Every piece of new or searched-for text in a change. */
const stringsOf = (change) => [
  ...(change.edits?.flatMap(({ find, replace }) => [find, replace]) ?? []),
  ...(change.append === undefined ? [] : [change.append]),
  ...(change.row ?? []),
]

// ---- which files -----------------------------------------------------------------------

const fold = (path) => (process.platform === 'win32' ? path.toLowerCase() : path)

/** Is `path` the folder `root` or somewhere inside it? Both already resolved. */
function inside(path, root) {
  const rel = relative(fold(root), fold(path))
  // Only a whole `..` step leaves the folder; a child may well be called `..cache`.
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * The real path of a file whose folder is inside one of the owner's roots, or a refusal.
 * Links are followed first, so one inside a root cannot lead an edit out of it.
 */
async function scoped(path, roots) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw refuse('I need the full path of the file.')
  const opened = []
  for (const root of Array.isArray(roots) ? roots : []) {
    const raw = typeof root === 'string' ? root : root?.uri
    if (typeof raw !== 'string' || raw === '') continue
    try {
      opened.push(await realpath(raw.startsWith('file:') ? fileURLToPath(raw) : raw))
    } catch {
      // A folder that is gone, or a URI that is not a path here, holds no file.
    }
  }
  if (opened.length === 0) throw refuse('No folder has been opened in Alexia, so I cannot change any file.')

  const outside = 'That file is not there, or it is outside the folders you have opened in Alexia.'
  let real
  try {
    real = await realpath(path)
  } catch {
    throw refuse(outside)
  }
  if (!opened.some((root) => inside(dirname(real), root))) throw refuse(outside)
  const found = await stat(real)
  if (!found.isFile()) throw refuse('That is not a file.')
  if (found.size > MOST) throw refuse('That file is too large to edit here. Nothing was changed.')
  return { real, mode: found.mode }
}

// ---- writing ---------------------------------------------------------------------------

/** Make a file that did not exist and fill it. Nothing is left behind when that fails. */
async function create(path, bytes, mode) {
  // `wx` fails when anything is at the path already, a link included.
  const handle = await open(path, 'wx', mode)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.chmod(mode)
  } catch (error) {
    await handle.close()
    await unlink(path).catch(() => {})
    throw error
  }
  await handle.close()
}

/** `<stem> (edited).<ext>`, then `(edited 2)`, `(edited 3)`… beside the original. */
async function writeCopy(original, bytes, mode) {
  const extension = extname(original)
  const stem = basename(original, extension)
  // As private as the original, and writable even when the original is not.
  const permissions = (mode & 0o666) | 0o600
  for (let n = 1; n < 10_000; n += 1) {
    const mark = n === 1 ? 'edited' : `edited ${String(n)}`
    const target = join(dirname(original), `${stem} (${mark})${extension}`)
    try {
      await create(target, bytes, permissions)
      return target
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  throw refuse('There are too many edited copies of that file already. Nothing was written.')
}

/**
 * Put the new bytes where the original is: written in full beside it, then renamed over it,
 * so the file is at every moment either the old one or the new one.
 */
async function replaceFile(original, before, bytes, mode) {
  if ((mode & 0o200) === 0) throw refuse('That file is read-only, so I left it alone. I can make an edited copy instead.')
  const temporary = join(dirname(original), `.${randomBytes(12).toString('hex')}.alexia-edit`)
  await create(temporary, bytes, mode & 0o777)
  try {
    if (!(await readFile(original)).equals(before)) {
      throw refuse('That file changed while I was editing it, so I left it alone. Ask again.')
    }
    await rename(temporary, original)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    if (['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) {
      throw refuse(
        'I could not save over that file; another program may have it open. Close it and ask again, or let me make an edited copy.',
      )
    }
    throw error
  }
  return original
}

// ---- Markdown, plain text and CSV ------------------------------------------------------

const UTF8_MARK = Buffer.from([0xef, 0xbb, 0xbf])
const UTF16_LITTLE = Buffer.from([0xff, 0xfe])
const UTF16_BIG = Buffer.from([0xfe, 0xff])

const strictly = (bytes) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)

const startsWith = (bytes, mark) => bytes.subarray(0, mark.length).equals(mark)

/**
 * A text file as a string, with the way back to **the same encoding**.
 *
 * The reader's `decode` may guess, because a wrong guess only reads oddly. A wrong guess
 * written back damages the file. So UTF-8 has to be valid to be called UTF-8, and a file in
 * some one-byte code page nobody named is carried byte for byte (`latin1` round-trips every
 * byte) and only takes plain ASCII, which means the same in all of them.
 */
function opened(bytes) {
  for (const [mark, big] of [[UTF16_LITTLE, false], [UTF16_BIG, true]]) {
    if (!startsWith(bytes, mark)) continue
    const body = Buffer.from(bytes.subarray(2))
    if (body.length % 2 !== 0) throw refuse('That file is cut off in the middle of a character, so I left it alone.')
    if (big) body.swap16()
    const encode = (text) => {
      const out = Buffer.from(text, 'utf16le')
      if (big) out.swap16()
      return Buffer.concat([mark, out])
    }
    return { text: body.toString('utf16le'), encode, asciiOnly: false }
  }
  if (looksBinary(bytes)) throw refuse('That file is not text inside, whatever its name says, so I left it alone.')
  const mark = startsWith(bytes, UTF8_MARK) ? UTF8_MARK : Buffer.alloc(0)
  try {
    const text = strictly(bytes.subarray(mark.length))
    return { text, encode: (out) => Buffer.concat([mark, Buffer.from(out, 'utf8')]), asciiOnly: false }
  } catch {
    return { text: bytes.toString('latin1'), encode: (out) => Buffer.from(out, 'latin1'), asciiOnly: true }
  }
}

/** The line ending the file mostly uses; `\n` for a file with none yet. */
function endingOf(text) {
  const counts = new Map()
  for (const [ending] of text.matchAll(/\r\n|\r|\n/g)) counts.set(ending, (counts.get(ending) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '\n'
}

const notFound = (find) => {
  const shown = find.length > 80 ? `${find.slice(0, 80)}…` : find
  return `I could not find “${shown}” in that document, so nothing was changed.`
}

function editText(bytes, change, { tabbed }) {
  const file = opened(bytes)
  const added = stringsOf(change)
  if (!added.every((one) => one.isWellFormed())) throw refuse('That text holds half of a character, so nothing was changed.')
  if (file.asciiOnly && added.some((one) => [...one].some((letter) => letter.codePointAt(0) > 127))) {
    throw refuse(
      'That file is not saved as UTF-8, so letters outside plain English would be garbled in it. ' +
        'Save it as UTF-8 and ask again. Nothing was changed.',
    )
  }
  const ending = endingOf(file.text)
  // A model writes `\n`; the file may not.
  const local = (text) => text.replace(/\r\n|\r|\n/g, ending)

  if (change.edits !== undefined) {
    let text = file.text
    let changed = 0
    for (const { find, replace, all } of change.edits) {
      // Split and join, because `String.replace` reads `$&` in a replacement as an order.
      const pieces = text.split(local(find))
      if (pieces.length === 1) throw refuse(notFound(find))
      const [first, ...rest] = pieces
      text = all ? pieces.join(local(replace)) : `${first}${local(replace)}${rest.join(local(find))}`
      changed += all ? rest.length : 1
    }
    return { bytes: file.encode(text), changed }
  }

  if (change.append !== undefined) {
    let text = file.text
    if (text !== '') {
      // One blank line between what was there and the new paragraph.
      const [trailing] = /(?:\r\n|\r|\n)*$/.exec(text)
      const there = trailing.match(/\r\n|\r|\n/g)?.length ?? 0
      text += ending.repeat(Math.max(0, 2 - there))
    }
    const paragraph = local(change.append.replace(/^[\r\n]+|[\r\n]+$/g, ''))
    return { bytes: file.encode(`${text}${paragraph}${ending}`), changed: 1 }
  }

  // The first line decides the delimiter, and a comma inside a quoted heading does not count.
  const delimiter = tabbed ? '\t' : delimiterOf(file.text.slice(0, 65_536).replace(/"[^"]*"/g, ''))
  const field = (cell) =>
    cell.includes(delimiter) || /["\r\n]/.test(cell) || cell !== cell.trim() ?
      `"${local(cell).replace(/"/g, '""')}"`
    : cell
  const gap = file.text === '' || /[\r\n]$/.test(file.text) ? '' : ending
  const line = change.row.map(field).join(delimiter)
  return { bytes: file.encode(`${file.text}${gap}${line}${ending}`), changed: 1 }
}

// ---- Word ------------------------------------------------------------------------------

const DOCUMENT = 'word/document.xml'
const END_OF_DIRECTORY = 0x06054b50

/** A page or column break: it holds a place in the paragraph that no search text can match. */
const BREAK = '\u0000'

/** What XML 1.0 cannot hold at all, escaped or not. */
const NOT_IN_XML = /[^\t\n\r -퟿-�\u{10000}-\u{10ffff}]/u

function editDocx(bytes, change) {
  if (stringsOf(change).some((one) => NOT_IN_XML.test(one))) {
    throw refuse('That text holds a character a Word document cannot, so nothing was changed.')
  }
  const parts = partsOf(bytes)
  const main = parts.get(DOCUMENT)
  if (main === undefined) throw refuse('That .docx has no word/document.xml in it, so there is nothing to edit.')
  let xml
  try {
    xml = strictly(main)
  } catch {
    throw refuse('That Word file is not written in UTF-8 inside, so I left it alone.')
  }
  const plain = (text) => text.replace(/\r\n?/g, '\n')
  const { xml: out, changed } =
    change.edits !== undefined ?
      replaced(xml, change.edits.map(({ find, replace, all }) => ({ find: plain(find), replace: plain(replace), all })))
    : appended(xml, plain(change.append))
  parts.set(DOCUMENT, Buffer.from(out, 'utf8'))
  return { bytes: zipStored(parts), changed }
}

/**
 * Every part of the archive, or a refusal. The reader may skip an entry it cannot unpack; a
 * rewrite may not, because a skipped entry would be missing from the file written back.
 */
function partsOf(bytes) {
  let parts
  try {
    parts = unzip(bytes)
  } catch (error) {
    throw refuse(`That Word file could not be opened (${String(error?.message ?? error)}), so nothing was changed.`)
  }
  let end = bytes.length - 22
  while (bytes.readUInt32LE(end) !== END_OF_DIRECTORY) end -= 1
  if (parts.size !== bytes.readUInt16LE(end + 10) || [...parts.keys()].some((name) => name.includes('�'))) {
    throw refuse('That Word file holds a part I cannot copy faithfully, so I left it alone.')
  }
  return parts
}

/** A ZIP of stored (uncompressed) entries, in the order given. `zip.js` reads; this writes. */
export function zipStored(parts) {
  const files = []
  const directory = []
  let at = 0
  for (const [name, body] of parts) {
    const named = Buffer.from(name, 'utf8')
    const checksum = crc32(body)
    // The fields a local header and a directory entry share: version, the UTF-8 name flag,
    // method 0, midnight on 1 January 1980, checksum, both sizes and the name's length.
    const shared = Buffer.alloc(26)
    shared.writeUInt16LE(20, 0)
    shared.writeUInt16LE(0x0800, 2)
    shared.writeUInt16LE(0x0021, 8)
    shared.writeUInt32LE(checksum, 10)
    shared.writeUInt32LE(body.length, 14)
    shared.writeUInt32LE(body.length, 18)
    shared.writeUInt16LE(named.length, 22)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    shared.copy(local, 4)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    shared.copy(entry, 6)
    entry.writeUInt32LE(at, 42)

    files.push(local, named, body)
    directory.push(entry, named)
    at += local.length + named.length + body.length
  }
  const listing = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(END_OF_DIRECTORY, 0)
  end.writeUInt16LE(parts.size, 8)
  end.writeUInt16LE(parts.size, 10)
  end.writeUInt32LE(listing.length, 12)
  end.writeUInt32LE(at, 16)
  return Buffer.concat([...files, listing, end])
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** In one pass, so `&amp;lt;` stays the four characters somebody typed. */
const unescaped = (text) =>
  text.replace(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/g, (_all, hex, digits, name) =>
    name === undefined ? String.fromCodePoint(hex === undefined ? Number(digits) : parseInt(hex, 16)) : NAMED[name],
  )

const escaped = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;')

/** Text as the contents of a run: tabs and line breaks are elements of their own in Word. */
const inRun = (text) =>
  text
    .split(/(\t|\n)/)
    .map((piece) =>
      piece === '\t' ? '<w:tab/>'
      : piece === '\n' ? '<w:br/>'
      : piece === '' ? ''
      : `<w:t xml:space="preserve">${escaped(piece)}</w:t>`,
    )
    .join('')

/** A comment, a CDATA block or an instruction (skipped), or one tag. */
const MARKUP = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([^\s/<>!?]+)(?:"[^"]*"|'[^']*'|[^"'<>])*?(\/?)>/g

/**
 * The paragraphs of a document, in the order they start, each as the pieces of its text: where
 * in the XML a piece is (`from`, `to`) and what it says (`value`).
 *
 * Tags are walked one by one, because a text box puts whole paragraphs inside a paragraph, and
 * each piece belongs to the innermost one. Text that tracked changes have removed is not there
 * to be found. Also found: where a new paragraph would go.
 */
function outline(xml) {
  const marks = new RegExp(MARKUP)
  const stack = []
  const open = []
  const paragraphs = []
  let section
  let bodyClose
  let emptyBody

  /** The `</name>` after `from`; the walk goes on behind it. */
  const closing = (name, from) => {
    const end = new RegExp(`</${name}\\s*>`, 'g')
    end.lastIndex = from
    const found = end.exec(xml)
    if (found === null) throw refuse('That Word file is damaged inside, so I left it alone.')
    marks.lastIndex = end.lastIndex
    return found
  }

  for (let hit = marks.exec(xml); hit !== null; hit = marks.exec(xml)) {
    const [tag, slash, name, selfClosing] = hit
    if (name === undefined) continue
    if (slash === '/') {
      if (name === 'w:p') open.pop()
      if (name === 'w:body') bodyClose = hit.index
      stack.pop()
      continue
    }
    const parent = stack.at(-1)
    const end = hit.index + tag.length
    const whole = selfClosing === '/'
    const isText = name === 'w:t'
    // A `<w:tab>` among a paragraph's settings is a tab stop; only one in a run is a tab.
    const isMark = parent === 'w:r' && (name === 'w:tab' || name === 'w:br' || name === 'w:cr')

    if (isText || isMark) {
      let value = ''
      let to = end
      if (!whole) {
        const close = closing(name, end)
        to = close.index + close[0].length
        if (isText) {
          const raw = xml.slice(end, close.index)
          if (raw.includes('<')) throw refuse('That Word file is written in a way I cannot edit safely, so I left it alone.')
          value = unescaped(raw.replace(/\r\n?|\n/g, ' '))
        }
      }
      if (name === 'w:tab') value = '\t'
      else if (name === 'w:br') value = /\bw:type\s*=\s*["'](?:page|column)["']/.test(tag) ? BREAK : '\n'
      else if (name === 'w:cr') value = '\n'
      const removed = stack.includes('w:del') || stack.includes('w:moveFrom')
      if (!removed) open.at(-1)?.push({ from: hit.index, to, value, changed: false })
      continue
    }

    // The body's own section settings, which stay last; a paragraph's are inside its `pPr`.
    if (name === 'w:sectPr' && parent === 'w:body') section = hit.index
    if (whole) {
      if (name === 'w:body') emptyBody = { from: hit.index, to: end }
      continue
    }
    if (name === 'w:p') {
      const pieces = []
      open.push(pieces)
      paragraphs.push(pieces)
    }
    stack.push(name)
  }
  return { paragraphs, section, bodyClose, emptyBody }
}

/** Put `replacement` where `length` characters stood at `at`: all of it into the first piece. */
function splice(pieces, at, length, replacement) {
  const end = at + length
  let start = 0
  let first = true
  for (const piece of pieces) {
    const stop = start + piece.value.length
    if (stop > at && start < end) {
      const head = piece.value.slice(0, Math.max(0, at - start))
      const tail = piece.value.slice(end - start)
      piece.value = `${head}${first ? replacement : ''}${tail}`
      piece.changed = true
      first = false
    }
    start = stop
  }
}

/** How many times `find` was replaced in one paragraph, searching its joined text. */
function inParagraph(pieces, { find, replace, all }) {
  let count = 0
  let from = 0
  for (;;) {
    const at = pieces.map((piece) => piece.value).join('').indexOf(find, from)
    if (at === -1) return count
    splice(pieces, at, find.length, replace)
    count += 1
    if (!all) return count
    // Past what was just put in, which may itself contain the search text.
    from = at + replace.length
  }
}

function replaced(xml, edits) {
  const { paragraphs } = outline(xml)
  let changed = 0
  for (const edit of edits) {
    let count = 0
    for (const pieces of paragraphs) {
      count += inParagraph(pieces, edit)
      if (!edit.all && count > 0) break
    }
    if (count === 0) {
      throw refuse(
        `${notFound(edit.find)} A phrase has to be within one paragraph, and headers, footers and footnotes are not searched.`,
      )
    }
    changed += count
  }
  const touched = paragraphs
    .flat()
    .filter((piece) => piece.changed)
    .sort((a, b) => a.from - b.from)
  const out = []
  let at = 0
  for (const { from, to, value } of touched) {
    out.push(xml.slice(at, from), inRun(value))
    at = to
  }
  out.push(xml.slice(at))
  return { xml: out.join(''), changed }
}

/** New paragraphs at the end of the body: a blank line in the text starts another one. */
function appended(xml, text) {
  const paragraphs = text
    .replace(/^\n+|\n+$/g, '')
    .split(/\n(?:[ \t]*\n)+/)
    .map((one) => `<w:p><w:r>${inRun(one)}</w:r></w:p>`)
    .join('')
  const { section, bodyClose, emptyBody } = outline(xml)
  const at = section ?? bodyClose
  if (at !== undefined) return { xml: `${xml.slice(0, at)}${paragraphs}${xml.slice(at)}`, changed: 1 }
  if (emptyBody !== undefined) {
    const body = `<w:body>${paragraphs}</w:body>`
    return { xml: `${xml.slice(0, emptyBody.from)}${body}${xml.slice(emptyBody.to)}`, changed: 1 }
  }
  throw refuse('That Word file has no body to append to, so I left it alone.')
}
