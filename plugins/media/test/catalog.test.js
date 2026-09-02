// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { pickEntry, describe as line, flatten, runnable, search, shelf } from '../catalog.js'

/** `/templates/index.json` in miniature, with every shape the real one has. */
const INDEX = [
  {
    category: 'GENERATION TYPE',
    title: 'Image',
    templates: [
      {
        name: 'image_sd15_t2i',
        title: 'SD 1.5: Text to Image',
        description: 'Make a picture from words with a small, fast model.',
        tags: ['Text to Image'],
        models: ['SD1.5'],
        vram: 4_000_000_000,
        openSource: true,
        searchRank: 9,
      },
      {
        name: 'image_flux_krea',
        title: 'Flux Krea: Text to Image',
        description: 'High quality text to image.',
        tags: ['Text to Image'],
        models: ['Flux'],
        vram: 22_333_829_939,
        openSource: true,
      },
      {
        name: 'api_seedream_t2i',
        title: 'Seedream 5: Text to Image',
        description: 'Text to image through a hosted service.',
        tags: ['Text to Image'],
        models: [],
        openSource: false,
      },
    ],
  },
  {
    category: 'GENERATION TYPE',
    title: 'Utility',
    templates: [
      {
        name: 'utility_birefnet_bg',
        title: 'BiRefNet: Background Removal',
        description: 'Cut the subject out of a photograph and drop the background.',
        tags: ['Segmentation', 'Matting'],
        models: ['BiRefNet'],
        vram: 2_000_000_000,
        openSource: true,
        searchRank: 7,
      },
      // No `vram` at all, which fifteen of the real 468 also have.
      { name: 'utility_upscale', title: 'Upscale an image', description: 'Make it bigger.', tags: ['Upscale'], openSource: true },
    ],
  },
]

const CARD = 8_585_216_000

test('the groups flatten and keep what decides whether a thing is usable', () => {
  const all = flatten(INDEX)
  expect(all).toHaveLength(5)
  const flux = all.find((one) => one.name === 'image_flux_krea')
  expect(flux.category).toBe('Image')
  expect(flux.vram).toBe(22_333_829_939)
  expect(flux.paid).toBe(false)
  // A missing `openSource` must read as open, not as paid — a blank field must never make
  // something look like it costs money.
  expect(all.find((one) => one.name === 'utility_upscale').paid).toBe(false)
  expect(all.find((one) => one.name === 'api_seedream_t2i').paid).toBe(true)
  expect(flatten(undefined)).toEqual([])
})

test('a card decides the shelf, and paid services are off it by default', () => {
  const all = flatten(INDEX)
  const mine = runnable(all, { vram: CARD })
  expect(mine.map((one) => one.name)).toEqual(['image_sd15_t2i', 'utility_birefnet_bg', 'utility_upscale'])
  // Flux wants 22 GB and this card has 8.5 — offering it would be offering a disappointment.
  expect(mine.some((one) => one.name === 'image_flux_krea')).toBe(false)
  // The paid one comes back only when it is asked for.
  expect(runnable(all, { vram: CARD, paid: true }).some((one) => one.paid)).toBe(true)
})

test('an entry that never said what it wants is kept rather than hidden', () => {
  // Punishing a workflow because the catalogue left a field blank would be filtering on the
  // catalogue's gap instead of on the machine. It runs or it does not; one attempt finds out.
  const all = flatten(INDEX)
  expect(runnable(all, { vram: 1 }).map((one) => one.name)).toContain('utility_upscale')
})

test('searching finds the thing somebody described rather than the thing they named', () => {
  const all = flatten(INDEX)
  // Nobody types "BiRefNet". They type what they want done.
  expect(search(all, 'remove the background')[0].name).toBe('utility_birefnet_bg')
  expect(search(all, 'make a picture from words')[0].name).toBe('image_sd15_t2i')
  // A word too short to mean anything, and a word nothing matches, both come back empty rather
  // than confidently wrong.
  expect(search(all, 'a of')).toEqual([])
  expect(search(all, 'blockchain')).toEqual([])

  // **And a near-miss comes back empty too, which is the harder half.** “photograph” appears
  // in one description and nowhere in any title or tag — measured against the real catalogue,
  // matches like that returned depth estimation for *read this out loud*. A fourth-best guess
  // presented as an answer is worse than saying there is nothing.
  expect(search(all, 'photograph')).toEqual([])
})

test('the shelf is described in numbers that are true rather than impressive', () => {
  const all = flatten(INDEX)
  const said = shelf(all, CARD)
  expect(said.total).toBe(5)
  expect(said.paid).toBe(1)
  expect(said.fits).toBe(3)
  // **The sentence a person is actually given.** "468 workflows" to somebody whose card runs 45
  // of them is accurate and misleading at once, which is the pairing this project has least
  // room for — so the count that leads is the one about their machine.
  expect(said.said).toMatch(/3 fit your 8\.6 GB card/)
  expect(said.said).toMatch(/1 call paid services and are hidden/)
})

test('an entry reads as a line somebody can decide from', () => {
  const all = flatten(INDEX)
  expect(line(all.find((one) => one.name === 'image_flux_krea'))).toBe('Flux Krea: Text to Image — image, wants 22.3 GB, needs Flux')
  expect(line(all.find((one) => one.name === 'api_seedream_t2i'))).toContain('calls a paid service')
})

/**
 * Which entry somebody meant, when all they have ever been shown is a title.
 *
 * `describe` never prints the catalogue's own `name`, so the title is the only handle that has
 * been in front of a person — and installing the wrong workflow is a silent wrong answer to a
 * question asked out loud, so more than one match is a question rather than a guess.
 */
test('an entry is found by what somebody was actually shown', () => {
  const entries = [
    { name: 'image_z_image_int8', title: 'Z Image Turbo', description: '', tags: [], models: [], category: 'Image', paid: false, rank: 0 },
    { name: 'video_wan_i2v', title: 'WAN Image to Video', description: '', tags: [], models: [], category: 'Video', paid: false, rank: 0 },
    { name: 'video_wan_t2v', title: 'WAN Text to Video', description: '', tags: [], models: [], category: 'Video', paid: false, rank: 0 },
  ]
  // The catalogue's own name, which is what a second call would carry.
  expect(pickEntry(entries, 'image_z_image_int8').entry.title).toBe('Z Image Turbo')
  // The title, which is all a person ever saw. Case is not a decision anybody made.
  expect(pickEntry(entries, 'z image turbo').entry.name).toBe('image_z_image_int8')
  // One unique partial is unambiguous and is taken.
  expect(pickEntry(entries, 'Text to Video').entry.name).toBe('video_wan_t2v')
  // Two matches is a question, not a coin toss.
  const both = pickEntry(entries, 'WAN')
  expect(both.entry).toBeUndefined()
  expect(both.many).toEqual(['WAN Image to Video', 'WAN Text to Video'])
  // Nothing at all says nothing at all.
  expect(pickEntry(entries, 'a pony').entry).toBeUndefined()
})
