// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { matchName } from '../writing.js'

/**
 * `/persona` and `/plainly` (plan-personality.md step 4d, part of improvement 8).
 *
 * Switching by name is silent when it goes wrong — the next answer is simply in the wrong
 * voice, with nothing on screen saying why — so the matching rule is *one candidate or none*,
 * never a best guess.
 */

const rows = [
  { rowid: 1, name: 'Chief of staff' },
  { rowid: 2, name: 'Chief of staff 2' },
  { rowid: 3, name: 'Butler' },
]

test('an exact name wins, even when it is a prefix of another', () => {
  // The killer case: `unique()` makes "Chief of staff 2" beside "Chief of staff", so a prefix
  // rule alone would make the original unreachable by its own full name.
  expect(matchName(rows, 'Chief of staff').row?.rowid).toBe(1)
  expect(matchName(rows, 'chief of staff 2').row?.rowid).toBe(2)
})

test('a unique prefix or fragment is enough, because nobody types a full name on a phone', () => {
  expect(matchName(rows, 'but').row?.rowid).toBe(3)
  expect(matchName(rows, 'BUTLER').row?.rowid).toBe(3)
  expect(matchName(rows, 'utle').row?.rowid).toBe(3)
})

test('two candidates switch nothing, and say which two', () => {
  const found = matchName(rows, 'chief')
  expect(found.row).toBeUndefined()
  expect(found.among).toEqual(['Chief of staff', 'Chief of staff 2'])
})

test('no candidate is no match, not the nearest one', () => {
  expect(matchName(rows, 'gardener')).toEqual({ none: true })
  expect(matchName(rows, '   ')).toEqual({ none: true })
  expect(matchName([], 'anything')).toEqual({ none: true })
})

test('the manifest declares both commands, and declares them as core dispatches them', () => {
  const manifest = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'))
  const names = manifest.commands.map((one) => one.name)
  expect(names).toEqual(['persona', 'plainly'])
  // Core binds a command to the plugin tool of the same name (commands.ts run()), so a
  // command with no tool behind it is a command that answers "is not running".
  const schema = JSON.parse(readFileSync(new URL('../../../docs/spec/plugin.schema.json', import.meta.url), 'utf8'))
  const pattern = new RegExp(schema.properties.commands.items.properties.name.pattern)
  for (const one of manifest.commands) {
    expect(pattern.test(one.name), one.name).toBe(true)
    expect(one.summary.length).toBeLessThanOrEqual(120)
  }
  // `commands` is an existing manifest field, so none of *this* moved the protocol. The
  // declaration went 2 → 7 for `multiline` on the Edit box (improvement 2) and 7 → 10 for
  // `alexia/answers` (improvement 4), then 10 → 12 for its `page` on the board (D199) — each
  // time, the oldest Alexia that knows what it needs.
  expect(manifest.alexia_protocol).toBe(12)
  expect(manifest.settings.some((one) => one.multiline === true)).toBe(true)
})

test('each declared command has a tool of the same name behind it', () => {
  // Core binds `/x` to the plugin tool called `x` and nothing else, so a command declared
  // without one is a command that answers "is not running" the first time it is typed.
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const manifest = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'))
  for (const one of manifest.commands) {
    expect(source, one.name).toMatch(new RegExp(`alexia\\.tool\\(\\s*'${one.name}'`))
  }
})

test('the argument is called what core passes it as, not what it holds', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  // Core hands whatever followed the command over under `rest`, the same key for every
  // plugin command (D177). Naming this property anything else — `name`, which is what it
  // actually holds — silently receives nothing, and `/persona Butler` goes back to listing.
  expect(source).toMatch(/properties: \{ rest: \{ type: 'string'/)
  expect(source).toMatch(/String\(args\?\.rest \?\? ''\)/)
  expect(source).toMatch(/matchName\(rows, typed\)/)
})
