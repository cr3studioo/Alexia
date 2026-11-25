// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a Markdown note says about itself: its title, its `#tags` and its `[[wikilinks]]`.
 *
 * Pure — text in, plain object out — so it is tested with strings and never touches a disk. It
 * understands what Obsidian writes (YAML front matter, `[[Note|alias]]`, `[[Note#Heading]]`,
 * `![[embed]]`, nested `#a/b` tags) and what any folder of Markdown has (`# Title`, `#tag`).
 */

/** Strips one pair of matching quotes. */
const unquote = (value) => value.trim().replace(/^(["'])(.*)\1$/, '$2')

/** A front-matter value that is a list: `[a, b]`, `a, b`, or the dashed lines under the key. */
function listOf(raw, following) {
  const inline = raw.trim()
  if (inline !== '') {
    const inner = inline.startsWith('[') && inline.endsWith(']') ? inline.slice(1, -1) : inline
    return inner
      .split(',')
      .map(unquote)
      .filter((one) => one !== '')
  }
  return following.map(unquote).filter((one) => one !== '')
}

/** The simple subset of YAML a note's header uses: `key: value`, and `- item` lines under a key. */
function parseMeta(block) {
  const meta = {}
  const lines = block.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const found = /^([A-Za-z][\w -]*?)\s*:\s*(.*)$/.exec(lines[i])
    if (!found) continue
    const key = found[1].trim().toLowerCase()
    const dashed = []
    while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
      i += 1
      dashed.push(lines[i].replace(/^\s*-\s+/, ''))
    }
    meta[key] = key === 'tags' || key === 'tag' ? listOf(found[2], dashed) : unquote(found[2])
  }
  return meta
}

/** The front matter (if the text starts with some) and the body after it. */
export function splitFrontmatter(text) {
  const found = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text)
  if (!found) return { meta: {}, body: text.replace(/^\uFEFF/, '') }
  return { meta: parseMeta(found[1]), body: text.slice(found[0].length) }
}

/** The text with code (fenced blocks and `inline`) taken out: a `#define` in code is not a tag. */
export function withoutCode(text) {
  return text.replace(/(^|\n)[ \t]*(```|~~~)[\s\S]*?(\n[ \t]*\2[^\n]*|$)/g, '$1').replace(/`[^`\n]*`/g, ' ')
}

const normaliseTag = (tag) =>
  tag
    .replace(/^#/, '')
    .replace(/[/_-]+$/, '')
    .toLowerCase()

/** `#tags` in the body: after a space or a bracket, with a letter in them (so `#1` is not one). */
export function tagsOf(text) {
  const found = []
  for (const match of withoutCode(text).matchAll(/(?:^|[\s(])#([\p{L}\p{N}_/-]+)/gmu)) {
    const tag = normaliseTag(match[1])
    if (/\p{L}/u.test(tag)) found.push(tag)
  }
  return found
}

/** The notes this one points at, as `[[Target]]` names: no alias, no `#Heading`, no `^block`. */
export function linksOf(text) {
  const found = []
  for (const match of withoutCode(text).matchAll(/!?\[\[([^[\]|#^\n]+)(?:[#^][^[\]|\n]*)?(?:\|[^[\]\n]*)?\]\]/g)) {
    const target = match[1].trim()
    if (target !== '') found.push(target)
  }
  return found
}

const unique = (list) => {
  const seen = new Set()
  return list.filter((one) => {
    const key = one.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** A file name without its folder or extension: the title of a note that never said one. */
export function nameOf(path) {
  const last = String(path).split(/[\\/]/).pop() ?? ''
  const dot = last.lastIndexOf('.')
  return dot > 0 ? last.slice(0, dot) : last
}

/**
 * One Markdown note, read.
 *
 * `{ title, body, tags, links }`. `body` is the text without its front matter. The title is the
 * front matter's `title`, else the first `# heading`, else the file name.
 */
export function parseNote(text, path = '') {
  const { meta, body } = splitFrontmatter(String(text ?? ''))
  const heading = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(withoutCode(body))
  const title = (typeof meta.title === 'string' && meta.title !== '' ? meta.title : (heading?.[1] ?? '')).trim()
  const fromHeader = Array.isArray(meta.tags) ? meta.tags.map(normaliseTag).filter((one) => one !== '') : []
  return {
    title: title !== '' ? title : nameOf(path),
    body,
    tags: unique([...fromHeader, ...tagsOf(body)]),
    links: unique(linksOf(body)),
  }
}

/** A plain-text file or an extracted document: no tags or links, a title from the first heading. */
export function parsePlain(text, path = '') {
  const body = String(text ?? '').replace(/^\uFEFF/, '')
  const heading = /^#{1,3}[ \t]+(.+?)[ \t]*$/m.exec(body)
  return { title: (heading?.[1] ?? '').trim() || nameOf(path), body, tags: [], links: [] }
}

/** Up to three sentences, and no more than 600 characters: what a summary is allowed to be. */
export function clampSummary(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  const sentences = flat.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? [flat]
  const three = sentences.slice(0, 3).join('').trim()
  return three.length > 600 ? `${three.slice(0, 599).trimEnd()}…` : three
}
