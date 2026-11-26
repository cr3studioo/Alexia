// SPDX-License-Identifier: AGPL-3.0-only
import { assert, test } from './harness.js'
import { locate, mentions } from '../locate.js'
import { picture, wordsIn } from './world.js'

const SLOW = { timeout: 120_000 }
let made
const screen = () => (made ??= picture())

/** A search over a screen holding `words`, counting its reads. */
async function search(words, label, options) {
  let reads = 0
  const read = async (png) => {
    reads += 1
    return wordsIn(png, words)
  }
  const found = await locate(screen(), label, read, options)
  return { found, reads }
}

const holds = (box, word) =>
  box.x <= word.x && box.y <= word.y && box.x + box.w >= word.x + word.w && box.y + box.h >= word.y + word.h

test('a label is narrowed to a small box wherever it is, within the reads allowed', SLOW, async () => {
  // Corners, the middle, and spots that sit across the cuts.
  const spots = [
    [4, 4],
    [1820, 1050],
    [920, 530],
    [740, 420],
    [1140, 640],
  ]
  for (const [x, y] of spots) {
    const word = { text: 'Save', x, y, w: 60, h: 20 }
    const { found, reads } = await search([word], 'Save')
    assert.ok(found, `nothing at ${String(x)},${String(y)}`)
    assert.ok(holds(found, word), `${JSON.stringify(found)} misses ${String(x)},${String(y)}`)
    assert.ok(found.w <= 640 && found.h <= 200, JSON.stringify(found))
    assert.ok(reads <= 30, String(reads))
  }
})

test('a label nobody can read in a piece gets no box', SLOW, async () => {
  const { found, reads } = await search([], 'Save')
  assert.equal(found, undefined)
  // Three pieces along each side, once.
  assert.equal(reads, 6)
})

test('the search stops when it is cancelled or out of time', SLOW, async () => {
  const word = { text: 'Save', x: 10, y: 10, w: 60, h: 20 }
  assert.deepEqual(await search([word], 'Save', { signal: AbortSignal.abort() }), { found: undefined, reads: 0 })
  let clock = 0
  const slow = await search([word], 'Save', { now: () => (clock += 25_000) })
  assert.equal(slow.found, undefined)
  assert.ok(slow.reads <= 1)
})

test('a label is matched as whole words, whatever the case and line breaks', () => {
  assert.ok(mentions('File\nSAVE   AS…', 'Save as'))
  assert.ok(mentions('Press "OK" now', 'ok'))
  assert.ok(mentions('Nastavení – Uložit', 'uložit'))
  assert.ok(mentions('Zoom (+)', '(+)'))
  assert.ok(!mentions('Saved files', 'Save'))
  assert.ok(!mentions('Uložitelné', 'Uložit'))
  assert.ok(!mentions('anything', '  '))
})
