// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { expect, test } from 'vitest'
import { fromPdf } from '../pdf.js'
import { pdf } from './making.js'

/**
 * The PDF reader, against the two things that actually break one.
 *
 * **The first is a real producer.** `browser-print.pdf` was printed by a browser and is a
 * checked-in binary on purpose: everything else in this suite is a fixture written by the
 * same hand that wrote the reader, and a reader tested only against its own idea of a PDF is
 * a reader that agrees with itself. That file has what a hand-made one does not — subset
 * fonts addressed two bytes at a time, a `ToUnicode` table standing between the bytes and the
 * letters, a graphics-state matrix, and words positioned run by run rather than line by line.
 * Its extraction was compared against `pdfjs-dist` and is identical.
 *
 * **The second is the structure.** Object streams, a cross-reference table that lies, and a
 * page that is a picture. Each has its own test below and each was, at some point while this
 * was written, wrong.
 */

const here = import.meta.dirname

test('a browser’s own PDF comes back as the page that was printed', () => {
  const found = fromPdf(readFileSync(join(here, 'browser-print.pdf')))
  expect(found.pages).toBe(2)
  expect(found.empty).toBe(false)
  expect(found.text.split('\n\n')).toEqual([
    '**page 1**',
    'Rent agreement\n' +
      'This agreement is made on 31 August 2026 between Alexia Ltd and the tenant.\n' +
      'Payment\n' +
      'The rent is 18 500 CZK per month, due on the first working day.\n' +
      // The table's two columns are separately positioned on one line. Telling that from a
      // line break needs the pen position, and telling it from *no space at all* needs the
      // font's own widths — both of which is what the reader keeps a text matrix for.
      'Item Amount\n' +
      'Rent 18500\n' +
      'Deposit 37000\n' +
      'Příliš žluťoučký kůň úpěl ďábelské ódy — and a “quoted” phrase.',
    '**page 2**',
    'Clause 7 applies to late payment.',
  ])
})

test('a word is not broken in half by a producer repositioning inside it', () => {
  // Chrome repositions the pen mid-word constantly. Guessing an average glyph width turns
  // `agreement` into `agr eement`, and a reader that does that to one word does it to
  // hundreds. The published widths are what make the question exact.
  const { text } = fromPdf(readFileSync(join(here, 'browser-print.pdf')))
  expect(text).not.toMatch(/\b\w+ \w{1,3}ement\b/)
  expect(text).toContain('agreement')
})

test('the cross-reference table is not read, so a wrong one costs nothing', () => {
  // `making.js` writes every offset as zero. Half the PDFs in the world are written by
  // software that got that table slightly off, and every real reader has a rebuild path.
  // This one is only that path.
  const found = fromPdf(pdf([{ text: 'Found anyway', x: 72, y: 700 }]))
  expect(found.text).toBe('Found anyway')
})

test('objects packed into an object stream are found', () => {
  // PDF 1.5 lets a producer compress its small objects — the page dictionary among them —
  // into one stream. Word and every TeX distribution do it, and without unpacking it a file
  // looks like it has three objects in it and no pages at all.
  const packed = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>']
  const offsets = []
  let body = ''
  for (const [at, one] of packed.entries()) {
    offsets.push(`${String(at + 1)} ${String(body.length)}`)
    body += `${one} `
  }
  const header = `${offsets.join(' ')} `
  const stream = deflateSync(Buffer.from(header + body, 'latin1'))
  const content = 'BT /F1 12 Tf 1 0 0 1 72 700 Tm (Inside an object stream) Tj ET'
  const parts = [
    `6 0 obj\n<< /Type /ObjStm /N 2 /First ${String(header.length)} /Filter /FlateDecode /Length ${String(stream.length)} >>\nstream\n`,
    stream.toString('latin1'),
    '\nendstream\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ]
  const file = Buffer.from(`%PDF-1.5\n${parts.join('')}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1')

  const found = fromPdf(file)
  expect(found.pages).toBe(1)
  expect(found.text).toBe('Inside an object stream')
})

test('a page with no words in it is reported as having none', () => {
  // Not thrown here: this file says what it found and the caller decides what that means,
  // because the caller is the one that knows whether anything is installed to read a scan.
  const found = fromPdf(pdf([]))
  expect(found.pages).toBe(1)
  expect(found.empty).toBe(true)
})

test('a stamped page number is not mistaken for a text layer', () => {
  // The failure this threshold exists for: a scan often carries a handful of stray glyphs
  // from a watermark or a page number, and three words is not a document.
  const found = fromPdf(pdf([{ text: '1', x: 300, y: 40 }]))
  expect(found.empty).toBe(true)
})

test('a file that is not a PDF is refused as one', () => {
  expect(() => fromPdf(Buffer.from('just some text', 'utf8'))).toThrow(/does not start like a PDF/)
})

test('an encrypted PDF says it is locked rather than coming back empty', () => {
  const locked = Buffer.concat([
    pdf([{ text: 'hidden', x: 72, y: 700 }]),
    Buffer.from('trailer\n<< /Encrypt 9 0 R >>\n%%EOF\n', 'latin1'),
  ])
  expect(() => fromPdf(locked)).toThrow(/encrypted/)
})

test('pages come back in the order the page tree says, not the order the objects are in', () => {
  // Object numbers are not reading order. A file whose pages are numbered backwards is
  // ordinary — an incremental save produces one — and reading them that way silently
  // reverses the document.
  const first = 'BT /F1 12 Tf 1 0 0 1 72 700 Tm (First page) Tj ET'
  const second = 'BT /F1 12 Tf 1 0 0 1 72 700 Tm (Second page) Tj ET'
  const file = Buffer.from(
    '%PDF-1.4\n' +
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
      '2 0 obj\n<< /Type /Pages /Kids [8 0 R 7 0 R] /Count 2 >>\nendobj\n' +
      '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n' +
      '7 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n' +
      '8 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 3 0 R >>\nendobj\n' +
      `3 0 obj\n<< /Length ${String(first.length)} >>\nstream\n${first}\nendstream\nendobj\n` +
      `4 0 obj\n<< /Length ${String(second.length)} >>\nstream\n${second}\nendstream\nendobj\n` +
      'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
    'latin1',
  )
  const found = fromPdf(file)
  expect(found.pages).toBe(2)
  expect(found.text.indexOf('First page')).toBeLessThan(found.text.indexOf('Second page'))
})

test('resources inherited from the page tree still reach the page', () => {
  // `/Resources` may sit on the `Pages` node and be inherited. A page that does not look up
  // the tree for it has no font, and no font means no `ToUnicode` — which is the difference
  // between the document and a page of wrong letters.
  const content = 'BT /F1 12 Tf 1 0 0 1 72 700 Tm (Inherited resources) Tj ET'
  const file = Buffer.from(
    '%PDF-1.4\n' +
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n' +
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n' +
      `4 0 obj\n<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream\nendobj\n` +
      '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n' +
      'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
    'latin1',
  )
  expect(fromPdf(file).text).toBe('Inherited resources')
})
