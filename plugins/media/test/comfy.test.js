// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { graph, pick } from '../comfy.js'

// The graph is the whole of what this plugin knows about diffusion, and one wire in the
// wrong place is a black image with no error anywhere. That failure is the reason the
// setting exists, so it is the thing with a test.

const built = (fp32) =>
  graph({ prompt: 'a cat', negative: 'blurry', checkpoint: 'sdxl.safetensors', steps: 25, width: 1024, height: 1024, seed: 7, fp32 })

test('the pipeline is wired end to end', () => {
  const g = built(false)
  expect(g[3].inputs.model).toEqual(['4', 0])
  expect(g[3].inputs.positive).toEqual(['6', 0])
  expect(g[3].inputs.negative).toEqual(['7', 0])
  expect(g[8].inputs.samples).toEqual(['3', 0])
  expect(g[9].inputs.images).toEqual(['8', 0])
  expect(g[6].inputs.text).toBe('a cat')
  expect(g[7].inputs.text).toBe('blurry')
})

test('the full-precision decode is the one that avoids the black image', () => {
  // SDXL's fp16 VAE overflows on many 8 GB cards and the symptom is a black image with no
  // error at all. Tiled decoding at full precision is the fix, and it is a different node.
  expect(built(false)[8].class_type).toBe('VAEDecode')
  expect(built(true)[8].class_type).toBe('VAEDecodeTiled')
  expect(built(true)[8].inputs.vae).toEqual(['4', 2])
})

test('the tiled decode sends every input the node requires', () => {
  // Found by trying to make a picture: `VAEDecodeTiled` requires four numbers, this sent
  // one, and ComfyUI refuses the whole graph with a 400 naming the three that are missing.
  // It is the **default** path, so until this was fixed the plugin could not make an image
  // at all on a current ComfyUI. The temporal pair are for video VAEs and do nothing to a
  // still — they are here because the node asks for them.
  expect(Object.keys(built(true)[8].inputs).sort()).toEqual(
    ['overlap', 'samples', 'temporal_overlap', 'temporal_size', 'tile_size', 'vae'],
  )
})

test('the same seed and prompt give the same graph', () => {
  expect(JSON.stringify(built(true))).toBe(JSON.stringify(built(true)))
})

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
