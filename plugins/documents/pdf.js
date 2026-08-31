// SPDX-License-Identifier: AGPL-3.0-only
import { inflateSync } from 'node:zlib'

/**
 * The PDF **text layer**, and nothing else.
 *
 * §4 splits *OCR* into three problems, and this file answers only the first one: a PDF that
 * was written by a program — Word, a browser, LaTeX, an accounting package — carries the
 * characters it drew, and getting them out is extraction rather than recognition. No model,
 * no GPU, no Python, and it works on a plane. That is category **A**, and category A is most
 * of what anybody uploads (§4).
 *
 * **A scan is category B and is refused rather than guessed at.** A photographed receipt has
 * no text layer at all — there is nothing in the file but a picture — and the only honest
 * answer is to say so and name what is missing (§6.5). A parser that returned an empty string
 * for a scan would be reported as broken; one that returned *something* would be worse.
 *
 * ponytail: no `pdfjs-dist`. It was measured rather than assumed — it reads this correctly,
 * and it is 35 MB that **does not survive being bundled**: `scripts/publish.mjs` bundles a
 * plugin to one file and pdf.js reaches for its worker by path at run time, so the published
 * plugin fails on the first PDF while the checkout works perfectly. That is D117's lesson
 * arriving before rather than after, and it is why this is written here instead.
 *
 * **What that costs, stated plainly.** This reads Flate, ASCIIHex and ASCII85 streams and
 * ignores the rest; it maps bytes to characters through the font's own `ToUnicode` table and
 * falls back to WinAnsi; it takes line breaks from the text matrix and word breaks from the
 * spacing a producer wrote. It is not a renderer and it does not know what a column is. A PDF
 * it cannot read comes back as a refusal that says which wall it hit.
 */

/**
 * Everything in the file, by object number.
 *
 * **Found by scanning rather than by walking the cross-reference table**, which is the one
 * decision here worth defending: a linearised PDF, an incrementally-updated one, and one
 * whose xref is simply wrong — which is common, because half the world's PDFs are written by
 * software that got it slightly off — all have their objects sitting in the file exactly
 * where `N 0 obj` says they are. Every real reader has a rebuild-the-xref path for that case.
 * This is only that path.
 */
function objects(raw) {
  const found = new Map()
  const marks = /(?:^|[\s>\]])(\d{1,10})\s+(\d{1,5})\s+obj\b/g
  for (let hit = marks.exec(raw); hit !== null; hit = marks.exec(raw)) {
    const from = hit.index + hit[0].length
    // An `endobj` can appear inside a stream's bytes, so the object ends at whichever comes
    // first: the next `endobj`, or the start of the next object.
    const nextObj = /(?:^|[\s>\]])\d{1,10}\s+\d{1,5}\s+obj\b/g
    nextObj.lastIndex = from
    const following = nextObj.exec(raw)?.index ?? raw.length
    const ends = raw.indexOf('endobj', from)
    const to = Math.min(ends === -1 ? raw.length : ends, following)
    found.set(Number(hit[1]), body(raw, from, to))
  }
  return found
}

/** One object, split into the dictionary in front of it and the stream behind it. */
function body(raw, from, to) {
  const text = raw.slice(from, to)
  const at = text.indexOf('stream')
  if (at === -1) return { dict: text, stream: undefined }
  const dict = text.slice(0, at)
  // `stream` is followed by CRLF or LF, and by nothing else. A space here would be one byte
  // of the data.
  let start = from + at + 'stream'.length
  if (raw[start] === '\r') start += 1
  if (raw[start] === '\n') start += 1
  const declared = Number(value(dict, 'Length'))
  const ends = raw.indexOf('endstream', start)
  // The declared length is believed only when it lands where `endstream` actually is —
  // an indirect `/Length 12 0 R` is not a number, and a wrong one is a truncated stream.
  const stop =
    Number.isFinite(declared) && declared > 0 && (ends === -1 || Math.abs(start + declared - ends) <= 2) ?
      start + declared
    : ends === -1 ? to
    : ends
  return { dict, stream: Buffer.from(raw.slice(start, stop), 'latin1') }
}

/**
 * The raw text of one dictionary entry — `/Type /Page`, `/Contents 4 0 R`, `/Kids [1 0 R]`.
 *
 * Reads to the next key at the same depth rather than tokenising, which is enough for
 * everything asked of it here and is the difference between forty lines and a parser.
 */
function value(dict, key) {
  const at = new RegExp(`/${key}(?![A-Za-z0-9])`).exec(dict)
  if (!at) return undefined
  let from = at.index + key.length + 1
  while (from < dict.length && /\s/.test(dict[from])) from += 1
  if (dict.startsWith('<<', from)) return balanced(dict, from, '<<', '>>')
  if (dict[from] === '[') return balanced(dict, from, '[', ']')
  // A name, a number, or `12 0 R`. Ends at the next key, the end of the dictionary, or a
  // delimiter that cannot be part of any of the three.
  const rest = dict.slice(from)
  const end = /[/[\]<>]|>>|$/.exec(rest.slice(1))
  return rest.slice(0, 1 + (end?.index ?? rest.length - 1)).trim()
}

function balanced(text, from, open, close) {
  let depth = 0
  for (let at = from; at < text.length; at++) {
    if (text.startsWith(open, at)) {
      depth += 1
      at += open.length - 1
    } else if (text.startsWith(close, at)) {
      depth -= 1
      if (depth === 0) return text.slice(from, at + close.length)
      at += close.length - 1
    }
  }
  return text.slice(from)
}

/** `12 0 R` → 12. */
const reference = (text) => {
  const found = /^(\d+)\s+\d+\s+R\b/.exec(String(text ?? '').trim())
  return found ? Number(found[1]) : undefined
}

/** Every `12 0 R` in an array, in order. */
const references = (text) => [...String(text ?? '').matchAll(/(\d+)\s+\d+\s+R\b/g)].map((hit) => Number(hit[1]))

/** Follow a reference if it is one, otherwise take the value as written. */
const resolve = (all, text) => {
  const at = reference(text)
  return at === undefined ? text : all.get(at)?.dict
}

// ---- streams ----------------------------------------------------------------------------

/** ASCII85, which a few producers still wrap content streams in. */
function ascii85(bytes) {
  const text = bytes.toString('latin1').replace(/\s+/g, '').replace(/^<~/, '')
  const out = []
  let group = []
  for (const one of text) {
    if (one === '~') break
    if (one === 'z' && group.length === 0) {
      out.push(0, 0, 0, 0)
      continue
    }
    group.push(one.charCodeAt(0) - 33)
    if (group.length === 5) {
      let n = 0
      for (const digit of group) n = n * 85 + digit
      out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
      group = []
    }
  }
  if (group.length > 1) {
    const short = group.length
    while (group.length < 5) group.push(84)
    let n = 0
    for (const digit of group) n = n * 85 + digit
    const four = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
    out.push(...four.slice(0, short - 1))
  }
  return Buffer.from(out)
}

/**
 * The PNG predictor, which is a compression trick and not a filter of its own.
 *
 * Object streams and cross-reference streams are routinely written with `/Predictor 12`, and
 * inflating one without undoing it gives bytes that are *nearly* right — every row off by
 * the row above it. Nearly right is the failure mode this whole plugin is written to avoid.
 */
function unpredict(bytes, columns) {
  const width = Math.max(1, columns)
  const out = Buffer.alloc(0)
  const rows = []
  let previous = Buffer.alloc(width)
  for (let at = 0; at + 1 <= bytes.length; at += width + 1) {
    const kind = bytes[at]
    const row = Buffer.from(bytes.subarray(at + 1, at + 1 + width))
    if (row.length === 0) break
    for (let n = 0; n < row.length; n++) {
      const left = n >= 1 ? row[n - 1] : 0
      const up = previous[n] ?? 0
      const upLeft = n >= 1 ? (previous[n - 1] ?? 0) : 0
      if (kind === 1) row[n] = (row[n] + left) & 0xff
      else if (kind === 2) row[n] = (row[n] + up) & 0xff
      else if (kind === 3) row[n] = (row[n] + ((left + up) >> 1)) & 0xff
      else if (kind === 4) row[n] = (row[n] + paeth(left, up, upLeft)) & 0xff
    }
    rows.push(row)
    previous = row
  }
  return Buffer.concat([out, ...rows])
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a
    : pb <= pc ? b
    : c
}

/** One object's stream, decoded, or nothing when the filter is one this does not read. */
function decoded(object) {
  if (!object?.stream) return undefined
  const filters = String(value(object.dict, 'Filter') ?? '').match(/\/(\w+)/g) ?? []
  let bytes = object.stream
  for (const filter of filters) {
    if (filter === '/FlateDecode' || filter === '/Fl') {
      try {
        bytes = inflateSync(bytes)
      } catch {
        // A stream whose declared length was long by a byte or two still inflates as far as
        // it goes, and what it got to is the whole document.
        try {
          bytes = inflateSync(bytes, { finishFlush: 2 })
        } catch {
          return undefined
        }
      }
    } else if (filter === '/ASCIIHexDecode' || filter === '/AHx') {
      bytes = Buffer.from(bytes.toString('latin1').replace(/[^0-9a-f]/gi, ''), 'hex')
    } else if (filter === '/ASCII85Decode' || filter === '/A85') {
      bytes = ascii85(bytes)
    } else {
      // LZW, DCT, CCITT, JBIG2, JPX. The last four are pictures; the first is 1990s.
      return undefined
    }
  }
  const parms = value(object.dict, 'DecodeParms')
  const predictor = Number(value(String(parms ?? ''), 'Predictor') ?? 1)
  if (predictor >= 10) bytes = unpredict(bytes, Number(value(String(parms), 'Columns') ?? 1))
  return bytes
}

/**
 * Object streams, unpacked into the same map as everything else.
 *
 * PDF 1.5 lets a producer pack most of its small objects — page dictionaries, font
 * dictionaries — into one compressed stream. Word and every TeX distribution do it. Without
 * this the file looks like it has three objects in it and no pages at all.
 */
function expand(all) {
  for (const [, object] of [...all]) {
    if (!String(object.dict).includes('/ObjStm')) continue
    const bytes = decoded(object)
    if (!bytes) continue
    const text = bytes.toString('latin1')
    const count = Number(value(object.dict, 'N') ?? 0)
    const first = Number(value(object.dict, 'First') ?? 0)
    const header = text.slice(0, first).trim().split(/\s+/).map(Number)
    for (let n = 0; n < count; n++) {
      const number = header[n * 2]
      const at = header[n * 2 + 1]
      if (!Number.isFinite(number) || !Number.isFinite(at)) continue
      const to = n + 1 < count ? first + header[n * 2 + 3] : text.length
      // Never overwrite: an object written twice is an incremental update, and the one
      // sitting loose in the file is the newer of the two.
      if (!all.has(number)) all.set(number, { dict: text.slice(first + at, to), stream: undefined })
    }
  }
  return all
}

// ---- fonts ------------------------------------------------------------------------------

/** The CP1252 block, which is the only part of WinAnsi that is not Latin-1. */
const CP1252 = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ',
  0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“',
  0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›',
  0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
}

/** A hex run from a CMap — `<0041>` or `<00410042>` — as the string it stands for. */
const utf16 = (hex) => {
  let out = ''
  for (let at = 0; at + 3 < hex.length; at += 4) out += String.fromCharCode(parseInt(hex.slice(at, at + 4), 16))
  // A single byte pair is written as two digits by some producers.
  return out === '' && hex.length >= 2 ? String.fromCharCode(parseInt(hex.slice(0, 2), 16)) : out
}

/**
 * A `ToUnicode` CMap: what the bytes in the content stream actually say.
 *
 * This is the whole reason a subset font is readable at all. A PDF from Word draws the letter
 * `R` as glyph 3 of a font called `ABCDEF+Calibri`, and without this table glyph 3 is the
 * character ``. Producers write it because search has to work; this reads it for the
 * same reason.
 */
function toUnicode(bytes) {
  const map = new Map()
  const text = bytes.toString('latin1')
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]*)>/gi)) {
      map.set(parseInt(pair[1], 16), utf16(pair[2]))
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    // `<20> <7e> <0020>` — a run, and the far more common of the two forms.
    for (const run of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi)) {
      const from = parseInt(run[1], 16)
      const to = parseInt(run[2], 16)
      const start = parseInt(run[3], 16)
      if (to - from > 0xffff) continue
      for (let at = from; at <= to; at++) map.set(at, String.fromCharCode(start + (at - from)))
    }
    // `<20> <22> [<0041> <0042> <0043>]` — a run with a value each.
    for (const run of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*\[([\s\S]*?)\]/gi)) {
      const from = parseInt(run[1], 16)
      const each = [...run[3].matchAll(/<([0-9a-f]*)>/g)]
      each.forEach((one, at) => map.set(from + at, utf16(one[1])))
    }
  }
  return map
}

/** What a glyph nobody published a width for is assumed to be. Half an em, as ever. */
const DEFAULT_WIDTH = 500

/**
 * How wide each character is, in thousandths of an em — the font's own `/Widths` or `/W`.
 *
 * **This is what makes a word break trustworthy.** Without it the only way to tell *the next
 * run starts further along than this one reached* is to guess an average glyph width, and a
 * guess is wrong on every proportional font: it under-measures `agreement` and the reader
 * decides the producer left a gap in the middle of the word. Measured from the file, the same
 * test is exact for every font that publishes a table, which is every embedded font.
 */
function widths(all, dict, wide) {
  const advance = new Map()
  if (!wide) {
    const first = Number(value(dict, 'FirstChar') ?? 0)
    numbersIn(resolve(all, value(dict, 'Widths')) ?? '').forEach((one, at) => advance.set(first + at, one))
    const descriptor = String(resolve(all, value(dict, 'FontDescriptor')) ?? '')
    const missing = Number(value(descriptor, 'MissingWidth') ?? NaN)
    return { advance, fallback: Number.isFinite(missing) ? missing : DEFAULT_WIDTH }
  }
  const child = references(value(dict, 'DescendantFonts')).at(0)
  const descendant = child === undefined ? '' : (all.get(child)?.dict ?? '')
  const fallback = Number(value(descendant, 'DW') ?? 1000)
  // `/W [ 3 [600 700] 10 20 500 ]` — either a code and a list, or a range and one width.
  const array = String(value(descendant, 'W') ?? '')
  const marks = /(\d+)\s*\[([^\]]*)\]|(\d+)\s+(\d+)\s+(-?[\d.]+)/g
  for (let hit = marks.exec(array); hit !== null; hit = marks.exec(array)) {
    if (hit[2] !== undefined) {
      numbersIn(hit[2]).forEach((one, at) => advance.set(Number(hit[1]) + at, one))
    } else {
      const from = Number(hit[3])
      const to = Math.min(Number(hit[4]), from + 65535)
      for (let at = from; at <= to; at++) advance.set(at, Number(hit[5]))
    }
  }
  return { advance, fallback: Number.isFinite(fallback) ? fallback : 1000 }
}

const numbersIn = (text) => [...String(text).matchAll(/-?\d+(?:\.\d+)?/g)].map((one) => Number(one[0]))

/** Every font the page's resources name, ready to turn bytes into characters. */
function fonts(all, resources) {
  const found = new Map()
  const dict = value(String(resources ?? ''), 'Font')
  if (dict === undefined) return found
  const table = reference(dict) === undefined ? dict : (all.get(reference(dict))?.dict ?? '')
  for (const named of String(table).matchAll(/\/([A-Za-z0-9#+._-]+)\s+(\d+)\s+\d+\s+R/g)) {
    const font = all.get(Number(named[2]))
    if (!font) continue
    const unicode = reference(value(font.dict, 'ToUnicode'))
    const cmap = unicode === undefined ? undefined : decoded(all.get(unicode))
    // A composite font addresses its glyphs with two bytes. `Identity-H` is what every
    // producer that embeds a subset writes, and it is the case this has to get right.
    const wide = /\/Type0\b/.test(font.dict)
    found.set(named[1], {
      wide,
      map: cmap === undefined ? undefined : toUnicode(cmap),
      ...widths(all, font.dict, wide),
    })
  }
  return found
}

/**
 * One string from the content stream: the characters it stands for, and how far it moved the
 * pen — in thousandths of an em, which is the unit the widths are published in.
 */
function say(bytes, font) {
  const wide = font?.wide === true
  let out = ''
  let width = 0
  let glyphs = 0
  let spaces = 0
  for (let at = 0; at < bytes.length; at += wide ? 2 : 1) {
    const code = wide ? ((bytes[at] << 8) | (bytes[at + 1] ?? 0)) : bytes[at]
    const mapped = font?.map?.get(code)
    if (mapped !== undefined) out += mapped
    else if (wide) out += code >= 0x20 && code !== 0xffff ? String.fromCharCode(code) : ''
    else out += CP1252[code] ?? String.fromCharCode(code)
    width += font?.advance?.get(code) ?? font?.fallback ?? DEFAULT_WIDTH
    glyphs += 1
    // Word spacing applies to the single byte 32, and only in a simple font.
    if (!wide && code === 32) spaces += 1
  }
  return { text: out, width, glyphs, spaces }
}

// ---- the content stream -----------------------------------------------------------------

/** One PostScript-ish token. Strings come back as bytes, because that is what they are. */
function* tokens(text) {
  let at = 0
  while (at < text.length) {
    const here = text[at]
    if (/\s/.test(here)) {
      at += 1
    } else if (here === '%') {
      const ends = text.indexOf('\n', at)
      at = ends === -1 ? text.length : ends + 1
    } else if (here === '(') {
      const [bytes, next] = literal(text, at + 1)
      at = next
      yield { kind: 'string', bytes }
    } else if (here === '<' && text[at + 1] !== '<') {
      const ends = text.indexOf('>', at)
      const hex = text.slice(at + 1, ends === -1 ? text.length : ends).replace(/[^0-9a-f]/gi, '')
      at = ends === -1 ? text.length : ends + 1
      yield { kind: 'string', bytes: Buffer.from(hex.length % 2 === 0 ? hex : `${hex}0`, 'hex') }
    } else if (text.startsWith('<<', at) || text.startsWith('>>', at)) {
      yield { kind: 'punctuation', text: text.slice(at, at + 2) }
      at += 2
    } else if (here === '[' || here === ']' || here === '{' || here === '}') {
      yield { kind: 'punctuation', text: here }
      at += 1
    } else if (here === '/') {
      const word = /^\/[^\s/[\]<>(){}%]*/.exec(text.slice(at))?.[0] ?? '/'
      at += word.length
      yield { kind: 'name', text: word.slice(1) }
    } else {
      const word = /^[^\s/[\]<>(){}%]+/.exec(text.slice(at))?.[0] ?? here
      at += word.length
      /**
       * An inline image's bytes, skipped whole.
       *
       * `ID` is followed by raw image data and then `EI`, and those bytes are not tokens: a
       * stray `(` in a JPEG would open a string that swallows the rest of the page. Rare in
       * a document with words in it, and catastrophic when it happens.
       */
      if (word === 'ID') {
        const ends = /\sEI(?=[\s/[\]<>(){}%]|$)/.exec(text.slice(at))
        at += ends === undefined ? text.length : ends.index + ends[0].length
        continue
      }
      const asNumber = Number(word)
      if (Number.isFinite(asNumber) && /^[-+.\d]/.test(word)) yield { kind: 'number', value: asNumber }
      else yield { kind: 'operator', text: word }
    }
  }
}

/** A `( … )` string, with the escapes and the balanced parentheses inside it. */
function literal(text, at) {
  const out = []
  let depth = 1
  while (at < text.length) {
    const here = text[at]
    if (here === '\\') {
      const next = text[at + 1]
      const octal = /^[0-7]{1,3}/.exec(text.slice(at + 1))?.[0]
      if (octal !== undefined) {
        out.push(parseInt(octal, 8) & 0xff)
        at += 1 + octal.length
        continue
      }
      const escapes = { n: 10, r: 13, t: 9, b: 8, f: 12 }
      if (next === '\n') at += 2
      else if (next === '\r') at += text[at + 2] === '\n' ? 3 : 2
      else {
        out.push(escapes[next] ?? next.charCodeAt(0))
        at += 2
      }
      continue
    }
    if (here === '(') depth += 1
    if (here === ')') {
      depth -= 1
      if (depth === 0) return [Buffer.from(out), at + 1]
    }
    out.push(here.charCodeAt(0))
    at += 1
  }
  return [Buffer.from(out), at]
}

/**
 * One page's content stream, as the words on it.
 *
 * **Line and word breaks come from the text matrix**, which is the only place they exist: a
 * PDF has no paragraphs, no newlines and — this is the one that surprises people — often no
 * spaces. It has instructions to draw a run of glyphs at a position. So a move down the page
 * is a line, a move along it that is wider than the run just drawn is a space, and a `TJ`
 * nudge past a threshold is a space too.
 *
 * The pen position is tracked with the font's own published widths, so the question *did the
 * next run start further along than this one reached* has an exact answer rather than an
 * estimate. That matters more than it sounds: a producer that repositions the pen in the
 * middle of a word — and Chrome's does, constantly — turns any guess into `agr eement`.
 */
function spoken(text, byName) {
  let out = ''
  let font
  let size = 12
  let leading = 0
  let charSpace = 0
  let wordSpace = 0
  let horizontal = 1
  // The text and line matrices, as PDF defines them. Only the translation and the scale are
  // used; the rest matters for rendering, which this is not doing.
  let line = [1, 0, 0, 1, 0, 0]
  let matrix = [...line]
  /**
   * The graphics state's own matrix, and the stack `q`/`Q` push it onto.
   *
   * Tracked rather than ignored because a page is normally drawn inside one or more
   * `q … cm … Q` groups, and the text matrix alone is measured in whatever space the
   * innermost one set up. Two runs in two groups would then be compared in two different
   * coordinate systems, and every comparison this file makes is between two positions.
   */
  let ctm = [1, 0, 0, 1, 0, 0]
  const saved = []
  /** Where the pen is, as far as this can tell, and where the last line was. */
  let penX = 0
  let penY
  let pending = ''
  const stack = []

  /** Text space through the graphics state, which is where the glyph actually lands. */
  const here = () => times(matrix, ctm)
  /** How much of a text-space unit reaches the page. */
  const scale = () => {
    const on = here()
    return Math.hypot(on[0], on[1]) || 1
  }
  /** The size a character is actually drawn at, which is the font size through the matrix. */
  const drawn = () => scale() * size

  const move = (tx, ty) => {
    line = [line[0], line[1], line[2], line[3], tx * line[0] + ty * line[2] + line[4], tx * line[1] + ty * line[3] + line[5]]
    matrix = [...line]
    placed()
  }
  /** The pen was moved. Whether that was a new line, a gap, or neither, is decided here. */
  const placed = () => {
    const em = drawn()
    const on = here()
    if (penY !== undefined && Math.abs(on[5] - penY) > Math.max(0.5, em * 0.3)) pending = '\n'
    // Forward only. A run that starts *behind* the last one is an underline, a highlight or
    // a second pass over the same words, and none of those is a word break.
    else if (penY !== undefined && on[4] - penX > em * 0.2) pending = pending === '\n' ? '\n' : ' '
    penX = on[4]
    penY = on[5]
  }
  const gap = (text) => {
    if (text === '' || out === '' || out.endsWith('\n')) return
    if (text === ' ' && out.endsWith(' ')) return
    out += text
  }
  const show = (bytes) => {
    gap(pending)
    pending = ''
    const said = say(bytes, font)
    out += said.text
    // PDF 32000 9.4.4, minus the vertical case: the pen moves by the glyph's own width plus
    // whatever spacing is switched on, all of it through the horizontal scale.
    penX += (((said.width / 1000) * size + said.glyphs * charSpace + said.spaces * wordSpace) * horizontal) * scale()
    penY = here()[5]
  }

  for (const token of tokens(text)) {
    if (token.kind !== 'operator') {
      stack.push(token)
      if (stack.length > 64) stack.shift()
      continue
    }
    const numbers = stack.filter((one) => one.kind === 'number').map((one) => one.value)
    switch (token.text) {
      case 'q':
        saved.push([...ctm])
        break
      case 'Q':
        ctm = saved.pop() ?? ctm
        break
      case 'cm':
        ctm = times(sixOf(numbers), ctm)
        break
      // The matrices reset and **nothing is decided**. `BT` puts the pen at the origin of a
      // space nothing has been drawn in yet, and asking *is this a new line* about it says
      // yes every time — which is a newline between every two runs on the same row.
      case 'BT':
        line = [1, 0, 0, 1, 0, 0]
        matrix = [...line]
        break
      case 'Tf': {
        const name = stack.filter((one) => one.kind === 'name').at(-1)?.text
        if (name !== undefined) font = byName.get(name)
        size = Math.abs(numbers.at(-1) ?? 12) || 12
        break
      }
      case 'TL':
        leading = numbers.at(-1) ?? 0
        break
      case 'Tc':
        charSpace = numbers.at(-1) ?? 0
        break
      case 'Tw':
        wordSpace = numbers.at(-1) ?? 0
        break
      case 'Tz':
        horizontal = (numbers.at(-1) ?? 100) / 100
        break
      case 'Td':
        move(numbers.at(-2) ?? 0, numbers.at(-1) ?? 0)
        break
      case 'TD':
        leading = -(numbers.at(-1) ?? 0)
        move(numbers.at(-2) ?? 0, numbers.at(-1) ?? 0)
        break
      case 'Tm':
        line = sixOf(numbers)
        matrix = [...line]
        placed()
        break
      case 'T*':
        move(0, -leading)
        break
      case 'Tj':
      case "'":
      case '"': {
        // `aw ac string "` sets both spacings before it draws, which is the one operator
        // that is three instructions in a trench coat.
        if (token.text === '"') {
          wordSpace = numbers.at(-2) ?? wordSpace
          charSpace = numbers.at(-1) ?? charSpace
        }
        if (token.text !== 'Tj') move(0, -leading)
        const said = stack.filter((one) => one.kind === 'string').at(-1)
        if (said) show(said.bytes)
        break
      }
      case 'TJ': {
        const opened = lastIndexOfPunctuation(stack, '[')
        for (const one of stack.slice(opened + 1)) {
          if (one.kind === 'string') show(one.bytes)
          else if (one.kind === 'number') {
            // A kerning nudge is a number in thousandths of an em, and a big negative one is
            // how most producers write a space they never drew a glyph for. It also moves
            // the pen, which is why it is subtracted rather than only tested.
            penX += (-one.value / 1000) * size * horizontal * scale()
            if (one.value < -170) pending = pending === '\n' ? '\n' : ' '
          }
        }
        break
      }
      default:
        break
    }
    stack.length = 0
  }
  return out
}

/** Two of PDF's six-number matrices, multiplied. The one piece of arithmetic in this file. */
const times = (m, n) => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
]

/** The last six numbers an operator was handed, padded when a producer wrote fewer. */
const sixOf = (numbers) => {
  const six = numbers.slice(-6)
  while (six.length < 6) six.unshift(0)
  return six
}

const lastIndexOfPunctuation = (stack, text) => {
  for (let at = stack.length - 1; at >= 0; at--) if (stack[at].kind === 'punctuation' && stack[at].text === text) return at
  return -1
}

// ---- pages ------------------------------------------------------------------------------

/**
 * The pages, in reading order, each with the resources it inherited.
 *
 * Walked from the catalogue when there is one, because the page *tree* is the only thing that
 * knows the order — object numbers do not. When there is not, every page object in file order
 * is a good enough answer and is better than nothing.
 */
function pages(all) {
  const root = [...all].find(([, one]) => /\/Type\s*\/Catalog\b/.test(one.dict))?.[1]
  const top = root === undefined ? undefined : reference(value(root.dict, 'Pages'))
  const found = []
  const seen = new Set()

  const walk = (at, inherited, depth) => {
    if (at === undefined || seen.has(at) || depth > 64 || found.length > 4000) return
    seen.add(at)
    const node = all.get(at)
    if (!node) return
    const resources = value(node.dict, 'Resources') ?? inherited
    if (/\/Type\s*\/Pages\b/.test(node.dict)) {
      for (const kid of references(value(node.dict, 'Kids'))) walk(kid, resources, depth + 1)
      return
    }
    if (/\/Type\s*\/Page\b/.test(node.dict)) found.push({ node, resources })
  }
  walk(top, undefined, 0)

  if (found.length > 0) return found
  return [...all]
    .filter(([, one]) => /\/Type\s*\/Page\b/.test(one.dict) && !/\/Type\s*\/Pages\b/.test(one.dict))
    .map(([, node]) => ({ node, resources: value(node.dict, 'Resources') }))
}

/**
 * A PDF's text layer, page by page.
 *
 * Returns `undefined` for the file that has pages and no words in them, which is the scan.
 * The caller turns that into the sentence, because the caller is the one that knows what is
 * installed to read one.
 */
export function fromPdf(bytes) {
  const raw = bytes.toString('latin1')
  if (!raw.startsWith('%PDF-') && !raw.slice(0, 1024).includes('%PDF-')) {
    throw new Error('that file does not start like a PDF')
  }
  if (/\/Encrypt\b/.test(raw.slice(-2048))) {
    throw new Error('that PDF is encrypted, and this cannot open a protected file')
  }
  const all = expand(objects(raw))
  const sheets = pages(all)
  if (sheets.length === 0) throw new Error('there are no pages in that PDF')

  const said = sheets.map(({ node, resources }) => {
    const byName = fonts(all, resolve(all, resources) ?? resources)
    const streams = references(value(node.dict, 'Contents'))
    const only = reference(value(node.dict, 'Contents'))
    const parts = (streams.length > 0 ? streams : only === undefined ? [] : [only])
      .map((at) => decoded(all.get(at)))
      .filter((one) => one !== undefined)
    return parts.map((part) => spoken(part.toString('latin1'), byName)).join('\n')
  })

  const text = said
    .map((page) => page.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim())
    .map((page, at) => (said.length === 1 ? page : `**page ${String(at + 1)}**\n\n${page}`))
    .filter((page) => page.trim() !== '')
    .join('\n\n')
    .trim()

  // Words, not characters: a scan often carries a handful of stray glyphs from a watermark
  // or a stamped page number, and calling that a text layer is how a scan comes back as
  // three words and an air of confidence.
  const words = text.split(/\s+/).filter((one) => /\p{L}|\p{N}/u.test(one)).length
  return { text, pages: sheets.length, empty: words < sheets.length * 3 }
}
