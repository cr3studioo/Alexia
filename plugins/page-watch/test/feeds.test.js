// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { fold, matchInterests, newItems, parseFeed, topics } from '../feeds.js'

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>School news</title>
<item><title>Nový rozvrh na jaro</title><link>https://s.test/rozvrh</link><guid>g-1</guid>
<description><![CDATA[<p>Rozvrh pro <b>jarní</b> semestr je venku.</p>]]></description><pubDate>Mon, 23 Nov 2026 08:00:00 GMT</pubDate></item>
<item><title>Canteen menu</title><link>https://s.test/menu</link><guid>g-2</guid><description>Soup &amp; bread</description></item>
</channel></rss>`

const ATOM = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title>
<entry><title>Release notes</title><link rel="self" href="https://b.test/self"/><link rel="alternate" href="https://b.test/notes"/>
<id>tag:b.test,2026:1</id><updated>2026-11-24T10:00:00Z</updated><summary type="html">&lt;p&gt;What is new&lt;/p&gt;</summary></entry>
<entry><title>Exam results</title><link href="https://b.test/results"/><id>tag:b.test,2026:2</id><published>2026-11-20T10:00:00Z</published></entry>
</feed>`

test('rss_and_atom', () => {
  const rss = parseFeed(RSS)
  expect(rss).toHaveLength(2)
  expect(rss[0]).toMatchObject({ id: 'g-1', title: 'Nový rozvrh na jaro', link: 'https://s.test/rozvrh', summary: 'Rozvrh pro jarní semestr je venku.', published: Date.parse('2026-11-23T08:00:00Z') })
  expect(rss[1].summary).toBe('Soup & bread')
  const atom = parseFeed(ATOM)
  expect(atom).toHaveLength(2)
  expect(atom[0]).toMatchObject({ id: 'tag:b.test,2026:1', title: 'Release notes', link: 'https://b.test/notes', summary: 'What is new' })
  expect(atom[1]).toMatchObject({ id: 'tag:b.test,2026:2', link: 'https://b.test/results', published: Date.parse('2026-11-20T10:00:00Z') })
  expect(parseFeed('not a feed')).toEqual([])
})

test('new_items_only', () => {
  const items = parseFeed(RSS)
  expect(newItems(items, []).map((i) => i.id)).toEqual(['g-1', 'g-2'])
  expect(newItems(items, ['g-1']).map((i) => i.id)).toEqual(['g-2'])
  expect(newItems(items, new Set(['g-1', 'g-2']))).toEqual([])
})

test('interest_filter_folds_diacritics', () => {
  const items = parseFeed(RSS)
  expect(fold('Škola ČESKÝ')).toBe('skola cesky')
  // Typed without accents against a title with them, and the other way round.
  expect(matchInterests(items, topics('rozvrh')).map((i) => i.id)).toEqual(['g-1'])
  expect(matchInterests(items, topics('JARNI SEMESTR')).map((i) => i.id)).toEqual(['g-1'])
  expect(matchInterests(items, topics('Nový')).map((i) => i.id)).toEqual(['g-1'])
  expect(matchInterests(items, topics('canteen\nrozvrh')).map((i) => i.id)).toEqual(['g-1', 'g-2'])
  // Every word of a topic has to be there.
  expect(matchInterests(items, topics('canteen exam'))).toEqual([])
  // No topics, no filter.
  expect(matchInterests(items, topics('\n  \n'))).toHaveLength(2)
})
