// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { assemble, bands } from '../lines.js'

/**
 * Reading order, which is the whole of what this plugin adds to the engine underneath it.
 *
 * The fixture below is **the real thing**, not an invented one: it is what
 * `Windows.Media.Ocr` actually returned for an A4 invoice rendered at 300 dpi, boxes and
 * all, in the order it returned them. That order is wrong in the specific way that matters —
 * the columns have come apart from their rows — so a test written against a tidied-up
 * version of it would be testing nothing.
 */
const invoice = [
  { text: 'ACME Supplies Limited', top: 209, left: 208, height: 44 },
  { text: 'Invoice number 4711', top: 389, left: 209, height: 35 },
  { text: 'Description', top: 569, left: 208, height: 44 },
  { text: 'Widget, brass, 8mm', top: 659, left: 209, height: 44 },
  { text: 'Bracket, steel', top: 749, left: 208, height: 42 },
  { text: 'Total due 129.50 EUR', top: 929, left: 209, height: 42 },
  { text: 'Date 12 March 2026', top: 389, left: 707, height: 35 },
  { text: 'Qty Price', top: 569, left: 680, height: 44 },
  { text: '3', top: 751, left: 707, height: 39 },
  { text: '12 42.00', top: 661, left: 777, height: 42 },
  { text: '18.50', top: 751, left: 806, height: 39 },
  { text: 'Payment within 30 days of the date above. Late', top: 1109, left: 208, height: 39 },
  { text: 'payment attracts interest at 8% above base rate.', top: 1199, left: 208, height: 39 },
]

test('the columns come back attached to the rows they belong to', () => {
  // The failure this file exists to prevent: unsorted, the engine puts "Date 12 March 2026"
  // five lines below the invoice number it sits beside, and 18.50 nowhere near the bracket
  // it is the price of. Nothing errors, and no reader of the output can tell.
  expect(assemble(invoice).split('\n')).toEqual([
    'ACME Supplies Limited',
    '',
    'Invoice number 4711  Date 12 March 2026',
    '',
    'Description  Qty Price',
    'Widget, brass, 8mm  12 42.00',
    'Bracket, steel  3  18.50',
    '',
    'Total due 129.50 EUR',
    '',
    'Payment within 30 days of the date above. Late',
    'payment attracts interest at 8% above base rate.',
  ])
})

test('a row is one row even when its cells do not share a top edge', () => {
  // 659 and 661 are the same row of the same table, two pixels apart, because a scan is
  // never perfectly straight and neither is a rendered font's baseline. A fixed grid of
  // bands would put these two in different rows whenever the boundary fell between them.
  const row = bands(
    [
      { text: 'Widget, brass, 8mm', top: 659, left: 209, height: 44 },
      { text: '12 42.00', top: 661, left: 777, height: 42 },
    ],
    44 * 0.6,
  )
  expect(row).toHaveLength(1)
  expect(row[0].lines.map((one) => one.text)).toEqual(['Widget, brass, 8mm', '12 42.00'])
})

test('lines of one paragraph stay together and a new block starts a new one', () => {
  // 1109 → 1199 is 90px on a 39px line: the next line of the same sentence. 929 → 1109 is
  // 180px: something else. Losing that turns a letter into one unbroken run.
  const found = assemble(invoice)
  expect(found).toContain('Payment within 30 days of the date above. Late\npayment attracts')
  expect(found).toContain('Total due 129.50 EUR\n\nPayment within')
})

test('a picture with no words in it comes back empty rather than as whitespace', () => {
  // The caller turns this into a sentence naming what happened. An empty string it can test
  // for is what lets it; a string of newlines is one it would have to guess about.
  expect(assemble([])).toBe('')
  expect(assemble([{ text: '   ', top: 10, left: 10, height: 10 }])).toBe('')
  expect(assemble(undefined)).toBe('')
})

test('a line the engine gave no box for is dropped rather than sorted to the top', () => {
  // `top: undefined` sorts as NaN, which in a comparator means "leave it wherever it was" —
  // so one malformed line would silently scramble the order of every line around it.
  const found = assemble([
    { text: 'second', top: 200, left: 10, height: 20 },
    { text: 'broken', left: 10, height: 20 },
    { text: 'first', top: 100, left: 10, height: 20 },
  ])
  expect(found.split('\n').filter((line) => line !== '')).toEqual(['first', 'second'])
})

test('the tolerance scales with the text, so a screen crop reads like a page does', () => {
  // The same shape at a tenth the size: a menu in a window rather than a scanned page. A
  // pixel-count tolerance tuned for 300 dpi would merge every one of these into one row.
  expect(
    assemble([
      { text: 'File', top: 10, left: 4, height: 12 },
      { text: 'Edit', top: 10, left: 40, height: 12 },
      { text: 'Open', top: 30, left: 8, height: 12 },
      { text: 'Ctrl+O', top: 30, left: 90, height: 12 },
    ]).split('\n'),
  ).toEqual(['File  Edit', 'Open  Ctrl+O'])
})
