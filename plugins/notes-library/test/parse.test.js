// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { clampSummary, linksOf, parseNote, parsePlain, splitFrontmatter, tagsOf } from '../parse.js'

test('front matter: title, tags as a list and as dashed lines, and the body after it', () => {
  const text = '---\ntitle: "Trip plan"\ntags: [travel, "#Japan"]\n---\nBody here.'
  const { meta, body } = splitFrontmatter(text)
  expect(meta.title).toBe('Trip plan')
  expect(meta.tags).toEqual(['travel', '#Japan'])
  expect(body).toBe('Body here.')
  const dashed = splitFrontmatter('---\ntags:\n  - a\n  - b/c\n---\nx')
  expect(dashed.meta.tags).toEqual(['a', 'b/c'])
})

test('wikilinks: alias, heading, block and embeds all name the note, once', () => {
  const links = linksOf('See [[Alpha]], [[Beta|the b]], [[Gamma#Part]], ![[Delta]] and [[alpha]] again. [[Eps^blk]]')
  expect(links).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta', 'alpha', 'Eps'])
  expect(parseNote('[[Alpha]] [[alpha]]').links).toEqual(['Alpha'])
})

test('tags: nested, from header and body, not headings, numbers, urls or code', () => {
  const text = '# Heading\nA #idea and #project/alpha, (#paren) and #1 and a.com/#frag\n`#inline`\n```\n#fenced\n```\n'
  expect(tagsOf(text)).toEqual(['idea', 'project/alpha', 'paren'])
  const note = parseNote('---\ntags: [Work]\n---\nText #work and #Home')
  expect(note.tags).toEqual(['work', 'home'])
})

test('title: front matter, then first heading, then the file name', () => {
  expect(parseNote('---\ntitle: A\n---\n# B', '/x/c.md').title).toBe('A')
  expect(parseNote('intro\n# B\nmore', '/x/c.md').title).toBe('B')
  expect(parseNote('no heading', '/x/some-note.md').title).toBe('some-note')
  expect(parsePlain('plain words', 'C:\\docs\\letter.txt').title).toBe('letter')
})

test('a plain text file has no tags or links, even if it has the characters', () => {
  const plain = parsePlain('ticket #4821 and [[not a link]]', '/x/a.txt')
  expect(plain.tags).toEqual([])
  expect(plain.links).toEqual([])
})

test('a summary is at most three sentences and 600 characters', () => {
  expect(clampSummary('One. Two! Three? Four. Five.')).toBe('One. Two! Three?')
  expect(clampSummary('x'.repeat(2000)).length).toBeLessThanOrEqual(600)
  expect(clampSummary('  spaced \n out  ')).toBe('spaced out')
})
