// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { catalogue, VOICES, where } from '../piper.js'

/**
 * The voice list behind the panel (M6-6).
 *
 * The change that made the panel possible is small and worth holding still: **a voice is a
 * file stem in `voices/`**, and one of the three published names resolves to its published
 * stem while anything else is taken as the stem itself. That is the whole of what makes a
 * voice somebody added work exactly like one Alexia downloaded — nothing downstream can tell
 * them apart, and nothing downstream needs to.
 */

const own = mkdtempSync(join(tmpdir(), 'alexia-piper-'))
mkdirSync(join(own, 'voices'), { recursive: true })
afterAll(() => rmSync(own, { recursive: true, force: true }))

const put = (stem) => {
  writeFileSync(join(own, 'voices', `${stem}.onnx`), 'x')
  writeFileSync(join(own, 'voices', `${stem}.onnx.json`), '{}')
}

test('a published voice resolves to its published file, and anything else to itself', () => {
  expect(where(own, 'lessac').model).toContain(VOICES.lessac.file)
  // The line that makes the rest of this work: no lookup, no fallback to lessac, no special
  // case. A stem nobody published is a voice with that stem.
  expect(where(own, 'my-own-voice').model).toContain('my-own-voice.onnx')
  expect(where(own, 'my-own-voice').config).toContain('my-own-voice.onnx.json')
})

test('the three published voices are always offered, downloaded or not', async () => {
  // *Not downloaded* is a state a person can act on. An absence is not, and a list that
  // hid the two voices you have not fetched would be a list that looks like there is one.
  const found = await catalogue(own)
  expect(found.map((one) => one.id).sort()).toEqual(Object.keys(VOICES).sort())
  expect(found.every((one) => one.here === false && one.mine === false)).toBe(true)
  expect(found.find((one) => one.id === 'ryan')?.mb).toBe(VOICES.ryan.mb)
})

test('a voice on disk is found, and one nobody published is marked as yours', async () => {
  put(VOICES.amy.file)
  put('great-aunt-mabel')

  const found = await catalogue(own)
  expect(found.find((one) => one.id === 'amy')).toMatchObject({ here: true, mine: false })
  // The one that could not have come from the published list: it is here, it is yours, and
  // it has no size because nobody published one to know.
  expect(found.find((one) => one.id === 'great-aunt-mabel')).toMatchObject({ here: true, mine: true })
  expect(found.find((one) => one.id === 'great-aunt-mabel')?.mb).toBeUndefined()
})

test('a voice with no config is still a folder entry, because half a voice is silence', async () => {
  // Piper will not load one without its config, so listing it is what lets the panel say
  // something about it rather than leaving a file nobody can explain.
  writeFileSync(join(own, 'voices', 'half-a-voice.onnx'), 'x')
  const found = await catalogue(own)
  expect(found.find((one) => one.id === 'half-a-voice')).toMatchObject({ mine: true })
})

test('no voices folder at all is the ordinary start, not an error', async () => {
  const fresh = mkdtempSync(join(tmpdir(), 'alexia-piper-empty-'))
  const found = await catalogue(fresh)
  expect(found).toHaveLength(Object.keys(VOICES).length)
  rmSync(fresh, { recursive: true, force: true })
})
