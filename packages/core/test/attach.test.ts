// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import {
  discard,
  MOST_FILES,
  MOST_PER_FILE,
  noteFor,
  receive,
  safeName,
  withDocuments,
  type Upload,
} from '../src/attach.js'

// Core's half of an attachment: the bytes arrive, they land somewhere a reader can open
// them, they are gone afterwards, and what the model is shown is a string with the document
// underneath the sentence — because `Message.content` is a string and there is nowhere else
// to put it.

const root = mkdtempSync(join(tmpdir(), 'alexia-attach-'))
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))

const upload = (name: string, text: string): Upload => ({ name, data: Buffer.from(text, 'utf8').toString('base64') })

test('what arrives is written where a reader can open it, with its bytes intact', () => {
  const { kept, refused } = receive([upload('notes.txt', 'Příliš žluťoučký')], root)
  expect(refused).toEqual([])
  expect(kept).toHaveLength(1)
  expect(readFileSync(kept[0]!.path, 'utf8')).toBe('Příliš žluťoučký')
  // The extension survives, because the reader dispatches on it.
  expect(kept[0]!.path.endsWith('.txt')).toBe(true)
  expect(kept[0]!.name).toBe('notes.txt')
})

test('a name cannot walk out of the folder it is written to', () => {
  expect(safeName('../../etc/passwd')).toBe('passwd')
  expect(safeName('..\\..\\Windows\\System32\\config')).toBe('config')
  expect(safeName('re:port?.pdf')).toBe('report.pdf')
  expect(safeName('...')).toBe('attachment')
  // The dots and digits stay, which is the whole reason this is not a character range.
  expect(safeName('2026-08-31 invoice.v2.pdf')).toBe('2026-08-31 invoice.v2.pdf')

  const { kept } = receive([{ name: '../escape.txt', data: Buffer.from('x').toString('base64') }], root)
  expect(dirname(kept[0]!.path)).toBe(root)
})

test('two files with the same name are two files', () => {
  const { kept } = receive([upload('scan.pdf', 'one'), upload('scan.pdf', 'two')], root, 1)
  expect(new Set(kept.map((one) => one.path)).size).toBe(2)
  expect(kept.map((one) => readFileSync(one.path, 'utf8'))).toEqual(['one', 'two'])
})

test('one file too big does not take the rest of the message with it', () => {
  // The point of refusing with a sentence rather than throwing: four attachments and a fifth
  // that will not fit is four attachments, not a lost message.
  const huge = { name: 'film.mov', data: 'A'.repeat(Math.ceil((MOST_PER_FILE + 1024) / 3) * 4) }
  const { kept, refused } = receive([upload('a.txt', 'one'), huge, upload('b.txt', 'two')], root)
  expect(kept.map((one) => one.name)).toEqual(['a.txt', 'b.txt'])
  expect(refused).toHaveLength(1)
  expect(refused[0]).toMatch(/film.mov is \d+ MB/)
})

test('more files than a message may carry is said, not silently dropped', () => {
  const many = Array.from({ length: MOST_FILES + 3 }, (_one, n) => upload(`${String(n)}.txt`, 'x'))
  const { kept, refused } = receive(many, root)
  expect(kept).toHaveLength(MOST_FILES)
  expect(refused.at(-1)).toMatch(/Only the first 8 files/)
})

test('an attachment is gone once it has been read', () => {
  // It exists for the length of one capability call, because that call takes a path. It does
  // not exist afterwards: a folder of everybody's payslips beside the database is a second
  // place their documents live, for no benefit.
  const { kept } = receive([upload('payslip.pdf', 'private')], root)
  expect(existsSync(kept[0]!.path)).toBe(true)
  discard(kept)
  expect(existsSync(kept[0]!.path)).toBe(false)
  // And deleting what is already gone is not an error, because a failed delete must never
  // be a failed message.
  expect(() => discard(kept)).not.toThrow()
})

test('the message a model sees is the sentence with the document under it', () => {
  const said = withDocuments('what does this say about the deposit?', [
    { name: 'lease.pdf', text: '# Lease\n\nThe deposit is 37000.', about: '31 characters' },
  ])
  expect(said).toBe(
    'what does this say about the deposit?\n\n' +
      '[attached: lease.pdf — 31 characters]\n# Lease\n\nThe deposit is 37000.\n[end of lease.pdf]',
  )
})

test('a file nothing could read still appears, saying so in the reader’s own words', () => {
  // Silence here is the failure this whole path is designed against: a model answering about
  // a document that never reached it, with nothing anywhere to say that is what happened.
  const said = withDocuments('is this the right one?', [
    { name: 'scan.pdf', refusal: 'that PDF has no text layer — it is a picture of a document.' },
  ])
  expect(said).toContain('[attached: scan.pdf — not read.')
  expect(said).toContain('no text layer')
  expect(noteFor({ name: 'scan.pdf', refusal: 'that PDF has no text layer.' })).toBe(
    'scan.pdf was not read. that PDF has no text layer.',
  )
})

test('a file with nothing typed beside it is still a whole message', () => {
  expect(withDocuments('', [{ name: 'a.txt', text: 'hello', about: '5 characters' }])).toBe(
    '[attached: a.txt — 5 characters]\nhello\n[end of a.txt]',
  )
})

test('the folder is made when it is not there yet', () => {
  const fresh = join(root, 'not', 'yet')
  const { kept } = receive([upload('a.txt', 'x')], fresh)
  expect(basename(dirname(kept[0]!.path))).toBe('yet')
})
