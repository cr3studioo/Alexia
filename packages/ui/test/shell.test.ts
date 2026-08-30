// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

/**
 * The shell reaches into `index.html` by id, and every one of those reads ends in `!`.
 *
 * That is the right call in a page whose markup ships in the same commit as the code — but it
 * means a renamed id is not a wrong colour or a missing row, it is `null.addEventListener`
 * thrown while the module is still loading, and a blank window. There is no browser in this
 * suite to catch that, and by the time a person sees it the only symptom is that Alexia does
 * not start.
 *
 * So: every id the shell asserts must exist in the markup, and every id in the markup should
 * be one somebody uses. Two directions, because the second is how dead markup accumulates.
 */

const ui = join(import.meta.dirname, '..')
const html = readFileSync(join(ui, 'index.html'), 'utf8')
const source = readdirSync(join(ui, 'src'))
  .filter((file) => file.endsWith('.ts'))
  .map((file) => ({ file, text: readFileSync(join(ui, 'src', file), 'utf8') }))

const ids = new Set([...html.matchAll(/\sid="([\w-]+)"/g)].map(([, id]) => id!))

/** `document.querySelector<T>('#thing')!` — the reads that cannot come back empty. */
const asserted = source.flatMap(({ file, text }) =>
  [...text.matchAll(/querySelector(?:<[^>]*>)?\('#([\w-]+)'\)!/g)].map(([, id]) => ({ file, id: id! })),
)

test('shell: every id the code asserts is in the markup', () => {
  expect(asserted.length).toBeGreaterThan(20)
  const missing = asserted.filter(({ id }) => !ids.has(id))
  expect(missing.map(({ file, id }) => `${file} reaches for #${id}, which index.html does not have`)).toEqual([])
})

test('shell: every id in the markup is reached for', () => {
  // An id earns its place three ways: the shell reads it, the sheet styles it, or an
  // attribute points at it. Anything else is markup nobody is drawing into — which is how a
  // screen ends up with two elements for one job and the wrong one being updated.
  const used = new Set(asserted.map(({ id }) => id))
  for (const { text } of source) {
    for (const [, id] of text.matchAll(/['"`]#([\w-]+)['"`]/g)) used.add(id!)
    for (const [, id] of text.matchAll(/getElementById\('([\w-]+)'\)/g)) used.add(id!)
  }
  const css = readFileSync(join(ui, 'app.css'), 'utf8')
  for (const [, id] of css.matchAll(/#([\w-]+)\b/g)) used.add(id!)
  for (const [, id] of html.matchAll(/(?:for|aria-controls|aria-labelledby)="([\w-]+)"/g)) used.add(id!)
  expect([...ids].filter((id) => !used.has(id)).sort()).toEqual([])
})

test('shell: the three painting assets are the ones the server serves', () => {
  // A mask that 404s is not a broken image with a border round it — it is an element painted
  // in the accent colour with no mask at all, which is a solid champagne rectangle over the
  // conversation. Silent, and very visible.
  const css = readFileSync(join(ui, 'app.css'), 'utf8')
  const masked = new Set([...css.matchAll(/mask:\s*url\('\/([\w.-]+)'\)/g)].map(([, file]) => file!))
  expect([...masked].sort()).toEqual(['alexia-band.svg', 'alexia-mark.svg', 'alexia-panel.svg'])

  const serve = readFileSync(join(ui, '..', 'core', 'src', 'serve.ts'), 'utf8')
  for (const file of masked) {
    expect(serve, `serve.ts does not serve /${file}, so the mask would resolve to nothing`).toContain(`'/${file}'`)
  }

  const packager = readFileSync(join(ui, '..', '..', 'scripts', 'package.mjs'), 'utf8')
  for (const file of masked) {
    expect(packager, `package.mjs does not copy ${file} into the packaged shell`).toContain(`'${file}'`)
  }
})
