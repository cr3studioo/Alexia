// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

/**
 * The stylesheet against the code, where the two have to agree and nothing would say so.
 *
 * `contrast.test.ts` measures the palette and `theme.test.ts` holds the theme control's five
 * copies together. This is the third kind of silent failure in the same file: a rule that
 * *parses*, applies, and does nothing — a token nobody defines, or a breakpoint one point away
 * from the one the code uses. Neither is an error anywhere. Both are a control that looks
 * slightly wrong on one screen width, or a background that never arrives.
 */

const ui = join(import.meta.dirname, '..')
const css = readFileSync(join(ui, 'app.css'), 'utf8')
const html = readFileSync(join(ui, 'index.html'), 'utf8')
const widgets = readFileSync(join(ui, 'src', 'widgets.ts'), 'utf8')
const shell = ['theme.ts', 'live.ts', 'main.ts', 'widgets.ts', 'settings.ts', 'control.ts', 'rail.ts']
  .map((file) => readFileSync(join(ui, 'src', file), 'utf8'))
  .join('\n')

const declared = new Set([...css.matchAll(/^\s*(--[\w-]+):/gm)].map(([, one]) => one!))
const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map(([, one]) => one!))

test('stylesheet: every colour a rule asks for is one the palette defines', () => {
  // A misspelled token is the quietest bug CSS has. It is valid, it applies, and the property
  // falls back to its initial value — so an invisible border, or text the colour of whatever
  // was underneath. It is not a parse error and it is not in the console.
  //
  // The exception is a token set from script at runtime: the theme's blur, the ladder's stops,
  // a progress fill. Those are legitimately absent from the sheet — but *only* if something
  // actually sets them, which is the half that caught `--surface-sunk`. It was a typo for
  // `--surface-sunken` with a grey fallback beside it, so the command palette's selected row
  // had been flat grey rather than the theme's own sunken surface since the day it shipped.
  const fromScript = new Set([...shell.matchAll(/setProperty\('(--[\w-]+)'/g)].map(([, one]) => one!))
  for (const [, one] of html.matchAll(/setProperty\('(--[\w-]+)'/g)) fromScript.add(one!)

  const orphans = [...used].filter((one) => !declared.has(one) && !fromScript.has(one)).sort()
  expect(orphans, 'tokens nothing defines and nothing sets — these render as their fallback, forever').toEqual([])
})

/**
 * The narrow breakpoint, which is a number in two languages.
 *
 * `widgets.ts` drops `hideNarrow` columns below `NARROW`, in JavaScript, by asking
 * `window.innerWidth`. The stylesheet rearranges the same rows at the same width, in CSS, by
 * asking `max-width`. They are the same decision and there is nothing making them the same
 * number — so the failure is a band one pixel wide where the table has dropped its columns and
 * the buttons have not moved, which nobody will ever see and everybody would have to debug.
 *
 * `< 560` in JavaScript is `max-width: 559px` in CSS. One of these blocks said `560px` under a
 * comment reading *"Same breakpoint the tables use"*, which it was not.
 */
test('stylesheet: the narrow breakpoint is the same number the code uses', () => {
  const narrow = Number(/NARROW = (\d+)/.exec(widgets)?.[1])
  expect(narrow).toBeGreaterThan(0)

  const widths = [...css.matchAll(/@media \(max-width: (\d+)px\)/g)].map(([, one]) => Number(one))
  expect(widths.length, 'no width-based media queries found — this check is reading nothing').toBeGreaterThan(0)
  // `<` on one side and `<=` on the other, so the CSS number is one below the JS one.
  expect([...new Set(widths)]).toEqual([narrow - 1])
})

/**
 * Nothing new on a row may make the page scroll sideways.
 *
 * The audio player is the first thing ever put inside a table cell that has an intrinsic width
 * of its own — the browser's default is around 300px, which is wider than a narrow screen. A
 * `max-width` is the whole of what stands between that and a table nobody can reach the
 * buttons on, so it is checked rather than assumed.
 */
test('stylesheet: the row player cannot outgrow the row it is on', () => {
  const rule = /\.row-audio \{([^}]*)\}/.exec(css)?.[1] ?? ''
  expect(rule, 'no .row-audio rule in app.css').not.toBe('')
  expect(rule).toContain('max-width: 100%')
})
