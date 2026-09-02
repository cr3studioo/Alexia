// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { reading, tier, TIERS, vram } from '../tier.js'

/** `/system_stats` as this machine actually answered it, trimmed to what the tiering reads. */
const THIS_MACHINE = {
  devices: [
    {
      name: 'cuda:0 NVIDIA GeForce RTX 4060 Ti : cudaMallocAsync',
      type: 'cuda',
      index: 0,
      vram_total: 8_585_216_000,
      vram_free: 897_129_170,
    },
  ],
  system: { ram_total: 17_101_475_840 },
}

test('the card is read out of what ComfyUI actually reports', () => {
  const card = vram(THIS_MACHINE)
  expect(card.total).toBe(8_585_216_000)
  // The name carries a device prefix and an allocator suffix; neither belongs on a settings page.
  expect(card.name).toBe('cuda')
  expect(card.type).toBe('cuda')
})

test('no card is not the same answer as a small card', () => {
  // A laptop with no GPU must not be told it is on the small tier — that reads as *this will
  // work*, and what is true is *this will work, and take minutes*.
  expect(vram({ devices: [{ type: 'cpu', vram_total: 0 }] })).toBeUndefined()
  expect(vram({ devices: [] })).toBeUndefined()
  expect(vram({})).toBeUndefined()
  expect(tier(0)).toBeUndefined()
  expect(tier(undefined)).toBeUndefined()
})

test('the rungs are picked by what the card can hold', () => {
  expect(tier(4e9).name).toBe('small')
  expect(tier(5.9e9).name).toBe('small')
  expect(tier(6e9).name).toBe('mid')
  expect(tier(8_585_216_000).name).toBe('mid') // this machine
  expect(tier(11.9e9).name).toBe('mid')
  expect(tier(12e9).name).toBe('high')
  expect(tier(24e9).name).toBe('high')
})

test('every rung names its licence and its size, because the card has to say both', () => {
  // Downloading a model on somebody's behalf is accepting its licence on their behalf. A rung
  // that could not say which licence would be a rung that cannot be honestly offered.
  for (const one of TIERS) {
    expect(one.licence, one.name).toBeTruthy()
    expect(one.bytes, one.name).toBeGreaterThan(1e9)
    expect(one.url, one.name).toMatch(/^https:\/\//)
    expect(one.file, one.name).toMatch(/\.safetensors$/)
  }
  // And none of them is non-commercial, which is the one thing that cannot be defaulted into.
  expect(TIERS.every((one) => !/non-commercial/i.test(one.licence))).toBe(true)
})

test('a machine that already has models is told there is nothing to download', () => {
  // The commonest person to install this plugin first is the one who already generates images.
  const said = reading(THIS_MACHINE, ['hassakuXLIllustrious_v22.safetensors', 'CyberRealisticPony_V18.safetensors'])
  expect(said.ok).toBe(true)
  expect(said.download).toBeUndefined()
  expect(said.said).toMatch(/2 models already installed/)
  expect(said.said).toMatch(/nothing to download/)
})

test('a fresh machine is told the size and the licence before anything is pressed', () => {
  const said = reading(THIS_MACHINE, [])
  expect(said.ok).toBe(true)
  expect(said.download.name).toBe('mid')
  expect(said.said).toMatch(/8\.6 GB/) // the card
  expect(said.said).toMatch(/6\.9 GB/) // what it is about to fetch
  expect(said.said).toMatch(/RAIL/) // under which licence
})

test('a machine with no card says so, and says what is coming without offering a button', () => {
  const said = reading({ devices: [] }, [])
  expect(said.ok).toBe(false)
  expect(said.tier).toBeUndefined()
  expect(said.said).toMatch(/minutes each rather than seconds/)
  // *Coming*, and what is missing — not a promise of capability, and nothing to press.
  expect(said.said).toMatch(/is coming/)
  expect(said.said).toMatch(/no way to connect one yet/)
})
