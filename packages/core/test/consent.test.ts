// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { allow, consume, forgetConsent, live, met, preauthorise, provenanceOf, record } from '../src/consent.js'
import { Skills } from '../src/skills.js'
import { Store } from '../src/store.js'

/**
 * The consent ladder for skills (M6-9, D84).
 *
 * A plugin has had this since M2-5 — a folder appearing is not consent — and **a skill
 * arrived and was simply live**, including one a model wrote after a task about what it
 * thinks it just learned. That is the case this exists for, and the three records exist
 * separately because they have three lifetimes.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-consent-'))
const store = new Store(join(root, 'alexia.db'))
afterAll(() => {
  store.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

test('provenance is written once, and a later writer does not get to change it', () => {
  record(store, 'sorting-downloads', 'learned')
  // The mistake this prevents: re-recording turns *learned* into *installed* the first time
  // somebody re-syncs a folder, and then nothing knows a model wrote it.
  record(store, 'sorting-downloads', 'installed')
  expect(provenanceOf(store, 'sorting-downloads')).toBe('learned')
})

test('nothing written is unknown, and unknown is a fact rather than a guess', () => {
  // The predecessor tried to read authorship out of a usage field, found it meant *is this
  // curator-managed*, and could not recover rows written before the marker existed. So an
  // absent fact is displayed as absent — the catalog's honesty rule, in a second place.
  expect(provenanceOf(store, 'never-heard-of-it')).toBeUndefined()
  met(store, { name: 'never-heard-of-it' })
  expect(provenanceOf(store, 'never-heard-of-it')).toBe('unknown')
})

test('a preauth is yes to one exact name, and it is spent once', () => {
  preauthorise(store, 'folding-laundry')
  expect(consume(store, 'folding-laundry')).toBe(true)
  // A second folder appearing under that name later is a folder nobody said yes to.
  expect(consume(store, 'folding-laundry')).toBe(false)
  expect(consume(store, 'something-else')).toBe(false)
})

test('a skill that arrives against a preauth is live, and one that just appears is not', () => {
  preauthorise(store, 'from-the-shop')
  met(store, { name: 'from-the-shop' })
  expect(live(store, { name: 'from-the-shop' })).toBe(true)
  expect(provenanceOf(store, 'from-the-shop')).toBe('installed')

  met(store, { name: 'appeared' })
  expect(live(store, { name: 'appeared' })).toBe(false)
})

test('a bundled skill is covered by the plugin’s own yes', () => {
  // Enabling the plugin was the consent decision, made with the author's own words on
  // screen. Asking again for the skill it shipped with would be asking twice.
  met(store, { name: 'dictating-well', pluginId: 'voice' })
  expect(provenanceOf(store, 'dictating-well')).toBe('bundled')
  expect(live(store, { name: 'dictating-well', pluginId: 'voice' })).toBe(true)
})

test('forgetting a skill forgets what was said about it', () => {
  allow(store, 'appeared')
  expect(live(store, { name: 'appeared' })).toBe(true)
  forgetConsent(store, 'appeared')
  // A folder that turns up under that name tomorrow is one nobody has said yes to.
  expect(live(store, { name: 'appeared' })).toBe(false)
  expect(provenanceOf(store, 'appeared')).toBeUndefined()
})

// ---- and the half that matters: the model is not shown one that is waiting ---------------

const dir = join(root, 'skills')
const write = (name: string, front = ''): void => {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: What ${name} is for.\n${front}---\n\nBody of ${name}.\n`)
}
write('waiting-one')
write('allowed-one')

test('a skill waiting for a person is not in the index and cannot be read by the model', () => {
  const skills = new Skills({ dir, store })
  expect(skills.all.map((one) => one.name).sort()).toEqual(['allowed-one', 'waiting-one'])
  // The list the screen reads holds both; the list the model is offered holds neither yet.
  expect(skills.usable).toEqual([])
  expect(skills.tool).toBeUndefined()
  expect(skills.read({ name: 'waiting-one' }).ok).toBe(false)

  allow(store, 'allowed-one')
  skills.invalidate()
  expect(skills.usable.map((one) => one.name)).toEqual(['allowed-one'])
  // That is the difference between a ladder and a label: the index is what the model sees.
  expect(skills.tool?.description).toContain('allowed-one')
  expect(skills.tool?.description).not.toContain('waiting-one')
  expect(skills.read({ name: 'waiting-one' }).ok).toBe(false)
  expect(skills.read({ name: 'allowed-one' }).ok).toBe(true)
})

test('the screen can read the one under review, because that is how somebody decides', () => {
  const skills = new Skills({ dir, store })
  // A review screen that could not show you the thing under review would be a screen
  // asking you to guess.
  expect(skills.text('waiting-one')).toContain('Body of waiting-one.')
})

test('no store at all means everything is live, which is what a caller with none is asking', () => {
  // The scanner is used without one — by tests of itself, and by anything that wants the
  // folders rather than the ladder.
  const bare = new Skills({ dir })
  expect(bare.usable.map((one) => one.name).sort()).toEqual(['allowed-one', 'waiting-one'])
  expect(bare.all.every((one) => one.live === undefined)).toBe(true)
})
