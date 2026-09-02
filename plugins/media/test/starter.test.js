// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { api, editor, STARTER } from '../starter.js'
import { knobs, isApi } from '../workflows.js'

/**
 * The starter workflow, in both of the formats ComfyUI keeps.
 *
 * The reason both are generated from one definition is that shipping two hand-written files
 * means shipping the day they disagree — and the day they disagree, Alexia runs one pipeline
 * while the person edits another and neither of them can tell. So the test that matters is not
 * that either file is well formed; it is that **they are the same workflow**.
 */

const CLASSES = {
  CheckpointLoaderSimple: {
    display_name: 'Load Checkpoint',
    input: { required: { ckpt_name: [['sd_xl_base_1.0.safetensors']] } },
  },
  CLIPTextEncode: { display_name: 'CLIP Text Encode (Prompt)', input: { required: { text: ['STRING', { multiline: true }] } } },
  EmptyLatentImage: {
    display_name: 'Empty Latent Image',
    input: { required: { width: ['INT', {}], height: ['INT', {}], batch_size: ['INT', {}] } },
  },
  // Read off this machine's own `/object_info`, interleaving exactly as ComfyUI declares it —
  // links and widgets in one list, which is what makes `widgets_values` order a trap.
  KSampler: {
    display_name: 'KSampler',
    input: {
      required: {
        model: ['MODEL'],
        seed: ['INT', {}],
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
  },
  VAEDecode: { display_name: 'VAE Decode', input: { required: {} } },
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
  },
  SaveImage: { display_name: 'Save Image', input: { required: { filename_prefix: ['STRING', {}] } } },
}

test('the runnable rendering is wired end to end', () => {
  const g = api({ checkpoint: 'sd_xl_base_1.0.safetensors', prompt: 'a lighthouse', negative: 'blurry', seed: 7 })
  expect(isApi(g)).toBe(true)
  expect(g[5].inputs.model).toEqual(['1', 0])
  expect(g[5].inputs.positive).toEqual(['2', 0])
  expect(g[5].inputs.negative).toEqual(['3', 0])
  expect(g[5].inputs.latent_image).toEqual(['4', 0])
  expect(g[6].inputs.samples).toEqual(['5', 0])
  expect(g[6].inputs.vae).toEqual(['1', 2])
  expect(g[7].inputs.images).toEqual(['6', 0])
  expect(g[2].inputs.text).toBe('a lighthouse')
  expect(g[3].inputs.text).toBe('blurry')
  expect(g[1].inputs.ckpt_name).toBe('sd_xl_base_1.0.safetensors')
  expect(g[5].inputs.seed).toBe(7)
})

test('`control_after_generate` is in the editor rendering and in no graph that runs', () => {
  // The widget that makes the editor re-roll a seed, which has no input behind it and does not
  // survive an export. It is the reason `reseed()` exists, and it must never reach `/prompt`.
  const doc = editor()
  const sampler = doc.nodes.find((one) => one.type === 'KSampler')
  expect(sampler.widgets_values).toEqual([0, 'randomize', 12, 7, 'dpmpp_2m', 'karras', 1])
  expect(Object.keys(api({}) [5].inputs)).not.toContain('control_after_generate')
  expect(Object.keys(api({}) [5].inputs)).not.toContain(null)
})

test('the two renderings are the same workflow', () => {
  const doc = editor()
  const g = api({})
  // Same nodes.
  expect(doc.nodes.map((one) => String(one.id)).sort()).toEqual(Object.keys(g).sort())
  for (const node of doc.nodes) expect(g[String(node.id)].class_type).toBe(node.type)

  // Same wiring: every link in the editor document is a `[id, slot]` pair in the graph.
  for (const [, fromNode, fromSlot, toNode, toSlot] of doc.links) {
    const target = doc.nodes.find((one) => one.id === toNode)
    const name = target.inputs[toSlot].name
    expect(g[String(toNode)].inputs[name], `${target.type}.${name}`).toEqual([String(fromNode), fromSlot])
  }

  // Same values — and getting here is the point. `widgets_values` is a bare array indexed by
  // *widget* order, which is the declared order with every link input skipped. ComfyUI
  // interleaves the two (`model, seed, steps, cfg, sampler_name, scheduler, positive, …`), so
  // counting positions without filtering is exactly how a hand-written converter goes wrong.
  const WIDGETS = ['STRING', 'INT', 'FLOAT', 'BOOLEAN']
  for (const node of doc.nodes) {
    const required = CLASSES[node.type].input.required
    const names = Object.keys(required).filter((name) => Array.isArray(required[name][0]) || WIDGETS.includes(required[name][0]))
    const values = node.widgets_values.filter((one) => one !== 'randomize')
    expect(values.length, `${node.type} widget count`).toBe(names.length)
    names.forEach((name, at) => {
      expect(g[String(node.id)].inputs[name], `${node.type}.${name}`).toBe(values[at])
    })
  }
})

test('the fields a person gets are the ones its author named', () => {
  // The starter is the convention's own documentation: bind it with the same code that binds
  // anybody's workflow, and the names that come out are the titles written on the nodes.
  const found = knobs(api({}), CLASSES)
  expect(found.map((one) => one.field)).toEqual(['model', 'what_to_make', 'what_to_avoid', 'size_width', 'size_height', 'size_batch_size'])

  // The untitled sampler stays out, even though every one of its inputs is a literal — which is
  // the rule, and the reason the starter has titles exactly where it wants fields.
  expect(found.some((one) => one.node === '5')).toBe(false)
  expect(found.some((one) => one.node === '7')).toBe(false)

  // The model field carries this install's real checkpoint list rather than a frozen enum.
  expect(found.find((one) => one.field === 'model').options).toEqual(['sd_xl_base_1.0.safetensors'])
})

test('the black-image lesson survived being moved into a workflow', () => {
  // The oldest thing this plugin knows: SDXL's fp16 VAE overflows on many 8 GB cards and the
  // symptom is a black image with no error anywhere. Moving the pipeline out of JavaScript and
  // into a file is exactly the kind of change that quietly loses a fix like this.
  expect(api({})[6].class_type).toBe('VAEDecodeTiled')
  expect(api({ fp32: false })[6].class_type).toBe('VAEDecode')
  // All four numbers, because the node requires every one and a graph missing one is a 400.
  expect(Object.keys(api({})[6].inputs).sort()).toEqual(['overlap', 'samples', 'temporal_overlap', 'temporal_size', 'tile_size', 'vae'])
  // And the editable rendering wires in the same node, or the two disagree the day someone opens it.
  expect(editor({}, { fp32: true }).nodes.find((one) => one.id === 6).type).toBe('VAEDecodeTiled')
  expect(editor({}, { fp32: false }).nodes.find((one) => one.id === 6).type).toBe('VAEDecode')
  // Whichever it is, the save still reads from it.
  expect(api({ fp32: false })[7].inputs.images).toEqual(['6', 0])
  expect(api({})[7].inputs.images).toEqual(['6', 0])
})

test('it is fast by default, because the first picture anybody asks for should arrive', () => {
  // Twelve steps at 768 is seconds rather than half a minute. "Better" turns the dials up; the
  // first impression does not get to be a wait.
  const g = api({})
  expect(g[5].inputs.steps).toBe(12)
  expect(g[4].inputs.width).toBe(768)
  expect(g[4].inputs.height).toBe(768)
})

test('the same seed and the same words give the same graph', () => {
  const once = { checkpoint: 'a.safetensors', prompt: 'a cat', negative: 'blurry', seed: 7 }
  expect(JSON.stringify(api(once))).toBe(JSON.stringify(api(once)))
})

test('it has a name a person will recognise in their own sidebar', () => {
  expect(STARTER).toBe('Alexia — Picture')
})
