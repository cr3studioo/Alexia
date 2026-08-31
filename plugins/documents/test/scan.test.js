// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { expect, test } from 'vitest'
import { pageImages } from '../pdf.js'
import { read } from '../read.js'
import { scan } from './making.js'

/**
 * Getting the page **out** of a PDF that is a photograph of one, which is half of reading a
 * scan and the half that lives here. The other half is recognition, and it belongs to
 * whatever provides `image.ocr` — this file never calls it and does not need it installed.
 *
 * The load-bearing observation is that **a scanned page is one image**, so there is nothing
 * to render: no content stream to execute, no compositing, no clipping paths. That is why
 * this is thirty lines instead of a rasteriser, and every test below is about the wrapper
 * rather than about pixels.
 */

const fixture = (name) => readFileSync(join(import.meta.dirname, name))

test('a PDF a browser printed from an image gives up its page, untouched', () => {
  // A real producer, not this file's own idea of one. `scanned-page.pdf` was printed by
  // Edge from a JPEG of a bank statement — the shape a scanner or a phone actually writes,
  // and the reason it is a committed binary is the same reason `browser-print.pdf` is: a
  // reader tested only against its own fixtures agrees with itself.
  const sheets = pageImages(fixture('scanned-page.pdf'))
  expect(sheets).toHaveLength(1)
  expect(sheets[0].width).toBe(1700)
  expect(sheets[0].height).toBe(2200)
  // `ffd8ff` is a JPEG's own first three bytes. The stream *is* the file, so handing it over
  // untouched is the whole of the work — anything else here would be re-encoding a scan.
  expect(sheets[0].bytes.subarray(0, 3).toString('hex')).toBe('ffd8ff')
})

test('the text reader still refuses that same file, in the words it always used', () => {
  // The refusal is not softened by the existence of an OCR tier and this proves it: nothing
  // in `read.js` or `kinds.js` knows OCR exists. On a machine with no OCR plugin this
  // sentence is what a person gets, exactly as it was the day before OCR was written.
  expect(() => read('scanned-page.pdf', fixture('scanned-page.pdf'))).toThrow(
    /no text layer — it is a picture of a document/,
  )
})

test('a PDF with a real text layer has no page picture to offer', () => {
  // The contrast that makes the routing safe. This file is read by the text path and never
  // reaches OCR at all, so a born-digital document never pays for recognition.
  const sheets = pageImages(fixture('browser-print.pdf'))
  expect(sheets.every((sheet) => sheet.bytes === undefined)).toBe(true)
})

test('a page stored as raw samples comes back as a picture something can open', () => {
  // What a screenshot pasted into a document and printed becomes: Flate, not JPEG. It
  // arrives as bare samples with no header, so it needs the smallest container that
  // describes them.
  const width = 300
  const height = 400
  const samples = Buffer.alloc(width * height, 0x7f)
  const sheets = pageImages(scan([{ width, height, filter: '/FlateDecode', stream: deflateSync(samples), gray: true }]))

  expect(sheets).toHaveLength(1)
  expect(sheets[0].bytes.subarray(0, 2).toString('latin1')).toBe('BM')
  expect(sheets[0].bytes.readInt32LE(18)).toBe(width)
  // **Negative, meaning top-down.** A BMP is bottom-up by default, and a page delivered
  // upside down is one that OCR reads as nothing rather than as an error — which is the
  // silent failure this whole feature is written against.
  expect(sheets[0].bytes.readInt32LE(22)).toBe(-height)
})

test('a page this cannot unwrap says which format it is, rather than vanishing', () => {
  // Fax compression is what an office scanner writes for black-and-white, and unwrapping it
  // is a codec this does not have. Dropping the page silently would lose it from the middle
  // of a document with no sign anything was missing; naming it lets a person act.
  const sheets = pageImages(scan([{ width: 1200, height: 1600, filter: '/CCITTFaxDecode', stream: 'not really' }]))
  expect(sheets[0].bytes).toBeUndefined()
  expect(sheets[0].why).toMatch(/fax compression/)
})

test('the logo in the corner is not mistaken for the page', () => {
  // A scanned letterhead has two images on it and only one of them is the page. OCR'ing the
  // wrong one returns a company name and an air of having worked.
  const page = Buffer.alloc(800 * 1000, 0xff)
  const logo = Buffer.alloc(64 * 64, 0x00)
  const sheets = pageImages(
    scan([
      { width: 64, height: 64, filter: '/FlateDecode', stream: deflateSync(logo), gray: true },
      { width: 800, height: 1000, filter: '/FlateDecode', stream: deflateSync(page), gray: true },
    ]),
  )
  expect(sheets).toHaveLength(1)
  expect(sheets[0].width).toBe(800)
})

test('a page with nothing on it at all says so', () => {
  const sheets = pageImages(scan([]))
  expect(sheets[0].why).toMatch(/no picture on it/)
})
