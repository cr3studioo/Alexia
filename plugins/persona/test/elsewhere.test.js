// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { brief, factsFrom, MARK } from '../writing.js'

/**
 * **Improvements 5 and 9** (`plan-personality.md`, order-of-work step 7).
 *
 * *Facts to memory, behaviour in the personality*: a description people write is half **how to
 * be** and half **who I am**, and the second half in a personality is re-sent on every step
 * whether it matters or not — plus it is a second place their name lives, which is two places
 * that can disagree about it.
 *
 * *A personality per place*: a reply read on a phone wants to be shorter and plainer than one
 * at the desk.
 */

const source = readFileSync(join(import.meta.dirname, '..', 'index.js'), 'utf8').replace(/\r\n/g, '\n')
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'plugin.json'), 'utf8'))

// ---- 5: facts, offered and never taken ---------------------------------------------------------

test('facts come out of the same call as the document, never out of a second one', () => {
  // The whole efficiency argument for Refine applies here too: an extra call per Adapt is an
  // extra chance for a slow model to run out of room, for a feature that is a list of sentences.
  expect(source.match(/createMessage\(/g)).toHaveLength(2)
  expect(brief('blunt, my grant is due in March', 'Chief', true)).toContain(MARK.facts)
})

test('facts are only asked for when something is going to remember them', () => {
  // A machine with no memory plugin gets the brief it always had and pays nothing for a
  // feature it cannot use — and `alexia/answers` is how the plugin can tell without learning
  // who would answer.
  expect(brief('blunt', 'Chief')).not.toContain(MARK.facts)
  expect(source).toMatch(/const remembering = \(await alexia\.answers\('memory\.remember'\)/)
  expect(source).toMatch(/brief\(description, name, remembering\)/)
})

test('a fact is a sentence that reads on its own, and anything else is not a fact', () => {
  const said = [
    'the document',
    MARK.facts,
    '- Vaclav’s grant deadline is in March.',
    '* He runs a studio called cr3.',
    '',
    '# a heading a model added',
    'short',
    `${'x'.repeat(300)}`,
  ].join('\n')
  expect(factsFrom(said)).toEqual(['Vaclav’s grant deadline is in March.', 'He runs a studio called cr3.'])
  // No marker is no facts, which is the ordinary case on a machine with no memory plugin.
  expect(factsFrom('the document')).toEqual([])
  expect(factsFrom(undefined)).toEqual([])
  // And a model that wrote the marker and nothing after it has stated no facts, not failed.
  expect(factsFrom(`doc\n${MARK.facts}\n`)).toEqual([])
})

test('nothing is remembered until the button, and the button is one press for all of them', () => {
  // D160: **one confirm for all of them**. A list with every fact ticked is the shape that
  // decision proposed and did not settle, and it is not one the widget set can draw — a plugin
  // writes only its own `status` settings, so it cannot put a dynamic list into a control.
  expect(source).toMatch(/Nothing has been remembered/)
  expect(source).toMatch(/for \(const fact of facts\)/)
  expect(source).toMatch(/alexia\.capability\('memory\.remember', \{ text: fact \}\)/)
  // The offer is cleared by the press, so it cannot be taken up twice.
  expect(source).toMatch(/\{ facts: '\[\]' \}/)
  // And the dependency is declared with a sentence the person reads, not documentation.
  const needs = manifest.requires.find((one) => one.cap === 'memory.remember')
  expect(needs).toBeDefined()
  expect(needs.why).toMatch(/when you press the button/)
})

test('with nothing to remember into, the button says so rather than failing quietly', () => {
  expect(source).toMatch(/Nothing here remembers things between conversations, so there is nowhere to put them/)
})

// ---- 9: a personality per place -------------------------------------------------------------------

test('the capability takes an optional channel, and ignoring it is the old behaviour', () => {
  // Optional at both ends: core sends nothing for a task from the window, because *the window*
  // is not a channel anybody bound anything to — it is the absence of one.
  expect(source).toMatch(/channel: \{\n\s+type: 'string'/)
  expect(source).toMatch(/const using = await forChannel\(String\(args\?\.channel \?\? ''\)\)/)
  // The fallback is the row in use, so one personality everywhere is still what happens.
  expect(source).toMatch(/return active\(\)/)
})

test('a table from before channels existed still answers with the row in use', () => {
  // A plugin table grows a column the first time a key is written, so every row saved before
  // this release has no `channel` — and `WHERE channel = ?` on it is SQLite's *no such column*.
  // Uncaught, every task a phone started had no personality at all on an upgraded install.
  const at = source.indexOf('const forChannel = async')
  const body = source.slice(at, source.indexOf('\n}\n', at))
  expect(body).toMatch(/where: \{ channel: said \}, limit: 1 \}\)\.catch\(\(\) => \[\]\)/)
  expect(body).toMatch(/return active\(\)/)
})

test('a bound row is not a second kind of *in use*, and neither clears the other', () => {
  // The row in use answers everywhere nothing else claims; a bound row answers in its own place
  // and nowhere else. Two flags, two meanings, and a row action that touches only its own.
  const at = source.indexOf("  'usethere',")
  expect(at).toBeGreaterThan(-1)
  const body = source.slice(at, at + 2000)
  expect(body).not.toContain('active')
  // One place, one personality: the row that had it lets go first, because two rows claiming
  // one channel is a coin toss nobody would be able to see.
  expect(body).toMatch(/\{ channel: '' \}, \{ channel: where \}/)
  // And an empty box unbinds rather than binding to nothing.
  expect(body).toMatch(/is no longer bound anywhere/)
})

test('where a row is bound is visible, or the binding is a setting nobody can see', () => {
  expect(source).toMatch(/`on \$\{String\(row\.channel\)\}`/)
  const table = manifest.settings.find((one) => one.key === 'saved')
  expect(table.rowActions.map((one) => one.key)).toContain('usethere')
  expect(manifest.settings.find((one) => one.key === 'use_on')?.type).toBe('text')
})
