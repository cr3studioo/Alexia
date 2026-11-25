// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { WORDS_PER_MINUTE, chunkTranscript, fileStem, freeName, renderNote } from '../notes.js'
import { writeNew } from '../tools.js'

const dir = mkdtempSync(join(tmpdir(), 'study-notes-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('markdown_sections', () => {
  const md = renderNote({
    title: 'Cell biology',
    date: '2026-12-01',
    course: 'Biology',
    summary: '## Key points\n- cells divide\n\n## Terms\n- mitosis: division\n\n## Open questions\n- why?',
    transcript: 'hello there',
  })
  const order = ['# Cell biology', '- Date: 2026-12-01', '- Course: Biology', '## Key points', '## Terms', '## Open questions', '<details>', 'hello there', '</details>']
  let at = -1
  for (const part of order) {
    const next = md.indexOf(part, at + 1)
    expect(next, part).toBeGreaterThan(at)
    at = next
  }
  expect(md).toContain('- cells divide')
  // A reply with no headings still lands under Key points, and empty sections say so.
  const loose = renderNote({ title: 'T', date: 'd', summary: 'just text', transcript: 'x' })
  expect(loose).toMatch(/## Key points\n\njust text/)
  expect(loose).toMatch(/## Terms\n\n_Nothing\._/)
})

test('never_overwrites', async () => {
  writeFileSync(join(dir, 'Lecture.md'), 'mine')
  const a = await writeNew(dir, 'Lecture', 'one')
  const b = await writeNew(dir, 'Lecture', 'two')
  expect([a, b]).toEqual([join(dir, 'Lecture (2).md'), join(dir, 'Lecture (3).md')])
  expect(readFileSync(join(dir, 'Lecture.md'), 'utf8')).toBe('mine')
  expect(readFileSync(a, 'utf8')).toBe('one')
  expect(freeName('X', (n) => n === 'X.md')).toBe('X (2).md')
  expect(fileStem('a/b:c*?')).toBe('a b c')
  expect(fileStem('..')).toBe('Notes')
  expect(fileStem('x\\y\u0001z')).toBe('x y z')
})

test('long_transcript_chunked', () => {
  const words = WORDS_PER_MINUTE * 20
  const text = Array.from({ length: words * 2 + 5 }, (_, i) => `w${i}`).join(' ')
  const chunks = chunkTranscript(text)
  expect(chunks.length).toBe(3)
  expect(chunks[0].split(' ').length).toBe(words)
  expect(chunks.join(' ')).toBe(text)
  expect(chunkTranscript('short talk')).toEqual(['short talk'])
  expect(chunkTranscript('  ')).toEqual([])
})
