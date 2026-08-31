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

/**
 * The other half of the same failure, one layer down: a class the renderer writes and the
 * sheet has never heard of.
 *
 * Not a thrown error and not a blank window — it is a control that draws with no styling at
 * all, which on a page this quiet looks like a layout bug rather than a typo. The ladder
 * (D112) is the first widget with enough parts for that to be likely, and every widget
 * already passed this the day it was written, so it costs nothing to keep true.
 */
test('shell: every class the widgets write has a rule in the sheet', () => {
  const widgets = readFileSync(join(ui, 'src', 'widgets.ts'), 'utf8')
  const written = new Set<string>()
  for (const [, list] of widgets.matchAll(/el\('[a-z]+', '([a-zA-Z0-9 _-]+)'/g)) {
    for (const one of list!.split(' ')) written.add(one)
  }
  for (const [, list] of widgets.matchAll(/className = '([a-zA-Z0-9 _-]+)'/g)) {
    for (const one of list!.split(' ')) written.add(one)
  }
  for (const [, one] of widgets.matchAll(/classList\.(?:add|toggle)\('([a-zA-Z0-9_-]+)'\)/g)) written.add(one!)

  expect(written.size).toBeGreaterThan(20)
  const css = readFileSync(join(ui, 'app.css'), 'utf8')
  const styled = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(([, one]) => one!))
  expect([...written].filter((one) => !styled.has(one)).sort()).toEqual([])
})

/**
 * §12.2's last bullet, and it is the one the rest of the project rests on: **skip must be
 * loud.** Zero keys reaches a working conversation, so a first-run screen that presents
 * leaving without one as the lesser path is telling everybody who reads it the opposite of
 * what is true — quietly, and in the one place nobody goes back to.
 *
 * `11-answers-with-no-keys` walks that path end to end and proves an answer comes back. This
 * is the other half of the same claim: that the screen says so.
 */
test('shell: skipping is the loud button, not a quiet way out of the screen', () => {
  const main = source.find(({ file }) => file === 'main.ts')!.text

  // The words are worn by the primary button itself. A separate control would be a second
  // thing to style, and the second thing always ends up quieter.
  expect(main).toMatch(/begin\.textContent =[\s\S]{0,80}Skip — start with no keys/)
  expect(main).not.toContain("'#skip'")

  // And it is the primary button: `.begin` is the loud one, `.quiet-button` is the other one,
  // and this must never quietly become the other one.
  expect(html).toContain('<button id="begin" class="begin" type="button">')
  expect(html).not.toMatch(/id="begin"[^>]*quiet-button/)
})

test('shell: the key wall is every provider, and no fork between two of them', () => {
  const main = source.find(({ file }) => file === 'main.ts')!.text

  // §12.2: "OmniRoute and OpenRouter are tiles among many, not a fork." One loop over the
  // whole list is what makes that true; a named row anywhere here is the fork coming back.
  expect(main).toMatch(/for \(const provider of state\.providers\) wall\.append\(/)
  expect(main).not.toMatch(/'(?:openrouter|omniroute)'/)

  // Every face carries what a person is actually choosing between: the published free tier,
  // what getting in costs beyond an email, and what it costs in privacy where anyone checked.
  for (const shown of ['allowance(provider)', 'provider.friction', 'provider.account', "provider.trainsOnYourData === 'yes'"]) {
    expect(main, `the tile does not show ${shown}`).toContain(shown)
  }

  // The dropdown-and-one-key-box this replaced is gone, rather than left behind next to it.
  expect(html).not.toContain('id="provider"')
})
