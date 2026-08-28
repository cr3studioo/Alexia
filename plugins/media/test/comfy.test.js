// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { graph } from '../comfy.js'

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

test('the same seed and prompt give the same graph', () => {
  expect(JSON.stringify(built(true))).toBe(JSON.stringify(built(true)))
})
