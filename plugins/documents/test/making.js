// SPDX-License-Identifier: AGPL-3.0-only
import { deflateRawSync } from 'node:zlib'

/**
 * The fixtures, built rather than committed.
 *
 * A test suite for a document reader wants a `.docx`, a `.xlsx` and a PDF to read, and there
 * are two ways to have one: check a binary into the repo, or write the twenty lines that
 * produce it. The second is better here for a reason specific to these formats — a committed
 * binary says nothing about *why* it is shaped the way it is, and every one of these files
 * exists to exercise one particular thing the reader has to get right.
 *
 * They are minimal on purpose and they are not what Word writes. What proves the reader
 * against a real producer is `real-pdf.test.js`, which reads a PDF made by a browser.
 */

/** A ZIP, with a central directory the reader will actually walk. */
export function zip(entries) {
  const files = []
  const directory = []
  let at = 0
  for (const [name, body] of Object.entries(entries)) {
    const raw = Buffer.from(body, 'utf8')
    const packed = deflateRawSync(raw)
    const named = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc32(raw), 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(named.length, 26)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(8, 10)
    entry.writeUInt32LE(crc32(raw), 16)
    entry.writeUInt32LE(packed.length, 20)
    entry.writeUInt32LE(raw.length, 24)
    entry.writeUInt16LE(named.length, 28)
    entry.writeUInt32LE(at, 42)

    files.push(local, named, packed)
    directory.push(entry, named)
    at += local.length + named.length + packed.length
  }
  const body = Buffer.concat(files)
  const listing = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(entries).length, 8)
  end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(listing.length, 12)
  end.writeUInt32LE(body.length, 16)
  return Buffer.concat([body, listing, end])
}

/** The one checksum a ZIP needs. Nothing here reads it, but a real unzip does. */
function crc32(bytes) {
  let crc = ~0
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

const paragraph = (text, style) =>
  `<w:p>${style === undefined ? '' : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`

export const docx = (body) =>
  zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`,
  })

export const docxParagraph = paragraph

export const docxTable = (grid) =>
  `<w:tbl>${grid
    .map((row) => `<w:tr>${row.map((cell) => `<w:tc>${paragraph(cell)}</w:tc>`).join('')}</w:tr>`)
    .join('')}</w:tbl>`

export const xlsx = (rows) =>
  zip({
    'xl/workbook.xml': '<?xml version="1.0"?><workbook><sheets><sheet name="Costs" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet><sheetData>${rows
      .map(
        (row, at) =>
          `<row r="${String(at + 1)}">${row
            .map((cell, column) =>
              cell === '' ? ''
              : `<c r="${String.fromCharCode(65 + column)}${String(at + 1)}"${typeof cell === 'number' ? '' : ' t="inlineStr"'}>` +
                (typeof cell === 'number' ? `<v>${String(cell)}</v>` : `<is><t>${cell}</t></is>`) +
                '</c>',
            )
            .join('')}</row>`,
      )
      .join('')}</sheetData></worksheet>`,
  })

export const pptx = (slides) =>
  zip(
    Object.fromEntries(
      slides.map((lines, at) => [
        `ppt/slides/slide${String(at + 1)}.xml`,
        `<?xml version="1.0"?><p:sld xmlns:a="x"><p:cSld>${lines
          .map((line) => `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`)
          .join('')}</p:cSld></p:sld>`,
      ]),
    ),
  )

export const odt = (body) =>
  zip({
    mimetype: 'application/vnd.oasis.opendocument.text',
    'content.xml': `<?xml version="1.0"?><office:document-content><office:body><office:text>${body}</office:text></office:body></office:document-content>`,
  })

export const epub = (chapters) =>
  zip({
    mimetype: 'application/epub+zip',
    'META-INF/container.xml':
      '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>',
    'OEBPS/book.opf':
      '<?xml version="1.0"?><package><manifest>' +
      chapters.map((_one, at) => `<item id="c${String(at)}" href="c${String(at)}.xhtml"/>`).join('') +
      '</manifest><spine>' +
      // Deliberately back to front: the spine is the reading order, and a folder listing is
      // not. A reader that ignores it gets the chapters in whatever order the archive holds.
      chapters.map((_one, at) => `<itemref idref="c${String(chapters.length - 1 - at)}"/>`).join('') +
      '</spine></package>',
    ...Object.fromEntries(
      chapters.map((text, at) => [`OEBPS/c${String(at)}.xhtml`, `<html><body><h1>${text}</h1></body></html>`]),
    ),
  })

/**
 * A one-page PDF with a real text layer, assembled by hand.
 *
 * The offsets in the cross-reference table are deliberately **left wrong** by the caller in
 * one test, because the reader's whole approach is that it does not read them — half the
 * PDFs in the world are written by software that got that table slightly off.
 */
export function pdf(lines, { objects: extra = [] } = {}) {
  const content = lines
    .map(({ text, x, y, size = 12 }) => `BT /F1 ${String(size)} Tf 1 0 0 1 ${String(x)} ${String(y)} Tm (${text}) Tj ET`)
    .join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...extra,
  ]
  let out = '%PDF-1.4\n'
  for (const [at, body] of objects.entries()) out += `${String(at + 1)} 0 obj\n${body}\nendobj\n`
  // A cross-reference table that points at nothing in particular, which is the point.
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`
  for (let n = 0; n < objects.length; n++) out += '0000000000 00000 n \n'
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n0\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
