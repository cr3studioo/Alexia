// SPDX-License-Identifier: AGPL-3.0-only
import { decodeEntities, foldSpace } from './extract.js'

/** RSS and Atom, read by hand. Pure: text in, items out. */

const unwrap = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
const plain = (s) => foldSpace(decodeEntities(unwrap(s)).replace(/<[^>]*>/g, ' ')).replace(/\n/g, ' ')

/** The first `<tag>` child's content (any namespace prefix), or ''. */
function child(block, tag) {
  const m = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}\\s*>`, 'i').exec(block)
  return m ? m[1] : ''
}

/** An Atom `<link href=...>`: the alternate one, or the first. */
function atomLink(block) {
  const links = [...block.matchAll(/<link\b([^>]*)>/gi)].map((m) => m[1])
  const pick = links.find((a) => !/rel\s*=\s*["'](?!alternate)/i.test(a)) ?? links[0]
  const href = pick && /href\s*=\s*["']([^"']*)["']/i.exec(pick)
  return href ? decodeEntities(href[1]) : ''
}

/** Items of an RSS or Atom document: `{ id, title, link, summary, published }`, in document order. */
export function parseFeed(xml) {
  const doc = String(xml ?? '')
  const out = []
  for (const [, kind, body] of doc.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>/gi)) {
    const atom = kind.toLowerCase() === 'entry'
    const title = plain(child(body, 'title'))
    const link = atom ? atomLink(body) : plain(child(body, 'link')) || atomLink(body)
    const summary = plain(child(body, 'description') || child(body, 'summary') || child(body, 'content') || child(body, 'encoded')).slice(0, 400)
    const id = plain(child(body, atom ? 'id' : 'guid')) || link || title
    const when = plain(child(body, 'pubDate') || child(body, 'published') || child(body, 'updated') || child(body, 'date'))
    const published = Number.isFinite(Date.parse(when)) ? Date.parse(when) : undefined
    if (!id) continue
    out.push({ id, title, link, summary, published })
  }
  return out
}

/** The items whose id is not in `seen` (an array or Set of ids). */
export function newItems(items, seen) {
  const known = seen instanceof Set ? seen : new Set(seen ?? [])
  return items.filter((i) => !known.has(i.id))
}

/** Lower case with the accents taken off, so "Škola" and "skola" meet. */
export function fold(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/** The topics, one per line, folded; blank lines dropped. */
export function topics(text) {
  return String(text ?? '')
    .split('\n')
    .map((l) => fold(l).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/**
 * The items that mention one of the topics. A topic matches when every word of it appears in
 * the title or summary (as a part of a word, so "rozvrh" finds "rozvrhu"). No topics, no filter.
 */
export function matchInterests(items, interests) {
  const list = Array.isArray(interests) ? interests : topics(interests)
  if (list.length === 0) return items
  return items.filter((item) => {
    const hay = fold(`${item.title} ${item.summary ?? ''}`)
    return list.some((topic) => topic.split(' ').every((w) => hay.includes(w)))
  })
}
