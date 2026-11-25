// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { htmlToText, pageTitle } from '../extract.js'

const PAGE = `<!doctype html><html><head><title>Rozvrh &amp; zkoušky</title>
<style>.x { color: red } nav { display: none }</style>
<script>var nav = "<nav>fake</nav>"; document.write('<p>from script</p>')</script></head>
<body>
<nav><ul><li><a href="/">Home</a></li><li><a href="/contact">Contact</a></li></ul></nav>
<header><h1>Timetable</h1></header>
<main>
  <p>Lecture   one is on
     Monday at&nbsp;9:00.</p>
  <p>Exam: 12&#46;1&#x2e;2027</p>
  <!-- a comment -->
  <noscript>Enable scripts</noscript>
</main>
<footer>Copyright 2026 School. All rights reserved.</footer>
</body></html>`

test('scripts_and_nav_removed', () => {
  const text = htmlToText(PAGE)
  expect(text).toContain('Lecture one is on')
  expect(text).toContain('Exam: 12.1.2027')
  for (const gone of ['from script', 'fake', 'color: red', 'Contact', 'Home', 'Copyright', 'Enable scripts', 'a comment']) {
    expect(text).not.toContain(gone)
  }
  expect(pageTitle(PAGE)).toBe('Rozvrh & zkoušky')
})

test('nav_and_footer_removed_without_a_main_element', () => {
  const text = htmlToText('<body><nav>Menu</nav><div>Real words</div><footer>Legal</footer></body>')
  expect(text).toBe('Real words')
})

test('whitespace_folded', () => {
  const text = htmlToText('<body><div>  a \t b  </div>\n\n\n<p>   </p><p>c  d</p><ul><li>e</li><li>f</li></ul></body>')
  expect(text).toBe('a b\nc d\ne\nf')
  expect(htmlToText('<p>Only this</p>')).toBe('Only this')
})

test('text_is_capped_at_twenty_thousand_characters', () => {
  const text = htmlToText(`<p>${'word '.repeat(10_000)}</p>`)
  expect(text.length).toBeLessThanOrEqual(20_000)
  expect(text.length).toBeGreaterThan(19_000)
})

test('an_unclosed_script_removes_only_what_follows_it', () => {
  expect(htmlToText('<p>before</p><script>broken')).toBe('before')
})
