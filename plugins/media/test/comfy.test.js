// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { named, pick } from '../comfy.js'

// The graph is the whole of what this plugin knows about diffusion, and one wire in the
// wrong place is a black image with no error anywhere. That failure is the reason the
// setting exists, so it is the thing with a test.

test('a model is picked by any part of the name nobody wants to type', () => {
  // Checkpoint filenames are not names people chose, and asking for one exactly is asking
  // for a typo. What must not happen is a near-miss quietly answered with another model:
  // that is how a request for anime comes back photographic and nobody can tell why.
  const have = ['CyberRealisticPony_V18.0_F16.safetensors', 'hassakuXLIllustrious_v22.safetensors']
  expect(pick(have, 'hassaku')).toBe(have[1])
  expect(pick(have, 'HASSAKU')).toBe(have[1])
  expect(pick(have, have[0])).toBe(have[0])
  expect(pick(have, 'flux')).toBeUndefined()
  expect(pick(have, '')).toBeUndefined()
  expect(pick(have, undefined)).toBeUndefined()
})

test('the Model box is a name to match, and `auto` is not one', () => {
  // The box used to be a dropdown offering exactly one option, `auto`, under a hint saying
  // the list would fill in. It could not: `choice` options are fixed in the manifest and
  // core refuses any plugin write to a widget that is not a `status`. So the box is text
  // now and `auto` is what an existing install has saved — it has to go on meaning
  // *whichever ComfyUI has*, not match the first checkpoint with those four letters in it.
  expect(named('auto')).toBe('')
  expect(named(' AUTO ')).toBe('')
  expect(named('')).toBe('')
  expect(named(undefined)).toBe('')
  expect(named('  hassaku ')).toBe('hassaku')
  expect(pick(['autismmixSDXL_v20.safetensors'], named('auto'))).toBeUndefined()
})
