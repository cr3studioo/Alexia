// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

/**
 * `docs/design.md` says both themes are real and both are measured. This is the measurement.
 *
 * It reads the declarations out of `app.css` rather than keeping a second copy of them,
 * because a palette that has to agree with a test in two places is a palette that will
 * disagree with it in one.
 */

const css = readFileSync(join(import.meta.dirname, '..', 'app.css'), 'utf8')

/** The `--token: value` pairs inside the first block whose selector matches. */
function palette(selector: RegExp): Record<string, string> {
  const at = css.search(selector)
  expect(at, `no block matching ${String(selector)} in app.css`).toBeGreaterThan(-1)
  const body = css.slice(at, css.indexOf('}', at))
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/g)].map(([, name, value]) => [name!, value!]),
  )
}

const light = palette(/:root \{\s*\n\s*color-scheme/)
const dark = palette(/:root\[data-theme='dark'\] \{/)
const darkByPreference = palette(/:root:not\(\[data-theme='light'\]\) \{/)

const channel = (hex: string, at: number): number => parseInt(hex.slice(at, at + 2), 16) / 255

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map((at) => channel(hex, at))
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high! + 0.05) / (low! + 0.05)
}

/** Text at 4.5:1 — WCAG AA for anything below 18.66px, which is everything here. */
const TEXT: [string, string[]][] = [
  ['ink', ['surface', 'surface-raised', 'surface-sunken']],
  ['ink-quiet', ['surface', 'surface-raised', 'surface-sunken']],
  ['ink-faint', ['surface', 'surface-raised', 'surface-sunken']],
  ['caution', ['surface', 'surface-raised']],
  ['danger', ['surface', 'surface-raised']],
  ['on-accent', ['accent']],
  // The chosen row: its ink against the page, and against the wash it sits on.
  ['chosen', ['surface', 'surface-raised', 'chosen-wash']],
]

/**
 * Borders, rings and the selected state at 3:1 — WCAG 1.4.11, non-text contrast.
 *
 * `focus` is checked against the surfaces and not against `accent`, because `outline-offset`
 * is the same width as the ring: it lands on the page beside the control, never on it.
 */
const OBJECT: [string, string[]][] = [
  ['line-strong', ['surface', 'surface-raised']],
  ['focus', ['surface', 'surface-raised']],
  // `surface-raised` joined the list when an engine card started marking *the chosen one* with
  // an accent border: a card's own ground is what that border has to be seen against, and it
  // is the one surface the accent had never been measured on.
  ['accent', ['surface', 'surface-sunken', 'surface-raised']],
]

test.each([
  ['light', light],
  ['dark', dark],
])('contrast: %s carries text at 4.5:1', (name, theme) => {
  for (const [ink, grounds] of TEXT) {
    for (const ground of grounds) {
      const seen = contrast(theme[ink]!, theme[ground]!)
      expect(seen, `${name}: --${ink} on --${ground} is ${seen.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
    }
  }
})

test.each([
  ['light', light],
  ['dark', dark],
])('contrast: %s shows its borders and rings at 3:1', (name, theme) => {
  for (const [mark, grounds] of OBJECT) {
    for (const ground of grounds) {
      const seen = contrast(theme[mark]!, theme[ground]!)
      expect(seen, `${name}: --${mark} on --${ground} is ${seen.toFixed(2)}:1`).toBeGreaterThanOrEqual(3)
    }
  }
})

test('contrast: the two themes define the same roles', () => {
  // A token that exists in one theme and not the other is a colour that falls back to the
  // other theme's value — which is exactly the bug that makes a light theme look like an
  // inversion with one thing wrong in it.
  expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort())
})

test('contrast: the two ways of asking for dark agree', () => {
  // Dark is written twice — once for `prefers-color-scheme`, once for the `[data-theme]`
  // override that exists so a toggle could be added later. Two copies drift; this is the only
  // thing stopping them.
  expect(darkByPreference).toEqual(dark)
})

test('contrast: the check is reading real declarations', () => {
  // The failure mode of every check like this one: a regex that matches nothing passes
  // silently and looks exactly like a clean palette.
  expect(Object.keys(light).length).toBeGreaterThanOrEqual(13)
  expect(light['surface']).toMatch(/^#[0-9a-f]{6}$/)
})
