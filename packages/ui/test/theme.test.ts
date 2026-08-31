// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

/**
 * The theme control, and the four places it is written down twice.
 *
 * A theme switch is small and it is spread across a stylesheet, a shell module, a page head,
 * a server and a packager — and every one of its failure modes is silent. A word that only
 * three of the five agree on is not an error anywhere: it is light on a dark desktop, or a
 * flash on every launch, or a card with no picture on it. `contrast.test.ts` already holds the
 * two spellings of the dark palette together for the same reason; this holds the rest.
 */

const ui = join(import.meta.dirname, '..')
const css = readFileSync(join(ui, 'app.css'), 'utf8')
const html = readFileSync(join(ui, 'index.html'), 'utf8')
const shell = readFileSync(join(ui, 'src', 'theme.ts'), 'utf8')
const serve = readFileSync(join(ui, '..', 'core', 'src', 'serve.ts'), 'utf8')

/** The `'a', 'b', 'c'` out of a `const THEMES` line, whichever file it is in. */
const listed = (source: string): string[] =>
  [...(/THEMES[^=]*=\s*\[([^\]]*)\]/.exec(source)?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map(([, one]) => one!)

test('theme: the shell and core agree on which three words there are', () => {
  // The shell cannot import core's copy — it has no dependencies and no Node in it (invariant
  // 6) — so the list exists twice. A word in one and not the other is a card that silently
  // does nothing when pressed, because core declines to store what the card sent.
  expect(listed(shell)).toEqual(['system', 'light', 'dark'])
  expect(listed(serve)).toEqual(listed(shell))
})

test('theme: the cards offer exactly those three', () => {
  const offered = [...html.matchAll(/name="theme" value="([a-z]+)"/g)].map(([, value]) => value!)
  expect(offered).toEqual(listed(shell))
})

test('theme: the head script and the module use the same storage key', () => {
  // The head script is what beats the network to the first paint, and it is plain inline
  // script rather than an import because nothing importable runs early enough. If it
  // reads a key the module does not write, the mirror is never read and every launch flashes.
  const key = /REMEMBERED = '([^']+)'/.exec(shell)?.[1]
  expect(key).toBeTruthy()
  const head = html.slice(0, html.indexOf('</head>'))
  expect(head).toContain(`localStorage.getItem('${key!}')`)
})

test('theme: the panel-glass mirror uses one key and one range end to end', () => {
  // Same failure as the theme key, one control over: the head script paints the frost before
  // the network answers, so a key it reads that the module never writes is a mirror that is
  // never read. And the clamp is written in three places — bound them here.
  const glassKey = /REMEMBERED_GLASS = '([^']+)'/.exec(shell)?.[1]
  expect(glassKey).toBeTruthy()
  const head = html.slice(0, html.indexOf('</head>'))
  expect(head).toContain(`localStorage.getItem('${glassKey!}')`)

  const min = Number(/GLASS_MIN = (\d+)/.exec(shell)?.[1])
  const max = Number(/GLASS_MAX = (\d+)/.exec(shell)?.[1])
  expect([min, max]).toEqual([0, 100])
  // The slider offers exactly that range, and the head script guards exactly it.
  expect(html).toMatch(new RegExp(`id="glass"[^>]*min="${min}"[^>]*max="${max}"`))
  expect(head).toContain(`glass >= ${min} && glass <= ${max}`)
  // Core clamps to the same window before it stores.
  expect(serve).toContain(`Math.min(${max}, Math.max(${min}, Math.round(chosen.glass)))`)

  // The blur scales with the tint, and the head script inlines the same sum glassFilter()
  // uses — a mismatch is one frame of the wrong frost, then the module overwrites it.
  const mult = /glassFilter[^]*?\* ([\d.]+)\)/.exec(shell)?.[1]
  expect(mult).toBe('0.5')
  expect(head).toContain(`Math.round(glass * ${mult})`)
  // .panel reads the variable the module sets, with a static fallback for the first paint.
  expect(css).toMatch(/backdrop-filter:\s*var\(--glass-filter,/)
})

test('theme: forcing a theme carries everything the desktop-preference query carries', () => {
  // The bug this exists for, found in the hook before anything drove it: `[data-theme='dark']`
  // set the fifteen colours and not `--paint` or the washes, so a forced dark theme was a
  // dark palette with the light theme's brushwork opacity on it. Nothing about that is
  // visible in a review of either block alone — only in the difference between them.
  const blocks = (selector: string): Record<string, string> => {
    const found: Record<string, string> = {}
    for (let at = css.indexOf(selector); at !== -1; at = css.indexOf(selector, at + 1)) {
      const body = css.slice(at + selector.length, css.indexOf('}', at))
      for (const [, name, value] of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) found[name!] = value!.trim()
    }
    return found
  }
  const byPreference = blocks(":root:not([data-theme='light']) {")
  const byAttribute = blocks(":root[data-theme='dark'] {")
  expect(Object.keys(byPreference).length).toBeGreaterThanOrEqual(18)
  expect(byAttribute).toEqual(byPreference)
})

test('theme: forcing a theme takes the browser furniture with it', () => {
  // `color-scheme` is what the scrollbars, the native select popups and the form controls
  // read. Left at `light dark` under a forced theme, they follow the desktop while the page
  // does not — a dark page with a white scrollbar down the side of it.
  expect(css).toMatch(/:root\[data-theme='light'\] \{\s*\n\s*color-scheme: light;/)
  expect(css).toMatch(/:root\[data-theme='dark'\] \{\s*\n\s*color-scheme: dark;/)
})

test('theme: the two previews are served, packaged, and small', () => {
  const plates = [...html.matchAll(/src="\/(theme-[\w.-]+)"/g)].map(([, file]) => file!)
  expect([...new Set(plates)].sort()).toEqual(['theme-dark.webp', 'theme-light.webp'])

  const packager = readFileSync(join(ui, '..', '..', 'scripts', 'package.mjs'), 'utf8')
  for (const file of new Set(plates)) {
    expect(serve, `serve.ts does not serve /${file}, so the card would be an empty frame`).toContain(`'/${file}'`)
    expect(packager, `package.mjs does not copy ${file} into the packaged shell`).toContain(`'${file}'`)
    // They are the card preview *and* the page background now, so they carry real pixels —
    // 2400px wide. Still a cap rather than a target: the originals were three megabytes each,
    // and the way that gets back in is somebody replacing a file rather than editing this line.
    const bytes = statSync(join(ui, file)).size
    expect(bytes, `${file} is ${Math.round(bytes / 1024)}KB`).toBeLessThan(512 * 1024)
  }
})
