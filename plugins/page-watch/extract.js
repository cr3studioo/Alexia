// SPDX-License-Identifier: AGPL-3.0-only

/**
 * HTML to the page's main text, written by hand because the plugin may not add a dependency.
 * It is forgiving rather than strict: a page that is broken still gives its words.
 */

export const MAX_TEXT = 20_000

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©' }

/** Decode the entities a page uses; an unknown one stays as written. */
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      try {
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole
      } catch {
        return whole
      }
    }
    return NAMED[body.toLowerCase()] ?? whole
  })
}

// Elements whose content is never the page's text.
const DROPPED = ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas', 'nav', 'footer', 'aside', 'form', 'select', 'button']
const BLOCKS = 'p|div|section|article|main|header|li|ul|ol|tr|table|thead|tbody|h[1-6]|br|hr|blockquote|pre|dl|dt|dd|figure|figcaption|address|details|summary'

/** Remove `<tag ...>...</tag>` for each name; an unclosed one removes to the end. */
function dropElements(html, names) {
  let out = html
  for (const name of names) {
    const open = new RegExp(`<${name}(?=[\\s>/])`, 'i')
    const close = new RegExp(`</${name}\\s*>`, 'i')
    for (let guard = 0; guard < 10_000; guard++) {
      const start = open.exec(out)
      if (!start) break
      const rest = out.slice(start.index)
      const end = close.exec(rest)
      out = out.slice(0, start.index) + ' ' + (end ? rest.slice(end.index + end[0].length) : '')
    }
  }
  return out
}

/** The text between `<tag>` and `</tag>`, or undefined. */
function inner(html, tag) {
  const m = new RegExp(`<${tag}(?=[\\s>])[^>]*>([\\s\\S]*?)</${tag}\\s*>`, 'i').exec(html)
  return m ? m[1] : undefined
}

/** Whitespace folded: spaces collapse, every line is trimmed, blank runs become nothing. */
export function foldSpace(text) {
  return text
    .replace(/[\p{Zs}\u200b\t\f\v\r]+/gu, ' ')
    .split('\n')
    .map((l) => l.replace(/ {2,}/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

/** The page's title, or an empty string. */
export function pageTitle(html) {
  const t = inner(html, 'title')
  return t === undefined ? '' : foldSpace(decodeEntities(t.replace(/<[^>]*>/g, ''))).replace(/\n/g, ' ')
}

/**
 * The main text of an HTML page: scripts, styles, navigation and footers removed, whitespace
 * folded, at most `MAX_TEXT` characters. A `<main>` or `<article>` is used alone when the page
 * has one.
 */
export function htmlToText(html, max = MAX_TEXT) {
  let h = String(html ?? '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ')
  const body = inner(h, 'body')
  if (body !== undefined) h = body
  // The scripts and styles go first, so a `<nav>` written inside one cannot confuse the rest.
  h = dropElements(h, ['script', 'style', 'noscript', 'template'])
  const main = inner(h, 'main') ?? inner(h, 'article')
  if (main !== undefined && main.replace(/<[^>]*>/g, '').trim().length > 0) h = main
  h = dropElements(h, DROPPED)
  h = h.replace(new RegExp(`</?(?:${BLOCKS})(?=[\\s>/])[^>]*>`, 'gi'), '\n').replace(/<[^>]*>/g, ' ')
  const text = foldSpace(decodeEntities(h))
  return text.length > max ? text.slice(0, max) : text
}
