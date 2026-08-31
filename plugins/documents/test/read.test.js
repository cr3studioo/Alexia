// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { read } from '../read.js'
import { docx, docxParagraph, docxTable, epub, odt, pdf, pptx, xlsx, zip } from './making.js'

const bytes = (text) => Buffer.from(text, 'utf8')

/**
 * What `document.extract` promises: **a file in, markdown out** — and, for everything it
 * cannot read, a sentence rather than an empty string.
 *
 * The refusals get as much room here as the successes, because the failure this plugin exists
 * to prevent is the *silent* one (§4). An extractor that returns nothing for a screenshot has
 * not failed as far as any caller can tell; the model then answers about a document nobody
 * read. Every test below that checks a message is checking that the wall has a name on it.
 */

test('plain text comes back as it was written', () => {
  const found = read('notes.txt', bytes('One line.\n\nAnd another.'))
  expect(found.kind).toBe('text')
  expect(found.markdown).toBe('One line.\n\nAnd another.')
  expect(found.truncated).toBe(false)
})

test('a spreadsheet exported as csv becomes a markdown table, quotes and all', () => {
  const found = read(
    'rent.csv',
    bytes('Item,Amount,Note\nRent,18500,"Due on the 1st, always"\nDeposit,37000,'),
  )
  expect(found.kind).toBe('csv')
  expect(found.markdown.split('\n')).toEqual([
    '| Item | Amount | Note |',
    '| --- | --- | --- |',
    '| Rent | 18500 | Due on the 1st, always |',
    '| Deposit | 37000 |  |',
  ])
})

test('a semicolon export is read as columns rather than as one column of nonsense', () => {
  // The European spreadsheet, whose decimal point is the comma. Guessing wrong here gives a
  // one-column table with every row intact and no columns in it — which looks like it worked.
  const found = read('cena.csv', bytes('Polozka;Cena\nNajem;18 500\n'))
  expect(found.markdown).toContain('| Polozka | Cena |')
})

test('a saved web page keeps its headings and loses its script', () => {
  const found = read(
    'page.html',
    bytes(
      '<html><head><style>body{color:red}</style><script>alert(1)</script></head>' +
        '<body><h1>Rent agreement</h1><p>Signed on 31 August &amp; witnessed.</p>' +
        '<ul><li>First</li><li>Second</li></ul></body></html>',
    ),
  )
  expect(found.markdown).toContain('# Rent agreement')
  expect(found.markdown).toContain('Signed on 31 August & witnessed.')
  expect(found.markdown).toContain('- First')
  expect(found.markdown).not.toContain('alert')
  expect(found.markdown).not.toContain('color:red')
})

test('source code arrives fenced, so a model can see that it is code', () => {
  const found = read('server.py', bytes('def main():\n    return 1\n'))
  expect(found.kind).toBe('code')
  expect(found.markdown.startsWith('```')).toBe(true)
  expect(found.markdown).toContain('def main():')
})

test('a Word document keeps its headings, its list and its table, in order', () => {
  const file = docx(
    docxParagraph('Rent agreement', 'Title') +
      docxParagraph('Payment', 'Heading1') +
      docxParagraph('The rent is 18 500 CZK.') +
      docxTable([
        ['Item', 'Amount'],
        ['Rent', '18500'],
      ]) +
      docxParagraph('Signed by both parties.'),
  )
  const found = read('agreement.docx', file)
  expect(found.kind).toBe('docx')
  expect(found.markdown.split('\n\n')).toEqual([
    '# Rent agreement',
    '# Payment',
    'The rent is 18 500 CZK.',
    '| Item | Amount |\n| --- | --- |\n| Rent | 18500 |',
    'Signed by both parties.',
  ])
})

test('a cell’s text is not also loose in the document', () => {
  // Every paragraph in a table is a `<w:p>` too. Reading both lists and merging them puts
  // every cell in twice — once in the table and once as a stray line under it.
  const found = read('table.docx', docx(docxTable([['Only', 'Once']])))
  expect(found.markdown.match(/Only/g)).toHaveLength(1)
})

test('a spreadsheet comes back one table per sheet, with the sheet named', () => {
  const found = read('costs.xlsx', xlsx([['Item', 'Amount'], ['Rent', 18500], ['', ''], ['Deposit', 37000]]))
  expect(found.kind).toBe('xlsx')
  expect(found.markdown).toContain('## Costs')
  expect(found.markdown).toContain('| Rent | 18500 |')
  // The empty row is not a row of the table; it is somebody's spacing.
  expect(found.markdown).not.toContain('|  |  |')
})

test('a deck comes back slide by slide, numbered', () => {
  const found = read('deck.pptx', pptx([['Title slide', 'A subtitle'], ['Second slide']]))
  expect(found.markdown).toContain('## Slide 1')
  expect(found.markdown).toContain('A subtitle')
  expect(found.markdown).toContain('## Slide 2')
})

test('an OpenDocument file keeps its outline levels', () => {
  const found = read(
    'notes.odt',
    odt(
      '<text:h text:outline-level="1">Rent agreement</text:h>' +
        '<text:p>Signed on the 31st.</text:p>' +
        '<text:h text:outline-level="2">Payment</text:h>',
    ),
  )
  expect(found.kind).toBe('odt')
  expect(found.markdown.split('\n\n')).toEqual(['# Rent agreement', 'Signed on the 31st.', '## Payment'])
})

test('a book is read in the order its spine says, not the order the archive holds', () => {
  const found = read('book.epub', epub(['Chapter one', 'Chapter two']))
  expect(found.kind).toBe('epub')
  // The fixture's spine is deliberately back to front.
  expect(found.markdown.indexOf('Chapter two')).toBeLessThan(found.markdown.indexOf('Chapter one'))
})

test('a PDF with a text layer comes back as its text', () => {
  const found = read(
    'invoice.pdf',
    pdf([
      { text: 'Invoice 2026-001', x: 72, y: 700, size: 24 },
      { text: 'Total due: 1234 CZK', x: 72, y: 660 },
    ]),
  )
  expect(found.kind).toBe('pdf')
  expect(found.pages).toBe(1)
  expect(found.markdown).toBe('Invoice 2026-001\nTotal due: 1234 CZK')
})

test('a PDF that is a photograph of a document says so, and says what would read it', () => {
  // The failure this whole plugin is written around. A scan has pages and no words; returning
  // an empty string would be reported as broken, and returning the watermark would be worse.
  const scanned = pdf([{ text: ' ', x: 0, y: 0 }])
  expect(() => read('scan.pdf', scanned)).toThrow(/no text layer/)
  expect(() => read('scan.pdf', scanned)).toThrow(/needs OCR/)
})

test('a picture is refused before it is opened, and the sentence names both jobs', () => {
  const png = Buffer.concat([Buffer.from([0x89]), bytes('PNG\r\n\n'), Buffer.alloc(64)])
  expect(() => read('screenshot.png', png)).toThrow(/not a document/)
  expect(() => read('screenshot.png', png)).toThrow(/OCR/)
  expect(() => read('screenshot.png', png)).toThrow(/model that/)
  // And by name as well as by magic number, because a `.jpg` with no bytes yet is still a jpg.
  expect(() => read('holiday.jpeg', bytes('not really a jpeg but named one'))).toThrow(/picture/)
})

test('the old Office formats are refused with the fix in the sentence', () => {
  expect(() => read('report.doc', bytes('anything'))).toThrow(/old Word document/)
  expect(() => read('report.doc', bytes('anything'))).toThrow(/ending in x/)
})

test('an archive is refused as an archive rather than read as one file', () => {
  expect(() => read('bundle.zip', zip({ 'a.txt': 'hello' }))).toThrow(/zip archive/)
})

test('a renamed document is read for what it is, not for what it is called', () => {
  // People rename things. The container says what it holds and costs one string search.
  const found = read('mystery.zip', docx(docxParagraph('Still a Word document.')))
  expect(found.kind).toBe('docx')
  expect(found.markdown).toBe('Still a Word document.')
})

test('a file of bytes is refused rather than decoded into replacement characters', () => {
  const noise = Buffer.from([0x01, 0x00, 0x02, 0x00, 0xff, 0xfd, 0x00, 0x03])
  expect(() => read('thing.dat', noise)).toThrow(/no text encoding has/)
})

test('an empty file says it is empty', () => {
  expect(() => read('nothing.txt', Buffer.alloc(0))).toThrow(/is empty/)
})

test('a document longer than the limit is cut, and the text says where', () => {
  const long = 'a line of text\n'.repeat(4000)
  const found = read('book.txt', bytes(long), { limit: 2000 })
  expect(found.truncated).toBe(true)
  expect(found.characters).toBe(long.trim().length)
  // Said in the extraction itself, not only in a field. A reader who cannot see that it was
  // cut is being told the document is shorter than it is.
  expect(found.markdown).toMatch(/cut here/)
  expect(found.markdown.length).toBeLessThan(2400)
})

test('a UTF-16 file with a byte-order mark is read as writing, not as bytes', () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Příliš žluťoučký', 'utf16le')])
  expect(read('note.txt', utf16).markdown).toBe('Příliš žluťoučký')
})

test('a Windows-1252 file falls back rather than coming back full of question marks', () => {
  // Node's UTF-8 decoder never throws — it substitutes — so a mis-decoded file looks *nearly*
  // right, which is the one outcome worse than an error.
  const latin = Buffer.from('Grüße aus München, Straße 5', 'latin1')
  expect(read('brief.txt', latin).markdown).toBe('Grüße aus München, Straße 5')
})
