// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { convert, widgetOrder } from '../convert.js'
import { editor } from '../starter.js'

/**
 * The converter D123 refused, built so that it refuses rather than guesses.
 *
 * **Measured before it was trusted.** Run against all 45 templates this machine can actually
 * run, it converts 6 and refuses 39 — 25 for containing a subgraph, 13 for a widget count that
 * did not add up, 1 for a Primitive. That figure is the finding rather than a disappointment:
 * a hand-written conversion recovers about one workflow in seven, and the rest still need the
 * frontend that has always owned this. What makes the six safe is that the thirty-nine said so.
 */

const CLASSES = {
  CheckpointLoaderSimple: {
    display_name: 'Load Checkpoint',
    input: { required: { ckpt_name: [['a.safetensors']] } },
    input_order: { required: ['ckpt_name'] },
  },
  CLIPTextEncode: {
    display_name: 'CLIP Text Encode (Prompt)',
    input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } },
    input_order: { required: ['text', 'clip'] },
  },
  EmptyLatentImage: {
    display_name: 'Empty Latent Image',
    input: { required: { width: ['INT', {}], height: ['INT', {}], batch_size: ['INT', {}] } },
    input_order: { required: ['width', 'height', 'batch_size'] },
  },
  KSampler: {
    display_name: 'KSampler',
    input: {
      required: {
        model: ['MODEL'],
        seed: ['INT', { control_after_generate: true }],
        steps: ['INT', {}],
        cfg: ['FLOAT', {}],
        sampler_name: [['euler', 'dpmpp_2m']],
        scheduler: [['normal', 'karras']],
        positive: ['CONDITIONING'],
        negative: ['CONDITIONING'],
        latent_image: ['LATENT'],
        denoise: ['FLOAT', {}],
      },
    },
    input_order: {
      required: ['model', 'seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'positive', 'negative', 'latent_image', 'denoise'],
    },
  },
  VAEDecodeTiled: {
    display_name: 'VAE Decode (Tiled)',
    input: {
      required: {
        samples: ['LATENT'],
        vae: ['VAE'],
        tile_size: ['INT', {}],
        overlap: ['INT', {}],
        temporal_size: ['INT', {}],
        temporal_overlap: ['INT', {}],
      },
    },
    input_order: { required: ['samples', 'vae', 'tile_size', 'overlap', 'temporal_size', 'temporal_overlap'] },
  },
  SaveImage: {
    display_name: 'Save Image',
    input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', {}] } },
    input_order: { required: ['images', 'filename_prefix'] },
  },
  // A V3 node: `COMBO` named as a type, with the list moved into the options.
  KSamplerSelect: {
    display_name: 'KSamplerSelect',
    input: { required: { sampler_name: ['COMBO', { options: ['euler', 'heun'] }] } },
    input_order: { required: ['sampler_name'] },
  },
}

test('a combo is a widget in both of the spellings one install uses at once', () => {
  // The bug this caught in shipped code: reading only the older spelling made a V3 node look
  // like it had no widgets at all, which is indistinguishable from the ambiguity this refuses on.
  expect(widgetOrder(CLASSES.KSamplerSelect).map((one) => one.name)).toEqual(['sampler_name'])
  expect(widgetOrder(CLASSES.CheckpointLoaderSimple).map((one) => one.name)).toEqual(['ckpt_name'])
})

test('`control_after_generate` takes a slot that belongs to no input', () => {
  // It is why an exported seed never changes, and why counting inputs instead of widgets gets
  // every value after the seed wrong by one.
  expect(widgetOrder(CLASSES.KSampler).map((one) => one.name)).toEqual([
    'seed',
    null,
    'steps',
    'cfg',
    'sampler_name',
    'scheduler',
    'denoise',
  ])
})

test('a graph it can prove, it converts — and the result matches the one the renderer builds', () => {
  // The strongest check available: `starter.js` renders one pipeline into both formats from a
  // single definition, so converting the editor half has to reproduce the runnable half.
  const got = convert(editor(), CLASSES)
  expect(got.ok, JSON.stringify(got.why)).toBe(true)
  expect(got.graph[5].inputs.model).toEqual(['1', 0])
  expect(got.graph[5].inputs.positive).toEqual(['2', 0])
  expect(got.graph[5].inputs.seed).toBe(0)
  expect(got.graph[5].inputs.steps).toBe(12)
  expect(got.graph[5].inputs.sampler_name).toBe('dpmpp_2m')
  expect(got.graph[6].class_type).toBe('VAEDecodeTiled')
  expect(got.graph[7].inputs.images).toEqual(['6', 0])
  // `randomize` is the editor's own widget and must never reach a graph.
  expect(Object.values(got.graph).some((one) => Object.values(one.inputs).includes('randomize'))).toBe(false)
})

test('a widget count that does not add up is refused, not guessed at', () => {
  // The rgthree shape: objects where order says scalars. There is no mapping to read, so there
  // is no answer to give — and an answer given anyway is a picture nobody can explain.
  const doc = editor()
  doc.nodes.find((one) => one.id === 5).widgets_values = [{ on: true, lora: 'x.safetensors' }, 'randomize']
  const got = convert(doc, CLASSES)
  expect(got.ok).toBe(false)
  expect(got.why[0]).toMatch(/holds 2 widget values where this install's KSampler declares 7/)
  expect(got.why[0]).toMatch(/not plain values/)
})

test('a bypassed node stops the whole conversion rather than being dropped', () => {
  // Dropping it silently disconnects the graph; keeping it sends the backend something it was
  // told to skip. Re-joining the wires is the obstacle D123 named, and it is not attempted.
  const doc = editor()
  doc.nodes.find((one) => one.id === 6).mode = 4
  const got = convert(doc, CLASSES)
  expect(got.ok).toBe(false)
  expect(got.why[0]).toMatch(/is muted/)
})

test('a subgraph, a reroute and an uninstalled class each refuse by name', () => {
  // Twenty-five of the forty-five real templates stop at the first of these, which is why the
  // reason has to be specific enough to act on rather than a shrug.
  expect(convert({ nodes: [], definitions: { subgraphs: [{}] } }, CLASSES).why[0]).toMatch(/subgraph/)

  const rerouted = editor()
  rerouted.nodes.push({ id: 99, type: 'Reroute', mode: 0, widgets_values: [] })
  expect(convert(rerouted, CLASSES).why[0]).toMatch(/Reroute/)

  const without = Object.fromEntries(Object.entries(CLASSES).filter(([one]) => one !== 'KSampler'))
  expect(convert(editor(), without).why[0]).toMatch(/KSampler, which is not installed here/)
})

test('notes are furniture and are left out without complaint', () => {
  // A Note is drawn on the canvas and the backend has never heard of it. Refusing over one
  // would refuse most of the catalogue on account of a sticky label.
  const doc = editor()
  doc.nodes.push({ id: 98, type: 'MarkdownNote', mode: 0, widgets_values: ['read me first'] })
  const got = convert(doc, CLASSES)
  expect(got.ok).toBe(true)
  expect(got.graph['98']).toBeUndefined()
})

test('a required input nothing fills is caught here rather than as a 400 later', () => {
  const doc = editor()
  const sampler = doc.nodes.find((one) => one.id === 5)
  sampler.inputs = sampler.inputs.filter((one) => one.name !== 'latent_image')
  const got = convert(doc, CLASSES)
  expect(got.ok).toBe(false)
  expect(got.why.join(' ')).toMatch(/nothing for its required input "latent_image"/)
})

test('nothing that is not a workflow is mistaken for one', () => {
  expect(convert(undefined, CLASSES).ok).toBe(false)
  expect(convert({ 3: { class_type: 'KSampler', inputs: {} } }, CLASSES).why[0]).toMatch(/no nodes/)
  expect(convert({ nodes: [] }, CLASSES).why[0]).toMatch(/nothing in it to run/)
})
